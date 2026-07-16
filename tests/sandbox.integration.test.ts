import dotenv from 'dotenv';
import { describe, expect, it } from 'vitest';
import { validateAndExecuteInSandbox } from '../src/capabilities/sandbox.js';
import { validateCapabilityDraft, validateCapabilityReview } from '../src/capabilities/draft.js';

dotenv.config({ path: '.env.local' });

const shouldRun =
  process.env.RUN_SANDBOX_INTEGRATION === '1' &&
  Boolean(process.env.VERCEL_OIDC_TOKEN);

describe.skipIf(!shouldRun)('Vercel Sandbox integration', () => {
  it('tests and executes generated code with network denied', async () => {
    const draft = validateCapabilityDraft({
      slug: 'word-counter',
      summary: 'Counts words in the provided input text.',
      toolCode: `export async function run(input) {
        const text = typeof input?.text === 'string' ? input.text : '';
        return { count: text.trim() ? text.trim().split(/\\s+/).length : 0 };
      }`,
      testCode: `import test from 'node:test';
        import assert from 'node:assert/strict';
        import { run } from './tool.mjs';
        test('counts words', async () => {
          assert.deepEqual(await run({ text: 'one two' }), { count: 2 });
        });`,
      sampleInput: { text: 'one two three' },
    });

    const review = validateCapabilityReview({
      evidenceStatus: 'sufficient',
      summary: 'Adds an independent empty-input boundary test.',
      testCode: `import test from 'node:test';
        import assert from 'node:assert/strict';
        import { run } from './tool.mjs';
        test('counts no words in empty text', async () => {
          assert.deepEqual(await run({ text: '' }), { count: 0 });
        });`,
      evidenceClaims: [],
    });

    const result = await validateAndExecuteInSandbox(draft, draft.sampleInput, review);
    expect(result.passed).toBe(true);
    expect(result.testOutput).toContain('pass 2');
    expect(JSON.parse(result.sampleOutput)).toEqual({ count: 3 });
  }, 90_000);

  it('enforces deny-all egress inside the sandbox', async () => {
    const networkProbe = {
      slug: 'network-policy-probe',
      summary: 'Proves that the capability sandbox blocks outbound network access.',
      toolCode: `export async function run() {
        try {
          await fetch('https://example.com');
          return { blocked: false };
        } catch {
          return { blocked: true };
        }
      }`,
      testCode: `import test from 'node:test';
        import assert from 'node:assert/strict';
        import { run } from './tool.mjs';
        test('blocks egress', async () => assert.deepEqual(await run(), { blocked: true }));`,
      sampleInput: {},
    };

    // This bypasses static validation on purpose so the infrastructure-level
    // deny-all policy is verified independently of the source scanner.
    const result = await validateAndExecuteInSandbox(networkProbe);
    expect(result.passed).toBe(true);
    expect(JSON.parse(result.sampleOutput)).toEqual({ blocked: true });
  }, 90_000);
});
