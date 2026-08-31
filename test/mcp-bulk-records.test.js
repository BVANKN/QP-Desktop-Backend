import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { MCP_TOOL_BY_NAME, publicTool } from '../src/modules/mcp/tool-catalog.js';

const protocolSource = fs.readFileSync(new URL('../src/modules/mcp/protocol.js', import.meta.url), 'utf8');

test('bulk record creation is one bounded write tool', () => {
  const definition = MCP_TOOL_BY_NAME.get('create_records');
  assert.ok(definition, 'create_records must be advertised to MCP clients');
  assert.equal(definition.action, 'mcpCreateRecords');
  assert.equal(definition.risk, 'write');
  assert.equal(definition.inputSchema.properties.records.type, 'array');
  assert.equal(definition.inputSchema.properties.records.minItems, 1);
  assert.equal(definition.inputSchema.properties.records.maxItems, 1000);
  assert.deepEqual(definition.inputSchema.required, ['tableLogicalName', 'records']);
  assert.match(definition.description, /one approval/i);

  const advertised = publicTool(definition);
  assert.equal(advertised.annotations.readOnlyHint, false);
  assert.equal(advertised._meta['quickerportal/action'], 'mcpCreateRecords');
  assert.equal(advertised._meta['quickerportal/risk'], 'write');
});

test('single record creation remains available for genuinely singular writes', () => {
  const definition = MCP_TOOL_BY_NAME.get('create_record');
  assert.ok(definition);
  assert.equal(definition.action, 'mcpCreateRecord');
  assert.equal(definition.inputSchema.properties.values.type, 'object');
});

test('server instructions direct agents to one bulk operation', () => {
  assert.match(protocolSource, /two or more rows[\s\S]*always use create_records once/i);
  assert.match(protocolSource, /instead of repeatedly calling create_record/i);
});
