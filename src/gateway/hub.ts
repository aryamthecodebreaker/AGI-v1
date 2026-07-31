// The agent hub: the WebSocket connection registry and frame handling.
//
// Extracted from the standalone gateway so the same code can run two ways:
//
//   * Standalone  — a separate long-running process, reached over an
//     authenticated internal HTTP API. Right for a serverless web tier.
//   * Embedded    — attached to the app's own HTTP server on the same port,
//     with dispatch going straight through memory. Right for any host that
//     runs one long-lived container (Docker, Fly, Railway, HF Spaces) and for
//     local development, where two processes is friction for no benefit.
//
// The hub never decides anything. It authenticates a device by asking whoever
// supplied the AppClient, relays validated frames, and reports what it saw.

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
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
import type { AppClient } from './appClient.js';

/** An agent that has not identified itself this quickly is dropped. */
const HELLO_TIMEOUT_MS = 10_000;
/** Flood guard: frames per connection per 10 seconds. */
const MESSAGES_PER_WINDOW = 120;
/** Bound on the replay-suppression set held per connection. */
const SEEN_COMMANDS_LIMIT = 500;

export interface HubLogger {
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
}

interface Connection {
  socket: WebSocket;
  deviceId: string;
  userId: string;
  deviceName: string;
  connectedAt: number;
  lastSeenAt: number;
  /** Command ids already dispatched here, so a replay can be refused. */
  seenCommands: Set<string>;
}

export interface DispatchOutcome {
  delivered: boolean;
  reason?: string;
}

export interface AgentHubOptions {
  appClient: AppClient;
  heartbeatIntervalMs: number;
  offlineAfterMs: number;
  logger: HubLogger;
  /** URL path agents connect to. */
  path?: string;
}

export function createAgentHub(options: AgentHubOptions) {
  const { appClient, logger } = options;
  const path = options.path ?? '/agent';

  /** deviceId -> live connection. One socket per device; newest wins. */
  const connections = new Map<string, Connection>();
  const startedAt = Date.now();

  const wss = new WebSocketServer({
    noServer: true,
    // Frames above this are rejected by ws before we ever see them.
    maxPayload: MAX_MESSAGE_BYTES,
  });

  function sendTo(connection: Connection, message: Record<string, unknown>): boolean {
    if (connection.socket.readyState !== connection.socket.OPEN) return false;
    connection.socket.send(encode(message as { type: string }));
    return true;
  }

  function closeWithError(socket: WebSocket, code: string, message: string, fatal = false): void {
    try {
      socket.send(encode({ type: 'server.error', code, message, fatal }));
    } catch {
      /* socket may already be gone */
    }
    socket.close(fatal ? 4003 : 1008, code);
  }

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
        logger.info({ deviceId: connection.deviceId }, 'device disconnected');
      }
    };

    socket.on('close', cleanup);
    socket.on('error', (err: Error) => {
      logger.warn({ err: err.message }, 'agent socket error');
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
        logger.warn({ code: decoded.code, error: decoded.error }, 'rejected agent frame');
        if (decoded.code === 'bad_protocol') {
          closeWithError(socket, 'bad_protocol', decoded.error, true);
        } else {
          try {
            socket.send(
              encode({ type: 'server.error', code: decoded.code, message: decoded.error }),
            );
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
          logger.warn({ frame: redactMessage(message) }, 'device authentication rejected');
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
          seenCommands: new Set(),
        };
        connections.set(auth.deviceId, connection);

        sendTo(connection, {
          type: 'server.welcome',
          deviceId: auth.deviceId,
          deviceName: auth.deviceName,
          heartbeatIntervalMs: auth.heartbeatIntervalMs || options.heartbeatIntervalMs,
          acceptedCapabilities: auth.acceptedCapabilities,
        });
        logger.info({ deviceId: auth.deviceId, name: auth.deviceName }, 'device connected');
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
          logger.warn(
            { deviceId: connection.deviceId, code: message.code, message: message.message },
            'agent reported an error',
          );
          break;
      }
    });
  });

  // Liveness sweep: ping everyone, drop anything that has gone quiet.
  const heartbeatTimer = setInterval(() => {
    const cutoff = Date.now() - options.offlineAfterMs;
    for (const connection of [...connections.values()]) {
      if (connection.lastSeenAt < cutoff) {
        logger.info({ deviceId: connection.deviceId }, 'heartbeat timeout — closing');
        connection.socket.terminate();
        continue;
      }
      if (connection.socket.readyState === connection.socket.OPEN) {
        connection.socket.ping();
      }
    }
  }, options.heartbeatIntervalMs);
  heartbeatTimer.unref();

  return {
    /** Wire this to the HTTP server's 'upgrade' event. */
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
      if (!request.url?.startsWith(path)) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    },

    dispatch(deviceId: string, envelope: Record<string, unknown>): DispatchOutcome {
      const connection = connections.get(deviceId);
      if (!connection) return { delivered: false, reason: 'device is not connected' };

      const key = `${String(envelope.commandId ?? '')}:${String(envelope.executionId ?? '')}`;
      // Replay guard at the edge; the agent also keeps its own dedupe set.
      if (connection.seenCommands.has(key)) {
        return { delivered: false, reason: 'duplicate dispatch suppressed' };
      }
      const delivered = sendTo(connection, envelope);
      if (delivered) {
        connection.seenCommands.add(key);
        // Bound the memory a long-lived connection can accumulate.
        if (connection.seenCommands.size > SEEN_COMMANDS_LIMIT) {
          const oldest = connection.seenCommands.values().next().value;
          if (oldest) connection.seenCommands.delete(oldest);
        }
      }
      return { delivered, reason: delivered ? undefined : 'socket was not writable' };
    },

    cancel(deviceId: string, commandId: string, executionId: string): DispatchOutcome {
      const connection = connections.get(deviceId);
      if (!connection) return { delivered: false, reason: 'device is not connected' };
      const delivered = sendTo(connection, {
        type: 'command.cancel',
        commandId,
        executionId,
      });
      return { delivered };
    },

    health() {
      return {
        ok: true,
        protocolVersion: PROTOCOL_VERSION,
        connections: connections.size,
        uptimeMs: Date.now() - startedAt,
      };
    },

    connectionCount: () => connections.size,
    connectedDeviceIds: () => [...connections.keys()],

    async close(): Promise<void> {
      clearInterval(heartbeatTimer);
      for (const connection of connections.values()) {
        connection.socket.close(1001, 'gateway shutting down');
      }
      connections.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

export type AgentHub = ReturnType<typeof createAgentHub>;
