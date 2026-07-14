import type { NeonQueryFunction } from '@neondatabase/serverless';
import { now } from '../../util/time.js';

type Sql = NeonQueryFunction<false, false>;

const schemaMigrationStatement = `CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at BIGINT NOT NULL
  )`;

const migrations = [
  {
    id: '001_shared_postgres',
    statements: [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'New chat',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
    content TEXT NOT NULL,
    token_count INTEGER,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
    source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('raw_turn','fact','summary')),
    content TEXT NOT NULL,
    importance DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    embedding JSONB,
    created_at BIGINT NOT NULL,
    last_accessed_at BIGINT
  )`,
  `CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    canonical_name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
    relationship TEXT,
    summary TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    first_seen_at BIGINT NOT NULL,
    last_mentioned_at BIGINT NOT NULL,
    mention_count INTEGER NOT NULL DEFAULT 1,
    UNIQUE (user_id, canonical_name)
  )`,
  `CREATE TABLE IF NOT EXISTS person_memories (
    person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    PRIMARY KEY (person_id, memory_id)
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    revoked_at BIGINT
  )`,
  'CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages(conversation_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages(user_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_memories_user_kind ON memories(user_id, kind)',
  'CREATE INDEX IF NOT EXISTS idx_memories_user_created_desc ON memories(user_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_memories_user_importance ON memories(user_id, importance DESC)',
  "CREATE INDEX IF NOT EXISTS idx_memories_content_fts ON memories USING GIN (to_tsvector('simple', content))",
  'CREATE INDEX IF NOT EXISTS idx_people_user_canonical ON people(user_id, canonical_name)',
  'CREATE INDEX IF NOT EXISTS idx_people_user_lastmention ON people(user_id, last_mentioned_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_conversations_user_upd ON conversations(user_id, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_person_memories_memory ON person_memories(memory_id)',
    ],
  },
  {
    id: '002_capability_requests',
    statements: [
      `CREATE TABLE IF NOT EXISTS capability_requests (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        task TEXT NOT NULL,
        slug TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending','generating','validating','pr_opened','failed')),
        branch_name TEXT,
        pr_url TEXT,
        sandbox_summary TEXT,
        error TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_capability_requests_user_created
        ON capability_requests(user_id, created_at DESC)`,
    ],
  },
] as const;

export async function runPostgresMigrations(sql: Sql): Promise<void> {
  await sql.query(schemaMigrationStatement, []);
  const appliedRows = await sql.query('SELECT id FROM schema_migrations', []) as Array<{ id: string }>;
  const applied = new Set(appliedRows.map((row) => row.id));

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    // Every statement is idempotent. That makes concurrent cold starts safe
    // even if two functions both reach this point before the marker is inserted.
    for (const statement of migration.statements) {
      await sql.query(statement, []);
    }
    await sql.query(
      'INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [migration.id, now()],
    );
  }
}
