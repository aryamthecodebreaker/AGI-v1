import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertDeviceConfig, config, usesEmbeddedGateway } from '../config.js';
import { logger } from '../logger.js';
import { initStorage, isDeviceStorage, type DeviceStorage, type Storage } from '../storage/index.js';
import { authRoutes } from './routes/auth.js';
import { conversationRoutes } from './routes/conversations.js';
import { chatRoutes } from './routes/chat.js';
import { memoryRoutes } from './routes/memories.js';
import { peopleRoutes } from './routes/people.js';
import { capabilityRoutes } from './routes/capabilities.js';
import { documentRoutes } from './routes/documents.js';
import { toHttpError } from '../util/errors.js';
import { createAgiCommand, type AgiCommand } from '../devices/index.js';
import { agiCommandRoutes } from './routes/agiCommand.js';
import { deviceRoutes } from './routes/devices.js';
import { deviceGroupRoutes } from './routes/deviceGroups.js';
import { deviceCommandRoutes } from './routes/deviceCommands.js';
import { workflowRoutes } from './routes/workflows.js';
import { internalGatewayRoutes } from './routes/internalGateway.js';
import { attachEmbeddedGateway, type EmbeddedGateway } from '../gateway/embedded.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolvePublicDir(): string {
  // Same strategy as migrations: be resilient to dev vs built layouts.
  const candidates = [
    path.resolve(__dirname, '..', '..', 'public'),
    path.resolve(process.cwd(), 'public'),
    path.resolve(__dirname, '..', 'public'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return candidates[0]!;
}

export interface BuildServerOptions {
  storage?: Storage;
  /** Injected by tests so they can drive a fake gateway. */
  agi?: AgiCommand;
}

export async function buildServer(
  optionsOrStorage?: BuildServerOptions | Storage,
): Promise<FastifyInstance> {
  // Accepts a bare Storage for backwards compatibility with existing callers.
  const options: BuildServerOptions =
    optionsOrStorage && 'kind' in optionsOrStorage
      ? { storage: optionsOrStorage as Storage }
      : ((optionsOrStorage as BuildServerOptions) ?? {});

  const storage = options.storage ?? (await initStorage());

  // Fail fast on a half-configured device feature rather than at first use.
  if (!options.agi) assertDeviceConfig();
  // AGI Command needs the SQLite repositories; on the Postgres path it stays
  // off and the routes report it as unavailable.
  const agi =
    options.agi ??
    createAgiCommand(storage, { serverSecret: config.jwtSecret });

  const app = Fastify({
    logger: config.nodeEnv === 'development'
      ? {
          level: config.logLevel,
          transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } },
        }
      : { level: config.logLevel },
    trustProxy: true,
  });

  await app.register(fastifyCors, { origin: true, credentials: true });
  await app.register(fastifyCookie, {});
  
  // Rate limiting - protect auth and chat endpoints
  await app.register(fastifyRateLimit, {
    max: config.rateLimitMaxRequests,
    timeWindow: config.rateLimitWindowMs,
    allowList: ['127.0.0.1', '::1'], // localhost exempt for dev
    errorResponseBuilder: (req, context) => ({
      error: 'RATE_LIMITED',
      message: `Too many requests. Retry after ${context.ttl}ms`,
      statusCode: 429,
    }),
  });

  // Health check
  app.get('/healthz', async () => ({
    ok: true,
    backend: config.llmBackend,
    storage: storage.kind,
    agiCommand: agi.enabled,
  }));

  /** Liveness for the command subsystem, including gateway reachability. */
  app.get('/healthz/agi-command', async () => {
    if (!agi.enabled) return { ok: true, enabled: false };
    const health = await agi.gateway.health();
    return {
      // The app is healthy even when the gateway is not; device control simply
      // reports as unavailable.
      ok: true,
      enabled: true,
      gateway: health,
    };
  });

  // API routes with selective rate limiting
  await authRoutes(app, storage);
  await conversationRoutes(app, storage);
  await chatRoutes(app, storage, agi);
  await memoryRoutes(app, storage);
  await peopleRoutes(app, storage);
  await capabilityRoutes(app, storage);
  await documentRoutes(app, storage);

  // AGI Command.
  //
  // The cast is sound because every handler in these routers sits behind
  // `requireFeature`, which returns 503 before any handler body runs whenever
  // `agi.enabled` is false — and `agi.enabled` is only ever true when the
  // storage really is a DeviceStorage (see createAgiCommand). Registering them
  // unconditionally keeps the "feature is off" response a clear 503 rather than
  // a confusing 404.
  const deviceStorage = storage as DeviceStorage;
  await agiCommandRoutes(app, deviceStorage, agi);
  await deviceRoutes(app, deviceStorage, agi);
  await deviceGroupRoutes(app, deviceStorage, agi);
  await deviceCommandRoutes(app, deviceStorage, agi);
  await workflowRoutes(app, deviceStorage, agi);
  // Gateway-facing, authenticated by shared secret rather than a user session.
  await internalGatewayRoutes(app, deviceStorage, agi);

  // Unified error handler
  app.setErrorHandler((err, _req, reply) => {
    const { status, body } = toHttpError(err);
    if (status >= 500) logger.error({ err }, 'server error');
    reply.status(status).send(body);
  });

  // Static frontend
  await app.register(fastifyStatic, {
    root: resolvePublicDir(),
    prefix: '/',
    index: ['index.html'],
  });

  return app;
}

export async function startServer(): Promise<FastifyInstance> {
  const storage = await initStorage();
  assertDeviceConfig();

  // Embedded mode needs the gateway client to point at a hub that does not
  // exist until the server does, so build the subsystem first and hand it the
  // client afterwards. `embeddedClient` is a thin indirection that the hub
  // fills in once it is attached.
  const embedded = usesEmbeddedGateway() && isDeviceStorage(storage);
  let embeddedGateway: EmbeddedGateway | null = null;
  const agi = createAgiCommand(storage, {
    serverSecret: config.jwtSecret,
    gateway: embedded
      ? {
          configured: () => true,
          dispatch: (deviceId, envelope) =>
            embeddedGateway
              ? embeddedGateway.client.dispatch(deviceId, envelope)
              : Promise.resolve({ delivered: false, reason: 'gateway is still starting' }),
          cancel: (deviceId, commandId, executionId) =>
            embeddedGateway
              ? embeddedGateway.client.cancel(deviceId, commandId, executionId)
              : Promise.resolve({ delivered: false, reason: 'gateway is still starting' }),
          health: () =>
            embeddedGateway
              ? embeddedGateway.client.health()
              : Promise.resolve({ ok: false, error: 'gateway is still starting' }),
          connectedDeviceIds: () =>
            embeddedGateway ? embeddedGateway.client.connectedDeviceIds() : Promise.resolve([]),
        }
      : undefined,
  });

  const app = await buildServer({ storage, agi });

  if (agi.enabled && embedded && isDeviceStorage(storage)) {
    embeddedGateway = attachEmbeddedGateway({
      app,
      storage,
      devices: agi.devices,
      commands: agi.commands,
      settings: agi.settings,
    });
    app.addHook('onClose', async () => {
      await embeddedGateway?.close();
    });
  }

  // Timeouts and expiries are swept in the background, not on request paths, so
  // a stuck command resolves itself even if nobody is looking at the UI.
  if (agi.enabled) {
    const stop = agi.startSweeper();
    app.addHook('onClose', async () => stop());
    logger.info(
      {
        mode: embedded ? 'embedded' : 'standalone',
        gateway: agi.settings.gatewayUrl || '(in-process)',
      },
      'AGI Command enabled',
    );
  }

  await app.listen({ port: config.port, host: config.host });
  logger.info({ url: `http://${config.host}:${config.port}` }, 'AGI-v1 server listening');
  return app;
}
