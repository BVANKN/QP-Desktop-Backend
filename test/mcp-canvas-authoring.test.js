import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { MCP_TOOL_BY_NAME, publicTool } from '../src/modules/mcp/tool-catalog.js';

const readTools = [
  'get_canvas_authoring_status',
  'sync_canvas_authoring_source',
  'get_canvas_authoring_operation',
  'list_canvas_source_files',
  'read_canvas_source_file',
  'search_canvas_source',
  'get_canvas_pending_diff',
  'list_canvas_controls',
  'describe_canvas_control',
  'list_canvas_apis',
  'describe_canvas_api',
  'list_canvas_data_sources',
  'get_canvas_data_source_schema'
];

test('Canvas authoring tools are stable QP wrappers over desktop actions', () => {
  for (const name of readTools) {
    const tool = MCP_TOOL_BY_NAME.get(name);
    assert.ok(tool, `${name} must be published`);
    assert.equal(tool.annotations.readOnlyHint, true, `${name} must request only mcp:read`);
    assert.deepEqual(publicTool(tool).securitySchemes[0].scopes, ['mcp:read']);
  }

  for (const name of ['connect_canvas_authoring', 'patch_canvas_source_file', 'apply_canvas_authoring_changes']) {
    const tool = MCP_TOOL_BY_NAME.get(name);
    assert.ok(tool, `${name} must be published`);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.deepEqual(publicTool(tool).securitySchemes[0].scopes, ['mcp:write']);
  }
});

test('Canvas patches are targeted, revision protected, and bounded', () => {
  const patch = MCP_TOOL_BY_NAME.get('patch_canvas_source_file');
  assert.equal(patch.action, 'canvasAuthoringPatchFile');
  assert.deepEqual(patch.inputSchema.required, ['appId', 'path', 'expectedRevision', 'edits']);
  assert.equal(patch.inputSchema.properties.edits.minItems, 1);
  assert.equal(patch.inputSchema.properties.edits.maxItems, 128);
  assert.match(patch.description, /never ask the user for the whole app/i);
  assert.equal(patch.inputSchema.properties.studioUrl, undefined, 'MCP clients must not transmit Designer URLs');
});

test('long Canvas operations return IDs and require explicit verification polling', () => {
  const connect = MCP_TOOL_BY_NAME.get('connect_canvas_authoring');
  const sync = MCP_TOOL_BY_NAME.get('sync_canvas_authoring_source');
  const apply = MCP_TOOL_BY_NAME.get('apply_canvas_authoring_changes');
  const poll = MCP_TOOL_BY_NAME.get('get_canvas_authoring_operation');
  for (const tool of [connect, sync, apply]) assert.match(tool.description, /operation ID/i);
  assert.match(apply.description, /verified/i);
  assert.equal(poll.action, 'canvasAuthoringOperation');
});

test('Canvas discovery tools pin only allowlisted Microsoft read capabilities', () => {
  const mapping = {
    list_canvas_controls: 'list_controls',
    describe_canvas_control: 'describe_control',
    list_canvas_apis: 'list_apis',
    describe_canvas_api: 'describe_api',
    list_canvas_data_sources: 'list_data_sources',
    get_canvas_data_source_schema: 'get_data_source_schema'
  };
  for (const [name, microsoftName] of Object.entries(mapping)) {
    const tool = MCP_TOOL_BY_NAME.get(name);
    assert.equal(tool.action, 'canvasAuthoringDiscovery');
    assert.deepEqual(tool.fixedArguments, { toolName: microsoftName });
  }
});

test('MCP instructions separate Canvas compilation from canonical verification', () => {
  const protocol = fs.readFileSync(new URL('../src/modules/mcp/protocol.js', import.meta.url), 'utf8');
  assert.match(protocol, /never claim the Canvas app was updated unless.*verified=true/i);
  assert.match(protocol, /compile success without canonical verification is not success/i);
  assert.match(protocol, /list\/read\/search the current \.pa\.yaml source/i);
});
