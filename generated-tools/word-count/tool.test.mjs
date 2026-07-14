import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from './tool.mjs';

test('counts simple words', async () => {
  const result = await run({ text: 'Hello world' });
  assert.strictEqual(result, 2);
});

test('counts words with multiple spaces', async () => {
  const result = await run({ text: 'Hello   world   test' });
  assert.strictEqual(result, 3);
});

test('counts words with newlines', async () => {
  const result = await run({ text: 'Hello\nworld' });
  assert.strictEqual(result, 2);
});

test('counts words with punctuation', async () => {
  const result = await run({ text: 'Hello, world!' });
  assert.strictEqual(result, 2);
});

test('counts zero words for empty string', async () => {
  const result = await run({ text: '' });
  assert.strictEqual(result, 0);
});
