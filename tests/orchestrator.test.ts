import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LlmBackend } from '../src/llm/types.js';
import { storageFromDb } from '../src/storage/index.js';
import { createOrchestrator, flushBackgroundTasks } from '../src/brain/orchestrator.js';

vi.mock('../src/llm/embeddings.js', () => ({
  embed: vi.fn(async () => new Float32Array(384)),
}));

function mockBackend(chunks: string[], onChunk?: (chunk: string) => void): LlmBackend {
  return {
    name: 'test:mock',
    ready: async () => {},
    generate: async function* () {
      for (const chunk of chunks) {
        onChunk?.(chunk);
        yield chunk;
      }
    },
    generateOnce: async () => '{}',
  };
}

describe('Brain orchestrator', () => {
  let tmpPath: string;
  let db: Database.Database;
  let storage: ReturnType<typeof storageFromDb>;

  beforeEach(() => {
    tmpPath = path.join(os.tmpdir(), `agi-orch-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = new Database(tmpPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    storage = storageFromDb(db);
  });

  afterEach(async () => {
    // Flush any pending background tasks
    await flushBackgroundTasks();
    db.close();
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath + '-wal'); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath + '-shm'); } catch { /* ignore */ }
  });

  it('creates conversation and persists user message', async () => {
    const user = storage.users.create({ username: 'orchtest', passwordHash: 'h' });
    const conv = storage.conversations.create(user.id, 'Test chat');
    
    const orchestratorWithMock = createOrchestrator(storage, mockBackend(['Hello', ' there']));
    
    const events: string[] = [];
    for await (const event of orchestratorWithMock.handleUserMessage({
      userId: user.id,
      conversationId: conv.id,
      content: 'Hi there!',
    })) {
      if (event.type === 'token') events.push(event.data!);
    }
    
    expect(events).toContain('Hello');
    
    // Verify message was persisted
    const messages = storage.messages.listByConversation(conv.id);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0]?.content).toBe('Hi there!');
  });

  it('updates conversation title on first message', async () => {
    const user = storage.users.create({ username: 'titletest', passwordHash: 'h' });
    const conv = storage.conversations.create(user.id, 'New chat');
    
    const orchestrator = createOrchestrator(storage, mockBackend(['Response']));
    
    for await (const _ of orchestrator.handleUserMessage({
      userId: user.id,
      conversationId: conv.id,
      content: 'Tell me about machine learning',
    })) {}
    
    const updated = storage.conversations.getById(conv.id);
    expect(updated?.title).not.toBe('New chat');
    expect(updated?.title).toMatch(/machine learning/i);
  });

  it('handles abort signal gracefully', async () => {
    const user = storage.users.create({ username: 'aborttest', passwordHash: 'h' });
    const conv = storage.conversations.create(user.id, 'Abort test');
    
    const abortController = new AbortController();
    
    const backend = mockBackend(['Start'], () => abortController.abort());
    const orchestrator = createOrchestrator(storage, backend);
    
    const events: string[] = [];
    for await (const event of orchestrator.handleUserMessage({
      userId: user.id,
      conversationId: conv.id,
      content: 'Test abort',
      signal: abortController.signal,
    })) {
      if (event.type === 'token') events.push(event.data!);
    }
    
    expect(events).toContain('Start');
    // Should handle abort gracefully without crashing
  });

  it('emits metadata event with context info', async () => {
    const user = storage.users.create({ username: 'metatest', passwordHash: 'h' });
    const conv = storage.conversations.create(user.id, 'Meta test');
    
    const orchestrator = createOrchestrator(storage, mockBackend(['OK']));
    
    let metaEvent: { memoriesUsed: number; peopleInContext: number; recentTurns: number } | null = null;
    
    for await (const event of orchestrator.handleUserMessage({
      userId: user.id,
      conversationId: conv.id,
      content: 'Hello',
    })) {
      if (event.type === 'meta') {
        metaEvent = event.meta as typeof metaEvent;
      }
    }
    
    expect(metaEvent).not.toBeNull();
    expect(metaEvent?.recentTurns).toBeGreaterThanOrEqual(0);
  });
});
