// The gateway reads its own environment rather than importing the app's
// config.ts. That keeps it genuinely standalone: it needs no JWT secret, no
// database path and no model settings, because it never touches any of them.

import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DEVICE_GATEWAY_PORT: z.coerce.number().int().positive().default(3100),
  DEVICE_GATEWAY_HOST: z.string().default('127.0.0.1'),
  /** Shared secret for both directions of the app <-> gateway channel. */
  DEVICE_GATEWAY_INTERNAL_SECRET: z.string().min(32),
  /** Where the app lives, so the gateway can authenticate devices and post results. */
  DEVICE_GATEWAY_APP_URL: z.string().default('http://127.0.0.1:3000'),
  DEVICE_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
  DEVICE_OFFLINE_AFTER_MS: z.coerce.number().int().positive().default(45000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

export type GatewayConfig = {
  port: number;
  host: string;
  internalSecret: string;
  appUrl: string;
  heartbeatIntervalMs: number;
  offlineAfterMs: number;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error';
};

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.errors
      .map((e) => `  ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(
      `Device gateway configuration is invalid:\n${issues}\n\n` +
        `DEVICE_GATEWAY_INTERNAL_SECRET must be at least 32 characters and must match the\n` +
        `value the main app uses. Generate one with:\n` +
        `  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  const v = parsed.data;
  return {
    port: v.DEVICE_GATEWAY_PORT,
    host: v.DEVICE_GATEWAY_HOST,
    internalSecret: v.DEVICE_GATEWAY_INTERNAL_SECRET,
    appUrl: v.DEVICE_GATEWAY_APP_URL.replace(/\/+$/, ''),
    heartbeatIntervalMs: v.DEVICE_HEARTBEAT_INTERVAL_MS,
    offlineAfterMs: v.DEVICE_OFFLINE_AFTER_MS,
    logLevel: v.LOG_LEVEL,
  };
}
