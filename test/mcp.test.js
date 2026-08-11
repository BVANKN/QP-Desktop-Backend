import test from 'node:test';
import assert from 'node:assert/strict';
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

async function createConnection(session) {
  const created = await server.call('POST', '/api/mcp/connections', {
    name: 'Automated MCP test',
    tenantId,
    tenantName: 'Test tenant',
    environmentId,
    environmentName: 'Test environment',
    captureMode: 'metadata'
  }, { accessToken: session.accessToken });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.match(created.body.apiKey, /^qpmcp\.mcp_/);
  return created.body;
}

function mcpCall(session, connection, method, params, id = 1, tenant = tenantId) {
  return server.call('POST', `/mcp/${encodeURIComponent(session.user.id)}/${encodeURIComponent(tenant)}`, {
    jsonrpc: '2.0', id, method, ...(params ? { params } : {})
  }, { headers: { Authorization: `Bearer ${connection.apiKey}`, 'MCP-Protocol-Version': '2025-11-25' } });
}

test('free users cannot create MCP connections', async () => {
  const session = await registerUser('mcpfree', 'free');
  const result = await server.call('POST', '/api/mcp/connections', { tenantId, environmentId }, { accessToken: session.accessToken });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'MCP_PLAN_REQUIRED');
});

test('Pro users can initialize MCP and discover the governed tool catalog', async () => {
  const session = await registerUser('mcppro', 'pro');
  assert.ok(session.entitlements.includes('mcp.server'));
  const connection = await createConnection(session);

  const initialized = await mcpCall(session, connection, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(initialized.status, 200, JSON.stringify(initialized.body));
  assert.equal(initialized.body.result.protocolVersion, '2025-11-25');

  const tools = await mcpCall(session, connection, 'tools/list');
  assert.equal(tools.status, 200, JSON.stringify(tools.body));
  assert.ok(tools.body.result.tools.length >= 70);
  assert.ok(tools.body.result.tools.some(tool => tool.name === 'query_records'));
  assert.ok(tools.body.result.tools.some(tool => tool.name === 'update_form'));
  assert.ok(tools.body.result.tools.some(tool => tool.name === 'register_plugin_artifact'));
});

test('MCP keys are tenant-scoped and invalid keys advertise protected-resource metadata', async () => {
  const session = await registerUser('mcpscope', 'pro');
  const connection = await createConnection(session);
  const wrongTenant = await mcpCall(session, connection, 'tools/list', undefined, 1, '99999999-2222-3333-4444-555555555555');
  assert.equal(wrongTenant.status, 401);
  assert.match(wrongTenant.headers.get('www-authenticate') || '', /\.well-known\/oauth-protected-resource/);
});

test('tool validation occurs before dispatch and offline desktop state is explicit', async () => {
  const session = await registerUser('mcpdispatch', 'pro');
  const connection = await createConnection(session);

  const invalid = await mcpCall(session, connection, 'tools/call', { name: 'delete_record', arguments: { tableLogicalName: 'account', recordId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', confirm: false } });
  assert.equal(invalid.status, 200);
  assert.equal(invalid.body.error.code, -32602);

  const offline = await mcpCall(session, connection, 'tools/call', { name: 'list_tables', arguments: {} });
  assert.equal(offline.status, 200);
  assert.equal(offline.body.error.code, -32002);
  assert.match(offline.body.error.message, /desktop is offline/i);
});

test('tool calls traverse the desktop broker and become environment-scoped analytics', async () => {
  const session = await registerUser('mcpbridge', 'pro');
  const connection = await createConnection(session);
  const clientInstanceId = 'mcp-test-desktop';
  const heartbeat = await server.call('POST', '/api/mcp/bridge/heartbeat', {
    tenantId,
    environmentId,
    environmentName: 'Test environment',
    clientInstanceId,
    appVersion: 'test'
  }, { accessToken: session.accessToken });
  assert.equal(heartbeat.status, 200, JSON.stringify(heartbeat.body));

  const pendingCall = mcpCall(session, connection, 'tools/call', {
    name: 'query_records',
    arguments: { tableLogicalName: 'account', select: ['name', 'accountnumber'], top: 2 }
  });
  await new Promise(resolve => setTimeout(resolve, 40));
  const query = new URLSearchParams({ tenantId, environmentId, clientInstanceId, limit: '1' });
  const leased = await server.call('GET', `/api/mcp/bridge/jobs?${query}`, undefined, { accessToken: session.accessToken });
  assert.equal(leased.status, 200, JSON.stringify(leased.body));
  assert.equal(leased.body.jobs.length, 1);
  assert.equal(leased.body.jobs[0].action, 'mcpQueryRecords');

  const completed = await server.call('POST', `/api/mcp/bridge/jobs/${leased.body.jobs[0].id}/complete`, {
    leaseToken: leased.body.jobs[0].leaseToken,
    result: {
      ok: true,
      result: { value: [{ accountid: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff', name: 'Acme', accountnumber: 'A-100' }] }
    }
  }, { accessToken: session.accessToken });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));

  const response = await pendingCall;
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.result.isError, false);
  assert.equal(response.body.result.structuredContent.value[0].name, 'Acme');

  const analytics = await server.call('GET', `/api/mcp/analytics?tenantId=${tenantId}&environmentId=${environmentId}`, undefined, { accessToken: session.accessToken });
  assert.equal(analytics.status, 200, JSON.stringify(analytics.body));
  assert.equal(analytics.body.analytics.summary.totalCalls, 1);
  assert.deepEqual(analytics.body.analytics.transmissions[0].tables, ['account']);
  assert.ok(analytics.body.analytics.transmissions[0].columns.includes('name'));
  assert.ok(analytics.body.analytics.transmissions[0].columns.includes('accountnumber'));
});
