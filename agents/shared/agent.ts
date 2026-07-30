// The shared device-agent runtime for TypeScript agents (Windows, simulated,
// and anything else that runs on Node).
//
// It owns everything that is identical across platforms — pairing, credential
// storage, connect/reconnect, heartbeats, capability advertisement, replay
// refusal, acknowledgement and result reporting — so a platform agent only has
// to supply handlers for the capabilities it can actually perform.
//
// Protocol types come from src/devices/protocol.ts, so a protocol change breaks
// the build here rather than surfacing as a mystery at runtime.

import WebSocket from 'ws';
import {
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  decodeServerMessage,
  encode,
  type CapabilityAdvert,
} from '../../src/devices/protocol.js';
import {
  clearCredential,
  defaultCredentialPath,
  loadCredential,
  saveCredential,
  type StoredCredential,
} from './credentialStore.js';

export type AgentState =
  | 'unpaired'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'revoked'
  | 'stopped';

export interface CapabilityContext {
  signal: AbortSignal;
}

/**
 * A capability implementation. Throwing produces a `failed` result with the
 * error message; returning produces `completed` with the returned payload.
 * Throw `new UnsupportedOnThisDevice()` to report `unsupported` instead.
 */
export type CapabilityHandler = (
  parameters: Record<string, unknown>,
  context: CapabilityContext,
) => Promise<Record<string, unknown> | void>;

export class UnsupportedOnThisDevice extends Error {
  constructor(message = 'not supported on this device') {
    super(message);
  }
}

export class RejectedByDevice extends Error {
  constructor(message = 'refused by the device') {
    super(message);
  }
}

export interface CommandLogEntry {
  commandId: string;
  capability: string;
  at: number;
  outcome: 'completed' | 'failed' | 'unsupported' | 'rejected' | 'duplicate' | 'expired';
  detail?: string;
}

export interface AgentOptions {
  /** Name shown in AGI-v1 and used for the credential filename. */
  name: string;
  deviceType:
    | 'android_phone'
    | 'android_tablet'
    | 'windows'
    | 'browser'
    | 'generic'
    | 'simulated';
  platform: string;
  platformVersion?: string;
  agentVersion: string;
  /** Base URL of the AGI-v1 app, used only for pairing. */
  appUrl: string;
  /** WebSocket URL of the device gateway, e.g. ws://127.0.0.1:3100/agent */
  gatewayUrl: string;
  handlers: Record<string, CapabilityHandler>;
  credentialPath?: string;
  onStateChange?: (state: AgentState, detail?: string) => void;
  onCommand?: (entry: CommandLogEntry) => void;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
/** How many recent (command, execution) pairs to refuse as replays. */
const DEDUPE_SIZE = 200;

export function createAgent(options: AgentOptions) {
  const credentialPath =
    options.credentialPath ?? defaultCredentialPath(slug(options.name));
  const log = options.log ?? (() => {});

  let stored: StoredCredential | null = loadCredential(credentialPath);
  let socket: WebSocket | null = null;
  let state: AgentState = stored ? 'connecting' : 'unpaired';
  let stopping = false;
  let reconnectAttempt = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let heartbeatIntervalMs = 15_000;

  /** Commands already handled — a repeat is refused rather than run twice. */
  const handled = new Set<string>();
  const inFlight = new Map<string, AbortController>();
  const history: CommandLogEntry[] = [];

  const capabilities: CapabilityAdvert[] = Object.keys(options.handlers).map((name) => ({
    name,
    version: 1,
  }));

  function setState(next: AgentState, detail?: string): void {
    if (state === next) return;
    state = next;
    options.onStateChange?.(next, detail);
    log(`state: ${next}${detail ? ` (${detail})` : ''}`);
  }

  function record(entry: CommandLogEntry): void {
    history.unshift(entry);
    if (history.length > 50) history.pop();
    options.onCommand?.(entry);
  }

  function send(message: Record<string, unknown> & { type: string }): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const frame = encode(message);
    if (Buffer.byteLength(frame, 'utf8') > MAX_MESSAGE_BYTES) {
      // Truncate rather than have the gateway drop the whole frame.
      log('outgoing frame too large — sending a trimmed failure instead');
      socket.send(
        encode({
          type: 'command.failed',
          commandId: String(message.commandId ?? ''),
          executionId: String(message.executionId ?? ''),
          code: 'failed',
          message: 'result payload was too large to report',
        }),
      );
      return;
    }
    socket.send(frame);
  }

  // -------------------------------------------------------------------------
  // Pairing
  // -------------------------------------------------------------------------

  /**
   * Redeem a pairing code. On success the credential is stored and the agent can
   * connect from then on without the code.
   */
  async function pair(code: string): Promise<StoredCredential> {
    const res = await fetch(`${options.appUrl.replace(/\/+$/, '')}/api/devices/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        name: options.name,
        deviceType: options.deviceType,
        platform: options.platform,
        platformVersion: options.platformVersion,
        agentVersion: options.agentVersion,
        protocolVersion: PROTOCOL_VERSION,
        capabilities: capabilities.map((c) => ({ name: c.name, version: c.version })),
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(body.message ?? `pairing failed (${res.status})`);
    }
    const body = (await res.json()) as {
      deviceId: string;
      deviceName: string;
      credential: string;
      rejectedCapabilities?: string[];
    };
    if (body.rejectedCapabilities?.length) {
      log(`server refused capabilities: ${body.rejectedCapabilities.join(', ')}`);
    }
    const value: StoredCredential = {
      credential: body.credential,
      deviceId: body.deviceId,
      deviceName: body.deviceName,
      gatewayUrl: options.gatewayUrl,
      pairedAt: Date.now(),
    };
    saveCredential(credentialPath, value);
    stored = value;
    log(`paired as "${body.deviceName}"`);
    return value;
  }

  function unpair(): void {
    clearCredential(credentialPath);
    stored = null;
    setState('unpaired');
    socket?.close(1000, 'unpaired');
  }

  // -------------------------------------------------------------------------
  // Command execution
  // -------------------------------------------------------------------------

  async function runCommand(dispatch: {
    commandId: string;
    executionId: string;
    capability: string;
    parameters: Record<string, unknown>;
    timeoutMs: number;
    expiresAt: number;
  }): Promise<void> {
    const key = `${dispatch.commandId}:${dispatch.executionId}`;

    // Replay refusal — the same command must not run twice.
    if (handled.has(key)) {
      send({
        type: 'command.failed',
        commandId: dispatch.commandId,
        executionId: dispatch.executionId,
        code: 'duplicate',
        message: 'this command was already processed',
      });
      record({
        commandId: dispatch.commandId,
        capability: dispatch.capability,
        at: Date.now(),
        outcome: 'duplicate',
      });
      return;
    }

    // Expired dispatches are refused, not run late.
    if (dispatch.expiresAt <= Date.now()) {
      send({
        type: 'command.failed',
        commandId: dispatch.commandId,
        executionId: dispatch.executionId,
        code: 'rejected',
        message: 'the command had already expired when it arrived',
      });
      record({
        commandId: dispatch.commandId,
        capability: dispatch.capability,
        at: Date.now(),
        outcome: 'expired',
      });
      return;
    }

    const handler = options.handlers[dispatch.capability];
    if (!handler) {
      send({
        type: 'command.failed',
        commandId: dispatch.commandId,
        executionId: dispatch.executionId,
        code: 'unsupported',
        message: `${dispatch.capability} is not implemented on this device`,
      });
      record({
        commandId: dispatch.commandId,
        capability: dispatch.capability,
        at: Date.now(),
        outcome: 'unsupported',
      });
      return;
    }

    handled.add(key);
    if (handled.size > DEDUPE_SIZE) {
      const oldest = handled.values().next().value;
      if (oldest) handled.delete(oldest);
    }

    // Acknowledge before doing the work, so the server can distinguish "never
    // arrived" from "arrived and is slow".
    send({
      type: 'command.acknowledged',
      commandId: dispatch.commandId,
      executionId: dispatch.executionId,
    });

    const controller = new AbortController();
    inFlight.set(key, controller);
    const timer = setTimeout(() => controller.abort(), dispatch.timeoutMs);

    try {
      const result = await handler(dispatch.parameters, { signal: controller.signal });
      send({
        type: 'command.completed',
        commandId: dispatch.commandId,
        executionId: dispatch.executionId,
        result: result ?? {},
      });
      record({
        commandId: dispatch.commandId,
        capability: dispatch.capability,
        at: Date.now(),
        outcome: 'completed',
      });
    } catch (err) {
      const code =
        err instanceof UnsupportedOnThisDevice
          ? 'unsupported'
          : err instanceof RejectedByDevice
            ? 'rejected'
            : 'failed';
      const message = (err as Error).message || 'the action failed';
      send({
        type: 'command.failed',
        commandId: dispatch.commandId,
        executionId: dispatch.executionId,
        code,
        message,
      });
      record({
        commandId: dispatch.commandId,
        capability: dispatch.capability,
        at: Date.now(),
        outcome: code === 'failed' ? 'failed' : code,
        detail: message,
      });
    } finally {
      clearTimeout(timer);
      inFlight.delete(key);
    }
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  function scheduleReconnect(reason: string): void {
    if (stopping || !stored) return;
    reconnectAttempt++;
    // Exponential backoff with jitter, so a gateway restart does not get
    // hammered by every device at the same instant.
    const backoff = Math.min(RECONNECT_BASE_MS * 2 ** (reconnectAttempt - 1), RECONNECT_MAX_MS);
    const delay = backoff / 2 + Math.random() * (backoff / 2);
    setState('reconnecting', reason);
    reconnectTimer = setTimeout(() => void connect(), delay);
    reconnectTimer.unref?.();
  }

  function startHeartbeat(): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      send({ type: 'agent.heartbeat' });
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
  }

  async function connect(): Promise<void> {
    if (stopping) return;
    if (!stored) {
      setState('unpaired');
      return;
    }
    setState(reconnectAttempt > 0 ? 'reconnecting' : 'connecting');

    const ws = new WebSocket(options.gatewayUrl, { maxPayload: MAX_MESSAGE_BYTES });
    socket = ws;

    ws.on('open', () => {
      send({
        type: 'agent.hello',
        credential: stored!.credential,
        device: {
          name: options.name,
          deviceType: options.deviceType,
          platform: options.platform,
          platformVersion: options.platformVersion,
          agentVersion: options.agentVersion,
        },
        capabilities,
      });
    });

    ws.on('message', (raw: Buffer) => {
      const decoded = decodeServerMessage(raw);
      if (!decoded.ok) {
        log(`ignored malformed server frame: ${decoded.error}`);
        return;
      }
      const message = decoded.message;

      switch (message.type) {
        case 'server.welcome': {
          reconnectAttempt = 0;
          heartbeatIntervalMs = message.heartbeatIntervalMs;
          setState('connected');
          startHeartbeat();
          log(`connected as "${message.deviceName}"`, {
            accepted: message.acceptedCapabilities.length,
          });
          break;
        }
        case 'command.dispatch': {
          void runCommand({
            commandId: message.commandId,
            executionId: message.executionId,
            capability: message.capability,
            parameters: message.parameters,
            timeoutMs: message.timeoutMs,
            expiresAt: message.expiresAt,
          });
          break;
        }
        case 'command.cancel': {
          const key = `${message.commandId}:${message.executionId}`;
          const controller = inFlight.get(key);
          if (controller) {
            controller.abort();
            log(`cancelled ${message.commandId}`);
          }
          break;
        }
        case 'server.error': {
          log(`server error: ${message.code} ${message.message ?? ''}`);
          if (message.fatal) {
            // A revoked or protocol-incompatible agent must stop retrying —
            // reconnecting forever would be a self-inflicted DoS.
            if (message.code === 'unauthorized') {
              setState('revoked', 'the server rejected this device credential');
              stopping = true;
            } else {
              setState('stopped', message.code);
              stopping = true;
            }
          }
          break;
        }
      }
    });

    ws.on('close', (code: number, reasonBuffer: Buffer) => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      const reason = reasonBuffer.toString() || `code ${code}`;
      if (stopping || state === 'revoked') {
        setState(state === 'revoked' ? 'revoked' : 'stopped');
        return;
      }
      scheduleReconnect(reason);
    });

    ws.on('error', (err: Error) => {
      log(`socket error: ${err.message}`);
      // 'close' always follows, which is where reconnect is scheduled.
    });
  }

  return {
    get state(): AgentState {
      return state;
    },
    get deviceId(): string | null {
      return stored?.deviceId ?? null;
    },
    get deviceName(): string {
      return stored?.deviceName ?? options.name;
    },
    get isPaired(): boolean {
      return stored !== null;
    },
    get recentCommands(): CommandLogEntry[] {
      return [...history];
    },
    capabilities: capabilities.map((c) => c.name),
    pair,
    unpair,
    async start(): Promise<void> {
      stopping = false;
      await connect();
    },
    async stop(): Promise<void> {
      stopping = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      for (const controller of inFlight.values()) controller.abort();
      await new Promise<void>((resolve) => {
        if (!socket || socket.readyState === WebSocket.CLOSED) return resolve();
        socket.once('close', () => resolve());
        socket.close(1000, 'agent stopping');
        // Do not hang shutdown on a socket that refuses to close.
        setTimeout(resolve, 1000).unref?.();
      });
      setState('stopped');
    },
    /** Re-advertise after enabling or disabling something locally. */
    advertise(names: string[]): void {
      send({
        type: 'agent.capabilities',
        capabilities: names.map((name) => ({ name, version: 1 })),
      });
    },
  };
}

export type Agent = ReturnType<typeof createAgent>;

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
}
