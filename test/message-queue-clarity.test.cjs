'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { upsertQueuedMessage } = loadTs('src/shared/messageQueue.ts');

test('one inbox wake-up is refreshed instead of queued repeatedly', () => {
  const first = {
    id: 'one', text: '1 inbox item', ts: 1, dedupeKey: 'hive-inbox',
    source: { kind: 'hive-inbox', label: 'Michael · Review CI plan' },
  };
  const refreshed = {
    id: 'two', text: '2 inbox items', ts: 2, dedupeKey: 'hive-inbox',
    source: { kind: 'hive-inbox', label: '2 inbox items from Michael and Jim' },
  };

  assert.deepEqual(upsertQueuedMessage([first], refreshed), [refreshed]);
});

test('distinct human messages remain distinct and ordered', () => {
  const first = { id: 'one', text: 'First', ts: 1 };
  const second = { id: 'two', text: 'Second', ts: 2 };
  assert.deepEqual(upsertQueuedMessage([first], second), [first, second]);
});
