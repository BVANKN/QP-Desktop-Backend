import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { MCP_TOOL_BY_NAME, publicTool } from '../src/modules/mcp/tool-catalog.js';

const expected = {
  edit_form_layout: { action: 'patchComponentDesigner', required: ['id', 'layoutOperations', 'expectedRevision'] },
  patch_cloud_flow: { action: 'patchFlowDefinition', required: ['workflowId', 'operations', 'expectedRevision'] },
  patch_form: { action: 'patchComponentDesigner', required: ['id', 'edits', 'expectedRevision'] },
  patch_view: { action: 'patchComponentDesigner', required: ['id', 'expectedRevision'] },
  patch_web_resource: { action: 'patchWebResource', required: ['webResourceId', 'edits', 'expectedRevision'] }
};

test('MCP publishes targeted artifact mutation tools with write semantics', () => {
  for (const [name, contract] of Object.entries(expected)) {
    const tool = MCP_TOOL_BY_NAME.get(name);
    assert.ok(tool, `${name} must be published`);
    assert.equal(tool.action, contract.action);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.deepEqual(tool.inputSchema.required, contract.required);
    assert.match(tool.description, /read|desktop/i);
    const exposed = publicTool(tool);
    assert.equal(exposed._meta['quickerportal/action'], contract.action);
    assert.deepEqual(exposed.securitySchemes[0].scopes, ['mcp:write']);
  }
});

test('targeted tools bound operation counts and expose stale-write revisions', () => {
  const flow = MCP_TOOL_BY_NAME.get('patch_cloud_flow').inputSchema;
  assert.equal(flow.properties.operations.minItems, 1);
  assert.equal(flow.properties.operations.maxItems, 128);
  assert.ok(flow.properties.expectedRevision);
  assert.deepEqual(flow.properties.operations.items.properties.op.enum, ['add', 'set', 'replace', 'remove', 'merge', 'test']);

  for (const name of ['edit_form_layout', 'patch_form', 'patch_view', 'patch_web_resource']) {
    assert.ok(MCP_TOOL_BY_NAME.get(name).inputSchema.properties.expectedRevision, `${name} must support optimistic concurrency`);
  }
});

test('semantic form layout tool exposes bounded typed operations instead of raw FormXML', () => {
  const tool = MCP_TOOL_BY_NAME.get('edit_form_layout');
  assert.ok(tool);
  assert.match(tool.description, /tabs, sections, and fields/i);
  assert.equal(tool.inputSchema.properties.layoutOperations.minItems, 1);
  assert.equal(tool.inputSchema.properties.layoutOperations.maxItems, 200);
  const variants = tool.inputSchema.properties.layoutOperations.items.oneOf;
  assert.deepEqual(variants.map(item => item.properties.op.const), ['ensureTab', 'ensureSection', 'placeField', 'renameTab', 'renameSection']);
  assert.match(MCP_TOOL_BY_NAME.get('patch_form').description, /escape hatch/i);
});

test('complete replacements are clearly demoted to import and recovery', () => {
  for (const name of ['update_cloud_flow', 'update_form', 'update_view', 'update_web_resource']) {
    assert.match(MCP_TOOL_BY_NAME.get(name).description, /prefer patch_/i);
  }
});

test('server initialization tells models not to request complete existing artifacts', () => {
  const protocol = fs.readFileSync(new URL('../src/modules/mcp/protocol.js', import.meta.url), 'utf8');
  assert.match(protocol, /never ask the user for a complete artifact/i);
  assert.match(protocol, /PCF changes belong in source files/i);
  assert.match(protocol, /read-modify-validate-write/i);
});
