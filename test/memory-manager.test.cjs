'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const loadTs = require('./load-ts.cjs');

const { MemoryManager } = loadTs('src/main/memory.ts');

function fixture(scriptBody, agentIds = ['angela']) {
  const root = mkdtempSync(join(tmpdir(), 'munder-memory-'));
  const home = join(root, 'office');
  for (const id of agentIds) {
    const dir = join(home, 'hive', 'agents', id);
    mkdirSync(join(dir, '.codex'), { recursive: true });
    writeFileSync(join(dir, 'memory.md'), `memory for ${id}`, 'utf8');
    writeFileSync(join(dir, '.codex', 'rollout.jsonl'), 'large private session', 'utf8');
  }
  const bin = join(root, 'mempalace');
  writeFileSync(bin, `#!/usr/bin/env node\n${scriptBody}\n`, 'utf8');
  chmodSync(bin, 0o755);
  const manager = new MemoryManager(() => home, () => ({ enabled: true, model: 'minilm' }));
  manager.binCache = bin;
  return { root, home, manager };
}

test('stop terminates the active mine and immediately runs the restarted pass', async (t) => {
  const { root, manager } = fixture("require('node:fs').appendFileSync(process.env.INVOCATIONS, 'mine\\n'); process.stderr.write('started\\n'); setInterval(() => {}, 1000)");
  process.env.INVOCATIONS = join(root, 'invocations.log');
  t.after(() => {
    manager.stop();
    delete process.env.INVOCATIONS;
  });
  const pass = manager.mineNow();
  const startedBy = Date.now() + 2_000;
  while (!existsSync(process.env.INVOCATIONS) && Date.now() < startedBy) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(readFileSync(process.env.INVOCATIONS, 'utf8'), 'mine\n');

  manager.stop();
  manager.start();
  await Promise.race([
    pass,
    new Promise((_, reject) => setTimeout(() => reject(new Error('mine child survived stop')), 2000)),
  ]);

  const restartedBy = Date.now() + 2_000;
  while ((!existsSync(process.env.INVOCATIONS)
    || readFileSync(process.env.INVOCATIONS, 'utf8').split('mine\n').length - 1 < 2)
    && Date.now() < restartedBy) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(readFileSync(process.env.INVOCATIONS, 'utf8'), 'mine\nmine\n');
  manager.stop();
  assert.equal(manager.initStarted, false);
});

test('writer-lock contention stops the pass instead of hammering every agent', async () => {
  const { root, manager } = fixture(
    "require('node:fs').appendFileSync(process.env.INVOCATIONS, 'mine\\n'); process.stderr.write('palace writer lock held by PID 123\\n'); process.exit(1)",
    ['angela', 'oscar'],
  );
  process.env.INVOCATIONS = join(root, 'invocations.log');

  await manager.mineNow();

  assert.equal(readFileSync(process.env.INVOCATIONS, 'utf8'), 'mine\n');
  delete process.env.INVOCATIONS;
});

test('mining excludes per-agent Codex session state', async () => {
  const { home, manager } = fixture('process.exit(0)');

  await manager.mineNow();

  const ignore = readFileSync(join(home, 'hive', 'agents', 'angela', '.gitignore'), 'utf8');
  assert.match(ignore, /^\.codex\/$/m);
  assert.ok(existsSync(join(home, 'hive', 'agents', 'angela', '.codex', 'rollout.jsonl')));
});
