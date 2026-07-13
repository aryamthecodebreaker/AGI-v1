import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.js';

let serverPromise: Promise<FastifyInstance> | undefined;

async function getServer(): Promise<FastifyInstance> {
  serverPromise ??= buildServer().then(async (app) => {
    await app.ready();
    return app;
  });
  return serverPromise;
}

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const app = await getServer();
  app.server.emit('request', request, response);
}
