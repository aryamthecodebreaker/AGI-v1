// Turning "make me a deck about X" into a real file.
//
// Two steps, deliberately separate:
//   1. The model fills in an outline schema. It never produces file bytes,
//      markup or code — only titles, bullets and rows.
//   2. src/documents/generate.ts renders that outline.
//
// A bad generation therefore produces silly slides, not a dangerous file.
//
// Finished files are held in memory with a short TTL rather than written to
// disk. That keeps generated content out of the database and off the filesystem,
// and means a restart loses pending downloads — which is stated in the reply
// rather than hidden.

import { z } from 'zod';
import type { LlmBackend } from '../llm/types.js';
import { logger } from '../logger.js';
import { newId } from '../util/ids.js';
import { now } from '../util/time.js';
import { extractFirstJsonObject } from '../brain/memoryExtraction.js';
import {
  documentRequestSchema,
  generateDocument,
  type DocumentKind,
  type GeneratedDocument,
} from './generate.js';

/** How long a generated file stays downloadable. */
const DOCUMENT_TTL_MS = 30 * 60 * 1000;
/** Cap on total retained bytes, so this cannot grow without bound. */
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

interface StoredDocument {
  id: string;
  userId: string;
  filename: string;
  mimeType: string;
  bytes: Buffer;
  createdAt: number;
  expiresAt: number;
}

const store = new Map<string, StoredDocument>();

function prune(): void {
  const at = now();
  for (const [id, doc] of store) {
    if (doc.expiresAt <= at) store.delete(id);
  }
  // If still over budget, drop oldest first.
  let total = 0;
  const byAge = [...store.values()].sort((a, b) => b.createdAt - a.createdAt);
  for (const doc of byAge) {
    total += doc.bytes.length;
    if (total > MAX_TOTAL_BYTES) store.delete(doc.id);
  }
}

export function retrieveDocument(userId: string, id: string): StoredDocument | null {
  prune();
  const doc = store.get(id);
  if (!doc || doc.userId !== userId) return null;
  if (doc.expiresAt <= now()) {
    store.delete(id);
    return null;
  }
  return doc;
}

function retain(userId: string, generated: GeneratedDocument): StoredDocument {
  prune();
  const doc: StoredDocument = {
    id: newId('doc'),
    userId,
    filename: generated.filename,
    mimeType: generated.mimeType,
    bytes: generated.bytes,
    createdAt: now(),
    expiresAt: now() + DOCUMENT_TTL_MS,
  };
  store.set(doc.id, doc);
  return doc;
}

/** Exposed for tests. */
export function clearDocumentStore(): void {
  store.clear();
}

// ---------------------------------------------------------------------------
// Intent detection
// ---------------------------------------------------------------------------

const KIND_WORDS: { kind: DocumentKind; patterns: RegExp }[] = [
  { kind: 'presentation', patterns: /\b(presentation|slide ?deck|slides|deck|powerpoint|pptx?)\b/i },
  { kind: 'spreadsheet', patterns: /\b(spreadsheet|excel|xlsx?|worksheet|sheet)\b/i },
  { kind: 'document', patterns: /\b(document|report|write ?up|memo|doc|docx|essay|letter)\b/i },
];

const MAKE_VERB = /\b(make|create|generate|build|draft|write|put together|prepare)\b/i;

/**
 * Deterministic gate, same idea as the device triage: ordinary conversation
 * must not pay for a document-planning call. Requires both an intent verb and
 * an explicit artefact word, so "write a function" or "report the bug" do not
 * trigger it.
 */
export function detectDocumentRequest(text: string): DocumentKind | null {
  if (!MAKE_VERB.test(text)) return null;
  // Order matters: "slide deck" should win over the "deck" in "document".
  for (const entry of KIND_WORDS) {
    if (entry.patterns.test(text)) return entry.kind;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Outline generation
// ---------------------------------------------------------------------------

const OUTLINE_INSTRUCTIONS: Record<DocumentKind, string> = {
  presentation: `Return JSON shaped exactly like:
{"kind":"presentation","title":"...","subtitle":"...","slides":[{"title":"...","bullets":["...","..."],"notes":"..."}]}
Aim for 5 to 10 slides. Each slide needs a short title and 2 to 5 concise bullets.
"notes" is optional speaker notes. Do not use markdown in any field.`,

  document: `Return JSON shaped exactly like:
{"kind":"document","title":"...","subtitle":"...","sections":[{"heading":"...","paragraphs":["..."],"bullets":["..."],"table":{"headers":["..."],"rows":[["..."]]}}]}
Aim for 3 to 8 sections. "bullets" and "table" are optional per section; include a
table only when the content is genuinely tabular. Do not use markdown in any field.`,

  spreadsheet: `Return JSON shaped exactly like:
{"kind":"spreadsheet","title":"...","sheets":[{"name":"...","headers":["..."],"rows":[["...",123]]}]}
Every row must have the same number of entries as "headers". Use numbers, not
strings, for numeric cells. Sheet names must be 31 characters or fewer.`,
};

export interface BuildDocumentResult {
  ok: boolean;
  document?: StoredDocument;
  error?: string;
}

/**
 * Ask the model for an outline, validate it, and render it.
 *
 * Every failure is returned rather than thrown: a failed document should be
 * reported to the user as a failed request, not break the chat turn.
 */
export async function buildDocumentFromBrief(input: {
  llm: LlmBackend;
  userId: string;
  kind: DocumentKind;
  brief: string;
}): Promise<BuildDocumentResult> {
  const system = `You plan ${input.kind}s. The user describes what they want and you return ONE JSON object and nothing else.

${OUTLINE_INSTRUCTIONS[input.kind]}

Rules:
- Output only the JSON object. No prose, no code fences.
- Write real content about the user's subject. Do not use placeholders.
- Keep every string plain text.`;

  let raw: string;
  try {
    raw = await input.llm.generateOnce(
      [
        { role: 'system', content: system },
        { role: 'user', content: input.brief },
      ],
      { maxNewTokens: 2600, temperature: 0.4 },
    );
  } catch (err) {
    logger.warn({ err }, 'document outline generation failed');
    return { ok: false, error: 'I could not reach the model to plan that document.' };
  }

  const json = extractFirstJsonObject(raw);
  if (!json) {
    logger.warn({ raw: raw.slice(0, 200) }, 'document outline was not JSON');
    return { ok: false, error: 'The model did not return a usable outline. Try asking again.' };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(json);
  } catch {
    return { ok: false, error: 'The model returned malformed JSON for that outline.' };
  }

  // Trust the detected kind over whatever the model labelled it.
  if (parsedJson && typeof parsedJson === 'object') {
    (parsedJson as { kind?: string }).kind = input.kind;
  }

  const parsed = documentRequestSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const first = parsed.error.errors[0];
    logger.warn(
      { path: first?.path.join('.'), message: first?.message },
      'document outline failed validation',
    );
    return {
      ok: false,
      error: `The outline did not fit the required shape (${first?.path.join('.') || 'unknown field'}). Try being more specific.`,
    };
  }

  try {
    const generated = await generateDocument(parsed.data);
    return { ok: true, document: retain(input.userId, generated) };
  } catch (err) {
    logger.error({ err }, 'document rendering failed');
    return { ok: false, error: 'The outline was fine but the file could not be built.' };
  }
}

export const documentKindSchema = z.enum(['presentation', 'document', 'spreadsheet']);
