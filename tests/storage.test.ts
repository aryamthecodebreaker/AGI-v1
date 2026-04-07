import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { storageFromDb, type Storage } from '../src/storage/index.js';
import { EMBED_DIM, l2Normalize } from '../src/storage/vector.js';

/** Deterministic embedding: hash the text into a small bag of indices, mark them ±1, normalize. */
function fakeEmbed(text: string): Float32Array {
  const v = new Float32Array(EMBED_DIM);
  const words = text.toLowerCase().split(/\W+/).filter(Boolean);
  for (const w of words) {
    let h = 0;
    for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
    v[h % EMBED_DIM] += 1;
    v[(h * 7) % EMBED_DIM] -= 0.5;
  }
  return l2Normalize(v);
}

describe('STORAGE brain', () => {
  let tmpPath: string;
  let db: Database.Database;
  let storage: Storage;

  beforeEach(() => {
    tmpPath = path.join(os.tmpdir(), `agi-storage-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

  it('creates a user and retrieves by id and username', () => {
    const user = storage.users.create({ username: 'aryam', passwordHash: 'h' });
    expect(user.id).toMatch(/^u_/);
    expect(storage.users.getById(user.id)?.username).toBe('aryam');
    expect(storage.users.getByUsername('aryam')?.id).toBe(user.id);
  });

  it('creates conversations and messages that are listable', () => {
    const user = storage.users.create({ username: 'alice', passwordHash: 'h' });
    const conv = storage.conversations.create(user.id, 'hello');
    const m1 = storage.messages.insert({ conversationId: conv.id, userId: user.id, role: 'user', content: 'hi' });
    const m2 = storage.messages.insert({ conversationId: conv.id, userId: user.id, role: 'assistant', content: 'hello back' });
    const msgs = storage.messages.listByConversation(conv.id);
    expect(msgs.map((m) => m.id)).toEqual([m1.id, m2.id]);
    expect(storage.messages.countByConversation(conv.id)).toBe(2);
    expect(storage.conversations.listByUser(user.id)).toHaveLength(1);
  });

  it('inserts memories with embeddings and roundtrips the embedding bytes', () => {
    const user = storage.users.create({ username: 'bob', passwordHash: 'h' });
    const emb = fakeEmbed('hello world');
    const mem = storage.memories.insert({
      userId: user.id,
      kind: 'raw_turn',
      content: 'hello world',
      embedding: emb,
    });
    const round = storage.memories.getById(mem.id);
    expect(round).not.toBeNull();
    expect(round!.embedding).not.toBeNull();
    expect(round!.embedding!.length).toBe(EMBED_DIM);
    // Roundtrip should preserve values within float precision.
    for (let i = 0; i < EMBED_DIM; i++) {
      expect(Math.abs(round!.embedding![i]! - emb[i]!)).toBeLessThan(1e-6);
    }
  });

  it('vector search ranks the closest memory first', () => {
    const user = storage.users.create({ username: 'carol', passwordHash: 'h' });
    storage.memories.insert({ userId: user.id, kind: 'fact', content: 'I love cerulean', embedding: fakeEmbed('cerulean color favorite') });
    storage.memories.insert({ userId: user.id, kind: 'fact', content: 'I have a dog named Rex', embedding: fakeEmbed('dog named rex pet') });
    storage.memories.insert({ userId: user.id, kind: 'fact', content: 'random trivia', embedding: fakeEmbed('totally unrelated') });

    const q = fakeEmbed('favorite color cerulean');
    const hits = storage.memories.vectorSearch(user.id, q, 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.memory.content).toContain('cerulean');
  });

  it('FTS search surfaces memories by keyword', () => {
    const user = storage.users.create({ username: 'dave', passwordHash: 'h' });
    storage.memories.insert({ userId: user.id, kind: 'fact', content: 'Sarah birthday is March 12', embedding: fakeEmbed('sarah birthday march') });
    storage.memories.insert({ userId: user.id, kind: 'fact', content: 'Pizza is my favorite food', embedding: fakeEmbed('pizza food favorite') });
    const hits = storage.memories.ftsSearch(user.id, 'Sarah', 5);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.memory.content).toMatch(/Sarah/);
  });

  it('hybrid search combines vector + FTS via RRF', () => {
    const user = storage.users.create({ username: 'erin', passwordHash: 'h' });
    storage.memories.insert({ userId: user.id, kind: 'fact', content: 'Mochi is my cat', embedding: fakeEmbed('mochi cat pet name') });
    storage.memories.insert({ userId: user.id, kind: 'fact', content: 'My favorite color is cerulean', embedding: fakeEmbed('favorite color cerulean') });
    storage.memories.insert({ userId: user.id, kind: 'fact', content: 'Groceries on Tuesday', embedding: fakeEmbed('groceries tuesday errands') });

    const q = 'What color and pet';
    const emb = fakeEmbed(q);
    const hits = storage.memories.hybridSearch(user.id, q, emb, 3);
    const contents = hits.map((h) => h.memory.content).join('|');
    expect(contents).toMatch(/Mochi|cerulean/);
  });

  it('people upsert is idempotent and bumps mention_count', () => {
    const user = storage.users.create({ username: 'frank', passwordHash: 'h' });
    const p1 = storage.people.upsert({ userId: user.id, displayName: 'Sarah Chen', relationship: 'friend' });
    expect(p1.mentionCount).toBe(1);
    const p2 = storage.people.upsert({ userId: user.id, displayName: 'sarah chen' });
    expect(p2.id).toBe(p1.id);
    expect(p2.mentionCount).toBe(2);
    expect(p2.relationship).toBe('friend');
    expect(storage.people.listByUser(user.id)).toHaveLength(1);
  });

  it('person_memories links survive and list correctly', () => {
    const user = storage.users.create({ username: 'gina', passwordHash: 'h' });
    const sarah = storage.people.upsert({ userId: user.id, displayName: 'Sarah' });
    const mem = storage.memories.insert({ userId: user.id, kind: 'fact', content: 'Sarah likes sushi', embedding: fakeEmbed('sarah sushi food') });
    storage.personMemories.link(sarah.id, mem.id);
    const list = storage.personMemories.getMemoriesForPerson(sarah.id);
    expect(list.map((m) => m.id)).toContain(mem.id);
    expect(storage.personMemories.getPeopleIdsForMemory(mem.id)).toContain(sarah.id);
  });
});
