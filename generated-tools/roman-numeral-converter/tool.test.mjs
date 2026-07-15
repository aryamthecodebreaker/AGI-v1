import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from './tool.mjs';

test('converts basic units', async () => {
  const res = await run({ value: 3 });
  assert.strictEqual(res.roman, 'III');
});

test('converts subtractive notation', async () => {
  const res4 = await run({ value: 4 });
  assert.strictEqual(res4.roman, 'IV');
  const res9 = await run({ value: 9 });
  assert.strictEqual(res9.roman, 'IX');
  const res90 = await run({ value: 90 });
  assert.strictEqual(res90.roman, 'XC');
});

test('converts complex numbers', async () => {
  const res = await run({ value: 1987 });
  assert.strictEqual(res.roman, 'MCMLXXXVII');
});

test('converts maximum value', async () => {
  const res = await run({ value: 3999 });
  assert.strictEqual(res.roman, 'MMMCMXCIX');
});

test('throws on invalid input', async () => {
  await assert.rejects(() => run({ value: 0 }));
  await assert.rejects(() => run({ value: 4000 }));
  await assert.rejects(() => run({ value: '10' }));
});