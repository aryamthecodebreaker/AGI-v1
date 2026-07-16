import { describe, expect, it } from 'vitest';
import { resolveDirectMemoryRecall } from '../src/brain/directRecall.js';
import type { Storage } from '../src/storage/index.js';
import type { MessageRow } from '../src/storage/repositories/messageRepo.js';
import type { Memory } from '../src/storage/repositories/memoryRepo.js';

function memory(input: Partial<Memory> & Pick<Memory, 'id' | 'kind' | 'content'>): Memory {
  return {
    userId: 'u_test',
    conversationId: 'c_test',
    sourceMessageId: null,
    importance: 0.7,
    embedding: null,
    createdAt: 0,
    lastAccessedAt: null,
    ...input,
  };
}

function userMessage(id: string, content: string): MessageRow {
  return {
    id,
    conversation_id: 'c_test',
    user_id: 'u_test',
    role: 'user',
    content,
    token_count: null,
    created_at: 0,
  };
}

function storageWith(memories: Memory[], messages: MessageRow[]): Storage {
  return {
    memories: {
      ftsSearch: async () => memories.map((item, index) => ({
        memory: item,
        score: 1 / (index + 1),
      })),
      listRecentByUser: async () => memories,
    },
    messages: {
      getById: async (id: string) => messages.find((message) => message.id === id) ?? null,
    },
  } as unknown as Storage;
}

describe('direct long-term memory recall', () => {
  it('prefers a source-grounded value over a newer poisoned fact', async () => {
    const memories: Memory[] = [
      memory({
        id: 'poisoned',
        kind: 'fact',
        content: "The user's launch code word is aryamthecodebreaker.",
        sourceMessageId: 'poison-source',
        createdAt: 40,
      }),
      memory({
        id: 'correct',
        kind: 'fact',
        content: "The user's launch code word is saffron comet.",
        sourceMessageId: 'correct-source',
        createdAt: 30,
      }),
    ];
    const storage = storageWith(memories, [
      userMessage('poison-source', 'What is my launch code word?'),
      userMessage('correct-source', 'Remember that my launch code word is saffron comet.'),
    ]);

    await expect(resolveDirectMemoryRecall(
      storage,
      'u_test',
      'What is my launch code word? Reply with only the code word.',
    )).resolves.toBe('saffron comet');
  });

  it('uses the newest value when the user explicitly supplied multiple values', async () => {
    const memories: Memory[] = [
      memory({
        id: 'new-fact',
        kind: 'fact',
        content: "The user's favorite color is teal.",
        sourceMessageId: 'new-source',
        createdAt: 40,
      }),
      memory({
        id: 'old-fact',
        kind: 'fact',
        content: "The user's favorite color is blue.",
        sourceMessageId: 'old-source',
        createdAt: 20,
      }),
    ];
    const storage = storageWith(memories, [
      userMessage('new-source', 'My favorite color is teal.'),
      userMessage('old-source', 'My favorite color is blue.'),
    ]);

    await expect(resolveDirectMemoryRecall(
      storage,
      'u_test',
      'What is my favorite color?',
    )).resolves.toBe('teal');
  });

  it('does not bypass the model for unrelated questions', async () => {
    await expect(resolveDirectMemoryRecall(
      storageWith([], []),
      'u_test',
      'Tell me about color theory.',
    )).resolves.toBeNull();
  });
});
