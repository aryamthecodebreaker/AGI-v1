import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from './tool.mjs';

test('clamp within bounds', async () => {
  const result = await run({ value: 5, min: 0, max: 10 });
  assert.strictEqual(result, 5);
});

test('clamp below min', async () => {
  const result = await run({ value: -5, min: 0, max: 10 });
  assert.strictEqual(result, 0);
});

test('clamp above max', async () => {
  const result = await run({ value: 15, min: 0, max: 10 });
  assert.strictEqual(result, 10);
});

test('clamp negative bounds', async () => {
  const result = await run({ value: -5, min: -10, max: -1 });
  assert.strictEqual(result, -5);
});

test('clamp value equal to min', async () => {
  const result = await run({ value: 0, min: 0, max: 10 });
  assert.strictEqual(result, 0);
});

test('clamp value equal to max', async () => {
  const result = await run({ value: 10, min: 0, max: 10 });
  assert.strictEqual(result, 10);
});

test('throws on non-finite', async () => {
  await assert.rejects(run({ value: NaN, min: 0, max: 10 }), /Non-finite number/);
});

test('throws when minimum exceeds maximum', async () => {
  await assert.rejects(
    run({ value: 5, min: 10, max: 0 }),
    /Minimum cannot exceed maximum/,
  );
});
