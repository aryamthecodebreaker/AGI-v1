import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from './tool.mjs';

test('JCS - Lone surrogates must throw an error', async () => {
  // Section 3.2.2.2: "occurrences of such data [lone surrogates] MUST cause a compliant JCS implementation to terminate with an appropriate error."
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
  // Section 3.2.3: "JSON array data MUST also be scanned for the presence of JSON objects (if an object is found, then its properties MUST be sorted)"
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
  // Minus zero
  const resNegZero = await run({ value: -0 });
  assert.equal(resNegZero.canonical, '-0');

  // Large integers and exponential notation normalization
  const resLarge = await run({ value: 1e+23 });
  assert.equal(resLarge.canonical, '1e23');

  const resSmall = await run({ value: 1e-27 });
  assert.equal(resSmall.canonical, '1e-27');
});
