import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from './tool.mjs';

test('reverses a standard string', async () => {
  const result = await run({ text: 'hello' });
  assert.strictEqual(result.reversed, 'olleh');
});

test('reverses a string with spaces and punctuation', async () => {
  const result = await run({ text: 'A man, a plan!' });
  assert.strictEqual(result.reversed, '!nalp a ,nam A');
});

test('handles empty strings', async () => {
  const result = await run({ text: '' });
  assert.strictEqual(result.reversed, '');
});

test('correctly reverses Unicode surrogate pairs (emojis)', async () => {
  const result = await run({ text: '🚀🌕' });
  assert.strictEqual(result.reversed, '🌕🚀');
});

test('handles palindromes', async () => {
  const result = await run({ text: 'racecar' });
  assert.strictEqual(result.reversed, 'racecar');
});

test('throws error on invalid input type', async () => {
  await assert.rejects(
    () => run({ text: 123 }),
    /Input property "text" must be a string/
  );
});