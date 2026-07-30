import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertDeviceConfig, config } from '../config.js';
import { logger } from '../logger.js';
import { initStorage, type Storage } from '../storage/index.js';
import { authRoutes } from './routes/auth.js';
import { conversationRoutes } from './routes/conversations.js';
import { chatRoutes } from './routes/chat.js';
import { peopleRoutes } from './routes/people.js';
import { memoryRoutes } from './routes/memories.js';
import { toHttpError } from '../util/errors.js';
import { createAgiCommand, type AgiCommand } from '../devices/index.js';
import { agiCommandRoutes } from './routes/agiCommand.js';
import { deviceRoutes } from './routes/devices.js';
import { deviceGroupRoutes } from './routes/deviceGroups.js';
import { deviceCommandRoutes } from './routes/deviceCommands.js';
import { workflowRoutes } from './routes/workflows.js';
import { internalGatewayRoutes } from './routes/internalGateway.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolvePublicDir(): string {
  // Same strategy as migrations: be resilient to dev vs built layouts.
  const candidates = [
    path.resolve(__dirname, '..', '..', 'public'),
    path.resolve(process.cwd(), 'public'),
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
    optionsOrStorage && 'db' in optionsOrStorage
      ? { storage: optionsOrStorage as Storage }
      : ((optionsOrStorage as BuildServerOptions) ?? {});

  const storage = options.storage ?? initStorage();

  // Fail fast on a half-configured device feature rather than at first use.
  if (!options.agi) assertDeviceConfig();
  const agi =
    options.agi ?? createAgiCommand(storage, { serverSecret: config.jwtSecret });

  const app = Fastify({
    logger: {
      level: config.logLevel,
      transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } },
    },
    trustProxy: false,
  });

  await app.register(fastifyCors, { origin: true, credentials: true });
  await app.register(fastifyCookie, {});

  // Health check
  app.get('/healthz', async () => ({
    ok: true,
    backend: config.llmBackend,
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

  // API routes
  await authRoutes(app, storage);
  await conversationRoutes(app, storage);
  await chatRoutes(app, storage, agi);
  await peopleRoutes(app, storage);
  await memoryRoutes(app, storage);

  // AGI Command
  await agiCommandRoutes(app, storage, agi);
  await deviceRoutes(app, storage, agi);
  await deviceGroupRoutes(app, storage, agi);
  await deviceCommandRoutes(app, storage, agi);
  await workflowRoutes(app, storage, agi);
  // Gateway-facing, authenticated by shared secret rather than a user session.
  await internalGatewayRoutes(app, storage, agi);

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
  const storage = initStorage();
  assertDeviceConfig();
  const agi = createAgiCommand(storage, { serverSecret: config.jwtSecret });
  const app = await buildServer({ storage, agi });

  // Timeouts and expiries are swept in the background, not on request paths, so
  // a stuck command resolves itself even if nobody is looking at the UI.
  if (agi.enabled) {
    const stop = agi.startSweeper();
    app.addHook('onClose', async () => stop());
    logger.info(
      { gateway: agi.settings.gatewayUrl || '(none)' },
      'AGI Command enabled',
    );
  }

  await app.listen({ port: config.port, host: config.host });
  logger.info({ url: `http://${config.host}:${config.port}` }, 'AGI-v1 server listening');
  return app;
}
