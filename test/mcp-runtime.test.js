import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { useTemporaryDataDir } from './helpers/test-server.js';

useTemporaryDataDir();
const broker = await import('../src/modules/mcp/broker.js');
const { MCP_TOOLS, MCP_TOOL_BY_NAME } = await import('../src/modules/mcp/tool-catalog.js');
const { validateSchema } = await import('../src/modules/mcp/schema-validator.js');
const { RESUMABLE_PLUGIN_TOOLS, operationContract } = await import('../src/modules/mcp/operation-contract.js');
const { redact } = await import('../src/modules/mcp/analytics.js');
const connection = { id: 'connection-A', userId: 'user-A', tenantId: 'tenant-A', environmentId: 'env-A' };
const definition = { name: 'example', action: 'exampleAction', risk: 'write', timeoutMs: 120_000 };
const enqueue = args => broker.enqueueDesktopToolCall({ connection, tool: definition, arguments: args || {}, requestId: randomUUID() });
const claim = claimId => broker.claimDesktopJobs({ ...connection, clientInstanceId: 'desktop-A', claimId });

test('all advertised tool schemas compile and enforce actual JSON Schema semantics', () => {
  for (const tool of MCP_TOOLS) assert.doesNotThrow(() => validateSchema(tool.inputSchema, {}), tool.name);
  assert.deepEqual(validateSchema({ type: 'object', required: ['value'], properties: { value: { type: 'string' } } }, { value: '' }), []);
  assert.deepEqual(validateSchema({ type: 'object', required: ['value'], properties: { value: { type: ['string', 'null'] } } }, { value: null }), []);
  assert.ok(validateSchema({ type: 'integer' }, '2').length);
  assert.ok(validateSchema({ type: 'integer' }, 2.5).length);
  assert.ok(validateSchema({ type: 'number' }, Infinity).length);
  assert.ok(validateSchema({ anyOf: [{ type: 'number', minimum: 2 }, { type: 'array', minItems: 2 }] }, 1).length);
  assert.ok(validateSchema({ anyOf: [{ type: 'number', minimum: 2 }, { type: 'array', minItems: 2 }] }, []).length);
  assert.ok(validateSchema({ type: 'string', minLength: 1 }, '').length);
});

test('new mutation contracts require current settings, bound bulk sizes, and fixed operations', () => {
  assert.ok(validateSchema(MCP_TOOL_BY_NAME.get('update_organization_setting').inputSchema, { logicalName: 'isauditenabled', value: true }).length);
  assert.deepEqual(validateSchema(MCP_TOOL_BY_NAME.get('update_organization_setting').inputSchema, { logicalName: 'isauditenabled', value: true, expectedValue: false }), []);
  const bulk = MCP_TOOL_BY_NAME.get('upsert_records_bulk');
  assert.equal(bulk.fixedArguments.operation, 'UpsertMultiple');
  assert.ok(validateSchema(bulk.inputSchema, { entitySet: 'accounts', logicalName: 'account', rows: Array.from({ length: 101 }, () => ({})) }).length);
  assert.ok(validateSchema(bulk.inputSchema, { entitySet: 'accounts', logicalName: 'account', rows: [{}], operation: 'DeleteMultiple' }).length);
});

test('fixed catalog arguments cannot be overwritten by an enveloped payload', async () => {
  const job = await broker.enqueueDesktopToolCall({ connection, tool: { ...definition, fixedArguments: { operation: 'Create' }, argumentEnvelope: 'payload' }, arguments: { payload: { operation: 'Delete', name: 'safe' } } });
  assert.equal(job.arguments.operation, 'Create');
  assert.equal(job.arguments.name, 'safe');
  const jobs = await claim(randomUUID());
  await broker.completeDesktopJob({ userId: connection.userId, jobId: jobs[0].id, leaseToken: jobs[0].leaseToken, result: { ok: true } });
});

test('repeated/concurrent claims replay the same leased job rather than consuming more', async () => {
  const job = await enqueue({ value: 1 });
  const second = await enqueue({ value: 2 });
  const key = randomUUID();
  const [first, duplicate] = await Promise.all([claim(key), claim(key)]);
  assert.equal(first[0].id, job.id);
  assert.equal(duplicate[0].id, job.id);
  assert.equal(first[0].leaseToken, duplicate[0].leaseToken);
  const retry = await claim(key);
  assert.equal(retry[0].id, job.id);
  assert.equal(first[0].userId, connection.userId);
  await broker.completeDesktopJob({ userId: connection.userId, jobId: job.id, leaseToken: first[0].leaseToken, result: { ok: true } });
  assert.deepEqual(await claim(key), [], 'acknowledged claims cannot acquire a different job');
  const next = await claim(randomUUID());
  assert.equal(next[0].id, second.id);
  await broker.completeDesktopJob({ userId: connection.userId, jobId: second.id, leaseToken: next[0].leaseToken, result: { ok: true } });
});

test('pending operations can be reconciled; duplicate completion cannot overwrite a successful result', async () => {
  const job = await enqueue();
  await assert.rejects(broker.waitForDesktopJob(job.id, 0, { leavePending: true }), error => error.code === 'MCP_OPERATION_PENDING' && error.details.operationId === job.id);
  const [leased] = await claim(randomUUID());
  const completion = { userId: connection.userId, jobId: job.id, leaseToken: leased.leaseToken, result: { ok: true, result: { id: 'created-once' } } };
  await broker.completeDesktopJob(completion);
  const replay = await broker.completeDesktopJob({ ...completion, result: { ok: false, error: 'late duplicate' } });
  assert.equal(replay.status, 'completed');
  const found = await broker.getDesktopOperation({ userId: connection.userId, connectionId: connection.id, operationId: job.id });
  assert.equal(found.result.result.id, 'created-once');
  await assert.rejects(broker.getDesktopOperation({ userId: 'different-user', connectionId: connection.id, operationId: job.id }));
  await assert.rejects(broker.getDesktopOperation({ userId: connection.userId, connectionId: 'different-connection', operationId: job.id }));
  assert.equal((await broker.waitForDesktopJob(job.id, 0, { leavePending: true })).status, 'completed', 'completion at the deadline is not a timeout');
});

test('oversize jobs fail before claim; heartbeats retain distinct environments', async () => {
  await assert.rejects(enqueue({ text: 'x'.repeat(4 * 1024 * 1024) }), /4 MiB/);
  broker.heartbeatDesktop({ ...connection, clientInstanceId: 'A' });
  broker.heartbeatDesktop({ ...connection, environmentId: 'env-B', clientInstanceId: 'B' });
  assert.equal(broker.desktopStatus(connection.userId, connection.tenantId, 'env-A').connected, true);
  assert.equal(broker.desktopStatus(connection.userId, connection.tenantId, 'env-B').connected, true);
});

test('analytics redaction omits source payloads and nested name/value secrets', () => {
  const text = JSON.stringify(redact({ source: 'password=example-secret', clientData: '{"password":"example-secret"}', nested: '{"accessToken":"example-secret"}', setting: { name: 'ClientSecret', value: 'example-secret' }, xml: '<Password>example-secret</Password>', safe: 'record-name' }));
  assert.ok(!text.includes('example-secret'));
  assert.ok(text.includes('record-name'));
});

test('desktop completion returns the acknowledged operation result', async () => {
  const source = fs.readFileSync(new URL('../src/modules/mcp/protocol.js', import.meta.url), 'utf8');
  const begin = source.indexOf('async function executeTool('), end = source.indexOf('export async function handleMcpRequest', begin);
  const context = {
    RESUMABLE_PLUGIN_TOOLS, operationContract,
    validateSchema, desktopStatus: () => ({ connected: true }), randomUUID,
    config: { mcp: { desktopTimeoutMs: 120_000 } },
    enqueueDesktopToolCall: async () => ({ id: 'job' }), waitForDesktopJob: async () => ({ result: { ok: true, result: { id: 'created-once' } } }),
    recordTransmission: async () => { throw new Error('analytics disk full'); }, logger: { warn() {} }, resultContent: value => ({ structuredContent: value, isError: false })
  };
  vm.runInNewContext(`${source.slice(begin, end)}\nthis.execute = executeTool;`, context);
  const result = await context.execute({}, connection, MCP_TOOL_BY_NAME.get('list_tables'), {}, 1);
  assert.equal(result.result.isError, false);
  assert.equal(result.result.structuredContent.id, 'created-once');
});

test('completion audit failures are observed without failing the durable result acknowledgment', async () => {
  const source = fs.readFileSync(new URL('../src/modules/mcp/broker.js', import.meta.url), 'utf8');
  const begin = source.indexOf('async function auditCompletion(');
  const end = source.indexOf('\nasync function waitForMongoDesktopJob', begin);
  let calls = 0, warnings = 0;
  const context = { setTimeout, clearTimeout,
    recordTransmission: async () => { calls++; throw new Error('analytics disk full'); },
    logger: { warn() { warnings++; } }
  };
  vm.runInNewContext(`${source.slice(begin, end)}\nthis.audit = auditCompletion;`, context);
  await context.audit({ id: 'known-completed', auditContext: connection, createdAt: new Date().toISOString() }, { ok: true, result: { id: 'created-once' } });
  assert.equal(calls, 1, 'exercise the actual completion audit, not an unused mock');
  assert.equal(warnings, 1);
});
