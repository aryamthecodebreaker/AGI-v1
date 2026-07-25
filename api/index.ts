import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.js';

interface RequestEmitter {
  emit(event: 'request', request: IncomingMessage, response: ServerResponse): boolean;
}

let serverPromise: Promise<FastifyInstance> | undefined;

async function getServer(): Promise<FastifyInstance> {
  serverPromise ??= buildServer().then(async (app) => {
    await app.ready();
    return app;
  });
  return serverPromise;
}

export function emitRequestAndWait(
  server: RequestEmitter,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.off('finish', finish);
      response.off('close', finish);
      response.off('error', fail);
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };

    response.once('finish', finish);
    response.once('close', finish);
    response.once('error', fail);
    try {
      server.emit('request', request, response);
    } catch (error) {
      fail(error as Error);
    }
  });
}

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const app = await getServer();
  await emitRequestAndWait(app.server, request, response);
}
