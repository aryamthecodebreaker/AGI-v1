// Retrieval — assembles the "what the model should see" package for a single turn.
//
// Sources:
//   1. Recent conversation turns (short-term memory, chronological)
//   2. Hybrid search over all memories (long-term memory — this is what makes
//      the bot "never forget" across conversations)
//   3. Top N people cards the user has mentioned (so the model knows who's who)

import type { Storage } from '../storage/index.js';
import type { Memory } from '../storage/repositories/memoryRepo.js';
import type { MessageRow } from '../storage/repositories/messageRepo.js';
import type { Person } from '../storage/repositories/personRepo.js';
import { embed } from '../llm/embeddings.js';

export interface AssembledContext {
  recentTurns: MessageRow[];
  relevantMemories: Memory[];
  people: Person[];
}

export interface AssembleContextInput {
  userId: string;
  conversationId: string;
  userMessage: string;
  recentTurnLimit?: number;
  memoryK?: number;
  peopleLimit?: number;
}

export async function assembleContext(
  storage: Storage,
  input: AssembleContextInput,
): Promise<AssembledContext> {
  const recentLimit = input.recentTurnLimit ?? 12;
  const memoryK = input.memoryK ?? 8;
  const peopleLimit = input.peopleLimit ?? 6;

  // Short-term: recent turns in this conversation (chronological).
  const recent = storage.messages
    .listRecentByConversation(input.conversationId, recentLimit)
    .reverse();

  // Long-term: hybrid search across the user's entire memory store.
  // We embed the user's current message and hand it to hybridSearch alongside
  // the raw text so FTS + vector can both contribute.
  let relevantMemories: Memory[] = [];
  try {
    const queryEmbedding = await embed(input.userMessage);
    const hits = storage.memories.hybridSearch(
      input.userId,
      input.userMessage,
      queryEmbedding,
      memoryK,
    );
    // Mark touched memories as accessed so we could later surface "frequently used" memories.
    for (const h of hits) storage.memories.touchAccessed(h.memory.id);
    relevantMemories = hits.map((h) => h.memory);
  } catch {
    // If embedding fails (e.g. model still downloading), fall back to FTS only.
    const hits = storage.memories.ftsSearch(input.userId, input.userMessage, memoryK);
    relevantMemories = hits.map((h) => h.memory);
  }

  // People roster — most-recently-mentioned first.
  const people = storage.people.listByUser(input.userId).slice(0, peopleLimit);

  return { recentTurns: recent, relevantMemories, people };
}
