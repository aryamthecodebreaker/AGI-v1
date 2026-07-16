import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from './tool.mjs';

test('JCS - Lone surrogates must throw an error', async () => {
  await assert.rejects(
    async () => {
      await run({ value: "\uD83D" });
    },
    /error/i,
    'Lone high surrogate should throw an error'
  );

  await assert.rejects(
    async () => {
      await run({ value: "\uDE00" });
    },
    /error/i,
    'Lone low surrogate should throw an error'
  );
});

test('JCS - Recursive sorting of objects inside arrays', async () => {
  const input = {
    value: [
      {
        z: 1,
        a: 2
      }
    ]
  };
  const res = await run(input);
  assert.equal(res.canonical, '[{"a":2,"z":1}]');
});

test('JCS - Complex UTF-16 sorting order from RFC 8785 section 3.2.3', async () => {
  const input = {
    value: {
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\ufb33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "\ud83d\ude00": "Emoji: Grinning Face",
      "\u0080": "Control",
      "\u00f6": "Latin Small Letter O With Diaeresis"
    }
  };
  
  const res = await run(input);
  const expectedKeys = [
    '"\\r":"Carriage Return"',
    '"1":"One"',
    '"\\u0080":"Control"',
    '"\u00f6":"Latin Small Letter O With Diaeresis"',
    '"\u20ac":"Euro Sign"',
    '"\ud83d\ude00":"Emoji: Grinning Face"',
    '"\ufb33":"Hebrew Letter Dalet With Dagesh"'
  ];
  const expected = '{' + expectedKeys.join(',') + '}';
  assert.equal(res.canonical, expected);
});

test('JCS - Number serialization edge cases from Appendix B', async () => {
  const resNegZero = await run({ value: -0 });
  assert.equal(resNegZero.canonical, '-0');

  const resLarge = await run({ value: 1e+23 });
  assert.equal(resLarge.canonical, '1e23');

  const resSmall = await run({ value: 1e-27 });
  assert.equal(resSmall.canonical, '1e-27');
});

test('JCS - Basic primitives and nested structures', async () => {
  const resNull = await run({ value: null });
  assert.equal(resNull.canonical, 'null');

  const resBool = await run({ value: true });
  assert.equal(resBool.canonical, 'true');

  const resObj = await run({ value: { b: 2, a: 1 } });
  assert.equal(resObj.canonical, '{"a":1,"b":2}');
});