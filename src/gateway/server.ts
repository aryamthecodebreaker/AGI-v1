// The standalone device gateway: a long-running process that owns the
// WebSocket connections to device agents.
//
// Why a separate service at all: the main app can live on a serverless host,
// where no request handler stays alive long enough to hold a socket open. Rather
// than pretend otherwise, persistent connections live here and the two talk over
// a small authenticated internal API.
//
// On a host that already runs one long-lived process (Docker, Fly, Railway,
// Hugging Face Spaces) this separation buys nothing, so the same connection
// handling can run inside the app instead — see ./embedded.ts. Both modes share
// createAgentHub(), so there is exactly one implementation of the protocol.

import Fastify, { type FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { PROTOCOL_VERSION } from '../devices/protocol.js';
import { createAppClient, type AppClient } from './appClient.js';
import { createAgentHub } from './hub.js';
import type { GatewayConfig } from './config.js';

export interface GatewayServer {
  app: FastifyInstance;
  listen(): Promise<{ port: number }>;
  close(): Promise<void>;
  connectionCount(): number;
  connectedDeviceIds(): string[];
}

function secretsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function createGatewayServer(
  config: GatewayConfig,
  appClientOverride?: AppClient,
): GatewayServer {
  const appClient =
    appClientOverride ?? createAppClient(config.appUrl, config.internalSecret);

  const app = Fastify({
    logger: {
      level: config.logLevel,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    },
  });

  const hub = createAgentHub({
    appClient,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    offlineAfterMs: config.offlineAfterMs,
    logger: {
      info: (data, message) => app.log.info(data, message),
      warn: (data, message) => app.log.warn(data, message),
    },
  });

  // -------------------------------------------------------------------------
  // Internal API — app -> gateway. Every route requires the shared secret.
  // -------------------------------------------------------------------------

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/internal/')) return;
    const presented = req.headers['x-agi-gateway-secret'];
    if (typeof presented !== 'string' || !secretsMatch(presented, config.internalSecret)) {
      app.log.warn({ url: req.url }, 'internal request rejected: bad secret');
      await reply.status(401).send({ error: 'UNAUTHORIZED' });
    }
  });

  app.get('/internal/health', async () => hub.health());

  app.get('/internal/connections', async () => ({
    deviceIds: hub.connectedDeviceIds(),
  }));

  app.post('/internal/dispatch', async (req, reply) => {
    const body = req.body as { deviceId?: string; envelope?: Record<string, unknown> };
    if (!body?.deviceId || !body?.envelope) {
      return reply.status(400).send({ delivered: false, reason: 'malformed dispatch' });
    }
    return reply.send(hub.dispatch(body.deviceId, body.envelope));
  });

  app.post('/internal/cancel', async (req, reply) => {
    const body = req.body as {
      deviceId?: string;
      commandId?: string;
      executionId?: string;
    };
    if (!body?.deviceId || !body?.commandId || !body?.executionId) {
      return reply.status(400).send({ delivered: false, reason: 'malformed cancel' });
    }
    return reply.send(hub.cancel(body.deviceId, body.commandId, body.executionId));
  });

  app.server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    hub.handleUpgrade(request, socket, head);
  });

  return {
    app,
    async listen() {
      await app.listen({ port: config.port, host: config.host });
      const address = app.server.address();
      const port = typeof address === 'object' && address ? address.port : config.port;
      app.log.info(
        { port, protocol: PROTOCOL_VERSION, appUrl: config.appUrl },
        'device gateway listening',
      );
      return { port };
    },
    async close() {
      await hub.close();
      await app.close();
    },
    connectionCount: () => hub.connectionCount(),
    connectedDeviceIds: () => hub.connectedDeviceIds(),
  };
}
