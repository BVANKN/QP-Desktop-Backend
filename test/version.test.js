import test from 'node:test';
import assert from 'node:assert/strict';
import { readBuildInfo } from '../src/lib/build-info.js';
import { useTemporaryDataDir, startTestServer } from './helpers/test-server.js';

useTemporaryDataDir();
const commit = '1234567890abcdef1234567890abcdef12345678';

test('build identity uses the Render commit, not an unrelated override', () => {
  const info = readBuildInfo({ RENDER_GIT_COMMIT: commit.toUpperCase(), QP_BUILD_COMMIT: 'a'.repeat(40) });
  assert.equal(info.commit, commit);
  assert.equal(info.commitSource, 'render');
  assert.ok(Object.isFrozen(info));
});

test('non-Render deployments can supply an explicit build commit', () => {
  const info = readBuildInfo({ QP_BUILD_COMMIT: 'b'.repeat(64) });
  assert.equal(info.commit, 'b'.repeat(64));
  assert.equal(info.commitSource, 'QP_BUILD_COMMIT');
});

test('missing or malformed metadata stays unknown and does not leak configuration', () => {
  for (const raw of [undefined, '', 'abc123', 'secret-value', 'a'.repeat(41), 'z'.repeat(40)]) {
    const info = readBuildInfo({ RENDER_GIT_COMMIT: raw, MONGODB_URI: 'private-database', TOKEN: 'private-token' });
    assert.equal(info.commit, null);
    assert.equal(info.commitSource, null);
    assert.deepEqual(Object.keys(info).sort(), ['commit', 'commitSource', 'startedAt', 'version']);
    assert.equal(JSON.stringify(info).includes('private-'), false);
  }
});

test('version endpoint is public, uncached and reports effective OAuth lifetimes without touching storage', async () => {
  process.env.QP_MCP_OAUTH_ACCESS_TTL_SECONDS = '901';
  process.env.QP_MCP_OAUTH_REFRESH_TTL_SECONDS = '2592001';
  process.env.QP_MCP_OAUTH_REFRESH_RETRY_GRACE_SECONDS = '91';
  const server = await startTestServer();
  try {
    const first = await server.call('GET', '/api/version');
    const second = await server.call('GET', '/api/version');
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.equal(first.body.ok, true);
    assert.equal(first.body.service, 'qp-x-xrm-backend');
    const { buildInfo } = await import('../src/lib/build-info.js');
    for (const [key, value] of Object.entries(buildInfo)) assert.equal(first.body[key], value);
    assert.equal(second.body.startedAt, first.body.startedAt);
    assert.ok(Number.isFinite(Date.parse(first.body.time)));
    assert.ok(Number.isFinite(Date.parse(first.body.startedAt)));
    assert.deepEqual(first.body.mcpOAuth, {
      accessTtlSeconds: 901, refreshTtlSeconds: 2592001, refreshRetryGraceSeconds: 91
    });
    assert.deepEqual(Object.keys(first.body).sort(), [
      'commit', 'commitSource', 'mcpOAuth', 'ok', 'service', 'startedAt', 'time', 'version'
    ]);
    const fs = await import('node:fs');
    assert.deepEqual(fs.readdirSync(process.env.QP_BACKEND_DATA_DIR), []);
  } finally {
    await server.close();
  }
});
