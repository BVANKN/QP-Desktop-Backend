import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { useTemporaryDataDir, startTestServer, readLatestCode, VALID_PASSWORD } from './helpers/test-server.js';

const dataDir = useTemporaryDataDir();
const server = await startTestServer();
const tenantId = '11111111-2222-3333-4444-555555555555';
const environmentId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

test.after(() => server.close());

async function registerUser(username, planId) {
  const started = await server.call('POST', '/api/auth/signup/start', {
    name: 'MCP Tester',
    username,
    email: `${username}@example.com`,
    password: VALID_PASSWORD,
    confirmPassword: VALID_PASSWORD,
    planId
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const verified = await server.call('POST', '/api/auth/signup/verify', {
    pendingId: started.body.pendingId,
    code: readLatestCode(dataDir)
  });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  return verified.body;
}


test('desktop notification endpoint authenticates and ignores caller-supplied identity', async () => {
  const { signalVersion, notifySignal } = await import('../src/modules/mcp/signals.js');
  const session = await registerUser('mcpwakepro', 'pro');
  const denied = await server.call('POST', '/api/mcp/bridge/wait', {});
  assert.equal(denied.status, 401);
  notifySignal('desktop:someone-else');
  const initial = await server.call('POST', '/api/mcp/bridge/wait', { userId: 'someone-else' }, { accessToken: session.accessToken });
  assert.equal(initial.status, 200);
  assert.equal(initial.body.version, signalVersion(`desktop:${session.user.id}`));
  assert.notEqual(initial.body.version, signalVersion('desktop:someone-else'));
  // Notify between cursor receipt and subscription: the next request must
  // return the new cursor immediately rather than wait for another job.
  notifySignal(`desktop:${session.user.id}`);
  const changed = await server.call('POST', '/api/mcp/bridge/wait', { after: initial.body.version }, { accessToken: session.accessToken });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.body.version, initial.body.version);
  const free = await registerUser('mcpwakefree', 'free');
  assert.equal((await server.call('POST', '/api/mcp/bridge/wait', {}, { accessToken: free.accessToken })).status, 403);
});
