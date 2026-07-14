import { describe, expect, it } from 'vitest';
import { parseCapabilityCommand } from '../src/capabilities/commands.js';
import { validateCapabilityDraft } from '../src/capabilities/draft.js';

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
});
