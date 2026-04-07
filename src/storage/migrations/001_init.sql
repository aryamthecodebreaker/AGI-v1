-- 001_init.sql — core schema for the STORAGE brain.
-- Note: journal_mode/synchronous/foreign_keys pragmas are set per-connection in src/storage/db.ts.
-- They cannot be set inside a transaction, and migrations run inside one.

CREATE TABLE IF NOT EXISTS schema_migrations (
  id         TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- Users (multi-user auth)
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  display_name   TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- Conversations (chat threads)
CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT 'New chat',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Messages: immutable log of every turn.
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content         TEXT NOT NULL,
  token_count     INTEGER,
  created_at      INTEGER NOT NULL
);

-- Memories: retrieval surface. kind = raw_turn | fact | summary.
-- Embeddings stored as BLOB (Float32Array serialized).
CREATE TABLE IF NOT EXISTS memories (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id   TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('raw_turn','fact','summary')),
  content           TEXT NOT NULL,
  importance        REAL NOT NULL DEFAULT 0.5,
  embedding         BLOB,
  created_at        INTEGER NOT NULL,
  last_accessed_at  INTEGER
);

-- People: per-user roster of humans mentioned in chat.
CREATE TABLE IF NOT EXISTS people (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  canonical_name    TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  aliases           TEXT NOT NULL DEFAULT '[]',
  relationship      TEXT,
  summary           TEXT,
  metadata          TEXT NOT NULL DEFAULT '{}',
  first_seen_at     INTEGER NOT NULL,
  last_mentioned_at INTEGER NOT NULL,
  mention_count     INTEGER NOT NULL DEFAULT 1,
  UNIQUE (user_id, canonical_name)
);

-- Edges from people -> memories.
CREATE TABLE IF NOT EXISTS person_memories (
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  PRIMARY KEY (person_id, memory_id)
);

-- Sessions (JWT revocation list, optional for v1)
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
