// The device gateway: a long-running process that owns the WebSocket
// connections to device agents.
//
// Why a separate service at all: the main app can live on a serverless host,
// where no request handler stays alive long enough to hold a socket open. Rather
// than pretend otherwise, persistent connections live here and the two talk over
// a small authenticated internal API.
//
// The gateway is deliberately dumb. It does not know what a user is, what a
// policy is, or whether a command should run. It authenticates a device by
// asking the app, relays validated frames, and reports what it saw.

import Fastify, { type FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import {
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  decodeAgentMessage,
  encode,
  isCompatibleProtocol,
  redactMessage,
  type CapabilityAdvert,
} from '../devices/protocol.js';
import { RateLimiter } from '../devices/rateLimit.js';
import { createAppClient, type AppClient } from './appClient.js';
import type { GatewayConfig } from './config.js';

/** An agent that has not identified itself this quickly is dropped. */
const HELLO_TIMEOUT_MS = 10_000;
/** Flood guard: frames per connection per 10 seconds. */
const MESSAGES_PER_WINDOW = 120;

interface Connection {
  socket: WebSocket;
  deviceId: string;
  userId: string;
  deviceName: string;
  connectedAt: number;
  lastSeenAt: number;
  agentVersion?: string;
  /** Command ids already dispatched here, so a replay can be refused. */
  seenCommands: Set<string>;
  limiter: RateLimiter;
}

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

  /** deviceId -> live connection. One socket per device; newest wins. */
  const connections = new Map<string, Connection>();
  const startedAt = Date.now();

  function sendTo(connection: Connection, message: Record<string, unknown>): boolean {
    if (connection.socket.readyState !== connection.socket.OPEN) return false;
    connection.socket.send(encode(message as { type: string }));
    return true;
  }

  function closeWithError(
    socket: WebSocket,
    code: string,
    message: string,
    fatal = false,
  ): void {
    try {
      socket.send(encode({ type: 'server.error', code, message, fatal }));
    } catch {
      /* socket may already be gone */
    }
    socket.close(fatal ? 4003 : 1008, code);
  }

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

  app.get('/internal/health', async () => ({
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    connections: connections.size,
    uptimeMs: Date.now() - startedAt,
  }));

  app.get('/internal/connections', async () => ({
    deviceIds: [...connections.keys()],
  }));

  app.post('/internal/dispatch', async (req, reply) => {
    const body = req.body as { deviceId?: string; envelope?: Record<string, unknown> };
    if (!body?.deviceId || !body?.envelope) {
      return reply.status(400).send({ delivered: false, reason: 'malformed dispatch' });
    }
    const connection = connections.get(body.deviceId);
    if (!connection) {
      return reply.send({ delivered: false, reason: 'device is not connected' });
    }
    const commandId = String(body.envelope.commandId ?? '');
    const executionId = String(body.envelope.executionId ?? '');
    // Replay guard at the edge; the agent also keeps its own dedupe set.
    const key = `${commandId}:${executionId}`;
    if (connection.seenCommands.has(key)) {
      return reply.send({ delivered: false, reason: 'duplicate dispatch suppressed' });
    }
    const delivered = sendTo(connection, body.envelope as { type: string });
    if (delivered) {
      connection.seenCommands.add(key);
      // Bound the memory a long-lived connection can accumulate.
      if (connection.seenCommands.size > 500) {
        const oldest = connection.seenCommands.values().next().value;
        if (oldest) connection.seenCommands.delete(oldest);
      }
    }
    return reply.send({
      delivered,
      reason: delivered ? undefined : 'socket was not writable',
    });
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
    const connection = connections.get(body.deviceId);
    if (!connection) return reply.send({ delivered: false, reason: 'device is not connected' });
    const delivered = sendTo(connection, {
      type: 'command.cancel',
      commandId: body.commandId,
      executionId: body.executionId,
    });
    return reply.send({ delivered });
  });

  // -------------------------------------------------------------------------
  // WebSocket endpoint — agents connect here.
  // -------------------------------------------------------------------------

  const wss = new WebSocketServer({
    noServer: true,
    // Frames above this are rejected by ws before we ever see them.
    maxPayload: MAX_MESSAGE_BYTES,
  });

  app.server.on('upgrade', (request: IncomingMessage, socket, head) => {
    if (!request.url?.startsWith('/agent')) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (socket: WebSocket) => {
    let connection: Connection | null = null;
    const limiter = new RateLimiter(MESSAGES_PER_WINDOW, 10_000);

    // Drop anonymous sockets that never say hello.
    const helloTimer = setTimeout(() => {
      if (!connection) closeWithError(socket, 'hello_timeout', 'no agent.hello received', true);
    }, HELLO_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(helloTimer);
      if (!connection) return;
      // Only clear the map if this socket is still the registered one — a newer
      // connection for the same device must not be evicted by an old close.
      if (connections.get(connection.deviceId)?.socket === socket) {
        connections.delete(connection.deviceId);
        void appClient.disconnected(connection.deviceId);
        app.log.info({ deviceId: connection.deviceId }, 'device disconnected');
      }
    };

    socket.on('close', cleanup);
    socket.on('error', (err) => {
      app.log.warn({ err: err.message }, 'agent socket error');
      cleanup();
    });

    socket.on('pong', () => {
      if (connection) connection.lastSeenAt = Date.now();
    });

    socket.on('message', async (raw: Buffer, isBinary: boolean) => {
      if (isBinary) {
        closeWithError(socket, 'binary_unsupported', 'frames must be UTF-8 JSON');
        return;
      }
      if (!limiter.tryConsume('frames')) {
        closeWithError(socket, 'rate_limited', 'too many frames', true);
        return;
      }

      const decoded = decodeAgentMessage(raw);
      if (!decoded.ok) {
        // Malformed input is a protocol error, not a crash.
        app.log.warn({ code: decoded.code, error: decoded.error }, 'rejected agent frame');
        if (decoded.code === 'bad_protocol') {
          closeWithError(socket, 'bad_protocol', decoded.error, true);
        } else {
          try {
            socket.send(encode({ type: 'server.error', code: decoded.code, message: decoded.error }));
          } catch {
            /* ignore */
          }
        }
        return;
      }

      const message = decoded.message;

      // ---- handshake ----
      if (message.type === 'agent.hello') {
        if (connection) {
          closeWithError(socket, 'already_identified', 'agent.hello sent twice');
          return;
        }
        if (!isCompatibleProtocol(message.v)) {
          closeWithError(socket, 'bad_protocol', `expected ${PROTOCOL_VERSION}`, true);
          return;
        }
        const auth = await appClient.authenticate({
          credential: message.credential,
          device: message.device,
          capabilities: message.capabilities as CapabilityAdvert[],
          protocolVersion: message.v,
        });
        if (!auth) {
          // Covers unknown, revoked and wrong-secret alike — no oracle.
          app.log.warn(
            { frame: redactMessage(message) },
            'device authentication rejected',
          );
          closeWithError(socket, 'unauthorized', 'device credential was rejected', true);
          return;
        }

        // One live socket per device.
        const previous = connections.get(auth.deviceId);
        if (previous && previous.socket !== socket) {
          closeWithError(previous.socket, 'superseded', 'a newer connection replaced this one');
          connections.delete(auth.deviceId);
        }

        clearTimeout(helloTimer);
        connection = {
          socket,
          deviceId: auth.deviceId,
          userId: auth.userId,
          deviceName: auth.deviceName,
          connectedAt: Date.now(),
          lastSeenAt: Date.now(),
          agentVersion: message.device.agentVersion,
          seenCommands: new Set(),
          limiter,
        };
        connections.set(auth.deviceId, connection);

        sendTo(connection, {
          type: 'server.welcome',
          deviceId: auth.deviceId,
          deviceName: auth.deviceName,
          heartbeatIntervalMs: auth.heartbeatIntervalMs || config.heartbeatIntervalMs,
          acceptedCapabilities: auth.acceptedCapabilities,
        });
        app.log.info(
          { deviceId: auth.deviceId, name: auth.deviceName },
          'device connected',
        );
        return;
      }

      // Everything past hello requires an identified connection.
      if (!connection) {
        closeWithError(socket, 'not_identified', 'send agent.hello first', true);
        return;
      }
      connection.lastSeenAt = Date.now();

      switch (message.type) {
        case 'agent.heartbeat':
          void appClient.heartbeat(connection.deviceId);
          break;

        case 'agent.capabilities':
          void appClient.capabilities(
            connection.deviceId,
            message.capabilities as CapabilityAdvert[],
          );
          break;

        case 'command.acknowledged':
          void appClient.result({
            deviceId: connection.deviceId,
            commandId: message.commandId,
            executionId: message.executionId,
            type: 'acknowledged',
          });
          break;

        case 'command.progress':
          void appClient.result({
            deviceId: connection.deviceId,
            commandId: message.commandId,
            executionId: message.executionId,
            type: 'progress',
            progressMessage: message.message,
          });
          break;

        case 'command.completed':
          void appClient.result({
            deviceId: connection.deviceId,
            commandId: message.commandId,
            executionId: message.executionId,
            type: 'completed',
            result: message.result,
          });
          break;

        case 'command.failed':
          void appClient.result({
            deviceId: connection.deviceId,
            commandId: message.commandId,
            executionId: message.executionId,
            type: 'failed',
            failure: { code: message.code, message: message.message },
          });
          break;

        case 'agent.error':
          app.log.warn(
            { deviceId: connection.deviceId, code: message.code, message: message.message },
            'agent reported an error',
          );
          break;
      }
    });
  });

  // Liveness sweep: ping everyone, drop anything that has gone quiet.
  const heartbeatTimer = setInterval(() => {
    const cutoff = Date.now() - config.offlineAfterMs;
    for (const connection of [...connections.values()]) {
      if (connection.lastSeenAt < cutoff) {
        app.log.info({ deviceId: connection.deviceId }, 'heartbeat timeout — closing');
        connection.socket.terminate();
        continue;
      }
      if (connection.socket.readyState === connection.socket.OPEN) {
        connection.socket.ping();
      }
    }
  }, config.heartbeatIntervalMs);
  heartbeatTimer.unref();

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
      clearInterval(heartbeatTimer);
      for (const connection of connections.values()) {
        connection.socket.close(1001, 'gateway shutting down');
      }
      connections.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await app.close();
    },
    connectionCount: () => connections.size,
    connectedDeviceIds: () => [...connections.keys()],
  };
}
