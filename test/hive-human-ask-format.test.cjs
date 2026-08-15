'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

test('Michael must write short actionable human asks with explicit open questions', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'main', 'hive.ts'), 'utf8');
  for (const heading of [
    'WHAT:',
    'WHY:',
    'DECISION NEEDED:',
    'RECOMMENDATION:',
    'OPEN QUESTIONS:',
    'OPTIONS:',
    'EVIDENCE:',
    'ANSWER FORMAT:',
    'ASD-STE100-style',
  ]) {
    assert.match(source, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
