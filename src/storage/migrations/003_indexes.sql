-- 003_indexes.sql — performance indexes.
CREATE INDEX IF NOT EXISTS idx_messages_conv_created    ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_user_created    ON messages(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memories_user_kind       ON memories(user_id, kind);
CREATE INDEX IF NOT EXISTS idx_memories_user_created    ON memories(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memories_user_importance ON memories(user_id, importance DESC);
CREATE INDEX IF NOT EXISTS idx_people_user_canonical    ON people(user_id, canonical_name);
CREATE INDEX IF NOT EXISTS idx_people_user_lastmention  ON people(user_id, last_mentioned_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_user_upd   ON conversations(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user            ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_person_memories_memory   ON person_memories(memory_id);
