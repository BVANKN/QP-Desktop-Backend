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

async function createConnection(session, captureMode = 'metadata', executionMode = 'verified') {
  const created = await server.call('POST', '/api/mcp/connections', {
    name: 'Automated MCP test',
    tenantId,
    tenantName: 'Test tenant',
    environmentId,
    environmentName: 'Test environment',
    captureMode,
    executionMode
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

async function collectToolPages(callPage) {
  const tools = [];
  const pageSizes = [];
  const cursors = new Set();
  let cursor;
  do {
    const response = await callPage(cursor);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(Array.isArray(response.body.result?.tools), JSON.stringify(response.body));
    const serializedBytes = Buffer.byteLength(JSON.stringify(response.body));
    assert.ok(serializedBytes < 52 * 1024, `Tool discovery page is too large: ${serializedBytes} bytes.`);
    tools.push(...response.body.result.tools);
    pageSizes.push(serializedBytes);
    cursor = response.body.result.nextCursor;
    if (cursor) {
      assert.equal(typeof cursor, 'string');
      assert.ok(!cursors.has(cursor), `Repeated pagination cursor: ${cursor}`);
      cursors.add(cursor);
    }
  } while (cursor);
  return { tools, pageSizes };
}

test('free users cannot create MCP connections', async () => {
  const session = await registerUser('mcpfree', 'free');
  const result = await server.call('POST', '/api/mcp/connections', { tenantId, environmentId }, { accessToken: session.accessToken });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'MCP_PLAN_REQUIRED');
  const health = await server.call('GET', '/api/mcp/connection-health', undefined, { accessToken: session.accessToken });
  assert.equal(health.status, 403);
  assert.equal((await server.call('GET', '/api/mcp/connection-health')).status, 401);
});

test('Pro users can initialize MCP and discover the governed tool catalog', async () => {
  const session = await registerUser('mcppro', 'pro');
  assert.ok(session.entitlements.includes('mcp.server'));
  const basic = await server.call('POST', '/api/mcp/connections', { tenantId, environmentId }, { accessToken: session.accessToken });
  assert.equal(basic.status, 201, JSON.stringify(basic.body));
  assert.equal(basic.body.connection.captureMode, 'metadata', 'business payloads require an explicit opt-in');
  const detailed = await server.call('POST', '/api/mcp/connections', { tenantId, environmentId, captureMode: 'detailed' }, { accessToken: session.accessToken });
  assert.equal(detailed.status, 201, JSON.stringify(detailed.body));
  assert.equal(detailed.body.connection.captureMode, 'detailed');
  const connection = await createConnection(session, 'metadata', 'autonomous');
  assert.equal(connection.connection.executionMode, 'autonomous');

  const initialized = await mcpCall(session, connection, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(initialized.status, 200, JSON.stringify(initialized.body));
  assert.equal(initialized.body.result.protocolVersion, '2025-11-25');

  let catalogRequestId = 10;
  const catalog = await collectToolPages(cursor => mcpCall(
    session,
    connection,
    'tools/list',
    cursor ? { cursor } : {},
    catalogRequestId++
  ));
  assert.ok(catalog.tools.length >= 80);
  assert.ok(catalog.pageSizes.length > 1, 'The large catalog must be paginated.');
  assert.equal(new Set(catalog.tools.map(tool => tool.name)).size, catalog.tools.length);
  assert.ok(catalog.tools.some(tool => tool.name === 'query_records'));
  assert.ok(catalog.tools.some(tool => tool.name === 'update_form'));
  assert.ok(catalog.tools.some(tool => tool.name === 'register_plugin_artifact'));
  assert.ok(catalog.tools.some(tool => tool.name === 'create_command_bar_control'));

  const invalidCursor = await mcpCall(session, connection, 'tools/list', { cursor: 'not-a-valid-cursor' }, 99);
  assert.equal(invalidCursor.status, 200);
  assert.equal(invalidCursor.body.error?.code, -32602);

  const listed = await server.call('GET', '/api/mcp/connections', undefined, { accessToken: session.accessToken });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.connections.find(item => item.id === connection.connection.id)?.executionMode, 'autonomous');

  const updated = await server.call('PUT', `/api/mcp/connections/${connection.connection.id}/execution-mode`, {
    executionMode: 'simple'
  }, { accessToken: session.accessToken });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.connection.executionMode, 'simple');

  const invalid = await server.call('PUT', `/api/mcp/connections/${connection.connection.id}/execution-mode`, {
    executionMode: 'fastest'
  }, { accessToken: session.accessToken });
  assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
  assert.equal(invalid.body.details?.field, 'executionMode');
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
  const authChallengeHeader = unauthenticatedProbe.headers.get('www-authenticate') || '';
  assert.match(authChallengeHeader, /resource_metadata="[^\"]+\.well-known\/oauth-protected-resource\/mcp\//);
  assert.match(
    authChallengeHeader,
    /scope="mcp:read mcp:write offline_access"/,
    'The initial connection must request every scope needed by the advertised tool catalog.'
  );

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
  const authorizationCsp = authorizePage.headers.get('content-security-policy') || '';
  assert.match(authorizationCsp, /form-action 'self' https:\/\/chatgpt\.com/);
  assert.doesNotMatch(authorizationCsp, /form-action \*/);
  const html = await authorizePage.text();
  const requestId = html.match(/name="requestId" value="([^"]+)"/)?.[1];
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  const retryPath = html.match(/name="retryPath" value="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
  assert.ok(requestId && csrf && retryPath, 'Authorization page did not include a protected recoverable transaction.');

  const wrongLogin = await fetch(`${server.baseUrl}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
    body: new URLSearchParams({
      requestId,
      csrf,
      retryPath,
      decision: 'approve',
      identifier: 'mcpoauth',
      password: 'wrong-password',
      connectionId: connection.connection.id
    })
  });
  const wrongLoginHtml = await wrongLogin.text();
  assert.equal(wrongLogin.status, 401);
  assert.match(wrongLoginHtml, /Invalid user name or password/);
  assert.doesNotMatch(wrongLoginHtml, /authorization request expired/i);

  const recovered = await fetch(`${server.baseUrl}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
    body: new URLSearchParams({ requestId: 'missing-request', csrf, retryPath, decision: 'approve' })
  });
  assert.equal(recovered.status, 303);
  assert.match(recovered.headers.get('location') || '', /^\/oauth\/authorize\?.*qp_retry=1/);
  const recoveredPage = await fetch(`${server.baseUrl}${recovered.headers.get('location')}`);
  assert.equal(recoveredPage.status, 200);
  assert.match(await recoveredPage.text(), /previous sign-in request was refreshed/i);

  const approval = await fetch(`${server.baseUrl}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
    body: new URLSearchParams({
      requestId,
      csrf,
      retryPath,
      decision: 'approve',
      identifier: 'mcpoauth',
      password: VALID_PASSWORD,
      connectionId: connection.connection.id
    })
  });
  assert.equal(approval.status, 303, await approval.text());
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
  const initialHealth = await server.call('GET', '/api/mcp/connection-health', undefined, { accessToken: session.accessToken });
  assert.equal(initialHealth.status, 200);
  assert.match(initialHealth.headers.get('cache-control'), /no-store/);
  assert.ok(initialHealth.body.connections.some(row => row.sessions.some(item => item.state === 'access_valid' && item.observedSince && !item.lastSuccessAt)));
  assert.doesNotMatch(JSON.stringify(initialHealth.body), /qpoat\.|qport\.|accessTokenHash|refreshTokenHash|sealed|clientInstanceId/);
  const forgedRefresh = await fetch(`${server.baseUrl}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: registered.body.client_id, refresh_token: `qport.${tokens.refresh_token.split('.')[1]}.wrong-secret`, resource })
  });
  assert.equal(forgedRefresh.status, 400);
  const afterForgery = await server.call('GET', '/api/mcp/connection-health', undefined, { accessToken: session.accessToken });
  assert.deepEqual(afterForgery.body.connections, initialHealth.body.connections, 'A forged token cannot poison another grant’s health.');

  const initialized = await server.call('POST', new URL(resource).pathname + new URL(resource).search, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'ChatGPT test', version: '1' } }
  }, { headers: { Authorization: `Bearer ${tokens.access_token}`, 'MCP-Protocol-Version': '2025-11-25' } });
  assert.equal(initialized.status, 200, JSON.stringify(initialized.body));
  assert.equal(initialized.body.result.protocolVersion, '2025-11-25');

  let oauthCatalogRequestId = 20;
  const listedCatalog = await collectToolPages(cursor => server.call(
    'POST',
    new URL(resource).pathname + new URL(resource).search,
    {
      jsonrpc: '2.0',
      id: oauthCatalogRequestId++,
      method: 'tools/list',
      params: cursor ? { cursor } : {}
    },
    { headers: { Authorization: `Bearer ${tokens.access_token}`, 'MCP-Protocol-Version': '2025-11-25' } }
  ));
  assert.ok(listedCatalog.tools.length >= 80);
  assert.ok(listedCatalog.pageSizes.length > 1);
  assert.ok(listedCatalog.tools.every(tool => tool.name && tool.description && tool.inputSchema?.type === 'object'));

  // Existing connectors may have been authorized before write tools were
  // advertised. Their reconnect challenge must request the complete durable
  // grant, rather than mcp:write alone, or ChatGPT will reconnect repeatedly.
  const readOnlyAuthQuery = new URLSearchParams(authQuery);
  readOnlyAuthQuery.set('scope', 'mcp:read');
  readOnlyAuthQuery.set('state', 'read-only-oauth-state');
  const readOnlyPage = await fetch(`${server.baseUrl}/oauth/authorize?${readOnlyAuthQuery}`);
  assert.equal(readOnlyPage.status, 200);
  const readOnlyHtml = await readOnlyPage.text();
  const readOnlyRequestId = readOnlyHtml.match(/name="requestId" value="([^"]+)"/)?.[1];
  const readOnlyCsrf = readOnlyHtml.match(/name="csrf" value="([^"]+)"/)?.[1];
  const readOnlyRetryPath = readOnlyHtml.match(/name="retryPath" value="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
  assert.ok(readOnlyRequestId && readOnlyCsrf && readOnlyRetryPath);

  const readOnlyApproval = await fetch(`${server.baseUrl}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
    body: new URLSearchParams({
      requestId: readOnlyRequestId,
      csrf: readOnlyCsrf,
      retryPath: readOnlyRetryPath,
      decision: 'approve',
      identifier: 'mcpoauth',
      password: VALID_PASSWORD,
      connectionId: connection.connection.id
    })
  });
  assert.equal(readOnlyApproval.status, 303, await readOnlyApproval.text());
  const readOnlyCode = new URL(readOnlyApproval.headers.get('location')).searchParams.get('code');
  assert.ok(readOnlyCode);

  const readOnlyTokenResponse = await fetch(`${server.baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: registered.body.client_id,
      redirect_uri: callback,
      code: readOnlyCode,
      code_verifier: verifier,
      resource
    })
  });
  const readOnlyTokens = await readOnlyTokenResponse.json();
  assert.equal(readOnlyTokenResponse.status, 200, JSON.stringify(readOnlyTokens));
  assert.equal(readOnlyTokens.refresh_token, undefined, 'Read-only authorization must not silently gain offline access.');

  const writeWithReadOnlyGrant = await server.call('POST', new URL(resource).pathname + new URL(resource).search, {
    jsonrpc: '2.0',
    id: 22,
    method: 'tools/call',
    params: { name: 'add_web_resource_to_form', arguments: {} }
  }, { headers: { Authorization: `Bearer ${readOnlyTokens.access_token}`, 'MCP-Protocol-Version': '2025-11-25' } });
  assert.equal(writeWithReadOnlyGrant.status, 403, JSON.stringify(writeWithReadOnlyGrant.body));
  assert.match(
    writeWithReadOnlyGrant.headers.get('www-authenticate') || '',
    /scope="mcp:read mcp:write offline_access"/,
    'Reconnect must upgrade an old read-only connector to the full durable grant.'
  );

  const wrongAudience = await server.call('POST', new URL(resource).pathname, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/list'
  }, { headers: { Authorization: `Bearer ${tokens.access_token}`, 'MCP-Protocol-Version': '2025-11-25' } });
  assert.equal(wrongAudience.status, 401, 'An access token must be bound to the exact MCP resource URI.');

  const wrongRefreshResource = await fetch(`${server.baseUrl}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: registered.body.client_id, refresh_token: tokens.refresh_token, resource: `${resource}/different-resource` })
  });
  assert.equal(wrongRefreshResource.status, 400);
  assert.equal((await wrongRefreshResource.json()).error, 'invalid_grant', 'Refresh cannot change the authorized resource.');

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
  const refreshedHealth = await server.call('GET', '/api/mcp/connection-health', undefined, { accessToken: session.accessToken });
  assert.ok(refreshedHealth.body.connections.some(row => row.sessions.some(item => item.lastResult === 'refreshed' && item.lastSuccessAt)));

  const overlappingCall = await server.call('GET', new URL(resource).pathname + new URL(resource).search, undefined,
    { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  assert.equal(overlappingCall.status, 405, 'An unexpired access token remains authenticated after refresh; GET advertises POST-only transport.');

  const { mutateOAuthGrant } = await import('../src/modules/mcp/oauth-store.js');
  await mutateOAuthGrant(tokens.access_token.split('.')[1], grant => {
    grant.previousAccessTokens.forEach(token => { token.expiresAt = Math.floor(Date.now() / 1000) - 1; });
    return { value: grant };
  });
  const expiredOverlap = await server.call('GET', new URL(resource).pathname + new URL(resource).search, undefined,
    { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  assert.equal(expiredOverlap.status, 401, 'Keeping a previous token must never extend its original expiry.');

  // A duplicate request from the same MCP client can happen when refreshes race
  // at access-token expiry or the first response is lost. Return the exact same
  // rotation instead of branching or revoking the connection.
  const retryResponse = await fetch(`${server.baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: registered.body.client_id,
      refresh_token: tokens.refresh_token,
      resource
    })
  });
  const retry = await retryResponse.json();
  assert.equal(retryResponse.status, 200, JSON.stringify(retry));
  assert.equal(retry.access_token, refreshed.access_token);
  assert.equal(retry.refresh_token, refreshed.refresh_token);

  // A retry the server cannot attribute is refused, but the session survives.
  // It used to be treated as proof of theft and revoked the grant, which ended
  // a live task: hosted MCP clients call from an egress pool, so an
  // unrecognised retry is routine rather than evidence of anything.
  const replayResponse = await fetch(`${server.baseUrl}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'different-mcp-refresh-client'
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: registered.body.client_id,
      refresh_token: tokens.refresh_token,
      resource
    })
  });
  assert.equal(replayResponse.status, 400);
  assert.equal((await replayResponse.json()).error, 'invalid_grant');

  const stillLive = await server.call('POST', new URL(resource).pathname + new URL(resource).search, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/list'
  }, { headers: { Authorization: `Bearer ${refreshed.access_token}`, 'MCP-Protocol-Version': '2025-11-25' } });
  assert.equal(stillLive.status, 200, 'an unattributable retry must not end a live session');
  const rejectedHealth = await server.call('GET', '/api/mcp/connection-health', undefined, { accessToken: session.accessToken });
  assert.ok(rejectedHealth.body.connections.some(row => row.sessions.some(item => item.lastResult === 'retry_client_unverified' && item.state !== 'revoked')));

  // Genuine reuse still revokes the whole family. Rotating a second time makes
  // the original token an old one rather than the just-rotated one, which is
  // the shape of an actual stolen token: not a retry of the newest rotation,
  // but a token from further back in the chain.
  const tokenForm = body => fetch(`${server.baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body)
  });
  const secondRotationResponse = await tokenForm({
    grant_type: 'refresh_token',
    client_id: registered.body.client_id,
    refresh_token: refreshed.refresh_token
  });
  assert.equal(secondRotationResponse.status, 200, 'Omitting the optional refresh resource preserves the originally bound resource.');
  const secondRotation = await secondRotationResponse.json();

  const reuse = await tokenForm({
    grant_type: 'refresh_token',
    client_id: registered.body.client_id,
    refresh_token: tokens.refresh_token,
    resource
  });
  assert.equal(reuse.status, 400);
  assert.equal((await reuse.json()).error, 'invalid_grant');

  const revokedAfterReuse = await server.call('POST', new URL(resource).pathname + new URL(resource).search, {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/list'
  }, { headers: { Authorization: `Bearer ${secondRotation.access_token}`, 'MCP-Protocol-Version': '2025-11-25' } });
  assert.equal(revokedAfterReuse.status, 401, 'reusing a superseded refresh token must revoke the complete grant family');
  const revokedHealth = await server.call('GET', '/api/mcp/connection-health', undefined, { accessToken: session.accessToken });
  assert.ok(revokedHealth.body.connections.some(row => row.sessions.some(item => item.revokedReason === 'refresh_token_reuse' && item.state === 'revoked')));
  const revokedPreviousAccess = await server.call('GET', new URL(resource).pathname + new URL(resource).search, undefined,
    { headers: { Authorization: `Bearer ${refreshed.access_token}` } });
  assert.equal(revokedPreviousAccess.status, 401, 'Revocation also rejects unexpired access tokens retained for overlapping calls.');
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
  assert.equal(offline.body.result.isError,true);
  assert.equal(offline.body.result.structuredContent.code,'DESKTOP_UNAVAILABLE');
  assert.equal(offline.body.result.structuredContent.dispatched,false);
  assert.match(offline.body.result.content[0].text,/No work was dispatched/);
});

test('first tool call waits for the heartbeat, then traverses the environment-scoped broker', async () => {
  const session = await registerUser('mcpbridge', 'pro');
  const connection = await createConnection(session, 'detailed', 'autonomous');
  const clientInstanceId = 'mcp-test-desktop';
  const pendingCall = mcpCall(session, connection, 'tools/call', {
    name: 'query_records',
    // A client cannot silently weaken the mode selected by the user in QP.
    arguments: { tableLogicalName: 'account', select: ['name', 'accountnumber'], top: 2, executionMode: 'simple' }
  });
  await new Promise(resolve => setTimeout(resolve, 40));
  const heartbeat = await server.call('POST', '/api/mcp/bridge/heartbeat', {
    userId: 'untrusted-body-cannot-override-authenticated-identity',
    tenantId,
    environmentId,
    environmentName: 'Test environment',
    clientInstanceId,
    appVersion: 'test'
  }, { accessToken: session.accessToken });
  assert.equal(heartbeat.status, 200, JSON.stringify(heartbeat.body));

  await new Promise(resolve => setTimeout(resolve, 40));
  const wrongEnvironmentQuery = new URLSearchParams({ tenantId, environmentId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', clientInstanceId, limit: '1' });
  const notLeased = await server.call('GET', `/api/mcp/bridge/jobs?${wrongEnvironmentQuery}`, undefined, { accessToken: session.accessToken });
  assert.equal(notLeased.status, 200, JSON.stringify(notLeased.body));
  assert.equal(notLeased.body.jobs.length, 0, 'a desktop must never claim a job for another environment');
  const query = new URLSearchParams({ tenantId, environmentId, clientInstanceId, limit: '1' });
  const leased = await server.call('GET', `/api/mcp/bridge/jobs?${query}`, undefined, { accessToken: session.accessToken });
  assert.equal(leased.status, 200, JSON.stringify(leased.body));
  assert.equal(leased.body.jobs.length, 1);
  assert.equal(leased.body.jobs[0].action, 'mcpQueryRecords');
  assert.equal(leased.body.jobs[0].executionMode, 'autonomous');
  assert.equal(Object.hasOwn(leased.body.jobs[0].arguments, 'executionMode'), false);

  const completed = await server.call('POST', `/api/mcp/bridge/jobs/${leased.body.jobs[0].id}/complete`, {
    userId: 'untrusted-user', jobId: 'untrusted-job',
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

  const pendingPreview = mcpCall(session, connection, 'tools/call', {
    name: 'preview_command_bar_change',
    arguments: {
      logicalName: 'account',
      solutionUniqueName: 'qp_unmanaged',
      operation: 'hide',
      mutation: { controlId: 'Mscrm.HomepageGrid.account.NewRecord', includeXml: false }
    }
  }, 44);
  await new Promise(resolve => setTimeout(resolve, 40));
  const previewLease = await server.call('GET', `/api/mcp/bridge/jobs?${query}`, undefined, { accessToken: session.accessToken });
  assert.equal(previewLease.status, 200, JSON.stringify(previewLease.body));
  assert.equal(previewLease.body.jobs.length, 1);
  assert.equal(previewLease.body.jobs[0].action, 'previewRibbonCommandChange');
  assert.deepEqual(previewLease.body.jobs[0].arguments, {
    logicalName: 'account',
    solutionUniqueName: 'qp_unmanaged',
    operation: 'hide',
    controlId: 'Mscrm.HomepageGrid.account.NewRecord',
    includeXml: false
  });
  const previewCompleted = await server.call('POST', `/api/mcp/bridge/jobs/${previewLease.body.jobs[0].id}/complete`, {
    leaseToken: previewLease.body.jobs[0].leaseToken,
    result: { ok: true, result: { valid: true } }
  }, { accessToken: session.accessToken });
  assert.equal(previewCompleted.status, 200, JSON.stringify(previewCompleted.body));
  const previewResponse = await pendingPreview;
  assert.equal(previewResponse.status, 200, JSON.stringify(previewResponse.body));
  assert.equal(previewResponse.body.result.structuredContent.valid, true);

  const analytics = await server.call('GET', `/api/mcp/analytics?tenantId=${tenantId}&environmentId=${environmentId}`, undefined, { accessToken: session.accessToken });
  assert.equal(analytics.status, 200, JSON.stringify(analytics.body));
  assert.equal(analytics.body.analytics.summary.totalCalls, 2);
  const queryTransmission = analytics.body.analytics.transmissions.find(item => item.toolName === 'query_records');
  assert.deepEqual(queryTransmission.tables, ['account']);
  assert.ok(queryTransmission.columns.includes('name'));
  assert.ok(queryTransmission.columns.includes('accountnumber'));
  assert.equal(queryTransmission.request, undefined, 'analytics list responses should omit detailed request payloads');
  assert.equal(queryTransmission.response, undefined, 'analytics list responses should omit detailed response payloads');
  const detail = await server.call('GET', `/api/mcp/analytics?tenantId=${tenantId}&environmentId=${environmentId}&transmissionId=${queryTransmission.id}&includePayloads=true&limit=1`, undefined, { accessToken: session.accessToken });
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.analytics.transmissions.length, 1);
  assert.equal(detail.body.analytics.transmissions[0].request.tableLogicalName, 'account');
  assert.equal(detail.body.analytics.transmissions[0].response.value[0].name, 'Acme');
});

// Revoking and deleting are two decisions, not one with a flag. Revoke keeps a
// visible record; delete is the separate choice to stop keeping it. Neither
// touches the transmission history, which lives elsewhere.
test('a connection can be revoked, then deleted, and delete is a separate endpoint', async () => {
  const session = await registerUser('mcpdelete', 'pro');
  const created = await createConnection(session);
  const id = created.connection.id;

  const revoked = await server.call('DELETE', `/api/mcp/connections/${id}`, null, { accessToken: session.accessToken });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.equal(revoked.body.connection.enabled, false);

  // Still listed after a revoke: that is the record the revoke preserves.
  const afterRevoke = await server.call('GET', '/api/mcp/connections', undefined, { accessToken: session.accessToken });
  assert.equal(afterRevoke.status, 200);
  assert.ok(afterRevoke.body.connections.some(item => item.id === id), 'a revoked connection stays listed');

  const deleted = await server.call('DELETE', `/api/mcp/connections/${id}/permanent`, null, { accessToken: session.accessToken });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.deleted, true);

  const afterDelete = await server.call('GET', '/api/mcp/connections', undefined, { accessToken: session.accessToken });
  assert.ok(!afterDelete.body.connections.some(item => item.id === id), 'a deleted connection is gone from the list');

  // Deleting twice is a clear 404, not a silent success.
  const again = await server.call('DELETE', `/api/mcp/connections/${id}/permanent`, null, { accessToken: session.accessToken });
  assert.equal(again.status, 404, JSON.stringify(again.body));
});

test('an active connection can be deleted outright, and one user cannot delete another\'s', async () => {
  const owner = await registerUser('mcpdeleteowner', 'pro');
  const stranger = await registerUser('mcpdeletestranger', 'pro');
  const created = await createConnection(owner);
  const id = created.connection.id;

  const foreign = await server.call('DELETE', `/api/mcp/connections/${id}/permanent`, null, { accessToken: stranger.accessToken });
  assert.equal(foreign.status, 404, 'a connection must not be deletable by anyone but its owner');

  const deleted = await server.call('DELETE', `/api/mcp/connections/${id}/permanent`, null, { accessToken: owner.accessToken });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));

  // The key stops working at the same moment, which is what makes deleting an
  // active connection safe to offer.
  const call = await mcpCall(owner, created, 'tools/list');
  assert.ok(call.status >= 400, `a deleted connection's key must stop working, got ${call.status}`);
});

test('free users cannot delete MCP connections either', async () => {
  const session = await registerUser('mcpdeletefree', 'free');
  const result = await server.call('DELETE', '/api/mcp/connections/anything/permanent', null, { accessToken: session.accessToken });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'MCP_PLAN_REQUIRED');
});
