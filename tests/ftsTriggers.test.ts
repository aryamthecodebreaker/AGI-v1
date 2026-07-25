import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { storageFromDb, type Storage } from '../src/storage/index.js';

/** Total bytes stored in the FTS5 index, so reindex churn is directly observable. */
function ftsIndexBytes(db: Database.Database): number {
  const row = db.prepare('SELECT SUM(LENGTH(block)) AS bytes FROM memories_fts_data').get() as {
    bytes: number | null;
  };
  return row.bytes ?? 0;
}

describe('memories FTS triggers', () => {
  let tmpPath: string;
  let db: Database.Database;
  let storage: Storage;
  let userId: string;

  beforeEach(() => {
    tmpPath = path.join(os.tmpdir(), `agi-fts-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = new Database(tmpPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    storage = storageFromDb(db);
    userId = storage.users.create({ username: 'aryam', passwordHash: 'h' }).id;
  });

  afterEach(() => {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpPath + suffix); } catch { /* ignore */ }
    }
  });

  it('does not reindex content when only last_accessed_at changes', () => {
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      ids.push(
        storage.memories.insert({
          userId,
          kind: 'fact',
          content: `The user mentioned their dog Rufus and a trip to Kyoto, note ${i}`,
        }).id,
      );
    }

    const before = ftsIndexBytes(db);
    // A hundred retrieval turns, each touching eight hits — the hot read path.
    for (let turn = 0; turn < 100; turn++) {
      for (const id of ids.slice(0, 8)) storage.memories.touchAccessed(id);
    }

    expect(ftsIndexBytes(db)).toBe(before);
  });

  it('still reindexes when content actually changes', () => {
    const memory = storage.memories.insert({
      userId,
      kind: 'fact',
      content: 'The user has a dog named Rufus',
    });

    expect(storage.memories.ftsSearch(userId, 'Rufus', 5)).toHaveLength(1);

    db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(
      'The user adopted a cat named Mochi',
      memory.id,
    );

    expect(storage.memories.ftsSearch(userId, 'Mochi', 5)).toHaveLength(1);
    expect(storage.memories.ftsSearch(userId, 'Rufus', 5)).toHaveLength(0);
  });

  it('removes deleted memories from the index', () => {
    const memory = storage.memories.insert({
      userId,
      kind: 'fact',
      content: 'The user is allergic to peanuts',
    });

    expect(storage.memories.ftsSearch(userId, 'peanuts', 5)).toHaveLength(1);

    db.prepare('DELETE FROM memories WHERE id = ?').run(memory.id);

    expect(storage.memories.ftsSearch(userId, 'peanuts', 5)).toHaveLength(0);
  });
});
