'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const loadTs = require('./load-ts.cjs');

const {
  codexRemoteHomePath,
  codexRemoteEndpoint,
  codexRemoteSocketFits,
  ensureCodexRemoteHome,
  withCodexRemoteArgs,
  CODEX_REMOTE_SOCKET_MAX,
  CODEX_REMOTE_SOCKET_RELATIVE
} = loadTs('src/shared/codexRemote.ts');

test('Codex remote uses a short stable per-agent home', () => {
  const first = codexRemoteHomePath('/very/long/hive/agent/.codex', 'dev-1', '/tmp');
  const again = codexRemoteHomePath('/very/long/hive/agent/.codex', 'dev-1', '/tmp');
  const other = codexRemoteHomePath('/very/long/hive/agent/.codex', 'dev-2', '/tmp');
  assert.equal(first, again);
  assert.notEqual(first, other);
  assert.ok(first.length < 80);
  assert.match(codexRemoteEndpoint(first), /^unix:\/\/\/tmp\//);
});

test('the default durable root yields a socket within sun_path', () => {
  // The real hive home that failed with "path must be shorter than SUN_LEN".
  const realHome =
    '/Users/vyapakgoyal/Documents/HarnessAgents/hive/agents/dev2-mrxb3l43/.codex';
  const socket =
    codexRemoteHomePath(realHome, 'dev2-mrxb3l43') + '/' + CODEX_REMOTE_SOCKET_RELATIVE;
  assert.ok(
    socket.length < CODEX_REMOTE_SOCKET_MAX,
    `socket path is ${socket.length} bytes: ${socket}`
  );
  // …and shorter than the home it replaces, which the $TMPDIR version was not.
  assert.ok(socket.length < (realHome + '/' + CODEX_REMOTE_SOCKET_RELATIVE).length);
});

test('an over-long durable root is rejected instead of failing at bind time', () => {
  const tmpdirStyle = '/var/folders/v6/9f10q5d148z7bxdzhr22xl7r0000gn/T/munder-codex';
  assert.equal(codexRemoteSocketFits(codexRemoteHomePath('/h/.codex', 'a', tmpdirStyle)), false);
  assert.equal(codexRemoteSocketFits(codexRemoteHomePath('/h/.codex', 'a')), true);
});

test('the real Codex home is moved to the short path and linked back', () => {
  const root = mkdtempSync('/tmp/mdc-home-');
  const realHome = join(root, 'very', 'long', 'hive', 'agent', '.codex');
  const shortRoot = join(root, 'short');
  mkdirSync(realHome, { recursive: true });
  writeFileSync(join(realHome, 'session.json'), 'kept', 'utf8');

  const result = ensureCodexRemoteHome(realHome, 'agent-1', shortRoot);

  assert.equal(result.ok, true);
  assert.ok(result.ok && existsSync(join(result.home, 'session.json')));
  assert.ok(lstatSync(realHome).isSymbolicLink());
  assert.equal(readFileSync(join(realHome, 'session.json'), 'utf8'), 'kept');
  assert.equal(ensureCodexRemoteHome(realHome, 'agent-1', shortRoot).ok, true);
});

test('conflicting real and short homes fail closed without merging state', () => {
  const root = mkdtempSync('/tmp/mdc-conflict-');
  const realHome = join(root, 'agent', '.codex');
  const shortRoot = join(root, 'short');
  const shortHome = codexRemoteHomePath(realHome, 'agent-1', shortRoot);
  mkdirSync(realHome, { recursive: true });
  mkdirSync(shortHome, { recursive: true });
  writeFileSync(join(realHome, 'real.txt'), 'real', 'utf8');
  writeFileSync(join(shortHome, 'short.txt'), 'short', 'utf8');

  const result = ensureCodexRemoteHome(realHome, 'agent-1', shortRoot);

  assert.equal(result.ok, false);
  assert.equal(readFileSync(join(realHome, 'real.txt'), 'utf8'), 'real');
  assert.equal(readFileSync(join(shortHome, 'short.txt'), 'utf8'), 'short');
});

test('remote endpoint precedes both fresh and resumed Codex invocations', () => {
  const endpoint = 'unix:///tmp/munder-codex/a/app-server-control/app-server-control.sock';
  assert.deepEqual(
    withCodexRemoteArgs(['--model', 'gpt-5.6-sol', 'hello'], endpoint),
    ['--remote', endpoint, '--model', 'gpt-5.6-sol', 'hello']
  );
  assert.deepEqual(
    withCodexRemoteArgs(['resume', 'session-id', '--model', 'gpt-5.6-sol'], endpoint),
    ['--remote', endpoint, 'resume', 'session-id', '--model', 'gpt-5.6-sol']
  );
  assert.deepEqual(
    withCodexRemoteArgs(['--remote', endpoint, 'resume'], endpoint),
    ['--remote', endpoint, 'resume']
  );
});
