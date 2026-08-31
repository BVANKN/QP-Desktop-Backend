import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { useTemporaryDataDir, startTestServer, readLatestCode, VALID_PASSWORD } from './helpers/test-server.js';

const dataDir = useTemporaryDataDir();
const server = await startTestServer();
test.after(() => server.close());

async function register(username, planId) {
  const started = await server.call('POST', '/api/auth/signup/start', {
    name: `${username} account`, username, email: `${username}@example.com`,
    password: VALID_PASSWORD, confirmPassword: VALID_PASSWORD, planId
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const verified = await server.call('POST', '/api/auth/signup/verify', {
    pendingId: started.body.pendingId,
    code: readLatestCode(dataDir)
  });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  return verified.body;
}

async function authorize(session, bootstrap) {
  const callback = 'https://chatgpt.com/connector/oauth/qp-sharepoint-test';
  const client = await server.call('POST', '/oauth/register', {
    client_name: 'QP SharePoint test client', redirect_uris: [callback],
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none'
  });
  assert.equal(client.status, 201, JSON.stringify(client.body));
  const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({
    response_type: 'code', client_id: client.body.client_id, redirect_uri: callback,
    code_challenge: challenge, code_challenge_method: 'S256',
    scope: 'mcp:read mcp:write offline_access', resource: bootstrap.mcpUrl, state: 'sharepoint-state'
  });
  const page = await fetch(`${server.baseUrl}/oauth/authorize?${query}`);
  const html = await page.text();
  assert.equal(page.status, 200, html);
  assert.match(html, /Connect your SharePoint workspace/);
  assert.match(html, /No customer app registration is required/);
  const requestId = html.match(/name="requestId" value="([^"]+)"/)?.[1];
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  const retryPath = html.match(/name="retryPath" value="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
  const approved = await fetch(`${server.baseUrl}/oauth/authorize`, {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ requestId, csrf, retryPath, decision: 'approve', identifier: session.user.username, password: VALID_PASSWORD, connectionId: bootstrap.connection.id })
  });
  assert.equal(approved.status, 303, await approved.text());
  const code = new URL(approved.headers.get('location')).searchParams.get('code');
  const tokenResponse = await fetch(`${server.baseUrl}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.body.client_id, redirect_uri: callback, code, code_verifier: verifier, resource: bootstrap.mcpUrl })
  });
  const tokens = await tokenResponse.json();
  assert.equal(tokenResponse.status, 200, JSON.stringify(tokens));
  return tokens;
}

async function mcpCall(url, token, body) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'MCP-Protocol-Version': '2025-11-25' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

test('SharePoint MCP is Premium, OAuth-only, and needs no customer app registration', async () => {
  const free = await register('spmcpfree', 'free');
  const refused = await server.call('GET', '/api/mcp/sharepoint/bootstrap', undefined, { accessToken: free.accessToken });
  assert.equal(refused.status, 403);

  const premium = await register('spmcppro', 'pro');
  const boot = await server.call('GET', '/api/mcp/sharepoint/bootstrap', undefined, { accessToken: premium.accessToken });
  assert.equal(boot.status, 200, JSON.stringify(boot.body));
  assert.equal(boot.body.connection.kind, 'sharepoint');
  assert.equal(boot.body.connection.tenantId, 'sharepoint');
  assert.equal(boot.body.mcpUrl, `${server.baseUrl}/sharepoint/mcp/${encodeURIComponent(premium.user.id)}`);
  assert.equal(boot.body.sharePoint.appRegistrationRequired, false);
  assert.equal('apiKey' in boot.body, false);

  const metadata = await server.call('GET', `/.well-known/oauth-protected-resource/sharepoint/mcp/${encodeURIComponent(premium.user.id)}`);
  assert.equal(metadata.status, 200);
  assert.equal(metadata.body.resource, boot.body.mcpUrl);
  assert.equal(metadata.body.resource_name, 'Quicker Portal SharePoint MCP');
  assert.match(metadata.body.sharepoint_authentication, /no customer app registration required/);
});

test('SharePoint MCP exposes only SharePoint tools and executes through its desktop resource', async () => {
  const session = await register('spmcpagent', 'pro');
  const boot = await server.call('GET', '/api/mcp/sharepoint/bootstrap', undefined, { accessToken: session.accessToken });
  assert.equal(boot.status, 200, JSON.stringify(boot.body));
  const bootstrap = boot.body;
  const tokens = await authorize(session, bootstrap);

  const heartbeat = await server.call('POST', '/api/mcp/bridge/heartbeat', {
    tenantId: 'sharepoint', environmentId: 'sharepoint', environmentName: 'Project site',
    resourceKind: 'sharepoint', appVersion: '1.0.0', clientInstanceId: 'sp-desktop-test'
  }, { accessToken: session.accessToken });
  assert.equal(heartbeat.status, 200, JSON.stringify(heartbeat.body));

  const initialized = await mcpCall(bootstrap.mcpUrl, tokens.access_token, {
    jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'SharePoint test', version: '1' } }
  });
  assert.equal(initialized.response.status, 200, JSON.stringify(initialized.body));
  assert.equal(initialized.body.result.serverInfo.name, 'Quicker Portal SharePoint MCP');
  assert.match(initialized.body.result.instructions, /never ask for tenant IDs/i);

  const listed = await mcpCall(bootstrap.mcpUrl, tokens.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const names = listed.body.result.tools.map(tool => tool.name);
  assert.ok(names.length >= 18, JSON.stringify(names));
  assert.ok(names.every(name => name.includes('sharepoint')));
  assert.ok(names.includes('patch_sharepoint_file'));
  assert.ok(names.includes('update_sharepoint_list_item'));
  assert.ok(!names.includes('create_table'));

  const forbiddenCrossResource = await mcpCall(bootstrap.mcpUrl, tokens.access_token, {
    jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_tables', arguments: {} }
  });
  assert.match(forbiddenCrossResource.body.error.message, /Unknown tool/);

  const pendingCall = mcpCall(bootstrap.mcpUrl, tokens.access_token, {
    jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_sharepoint_connection', arguments: {} }
  });
  let claimed;
  for (let attempt = 0; attempt < 30 && !claimed; attempt += 1) {
    const jobs = await server.call('GET', '/api/mcp/bridge/jobs?tenantId=sharepoint&environmentId=sharepoint&clientInstanceId=sp-desktop-test&limit=1', undefined, { accessToken: session.accessToken });
    claimed = jobs.body.jobs?.[0];
    if (!claimed) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(claimed, 'SharePoint desktop job was not leased.');
  assert.equal(claimed.action, 'mcpSharePointStatus');
  const completed = await server.call('POST', `/api/mcp/bridge/jobs/${encodeURIComponent(claimed.id)}/complete`, {
    leaseToken: claimed.leaseToken,
    result: { ok: true, result: { connected: true, mode: 'browser-session', connectedSite: { displayName: 'Project site' }, appRegistrationRequired: false } }
  }, { accessToken: session.accessToken });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  const call = await pendingCall;
  assert.equal(call.body.result.isError, false, JSON.stringify(call.body));
  assert.equal(call.body.result.structuredContent.connected, true);
  assert.equal(call.body.result.structuredContent.appRegistrationRequired, false);
});
