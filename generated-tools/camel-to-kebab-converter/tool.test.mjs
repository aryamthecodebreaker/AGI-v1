import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from './tool.mjs';

const sampleInput = {
  firstName: 'John',
  lastName: 'Doe',
  address: {
    streetName: 'Main St',
    cityName: 'Springfield'
  },
  hobbies: ['reading', 'coding']
};

const expectedOutput = {
  'first-name': 'John',
  'last-name': 'Doe',
  address: {
    'street-name': 'Main St',
    'city-name': 'Springfield'
  },
  hobbies: ['reading', 'coding']
};

test('converts top-level camelCase keys to kebab-case', async () => {
  const result = await run(sampleInput);
  assert.deepStrictEqual(result, expectedOutput);
});

test('does not mutate the original input', async () => {
  const inputCopy = JSON.parse(JSON.stringify(sampleInput));
  await run(sampleInput);
  assert.deepStrictEqual(sampleInput, inputCopy);
});

test('handles nested objects and arrays correctly', async () => {
  const complexInput = {
    userInfo: {
      userName: 'alice',
      userDetails: {
        firstName: 'Alice',
        lastName: 'Smith'
      }
    },
    tags: ['tagOne', 'tagTwo']
  };
  const complexExpected = {
    'user-info': {
      'user-name': 'alice',
      'user-details': {
        'first-name': 'Alice',
        'last-name': 'Smith'
      }
    },
    tags: ['tagOne', 'tagTwo']
  };
  const result = await run(complexInput);
  assert.deepStrictEqual(result, complexExpected);
});