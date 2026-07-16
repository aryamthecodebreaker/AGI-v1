import { describe, expect, it } from 'vitest';
import { resolveDirectMemoryRecall } from '../src/brain/directRecall.js';
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

describe('direct long-term memory recall', () => {
  it('prefers a user-grounded value over a newer poisoned fact', () => {
    const memories: Memory[] = [
      memory({
        id: 'poisoned',
        kind: 'fact',
        content: "The user's launch code word is aryamthecodebreaker.",
        createdAt: 40,
      }),
      memory({
        id: 'correct',
        kind: 'fact',
        content: "The user's launch code word is saffron comet.",
        createdAt: 30,
      }),
      memory({
        id: 'source',
        kind: 'raw_turn',
        content: 'USER: Remember that my launch code word is saffron comet.',
        createdAt: 20,
      }),
    ];

    expect(resolveDirectMemoryRecall(
      'What is my launch code word? Reply with only the code word.',
      memories,
    )).toBe('saffron comet');
  });

  it('uses the newest value when the user explicitly supplied multiple values', () => {
    const memories: Memory[] = [
      memory({
        id: 'new-fact',
        kind: 'fact',
        content: "The user's favorite color is teal.",
        createdAt: 40,
      }),
      memory({
        id: 'new-source',
        kind: 'raw_turn',
        content: 'USER: My favorite color is teal.',
        createdAt: 35,
      }),
      memory({
        id: 'old-fact',
        kind: 'fact',
        content: "The user's favorite color is blue.",
        createdAt: 20,
      }),
      memory({
        id: 'old-source',
        kind: 'raw_turn',
        content: 'USER: My favorite color is blue.',
        createdAt: 15,
      }),
    ];

    expect(resolveDirectMemoryRecall('What is my favorite color?', memories)).toBe('teal');
  });

  it('does not bypass the model for unrelated questions', () => {
    expect(resolveDirectMemoryRecall('Tell me about color theory.', [])).toBeNull();
  });
});
