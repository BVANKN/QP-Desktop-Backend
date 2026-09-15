import test from 'node:test';
import assert from 'node:assert/strict';
import { useTemporaryDataDir, startTestServer, readLatestCode, VALID_PASSWORD } from './helpers/test-server.js';
// Independent server/data also keeps these signups within normal rate limits.
const dataDir = useTemporaryDataDir();
const server = await startTestServer();
test.after(() => server.close());
async function registerUser(username) {
  const start = await server.call('POST', '/api/auth/signup/start', { name: 'Health test', username, email: `${username}@example.com`, password: VALID_PASSWORD, confirmPassword: VALID_PASSWORD, planId: 'pro' });
  assert.equal(start.status, 200);
  const verify = await server.call('POST', '/api/auth/signup/verify', { pendingId: start.body.pendingId, code: readLatestCode(dataDir) });
  assert.equal(verify.status, 200); return verify.body;
}
test('health is account-scoped and includes special connections without changing the normal list', async () => {
  const owner = await registerUser('healthowner');
  const other = await registerUser('healthother');
  const { ensureSharePointMcpConnection, listMcpConnections } = await import('../src/modules/mcp/connections.js');
  await ensureSharePointMcpConnection(owner.user.id);
  assert.equal((await listMcpConnections(owner.user.id)).length, 0);
  const mine = await server.call('GET', '/api/mcp/connection-health', undefined, { accessToken: owner.accessToken });
  assert.equal(mine.status, 200); assert.ok(mine.body.connections.some(row => row.kind === 'sharepoint'));
  const theirs = await server.call('GET', `/api/mcp/connection-health?userId=${owner.user.id}`, undefined, { accessToken: other.accessToken });
  assert.equal(theirs.status, 200);
  assert.equal(theirs.body.connections.some(row => row.kind === 'sharepoint'), false);
});
