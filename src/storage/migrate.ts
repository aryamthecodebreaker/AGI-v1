import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database as DbType } from 'better-sqlite3';
import { logger } from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// We use source-relative migrations so this works both in dev (tsx) and built (dist/).
// Dev: __dirname = .../src/storage, migrations live in .../src/storage/migrations.
// Built: __dirname = .../dist/storage, but migrations/*.sql aren't copied there — so we point at ../../src/storage/migrations.
function resolveMigrationsDir(): string {
  const candidates = [
    path.resolve(__dirname, 'migrations'),
    path.resolve(__dirname, '..', '..', 'src', 'storage', 'migrations'),
    path.resolve(process.cwd(), 'src', 'storage', 'migrations'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `Cannot find migrations dir. Tried:\n  ${candidates.join('\n  ')}`,
  );
}

export function runMigrations(db: DbType): void {
  // Make sure the schema_migrations table exists first (also in 001_init, but 001 itself needs to be idempotent).
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const migrationsDir = resolveMigrationsDir();
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = new Set<string>(
    db.prepare('SELECT id FROM schema_migrations').all().map((r) => (r as { id: string }).id),
  );

  const insertMigration = db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      insertMigration.run(file, Date.now());
    });
    try {
      tx();
      logger.info({ migration: file }, 'migration applied');
    } catch (err) {
      logger.error({ err, migration: file }, 'migration failed');
      throw err;
    }
  }
}
