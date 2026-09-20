import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { useTemporaryDataDir, startTestServer, readLatestCode, VALID_PASSWORD } from './helpers/test-server.js';
import { MCP_TOOLS, MCP_TOOL_BY_NAME } from '../src/modules/mcp/tool-catalog.js';

const dataDir = useTemporaryDataDir();
const server = await startTestServer();
test.after(() => server.close());

async function register(planId) {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const started = await server.call('POST', '/api/auth/signup/start', {
    name: 'Power Pages test', username: `powerpages${suffix}`, email: `powerpages${suffix}@example.com`,
    password: VALID_PASSWORD, confirmPassword: VALID_PASSWORD, planId
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const verified = await server.call('POST', '/api/auth/signup/verify', { pendingId: started.body.pendingId, code: readLatestCode(dataDir) });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  return verified.body;
}

test('Power Pages tool catalog is isolated, model-aware, and risk classified', () => {
  const tools = MCP_TOOLS.filter(item => item.group === 'powerpages');
  assert.equal(tools.length, 22);
  assert.equal(MCP_TOOL_BY_NAME.get('get_power_pages_operation').execution, 'server');
  // The five that answer a question a component list structurally cannot.
  for (const name of ['get_power_pages_page_tree', 'search_power_pages_content', 'get_power_pages_site_setting', 'audit_power_pages_access', 'validate_power_pages_site']) {
    assert.equal(MCP_TOOL_BY_NAME.get(name).risk, 'read', `${name} must be read-only`);
    assert.equal(MCP_TOOL_BY_NAME.get(name).action, 'powerPagesRead');
  }
  assert.equal(MCP_TOOL_BY_NAME.get('search_power_pages_content').fixedArguments.operation, 'searchContent');
  assert.deepEqual(MCP_TOOL_BY_NAME.get('search_power_pages_content').inputSchema.required, ['siteId', 'query']);
  // Language is site configuration, not a component, so it never showed up in
  // the component inventory and had no tool of its own.
  assert.equal(MCP_TOOL_BY_NAME.get('list_power_pages_languages').risk, 'read');
  assert.equal(MCP_TOOL_BY_NAME.get('list_power_pages_languages').fixedArguments.operation, 'listLanguages');
  assert.ok(tools.every(item => ['powerPagesRead', 'powerPagesWrite', 'powerPagesDelete'].includes(item.action) || (item.action === 'mcpOperationStatus' && item.execution === 'server')));
  assert.equal(MCP_TOOL_BY_NAME.get('read_power_pages_component').risk, 'read');
  assert.equal(MCP_TOOL_BY_NAME.get('update_power_pages_component').risk, 'write');
  assert.equal(MCP_TOOL_BY_NAME.get('delete_power_pages_component').risk, 'destructive');
  assert.equal(MCP_TOOL_BY_NAME.get('create_power_pages_site').risk, 'write');
  assert.deepEqual(MCP_TOOL_BY_NAME.get('create_power_pages_site').inputSchema.properties.templateName.enum, ['DefaultPortalTemplate','PowerPortals_ProgramRegistration','PowerPortals_BookMeeting']);
  assert.ok(MCP_TOOL_BY_NAME.get('create_power_pages_component').inputSchema.properties.componentType.enum.includes('tablePermission'));
  assert.ok(MCP_TOOL_BY_NAME.get('create_power_pages_component').inputSchema.properties.componentType.enum.includes('uxComponent'));
  assert.ok(MCP_TOOL_BY_NAME.get('configure_power_pages_security').inputSchema.properties.operation.enum.includes('enableWaf'));
  assert.ok(MCP_TOOL_BY_NAME.get('configure_power_pages_security').inputSchema.properties.operation.enum.includes('uploadCertificate'));
});

test('Power Pages MCP bootstrap is Premium, OAuth-only, and environment-scoped', async () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const environmentId = '22222222-2222-4222-8222-222222222222';
  const query = `tenantId=${tenantId}&environmentId=${environmentId}&tenantName=Contoso&environmentName=Development`;
  const free = await register('free');
  const refused = await server.call('GET', `/api/mcp/powerpages/bootstrap?${query}`, undefined, { accessToken: free.accessToken });
  assert.equal(refused.status, 403);

  const premium = await register('pro');
  const response = await server.call('GET', `/api/mcp/powerpages/bootstrap?${query}`, undefined, { accessToken: premium.accessToken });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.connection.kind, 'powerpages');
  assert.equal(response.body.connection.tenantId, `powerpages:${tenantId}`);
  assert.equal(response.body.connection.environmentId, environmentId);
  assert.equal(response.body.mcpUrl, `${server.baseUrl}/powerpages/mcp/${encodeURIComponent(premium.user.id)}/${tenantId}`);
  assert.equal('apiKey' in response.body, false);

  const metadata = await server.call('GET', `/.well-known/oauth-protected-resource/powerpages/mcp/${encodeURIComponent(premium.user.id)}/${tenantId}`);
  assert.equal(metadata.status, 200, JSON.stringify(metadata.body));
  assert.equal(metadata.body.resource_name, 'Quicker Portal Power Pages MCP');
  assert.equal(metadata.body.resource, response.body.mcpUrl);
  assert.match(metadata.body.power_pages_execution, /local-write-approval/);

  const unauthorized = await server.call('POST', `/powerpages/mcp/${encodeURIComponent(premium.user.id)}/${tenantId}`, { jsonrpc:'2.0', id:1, method:'initialize', params:{} });
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get('www-authenticate') || '', /oauth-protected-resource/);
});

// A queued job that no desktop can claim.
//
// The claim filter matches on the environment key, so a connection bound to one
// environment while the desktop is on another produces a job nothing will ever
// pick up. Two things made that invisible: desktopStatus counted a heartbeat
// with no environment as a match, so the call was told the desktop was ready;
// and the expiry message said "keep Quicker Portal running" even when Quicker
// Portal was running and heartbeating. The caller waited the full tool timeout
// and got no indication that an environment was involved.
test('an unclaimable job names the environment mismatch instead of blaming the desktop', async () => {
  const { desktopStatus, desktopWaitFailure, heartbeatDesktop } = await import('../src/modules/mcp/broker.js');
  const userId = 'mismatch-user';
  const tenantId = 'powerpages:11111111-2222-3333-4444-555555555555';
  const job = { userId, tenantId, environmentId: 'KNCBHARAT', environmentName: 'KNCBHARAT' };

  // Nothing has reported in at all.
  assert.match(desktopWaitFailure(job).message, /No desktop has reported in/);

  // A desktop is running, but on another environment. This is the reported bug.
  heartbeatDesktop({ userId, tenantId, environmentId: 'AB2', environmentName: 'AB2', clientInstanceId: 'c1' });
  const mismatch = desktopWaitFailure(job).message;
  assert.match(mismatch, /bound to environment KNCBHARAT/);
  assert.match(mismatch, /desktop is on AB2/);
  assert.match(mismatch, /never picked up/);
  assert.doesNotMatch(mismatch, /Keep Quicker Portal running/, 'it is already running; that advice sends people to the wrong place');

  // And the status must not claim it is connected for that environment.
  const wrong = desktopStatus(userId, tenantId, 'KNCBHARAT');
  assert.equal(wrong.environmentMatches, false);
  assert.equal(wrong.connected, false, 'a desktop on another environment cannot serve this connection');

  // A heartbeat that does not say where it is cannot be counted as a match.
  heartbeatDesktop({ userId, tenantId: 'powerpages:blank', environmentId: '', clientInstanceId: 'c2' });
  const unknown = desktopStatus(userId, 'powerpages:blank', 'KNCBHARAT');
  assert.equal(unknown.environmentMatches, false, 'an unknown environment is not a match');
  assert.equal(unknown.connected, false, 'otherwise a job is queued that the claim filter can never match');

  // Same environment: the fault is genuinely the request, and it says so.
  heartbeatDesktop({ userId, tenantId, environmentId: 'KNCBHARAT', environmentName: 'KNCBHARAT', clientInstanceId: 'c3' });
  assert.equal(desktopStatus(userId, tenantId, 'KNCBHARAT').connected, true);
  assert.match(desktopWaitFailure(job, 'leased').message, /accepted this tool call but did not return a terminal result/);
  assert.match(desktopWaitFailure(job, 'leased').message, /reconcile current state before any retry/);
  assert.match(desktopWaitFailure(job, 'queued').message, /never picked the request up/);
});

// The Power Pages endpoint is addressed by user and tenant only - there is no
// environment in its URL - so the environment has to come from somewhere else.
// Taking it from the connection record froze it at whatever was selected when
// the endpoint was first prepared: signing in and choosing an environment in
// Quicker Portal changed nothing, and jobs were queued against an environment
// key no running desktop would ever claim.
test('an environment-less endpoint follows the environment the desktop is signed in to', async () => {
  const { currentDesktopEnvironment, heartbeatDesktop, desktopStatus } = await import('../src/modules/mcp/broker.js');
  const userId = 'follows-user';
  const tenantId = 'powerpages:99999999-8888-7777-6666-555555555555';

  assert.equal(currentDesktopEnvironment(userId, tenantId), null, 'with nothing running there is no environment to follow');

  heartbeatDesktop({ userId, tenantId, environmentId: 'KNCBHARAT', environmentName: 'KNC Bharat', clientInstanceId: 'c1' });
  assert.deepEqual(currentDesktopEnvironment(userId, tenantId), { environmentId: 'KNCBHARAT', environmentName: 'KNC Bharat' });

  // Switching environments in the desktop moves the endpoint with it. The same
  // client instance must replace its heartbeat rather than add a second one,
  // or the environment just left behind goes on looking live for 25 seconds.
  heartbeatDesktop({ userId, tenantId, environmentId: 'AB2', environmentName: 'AB2 Sandbox', clientInstanceId: 'c1' });
  assert.equal(desktopStatus(userId, tenantId, 'KNCBHARAT').connected, false, 'the environment just left must not still answer');
  assert.deepEqual(currentDesktopEnvironment(userId, tenantId), { environmentId: 'AB2', environmentName: 'AB2 Sandbox' });
  assert.equal(desktopStatus(userId, tenantId, 'AB2').connected, true, 'and the job can then be claimed');

  // Scope is unchanged: another tenant, and another user, are still separate.
  assert.equal(currentDesktopEnvironment(userId, 'powerpages:other-tenant'), null);
  assert.equal(currentDesktopEnvironment('another-user', tenantId), null);

  // A heartbeat with no environment tells us nothing and must not be followed.
  heartbeatDesktop({ userId, tenantId: 'powerpages:blank-env', environmentId: '', clientInstanceId: 'c2' });
  assert.equal(currentDesktopEnvironment(userId, 'powerpages:blank-env'), null);

  const protocol = await import('../src/modules/mcp/protocol.js');
  assert.ok(protocol, 'the protocol module wires this in for environment-less resources');
});
