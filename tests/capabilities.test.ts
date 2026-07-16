import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { parseCapabilityCommand } from '../src/capabilities/commands.js';
import {
  classifyCapabilityLimitation,
  looksLikeCapabilityLimitation,
  parseCapabilityGapMarker,
} from '../src/capabilities/autoRecovery.js';
import { assertCapabilityEnabled } from '../src/capabilities/config.js';
import {
  generateCapabilityDraft,
  generateCapabilityReview,
  validateCapabilityDraft,
  validateCapabilityReview,
} from '../src/capabilities/draft.js';
import {
  collectCapabilityEvidence,
  referencedRfcNumbers,
} from '../src/capabilities/evidence.js';
import { createGitHubAppJwt } from '../src/capabilities/github.js';
import {
  assertCapabilityCreationQuota,
  buildCapabilityRepairFeedback,
} from '../src/capabilities/service.js';
import type { CapabilityRequestRow } from '../src/storage/repositories/capabilityRequestRepo.js';
import {
  applyImprovementReplacements,
  extractImprovementPatch,
  generateImprovementProposal,
  validateImprovementPatch,
  validateImprovementProposal,
} from '../src/capabilities/improvement.js';
import { shouldAbortStreamOnResponseClose } from '../src/http/routes/chat.js';
import type { ChatMessage, LlmBackend } from '../src/llm/types.js';

const safeDraft = {
  slug: 'word-counter',
  summary: 'Counts the words in a supplied text value.',
  toolCode: `export async function run(input) {
    const text = typeof input?.text === 'string' ? input.text : '';
    return { count: text.trim() ? text.trim().split(/\\s+/).length : 0 };
  }`,
  testCode: `import test from 'node:test';
    import assert from 'node:assert/strict';
    import { run } from './tool.mjs';
    test('counts words', async () => assert.deepEqual(await run({ text: 'one two' }), { count: 2 }));`,
  sampleInput: { text: 'one two three' },
};

describe('capability commands', () => {
  it('requires an explicit build command', () => {
    expect(parseCapabilityCommand('please make a tool')).toBeNull();
    expect(parseCapabilityCommand('/build-tool Count words in supplied text')).toEqual({
      type: 'build',
      task: 'Count words in supplied text',
    });
  });

  it('parses an explicit self-improvement goal', () => {
    expect(parseCapabilityCommand('/improve-self Make chat errors clear and recoverable')).toEqual({
      type: 'improve',
      task: 'Make chat errors clear and recoverable',
    });
    expect(() => parseCapabilityCommand('/improve-self too short')).toThrow(/between 15 and 2,000/);
  });

  it('parses merged-tool input as JSON', () => {
    expect(parseCapabilityCommand('/run-tool word-counter {"text":"hello world"}')).toEqual({
      type: 'run',
      slug: 'word-counter',
      input: { text: 'hello world' },
    });
    expect(() => parseCapabilityCommand('/run-tool word-counter nope')).toThrow(/valid JSON/);
  });
});

describe('automatic capability-gap detection', () => {
  it('parses a strict internal gap signal', () => {
    expect(parseCapabilityGapMarker(
      '<capability-gap>{"kind":"source","task":"Add a reviewed calendar integration to AGI-v1"}</capability-gap>',
    )).toEqual({
      kind: 'source',
      task: 'Add a reviewed calendar integration to AGI-v1',
    });
  });

  it('recognizes missing executable abilities without treating ordinary uncertainty as a gap', () => {
    expect(looksLikeCapabilityLimitation("I can't browse the web right now.")).toBe(true);
    expect(looksLikeCapabilityLimitation('I can’t browse the web right now.')).toBe(true);
    expect(looksLikeCapabilityLimitation('I’m unable to run that conversion.')).toBe(true);
    expect(looksLikeCapabilityLimitation('I’m not able to access GitHub.')).toBe(true);
    expect(looksLikeCapabilityLimitation('I don’t have a tool that can search the web.')).toBe(true);
    expect(looksLikeCapabilityLimitation("I don't know the answer from the context provided.")).toBe(false);
  });

  it('classifies a natural capability refusal into a reusable tool task', async () => {
    const backend: LlmBackend = {
      name: 'test:gap-classifier',
      ready: async () => {},
      async *generate() {},
      generateOnce: async () => JSON.stringify({
        kind: 'tool',
        task: 'Convert a supplied image color from RGB to hexadecimal',
      }),
    };

    await expect(classifyCapabilityLimitation(
      backend,
      'Convert this RGB color to hex',
      "I can't run a conversion tool right now.",
    )).resolves.toEqual({
      kind: 'tool',
      task: 'Convert a supplied image color from RGB to hexadecimal',
    });
  });
});

describe('source improvement safety', () => {
  const safePatch = `diff --git a/src/brain/example.ts b/src/brain/example.ts
--- a/src/brain/example.ts
+++ b/src/brain/example.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
diff --git a/tests/example.test.ts b/tests/example.test.ts
new file mode 100644
--- /dev/null
+++ b/tests/example.test.ts
@@ -0,0 +1 @@
+export {};
`;

  it('extracts and validates a focused source patch with regression coverage', () => {
    expect(extractImprovementPatch(`Here is the patch:\n${safePatch}`)).toBe(safePatch);
    expect(validateImprovementPatch(safePatch)).toEqual([
      'src/brain/example.ts',
      'tests/example.test.ts',
    ]);
  });

  it('blocks changes to self-improvement guardrails and dependency manifests', () => {
    expect(() => validateImprovementPatch(safePatch.replaceAll(
      'src/brain/example.ts',
      'src/capabilities/improvement.ts',
    ))).toThrow(/protected or unsupported path/);
    expect(() => validateImprovementPatch(safePatch.replaceAll(
      'src/brain/example.ts',
      'package.json',
    ))).toThrow(/protected or unsupported path/);
    expect(() => validateImprovementPatch(safePatch.replaceAll(
      'src/brain/example.ts',
      'src/http/routes/chat.ts',
    ))).toThrow(/protected or unsupported path/);
  });

  it('requires a regression test for executable changes', () => {
    expect(() => validateImprovementPatch(safePatch.split('diff --git a/tests/')[0]!))
      .toThrow(/must include a regression test/);
  });

  it('materializes exact structured replacements without model-generated diff metadata', () => {
    const proposal = validateImprovementProposal({
      changes: [{
        path: 'README.md',
        replacements: [{ oldText: 'Old guidance', newText: 'New guidance' }],
      }],
    });
    expect(proposal[0]?.path).toBe('README.md');
    expect(applyImprovementReplacements(
      'Before\nOld guidance\nAfter\n',
      [{ oldText: 'Old guidance', newText: 'New guidance' }],
    )).toBe('Before\nNew guidance\nAfter\n');
  });

  it('rejects ambiguous replacements and protected structured edits', () => {
    expect(() => applyImprovementReplacements(
      'same\nsame\n',
      [{ oldText: 'same', newText: 'changed' }],
    )).toThrow(/ambiguous/);
    expect(() => validateImprovementProposal({
      changes: [{
        path: 'src/capabilities/improvement.ts',
        replacements: [{ oldText: 'before', newText: 'after' }],
      }],
    })).toThrow(/protected or unsupported path/);
    expect(() => validateImprovementProposal({
      changes: [{
        path: 'src/brain/example.ts',
        replacements: [{ oldText: 'before', newText: 'after' }],
      }],
    })).toThrow(/must include a regression test/);
  });

  it('parses a strict JSON proposal and includes repair feedback', async () => {
    const calls: ChatMessage[][] = [];
    const backend: LlmBackend = {
      name: 'test-improvement-proposal',
      async ready() {},
      async *generate() {},
      async generateOnce(messages) {
        calls.push(messages);
        return JSON.stringify({
          changes: [{
            path: 'README.md',
            replacements: [{ oldText: 'Old guidance', newText: 'New guidance' }],
          }],
        });
      },
    };

    await expect(generateImprovementProposal(
      'Improve the README guidance',
      '===== README.md =====\nOld guidance',
      backend,
      'oldText was not found',
    )).resolves.toHaveLength(1);
    expect(calls[0]?.[0]?.content).toContain('exactly one JSON object');
    expect(calls[0]?.[1]?.content).toContain('corrected complete JSON proposal');
  });
});

describe('chat stream disconnect handling', () => {
  it('does not abort after a normal completed response', () => {
    expect(shouldAbortStreamOnResponseClose(true)).toBe(false);
    expect(shouldAbortStreamOnResponseClose(false)).toBe(true);
  });
});

describe('capability configuration', () => {
  it('allows every authenticated caller when the feature is enabled', () => {
    const previousEnabled = process.env.CAPABILITY_BUILDER_ENABLED;
    try {
      process.env.CAPABILITY_BUILDER_ENABLED = 'true\n';
      expect(() => assertCapabilityEnabled()).not.toThrow();
    } finally {
      if (previousEnabled === undefined) delete process.env.CAPABILITY_BUILDER_ENABLED;
      else process.env.CAPABILITY_BUILDER_ENABLED = previousEnabled;
    }
  });

  it('keeps the global capability feature flag as a kill switch', () => {
    const previousEnabled = process.env.CAPABILITY_BUILDER_ENABLED;
    try {
      process.env.CAPABILITY_BUILDER_ENABLED = 'false';
      expect(() => assertCapabilityEnabled()).toThrow(/disabled/);
    } finally {
      if (previousEnabled === undefined) delete process.env.CAPABILITY_BUILDER_ENABLED;
      else process.env.CAPABILITY_BUILDER_ENABLED = previousEnabled;
    }
  });
});

describe('capability creation quota', () => {
  const now = 2_000_000_000_000;
  const request = (overrides: Partial<CapabilityRequestRow> = {}): CapabilityRequestRow => ({
    id: 'r_test',
    user_id: 'u_test',
    task: 'Build a safe test capability',
    slug: null,
    status: 'pr_opened',
    branch_name: null,
    pr_url: null,
    sandbox_summary: null,
    error: null,
    created_at: now - 1_000,
    updated_at: now - 1_000,
    ...overrides,
  });

  it('allows up to two completed creation requests per user per hour', () => {
    expect(() => assertCapabilityCreationQuota([request()], now)).not.toThrow();
  });

  it('blocks a second active creation request', () => {
    expect(() => assertCapabilityCreationQuota([
      request({ status: 'generating' }),
    ], now)).toThrow(/active capability request/);
  });

  it('limits creation and self-improvement requests to two per hour', () => {
    expect(() => assertCapabilityCreationQuota([
      request({ id: 'r_one' }),
      request({ id: 'r_two', status: 'failed', created_at: now - 2_000 }),
    ], now)).toThrow(/2 requests per user per hour/);
  });

  it('does not permanently lock a user behind stale requests', () => {
    expect(() => assertCapabilityCreationQuota([
      request({
        status: 'validating',
        created_at: now - 3_700_000,
        updated_at: now - 16 * 60 * 1_000,
      }),
    ], now)).not.toThrow();
  });
});

describe('GitHub App authentication', () => {
  it('keeps the required issued-at claim in the signed assertion', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const now = Math.floor(Date.now() / 1000);
    const token = createGitHubAppJwt('4293131', privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    }).toString());
    const payload = jwt.decode(token);

    expect(payload).toMatchObject({ iss: '4293131' });
    expect(typeof payload).toBe('object');
    expect(payload && typeof payload === 'object' ? payload.iat : undefined)
      .toBeGreaterThanOrEqual(now - 61);
    expect(payload && typeof payload === 'object' ? payload.exp : undefined)
      .toBeGreaterThan(now);
  });
});

describe('capability draft validation', () => {
  it('accepts a dependency-free, test-covered tool', () => {
    expect(validateCapabilityDraft(safeDraft).slug).toBe('word-counter');
  });

  it('blocks credential, network, and process access before sandbox execution', () => {
    expect(() => validateCapabilityDraft({
      ...safeDraft,
      toolCode: `export async function run() { return process.env.SECRET; }`,
    })).toThrow(/process access/);
    expect(() => validateCapabilityDraft({
      ...safeDraft,
      toolCode: `export async function run() { return fetch('https://example.com'); }`,
    })).toThrow(/network fetch/);
    expect(() => validateCapabilityDraft({
      ...safeDraft,
      toolCode: `import { createRequire } from 'node:module';
        export async function run() { return createRequire(import.meta.url)('fs'); }`,
    })).toThrow(/privileged module|runtime module loading/);
  });

  it('requires a JSON object for the canonical tool input contract', () => {
    expect(() => validateCapabilityDraft({
      ...safeDraft,
      sampleInput: 'one two three',
    })).toThrow();
  });

  it('requires an independent reviewer to have sufficient evidence', () => {
    const review = {
      evidenceStatus: 'sufficient',
      summary: 'Exercises invalid inputs and boundary behavior independently.',
      testCode: `import test from 'node:test';
        import assert from 'node:assert/strict';
        import { run } from './tool.mjs';
        test('handles empty text', async () => assert.deepEqual(await run({ text: '' }), { count: 0 }));`,
    };
    expect(validateCapabilityReview(review).summary).toContain('independently');
    expect(() => validateCapabilityReview({
      ...review,
      evidenceStatus: 'insufficient',
    })).toThrow(/lacked sufficient evidence/);
    expect(() => validateCapabilityReview(review, [], true))
      .toThrow(/requires official evidence/);
  });

  it('grounds RFC reviews in the official RFC Editor document', async () => {
    const calls: Array<{ messages: ChatMessage[]; webSearch: boolean }> = [];
    const backend: LlmBackend = {
      name: 'test:capability-review',
      async ready() {},
      async *generate() {},
      async generateOnce(messages, opts) {
        calls.push({ messages, webSearch: Boolean(opts?.webSearch) });
        return JSON.stringify({
          evidenceStatus: 'sufficient',
          summary: 'Tests a normative Unicode error requirement from the official RFC.',
          testCode: `import test from 'node:test';
            import assert from 'node:assert/strict';
            import { run } from './tool.mjs';
            test('rejects a lone surrogate', async () => {
              await assert.rejects(() => run({ text: '\\ud800' }));
            });`,
        });
      },
    };
    const evidence = [{
      title: 'RFC 8785',
      url: 'https://www.rfc-editor.org/rfc/rfc8785.txt',
      content: 'Occurrences of invalid Unicode data like lone surrogates MUST cause an error.',
    }];

    const review = await generateCapabilityReview(
      'Canonicalize JSON according to RFC 8785',
      safeDraft,
      backend,
      async () => evidence,
    );

    expect(review.sources).toEqual(evidence);
    expect(calls[0]?.webSearch).toBe(false);
    expect(calls[0]?.messages[1]?.content).toContain('rfc8785.txt');
    expect(calls[0]?.messages[1]?.content).toContain('lone surrogates');
  });

  it('retries one malformed reviewer response with stricter JSON instructions', async () => {
    const calls: ChatMessage[][] = [];
    const backend: LlmBackend = {
      name: 'test:capability-review-json-retry',
      async ready() {},
      async *generate() {},
      async generateOnce(messages) {
        calls.push(messages);
        return calls.length === 1
          ? 'The implementation needs more tests.'
          : JSON.stringify({
            evidenceStatus: 'sufficient',
            summary: 'Adds a boundary test independent from the author suite.',
            testCode: `import test from 'node:test';
              import assert from 'node:assert/strict';
              import { run } from './tool.mjs';
              test('handles empty input', async () => {
                assert.deepEqual(await run({ text: '' }), { count: 0 });
              });`,
          });
      },
    };

    await expect(generateCapabilityReview(
      'Count words in supplied text',
      safeDraft,
      backend,
      async () => [],
    )).resolves.toMatchObject({ evidenceStatus: 'sufficient' });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.[1]?.content).toContain('previous response was not one complete valid JSON object');
  });

  it('loads numbered RFC evidence from the fixed official host', async () => {
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      requested.push(String(input));
      return new Response('RFC evidence '.repeat(20), {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    };

    expect(referencedRfcNumbers('Implement RFC 8785 and RFC-8259')).toEqual(['8785', '8259']);
    const evidence = await collectCapabilityEvidence('Implement RFC 8785', fetchImpl);
    expect(requested).toEqual(['https://www.rfc-editor.org/rfc/rfc8785.txt']);
    expect(evidence[0]?.content).toContain('RFC evidence');
    await expect(collectCapabilityEvidence('Implement an RFC canonicalizer', fetchImpl))
      .rejects.toThrow(/must name the RFC number/);
  });

  it('feeds sandbox failures back into one corrected generation request', async () => {
    const calls: Array<{ messages: ChatMessage[]; jsonObject: boolean }> = [];
    const backend: LlmBackend = {
      name: 'test-capability-repair',
      async ready() {},
      async *generate() {},
      async generateOnce(messages, opts) {
        calls.push({ messages, jsonObject: Boolean(opts?.jsonObject) });
        return JSON.stringify(safeDraft);
      },
    };

    await generateCapabilityDraft(
      'Count words in supplied text',
      backend,
      'Tests passed objects but the tool expected a raw string',
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.jsonObject).toBe(true);
    expect(calls[0]?.messages[0]?.content).toContain('run(input) always receives exactly one JSON object');
    expect(calls[0]?.messages[1]?.content).toContain('previous draft failed sandbox validation');
    expect(calls[0]?.messages[1]?.content).toContain('same object input contract');
    expect(calls[0]?.messages[1]?.content).toContain('author-written test expectation may itself be wrong');
  });

  it('keeps reviewer evidence and tests fixed in capability repair feedback', () => {
    const feedback = buildCapabilityRepairFeedback({
      evidenceStatus: 'sufficient',
      summary: 'The official ordering example is the source of truth.',
      testCode: `import test from 'node:test';
        import { run } from './tool.mjs';
        test('official order', async () => run({ data: {} }));`,
      sources: [{
        title: 'RFC 8785',
        url: 'https://www.rfc-editor.org/rfc/rfc8785.txt',
        content: 'official content',
      }],
    }, 'author assertion expected the wrong property order');

    expect(feedback).toContain('fixed regression gate');
    expect(feedback).toContain('official ordering example');
    expect(feedback).toContain('rfc8785.txt');
    expect(feedback).toContain("test('official order'");
    expect(feedback).toContain('wrong property order');
  });

  it('retries one malformed provider response with stricter JSON instructions', async () => {
    const calls: ChatMessage[][] = [];
    const backend: LlmBackend = {
      name: 'test-capability-json-retry',
      async ready() {},
      async *generate() {},
      async generateOnce(messages) {
        calls.push(messages);
        return calls.length === 1 ? 'I cannot provide that JSON.' : JSON.stringify(safeDraft);
      },
    };

    await expect(generateCapabilityDraft('Count words in supplied text', backend))
      .resolves.toMatchObject({ slug: 'word-counter' });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.[1]?.content).toContain('previous response was not one complete valid JSON object');
  });
});
