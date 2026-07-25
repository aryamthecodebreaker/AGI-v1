import { describe, expect, it } from 'vitest';
import { buildPrompt } from '../src/brain/contextBuilder.js';
import type { AssembledContext } from '../src/brain/retrieval.js';
import type { Memory } from '../src/storage/repositories/memoryRepo.js';
import type { Person } from '../src/storage/repositories/personRepo.js';

function memory(content: string, id: string): Memory {
  return {
    id,
    userId: 'u1',
    conversationId: 'c1',
    sourceMessageId: null,
    kind: 'fact',
    content,
    importance: 0.5,
    embedding: null,
    createdAt: 0,
    lastAccessedAt: null,
  };
}

function person(displayName: string, summary: string): Person {
  return {
    id: `p_${displayName}`,
    userId: 'u1',
    canonicalName: displayName.toLowerCase(),
    displayName,
    aliases: [],
    relationship: null,
    summary,
    metadata: {},
    firstSeenAt: 0,
    lastMentionedAt: 0,
    mentionCount: 1,
  };
}

function contextWith(memories: Memory[], people: Person[] = []): AssembledContext {
  return { recentTurns: [], relevantMemories: memories, people };
}

function promptText(context: AssembledContext, userMessage = 'what do you know about me?'): string {
  return buildPrompt({ context, userMessage })
    .map((message) => message.content)
    .join('\n');
}

describe('context budget packing', () => {
  it('keeps packing memories after one exceeds the remaining budget', () => {
    // Memories arrive best-first from RRF. A single long one must not discard
    // every lower-ranked memory behind it — the budget is 2500 characters and
    // these four short facts easily fit alongside it.
    const oversized = `The user wrote a very long note. ${'x'.repeat(2500)}`;
    const context = contextWith([
      memory('The user lives in Kyoto', 'm1'),
      memory(oversized, 'm2'),
      memory('The user has a dog named Rufus', 'm3'),
      memory('The user is allergic to peanuts', 'm4'),
      memory('The user works as a paramedic', 'm5'),
    ]);

    const text = promptText(context);

    expect(text).toContain('The user lives in Kyoto');
    expect(text).toContain('The user has a dog named Rufus');
    expect(text).toContain('The user is allergic to peanuts');
    expect(text).toContain('The user works as a paramedic');
    expect(text).not.toContain('x'.repeat(2500));
  });

  it('still stops adding memories once the budget is genuinely full', () => {
    const context = contextWith(
      Array.from({ length: 200 }, (_, i) => memory(`Fact number ${i} about the user`, `m${i}`)),
    );

    const memoryLines = promptText(context)
      .split('\n')
      .filter((line) => line.startsWith('- Fact number '));
    const budgetUsed = memoryLines.reduce((total, line) => total + line.length + 1, 0);

    expect(memoryLines.length).toBeGreaterThan(0);
    expect(memoryLines.length).toBeLessThan(200);
    expect(budgetUsed).toBeLessThanOrEqual(2500);
  });

  it('keeps packing people after one exceeds the remaining budget', () => {
    const context = contextWith(
      [],
      [
        person('Aiko', 'sister'),
        person('Boris', 'y'.repeat(600)),
        person('Chidi', 'climbing partner'),
        person('Dara', 'family doctor'),
      ],
    );

    const text = promptText(context);

    expect(text).toContain('Aiko');
    expect(text).toContain('Chidi');
    expect(text).toContain('Dara');
    expect(text).not.toContain('y'.repeat(600));
  });
});
