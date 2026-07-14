import { z } from 'zod';
import { getLlmBackend } from '../llm/registry.js';
import type { ChatMessage, LlmBackend } from '../llm/types.js';

const MAX_CODE_CHARS = 30_000;

export const capabilityDraftSchema = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9-]{2,39}$/),
  summary: z.string().min(10).max(500),
  toolCode: z.string().min(40).max(MAX_CODE_CHARS),
  testCode: z.string().min(40).max(MAX_CODE_CHARS),
  sampleInput: z.record(z.unknown()),
}).strict();

export type CapabilityDraft = z.infer<typeof capabilityDraftSchema>;

const generationPrompt = `You generate a small, reviewable AGI-v1 capability.
Return exactly one JSON object with keys: slug, summary, toolCode, testCode, sampleInput.

Rules:
- slug is lowercase kebab-case, 3-40 characters.
- toolCode is dependency-free Node.js 24 ESM and exports: async function run(input).
- run(input) always receives exactly one JSON object. Never use a top-level string, number, boolean, null, or array as the input contract.
- The exported function returns JSON-serializable data.
- testCode uses node:test and node:assert/strict, imports run from ./tool.mjs, and has meaningful passing tests.
- Every test must call run with an object whose field names and value types match sampleInput, and toolCode must read that same object shape.
- Do not read environment variables, files, credentials, or process state.
- Do not use the network, child processes, workers, dynamic import, eval, or Function.
- Do not include a CLI wrapper; the host supplies a trusted runner.
- sampleInput is a small realistic JSON object that demonstrates the requested capability.
- Example contract: sampleInput {"text":"one two"}, toolCode reads input.text, and tests call run({ text: "one two" }).
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
  if (!draft.testCode.includes('./tool.mjs')) {
    throw new Error('Generated tests must import ./tool.mjs');
  }
  if (!draft.testCode.includes('node:test')) {
    throw new Error('Generated tests must use node:test');
  }
  for (const [pattern, label] of forbiddenPatterns) {
    if (pattern.test(draft.testCode)) throw new Error(`Generated tests contain forbidden ${label}`);
  }
  const sample = JSON.stringify(draft.sampleInput);
  if (sample === undefined || sample.length > 10_000) {
    throw new Error('Generated sample input must be JSON-serializable and at most 10,000 characters');
  }
  return draft;
}

export async function generateCapabilityDraft(
  task: string,
  llm: LlmBackend = getLlmBackend(),
  repairFeedback?: string,
): Promise<CapabilityDraft> {
  const repairInstruction = repairFeedback
    ? `\n\nA previous draft failed sandbox validation. Return a corrected, complete draft. Keep toolCode, every run(...) call in testCode, and sampleInput on exactly the same object input contract.\nValidation failure:\n${repairFeedback.slice(0, 4_000)}`
    : '';
  const messages: ChatMessage[] = [
    { role: 'system', content: generationPrompt },
    { role: 'user', content: `Requested capability:\n${task}${repairInstruction}` },
  ];
  await llm.ready();
  const raw = await llm.generateOnce(messages, { maxNewTokens: 1800, temperature: 0.15 });
  const json = firstJsonObject(raw);
  if (!json) throw new Error('The model did not return a JSON capability draft');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('The model returned invalid JSON for the capability draft');
  }
  return validateCapabilityDraft(parsed);
}
