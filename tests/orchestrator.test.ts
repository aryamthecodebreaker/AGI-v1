import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitUntil } from '@vercel/functions';
import type { LlmBackend } from '../src/llm/types.js';
import type { AutoCapabilityRecovery } from '../src/capabilities/autoRecovery.js';
import { storageFromDb } from '../src/storage/index.js';
import { createOrchestrator, flushBackgroundTasks } from '../src/brain/orchestrator.js';

vi.mock('../src/llm/embeddings.js', () => ({
  embed: vi.fn(async () => new Float32Array(384)),
}));

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn(),
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
    delete process.env.VERCEL;
    vi.mocked(waitUntil).mockClear();
    tmpPath = path.join(os.tmpdir(), `agi-orch-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = new Database(tmpPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    storage = storageFromDb(db);
  });

  afterEach(async () => {
    delete process.env.VERCEL;
    // Flush any pending background tasks
    await flushBackgroundTasks();
    db.close();
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath + '-wal'); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath + '-shm'); } catch { /* ignore */ }
  });

  it('registers memory extraction with the Vercel request lifecycle', async () => {
    process.env.VERCEL = '1';
    const user = storage.users.create({ username: 'vercelwait', passwordHash: 'h' });
    const conv = storage.conversations.create(user.id, 'Lifecycle test');
    const orchestrator = createOrchestrator(storage, mockBackend(['Stored response']));

    for await (const _event of orchestrator.handleUserMessage({
      userId: user.id,
      conversationId: conv.id,
      content: 'Remember this.',
    })) {
      // consume the stream so background extraction is scheduled
    }

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(vi.mocked(waitUntil).mock.calls[0]?.[0]).toBeInstanceOf(Promise);
  });

  it('emits done while durable memory extraction continues in the background', async () => {
    const user = storage.users.create({ username: 'memoryfinal', passwordHash: 'h' });
    const conv = storage.conversations.create(user.id, 'Memory finalization test');
    let releaseExtraction!: (value: string) => void;
    let markExtractionStarted!: () => void;
    let extractionFinished = false;
    const extractionStarted = new Promise<void>((resolve) => {
      markExtractionStarted = resolve;
    });
    const extractionResult = new Promise<string>((resolve) => {
      releaseExtraction = resolve;
    });
    const backend = mockBackend(['Reply text']);
    backend.generateOnce = async () => {
      markExtractionStarted();
      const result = await extractionResult;
      extractionFinished = true;
      return result;
    };
    const orchestrator = createOrchestrator(storage, backend);
    let doneSeen = false;
    const consume = (async () => {
      for await (const event of orchestrator.handleUserMessage({
        userId: user.id,
        conversationId: conv.id,
        content: 'My favorite color is ultramarine.',
      })) {
        if (event.type === 'done') doneSeen = true;
      }
    })();

    await extractionStarted;
    await consume;
    expect(doneSeen).toBe(true);
    expect(extractionFinished).toBe(false);

    releaseExtraction('{"people":[],"facts":[]}');
    await flushBackgroundTasks();
    expect(extractionFinished).toBe(true);
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

  it('answers direct self-fact recall from grounded memory without model selection', async () => {
    const user = storage.users.create({ username: 'direct-recall', passwordHash: 'h' });
    const sourceConversation = storage.conversations.create(user.id, 'Stored fact');
    const correctSource = storage.messages.insert({
      conversationId: sourceConversation.id,
      userId: user.id,
      role: 'user',
      content: 'Remember that my launch code word is saffron comet.',
    });
    storage.memories.insert({
      userId: user.id,
      conversationId: sourceConversation.id,
      sourceMessageId: correctSource.id,
      kind: 'raw_turn',
      content: 'USER: Remember that my launch code word is saffron comet.',
      embedding: new Float32Array(384),
    });
    storage.memories.insert({
      userId: user.id,
      conversationId: sourceConversation.id,
      sourceMessageId: correctSource.id,
      kind: 'fact',
      content: "The user's launch code word is saffron comet.",
      embedding: new Float32Array(384),
    });
    const poisonedSource = storage.messages.insert({
      conversationId: sourceConversation.id,
      userId: user.id,
      role: 'user',
      content: 'What is my launch code word? Reply with only the code word.',
    });
    storage.memories.insert({
      userId: user.id,
      conversationId: sourceConversation.id,
      sourceMessageId: poisonedSource.id,
      kind: 'fact',
      content: "The user's launch code word is aryamthecodebreaker.",
      embedding: new Float32Array(384),
    });

    const recallConversation = storage.conversations.create(user.id, 'Recall');
    const backend = mockBackend([]);
    backend.generate = async function* () {
      throw new Error('the model should not be used for grounded direct recall');
    };
    const orchestrator = createOrchestrator(storage, backend);

    let response = '';
    for await (const event of orchestrator.handleUserMessage({
      userId: user.id,
      conversationId: recallConversation.id,
      content: 'What is my launch code word? Reply with only the code word.',
    })) {
      if (event.type === 'token') response += event.data;
    }

    expect(response).toBe('saffron comet');
  });

  it('conceals a capability-gap signal and automatically executes recovery', async () => {
    const user = storage.users.create({ username: 'recoverytest', passwordHash: 'h' });
    const conv = storage.conversations.create(user.id, 'Recovery test');
    const backend = mockBackend([
      '<capability-',
      'gap>{"kind":"tool","task":"Convert a supplied color value into another format"}</capability-gap>',
    ]);
    const recovery: AutoCapabilityRecovery = {
      classify: vi.fn(async () => null),
      execute: vi.fn(async () => ({
        kind: 'tool',
        message: 'I built the missing tool. Draft PR: https://example.test/pr/1',
        requestId: 'cap_test',
        prUrl: 'https://example.test/pr/1',
        reused: false,
      })),
    };
    const orchestrator = createOrchestrator(storage, backend, recovery);

    let response = '';
    for await (const event of orchestrator.handleUserMessage({
      userId: user.id,
      conversationId: conv.id,
      content: 'Convert this color for me',
    })) {
      if (event.type === 'token') response += event.data;
    }

    expect(response).not.toContain('<capability-gap>');
    expect(response).toContain('I detected a missing offline capability');
    expect(response).toContain('Draft PR: https://example.test/pr/1');
    expect(recovery.classify).not.toHaveBeenCalled();
    expect(recovery.execute).toHaveBeenCalledWith(user.id, {
      kind: 'tool',
      task: 'Convert a supplied color value into another format',
    });
    expect(storage.messages.listByConversation(conv.id)).toMatchObject([
      { role: 'user', content: 'Convert this color for me' },
      { role: 'assistant', content: expect.stringContaining('Draft PR: https://example.test/pr/1') },
    ]);
  });

  it('reports an empty model response without persisting a fake assistant turn', async () => {
    const user = storage.users.create({ username: 'emptytest', passwordHash: 'h' });
    const conv = storage.conversations.create(user.id, 'Empty response test');
    const orchestrator = createOrchestrator(storage, mockBackend([]));

    const errors: string[] = [];
    for await (const event of orchestrator.handleUserMessage({
      userId: user.id,
      conversationId: conv.id,
      content: 'Please respond',
    })) {
      if (event.type === 'error') errors.push(event.data!);
    }

    expect(errors).toEqual(['The model returned an empty response. Please try again.']);
    expect(storage.messages.listByConversation(conv.id)).toMatchObject([
      { role: 'user', content: 'Please respond' },
    ]);
  });
});
