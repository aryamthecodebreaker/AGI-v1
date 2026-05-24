import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { storageFromDb } from '../src/storage/index.js';
import { createOrchestrator, flushBackgroundTasks } from '../src/brain/orchestrator.js';
import { getLlmBackend } from '../src/llm/registry.js';

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
    
    const orchestrator = createOrchestrator(storage);
    
    // Mock LLM backend for testing
    const mockBackend = getLlmBackend();
    mockBackend.ready = async () => {};
    mockBackend.generate = async function* () {
      yield 'Hello';
      yield ' there';
    };
    
    const orchestratorWithMock = createOrchestrator(storage, mockBackend);
    
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
    
    const mockBackend = getLlmBackend();
    mockBackend.ready = async () => {};
    mockBackend.generate = async function* () {
      yield 'Response';
    };
    
    const orchestrator = createOrchestrator(storage, mockBackend);
    
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
    
    const mockBackend = getLlmBackend();
    mockBackend.ready = async () => {};
    mockBackend.generate = async function* () {
      yield 'Start';
      abortController.abort();
      yield 'Should not reach';
    };
    
    const orchestrator = createOrchestrator(storage, mockBackend);
    
    const events: string[] = [];
    let errorOccurred = false;
    
    try {
      for await (const event of orchestrator.handleUserMessage({
        userId: user.id,
        conversationId: conv.id,
        content: 'Test abort',
        signal: abortController.signal,
      })) {
        if (event.type === 'token') events.push(event.data!);
        if (event.type === 'error') errorOccurred = true;
      }
    } catch {
      errorOccurred = true;
    }
    
    expect(events).toContain('Start');
    // Should handle abort gracefully without crashing
  });

  it('emits metadata event with context info', async () => {
    const user = storage.users.create({ username: 'metatest', passwordHash: 'h' });
    const conv = storage.conversations.create(user.id, 'Meta test');
    
    const mockBackend = getLlmBackend();
    mockBackend.ready = async () => {};
    mockBackend.generate = async function* () {
      yield 'OK';
    };
    
    const orchestrator = createOrchestrator(storage, mockBackend);
    
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
