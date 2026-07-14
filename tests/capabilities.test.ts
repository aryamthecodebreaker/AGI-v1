import { describe, expect, it } from 'vitest';
import { parseCapabilityCommand } from '../src/capabilities/commands.js';
import { assertCapabilityAdmin } from '../src/capabilities/config.js';
import { generateCapabilityDraft, validateCapabilityDraft } from '../src/capabilities/draft.js';
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

  it('parses merged-tool input as JSON', () => {
    expect(parseCapabilityCommand('/run-tool word-counter {"text":"hello world"}')).toEqual({
      type: 'run',
      slug: 'word-counter',
      input: { text: 'hello world' },
    });
    expect(() => parseCapabilityCommand('/run-tool word-counter nope')).toThrow(/valid JSON/);
  });
});

describe('capability configuration', () => {
  it('accepts whitespace around deployment-provided flag values', () => {
    const previousEnabled = process.env.CAPABILITY_BUILDER_ENABLED;
    const previousAdmins = process.env.CAPABILITY_ADMIN_USER_IDS;
    try {
      process.env.CAPABILITY_BUILDER_ENABLED = 'true\n';
      process.env.CAPABILITY_ADMIN_USER_IDS = 'u_owner\n';
      expect(() => assertCapabilityAdmin('u_owner')).not.toThrow();
    } finally {
      if (previousEnabled === undefined) delete process.env.CAPABILITY_BUILDER_ENABLED;
      else process.env.CAPABILITY_BUILDER_ENABLED = previousEnabled;
      if (previousAdmins === undefined) delete process.env.CAPABILITY_ADMIN_USER_IDS;
      else process.env.CAPABILITY_ADMIN_USER_IDS = previousAdmins;
    }
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

  it('feeds sandbox failures back into one corrected generation request', async () => {
    const calls: ChatMessage[][] = [];
    const backend: LlmBackend = {
      name: 'test-capability-repair',
      async ready() {},
      async *generate() {},
      async generateOnce(messages) {
        calls.push(messages);
        return JSON.stringify(safeDraft);
      },
    };

    await generateCapabilityDraft(
      'Count words in supplied text',
      backend,
      'Tests passed objects but the tool expected a raw string',
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]?.content).toContain('run(input) always receives exactly one JSON object');
    expect(calls[0]?.[1]?.content).toContain('previous draft failed sandbox validation');
    expect(calls[0]?.[1]?.content).toContain('same object input contract');
  });
});
