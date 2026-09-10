import test from 'node:test';
import assert from 'node:assert/strict';
import { useTemporaryDataDir, startTestServer } from './helpers/test-server.js';
useTemporaryDataDir();
const server = await startTestServer();
const { JsonStore } = await import('../src/lib/json-store.js');
test.after(() => server.close());

test('credential lookup outages return retryable service errors across every MCP endpoint', async t => {
  const originalRead = JsonStore.prototype.read;
  t.mock.method(JsonStore.prototype, 'read', async function (...args) {
    if (this.filePath.endsWith('mcp/oauth-tokens.json')) throw new Error('Storage unavailable with private diagnostic details');
    return originalRead.apply(this, args);
  });
  for (const route of ['/mcp/user/tenant', '/sharepoint/mcp/user', '/powerpages/mcp/user/tenant', '/ide/mcp/user']) {
    const result = await server.call('GET', route, undefined, { headers: { Authorization: 'Bearer qpoat.grant.secret' } });
    assert.equal(result.status, 503, route);
    assert.equal(result.headers.get('www-authenticate'), null, 'An outage must not start a reconnect/consent flow.');
    assert.equal(result.headers.get('retry-after'), '5');
    assert.doesNotMatch(JSON.stringify(result.body), /private diagnostic/);
  }
});

test('missing credentials still produce the OAuth discovery challenge', async () => {
  for (const route of ['/mcp/user/tenant', '/sharepoint/mcp/user', '/powerpages/mcp/user/tenant', '/ide/mcp/user']) {
    const result = await server.call('GET', route);
    assert.equal(result.status, 401, route);
    assert.match(result.headers.get('www-authenticate'), /resource_metadata=/);
    assert.match(result.headers.get('www-authenticate'), /offline_access/);
  }
});
