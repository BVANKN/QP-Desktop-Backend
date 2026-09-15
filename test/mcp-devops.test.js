import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { useTemporaryDataDir, startTestServer, readLatestCode, VALID_PASSWORD } from './helpers/test-server.js';
import { MCP_TOOLS } from '../src/modules/mcp/tool-catalog.js';
import { DEVOPS_DEFAULT_POLICY, subjectFor, subjectsForResource, toolAllowed } from '../src/modules/mcp/tool-policy.js';
import { normalizeDevOpsGrant, summarizeDevOpsGrant } from '../src/modules/mcp/devops-grant.js';

const dataDir = useTemporaryDataDir();
const server = await startTestServer();
test.after(() => server.close());

async function register(planId) {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const username = `devops${suffix}`;
  const started = await server.call('POST', '/api/auth/signup/start', {
    name: 'Azure DevOps test', username, email: `${username}@example.com`,
    password: VALID_PASSWORD, confirmPassword: VALID_PASSWORD, planId
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const verified = await server.call('POST', '/api/auth/signup/verify', { pendingId: started.body.pendingId, code: readLatestCode(dataDir) });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  return { ...verified.body, username };
}

/** A complete OAuth 2.1 + PKCE connection for one MCP resource, as a hosted client performs it. */
async function connectOAuth(session, resource, connectionId) {
  const callback = 'https://chatgpt.com/connector/oauth/devops-test';
  const registered = await server.call('POST', '/oauth/register', {
    client_name: 'Azure DevOps OAuth test', redirect_uris: [callback],
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none'
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const verifier = randomUUID() + randomUUID();
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const page = await fetch(`${server.baseUrl}/oauth/authorize?${new URLSearchParams({
    response_type: 'code', client_id: registered.body.client_id, redirect_uri: callback,
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp:read mcp:write offline_access', resource, state: 's'
  })}`);
  const html = await page.text();
  assert.equal(page.status, 200, html.slice(0, 400));
  const field = name => html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1]?.replaceAll('&amp;', '&');
  const approval = await fetch(`${server.baseUrl}/oauth/authorize`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual',
    body: new URLSearchParams({ requestId: field('requestId'), csrf: field('csrf'), retryPath: field('retryPath'), decision: 'approve', identifier: session.username, password: VALID_PASSWORD, connectionId })
  });
  assert.equal(approval.status, 303, await approval.text());
  const code = new URL(approval.headers.get('location')).searchParams.get('code');
  const token = await fetch(`${server.baseUrl}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: registered.body.client_id, redirect_uri: callback, code, code_verifier: verifier, resource })
  });
  const tokens = await token.json();
  assert.equal(token.status, 200, JSON.stringify(tokens));
  return { html, accessToken: tokens.access_token };
}

function rpc(resource, accessToken, method, params, id = 1) {
  return server.call('POST', new URL(resource).pathname, { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }, {
    headers: { Authorization: `Bearer ${accessToken}`, 'MCP-Protocol-Version': '2025-11-25' }
  });
}

test('the Azure DevOps catalog is its own resource, fully classified, and never unclassified', () => {
  const tools = MCP_TOOLS.filter(tool => tool.group === 'devops');
  assert.equal(tools.length, 34);
  const subjects = new Set(subjectsForResource('devops').map(subject => subject.id));
  for (const tool of tools) {
    const subject = subjectFor(tool);
    assert.ok(subjects.has(subject), `${tool.name} resolved to ${subject}, which no Azure DevOps connection can be granted`);
    assert.ok(tool.action === 'mcpOperationStatus' || tool.action === 'mcpConnectionStatus' || /^mcpDevOps[A-Z]/.test(tool.action), `${tool.name} maps to ${tool.action}`);
  }
  // Messages are messages before they are work items or pull requests.
  assert.equal(subjectFor(tools.find(tool => tool.name === 'add_devops_pull_request_comment')), 'devops-messages');
  assert.equal(subjectFor(tools.find(tool => tool.name === 'add_devops_work_item_comment')), 'devops-messages');
  // Only one tool can destroy anything, and it needs confirm.
  const destructive = tools.filter(tool => tool.risk === 'destructive');
  assert.deepEqual(destructive.map(tool => tool.name), ['delete_devops_work_item']);
  assert.ok(destructive[0].inputSchema.required.includes('confirm'));
  // Neither the Power Platform access settings nor its counts ever include these.
  assert.ok(!subjectsForResource('power-platform').some(subject => subject.id.startsWith('devops-')));
  // A tool nobody classified is withheld from a restricted connection.
  assert.equal(subjectFor({ name: 'frobnicate_devops_widgets', group: 'devops' }), 'data');
  assert.equal(toolAllowed({ name: 'frobnicate_devops_widgets', group: 'devops', risk: 'read' }, DEVOPS_DEFAULT_POLICY).allowed, false);
  // Nothing in any schema can carry a grant.
  for (const tool of tools) {
    assert.ok(!Object.hasOwn(tool.inputSchema.properties || {}, 'grant'), `${tool.name} must not accept a grant`);
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must refuse unknown arguments`);
  }
});

test('a grant is normalized to exactly what will be enforced', () => {
  const grant = normalizeDevOpsGrant({
    organizations: {
      Contoso: { projects: ['Field Service', 'Field Service', '../x', '_system'] },
      Fabrikam: { allProjects: true },
      Empty: { projects: [] },
      'bad org!': { allProjects: true },
      '-dash': { allProjects: true }
    }
  });
  assert.deepEqual(Object.keys(grant.organizations).sort(), ['contoso', 'fabrikam']);
  assert.deepEqual(grant.organizations.contoso.projects, ['Field Service']);
  assert.deepEqual(summarizeDevOpsGrant(grant), { organizations: 2, wholeOrganizations: 1, projects: 1, empty: false });
  assert.equal(summarizeDevOpsGrant(null).empty, true);
});

test('Azure DevOps MCP is Premium, starts granted nothing, starts read-only, and cannot be deleted', async () => {
  const free = await register('free');
  const refused = await server.call('GET', '/api/mcp/devops/bootstrap', undefined, { accessToken: free.accessToken });
  assert.equal(refused.status, 403);

  const session = await register('pro');
  const boot = await server.call('GET', '/api/mcp/devops/bootstrap', undefined, { accessToken: session.accessToken });
  assert.equal(boot.status, 200, JSON.stringify(boot.body));
  assert.match(boot.body.mcpUrl, new RegExp(`/devops/mcp/${session.user.id}$`));
  assert.deepEqual(boot.body.grant, { organizations: {} }, 'a new connection reaches nothing');
  assert.equal(boot.body.grantSummary.empty, true);
  assert.equal(boot.body.devOps.appRegistrationRequired, false);
  assert.equal(boot.body.devOps.personalAccessTokenRequired, false);
  assert.equal(boot.body.connection.toolPolicy.enabled, true);
  assert.equal(boot.body.connection.toolPolicy.ceiling, 'read', 'and can only read until the ceiling is raised');

  // Bootstrapping again must not reset what someone chose.
  const granted = await server.call('PUT', '/api/mcp/devops/access', { grant: { organizations: { contoso: { projects: ['Field Service'] }, 'not valid!': { allProjects: true } } } }, { accessToken: session.accessToken });
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.deepEqual(Object.keys(granted.body.grant.organizations), ['contoso']);
  const again = await server.call('GET', '/api/mcp/devops/bootstrap', undefined, { accessToken: session.accessToken });
  assert.deepEqual(again.body.grant.organizations.contoso.projects, ['Field Service'], 'a repeat bootstrap keeps the grant');

  const listed = await server.call('GET', '/api/mcp/connections', undefined, { accessToken: session.accessToken });
  assert.ok(!listed.body.connections.some(connection => connection.kind === 'devops'), 'the provisioned connection is not a row in the connections table');
  const deleted = await server.call('DELETE', `/api/mcp/connections/${boot.body.connection.id}/permanent`, undefined, { accessToken: session.accessToken });
  assert.equal(deleted.status, 400, 'a provisioned resource is refused rather than deleted');

  const metadata = await server.call('GET', `/.well-known/oauth-protected-resource/devops/mcp/${session.user.id}`);
  assert.equal(metadata.status, 200);
  assert.equal(metadata.body.resource_name, 'Quicker Portal Azure DevOps MCP');
  assert.match(metadata.body.devops_authentication, /no app registration or personal access token/);

  const catalog = await server.call('GET', '/api/mcp/tool-policy/catalog?resource=devops', undefined, { accessToken: session.accessToken });
  assert.equal(catalog.body.totalTools, 34, 'counts are the resource\'s own tools, not the whole catalog');
  assert.ok(catalog.body.subjects.every(subject => subject.resource === 'devops' || subject.id === 'diagnostics'));
});

test('over OAuth, the policy shapes what a client sees, and the grant travels with every job', async () => {
  const session = await register('pro');
  const boot = await server.call('GET', '/api/mcp/devops/bootstrap', undefined, { accessToken: session.accessToken });
  const resource = boot.body.mcpUrl;
  const { html, accessToken } = await connectOAuth(session, resource, boot.body.connection.id);
  assert.match(html, /Connect your Azure DevOps projects/, 'the consent page names what is being connected');
  assert.match(html, /organizations and projects you granted/, 'and what the client will be able to reach');

  const initialized = await rpc(resource, accessToken, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(initialized.body.result.serverInfo.name, 'Quicker Portal Azure DevOps MCP');
  assert.match(initialized.body.result.instructions, /Plain @name text notifies nobody/);
  assert.match(initialized.body.result.instructions, /never try to pass pipeline variables/);

  // Read-only by default: a model is not shown writes it would be refused.
  const listTools = async () => {
    const names = [];
    let cursor;
    do {
      const page = await rpc(resource, accessToken, 'tools/list', cursor ? { cursor } : undefined);
      assert.equal(page.status, 200, JSON.stringify(page.body));
      names.push(...page.body.result.tools.map(tool => tool.name));
      cursor = page.body.result.nextCursor;
    } while (cursor);
    return names;
  };
  const readOnly = await listTools();
  assert.ok(readOnly.includes('query_devops_work_items'));
  assert.ok(!readOnly.includes('add_devops_work_item_comment'), 'no write tools under the read-only default');
  assert.ok(!readOnly.includes('delete_devops_work_item'));
  assert.ok(!readOnly.some(name => !name.includes('devops')), 'only Azure DevOps tools on this resource');
  const refusedWrite = await rpc(resource, accessToken, 'tools/call', { name: 'add_devops_work_item_comment', arguments: { organization: 'contoso', project: 'Field Service', workItemId: 5, text: 'hi' } });
  assert.equal(refusedWrite.body.error.data.code, 'MCP_TOOL_NOT_PERMITTED', 'a cached or guessed write is refused at call time too');

  // The connection check states an empty grant plainly.
  const status = await rpc(resource, accessToken, 'tools/call', { name: 'get_devops_connection', arguments: {} });
  const statusValue = status.body.result.structuredContent;
  assert.equal(statusValue.grantSummary.empty, true);
  assert.match(statusValue.grantGuidance, /nothing can be read until they do/);

  // Raising the ceiling makes writes visible; deletes stay withheld.
  const raised = await server.call('PUT', `/api/mcp/connections/${boot.body.connection.id}/tool-policy`, { policy: { ...DEVOPS_DEFAULT_POLICY, ceiling: 'write' } }, { accessToken: session.accessToken });
  assert.equal(raised.status, 200, JSON.stringify(raised.body));
  assert.equal(raised.body.summary.totalTools, 34);
  const writable = await listTools();
  assert.ok(writable.includes('add_devops_work_item_comment'));
  assert.ok(!writable.includes('delete_devops_work_item'));

  // The grant is taken from the record at call time and delivered beside the
  // arguments. A grant change applies to the very next call.
  await server.call('PUT', '/api/mcp/devops/access', { grant: { organizations: { contoso: { projects: ['Field Service'] } } } }, { accessToken: session.accessToken });
  const clientInstanceId = 'devops-test-desktop';
  const heartbeat = await server.call('POST', '/api/mcp/bridge/heartbeat', { tenantId: 'devops', environmentId: 'devops', environmentName: 'person@contoso.com', clientInstanceId, appVersion: 'test' }, { accessToken: session.accessToken });
  assert.equal(heartbeat.status, 200, JSON.stringify(heartbeat.body));

  const smuggled = await rpc(resource, accessToken, 'tools/call', { name: 'list_devops_projects', arguments: { organization: 'contoso', grant: { organizations: { northwind: { allProjects: true } } } } });
  assert.equal(smuggled.body.error?.code, -32602, 'an argument claiming a grant is rejected by the schema');

  const pending = rpc(resource, accessToken, 'tools/call', { name: 'list_devops_projects', arguments: { organization: 'contoso' } });
  await new Promise(resolve => setTimeout(resolve, 60));
  const leased = await server.call('GET', `/api/mcp/bridge/jobs?${new URLSearchParams({ tenantId: 'devops', environmentId: 'devops', clientInstanceId, limit: '1' })}`, undefined, { accessToken: session.accessToken });
  assert.equal(leased.status, 200, JSON.stringify(leased.body));
  assert.equal(leased.body.jobs.length, 1);
  const job = leased.body.jobs[0];
  assert.equal(job.action, 'mcpDevOpsListProjects');
  assert.deepEqual(job.grant, { organizations: { contoso: { name: 'contoso', allProjects: false, projects: ['Field Service'] } } });
  assert.equal(job.arguments.grant, undefined, 'the grant is never inside the arguments');

  const completed = await server.call('POST', `/api/mcp/bridge/jobs/${job.id}/complete`, { leaseToken: job.leaseToken, result: { ok: true, result: [{ id: 'p1', name: 'Field Service' }] } }, { accessToken: session.accessToken });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  const response = await pending;
  assert.equal(response.body.result.isError, false, JSON.stringify(response.body));
});
