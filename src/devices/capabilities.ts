// The capability registry — the complete, closed set of things a device may be
// asked to do.
//
// This file is the security boundary for device actions. A command can only be
// built from a capability that appears here, its parameters must satisfy that
// capability's input schema, and the target device must actually advertise it.
// There is deliberately no "run this command" / "eval this script" capability:
// adding one would turn every device agent into a remote shell.
//
// Each definition carries the operational facts the dispatcher needs
// (timeout, retry-safety, parallel-safety, queueability) alongside the policy
// facts (risk, confirmation) so there is one source of truth per action.

import { z } from 'zod';
import type { DeviceType } from '../storage/repositories/deviceRepo.js';

export type RiskLevel = 'read_only' | 'low' | 'moderate' | 'high' | 'prohibited';

/** Ordering used to take the max of a capability's risk and any escalations. */
export const RISK_ORDER: readonly RiskLevel[] = [
  'read_only',
  'low',
  'moderate',
  'high',
  'prohibited',
] as const;

export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b;
}

export interface CapabilityDefinition {
  /** Stable wire name, e.g. "app.open". Never renamed — only superseded. */
  name: string;
  version: number;
  description: string;
  /** Parameters the caller must supply. Validated before anything is stored. */
  input: z.ZodType<Record<string, unknown>>;
  /** Shape the agent is expected to return. Validated on result ingest. */
  output: z.ZodType<Record<string, unknown>>;
  /** Device types that can plausibly implement this. */
  platforms: readonly DeviceType[];
  risk: RiskLevel;
  /** Always ask, regardless of fan-out. */
  requiresConfirmation: boolean;
  timeoutMs: number;
  /** Safe to run again after a failure without double side effects. */
  retrySafe: boolean;
  /** Safe to run on many devices at the same time. */
  parallelSafe: boolean;
  /** May be held for a device that is currently offline. */
  queueable: boolean;
}

const ALL_TYPES: readonly DeviceType[] = [
  'android_phone',
  'android_tablet',
  'windows',
  'browser',
  'generic',
  'simulated',
] as const;

const MOBILE_AND_DESKTOP: readonly DeviceType[] = [
  'android_phone',
  'android_tablet',
  'windows',
  'generic',
  'simulated',
] as const;

const empty = z.object({}).strict();

/**
 * Friendly app identifiers. The agent maps these to a platform-specific
 * intent/executable through its own allowlist — the server never sends a path
 * or an executable name, only a symbolic id.
 */
const appIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, 'appId must be a simple identifier, not a path or command');

/**
 * URLs are restricted to http/https. Blocking other schemes stops a planner
 * slip from turning url.open into a launcher for file://, javascript: or
 * app-specific deep links with side effects.
 */
const urlSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'url must be an absolute http(s) URL');

const DEFINITIONS: CapabilityDefinition[] = [
  {
    name: 'device.ping',
    version: 1,
    description: 'Check that a device agent is responsive.',
    input: empty,
    output: z.object({ roundTripMs: z.number().optional() }).passthrough(),
    platforms: ALL_TYPES,
    risk: 'read_only',
    requiresConfirmation: false,
    timeoutMs: 5000,
    retrySafe: true,
    parallelSafe: true,
    queueable: false,
  },
  {
    name: 'device.status',
    version: 1,
    description: 'Read a summary of device state (foreground app is not included).',
    input: empty,
    output: z
      .object({
        online: z.boolean().optional(),
        batteryPercent: z.number().min(0).max(100).optional(),
        charging: z.boolean().optional(),
        network: z.string().optional(),
        volumePercent: z.number().min(0).max(100).optional(),
      })
      .passthrough(),
    platforms: ALL_TYPES,
    risk: 'read_only',
    requiresConfirmation: false,
    timeoutMs: 5000,
    retrySafe: true,
    parallelSafe: true,
    queueable: false,
  },
  {
    name: 'battery.read',
    version: 1,
    description: 'Read battery percentage and charging state.',
    input: empty,
    output: z
      .object({
        batteryPercent: z.number().min(0).max(100),
        charging: z.boolean().optional(),
      })
      .passthrough(),
    platforms: ALL_TYPES,
    risk: 'read_only',
    requiresConfirmation: false,
    timeoutMs: 5000,
    retrySafe: true,
    parallelSafe: true,
    queueable: false,
  },
  {
    name: 'app.open',
    version: 1,
    description: 'Launch an allowlisted application by friendly id.',
    input: z.object({ appId: appIdSchema }).strict(),
    output: z.object({ launched: z.boolean().optional() }).passthrough(),
    platforms: MOBILE_AND_DESKTOP,
    risk: 'low',
    requiresConfirmation: false,
    timeoutMs: 15000,
    // Opening an already-open app is harmless, so a retry cannot compound.
    retrySafe: true,
    parallelSafe: true,
    queueable: true,
  },
  {
    name: 'url.open',
    version: 1,
    description: 'Open an http(s) URL in the default browser.',
    input: z.object({ url: urlSchema }).strict(),
    output: z.object({ opened: z.boolean().optional() }).passthrough(),
    platforms: ALL_TYPES,
    risk: 'low',
    requiresConfirmation: false,
    timeoutMs: 15000,
    retrySafe: true,
    parallelSafe: true,
    queueable: true,
  },
  {
    name: 'media.play',
    version: 1,
    description: 'Resume media playback.',
    input: empty,
    output: empty.passthrough(),
    platforms: ALL_TYPES,
    risk: 'low',
    requiresConfirmation: false,
    timeoutMs: 8000,
    retrySafe: true,
    parallelSafe: true,
    queueable: false,
  },
  {
    name: 'media.pause',
    version: 1,
    description: 'Pause media playback.',
    input: empty,
    output: empty.passthrough(),
    platforms: ALL_TYPES,
    risk: 'low',
    requiresConfirmation: false,
    timeoutMs: 8000,
    retrySafe: true,
    parallelSafe: true,
    queueable: false,
  },
  {
    name: 'media.next',
    version: 1,
    description: 'Skip to the next track.',
    input: empty,
    output: empty.passthrough(),
    platforms: ALL_TYPES,
    risk: 'low',
    requiresConfirmation: false,
    timeoutMs: 8000,
    // Skipping twice skips two tracks, so an automatic retry is not safe.
    retrySafe: false,
    parallelSafe: true,
    queueable: false,
  },
  {
    name: 'media.previous',
    version: 1,
    description: 'Go back to the previous track.',
    input: empty,
    output: empty.passthrough(),
    platforms: ALL_TYPES,
    risk: 'low',
    requiresConfirmation: false,
    timeoutMs: 8000,
    retrySafe: false,
    parallelSafe: true,
    queueable: false,
  },
  {
    name: 'volume.get',
    version: 1,
    description: 'Read the current output volume.',
    input: empty,
    output: z
      .object({ volumePercent: z.number().min(0).max(100), muted: z.boolean().optional() })
      .passthrough(),
    platforms: ALL_TYPES,
    risk: 'read_only',
    requiresConfirmation: false,
    timeoutMs: 5000,
    retrySafe: true,
    parallelSafe: true,
    queueable: false,
  },
  {
    name: 'volume.set',
    version: 1,
    description: 'Set output volume to an absolute percentage.',
    input: z.object({ percent: z.number().int().min(0).max(100) }).strict(),
    output: z.object({ volumePercent: z.number().min(0).max(100).optional() }).passthrough(),
    platforms: ALL_TYPES,
    risk: 'low',
    requiresConfirmation: false,
    timeoutMs: 8000,
    // Absolute, so replaying it lands on the same value.
    retrySafe: true,
    parallelSafe: true,
    queueable: false,
  },
  {
    name: 'volume.mute',
    version: 1,
    description: 'Mute device audio output.',
    input: empty,
    output: z.object({ muted: z.boolean().optional() }).passthrough(),
    platforms: ALL_TYPES,
    risk: 'low',
    requiresConfirmation: false,
    timeoutMs: 8000,
    retrySafe: true,
    parallelSafe: true,
    queueable: false,
  },
  {
    name: 'volume.unmute',
    version: 1,
    description: 'Unmute device audio output.',
    input: empty,
    output: z.object({ muted: z.boolean().optional() }).passthrough(),
    platforms: ALL_TYPES,
    risk: 'low',
    requiresConfirmation: false,
    timeoutMs: 8000,
    retrySafe: true,
    parallelSafe: true,
    queueable: false,
  },
  {
    name: 'screen.read',
    version: 1,
    description:
      'Look at a screen the user explicitly shares and answer a question about it. The browser shows a picker; the user chooses what is shared.',
    input: z
      .object({
        question: z.string().min(1).max(500).default('What is on this screen?'),
      })
      .strict(),
    output: z.object({ answer: z.string().optional() }).passthrough(),
    // Browser only, and on purpose. The browser's getDisplayMedia() makes the
    // operating system ask which window or screen to share, so consent is
    // enforced by the platform rather than by this code. A silent OS-level
    // screenshot would be a different and much worse feature — see
    // docs/security-threat-model.md.
    platforms: ['browser'],
    // It can see anything on screen: passwords, private messages, other
    // people's data. It always asks first, and no fan-out escalation can
    // downgrade that.
    risk: 'high',
    requiresConfirmation: true,
    timeoutMs: 60_000,
    // Re-running means a second capture and a second share prompt.
    retrySafe: false,
    parallelSafe: false,
    queueable: false,
  },
  {
    name: 'screen.wake',
    version: 1,
    description: 'Wake the screen where the platform permits it. Never unlocks the device.',
    input: empty,
    output: z.object({ woken: z.boolean().optional() }).passthrough(),
    platforms: MOBILE_AND_DESKTOP,
    risk: 'low',
    requiresConfirmation: false,
    timeoutMs: 8000,
    retrySafe: true,
    parallelSafe: true,
    queueable: false,
  },
  {
    name: 'notification.show',
    version: 1,
    description: 'Show a local notification on the device.',
    input: z
      .object({
        title: z.string().min(1).max(120),
        body: z.string().max(500).optional(),
      })
      .strict(),
    output: z.object({ shown: z.boolean().optional() }).passthrough(),
    platforms: ALL_TYPES,
    risk: 'low',
    requiresConfirmation: false,
    timeoutMs: 10000,
    // Retrying would show a second notification; only do it on explicit ask.
    retrySafe: false,
    parallelSafe: true,
    queueable: true,
  },
];

const REGISTRY = new Map<string, CapabilityDefinition>(DEFINITIONS.map((d) => [d.name, d]));

/**
 * Capability names that must never be honoured, even if a device agent
 * advertises them or a model invents them. These are refused at every layer:
 * capability lookup, agent advertisement, and command creation.
 *
 * This is a hard denylist, not a policy knob — there is no configuration that
 * turns any of these on.
 */
export const PROHIBITED_CAPABILITIES: readonly string[] = [
  'shell.exec',
  'shell.run',
  'process.spawn',
  'script.run',
  'script.eval',
  'code.execute',
  'file.delete',
  'file.read',
  'file.write',
  'camera.capture',
  'camera.stream',
  'mic.record',
  'audio.record',
  'screen.record',
  // Silent, OS-level screenshotting stays prohibited. `screen.read` is NOT this:
  // it goes through the browser's getDisplayMedia(), so the operating system
  // asks which window to share and the user picks. Consent enforced by the
  // platform is the whole difference between the two.
  'screen.capture',
  'keylog.start',
  'input.inject',
  'lockscreen.bypass',
  'lockscreen.unlock',
  'biometric.bypass',
  'credentials.read',
  'keychain.read',
  'security.disable',
  'antivirus.disable',
  'privilege.escalate',
  'purchase.make',
  'payment.send',
  'message.send',
  'sms.send',
  'call.place',
  'location.track',
] as const;

const PROHIBITED_SET = new Set(PROHIBITED_CAPABILITIES);

export function isProhibitedCapability(name: string): boolean {
  return PROHIBITED_SET.has(name);
}

export function getCapability(name: string): CapabilityDefinition | null {
  if (isProhibitedCapability(name)) return null;
  return REGISTRY.get(name) ?? null;
}

export function listCapabilities(): CapabilityDefinition[] {
  return [...DEFINITIONS];
}

export function capabilityNames(): string[] {
  return DEFINITIONS.map((d) => d.name);
}

export function capabilitySupportsDeviceType(
  cap: CapabilityDefinition,
  type: DeviceType,
): boolean {
  return cap.platforms.includes(type);
}

export interface ValidatedParameters {
  ok: true;
  parameters: Record<string, unknown>;
}
export interface InvalidParameters {
  ok: false;
  error: string;
}

/**
 * Validate caller-supplied parameters against a capability's input schema.
 * Anything that fails here never reaches storage, let alone a device.
 */
export function validateParameters(
  cap: CapabilityDefinition,
  raw: unknown,
): ValidatedParameters | InvalidParameters {
  const parsed = cap.input.safeParse(raw ?? {});
  if (!parsed.success) {
    const first = parsed.error.errors[0];
    const path = first?.path.join('.');
    return {
      ok: false,
      error: `${cap.name}: ${path ? `${path} — ` : ''}${first?.message ?? 'invalid parameters'}`,
    };
  }
  return { ok: true, parameters: parsed.data };
}

/**
 * Validate an agent's result payload. A malformed result is downgraded to an
 * empty object rather than rejected outright — the action may genuinely have
 * happened, and dropping the whole result would misreport it as a failure.
 */
export function validateResult(
  cap: CapabilityDefinition,
  raw: unknown,
): Record<string, unknown> {
  const parsed = cap.output.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

/** Short human phrase used when the assistant describes a command. */
export function describeCapability(name: string, parameters: Record<string, unknown>): string {
  switch (name) {
    case 'app.open':
      return `open ${String(parameters.appId ?? 'an app')}`;
    case 'url.open':
      return `open ${String(parameters.url ?? 'a link')}`;
    case 'volume.set':
      return `set volume to ${String(parameters.percent ?? '?')}%`;
    case 'volume.mute':
      return 'mute';
    case 'volume.unmute':
      return 'unmute';
    case 'volume.get':
      return 'read the volume';
    case 'media.play':
      return 'resume playback';
    case 'media.pause':
      return 'pause playback';
    case 'media.next':
      return 'skip to the next track';
    case 'media.previous':
      return 'go to the previous track';
    case 'battery.read':
      return 'read the battery level';
    case 'device.status':
      return 'read device status';
    case 'device.ping':
      return 'ping';
    case 'screen.wake':
      return 'wake the screen';
    case 'notification.show':
      return `show a notification${parameters.title ? ` titled "${String(parameters.title)}"` : ''}`;
    default:
      return name;
  }
}
