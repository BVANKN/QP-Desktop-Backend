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
  assert.equal(tools.length, 15);
  assert.ok(tools.every(item => ['powerPagesRead', 'powerPagesWrite', 'powerPagesDelete'].includes(item.action)));
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
