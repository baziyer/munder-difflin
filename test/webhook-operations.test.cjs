'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { closeSync, mkdtempSync, mkdirSync, openSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  applyHumanAnswer,
  buildOperationalSnapshot,
  readBoundedUtf8,
  readOperationalDocument,
} = loadTs('src/main/webhookOperations.ts');

test('bounded document reads reject one byte beyond the cap', () => {
  const root = mkdtempSync(join(require('node:os').tmpdir(), 'munder-bounded-document-'));
  const path = join(root, 'design.md');
  writeFileSync(path, '12345', 'utf8');
  const fd = openSync(path, 'r');
  try {
    assert.throws(() => readBoundedUtf8(fd, 4), /read limit/);
  } finally {
    closeSync(fd);
  }
});
const { verifyHumanAnswerReceipt } = loadTs('src/main/humanAnswerReceipt.ts');

const NOW = Date.parse('2026-08-15T12:00:00.000Z');

function task(overrides = {}) {
  return {
    id: 'task-1',
    title: 'Ship SECRET safely',
    status: 'blocked',
    assignee: 'worker-1',
    dependsOn: [],
    priority: 1,
    createdAt: '2026-08-15T10:00:00.000Z',
    startedAt: '2026-08-15T10:30:00.000Z',
    humanQA: [{ q: 'Choose SECRET option?', askedAt: '2026-08-15T11:00:00.000Z' }],
    description: 'private implementation detail',
    ...overrides
  };
}

test('buildOperationalSnapshot exposes actionable bounded state and omits local internals', () => {
  const done = Array.from({ length: 15 }, (_, index) => task({
    id: `done-${index}`,
    title: `Done ${index}`,
    status: 'done',
    humanQA: undefined,
    result: `Result SECRET ${index}`,
    completedAt: new Date(NOW - index * 1000).toISOString()
  }));
  const snapshot = buildOperationalSnapshot({
    tasks: [
      task({ dependsOn: ['dependency'.repeat(40)] }),
      task({ id: 'dismissed', humanQA: [{ q: 'old', dismissedAt: '2026-08-15T11:30:00.000Z' }] }),
      ...done
    ],
    registry: {
      godId: 'god',
      agents: {
        god: { id: 'god', name: 'Michael', role: 'orchestrator', provider: 'claude', cwd: '/private', status: 'working', lastSeen: NOW },
        'worker-1': { id: 'worker-1', name: 'Dwight', role: 'builder', provider: 'claude', cwd: '/private/worktree', status: 'working', lastSeen: NOW }
      }
    },
    fleet: {
      ts: NOW,
      agents: [{
        id: 'worker-1', name: 'Dwight', role: 'builder', cwd: '/private/worktree',
        isGod: false, breaker: 'healthy', tokens: 1200, usd: 1.25,
        lastTool: 'Bash', lastActiveSecAgo: 4, inboxBacklog: 2
      }]
    },
    now: NOW,
    redact: (value) => value.replaceAll('SECRET', '[redacted]')
  });

  assert.equal(snapshot.generatedAt, '2026-08-15T12:00:00.000Z');
  assert.deepEqual(snapshot.counts, { todo: 0, doing: 0, blocked: 2, done: 15 });
  assert.equal(snapshot.tasks.filter((item) => item.status === 'done').length, 12);
  assert.equal(snapshot.tasks[0].title, 'Ship [redacted] safely');
  assert.equal(snapshot.tasks[0].question.text, 'Choose [redacted] option?');
  assert.equal(snapshot.tasks[0].dependsOn[0].length, 256);
  assert.equal(snapshot.tasks[1].question, undefined, 'dismissed asks are not actionable');
  assert.equal(snapshot.tasks.find((item) => item.id === 'done-0').result, 'Result [redacted] 0');
  assert.equal(snapshot.tasks[0].description, undefined);
  assert.deepEqual(snapshot.agents, [{
    id: 'worker-1', name: 'Dwight', role: 'builder', provider: 'claude', isGod: false,
    breaker: 'healthy', tokens: 1200, usd: 1.25, lastActiveSecAgo: 4, inboxBacklog: 2
  }]);
  assert.equal(snapshot.agents[0].cwd, undefined);
  assert.equal(snapshot.agents[0].lastTool, undefined);
});

test('applyHumanAnswer records the latest open answer without changing task status', () => {
  const tasks = [task({
    humanQA: [
      { q: 'Earlier?', a: 'Earlier answer', answeredAt: '2026-08-15T09:00:00.000Z' },
      { q: 'Current?', askedAt: '2026-08-15T11:00:00.000Z' }
    ]
  })];
  const applied = applyHumanAnswer(tasks, { taskId: 'task-1', answer: 'Current answer' }, NOW);
  assert.equal(applied.result.ok, true);
  assert.equal(applied.tasks[0].status, 'blocked');
  assert.equal(applied.tasks[0].humanQA[0].a, 'Earlier answer');
  assert.equal(applied.tasks[0].humanQA[1].a, 'Current answer');
  assert.equal(applied.tasks[0].humanQA[1].answeredAt, '2026-08-15T12:00:00.000Z');
  assert.equal(applied.notification.question, 'Current?');
});

test('applyHumanAnswer authenticates webhook provenance without persisting the secret', () => {
  const secret = 'endpoint-secret-for-test';
  const applied = applyHumanAnswer(
    [task({ humanQA: [{ q: 'Approve exact hire?' }] })],
    { taskId: 'task-1', answer: 'Yes, implement it.' },
    NOW,
    { source: 'webhook', endpointId: 'minerva', endpointSecret: secret }
  );
  const answer = applied.tasks[0].humanQA[0];
  assert.equal(answer.answerSource, 'webhook');
  assert.equal(answer.answerEndpointId, 'minerva');
  assert.equal(typeof answer.answerReceipt, 'string');
  assert.equal(JSON.stringify(answer).includes(secret), false);
  assert.equal(verifyHumanAnswerReceipt(secret, {
    taskId: 'task-1',
    question: 'Approve exact hire?',
    answer: 'Yes, implement it.',
    answeredAt: '2026-08-15T12:00:00.000Z',
    endpointId: 'minerva'
  }, answer.answerReceipt), true);
});

test('applyHumanAnswer gives desktop Ask Me the same authenticated receipt contract', () => {
  const secret = 'desktop-main-only-test-key';
  const applied = applyHumanAnswer(
    [task({ humanQA: [{ q: 'Approve from the desktop queue?' }] })],
    { taskId: 'task-1', answer: 'Approved.' },
    NOW,
    { source: 'desktop', endpointId: 'desktop-ask-me', endpointSecret: secret }
  );
  const answer = applied.tasks[0].humanQA[0];
  assert.equal(answer.answerSource, 'desktop');
  assert.equal(answer.answerEndpointId, 'desktop-ask-me');
  assert.equal(verifyHumanAnswerReceipt(secret, {
    taskId: 'task-1',
    question: 'Approve from the desktop queue?',
    answer: 'Approved.',
    answeredAt: '2026-08-15T12:00:00.000Z',
    endpointId: 'desktop-ask-me'
  }, answer.answerReceipt), true);
});

test('applyHumanAnswer fails closed for missing tasks or resolved asks', () => {
  const missing = applyHumanAnswer([task()], { taskId: 'missing', answer: 'x' }, NOW);
  assert.deepEqual(missing.result, { ok: false, status: 404, error: 'task not found' });

  const resolved = applyHumanAnswer(
    [task({ humanQA: [{ q: 'Resolved?', a: 'yes' }] })],
    { taskId: 'task-1', answer: 'again' },
    NOW
  );
  assert.deepEqual(resolved.result, { ok: false, status: 409, error: 'task has no open human question' });
});

test('open questions expose bounded hive design documents by opaque id', () => {
  const root = mkdtempSync('/tmp/munder-docs-');
  const designDir = join(root, 'agents', 'angela', 'design');
  mkdirSync(designDir, { recursive: true });
  writeFileSync(join(designDir, 'telemetry-plan.md'), '# Plan\n\nSECRET evidence', 'utf8');
  const tasks = [task({
    humanQA: [{
      q: 'WHAT: Add safe telemetry.\nWHY: Find release errors.\nEVIDENCE: hive/agents/angela/design/telemetry-plan.md',
    }],
  })];
  const snapshot = buildOperationalSnapshot({
    tasks,
    registry: { godId: null, agents: {} },
    fleet: {},
    documentRoot: root,
    now: NOW,
    redact: (value) => value.replaceAll('SECRET', '[redacted]'),
  });

  const ref = snapshot.tasks[0].question.documents[0];
  assert.equal(ref.name, 'telemetry-plan.md');
  assert.equal(ref.reference, 'hive/agents/angela/design/telemetry-plan.md');
  assert.match(ref.id, /^[a-f0-9]{24}$/);

  const result = readOperationalDocument({
    tasks,
    taskId: 'task-1',
    documentId: ref.id,
    documentRoot: root,
    redact: (value) => value.replaceAll('SECRET', '[redacted]'),
  });
  assert.equal(result.ok, true);
  assert.equal(result.document.content, '# Plan\n\n[redacted] evidence');
  assert.match(result.document.revision, /^[a-f0-9]{12}$/);
});

test('document access fails closed outside the current open question', () => {
  const root = mkdtempSync('/tmp/munder-docs-');
  const result = readOperationalDocument({
    tasks: [task()], taskId: 'task-1', documentId: 'a'.repeat(24),
    documentRoot: root, redact: (value) => value,
  });
  assert.deepEqual(result, { ok: false, status: 404, error: 'document not found' });
});
