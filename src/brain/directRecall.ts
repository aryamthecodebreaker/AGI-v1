import type { Storage } from '../storage/index.js';
import type { Memory } from '../storage/repositories/memoryRepo.js';
import { contentIsGroundedInText, contentTokens } from './factGrounding.js';

interface SelfFact {
  attribute: string;
  value: string;
  memory: Memory;
}

function recallAttribute(userMessage: string): string | null {
  const match = userMessage.match(
    /\b(?:what|which)\s+(?:is|are|was|were)\s+my\s+(.+?)(?=\?|[.!]|\s+(?:please\s+)?(?:reply|answer)\b|$)/iu,
  );
  return match?.[1]?.trim() || null;
}

function parseSelfFact(memory: Memory): SelfFact | null {
  if (memory.kind !== 'fact') return null;
  const match = memory.content.match(
    /^The user(?:'|’)s\s+(.+?)\s+(?:is|are|was|were)\s+(.+?)[.!]?$/iu,
  );
  const attribute = match?.[1]?.trim();
  const value = match?.[2]?.trim();
  return attribute && value ? { attribute, value, memory } : null;
}

function sameAttribute(left: string, right: string): boolean {
  const leftTokens = contentTokens(left);
  const rightTokens = contentTokens(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) return false;
  return leftTokens.length === rightTokens.length
    && leftTokens.every((token) => rightTokens.includes(token));
}

/**
 * Resolve direct self-fact questions without asking the model to choose among
 * a people roster and retrieved facts. A candidate is trusted only when a
 * original source message is a USER message containing both its attribute and
 * value. Using source-message provenance keeps recall correct even when the
 * supporting raw-turn memory falls outside the semantic retrieval window.
 */
export async function resolveDirectMemoryRecall(
  storage: Storage,
  userId: string,
  userMessage: string,
): Promise<string | null> {
  const requestedAttribute = recallAttribute(userMessage);
  if (!requestedAttribute) return null;

  const searchHits = await storage.memories.ftsSearch(userId, requestedAttribute, 50);
  let memories = searchHits.map((hit) => hit.memory);
  if (!memories.some((memory) => parseSelfFact(memory) !== null)) {
    memories = await storage.memories.listRecentByUser(userId, 200);
  }

  const candidates = memories
    .map(parseSelfFact)
    .filter((candidate): candidate is SelfFact =>
      candidate !== null
      && sameAttribute(candidate.attribute, requestedAttribute))
    .sort((left, right) => right.memory.createdAt - left.memory.createdAt);

  for (const candidate of candidates) {
    const sourceMessageId = candidate.memory.sourceMessageId;
    if (!sourceMessageId) continue;

    const source = await storage.messages.getById(sourceMessageId);
    if (
      source?.user_id === userId
      && source.role === 'user'
      && contentIsGroundedInText(candidate.attribute, source.content)
      && contentIsGroundedInText(candidate.value, source.content)
    ) {
      return candidate.value;
    }
  }

  return null;
}
