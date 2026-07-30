import 'dotenv/config';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

/**
 * Env booleans. `z.coerce.boolean()` is wrong here — it follows JS truthiness,
 * so the string "false" would parse as true.
 */
const envBool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : /^(1|true|yes|on)$/i.test(v)));

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('127.0.0.1'),
  JWT_SECRET: z.string().min(16).optional(),
  DATA_DIR: z.string().default('./data'),
  LLM_BACKEND: z.enum(['transformers', 'scratch', 'gemini']).default('gemini'),
  LLM_MODEL_ID: z.string().default('gemini-2.5-flash'),
  EMBED_MODEL_ID: z.string().default('Xenova/all-MiniLM-L6-v2'),
  GEMINI_API_KEY: z.string().optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  // ---- AGI Command (device control) ----
  // Off by default: a fresh clone behaves exactly like AGI-v1 did before.
  AGI_COMMAND_ENABLED: envBool(false),
  // Where the main app reaches the long-running gateway. Empty = no gateway
  // configured, which the app reports as "device control unavailable".
  DEVICE_GATEWAY_URL: z.string().default(''),
  // Shared secret for the app <-> gateway internal API. Never sent to browsers.
  DEVICE_GATEWAY_INTERNAL_SECRET: z.string().default(''),
  // Port the standalone gateway process listens on.
  DEVICE_GATEWAY_PORT: z.coerce.number().int().positive().default(3100),
  // Where the gateway calls back into the app to authenticate devices and post
  // results. Defaults to the local app in dev.
  DEVICE_GATEWAY_APP_URL: z.string().default(''),
  DEVICE_PAIRING_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  DEVICE_COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  DEVICE_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
  DEVICE_OFFLINE_AFTER_MS: z.coerce.number().int().positive().default(45000),
  DEVICE_EVENT_RETENTION_DAYS: z.coerce.number().int().positive().default(30),

  // ---- Voice ----
  // "browser" uses the Web Speech API in the client; hosted STT/TTS providers
  // slot in behind the same provider-neutral interface.
  VOICE_BACKEND: z.enum(['browser', 'none']).default('browser'),
  VOICE_STT_BACKEND: z.string().default(''),
  VOICE_TTS_BACKEND: z.string().default(''),
});

function ensureJwtSecret(): string {
  const existing = process.env.JWT_SECRET;
  if (existing && existing.length >= 16) return existing;

  // Generate a secret and persist it to .env so restarts keep the same value.
  const generated = crypto.randomBytes(48).toString('hex');
  const envPath = path.resolve(process.cwd(), '.env');
  let existingFile = '';
  try {
    existingFile = fs.readFileSync(envPath, 'utf8');
  } catch {
    /* no .env yet */
  }
  const line = `JWT_SECRET=${generated}`;
  const updated = existingFile.match(/^JWT_SECRET=.*/m)
    ? existingFile.replace(/^JWT_SECRET=.*/m, line)
    : (existingFile ? existingFile.replace(/\s*$/, '') + '\n' : '') + line + '\n';
  try {
    fs.writeFileSync(envPath, updated, 'utf8');
    // eslint-disable-next-line no-console
    console.warn(
      '[config] No JWT_SECRET found — generated one and wrote it to .env. Restart so sessions are stable.',
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[config] Could not persist JWT_SECRET to .env:', (e as Error).message);
  }
  process.env.JWT_SECRET = generated;
  return generated;
}

const parsed = envSchema.parse({
  ...process.env,
  JWT_SECRET: process.env.JWT_SECRET || ensureJwtSecret(),
});

const dataDir = path.resolve(process.cwd(), parsed.DATA_DIR);
const modelsDir = path.join(dataDir, 'models');
const dbPath = path.join(dataDir, 'agi.db');
const scratchCheckpointDir = path.join(dataDir, 'scratch_checkpoints');

// Ensure directories exist up-front.
for (const dir of [dataDir, modelsDir, scratchCheckpointDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Tunables for the AGI Command subsystem. Passed explicitly into the device
 * services rather than read from module scope, so tests can drive short
 * timeouts without mutating process.env.
 */
export interface DeviceSettings {
  enabled: boolean;
  gatewayUrl: string;
  gatewayInternalSecret: string;
  gatewayPort: number;
  gatewayAppUrl: string;
  pairingTtlMs: number;
  commandTimeoutMs: number;
  heartbeatIntervalMs: number;
  offlineAfterMs: number;
  eventRetentionDays: number;
}

export const deviceSettings: DeviceSettings = {
  enabled: parsed.AGI_COMMAND_ENABLED,
  gatewayUrl: parsed.DEVICE_GATEWAY_URL,
  gatewayInternalSecret: parsed.DEVICE_GATEWAY_INTERNAL_SECRET,
  gatewayPort: parsed.DEVICE_GATEWAY_PORT,
  gatewayAppUrl:
    parsed.DEVICE_GATEWAY_APP_URL || `http://127.0.0.1:${parsed.PORT}`,
  pairingTtlMs: parsed.DEVICE_PAIRING_TTL_SECONDS * 1000,
  commandTimeoutMs: parsed.DEVICE_COMMAND_TIMEOUT_MS,
  heartbeatIntervalMs: parsed.DEVICE_HEARTBEAT_INTERVAL_MS,
  offlineAfterMs: parsed.DEVICE_OFFLINE_AFTER_MS,
  eventRetentionDays: parsed.DEVICE_EVENT_RETENTION_DAYS,
};

/**
 * Fail loudly rather than running a device-control feature with no shared
 * secret between the app and the gateway. Only enforced when the feature is
 * actually switched on, so the default config path stays frictionless.
 */
export function assertDeviceConfig(s: DeviceSettings = deviceSettings): void {
  if (!s.enabled) return;
  const missing: string[] = [];
  if (!s.gatewayInternalSecret) missing.push('DEVICE_GATEWAY_INTERNAL_SECRET');
  if (!s.gatewayUrl) missing.push('DEVICE_GATEWAY_URL');
  if (missing.length > 0) {
    throw new Error(
      `AGI_COMMAND_ENABLED=true but ${missing.join(' and ')} ${
        missing.length > 1 ? 'are' : 'is'
      } not set.\n` +
        `Set them in .env (see .env.example). Generate a secret with:\n` +
        `  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  if (s.gatewayInternalSecret.length < 32) {
    throw new Error(
      'DEVICE_GATEWAY_INTERNAL_SECRET must be at least 32 characters — it authenticates the app <-> gateway channel.',
    );
  }
}

export const config = {
  port: parsed.PORT,
  host: parsed.HOST,
  jwtSecret: parsed.JWT_SECRET!,
  dataDir,
  modelsDir,
  dbPath,
  scratchCheckpointDir,
  llmBackend: parsed.LLM_BACKEND,
  llmModelId: parsed.LLM_MODEL_ID,
  embedModelId: parsed.EMBED_MODEL_ID,
  geminiApiKey: parsed.GEMINI_API_KEY,
  logLevel: parsed.LOG_LEVEL,
  devices: deviceSettings,
  voice: {
    backend: parsed.VOICE_BACKEND,
    sttBackend: parsed.VOICE_STT_BACKEND,
    ttsBackend: parsed.VOICE_TTS_BACKEND,
  },
} as const;

export type Config = typeof config;
