import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { EXECUTION_MODES, executionModeSchema, normalizeExecutionMode, splitExecutionArguments } from '../src/modules/mcp/execution-mode.js';
import { operationContract, resumableSchema } from '../src/modules/mcp/operation-contract.js';
import { MCP_TOOL_BY_NAME, MCP_TOOLS, publicTool } from '../src/modules/mcp/tool-catalog.js';

test('every MCP tool exposes the shared three-mode execution policy', () => {
  assert.deepEqual(EXECUTION_MODES, ['simple', 'verified', 'autonomous']);
  for (const tool of MCP_TOOLS) {
    const exposed = publicTool(tool);
    assert.deepEqual(exposed.inputSchema.properties.executionMode.enum, EXECUTION_MODES, tool.name);
    assert.match(exposed.inputSchema.properties.executionMode.description, /reconcile|uncertain|verification/i, tool.name);
    assert.deepEqual(exposed._meta['quickerportal/executionPolicy'].supportedModes, EXECUTION_MODES, tool.name);
    assert.equal(exposed._meta['quickerportal/executionPolicy'].defaultMode, tool.risk === 'read' ? 'simple' : 'verified', tool.name);
    assert.equal(exposed._meta['quickerportal/executionPolicy'].uncertainMutationRule, 'reconcile-before-retry', tool.name);
    assert.equal(normalizeExecutionMode(undefined, tool), tool.risk === 'read' ? 'simple' : 'verified', tool.name);
  }
});

test('execution mode is orchestration metadata and never leaks into desktop arguments', () => {
  const tool = MCP_TOOL_BY_NAME.get('patch_cloud_flow');
  const result = splitExecutionArguments({ workflowId: '00000000-0000-0000-0000-000000000001', executionMode: 'AUTONOMOUS' }, tool);
  assert.equal(result.mode, 'autonomous');
  assert.equal(Object.hasOwn(result.arguments, 'executionMode'), false);
  assert.equal(result.arguments.workflowId, '00000000-0000-0000-0000-000000000001');
});

test('resumable tools allow mode propagation without reopening the original mutation payload', () => {
  const schema = executionModeSchema(resumableSchema({
    type: 'object',
    properties: { artifactToken: { type: 'string' } },
    required: ['artifactToken'],
    additionalProperties: false
  }));
  assert.equal(schema.then.maxProperties, 2);
  assert.deepEqual(schema.then.propertyNames.enum, ['resumeOperationId', 'executionMode']);
});

test('uncertain accepted writes remain pending and explicitly require reconciliation before retry', () => {
  const contract = operationContract({
    operationId: 'op-1',
    status: 'outcome_unknown',
    toolName: 'patch_cloud_flow',
    result: null
  }, 'powerplatform');
  assert.equal(contract.pending, true);
  assert.equal(contract.outcomeUncertain, true);
  assert.equal(contract.reconcileBeforeRetry, true);
  assert.equal(contract.nextAction, 'poll');
});

test('expired unreconciled operations are terminal without pretending the mutation failed', () => {
  const contract = operationContract({
    operationId: 'op-2',
    status: 'expired_unreconciled',
    toolName: 'patch_cloud_flow',
    result: null,
    guidance: 'Reconcile current platform state before any new mutation.'
  }, 'powerplatform');
  assert.equal(contract.pending, false);
  assert.equal(contract.output, undefined);
  assert.match(contract.guidance, /Reconcile/i);
});

test('forensic schema/runtime drift regressions stay fixed in the public catalog', () => {
  const fetch = publicTool(MCP_TOOL_BY_NAME.get('execute_fetchxml')).inputSchema;
  assert.deepEqual(fetch.required, ['fetchXml']);
  assert.equal(Object.hasOwn(fetch.properties, 'entitySetName'), false);

  const publisher = publicTool(MCP_TOOL_BY_NAME.get('create_solution_publisher')).inputSchema;
  for (const key of ['customizationOptionValuePrefix', 'supportingWebsiteUrl']) assert.ok(publisher.properties[key], key);

  const inventory = publicTool(MCP_TOOL_BY_NAME.get('get_solution_inventory')).inputSchema;
  assert.ok(inventory.properties.solutionId);
  assert.ok(inventory.properties.uniqueName);

  const columns = publicTool(MCP_TOOL_BY_NAME.get('list_all_columns')).inputSchema;
  assert.deepEqual(columns.required, ['tableLogicalName']);
  assert.equal(columns.properties.pageSize.maximum, 500);

  const resources = publicTool(MCP_TOOL_BY_NAME.get('list_web_resources')).inputSchema;
  assert.equal(resources.properties.pageSize.maximum, 500);
  assert.ok(resources.properties.nextLink);

  const pluginCatalog = publicTool(MCP_TOOL_BY_NAME.get('list_plugin_registrations')).inputSchema;
  assert.deepEqual(pluginCatalog.properties.purpose.enum, ['inventory', 'register', 'updateAssembly', 'webhook', 'image', 'step']);
});

test('environment-variable state mutation remains quarantined until its destructive live regression is proven safe', () => {
  const tool = MCP_TOOL_BY_NAME.get('set_environment_variable_state');
  assert.equal(tool.quarantined, true);
  assert.match(tool.quarantineReason, /default-value|safety|acceptance/i);
});

test('operation contracts expose queue, handler and total timings without conflating them', () => {
  const contract = operationContract({
    operationId: 'op-timing',
    status: 'completed',
    toolName: 'get_table',
    createdAt: '2026-09-20T00:00:00.000Z',
    claimedAt: '2026-09-20T00:00:00.125Z',
    completedAt: '2026-09-20T00:00:00.700Z',
    result: { ok: true, result: { value: {}, _desktopExecution: { handlerMs: 420 } } }
  }, 'powerplatform');
  assert.deepEqual(contract.timings, { queueMs: 125, totalMs: 700, handlerMs: 420 });
});


test('result-budget overflow never encourages replay of a completed mutation', () => {
  const source = fs.readFileSync(new URL('../src/modules/mcp/protocol.js', import.meta.url), 'utf8');
  assert.match(source, /mutationCompleted = Boolean\(tool && tool\.risk !== 'read'\)/);
  assert.match(source, /writeSucceeded: true/);
  assert.match(source, /retrySafe: false/);
  assert.match(source, /isError: !mutationCompleted/);
  assert.match(source, /Do not repeat the mutation/);
});

test('list_tables exposes bounded pagination instead of an unbounded environment inventory', () => {
  const exposed = publicTool(MCP_TOOL_BY_NAME.get('list_tables'));
  assert.equal(exposed.inputSchema.properties.pageSize.minimum, 1);
  assert.equal(exposed.inputSchema.properties.pageSize.maximum, 200);
  assert.equal(exposed.inputSchema.properties.cursor.type, 'string');
  assert.equal(exposed.inputSchema.properties.search.type, 'string');
  assert.equal(exposed.inputSchema.properties.customOnly.type, 'boolean');
  assert.match(exposed.description, /bounded|pageable/i);
});
