// Extracts durable personal facts from a user/assistant exchange.
//
// Same defense-in-depth as entityExtraction: few-shot examples, JSON array
// regex, and a guaranteed path where we never lose data (the raw turn is
// always preserved — this only adds auxiliary `fact` rows for better recall).

import type { Storage } from '../storage/index.js';
import type { LlmBackend, ChatMessage } from '../llm/types.js';
import { FACT_EXTRACTION_SYSTEM, FACT_EXTRACTION_EXAMPLES } from '../llm/prompts.js';
import { embed } from '../llm/embeddings.js';
import { canonicalize } from '../storage/repositories/personRepo.js';
import { logger } from '../logger.js';
import { extractFirstJsonArray } from './entityExtraction.js';

interface ExtractedFact {
  fact: string;
  people: string[];
}

export interface ExtractFactsInput {
  userId: string;
  conversationId: string;
  sourceMessageId: string;
  userMessage: string;
  assistantMessage: string;
}

export async function extractAndStoreFacts(
  storage: Storage,
  llm: LlmBackend,
  input: ExtractFactsInput,
): Promise<void> {
  const messages: ChatMessage[] = [
    { role: 'system', content: FACT_EXTRACTION_SYSTEM },
  ];
  for (const ex of FACT_EXTRACTION_EXAMPLES) {
    messages.push({ role: 'user', content: ex.user });
    messages.push({ role: 'assistant', content: ex.assistant });
  }
  messages.push({
    role: 'user',
    content: `USER: ${input.userMessage}\nASSISTANT: ${input.assistantMessage}`,
  });

  const raw = await llm.generateOnce(messages, { maxNewTokens: 220, temperature: 0.1 });
  logger.debug({ raw }, 'fact extraction raw output');
  const facts = parseFacts(raw);
  if (facts.length === 0) {
    logger.debug({ raw }, 'fact extraction: parsed 0 facts');
    return;
  }

  // Anti-hallucination guard: every distinctive token in the fact must
  // appear in the source text. Distinctive = a number or a capitalized word
  // that isn't a stopword. This is strict enough to catch "The user's
  // birthday is August 3" when the source was "Her birthday is March 12".
  const STOPWORDS = new Set([
    'User',
    'The',
    'A',
    'An',
    'I',
    'It',
    'He',
    'She',
    'They',
    'We',
    'You',
    'My',
    'His',
    'Her',
    'Their',
    'Our',
    'Your',
    'Me',
    'Him',
    'Them',
    'Us',
    'This',
    'That',
    'These',
    'Those',
    'And',
    'Or',
    'But',
    'So',
    'If',
    'When',
    'Where',
    'Why',
    'How',
    'What',
    'Who',
    'Which',
    'Yes',
    'No',
    'Not',
    'Nothing',
    'Is',
    'Are',
    'Was',
    'Were',
    'Be',
    'Been',
    'Being',
    'Have',
    'Has',
    'Had',
    'Do',
    'Does',
    'Did',
    'Will',
    'Would',
    'Can',
    'Could',
    'Should',
    'May',
    'Might',
    'Must',
    'Today',
    'Yesterday',
    'Tomorrow',
  ]);
  // Ground ONLY against the user message. We cannot trust the assistant's
  // own reply as source-of-truth — it may have hallucinated or rephrased
  // (e.g. turning "March 12" into "3/12"), and feeding those mutations back
  // as "source" lets the fact extractor parrot the hallucination.
  const sourceText = input.userMessage;
  const sourceTokensLower = new Set(
    sourceText.split(/[^\p{L}\p{N}]+/u).map((t) => t.toLowerCase()),
  );
  const grounded = facts.filter((f) => {
    const tokens = f.fact.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    // Extract distinctive tokens: numbers and capitalized non-stopwords.
    const distinctive = tokens.filter(
      (t) => /^\d+$/.test(t) || (/^[A-Z]/.test(t) && !STOPWORDS.has(t)),
    );
    if (distinctive.length === 0) {
      // No distinctive tokens — fall back to "any content word overlaps".
      return tokens.some(
        (t) => t.length >= 4 && sourceTokensLower.has(t.toLowerCase()),
      );
    }
    // Every distinctive token must appear in the source text.
    for (const d of distinctive) {
      if (!sourceTokensLower.has(d.toLowerCase())) return false;
    }
    return true;
  });

  for (const f of grounded) {
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

    // Link to any people referenced — but only if the name token actually
    // appears in the user message. This blocks the small-model failure mode
    // where the fact extractor attaches an example name (e.g. "Priya") to a
    // legitimate fact about someone else entirely.
    for (const personName of f.people || []) {
      if (!personName) continue;
      const nameLower = personName.trim().toLowerCase();
      if (!nameLower) continue;
      if (!sourceTokensLower.has(nameLower)) {
        logger.debug(
          { personName, fact: content },
          'skipping person link — name not in source',
        );
        continue;
      }
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

export function parseFacts(raw: string): ExtractedFact[] {
  const json = extractFirstJsonArray(raw);
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((f) => f && typeof f === 'object' && typeof f.fact === 'string')
      .map((f) => ({
        fact: f.fact as string,
        people: Array.isArray(f.people)
          ? (f.people as unknown[]).filter(
              (x): x is string => typeof x === 'string' && x !== 'The user',
            )
          : [],
      }));
  } catch {
    return [];
  }
}
