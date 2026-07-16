import { z } from 'zod';
import { getLlmBackend } from '../llm/registry.js';
import type { ChatMessage, LlmBackend } from '../llm/types.js';
import {
  collectCapabilityEvidence,
  type CapabilityEvidence,
  requiresOfficialCapabilityEvidence,
} from './evidence.js';

const MAX_CODE_CHARS = 30_000;

export const capabilityDraftSchema = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9-]{2,39}$/),
  summary: z.string().min(10).max(500),
  toolCode: z.string().min(40).max(MAX_CODE_CHARS),
  testCode: z.string().min(40).max(MAX_CODE_CHARS),
  sampleInput: z.record(z.unknown()),
}).strict();

export type CapabilityDraft = z.infer<typeof capabilityDraftSchema>;

const capabilityReviewResponseSchema = z.object({
  evidenceStatus: z.enum(['sufficient', 'insufficient']),
  summary: z.string().min(10).max(1_000),
  testCode: z.string().min(40).max(MAX_CODE_CHARS),
  evidenceClaims: z.array(z.object({
    testName: z.string().min(3).max(300),
    sourceUrl: z.string().url().max(2_000),
    quote: z.string().min(12).max(1_500),
  }).strict()).max(30),
}).strict();

export interface CapabilityReview extends z.infer<typeof capabilityReviewResponseSchema> {
  sources: CapabilityEvidence[];
}

const generationPrompt = `You generate a small, reviewable AGI-v1 capability.
Return exactly one JSON object with keys: slug, summary, toolCode, testCode, sampleInput.

Rules:
- slug is lowercase kebab-case, 3-40 characters.
- toolCode is dependency-free Node.js 24 ESM and exports: async function run(input).
- run(input) always receives exactly one JSON object. Never use a top-level string, number, boolean, null, or array as the input contract.
- The exported function returns JSON-serializable data.
- testCode uses node:test and node:assert/strict, imports run from ./tool.mjs, and has meaningful passing tests.
- If the request names a standard or RFC, implement its error cases and edge cases as well as its examples. Do not claim conformance from a single happy path.
- Every test must call run with an object whose field names and value types match sampleInput, and toolCode must read that same object shape.
- Do not read environment variables, files, credentials, or process state.
- Do not use the network, child processes, workers, dynamic import, eval, or Function.
- Do not include a CLI wrapper; the host supplies a trusted runner.
- sampleInput is a small realistic JSON object that demonstrates the requested capability.
- Example contract: sampleInput {"text":"one two"}, toolCode reads input.text, and tests call run({ text: "one two" }).
- No markdown fences and no text outside the JSON object.`;

const reviewPrompt = `You are the independent adversarial reviewer for a generated AGI-v1 capability.
The capability author wrote both the implementation and its first test suite, so those tests are not proof by themselves.
Return exactly one JSON object with keys: evidenceStatus, summary, testCode, evidenceClaims.

Rules:
- Inspect the requested task, implementation, author tests, sample input, and any official evidence supplied below.
- evidenceStatus is "sufficient" only when you have enough trustworthy information to test the requested behavior. Otherwise use "insufficient".
- summary describes what the independent tests cover. Do not describe implementation defects that may become stale after a repair.
- testCode uses node:test and node:assert/strict and imports run from ./tool.mjs.
- Write independent adversarial tests. Do not merely rename or repeat the author's happy paths.
- Test malformed input, boundary values, Unicode or encoding behavior, ordering, error behavior, and misleading success cases when relevant.
- If the task names an RFC or other standard, translate its normative requirements and official examples into executable tests. A passing author-written example is not conformance evidence.
- evidenceClaims is an empty array when no fixed official evidence was supplied.
- When official evidence is supplied, every test in testCode must have at least one evidenceClaims entry. testName exactly matches the static node:test name, sourceUrl exactly matches a supplied official URL, and quote is a short verbatim excerpt from that source that directly supports the assertion.
- Tests may be expected to fail the current implementation when they expose a real defect; the failure will be sent back to the author for one repair.
- Do not read environment variables, files, credentials, or process state.
- Do not use the network, child processes, workers, dynamic import, eval, or Function.
- No markdown fences and no text outside the JSON object.`;

const reviewAuditPrompt = `You audit an adversarial test suite for an AGI-v1 generated capability.
The first reviewer can misunderstand a standard, so its tests are not trusted yet.
Return exactly one corrected JSON object with keys: evidenceStatus, summary, testCode, evidenceClaims.

Rules:
- Independently compare every expected value and error assertion with the complete official evidence.
- Correct or remove any assertion that conflicts with the evidence, including subtle string escaping and number formatting details.
- Preserve strong adversarial coverage, but never make the implementation pass by weakening a valid normative test.
- summary describes the final test coverage, not defects in the current implementation.
- testCode uses node:test and node:assert/strict and imports run from ./tool.mjs.
- Every test must have an evidenceClaims entry whose testName exactly matches the static node:test name.
- Each sourceUrl exactly matches a supplied official URL.
- Each quote is a short verbatim excerpt copied from the supplied source and directly supports that test's assertion.
- evidenceStatus is "insufficient" if the supplied official text cannot support a reliable suite.
- Do not read files, credentials, environment variables, process state, or the network.
- No markdown fences and no text outside the JSON object.`;

const forbiddenPatterns: Array<[RegExp, string]> = [
  [/\bprocess\b/, 'process access'],
  [/\bfetch\b/, 'network fetch'],
  [/\b(?:WebSocket|XMLHttpRequest)\b/, 'network client'],
  [/\b(?:eval|Function)\s*\(/, 'dynamic code execution'],
  [/\bimport\s*\(/, 'dynamic import'],
  [/(?:node:)?(?:child_process|worker_threads|cluster|net|tls|dgram|http|https|fs|module|vm|inspector)(?:['"]|\/)/, 'privileged module'],
  [/\b(?:createRequire|require)\s*\(/, 'runtime module loading'],
];

export function assertSafeCapabilityCode(code: string): void {
  if (code.length > MAX_CODE_CHARS) throw new Error('Generated capability exceeds the code size limit');
  if (!code.includes('export async function run')) {
    throw new Error('Generated tool must export async function run(input)');
  }
  for (const [pattern, label] of forbiddenPatterns) {
    if (pattern.test(code)) throw new Error(`Generated capability contains forbidden ${label}`);
  }
}

function firstJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const char = raw[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return raw.slice(start, i + 1);
  }
  return null;
}

export function validateCapabilityDraft(value: unknown): CapabilityDraft {
  const draft = capabilityDraftSchema.parse(value);
  assertSafeCapabilityCode(draft.toolCode);
  validateGeneratedTests(draft.testCode, 'author');
  const sample = JSON.stringify(draft.sampleInput);
  if (sample === undefined || sample.length > 10_000) {
    throw new Error('Generated sample input must be JSON-serializable and at most 10,000 characters');
  }
  return draft;
}

function validateGeneratedTests(code: string, owner: 'author' | 'reviewer'): void {
  if (!code.includes('./tool.mjs')) {
    throw new Error(`Generated ${owner} tests must import ./tool.mjs`);
  }
  if (!code.includes('node:test')) {
    throw new Error(`Generated ${owner} tests must use node:test`);
  }
  if (/\b(?:test|describe|it)\s*\.\s*(?:skip|todo|only)\b|(?:skip|todo|only)\s*:\s*true\b/.test(code)) {
    throw new Error(`Generated ${owner} tests may not skip, defer, or selectively run tests`);
  }
  for (const [pattern, label] of forbiddenPatterns) {
    if (pattern.test(code)) throw new Error(`Generated ${owner} tests contain forbidden ${label}`);
  }
  staticTestNames(code, owner);
}

function normalizedEvidenceText(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim();
}

function staticTestNames(code: string, owner: 'author' | 'reviewer'): string[] {
  const names = [...code.matchAll(/\btest\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*,/gs)]
    .map((match) => match[2]!.replace(/\\(['"`\\])/g, '$1'));
  if (names.length === 0) {
    throw new Error(`Generated ${owner} tests must use static test names`);
  }
  if (new Set(names).size !== names.length) {
    throw new Error(`Generated ${owner} tests must use unique test names`);
  }
  return names;
}

export function validateCapabilityReview(
  value: unknown,
  sources: CapabilityEvidence[] = [],
  requiresOfficialEvidence = false,
): CapabilityReview {
  const review = capabilityReviewResponseSchema.parse(value);
  validateGeneratedTests(review.testCode, 'reviewer');
  if (requiresOfficialEvidence && sources.length === 0) {
    throw new Error('Independent review requires official evidence for the named RFC');
  }
  if (review.evidenceStatus !== 'sufficient') {
    throw new Error(`Independent capability review lacked sufficient evidence: ${review.summary}`);
  }
  if (requiresOfficialEvidence) {
    const testNames = staticTestNames(review.testCode, 'reviewer');
    const knownSources = new Map(sources.map((source) => [source.url, source]));
    const coveredTests = new Set<string>();
    for (const claim of review.evidenceClaims) {
      const source = knownSources.get(claim.sourceUrl);
      if (!source) {
        throw new Error(`Independent review cited an unknown official source: ${claim.sourceUrl}`);
      }
      if (!testNames.includes(claim.testName)) {
        throw new Error(`Independent review evidence names an unknown test: ${claim.testName}`);
      }
      const sourceText = normalizedEvidenceText(source.content);
      const quote = normalizedEvidenceText(claim.quote);
      if (!sourceText.includes(quote)) {
        throw new Error(`Independent review evidence quote was not found in ${claim.sourceUrl}`);
      }
      coveredTests.add(claim.testName);
    }
    const uncovered = testNames.filter((name) => !coveredTests.has(name));
    if (uncovered.length > 0) {
      throw new Error(`Independent review tests lack official evidence: ${uncovered.join(', ')}`);
    }
  }
  return { ...review, sources };
}

export async function generateCapabilityDraft(
  task: string,
  llm: LlmBackend = getLlmBackend(),
  repairFeedback?: string,
): Promise<CapabilityDraft> {
  const repairInstruction = repairFeedback
    ? `\n\nA previous draft failed sandbox validation. Return a corrected, complete draft. Keep toolCode, every run(...) call in testCode, and sampleInput on exactly the same object input contract. The author-written test expectation may itself be wrong; reconcile it with the independent reviewer and official evidence instead of changing correct behavior to satisfy a bad assertion.\nValidation failure and independent review:\n${repairFeedback.slice(0, 8_000)}`
    : '';
  await llm.ready();
  let formatInstruction = '';
  let formatError = 'The model did not return a JSON capability draft';
  for (let attempt = 0; attempt < 2; attempt++) {
    const messages: ChatMessage[] = [
      { role: 'system', content: generationPrompt },
      {
        role: 'user',
        content: `Requested capability:\n${task}${repairInstruction}${formatInstruction}`,
      },
    ];
    const raw = await llm.generateOnce(messages, {
      maxNewTokens: 3_200,
      temperature: 0.15,
      jsonObject: true,
    });
    const json = firstJsonObject(raw);
    if (json) {
      try {
        return validateCapabilityDraft(JSON.parse(json));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        formatError = 'The model returned invalid JSON for the capability draft';
      }
    }
    formatInstruction = [
      '',
      '',
      'Your previous response was not one complete valid JSON object.',
      'Retry once. Return only the five required keys and ensure all code is escaped as JSON strings.',
    ].join('\n');
  }
  throw new Error(formatError);
}

type EvidenceLoader = (task: string) => Promise<CapabilityEvidence[]>;

async function generateReviewedJson<T>(
  llm: LlmBackend,
  systemPrompt: string,
  content: string,
  maxNewTokens: number,
  webSearch: boolean,
  validator: (value: unknown) => T,
): Promise<T> {
  let formatInstruction = '';
  let formatError = 'The reviewer did not return a JSON capability review';
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await llm.generateOnce([
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [content, formatInstruction].filter(Boolean).join('\n\n'),
      },
    ], {
      maxNewTokens,
      temperature: 0.05,
      jsonObject: true,
      ...(webSearch
        ? {
          webSearch: {
            maxResults: 3,
            maxTotalResults: 5,
            maxCharactersPerResult: 3_000,
          },
        }
        : {}),
    });
    const json = firstJsonObject(raw);
    if (json) {
      try {
        return validator(JSON.parse(json));
      } catch (error) {
        formatError = error instanceof SyntaxError
          ? 'The reviewer returned invalid JSON for the capability review'
          : `The reviewer response failed validation: ${
            error instanceof Error ? error.message : String(error)
          }`;
      }
    }
    formatInstruction = [
      'Your previous response was not one complete valid JSON object.',
      'Retry once with only evidenceStatus, summary, testCode, and evidenceClaims, escaping the test program as a JSON string.',
      `Validation error: ${formatError}`,
    ].join(' ');
  }
  throw new Error(formatError);
}

export async function generateCapabilityReview(
  task: string,
  draft: CapabilityDraft,
  llm: LlmBackend = getLlmBackend(),
  evidenceLoader: EvidenceLoader = collectCapabilityEvidence,
): Promise<CapabilityReview> {
  const sources = await evidenceLoader(task);
  const officialEvidence = sources.length > 0
    ? sources.map((source) => [
      `Official source: ${source.title}`,
      `URL: ${source.url}`,
      source.content,
    ].join('\n')).join('\n\n')
    : 'No fixed official source was identified. Search the public web for authoritative evidence when needed.';
  await llm.ready();
  const reviewContent = [
    `Search the public web for official sources when the supplied evidence is not enough.`,
    `Requested capability:\n${task}`,
    `Generated implementation:\n${draft.toolCode}`,
    `Author tests:\n${draft.testCode}`,
    `Sample input:\n${JSON.stringify(draft.sampleInput)}`,
    `Verification evidence:\n${officialEvidence}`,
  ].join('\n\n');
  const candidate = await generateReviewedJson(
    llm,
    reviewPrompt,
    reviewContent,
    3_200,
    sources.length === 0,
    (value) => capabilityReviewResponseSchema.parse(value),
  );
  const requiresOfficialEvidence = requiresOfficialCapabilityEvidence(task);
  if (!requiresOfficialEvidence) {
    return validateCapabilityReview(candidate, sources, false);
  }

  const audited = await generateReviewedJson(
    llm,
    reviewAuditPrompt,
    [
      `Requested capability:\n${task}`,
      `Generated implementation:\n${draft.toolCode}`,
      `Author tests:\n${draft.testCode}`,
      `First reviewer proposal:\n${JSON.stringify(candidate)}`,
      `Complete official evidence:\n${officialEvidence}`,
    ].join('\n\n'),
    3_600,
    false,
    (value) => validateCapabilityReview(value, sources, true),
  );
  return audited;
}
