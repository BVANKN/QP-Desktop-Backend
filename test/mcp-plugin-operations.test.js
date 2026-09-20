import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTemporaryDataDir, startTestServer, readLatestCode, VALID_PASSWORD } from './helpers/test-server.js';
import { operationContract, RESUMABLE_PLUGIN_TOOLS } from '../src/modules/mcp/operation-contract.js';

const dataDir = useTemporaryDataDir();
const { MCP_TOOL_BY_NAME } = await import('../src/modules/mcp/tool-catalog.js');
const { validateSchema } = await import('../src/modules/mcp/schema-validator.js');
const broker = await import('../src/modules/mcp/broker.js');

test('plug-in tools accept resume-only calls but reject missing original inputs and mixed requests', () => {
  for (const name of RESUMABLE_PLUGIN_TOOLS) {
    const schema = MCP_TOOL_BY_NAME.get(name).inputSchema;
    assert.deepEqual(validateSchema(schema, { resumeOperationId: 'job-existing' }), [], name);
    for (const args of [{}, { resumeOperationId: '' }, { resumeOperationId: 'x'.repeat(129) }, { resumeOperationId: 'job-existing', confirm: true }, { resumeOperationId: 'job-existing', mode: 'register' }]) {
      assert.ok(validateSchema(schema, args).length, `${name}: ${JSON.stringify(args)}`);
    }
  }
  assert.deepEqual(validateSchema(MCP_TOOL_BY_NAME.get('register_plugin_artifact').inputSchema, { artifactToken: 'selected', confirm: true }), []);
});

test('operation contract exposes final artifact output and distinguishes cancellation, failure and unknown outcomes', () => {
  const operation = { operationId: 'job-existing', toolName: 'choose_plugin_artifact', status: 'completed', result: { ok: true, result: { artifactToken: 'selected-once' } } };
  const complete = operationContract(operation, 'power-platform');
  assert.equal(complete.pending, false);
  assert.equal(complete.output.artifactToken, 'selected-once');
  assert.equal(complete.result, operation.result, 'preserve existing polling payload');
  assert.deepEqual(complete.resumeArguments, { resumeOperationId: operation.operationId });
  assert.match(complete.guidance, /do not select the file again/);
  const canceled = operationContract({ ...operation, result: { ok: true, result: { canceled: true } } }, 'power-platform');
  assert.match(canceled.guidance, /Stop/);
  for (const status of ['failed', 'expired']) {
    const result = operationContract({ ...operation, status }, 'power-platform');
    assert.equal(result.output, undefined);
    assert.equal(result.pending, false);
    assert.match(result.guidance, /do not blindly repeat/);
  }
  const uncertain = operationContract({ ...operation, status: 'outcome_unknown' }, 'power-platform');
  assert.equal(uncertain.output, undefined);
  assert.equal(uncertain.pending, true);
  assert.equal(uncertain.reconcileBeforeRetry, true);
  assert.match(uncertain.guidance, /reconcile current platform state/i);
  assert.equal(operationContract({ ...operation, resultPurged: true }, 'power-platform').output, undefined);
  for (const status of ['queued', 'leased']) {
    const result = operationContract({ ...operation, status, result: null }, 'power-platform');
    assert.equal(result.pending, true);
    assert.match(result.guidance, /resumeTool/);
  }
  assert.equal(operationContract(operation, 'sharepoint').pollTool, 'get_sharepoint_operation');
  assert.equal(operationContract(operation, 'powerpages').pollTool, 'get_power_pages_operation');
});

test('slow native selection can be retrieved through the same tool with no second job; scoped endpoints expose polling', { timeout: 60000 }, async () => {
  const server = await startTestServer();
  try {
    const started = await server.call('POST', '/api/auth/signup/start', {
      name: 'Plugin Operation Test', username: 'pluginoperationtest', email: 'pluginoperation@example.com',
      password: VALID_PASSWORD, confirmPassword: VALID_PASSWORD, planId: 'pro'
    });
    assert.equal(started.status, 200);
    const verified = await server.call('POST', '/api/auth/signup/verify', { pendingId: started.body.pendingId, code: readLatestCode(dataDir) });
    assert.equal(verified.status, 200);
    const session = verified.body;
    const auth = { accessToken: session.accessToken };
    const tenantId = '11111111-2222-3333-4444-555555555555';
    const environmentId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const created = await server.call('POST', '/api/mcp/connections', { tenantId, environmentId, captureMode: 'detailed' }, auth);
    assert.equal(created.status, 201);
    const connection = created.body.connection;
    const prefix = `/mcp/${session.user.id}/${tenantId}`;
    const headers = { Authorization: `Bearer ${created.body.apiKey}` };
    const rpc = (endpoint, method, params) => server.call('POST', endpoint, { jsonrpc: '2.0', id: 1, method, params }, { headers });
    const endpoint = `${prefix}/choose_plugin_artifact`;
    const list = await rpc(endpoint, 'tools/list', {});
    assert.deepEqual(list.body.result.tools.map(tool => tool.name).sort(), ['choose_plugin_artifact', 'get_power_platform_operation']);
    const firstPage = await rpc(prefix, 'tools/list', {});
    assert.ok(firstPage.body.result.tools.some(tool => tool.name === 'get_power_platform_operation'));
    await server.call('POST', '/api/mcp/bridge/heartbeat', { tenantId, environmentId, clientInstanceId: 'plugin-test-desktop' }, auth);
    // Exercise the real 25-second inline budget. No production connection,
    // native picker, DLL upload or Dataverse mutation is involved.
    const accepted = await rpc(endpoint, 'tools/call', { name: 'choose_plugin_artifact', arguments: { mode: 'register' } });
    const pending = accepted.body.result.structuredContent;
    assert.equal(pending.pending, true, JSON.stringify(accepted.body));
    assert.equal(pending.resumeTool, 'choose_plugin_artifact');
    assert.deepEqual(pending.resumeArguments, { resumeOperationId: pending.operationId });
    const readAgain = () => rpc(endpoint, 'tools/call', { name: pending.resumeTool, arguments: pending.resumeArguments });
    assert.equal((await readAgain()).body.result.structuredContent.status, 'queued');
    const jobs = await broker.claimDesktopJobs({ userId: session.user.id, tenantId, environmentId, clientInstanceId: 'plugin-test-desktop' });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, pending.operationId);
    assert.equal((await readAgain()).body.result.structuredContent.status, 'leased');
    await broker.completeDesktopJob({ userId: session.user.id, jobId: jobs[0].id, leaseToken: jobs[0].leaseToken, result: { ok: true, result: { artifactToken: 'selected-once', fileName: 'Timesheet.dll', canceled: false } } });
    for (let i = 0; i < 2; i++) {
      const resumed = await readAgain();
      assert.equal(resumed.body.result.isError, false);
      assert.equal(resumed.body.result.structuredContent.output.artifactToken, 'selected-once');
      assert.equal(resumed.body.result.structuredContent.pending, false);
    }
    const polled = await rpc(endpoint, 'tools/call', { name: 'get_power_platform_operation', arguments: { operationId: pending.operationId } });
    assert.equal(polled.body.result.structuredContent.output.artifactToken, 'selected-once');
    const deniedTool = await rpc(endpoint, 'tools/call', { name: 'register_plugin_artifact', arguments: { artifactToken: 'selected-once', confirm: true } });
    assert.ok(deniedTool.body.error, 'scoped endpoint cannot register');
    const wrongResume = await rpc(`${prefix}/register_plugin_artifact`, 'tools/call', { name: 'register_plugin_artifact', arguments: pending.resumeArguments });
    assert.equal(wrongResume.body.result.isError, true, 'resuming is bound to the originating tool');
    const wrongScopedPoll = await rpc(`${prefix}/register_plugin_artifact`, 'tools/call', { name: 'get_power_platform_operation', arguments: pending.pollArguments });
    assert.equal(wrongScopedPoll.body.result.isError, true);
    await assert.rejects(broker.getDesktopOperation({ userId: 'other-user', connectionId: connection.id, operationId: pending.operationId }));
    await assert.rejects(broker.getDesktopOperation({ userId: session.user.id, connectionId: 'other-connection', operationId: pending.operationId }));
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'mcp/jobs.json'), 'utf8'));
    assert.equal(stored.jobs.length, 1, 'polling and rejected calls must not enqueue work');
    // Registration also resumes its existing output instead of issuing a new upload.
    const registerJob = await broker.enqueueDesktopToolCall({ connection, tool: MCP_TOOL_BY_NAME.get('register_plugin_artifact'), arguments: { artifactToken: 'selected-once', confirm: true } });
    const [registerLease] = await broker.claimDesktopJobs({ userId: session.user.id, tenantId, environmentId, clientInstanceId: 'plugin-test-desktop' });
    await broker.completeDesktopJob({ userId: session.user.id, jobId: registerJob.id, leaseToken: registerLease.leaseToken, result: { ok: true, result: { assemblyId: 'registered-once' } } });
    const registered = await rpc(prefix, 'tools/call', { name: 'register_plugin_artifact', arguments: { resumeOperationId: registerJob.id } });
    assert.equal(registered.body.result.structuredContent.output.assemblyId, 'registered-once');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'mcp/jobs.json'), 'utf8')).jobs.length, 2);
    // Destructive dispatch still requires confirmation, but resume is a
    // read of the same already-approved operation and must not ask again.
    const rollbackTool = MCP_TOOL_BY_NAME.get('rollback_plugin_registration');
    const deniedRollback = await rpc(prefix, 'tools/call', { name: rollbackTool.name, arguments: { rollbackToken: 'snapshot', confirm: false } });
    assert.ok(deniedRollback.body.error, 'unconfirmed rollback must never be dispatched');
    const rollbackJob = await broker.enqueueDesktopToolCall({ connection, tool: rollbackTool, arguments: { rollbackToken: 'snapshot', confirm: true } });
    const [rollbackLease] = await broker.claimDesktopJobs({ userId: session.user.id, tenantId, environmentId, clientInstanceId: 'plugin-test-desktop' });
    await broker.completeDesktopJob({ userId: session.user.id, jobId: rollbackJob.id, leaseToken: rollbackLease.leaseToken, result: { ok: true, result: { rolledBack: true } } });
    const resumedRollback = await rpc(`${prefix}/${rollbackTool.name}`, 'tools/call', { name: rollbackTool.name, arguments: { resumeOperationId: rollbackJob.id } });
    assert.equal(resumedRollback.body.result.isError, false);
    assert.equal(resumedRollback.body.result.structuredContent.output.rolledBack, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'mcp/jobs.json'), 'utf8')).jobs.length, 3, 'resume cannot repeat rollback');
  } finally {
    await server.close();
  }
});
