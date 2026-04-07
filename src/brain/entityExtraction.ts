// Extracts named people from a user message using the LLM.
//
// SmolLM2-360M mangles JSON ~10% of the time, so we defend in three layers:
//  1) Few-shot examples in the prompt.
//  2) Regex grab for the first [ ... ] block.
//  3) If all else fails: log a warning, return [], and let the raw turn be
//     surfaced later by FTS + vector search. NEVER lose data.

import type { Storage } from '../storage/index.js';
import type { LlmBackend, ChatMessage } from '../llm/types.js';
import { ENTITY_EXTRACTION_SYSTEM, ENTITY_EXTRACTION_EXAMPLES } from '../llm/prompts.js';
import { logger } from '../logger.js';

interface ExtractedPerson {
  name: string;
  relationship?: string;
}

export interface ExtractPeopleInput {
  userId: string;
  conversationId: string;
  sourceMessageId: string;
  text: string;
}

export async function extractAndStorePeople(
  storage: Storage,
  llm: LlmBackend,
  input: ExtractPeopleInput,
): Promise<void> {
  const messages: ChatMessage[] = [
    { role: 'system', content: ENTITY_EXTRACTION_SYSTEM },
  ];
  for (const ex of ENTITY_EXTRACTION_EXAMPLES) {
    messages.push({ role: 'user', content: ex.user });
    messages.push({ role: 'assistant', content: ex.assistant });
  }
  messages.push({ role: 'user', content: input.text });

  const raw = await llm.generateOnce(messages, { maxNewTokens: 160, temperature: 0.1 });
  const people = parsePeople(raw);
  if (people.length === 0) return;

  // Anti-hallucination guard: only accept names whose tokens actually appear
  // in the original user message. SmolLM2 happily invents names from the
  // instructions, so we filter any that don't ground in the input text.
  // Also reject generic non-name strings like "you", "me", "user".
  const NAME_STOPWORDS = new Set([
    'you','me','user','i','he','she','they','them','him','her','someone','anyone',
    'nobody','everyone','person','friend','people','mom','dad','mother','father',
  ]);
  const inputLower = input.text.toLowerCase();
  const grounded = people.filter((p) => {
    const name = (p.name || '').trim();
    if (!name) return false;
    if (NAME_STOPWORDS.has(name.toLowerCase())) return false;
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return false;
    // Require at least one token of the name to appear in the input.
    return parts.some((tok) => tok.length >= 2 && inputLower.includes(tok.toLowerCase()));
  });

  for (const p of grounded) {
    const name = (p.name || '').trim();
    if (!name) continue;
    try {
      const person = storage.people.upsert({
        userId: input.userId,
        displayName: name,
        relationship: p.relationship && p.relationship !== 'unknown' ? p.relationship : undefined,
      });
      logger.info({ person: person.displayName }, 'person upserted');
    } catch (err) {
      logger.warn({ err, name }, 'person upsert failed');
    }
  }
}

export function parsePeople(raw: string): ExtractedPerson[] {
  const json = extractFirstJsonArray(raw);
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: ExtractedPerson[] = [];
  for (const item of parsed) {
    // Case A: a plain object — { name, relationship }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const obj = item as Record<string, unknown>;
      const name = typeof obj.name === 'string' ? obj.name : '';
      const relationship =
        typeof obj.relationship === 'string' ? obj.relationship : undefined;
      if (name) out.push({ name, relationship });
      continue;
    }
    // Case B: a string that SmolLM2 wrapped a JSON object in — try to
    // parse it back out. Safety net for `["{ \"name\":\"Sarah\"... }"]`.
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const inner = JSON.parse(trimmed) as Record<string, unknown>;
          const name = typeof inner.name === 'string' ? inner.name : '';
          const relationship =
            typeof inner.relationship === 'string' ? inner.relationship : undefined;
          if (name) {
            out.push({ name, relationship });
            continue;
          }
        } catch {
          // fall through — treat as a plain name below
        }
      }
      // Plain name string: `["Sarah", "Marco"]`
      if (trimmed) out.push({ name: trimmed });
    }
  }
  return out;
}

/**
 * Find the first `[`, then scan forward tracking bracket depth (respecting
 * string literals) until we hit the matching `]`. This beats a non-greedy
 * regex which will wrongly match inner arrays like `["Sarah"]`.
 */
export function extractFirstJsonArray(raw: string): string | null {
  const start = raw.indexOf('[');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === '\\') {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === '[') {
      depth++;
    } else if (ch === ']') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}
