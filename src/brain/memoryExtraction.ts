// Unified memory extraction: one LLM call emits BOTH the people list and the
// durable facts for a single user/assistant exchange. Halves the API-request
// cost compared with the old entity + fact two-call flow, which matters on
// Gemini's free tier (10–15 requests/min).
//
// Safety nets (all kept from the split implementation):
//   1. Tolerant JSON object extraction — we scan for the first balanced {...}
//      block instead of trusting regex.
//   2. Grounding guards — people names and fact tokens must appear in the
//      source user message. This blocks the small-model failure mode where an
//      example name (e.g. "Priya") leaks into the output.
//   3. If parsing/LLM fails entirely, we just return — the raw turn has
//      already been persisted upstream, so nothing is ever lost.

import type { Storage } from '../storage/index.js';
import type { ChatMessage, LlmBackend } from '../llm/types.js';
import { MEMORY_EXTRACTION_SYSTEM } from '../llm/prompts.js';
import { embed } from '../llm/embeddings.js';
import { canonicalize } from '../storage/repositories/personRepo.js';
import { logger } from '../logger.js';

export interface ExtractMemoryInput {
  userId: string;
  conversationId: string;
  sourceMessageId: string;
  userMessage: string;
  assistantMessage: string;
}

interface ExtractedPerson {
  name: string;
  relationship?: string;
}
interface ExtractedFact {
  fact: string;
  people: string[];
}
interface ExtractedPayload {
  people: ExtractedPerson[];
  facts: ExtractedFact[];
}

// Names/tokens the LLM tends to invent instead of extracting.
const NAME_STOPWORDS = new Set([
  'you','me','user','i','he','she','they','them','him','her','someone','anyone',
  'nobody','everyone','person','friend','people','mom','dad','mother','father',
]);
// Common words that are NOT distinctive enough to require source-grounding.
const FACT_STOPWORDS = new Set([
  'User','The','A','An','I','It','He','She','They','We','You','My','His','Her',
  'Their','Our','Your','Me','Him','Them','Us','This','That','These','Those',
  'And','Or','But','So','If','When','Where','Why','How','What','Who','Which',
  'Yes','No','Not','Nothing','Is','Are','Was','Were','Be','Been','Being','Have',
  'Has','Had','Do','Does','Did','Will','Would','Can','Could','Should','May',
  'Might','Must','Today','Yesterday','Tomorrow',
]);

export async function extractAndStoreMemory(
  storage: Storage,
  llm: LlmBackend,
  input: ExtractMemoryInput,
): Promise<void> {
  const messages: ChatMessage[] = [
    { role: 'system', content: MEMORY_EXTRACTION_SYSTEM },
    {
      role: 'user',
      content: `USER: ${input.userMessage}\nASSISTANT: ${input.assistantMessage}`,
    },
  ];

  let raw: string;
  try {
    raw = await llm.generateOnce(messages, { maxNewTokens: 320, temperature: 0.1 });
  } catch (err) {
    logger.warn({ err }, 'memory extraction LLM call failed');
    return;
  }

  const payload = parseExtraction(raw);
  if (!payload) {
    logger.debug({ raw }, 'memory extraction: no parseable JSON');
    return;
  }

  // --- People ---
  const userLower = input.userMessage.toLowerCase();
  const groundedPeople = payload.people.filter((p) => {
    const name = (p.name || '').trim();
    if (!name) return false;
    if (NAME_STOPWORDS.has(name.toLowerCase())) return false;
    const parts = name.split(/\s+/).filter(Boolean);
    return parts.some(
      (tok) => tok.length >= 2 && userLower.includes(tok.toLowerCase()),
    );
  });

  for (const p of groundedPeople) {
    try {
      const person = storage.people.upsert({
        userId: input.userId,
        displayName: p.name.trim(),
        relationship:
          p.relationship && p.relationship !== 'unknown' ? p.relationship : undefined,
      });
      logger.info({ person: person.displayName }, 'person upserted');
    } catch (err) {
      logger.warn({ err, name: p.name }, 'person upsert failed');
    }
  }

  // --- Facts ---
  // Only the USER message counts as source-of-truth. The assistant's reply
  // can hallucinate (e.g. turn "March 12" into "3/12"), and feeding that back
  // as source lets those mutations pass the grounding guard.
  const sourceTokensLower = new Set(
    input.userMessage.split(/[^\p{L}\p{N}]+/u).map((t) => t.toLowerCase()),
  );
  const groundedFacts = payload.facts.filter((f) => {
    const tokens = f.fact.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const distinctive = tokens.filter(
      (t) => /^\d+$/.test(t) || (/^[A-Z]/.test(t) && !FACT_STOPWORDS.has(t)),
    );
    if (distinctive.length === 0) {
      return tokens.some(
        (t) => t.length >= 4 && sourceTokensLower.has(t.toLowerCase()),
      );
    }
    for (const d of distinctive) {
      if (!sourceTokensLower.has(d.toLowerCase())) return false;
    }
    return true;
  });

  for (const f of groundedFacts) {
    const content = f.fact.trim();
    if (!content) continue;

    let embedding: Float32Array | null = null;
    try {
      embedding = await embed(content);
    } catch (err) {
      logger.warn({ err }, 'fact embed failed — storing without embedding');
    }

    const mem = storage.memories.insert({
      userId: input.userId,
      conversationId: input.conversationId,
      sourceMessageId: input.sourceMessageId,
      kind: 'fact',
      content,
      importance: 0.7,
      embedding,
    });

    for (const personName of f.people || []) {
      if (!personName) continue;
      const nameLower = personName.trim().toLowerCase();
      if (!nameLower || !sourceTokensLower.has(nameLower)) continue;
      try {
        const canonical = canonicalize(personName);
        const person =
          storage.people.getByCanonical(input.userId, canonical) ??
          storage.people.upsert({ userId: input.userId, displayName: personName });
        storage.personMemories.link(person.id, mem.id);
      } catch (err) {
        logger.warn({ err, personName }, 'person<->memory link failed');
      }
    }

    logger.info({ fact: content }, 'fact stored');
  }
}

/**
 * Scan for the first balanced JSON object, respecting string literals, then
 * parse it and coerce the shape we want. Returns null on any failure so the
 * caller can fall back gracefully.
 */
export function parseExtraction(raw: string): ExtractedPayload | null {
  const obj = extractFirstJsonObject(raw);
  if (!obj) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(obj);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;

  const people: ExtractedPerson[] = Array.isArray(p.people)
    ? (p.people as unknown[])
        .map((item): ExtractedPerson | null => {
          if (!item || typeof item !== 'object') return null;
          const obj = item as Record<string, unknown>;
          const name = typeof obj.name === 'string' ? obj.name.trim() : '';
          if (!name) return null;
          return {
            name,
            relationship:
              typeof obj.relationship === 'string' ? obj.relationship : undefined,
          };
        })
        .filter((x): x is ExtractedPerson => x !== null)
    : [];

  const facts: ExtractedFact[] = Array.isArray(p.facts)
    ? (p.facts as unknown[])
        .map((item): ExtractedFact | null => {
          if (!item || typeof item !== 'object') return null;
          const obj = item as Record<string, unknown>;
          const fact = typeof obj.fact === 'string' ? obj.fact.trim() : '';
          if (!fact) return null;
          const peopleList = Array.isArray(obj.people)
            ? (obj.people as unknown[]).filter(
                (x): x is string =>
                  typeof x === 'string' && x.length > 0 && x !== 'The user',
              )
            : [];
          return { fact, people: peopleList };
        })
        .filter((x): x is ExtractedFact => x !== null)
    : [];

  return { people, facts };
}

/**
 * Balanced-brace scanner. Returns the substring of `raw` that contains the
 * first complete top-level `{ ... }` block, or null if none found. Unlike a
 * naive regex this correctly handles nested objects and quoted `{`/`}`.
 */
export function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}
