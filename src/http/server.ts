import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { initStorage, type Storage } from '../storage/index.js';
import { authRoutes } from './routes/auth.js';
import { conversationRoutes } from './routes/conversations.js';
import { chatRoutes } from './routes/chat.js';
import { peopleRoutes } from './routes/people.js';
import { memoryRoutes } from './routes/memories.js';
import { toHttpError } from '../util/errors.js';

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

export async function buildServer(storageOverride?: Storage): Promise<FastifyInstance> {
  const storage = storageOverride ?? initStorage();

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
  app.get('/healthz', async () => ({ ok: true, backend: config.llmBackend }));

  // API routes
  await authRoutes(app, storage);
  await conversationRoutes(app, storage);
  await chatRoutes(app, storage);
  await peopleRoutes(app, storage);
  await memoryRoutes(app, storage);

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
  const app = await buildServer();
  await app.listen({ port: config.port, host: config.host });
  logger.info({ url: `http://${config.host}:${config.port}` }, 'AGI-v1 server listening');
  return app;
}
