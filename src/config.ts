import 'dotenv/config';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  JWT_SECRET: z.string().min(32).optional(),
  DATA_DIR: z.string().default('/tmp/agi-data'),
  LLM_BACKEND: z.enum(['transformers', 'scratch', 'gemini', 'openrouter']).default('gemini'),
  LLM_MODEL_ID: z.string().default('gemini-3-flash-preview'),
  EMBED_MODEL_ID: z.string().default('Xenova/all-MiniLM-L6-v2'),
  GEMINI_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_FALLBACK_MODEL_IDS: z.string().default(''),
  OPENROUTER_TASK_FALLBACK_MODEL_ID: z.string().trim().min(1).default('openrouter/free'),
  OPENROUTER_WEB_SEARCH_MODEL_ID: z.string().trim().min(1).default('openrouter/free'),
  OPENROUTER_WEB_SEARCH_ENABLED: z.string().default('true')
    .transform((value) => value.trim().toLowerCase() === 'true'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

function ensureJwtSecret(): string {
  const existing = process.env.JWT_SECRET;
  if (existing && existing.length >= 32) return existing;

  // Never generate per-instance auth secrets in production. On serverless
  // hosts that would make otherwise-valid cookies fail on another instance.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set in production environment via environment variable');
  }

  // Generate a secret and persist it to .env so restarts keep the same value.
  const generated = crypto.randomBytes(48).toString('hex');
  
  // Only write to .env in non-serverless environments
  if (!process.env.VERCEL && process.env.NODE_ENV !== 'production') {
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
  openRouterApiKey: parsed.OPENROUTER_API_KEY,
  openRouterFallbackModelIds: parsed.OPENROUTER_FALLBACK_MODEL_IDS
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean),
  openRouterTaskFallbackModelId: parsed.OPENROUTER_TASK_FALLBACK_MODEL_ID,
  openRouterWebSearchModelId: parsed.OPENROUTER_WEB_SEARCH_MODEL_ID,
  openRouterWebSearchEnabled: parsed.OPENROUTER_WEB_SEARCH_ENABLED,
  logLevel: parsed.LOG_LEVEL,
  rateLimitWindowMs: parsed.RATE_LIMIT_WINDOW_MS,
  rateLimitMaxRequests: parsed.RATE_LIMIT_MAX_REQUESTS,
  nodeEnv: parsed.NODE_ENV,
} as const;

export type Config = typeof config;
