'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  applyHumanAnswer,
  buildOperationalSnapshot
} = loadTs('src/main/webhookOperations.ts');

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
