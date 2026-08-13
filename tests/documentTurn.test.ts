// The document chat path.
//
// Two things must both hold, same as the device turn: a real request produces a
// real file, and ordinary conversation is untouched and costs no extra model
// call.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { storageFromDb, type DeviceStorage } from '../src/storage/index.js';
import { createOrchestrator } from '../src/brain/orchestrator.js';
import {
  buildDocumentFromBrief,
  clearDocumentStore,
  detectDocumentRequest,
  retrieveDocument,
} from '../src/documents/service.js';
import type { ChatMessage, LlmBackend } from '../src/llm/types.js';

function stubLlm(responses: string[]): LlmBackend & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  let index = 0;
  return {
    name: 'stub',
    calls,
    async ready() {},
    async *generate() {
      yield 'ordinary reply';
    },
    async generateOnce(messages) {
      calls.push(messages);
      return responses[index++] ?? '{}';
    },
  };
}

const DECK_JSON = JSON.stringify({
  kind: 'presentation',
  title: 'Solar Power',
  subtitle: 'A primer',
  slides: [
    { title: 'Why solar', bullets: ['Cheap', 'Clean'] },
    { title: 'How it works', bullets: ['Photovoltaic effect'] },
  ],
});

describe('document intent gate', () => {
  it('fires on a real request', () => {
    expect(detectDocumentRequest('make me a presentation about solar power')).toBe('presentation');
    expect(detectDocumentRequest('create a slide deck on pricing')).toBe('presentation');
    expect(detectDocumentRequest('build a spreadsheet of Q3 revenue')).toBe('spreadsheet');
    expect(detectDocumentRequest('draft a report on the migration')).toBe('document');
  });

  it('does not fire on ordinary conversation', () => {
    for (const message of [
      'hello there',
      'what did I say about my sister?',
      'can you explain how solar panels work?',
      'write a function that reverses a string',
      'thanks!',
    ]) {
      expect(detectDocumentRequest(message), message).toBeNull();
    }
  });

  it('needs both an intent verb and an artefact word', () => {
    // Artefact word with no intent verb.
    expect(detectDocumentRequest('the presentation was good')).toBeNull();
    // Intent verb with no artefact word.
    expect(detectDocumentRequest('make me a sandwich')).toBeNull();
  });
});

describe('document generation from a brief', () => {
  afterEach(() => clearDocumentStore());

  it('renders a real file and keeps it retrievable by its owner only', async () => {
    const llm = stubLlm([DECK_JSON]);
    const result = await buildDocumentFromBrief({
      llm,
      userId: 'u_owner',
      kind: 'presentation',
      brief: 'make me a presentation about solar power',
    });

    expect(result.ok).toBe(true);
    const doc = result.document!;
    expect(doc.filename).toBe('Solar-Power.pptx');
    // Real OOXML: a ZIP archive, not a stub.
    expect(doc.bytes.subarray(0, 2).toString('utf8')).toBe('PK');

    expect(retrieveDocument('u_owner', doc.id)?.id).toBe(doc.id);
    // Knowing the id is not enough.
    expect(retrieveDocument('u_someone_else', doc.id)).toBeNull();
  });

  it('reports a failure instead of throwing when the model returns junk', async () => {
    const llm = stubLlm(['not json at all']);
    const result = await buildDocumentFromBrief({
      llm,
      userId: 'u1',
      kind: 'presentation',
      brief: 'make a deck',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/outline/i);
  });

  it('rejects an outline that does not fit the schema', async () => {
    const llm = stubLlm([JSON.stringify({ kind: 'presentation', title: 'x', slides: [] })]);
    const result = await buildDocumentFromBrief({
      llm,
      userId: 'u1',
      kind: 'presentation',
      brief: 'make a deck',
    });
    expect(result.ok).toBe(false);
  });
});

describe('document turn inside chat', () => {
  let db: Database.Database;
  let storage: DeviceStorage;
  let userId: string;
  let conversationId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    storage = storageFromDb(db);
    userId = storage.users.create({ username: 'docs', passwordHash: 'h' }).id;
    conversationId = storage.conversations.create(userId, 'chat').id;
  });
  afterEach(() => {
    clearDocumentStore();
    db.close();
  });

  async function run(llm: LlmBackend, content: string): Promise<string> {
    const orchestrator = createOrchestrator(storage, llm);
    let text = '';
    for await (const event of orchestrator.handleUserMessage({ userId, conversationId, content })) {
      if (event.type === 'token') text += event.data;
    }
    return text;
  }

  it('answers a document request with a download link', async () => {
    const llm = stubLlm([DECK_JSON]);
    const reply = await run(llm, 'make me a presentation about solar power');

    expect(reply).toMatch(/Solar-Power\.pptx/);
    expect(reply).toMatch(/api\/documents\/doc_/);
    // It says plainly that the file is transient.
    expect(reply).toMatch(/30 minutes/);
  });

  it('leaves ordinary conversation on the normal path', async () => {
    const llm = stubLlm([]);
    const reply = await run(llm, 'can you explain how solar panels work?');
    expect(reply).toBe('ordinary reply');
    // The document planner was never called.
    expect(llm.calls).toHaveLength(0);
  });
});
