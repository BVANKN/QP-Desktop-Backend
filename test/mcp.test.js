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

test('ChatGPT-compatible OAuth discovery, DCR, PKCE, refresh rotation, and MCP access work end to end', async () => {
  const session = await registerUser('mcpoauth', 'pro');
  const connection = await createConnection(session);
  const resource = connection.endpoint;

  const unauthenticatedProbe = await server.call('GET', new URL(resource).pathname + new URL(resource).search);
  assert.equal(unauthenticatedProbe.status, 401);
  assert.match(unauthenticatedProbe.headers.get('www-authenticate') || '', /resource_metadata="[^\"]+\.well-known\/oauth-protected-resource\/mcp\//);

  const protectedMetadata = await server.call('GET', `/.well-known/oauth-protected-resource/mcp/${encodeURIComponent(session.user.id)}/${encodeURIComponent(tenantId)}?connection_id=${encodeURIComponent(connection.connection.id)}`);
  assert.equal(protectedMetadata.status, 200, JSON.stringify(protectedMetadata.body));
  assert.equal(protectedMetadata.body.resource, resource);
  assert.deepEqual(protectedMetadata.body.authorization_servers, [server.baseUrl]);

  const serverMetadata = await server.call('GET', '/.well-known/oauth-authorization-server');
  assert.equal(serverMetadata.status, 200, JSON.stringify(serverMetadata.body));
  assert.deepEqual(serverMetadata.body.code_challenge_methods_supported, ['S256']);
  assert.ok(serverMetadata.body.scopes_supported.includes('offline_access'));

  const callback = 'https://chatgpt.com/connector/oauth/qp-test';
  const registered = await server.call('POST', '/oauth/register', {
    client_name: 'ChatGPT OAuth test',
    redirect_uris: [callback],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none'
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));

  const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authQuery = new URLSearchParams({
    response_type: 'code',
    client_id: registered.body.client_id,
    redirect_uri: callback,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'mcp:read mcp:write offline_access',
    resource,
    state: 'oauth-state-test'
  });
  const authorizePage = await fetch(`${server.baseUrl}/oauth/authorize?${authQuery}`);
  assert.equal(authorizePage.status, 200);
  const html = await authorizePage.text();
  const requestId = html.match(/name="requestId" value="([^"]+)"/)?.[1];
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(requestId && csrf, 'Authorization page did not include a protected transaction.');

  const approval = await fetch(`${server.baseUrl}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
    body: new URLSearchParams({
      requestId,
      csrf,
      decision: 'approve',
      identifier: 'mcpoauth',
      password: VALID_PASSWORD,
      connectionId: connection.connection.id
    })
  });
  assert.equal(approval.status, 302, await approval.text());
  const callbackUrl = new URL(approval.headers.get('location'));
  assert.equal(callbackUrl.searchParams.get('state'), 'oauth-state-test');
  const code = callbackUrl.searchParams.get('code');
  assert.ok(code);

  const tokenResponse = await fetch(`${server.baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: registered.body.client_id,
      redirect_uri: callback,
      code,
      code_verifier: verifier,
      resource
    })
  });
  const tokens = await tokenResponse.json();
  assert.equal(tokenResponse.status, 200, JSON.stringify(tokens));
  assert.match(tokens.access_token, /^qpoat\./);
  assert.match(tokens.refresh_token, /^qport\./);

  const initialized = await server.call('POST', new URL(resource).pathname + new URL(resource).search, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'ChatGPT test', version: '1' } }
  }, { headers: { Authorization: `Bearer ${tokens.access_token}`, 'MCP-Protocol-Version': '2025-11-25' } });
  assert.equal(initialized.status, 200, JSON.stringify(initialized.body));
  assert.equal(initialized.body.result.protocolVersion, '2025-11-25');

  const wrongAudience = await server.call('POST', new URL(resource).pathname, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list'
  }, { headers: { Authorization: `Bearer ${tokens.access_token}`, 'MCP-Protocol-Version': '2025-11-25' } });
  assert.equal(wrongAudience.status, 401, 'An access token must be bound to the exact MCP resource URI.');

  const refreshResponse = await fetch(`${server.baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: registered.body.client_id,
      refresh_token: tokens.refresh_token,
      resource
    })
  });
  const refreshed = await refreshResponse.json();
  assert.equal(refreshResponse.status, 200, JSON.stringify(refreshed));
  assert.notEqual(refreshed.refresh_token, tokens.refresh_token);

  const replayResponse = await fetch(`${server.baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: registered.body.client_id,
      refresh_token: tokens.refresh_token,
      resource
    })
  });
  assert.equal(replayResponse.status, 400);
  assert.equal((await replayResponse.json()).error, 'invalid_grant');

  const revokedAfterReplay = await server.call('POST', new URL(resource).pathname + new URL(resource).search, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/list'
  }, { headers: { Authorization: `Bearer ${refreshed.access_token}`, 'MCP-Protocol-Version': '2025-11-25' } });
  assert.equal(revokedAfterReplay.status, 401, 'Refresh-token replay must revoke the complete OAuth grant family.');
});

test('OAuth client registration rejects unsafe redirect URIs', async () => {
  const rejected = await server.call('POST', '/oauth/register', {
    client_name: 'Unsafe OAuth client',
    redirect_uris: ['http://attacker.example/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none'
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error, 'invalid_redirect_uri');
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
