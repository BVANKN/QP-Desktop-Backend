import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_TOOLS, publicTool } from '../src/modules/mcp/tool-catalog.js';
import { capabilityPackForTool, gatewayToolsForDomains, gatewayToolsForScope } from '../src/modules/mcp/gateway-taxonomy.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('bulk schema tool is exposed as a Dataverse schema capability and on combined gateway', () => {
  const tool = MCP_TOOLS.find(item => item.name === 'bulk_apply_dataverse_schema');
  assert.ok(tool, 'bulk schema tool must exist');
  assert.equal(tool.action, 'bulkApplyDataverseSchema');
  assert.equal(tool.risk, 'write');
  assert.ok(tool.timeoutMs >= 1_800_000, 'bulk schema tool needs a long queue/approval expiry');
  assert.ok(tool.leaseMs >= tool.timeoutMs, 'desktop lease must cover the long-running bulk job');
  assert.equal(capabilityPackForTool(tool)?.id, 'schema');
  assert.ok(gatewayToolsForDomains(MCP_TOOLS, ['dataverse']).some(item => item.name === tool.name));
  assert.ok(gatewayToolsForDomains(MCP_TOOLS, ['dataverse','alm']).some(item => item.name === tool.name));
  assert.ok(gatewayToolsForScope(MCP_TOOLS, ['dataverse'], { dataverse: ['schema'] }).some(item => item.name === tool.name));
  assert.equal(gatewayToolsForScope(MCP_TOOLS, ['dataverse'], { dataverse: ['data'] }).some(item => item.name === tool.name), false);
});

test('bulk schema MCP contract advertises project-first usage, staging, and bounded schema shapes', () => {
  const tool = MCP_TOOLS.find(item => item.name === 'bulk_apply_dataverse_schema');
  const schema = tool.inputSchema;
  assert.deepEqual(schema.properties.operation.enum, ['start','stage','append','execute','discard']);
  assert.deepEqual(schema.properties.strategy.enum, ['auto','direct','solution']);
  assert.equal(schema.properties.schema.properties.tables.maxItems, 50);
  assert.equal(schema.properties.schema.properties.columns.maxItems, 1000);
  assert.equal(schema.properties.schema.properties.relationships.maxItems, 500);
  assert.match(tool.description, /PREFERRED tool/i);
  assert.match(tool.description, /multi-table Dataverse schema|entire project model/i);
  assert.match(tool.description, /stage\/append/i);
});

test('single-category Dataverse endpoint keeps bulk tool mode automatic while combined endpoint exposes executionMode', () => {
  const tool = MCP_TOOLS.find(item => item.name === 'bulk_apply_dataverse_schema');
  const scoped = publicTool(tool, { includeExecutionMode: false, fixedExecutionMode: 'automatic' });
  const combined = publicTool(tool, { includeExecutionMode: true });
  assert.equal(Object.hasOwn(scoped.inputSchema.properties || {}, 'executionMode'), false);
  assert.equal(scoped._meta['quickerportal/executionPolicy'].fixedMode, 'verified');
  assert.equal(Object.hasOwn(combined.inputSchema.properties || {}, 'executionMode'), true);
});

test('long-running bulk jobs persist per-tool leases and protocol tells Dataverse endpoints to prefer the bulk tool', () => {
  const broker = read('src/modules/mcp/broker.js');
  const protocol = read('src/modules/mcp/protocol.js');
  const guidance = read('src/modules/mcp/power-platform-authoring.js');
  assert.match(broker, /leaseMs:\s*Math\.max\(DEFAULT_LEASE_MS/);
  assert.match(broker, /job\.leaseMs/);
  assert.match(protocol, /DATAVERSE_BULK_SCHEMA_GUIDANCE/);
  assert.match(protocol, /includes\('dataverse'\)/);
  assert.match(guidance, /prefer bulk_apply_dataverse_schema/i);
});
