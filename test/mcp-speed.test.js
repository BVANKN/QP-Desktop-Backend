import test from 'node:test';
import assert from 'node:assert/strict';
import { useTemporaryDataDir } from './helpers/test-server.js';
useTemporaryDataDir();
const { signalVersion, waitForSignal, notifySignal } = await import('../src/modules/mcp/signals.js');
const { fetchFiles } = await import('../src/modules/ide-codewriter/mcp/tools/shared.js');

test('notifications wake immediately and close the read/subscribe race without crossing scopes', async () => {
  const key = 'desktop:A', version = signalVersion(key);
  const waiting = waitForSignal(key, version, 10000);
  notifySignal('desktop:B');
  notifySignal(key);
  assert.equal(await waiting, signalVersion(key));
  const beforeRead = signalVersion(key);
  notifySignal(key); // completion between reading persistence and subscribing
  assert.equal(await waitForSignal(key, beforeRead, 10000), signalVersion(key));
  const controller = new AbortController();
  const idle = waitForSignal('desktop:C', signalVersion('desktop:C'), 10000, controller.signal);
  controller.abort();
  assert.equal(await idle, signalVersion('desktop:C'));
});

test('IDE simultaneous clean reads share one RPC; completed and dirty reads are not reused', async () => {
  let calls = 0, dirty = false;
  let release;
  const entry = { revision: 'revision-1', size: 4 };
  const workspace = { id: 'workspace-A', getFile: () => ({ ...entry, dirty }) };
  const agent = { request: async () => {
    calls++; await new Promise(resolve => { release = resolve; });
    return { files: [{ path: 'a.js', revision: entry.revision, content: 'text', dirty }] };
  } };
  const ctx = { contentCache: { get: () => null, set() {} } };
  const args = { workspace, agent, paths: ['a.js'] };
  const first = fetchFiles(ctx, args), second = fetchFiles(ctx, args);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  release(); const both = await Promise.all([first, second]);
  assert.equal(both[0][0].content, 'text'); assert.deepEqual(both[0], both[1]);
  const third = fetchFiles(ctx, args); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2); release(); await third;
  dirty = true;
  const releases = [];
  agent.request = async () => { calls++; await new Promise(resolve => releases.push(resolve)); return { files: [{ path: 'a.js', content: 'dirty', dirty: true }] }; };
  const reads = [fetchFiles(ctx, args), fetchFiles(ctx, args)];
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 4);
  releases.forEach(resolve => resolve()); await Promise.all(reads);
});

