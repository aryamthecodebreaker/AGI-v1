-- 004_fts_update_scope.sql — stop reindexing FTS when only bookkeeping columns change.
--
-- 002_fts.sql created memories_au as `AFTER UPDATE ON memories`, which fires for a write
-- to any column. Retrieval calls touchAccessed() on every hit to set last_accessed_at, so
-- an ordinary chat turn re-tokenized and reinserted the FTS entry for up to eight memories
-- whose content had not changed. The index grew on every read and the tokenizer ran for
-- nothing.
--
-- Scoping to `UPDATE OF content` with a value guard keeps content edits correctly
-- reindexed while leaving last_accessed_at writes alone. `CREATE TRIGGER IF NOT EXISTS`
-- in 002 will not replace an existing trigger, so drop it explicitly first.

DROP TRIGGER IF EXISTS memories_au;

CREATE TRIGGER memories_au AFTER UPDATE OF content ON memories
WHEN old.content IS NOT new.content
BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;
