import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LlmBackend } from '../src/llm/types.js';
import { extractAndStoreMemory, extractExplicitSelfFacts } from '../src/brain/memoryExtraction.js';
import { storageFromDb } from '../src/storage/index.js';

vi.mock('../src/llm/embeddings.js', () => ({
  embed: vi.fn(async () => new Float32Array(384)),
}));

function extractionBackend(result: string): LlmBackend {
  return {
    name: 'test:extraction',
    ready: async () => {},
    generate: async function* () {},
    generateOnce: async () => result,
  };
}

describe('durable memory extraction fallback', () => {
  let tmpPath: string;
  let db: Database.Database;
  let storage: ReturnType<typeof storageFromDb>;

  beforeEach(() => {
    tmpPath = path.join(os.tmpdir(), `agi-memory-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = new Database(tmpPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    storage = storageFromDb(db);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath + '-wal'); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath + '-shm'); } catch { /* ignore */ }
  });

  it('extracts multiple explicit self facts without storing common secrets', () => {
    expect(extractExplicitSelfFacts(
      'My favorite test color is ultramarine and my test city is Pune.',
    )).toEqual([
      { fact: "The user's favorite test color is ultramarine.", people: [] },
      { fact: "The user's test city is Pune.", people: [] },
    ]);
    expect(extractExplicitSelfFacts('My API key is do-not-store-this.')).toEqual([]);
  });

  it.each(['{"people":[],"facts":[]}', 'not valid JSON'])(
    'stores explicit facts when the model extraction is empty or malformed: %s',
    async (modelResult) => {
      const user = storage.users.create({ username: `memory-${Math.random()}`, passwordHash: 'h' });
      const conversation = storage.conversations.create(user.id, 'Fallback test');
      const source = storage.messages.insert({
        userId: user.id,
        conversationId: conversation.id,
        role: 'user',
        content: 'My favorite test color is ultramarine and my test city is Pune.',
      });

      await extractAndStoreMemory(storage, extractionBackend(modelResult), {
        userId: user.id,
        conversationId: conversation.id,
        sourceMessageId: source.id,
        userMessage: source.content,
        assistantMessage: 'Thanks, I will remember that.',
      });

      expect(
        storage.memories.listRecentByUser(user.id, 20)
          .filter((memory) => memory.kind === 'fact')
          .map((memory) => memory.content)
          .sort(),
      ).toEqual([
        "The user's favorite test color is ultramarine.",
        "The user's test city is Pune.",
      ].sort());
    },
  );
});
