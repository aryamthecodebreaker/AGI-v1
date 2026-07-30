// The device-agent wire protocol.
//
// Shared by the server, the gateway, and every TypeScript agent, so a protocol
// change is a compile error rather than a runtime mystery. The Kotlin agent
// mirrors these shapes by hand — see docs/device-protocol.md, which is the
// normative description for non-TypeScript agents.
//
// Two rules hold everywhere:
//   1. Every inbound frame is validated before a single field is trusted.
//   2. Nothing is logged without going through redactMessage() first, because
//      agent.hello carries a device credential.

import { z } from 'zod';

/**
 * Bump the minor for additive changes, the major for breaking ones. The gateway
 * accepts any agent whose major matches; a mismatched major is refused with a
 * clear error rather than being half-understood.
 */
export const PROTOCOL_VERSION = 'agi-command/1';

/** Frames larger than this are dropped without parsing. */
export const MAX_MESSAGE_BYTES = 64 * 1024;

export function protocolMajor(version: string): string {
  return version.split('/')[1]?.split('.')[0] ?? '';
}

export function isCompatibleProtocol(version: string): boolean {
  return protocolMajor(version) === protocolMajor(PROTOCOL_VERSION);
}

const capabilityAdvert = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*$/, 'capability must look like "group.action"'),
  version: z.number().int().min(1).max(1000).default(1),
});

export type CapabilityAdvert = z.infer<typeof capabilityAdvert>;

const deviceTypeSchema = z.enum([
  'android_phone',
  'android_tablet',
  'windows',
  'browser',
  'generic',
  'simulated',
]);

// ---------------------------------------------------------------------------
// Agent -> server
// ---------------------------------------------------------------------------

/**
 * First frame on every connection. `credential` is the device's own bearer
 * credential, never a user JWT, and is stripped from all logs.
 */
export const agentHelloSchema = z.object({
  v: z.string(),
  type: z.literal('agent.hello'),
  ts: z.number().int().nonnegative(),
  credential: z.string().min(8).max(512),
  device: z.object({
    name: z.string().min(1).max(80).optional(),
    deviceType: deviceTypeSchema.optional(),
    platform: z.string().max(64).optional(),
    platformVersion: z.string().max(64).optional(),
    agentVersion: z.string().max(32).optional(),
  }),
  capabilities: z.array(capabilityAdvert).max(200).default([]),
});

export const agentHeartbeatSchema = z.object({
  v: z.string(),
  type: z.literal('agent.heartbeat'),
  ts: z.number().int().nonnegative(),
});

export const agentCapabilitiesSchema = z.object({
  v: z.string(),
  type: z.literal('agent.capabilities'),
  ts: z.number().int().nonnegative(),
  capabilities: z.array(capabilityAdvert).max(200),
});

export const commandAcknowledgedSchema = z.object({
  v: z.string(),
  type: z.literal('command.acknowledged'),
  ts: z.number().int().nonnegative(),
  commandId: z.string().min(1).max(64),
  executionId: z.string().min(1).max(64),
});

export const commandProgressSchema = z.object({
  v: z.string(),
  type: z.literal('command.progress'),
  ts: z.number().int().nonnegative(),
  commandId: z.string().min(1).max(64),
  executionId: z.string().min(1).max(64),
  percent: z.number().min(0).max(100).optional(),
  message: z.string().max(200).optional(),
});

export const commandCompletedSchema = z.object({
  v: z.string(),
  type: z.literal('command.completed'),
  ts: z.number().int().nonnegative(),
  commandId: z.string().min(1).max(64),
  executionId: z.string().min(1).max(64),
  result: z.record(z.unknown()).optional(),
});

export const commandFailedSchema = z.object({
  v: z.string(),
  type: z.literal('command.failed'),
  ts: z.number().int().nonnegative(),
  commandId: z.string().min(1).max(64),
  executionId: z.string().min(1).max(64),
  /** `unsupported` and `rejected` map to distinct execution states. */
  code: z.enum(['unsupported', 'rejected', 'failed', 'duplicate', 'invalid_parameters']),
  message: z.string().max(400).optional(),
});

export const agentErrorSchema = z.object({
  v: z.string(),
  type: z.literal('agent.error'),
  ts: z.number().int().nonnegative(),
  code: z.string().max(64),
  message: z.string().max(400).optional(),
});

export const agentMessageSchema = z.discriminatedUnion('type', [
  agentHelloSchema,
  agentHeartbeatSchema,
  agentCapabilitiesSchema,
  commandAcknowledgedSchema,
  commandProgressSchema,
  commandCompletedSchema,
  commandFailedSchema,
  agentErrorSchema,
]);

export type AgentMessage = z.infer<typeof agentMessageSchema>;
export type AgentHello = z.infer<typeof agentHelloSchema>;
export type CommandFailed = z.infer<typeof commandFailedSchema>;

// ---------------------------------------------------------------------------
// Server -> agent
// ---------------------------------------------------------------------------

export const serverWelcomeSchema = z.object({
  v: z.string(),
  type: z.literal('server.welcome'),
  ts: z.number().int().nonnegative(),
  deviceId: z.string(),
  deviceName: z.string(),
  heartbeatIntervalMs: z.number().int().positive(),
  /** Capabilities the server will actually accept from this device. */
  acceptedCapabilities: z.array(z.string()),
});

export const commandDispatchSchema = z.object({
  v: z.string(),
  type: z.literal('command.dispatch'),
  ts: z.number().int().nonnegative(),
  commandId: z.string(),
  executionId: z.string(),
  capability: z.string(),
  capabilityVersion: z.number().int().min(1),
  parameters: z.record(z.unknown()),
  timeoutMs: z.number().int().positive(),
  /** Absolute epoch ms. Agents must refuse to run a dispatch past this. */
  expiresAt: z.number().int().positive(),
});

export const commandCancelSchema = z.object({
  v: z.string(),
  type: z.literal('command.cancel'),
  ts: z.number().int().nonnegative(),
  commandId: z.string(),
  executionId: z.string(),
});

export const serverErrorSchema = z.object({
  v: z.string(),
  type: z.literal('server.error'),
  ts: z.number().int().nonnegative(),
  code: z.string(),
  message: z.string().optional(),
  /** Set when the agent should stop retrying (revoked, bad protocol). */
  fatal: z.boolean().optional(),
});

export const serverMessageSchema = z.discriminatedUnion('type', [
  serverWelcomeSchema,
  commandDispatchSchema,
  commandCancelSchema,
  serverErrorSchema,
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type CommandDispatch = z.infer<typeof commandDispatchSchema>;
export type ServerWelcome = z.infer<typeof serverWelcomeSchema>;

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

export interface DecodeSuccess<T> {
  ok: true;
  message: T;
}
export interface DecodeFailure {
  ok: false;
  code: 'too_large' | 'malformed' | 'bad_protocol' | 'unknown_type';
  error: string;
}
export type DecodeResult<T> = DecodeSuccess<T> | DecodeFailure;

// Generic over the schema, not its output type: several schemas use .default(),
// which gives them different input and output types and does not fit
// z.ZodType<T>'s single parameter.
function decodeWith<S extends z.ZodTypeAny>(
  schema: S,
  raw: string | Buffer,
): DecodeResult<z.infer<S>> {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) {
    return { ok: false, code: 'too_large', error: 'message exceeds size limit' };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, code: 'malformed', error: 'not valid JSON' };
  }
  if (typeof json !== 'object' || json === null) {
    return { ok: false, code: 'malformed', error: 'expected a JSON object' };
  }
  const version = (json as { v?: unknown }).v;
  if (typeof version !== 'string' || !isCompatibleProtocol(version)) {
    return {
      ok: false,
      code: 'bad_protocol',
      error: `expected protocol ${PROTOCOL_VERSION}, got ${String(version)}`,
    };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.errors[0];
    const known = first?.code === 'invalid_union_discriminator';
    return {
      ok: false,
      code: known ? 'unknown_type' : 'malformed',
      error: `${first?.path.join('.') || 'message'}: ${first?.message ?? 'invalid'}`,
    };
  }
  return { ok: true, message: parsed.data };
}

export function decodeAgentMessage(raw: string | Buffer): DecodeResult<AgentMessage> {
  return decodeWith(agentMessageSchema, raw);
}

export function decodeServerMessage(raw: string | Buffer): DecodeResult<ServerMessage> {
  return decodeWith(serverMessageSchema, raw);
}

/** Stamp version + timestamp so callers never hand-write an envelope. */
export function encode<T extends { type: string }>(
  message: T & { v?: string; ts?: number },
): string {
  return JSON.stringify({ ...message, v: PROTOCOL_VERSION, ts: message.ts ?? Date.now() });
}

/**
 * Strip secrets before logging. agent.hello carries a live device credential,
 * so this must be applied on every log path that touches a protocol frame.
 */
export function redactMessage(message: unknown): unknown {
  if (typeof message !== 'object' || message === null) return message;
  const copy: Record<string, unknown> = { ...(message as Record<string, unknown>) };
  if ('credential' in copy) copy.credential = '[redacted]';
  if ('token' in copy) copy.token = '[redacted]';
  if ('secret' in copy) copy.secret = '[redacted]';
  return copy;
}
