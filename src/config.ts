import 'dotenv/config';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('127.0.0.1'),
  JWT_SECRET: z.string().min(16).optional(),
  DATA_DIR: z.string().default('./data'),
  LLM_BACKEND: z.enum(['transformers', 'scratch', 'gemini']).default('gemini'),
  LLM_MODEL_ID: z.string().default('gemini-2.5-flash-lite'),
  EMBED_MODEL_ID: z.string().default('Xenova/all-MiniLM-L6-v2'),
  GEMINI_API_KEY: z.string().optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
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
} as const;

export type Config = typeof config;
