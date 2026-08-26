import test from 'node:test';
import assert from 'node:assert/strict';
import { MCP_TOOL_BY_NAME, MCP_TOOLS, publicTool } from '../src/modules/mcp/tool-catalog.js';

const commandTools = [
  'list_command_bar_controls',
  'get_command_bar_control',
  'preview_command_bar_change',
  'create_command_bar_control',
  'clone_command_bar_control',
  'update_command_bar_control',
  'replace_command_bar_rules',
  'hide_command_bar_control',
  'unhide_command_bar_control',
  'delete_custom_command_bar_control',
  'rollback_command_bar_deployment'
];

test('command-bar MCP tools are typed, uniquely named, and risk classified', () => {
  assert.equal(new Set(MCP_TOOLS.map(tool => tool.name)).size, MCP_TOOLS.length);
  for (const name of commandTools) {
    const tool = MCP_TOOL_BY_NAME.get(name);
    assert.ok(tool, `${name} is missing`);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    const advertised = publicTool(tool);
    assert.equal(advertised.annotations.openWorldHint, false);
    assert.equal(advertised._meta['quickerportal/execution'], 'connected-desktop');
  }
  assert.equal(MCP_TOOL_BY_NAME.get('list_command_bar_controls').risk, 'read');
  assert.ok(MCP_TOOL_BY_NAME.get('list_command_bar_controls').timeoutMs >= 90_000);
  assert.equal(MCP_TOOL_BY_NAME.get('preview_command_bar_change').risk, 'read');
  assert.equal(MCP_TOOL_BY_NAME.get('update_command_bar_control').risk, 'write');
  assert.equal(MCP_TOOL_BY_NAME.get('delete_custom_command_bar_control').risk, 'destructive');
  assert.equal(MCP_TOOL_BY_NAME.get('rollback_command_bar_deployment').risk, 'destructive');
});

test('semantic command mutations cannot accept an operation override', () => {
  for (const name of commandTools.filter(name => !['list_command_bar_controls', 'get_command_bar_control', 'preview_command_bar_change', 'rollback_command_bar_deployment'].includes(name))) {
    const tool = MCP_TOOL_BY_NAME.get(name);
    assert.ok(tool.fixedArguments?.operation, `${name} must pin its operation server-side`);
    assert.equal(tool.inputSchema.properties.operation, undefined, `${name} must not let an MCP caller override the operation`);
  }
});

test('rule and action schemas expose discoverable parameters to MCP clients', () => {
  const create = MCP_TOOL_BY_NAME.get('create_command_bar_control');
  const command = create.inputSchema.properties.command;
  assert.deepEqual(command.properties.surface.enum, ['mainGrid', 'mainForm', 'subgrid', 'associated']);
  assert.ok(command.properties.action.properties.parameters.items.properties.value.description.includes('PrimaryControl'));
  assert.match(command.description, /displayRules/);

  const rules = MCP_TOOL_BY_NAME.get('replace_command_bar_rules').inputSchema.properties.displayRules;
  assert.ok(rules.items.properties.type.enum.includes('CustomRule'));
  assert.ok(rules.maxItems <= 32);
});

test('tool discovery metadata remains within its regression budget', () => {
  const advertised = MCP_TOOLS.map(publicTool);
  const totalBytes = Buffer.byteLength(JSON.stringify({ tools: advertised }));
  const largest = Math.max(...advertised.map(item => Buffer.byteLength(JSON.stringify(item))));
  // Discovery is byte-paginated by protocol.js at 48 KiB. The aggregate
  // ceiling still catches accidental schema explosions while allowing the
  // targeted flow/form/view/web-resource mutation contracts.
  assert.ok(totalBytes < 96 * 1024, `MCP catalog regressed to ${totalBytes} bytes.`);
  assert.ok(largest < 8 * 1024, `An individual MCP tool descriptor regressed to ${largest} bytes.`);
});
