import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
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

function waitForFrame(socket, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Timed out waiting for an IDE bridge frame.')), timeoutMs);
    const onMessage = raw => {
      const frame = JSON.parse(raw.toString('utf8'));
      if (predicate(frame)) finish(null, frame);
    };
    const finish = (error, frame) => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      if (error) reject(error); else resolve(frame);
    };
    socket.on('message', onMessage);
  });
}

async function authorizeIde(session, bootstrap) {
  const callback = 'https://chatgpt.com/connector/oauth/qp-ide-test';
  const client = await server.call('POST', '/oauth/register', {
    client_name: 'QP IDE test client',
    redirect_uris: [callback],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none'
  });
  assert.equal(client.status, 201, JSON.stringify(client.body));
  const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({
    response_type: 'code', client_id: client.body.client_id, redirect_uri: callback,
    code_challenge: challenge, code_challenge_method: 'S256',
    scope: 'mcp:read mcp:write offline_access', resource: bootstrap.mcpUrl, state: 'ide-state'
  });
  const page = await fetch(`${server.baseUrl}/oauth/authorize?${query}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Connect your IDE workspaces/);
  const requestId = html.match(/name="requestId" value="([^"]+)"/)?.[1];
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  const retryPath = html.match(/name="retryPath" value="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
  assert.ok(requestId && csrf && retryPath);
  const approved = await fetch(`${server.baseUrl}/oauth/authorize`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      requestId, csrf, retryPath, decision: 'approve', identifier: session.user.username,
      password: VALID_PASSWORD, connectionId: bootstrap.connection.id
    })
  });
  assert.equal(approved.status, 303, await approved.text());
  const code = new URL(approved.headers.get('location')).searchParams.get('code');
  const tokenResponse = await fetch(`${server.baseUrl}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: client.body.client_id,
      redirect_uri: callback, code, code_verifier: verifier, resource: bootstrap.mcpUrl
    })
  });
  const tokens = await tokenResponse.json();
  assert.equal(tokenResponse.status, 200, JSON.stringify(tokens));
  return { client: client.body, tokens };
}

async function mcpCall(url, accessToken, body, sessionId) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${accessToken}`,
      'MCP-Protocol-Version': '2025-11-25',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {})
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let parsed = null;
  if (text.startsWith('event:')) {
    const messages = text.split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => JSON.parse(line.slice(5).trim()));
    parsed = messages.find(message => message.id === body.id) || messages.at(-1) || null;
  } else if (text) {
    parsed = JSON.parse(text);
  }
  return { response, body: parsed };
}

test('IDE requires Premium and inherits the QP account identity', async () => {
  const free = await register('idefree', 'free');
  const refused = await server.call('GET', '/api/ide/bootstrap', undefined, { accessToken: free.accessToken });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'IDE_PREMIUM_REQUIRED');

  const premium = await register('idepremium', 'pro');
  const boot = await server.call('GET', '/api/ide/bootstrap', undefined, { accessToken: premium.accessToken });
  assert.equal(boot.status, 200, JSON.stringify(boot.body));
  assert.equal(boot.body.user.id, premium.user.id);
  assert.equal(boot.body.connection.kind, 'ide');
  assert.equal(boot.body.mcpUrl, `${server.baseUrl}/ide/mcp/${encodeURIComponent(premium.user.id)}`);
  assert.equal('apiKey' in boot.body, false, 'IDE bootstrap must not mint a second reusable bearer credential.');

  const metadata = await server.call('GET', `/.well-known/oauth-protected-resource/ide/mcp/${encodeURIComponent(premium.user.id)}`);
  assert.equal(metadata.status, 200);
  assert.equal(metadata.body.resource_name, 'Quicker Portal IDE MCP');
  assert.equal(metadata.body.resource, boot.body.mcpUrl);
});

test('QP OAuth, bridge, workspace reads, and writes work end to end', async () => {
  const session = await register('ideagent', 'pro');
  const bootstrapResponse = await server.call('GET', '/api/ide/bootstrap', undefined, { accessToken: session.accessToken });
  assert.equal(bootstrapResponse.status, 200, JSON.stringify(bootstrapResponse.body));
  const bootstrap = bootstrapResponse.body;

  const rejected = new WebSocket(bootstrap.bridgeUrl, { headers: { Authorization: 'Bearer invalid-token' } });
  const rejectedStatus = await new Promise(resolve => rejected.once('unexpected-response', (_request, response) => resolve(response.statusCode)));
  assert.equal(rejectedStatus, 401);

  const socket = new WebSocket(bootstrap.bridgeUrl, { headers: { Authorization: `Bearer ${session.accessToken}` } });
  const welcomePromise = waitForFrame(socket, frame => frame.t === 'welcome');
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const welcome = await welcomePromise;
  assert.equal(welcome.user.id, session.user.id);

  const currentRevision = '1111111111111111';
  const nextRevision = '2222222222222222';
  let content = 'console.log("hello");\n';
  socket.on('message', raw => {
    const frame = JSON.parse(raw.toString('utf8'));
    if (frame.t !== 'req') return;
    if (frame.method === 'ping') socket.send(JSON.stringify({ t: 'res', id: frame.id, ok: true, result: {} }));
    if (frame.method === 'gitCheckpoint') socket.send(JSON.stringify({ t: 'res', id: frame.id, ok: true, result: { committed: false, reason: 'clean' } }));
    if (frame.method === 'readFiles') socket.send(JSON.stringify({
      t: 'res', id: frame.id, ok: true,
      result: { files: frame.params.paths.map(path => ({ path, content, revision: content.includes('updated') ? nextRevision : currentRevision, size: Buffer.byteLength(content), encoding: 'utf8', dirty: false })) }
    }));
    if (frame.method === 'writeFiles') {
      content = frame.params.changes[0].content;
      socket.send(JSON.stringify({
        t: 'res', id: frame.id, ok: true,
        result: { results: [{ ok: true, path: 'hello.js', action: 'update', revision: nextRevision, size: Buffer.byteLength(content), mtime: Date.now() }] }
      }));
    }
  });
  socket.send(JSON.stringify({ t: 'hello', info: { platform: 'darwin', appVersion: '1.0.0', capabilities: ['describeEnvironment', 'gitCheckpoint', 'installPrompt', 'boundedApproval'] } }));
  const registeredPromise = waitForFrame(socket, frame => frame.t === 'event' && frame.event === 'workspace-registered');
  socket.send(JSON.stringify({ t: 'event', event: 'workspace-opened', localId: 'local-1', name: 'hello-project', rootPath: '/tmp/hello-project', kind: 'folder' }));
  const registered = await registeredPromise;
  socket.send(JSON.stringify({
    t: 'event', event: 'manifest-chunk', workspaceId: registered.workspaceId, reset: true,
    files: [{ path: 'hello.js', size: Buffer.byteLength(content), mtime: Date.now(), revision: currentRevision, binary: false, encoding: 'utf8' }]
  }));
  socket.send(JSON.stringify({
    t: 'event', event: 'index-complete', workspaceId: registered.workspaceId,
    skipped: { ignored: 0, binary: 0, tooLarge: 0 },
    git: { isRepo: true, branch: 'main', dirtyFileCount: 0 },
    project: { topLevelFiles: ['hello.js'], frameworks: [], commands: [] }
  }));

  const { client, tokens } = await authorizeIde(session, bootstrap);
  const initialized = await mcpCall(bootstrap.mcpUrl, tokens.access_token, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'QP IDE test', version: '1' } }
  });
  assert.equal(initialized.response.status, 200, JSON.stringify(initialized.body));
  const mcpSessionId = initialized.response.headers.get('mcp-session-id');
  assert.ok(mcpSessionId);

  const listed = await mcpCall(bootstrap.mcpUrl, tokens.access_token, {
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_workspaces', arguments: {} }
  }, mcpSessionId);
  assert.ok(listed.body?.result?.structuredContent?.workspaces, JSON.stringify(listed.body));
  assert.equal(listed.body.result.structuredContent.workspaces[0].name, 'hello-project');

  const read = await mcpCall(bootstrap.mcpUrl, tokens.access_token, {
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'read_files', arguments: { workspaceId: registered.workspaceId, paths: ['hello.js'] } }
  }, mcpSessionId);
  assert.equal(read.body.result.structuredContent.files[0].content, content);

  const updatedContent = 'console.log("updated");\n';
  const written = await mcpCall(bootstrap.mcpUrl, tokens.access_token, {
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'write_files', arguments: {
      workspaceId: registered.workspaceId,
      changes: [{ path: 'hello.js', content: updatedContent, baseRevision: currentRevision, action: 'update' }],
      summary: 'Update the greeting'
    } }
  }, mcpSessionId);
  assert.notEqual(written.body.result.isError, true, JSON.stringify(written.body));
  assert.equal(written.body.result.structuredContent.applied[0].revision, nextRevision);
  assert.equal(content, updatedContent);

  const grants = await server.call('GET', '/api/ide/grants', undefined, { accessToken: session.accessToken });
  assert.equal(grants.status, 200);
  assert.equal(grants.body.grants[0].clientId, client.client_id);
  const revoked = await server.call('DELETE', `/api/ide/grants/${encodeURIComponent(client.client_id)}`, undefined, { accessToken: session.accessToken });
  assert.equal(revoked.status, 200);
  assert.ok(revoked.body.revoked >= 1);
  const afterRevoke = await mcpCall(bootstrap.mcpUrl, tokens.access_token, {
    jsonrpc: '2.0', id: 5, method: 'ping'
  }, mcpSessionId);
  assert.equal(afterRevoke.response.status, 401);

  socket.close();
});
