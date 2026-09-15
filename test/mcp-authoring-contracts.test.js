import test from 'node:test';
import assert from 'node:assert/strict';
import { MCP_TOOL_BY_NAME } from '../src/modules/mcp/tool-catalog.js';
import { validateSchema } from '../src/modules/mcp/schema-validator.js';
import { operationContract } from '../src/modules/mcp/operation-contract.js';

const check = (name, args) => validateSchema(MCP_TOOL_BY_NAME.get(name).inputSchema, args);
test('BPF creation requires one complete route, not missing or mixed artifacts', () => {
  const designer = { name: 'Flow', authoringMode: 'designer', primaryTable: 'account', uniqueName: 'new_flow', solutionUniqueName: 'Solution', stages: [{ name: 'Review', steps: [{ name: 'Name', column: 'name', required: true }] }] };
  for (const args of [designer, { name: 'Flow', templateWorkflowId: 'template' }, { name: 'Flow', primaryTable: 'account', uniqueName: 'new_flow', xaml: '<Activity/>', clientData: { stages: [] } }, { resumeOperationId: 'existing-operation' }]) assert.deepEqual(check('create_business_process_flow', args), []);
  for (const args of [{ name: 'Flow' }, { name: 'Flow', xaml: '<Activity/>' }, { ...designer, activate: true }, { ...designer, xaml: '<Activity/>' }, { ...designer, templateWorkflowId: 'template' }, { ...designer, stages: [] }]) assert(check('create_business_process_flow', args).length, JSON.stringify(args));
  assert.equal(MCP_TOOL_BY_NAME.get('complete_business_process_flow_creation').risk, 'read');
  assert.deepEqual(check('list_business_process_flow_templates', { primaryTable: 'account' }), []);
});

test('image operations and scoped inventory expose their actual desktop fields', () => {
  const args = { stepId: 'step', name: 'Before', entityAlias: 'Before', imageType: 0, attributes: 'name', confirm: true };
  assert.deepEqual(check('save_plugin_step_image', args), []);
  assert(check('save_plugin_step_image', { ...args, imageType: 3 }).length);
  assert(check('save_plugin_step_image', { stepId: 'step', confirm: true }).length);
  assert.deepEqual(check('list_plugin_registrations', { assemblyId: 'assembly' }), []);
  assert.deepEqual(check('get_plugin_registration', { kind: 'image', id: 'image' }), []);
  assert.equal(MCP_TOOL_BY_NAME.get('get_plugin_registration').risk, 'read');
  assert.equal(MCP_TOOL_BY_NAME.get('rollback_plugin_registration').risk, 'destructive');
  assert(check('rollback_plugin_registration', { rollbackToken: 'rollback' }).length);
  assert.deepEqual(check('rollback_plugin_registration', { resumeOperationId: 'existing' }), []);
  assert(check('rollback_plugin_registration', { resumeOperationId: 'existing', rollbackToken: 'rollback' }).length);
});

test('online isolation schema rejects None and accepts Sandbox', () => {
  for (const name of ['register_plugin_artifact', 'update_plugin_assembly_binary']) {
    const args = { artifactToken: 'artifact', confirm: true, ...(name.startsWith('update') ? { assemblyId: 'assembly' } : {}) };
    assert.deepEqual(check(name, { ...args, isolationMode: 2 }), []);
    assert(check(name, { ...args, isolationMode: 1 }).length);
  }
});

test('completed job with pending verification remains actionable without implying deployment success', () => {
  const output = { id: 'step', rollbackToken: 'rollback', writeSucceeded: true, verification: 'pending', requiresVerification: true, nextTool: 'get_plugin_registration', nextArguments: { kind: 'step', id: 'step' } };
  const result = operationContract({ operationId: 'operation', toolName: 'save_plugin_step', status: 'completed', result: { ok: true, result: output } }, 'power-platform');
  assert.equal(result.output, output);
  assert.equal(result.pending, false);
  assert.match(result.guidance, /Do not repeat the write/);
  assert.match(result.guidance, /preserve the component ID/);
  const handoff = operationContract({ operationId: 'creation', toolName: 'create_business_process_flow', status: 'completed', result: { ok: true, result: { requiresUserAction: true, message: 'Save the BPF in the designer.' } } }, 'power-platform');
  assert.match(handoff.guidance, /designer/);
});
