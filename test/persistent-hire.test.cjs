'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  PERSISTENT_HIRE_SPEC,
  classifyPersistentHireEnvelope,
  parsePersistentHireRequest,
  persistentHireAssignmentId,
  persistentHireControlCwd,
  planPersistentHire,
  persistentHireApprovalDigest,
  protectPersistentHireRosterWrite
} = loadTs('src/main/persistentHire.ts');
const { signHumanAnswerReceipt } = loadTs('src/main/humanAnswerReceipt.ts');

const WEBHOOK_SECRET = 'test-webhook-secret';

const manifest = {
  spec: 'munder-difflin/hire@1',
  name: 'Stanley',
  description: 'Thermal bridge programme owner',
  goal: 'Plan the thinnest browser/WASM slice, then wait for approval.',
  provider: 'claude',
  model: 'sonnet',
  capabilities: ['rust', 'wasm'],
  isolate: false,
  tokenCap: 500000
};

function request(overrides = {}) {
  return {
    spec: PERSISTENT_HIRE_SPEC,
    id: 'hire-stanley-20260815',
    agentId: 'stanley-thermal-bridge',
    cwd: '/repo',
    approval: {
      taskId: 'thermal-bridge-solver-browser-ux-programme',
      answeredAt: '2026-08-15T16:07:20.360Z'
    },
    objective: 'Read the standing charter and complete milestone zero.',
    manifest,
    ...overrides
  };
}

const baseParsed = parsePersistentHireRequest(request());
assert.equal(baseParsed.ok, true);
const approvedQuestion = {
  q: `Approve hire Stanley as stanley-thermal-bridge in /repo using claude model sonnet with isolate off and token cap 500000? payload sha256:${persistentHireApprovalDigest(baseParsed.request)}`,
  a: 'This works, implement please.',
  answeredAt: '2026-08-15T16:07:20.360Z',
  answerSource: 'webhook',
  answerEndpointId: 'minerva'
};
approvedQuestion.answerReceipt = signHumanAnswerReceipt(WEBHOOK_SECRET, {
  taskId: 'thermal-bridge-solver-browser-ux-programme',
  question: approvedQuestion.q,
  answer: approvedQuestion.a,
  answeredAt: approvedQuestion.answeredAt,
  endpointId: approvedQuestion.answerEndpointId
});

const approvalTasks = [{
  id: 'thermal-bridge-solver-browser-ux-programme',
  assignee: 'stanley-thermal-bridge',
  humanQA: [approvedQuestion]
}];

test('parsePersistentHireRequest requires a task-answer approval reference and validated hire manifest', () => {
  assert.equal(classifyPersistentHireEnvelope(request()), 'current');
  assert.equal(classifyPersistentHireEnvelope({ ...request(), spec: 'munder-difflin/persistent-hire@2' }), 'unknown');
  assert.equal(classifyPersistentHireEnvelope({ spec: 'legacy-worker' }), 'none');
  const parsed = parsePersistentHireRequest(request());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.request.agentId, 'stanley-thermal-bridge');
  assert.equal(parsed.request.manifest.name, 'Stanley');

  assert.match(parsePersistentHireRequest(request({ approval: {} })).error, /approval/);
  assert.match(parsePersistentHireRequest(request({ agentId: '../stanley' })).error, /agentId/);
  assert.match(parsePersistentHireRequest(request({ cwd: 'relative/repo' })).error, /absolute/);
  assert.match(parsePersistentHireRequest(request({ manifest: { ...manifest, provider: 'custom' } })).error, /manifest/);
  assert.match(parsePersistentHireRequest(request({ manifest: { ...manifest, model: undefined } })).error, /explicitly set/);
  assert.match(parsePersistentHireRequest(request({ manifest: { ...manifest, isolate: undefined } })).error, /explicitly set/);
  assert.match(parsePersistentHireRequest(request({
    manifest: { ...manifest, commandFlags: ['--model', 'opus'] }
  })).error, /cannot override/);
  assert.match(parsePersistentHireRequest({ ...request(), spec: 'anything' }).error, /spec/);
});

test('standing identities start in a safe app-data control workspace, never the approved repo', () => {
  assert.equal(
    persistentHireControlCwd('/Users/test/Library/Application Support/Munder', 'stanley-thermal-bridge'),
    '/Users/test/Library/Application Support/Munder/standing-workers/stanley-thermal-bridge'
  );
  assert.equal(persistentHireControlCwd('relative', 'stanley'), null);
  assert.equal(persistentHireControlCwd('/Users/test/Munder', '../escape'), null);
});

test('standing assignment retries derive monotonically from durable mailbox history', () => {
  const base = 'standing-hire-hire-stanley-20260815';
  assert.equal(persistentHireAssignmentId(base, [], false), base);
  assert.equal(persistentHireAssignmentId(base, [{ id: base, handled: false }], false), base);
  assert.equal(persistentHireAssignmentId(base, [{ id: base, handled: true }], true), base);
  assert.equal(persistentHireAssignmentId(base, [
    { id: base, handled: true },
    { id: `${base}-retry-1`, handled: true },
    { id: `${base}-retry-2`, handled: false },
  ], false), `${base}-retry-2`);
  assert.equal(persistentHireAssignmentId(base, [
    { id: base, handled: true },
    { id: `${base}-retry-1`, handled: true },
    { id: `${base}-retry-2`, handled: true },
  ], false), `${base}-retry-3`);
});

test('planPersistentHire creates one durable standing-agent recipe from local provider configuration', () => {
  const parsed = parsePersistentHireRequest(request());
  assert.equal(parsed.ok, true);
  const plan = planPersistentHire({
    request: parsed.request,
    registry: { godId: 'god', agents: {} },
    roster: { version: 1, agents: [], archived: [], restorable: [] },
    livePtyOwners: new Map(),
    tasks: approvalTasks,
    approvalSecrets: new Map([['minerva', WEBHOOK_SECRET]]),
    defaultCommand: 'claude',
    autoMode: true
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.recipe.id, 'stanley-thermal-bridge');
  assert.equal(plan.recipe.ptyId, 'pty-stanley-thermal-bridge');
  assert.equal(plan.recipe.executable, 'claude');
  assert.deepEqual(plan.recipe.args.slice(0, 2), ['--model', 'sonnet']);
  assert.equal(plan.recipe.args.includes('--permission-mode'), true);
  assert.equal(plan.recipe.args.includes('bypassPermissions'), true);
  assert.equal(plan.recipe.isolate, false);
  assert.equal(plan.recipe.goal, manifest.goal);
  assert.equal(plan.recipe.tokenCap, 500000);
});

test('planPersistentHire fails closed for reserved, existing, archived, or live identities', () => {
  const parsed = parsePersistentHireRequest(request());
  assert.equal(parsed.ok, true);
  const base = {
    request: parsed.request,
    registry: { godId: 'god', agents: {} },
    roster: { version: 1, agents: [], archived: [], restorable: [] },
    livePtyOwners: new Map(),
    tasks: approvalTasks,
    approvalSecrets: new Map([['minerva', WEBHOOK_SECRET]]),
    defaultCommand: 'claude',
    autoMode: true
  };
  assert.match(planPersistentHire({ ...base, request: { ...parsed.request, agentId: 'god' } }).error, /orchestrator/);
  assert.match(planPersistentHire({ ...base, request: { ...parsed.request, agentId: 'worker-temp' } }).error, /ephemeral/);
  assert.match(planPersistentHire({
    ...base,
    registry: { godId: 'god', agents: { 'stanley-thermal-bridge': { id: 'stanley-thermal-bridge' } } }
  }).error, /already exists.*recovery/i);
  assert.match(planPersistentHire({
    ...base,
    roster: { version: 1, agents: [], archived: [{ id: 'stanley-thermal-bridge' }], restorable: [] }
  }).error, /already exists.*recovery/i);
  assert.match(planPersistentHire({
    ...base,
    livePtyOwners: new Map([['pty-stanley-thermal-bridge', 'someone-else']])
  }).error, /PTY/);
  assert.match(planPersistentHire({
    ...base,
    maxStandingAgents: 1,
    registry: { godId: 'god', agents: { dwight: { id: 'dwight', archived: false } } }
  }).error, /limit/);
  assert.match(planPersistentHire({
    ...base,
    request: { ...parsed.request, manifest: { ...parsed.request.manifest, isolate: true } }
  }).error, /task-specific worktree/);
});

test('planPersistentHire rejects forged, stale, negative, or differently-scoped approvals', () => {
  const parsed = parsePersistentHireRequest(request());
  assert.equal(parsed.ok, true);
  const base = {
    request: parsed.request,
    registry: { godId: 'god', agents: {} },
    roster: { version: 1, agents: [], archived: [], restorable: [] },
    livePtyOwners: new Map(),
    tasks: approvalTasks,
    approvalSecrets: new Map([['minerva', WEBHOOK_SECRET]]),
    defaultCommand: 'claude',
    autoMode: true
  };
  assert.match(planPersistentHire({ ...base, tasks: [] }).error, /approval task/);
  assert.match(planPersistentHire({
    ...base,
    tasks: [{ ...approvalTasks[0], assignee: 'another-agent' }]
  }).error, /assignee/);
  const denied = { ...approvalTasks[0].humanQA[0], a: 'No' };
  denied.answerReceipt = signHumanAnswerReceipt(WEBHOOK_SECRET, {
    taskId: approvalTasks[0].id,
    question: denied.q,
    answer: denied.a,
    answeredAt: denied.answeredAt,
    endpointId: denied.answerEndpointId
  });
  assert.match(planPersistentHire({
    ...base,
    tasks: [{ ...approvalTasks[0], humanQA: [denied] }]
  }).error, /affirmative/);
  for (const qualifiedAnswer of ['Yes, use Opus instead of Sonnet', 'Approved, but use the shared checkout']) {
    const qualified = { ...approvalTasks[0].humanQA[0], a: qualifiedAnswer };
    qualified.answerReceipt = signHumanAnswerReceipt(WEBHOOK_SECRET, {
      taskId: approvalTasks[0].id,
      question: qualified.q,
      answer: qualified.a,
      answeredAt: qualified.answeredAt,
      endpointId: qualified.answerEndpointId
    });
    assert.match(planPersistentHire({
      ...base,
      tasks: [{ ...approvalTasks[0], humanQA: [qualified] }]
    }).error, /unqualified affirmative/);
  }
  assert.match(planPersistentHire({
    ...base,
    tasks: [{ ...approvalTasks[0], humanQA: [{ ...approvalTasks[0].humanQA[0], q: 'Approve some unrelated cleanup?' }] }]
  }).error, /receipt/);
  assert.match(planPersistentHire({
    ...base,
    tasks: [{ ...approvalTasks[0], humanQA: [{ ...approvalTasks[0].humanQA[0], answerReceipt: undefined }] }]
  }).error, /authenticated human-answer/);

  const desktop = {
    ...approvalTasks[0].humanQA[0],
    answerSource: 'desktop',
    answerEndpointId: 'desktop-ask-me'
  };
  desktop.answerReceipt = signHumanAnswerReceipt(WEBHOOK_SECRET, {
    taskId: approvalTasks[0].id,
    question: desktop.q,
    answer: desktop.a,
    answeredAt: desktop.answeredAt,
    endpointId: desktop.answerEndpointId
  });
  assert.equal(planPersistentHire({
    ...base,
    tasks: [{ ...approvalTasks[0], humanQA: [desktop] }],
    approvalSecrets: new Map([['desktop-ask-me', WEBHOOK_SECRET]])
  }).ok, true);
});

test('provider command is local and manifest flags remain argv, never executable input', () => {
  const codexRequest = request({
    manifest: {
      ...manifest,
      provider: 'codex',
      model: 'gpt-5.6-terra',
      commandFlags: ['--verbose']
    }
  });
  const parsed = parsePersistentHireRequest(codexRequest);
  assert.equal(parsed.ok, true);
  const codexApprovalTasks = [{
    ...approvalTasks[0],
    humanQA: [{
      ...approvalTasks[0].humanQA[0],
      q: `Approve hire Stanley as stanley-thermal-bridge in /repo using codex model gpt-5.6-terra with isolate off and --verbose? payload sha256:${persistentHireApprovalDigest(parsed.request)}`
    }]
  }];
  codexApprovalTasks[0].humanQA[0].answerReceipt = signHumanAnswerReceipt(WEBHOOK_SECRET, {
    taskId: codexApprovalTasks[0].id,
    question: codexApprovalTasks[0].humanQA[0].q,
    answer: codexApprovalTasks[0].humanQA[0].a,
    answeredAt: codexApprovalTasks[0].humanQA[0].answeredAt,
    endpointId: codexApprovalTasks[0].humanQA[0].answerEndpointId
  });
  const plan = planPersistentHire({
    request: parsed.request,
    registry: { godId: 'god', agents: {} },
    roster: { version: 1, agents: [], archived: [], restorable: [] },
    livePtyOwners: new Map(),
    tasks: codexApprovalTasks,
    approvalSecrets: new Map([['minerva', WEBHOOK_SECRET]]),
    defaultCommand: '/tmp/attacker-command --flag',
    autoMode: true
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.recipe.executable, 'codex');
  assert.equal(plan.recipe.args.includes('--verbose'), true);
  assert.equal(plan.recipe.command.startsWith('codex '), true);
  assert.equal(plan.recipe.command.includes('/tmp/attacker-command'), false);

  const claudePlan = planPersistentHire({
    request: baseParsed.request,
    registry: { godId: 'god', agents: {} },
    roster: { version: 1, agents: [], archived: [], restorable: [] },
    livePtyOwners: new Map(),
    tasks: approvalTasks,
    approvalSecrets: new Map([['minerva', WEBHOOK_SECRET]]),
    defaultCommand: 'codex --dangerously-bypass-approvals-and-sandbox',
    autoMode: true
  });
  assert.match(claudePlan.error, /approved Claude provider/);
});

test('stale renderer writes cannot erase or resurrect a standing-hire transaction marker', () => {
  const pending = { id: 'stanley', standingHire: true, standingHireRequestId: 'hire-stanley' };
  const current = {
    version: 1,
    agents: [pending],
    archived: [],
    restorable: [],
    queues: {},
    selectedId: 'stanley'
  };
  const protectedWrite = protectPersistentHireRosterWrite({
    incoming: { ...current, agents: [{ id: 'dwight' }] },
    current,
    registry: { agents: {} },
    requestQueued: (id) => id === 'hire-stanley'
  });
  assert.deepEqual(protectedWrite.agents, [{ id: 'dwight' }, pending]);

  const staleWrite = protectPersistentHireRosterWrite({
    incoming: current,
    current: { ...current, agents: [{ id: 'stanley', standingHire: true }] },
    registry: { agents: { stanley: { id: 'stanley', standingHire: true } } },
    requestQueued: () => false
  });
  assert.deepEqual(staleWrite.agents, [{ id: 'stanley', standingHire: true }]);
});
