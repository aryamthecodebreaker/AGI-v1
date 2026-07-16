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
 * retrieved USER raw turn contains both its attribute and value; this also
 * ignores poisoned facts that were derived from assistant hallucinations.
 */
export function resolveDirectMemoryRecall(
  userMessage: string,
  memories: Memory[],
): string | null {
  const requestedAttribute = recallAttribute(userMessage);
  if (!requestedAttribute) return null;

  const userTurns = memories
    .filter((memory) => memory.kind === 'raw_turn' && /^USER:\s*/u.test(memory.content))
    .map((memory) => memory.content.replace(/^USER:\s*/u, ''));

  const grounded = memories
    .map(parseSelfFact)
    .filter((candidate): candidate is SelfFact =>
      candidate !== null
      && sameAttribute(candidate.attribute, requestedAttribute)
      && userTurns.some((turn) =>
        contentIsGroundedInText(candidate.attribute, turn)
        && contentIsGroundedInText(candidate.value, turn)))
    .sort((left, right) => right.memory.createdAt - left.memory.createdAt);

  return grounded[0]?.value ?? null;
}
