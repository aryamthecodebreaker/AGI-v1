import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from './tool.mjs';

test('JCS: sorts object keys alphabetically', async () => {
  const input = { data: { z: 1, a: 2, m: 3 } };
  const result = await run(input);
  assert.equal(result.canonicalString, '{"a":2,"m":3,"z":1}');
});

test('JCS: handles nested structures and arrays', async () => {
  const input = { data: { b: [3, 2, 1], a: { y: true, x: null } } };
  const result = await run(input);
  assert.equal(result.canonicalString, '{"a":{"x":null,"y":true},"b":[3,2,1]}');
});

test('JCS: handles strings with escapes', async () => {
  const input = { data: { "\u0001": "foo" } };
  const result = await run(input);
  // JSON.stringify handles the required escaping for JCS
  assert.equal(result.canonicalString, '{"\\u0001":"foo"}');
});

test('JCS: handles numbers correctly', async () => {
  const input = { data: { n: 1e2 } };
  const result = await run(input);
  assert.equal(result.canonicalString, '{"n":100}');
});