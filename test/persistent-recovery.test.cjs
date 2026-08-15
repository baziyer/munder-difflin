'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const loadTs = require('./load-ts.cjs');

const {
  choosePersistentRecoverySession,
  parsePersistentRecoveryRequest,
  planPersistentRecovery,
  tokenizeSavedCommand
} = loadTs('src/main/persistentRecovery.ts');
const { PtyManager } = loadTs('src/main/pty.ts');

test('Michael is told how to authorize the exact legacy blank-session exception', () => {
  const hiveSource = readFileSync(require.resolve('../src/main/hive.ts'), 'utf8');
  assert.match(hiveSource, /LEGACY BLANK EXCEPTION/);
  assert.match(hiveSource, /"blankAssignment"/);
  assert.match(hiveSource, /SHA-256 of the exact unread JSON bytes/);
});

const recipe = {
  id: 'oscar-code-quality',
  name: 'Oscar',
  provider: 'codex',
  cwd: '/repo',
  worktreePath: '/repo-oscar',
  command: '/opt/codex --model "gpt 5" --flag',
  ptyId: 'oscar-code-quality',
  description: 'quality worker'
};

const registry = {
  godId: 'god',
  agents: {
    god: { id: 'god', name: 'Michael', sessionId: 'god-session' },
    'oscar-code-quality': {
      id: 'oscar-code-quality',
      name: 'Oscar',
      provider: 'codex',
      sessionId: 'session-123',
      archived: false,
      standingHire: true
    }
  }
};

function request(overrides = {}) {
  return {
    spec: 'munder-difflin/recover@1',
    id: 'recover-oscar-1',
    agentId: 'oscar-code-quality',
    expectedSessionId: 'session-123',
    reason: 'Unread concrete dispatch for 45 minutes after one redelivery.',
    ...overrides
  };
}

test('parsePersistentRecoveryRequest requires a scoped same-session request', () => {
  assert.deepEqual(parsePersistentRecoveryRequest(request()), { ok: true, request: request() });
  assert.match(parsePersistentRecoveryRequest(request({ expectedSessionId: '' })).error, /expectedSessionId/);
  assert.match(parsePersistentRecoveryRequest(request({ agentId: '../god' })).error, /agentId/);
  assert.match(parsePersistentRecoveryRequest(request({ reason: '' })).error, /reason/);
  assert.match(parsePersistentRecoveryRequest(request({ blankAssignment: { id: 'standing-hire-1', sha256: 'bad' } })).error, /SHA-256/);
  assert.match(parsePersistentRecoveryRequest({ ...request(), spec: 'anything' }).error, /spec/);
  const blankAssignment = { id: 'standing-hire-stanley-1', sha256: 'a'.repeat(64) };
  assert.deepEqual(
    parsePersistentRecoveryRequest(request({ blankAssignment })),
    { ok: true, request: request({ blankAssignment }) },
  );
});

test('planPersistentRecovery restarts a live saved agent without changing identity or worktree', () => {
  const parsed = parsePersistentRecoveryRequest(request());
  assert.equal(parsed.ok, true);
  const plan = planPersistentRecovery({
    request: parsed.request,
    registry,
    roster: { version: 1, agents: [recipe], archived: [], restorable: [] },
    livePtyOwners: new Map([['oscar-code-quality', 'oscar-code-quality']])
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, 'restart');
  assert.equal(plan.recipe.id, 'oscar-code-quality');
  assert.equal(plan.recipe.worktreePath, '/repo-oscar');
  assert.equal(plan.recipe.standingHire, true);
  assert.equal(plan.sessionId, 'session-123');
});

test('planPersistentRecovery restores an archived recipe with the same recorded session', () => {
  const plan = planPersistentRecovery({
    request: request(),
    registry: {
      ...registry,
      agents: {
        ...registry.agents,
        'oscar-code-quality': { ...registry.agents['oscar-code-quality'], archived: true }
      }
    },
    roster: { version: 1, agents: [], archived: [recipe], restorable: [] },
    livePtyOwners: new Map()
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, 'restore');
  assert.equal(plan.recipe.ptyId, 'oscar-code-quality');
  assert.equal(plan.recipe.standingHire, true);

  const legacy = planPersistentRecovery({
    request: request(),
    registry,
    roster: { version: 1, agents: [{ ...recipe, ptyId: undefined }], archived: [], restorable: [] },
    livePtyOwners: new Map()
  });
  assert.equal(legacy.recipe.ptyId, 'pty-oscar-code-quality');
});

test('a standing Claude hire with no transcript and an unread approved assignment restarts fresh', () => {
  assert.equal(choosePersistentRecoverySession({
    provider: 'claude',
    standingHire: true,
    transcriptExists: false,
    unreadStandingAssignment: true,
    firstTurnConfirmed: undefined,
    explicitLegacyBlank: true
  }), 'fresh-bootstrap');

  // A fresh-session fallback is deliberately much narrower than ordinary
  // recovery. Any evidence of prior work, another provider, or a non-standing
  // identity keeps the exact-session resume requirement.
  for (const input of [
    { provider: 'claude', standingHire: true, transcriptExists: true, unreadStandingAssignment: true, explicitLegacyBlank: true },
    { provider: 'claude', standingHire: true, transcriptExists: false, unreadStandingAssignment: false, explicitLegacyBlank: true },
    { provider: 'claude', standingHire: true, transcriptExists: false, unreadStandingAssignment: true, explicitLegacyBlank: false },
    { provider: 'claude', standingHire: true, transcriptExists: false, unreadStandingAssignment: true, firstTurnConfirmed: true, explicitLegacyBlank: true },
    { provider: 'codex', standingHire: true, transcriptExists: false, unreadStandingAssignment: true, explicitLegacyBlank: true },
    { provider: 'claude', standingHire: false, transcriptExists: false, unreadStandingAssignment: true, explicitLegacyBlank: true }
  ]) {
    assert.equal(choosePersistentRecoverySession(input), 'resume');
  }
});

test('planPersistentRecovery fails closed for god, ephemeral workers, stale sessions and missing recipes', () => {
  const base = { registry, roster: { version: 1, agents: [recipe], archived: [], restorable: [] }, livePtyOwners: new Map() };
  assert.match(planPersistentRecovery({ ...base, request: request({ agentId: 'god', expectedSessionId: 'god-session' }) }).error, /orchestrator/);
  assert.match(planPersistentRecovery({ ...base, request: request({ agentId: 'worker-temp' }) }).error, /ephemeral/);
  assert.match(planPersistentRecovery({ ...base, request: request({ expectedSessionId: 'stale-session' }) }).error, /session changed/);
  assert.match(planPersistentRecovery({ ...base, roster: { version: 1, agents: [], archived: [], restorable: [] }, request: request() }).error, /saved spawn recipe/);
  assert.match(planPersistentRecovery({
    ...base,
    livePtyOwners: new Map([['oscar-code-quality', 'pam-cleanup']]),
    request: request()
  }).error, /belongs to a different agent/);
});

test('tokenizeSavedCommand preserves quoted model names and rejects unterminated quotes', () => {
  assert.deepEqual(tokenizeSavedCommand(recipe.command), ['/opt/codex', '--model', 'gpt 5', '--flag']);
  assert.deepEqual(tokenizeSavedCommand("codex --label 'Oscar QA'"), ['codex', '--label', 'Oscar QA']);
  assert.throws(() => tokenizeSavedCommand('codex --model "broken'), /unterminated/);
});

test('requestExit keeps the session registered until the relaunch handler observes exit', async (t) => {
  const manager = new PtyManager();
  t.after(() => manager.killAll());
  const id = `recovery-exit-${process.pid}-${Date.now()}`;
  const exited = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('exit handler was not called')), 8_000);
    manager.setExitHandler((exitedId) => {
      clearTimeout(timeout);
      resolve(exitedId);
    });
  });
  const spawned = manager.spawn({
    id,
    cwd: process.cwd(),
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)']
  }, null);
  assert.equal(spawned.ok, true);
  assert.equal(manager.requestExit(id).ok, true);
  assert.equal(await exited, id);
  assert.equal(manager.list().some((entry) => entry.id === id), false);
});
