import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_TOOLS, publicTool } from '../src/modules/mcp/tool-catalog.js';
import {
  GATEWAY_CAPABILITY_PACKS,
  GATEWAY_DOMAIN_IDS,
  capabilityPackForTool,
  isGatewayCoreTool,
  gatewayToolsForDomains,
  gatewayToolsForScope,
  normalizeGatewayDomains,
  normalizeGatewayPacks,
  normalizeGatewayToolAllowlist
} from '../src/modules/mcp/gateway-taxonomy.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('every category endpoint has a strict non-empty subset and combined gateway covers the catalog', () => {
  const seen = new Set();
  for (const id of GATEWAY_DOMAIN_IDS) {
    const scoped = gatewayToolsForDomains(MCP_TOOLS, [id]);
    assert.ok(scoped.length > 0, `${id} must expose tools`);
    assert.ok(scoped.length < MCP_TOOLS.length, `${id} must not expose the whole catalog`);
    for (const tool of scoped) seen.add(tool.name);
  }
  assert.equal(seen.size, MCP_TOOLS.length);
  assert.equal(gatewayToolsForDomains(MCP_TOOLS, GATEWAY_DOMAIN_IDS).length, MCP_TOOLS.length);
});

test('gateway domain normalization rejects widening typos and deduplicates', () => {
  assert.deepEqual(normalizeGatewayDomains(['dataverse', 'dataverse', 'alm']), ['dataverse', 'alm']);
  assert.throws(() => normalizeGatewayDomains(['dataverse', 'not-a-domain']), /Unknown MCP gateway category/);
  assert.throws(() => normalizeGatewayDomains([]), /Select at least one/);
});

test('Dataverse capability packs cover the catalog while each scoped endpoint also keeps essential core tools', () => {
  const dataverse = gatewayToolsForDomains(MCP_TOOLS, ['dataverse']);
  const packs = GATEWAY_CAPABILITY_PACKS.dataverse;
  assert.deepEqual(packs.map(pack => pack.id), ['data', 'schema', 'app-design', 'security', 'diagnostics']);
  const assigned = new Set();
  const coreNames = new Set(dataverse.filter(isGatewayCoreTool).map(tool => tool.name));
  assert.ok(coreNames.size > 0, 'Dataverse endpoints need continuation and metadata core tools');
  for (const pack of packs) {
    const scoped = gatewayToolsForScope(MCP_TOOLS, ['dataverse'], { dataverse: [pack.id] });
    assert.ok(scoped.length > 0, `${pack.id} must expose tools`);
    assert.ok(scoped.length < dataverse.length, `${pack.id} must be smaller than full Dataverse`);
    for (const coreName of coreNames) assert.ok(scoped.some(tool => tool.name === coreName), `${pack.id} must retain core tool ${coreName}`);
    for (const tool of scoped.filter(item => !isGatewayCoreTool(item))) {
      assert.equal(capabilityPackForTool(tool)?.id, pack.id);
      assert.equal(assigned.has(tool.name), false, `${tool.name} must belong to one capability pack`);
      assigned.add(tool.name);
    }
  }
  const nonCore = dataverse.filter(tool => !isGatewayCoreTool(tool));
  assert.equal(assigned.size, nonCore.length);
  assert.equal(gatewayToolsForScope(MCP_TOOLS, ['dataverse']).length, dataverse.length, 'omitted pack selection must preserve full Dataverse for backward compatibility');
  assert.deepEqual(normalizeGatewayPacks({ dataverse: ['schema', 'schema', 'data'] }, ['dataverse']), { dataverse: ['schema', 'data'] });
  assert.throws(() => normalizeGatewayPacks({ dataverse: [] }, ['dataverse']), /at least one dataverse capability pack/i);
  assert.throws(() => normalizeGatewayPacks({ dataverse: ['unknown'] }, ['dataverse']), /Unknown dataverse capability pack/);
});


test('exact tool allowlists further reduce a category endpoint without widening its pack or domain scope', () => {
  const requested = ['query_records', 'execute_fetchxml', 'get_table'];
  const normalized = normalizeGatewayToolAllowlist(requested, MCP_TOOLS, ['dataverse'], null);
  assert.deepEqual(normalized, requested);
  const scoped = gatewayToolsForScope(MCP_TOOLS, ['dataverse'], null, requested);
  assert.deepEqual(scoped.map(tool => tool.name).sort(), [...requested].sort());
  assert.throws(() => normalizeGatewayToolAllowlist(['list_cloud_flows'], MCP_TOOLS, ['dataverse'], null), /outside this endpoint scope/i);
  assert.throws(() => normalizeGatewayToolAllowlist([], MCP_TOOLS, ['dataverse'], null), /at least one MCP tool/i);
});

test('single-category descriptors remove executionMode and use risk-aware fixed execution while combined descriptors retain it', () => {
  const tool = MCP_TOOLS.find(item => item.name === 'create_table');
  const readTool = MCP_TOOLS.find(item => item.name === 'list_tables');
  const fixedWrite = publicTool(tool, { includeExecutionMode: false, fixedExecutionMode: 'automatic' });
  const fixedRead = publicTool(readTool, { includeExecutionMode: false, fixedExecutionMode: 'automatic' });
  assert.equal(Object.hasOwn(fixedWrite.inputSchema?.properties || {}, 'executionMode'), false);
  assert.equal(fixedWrite._meta?.['quickerportal/executionPolicy']?.fixedMode, 'verified');
  assert.equal(fixedRead._meta?.['quickerportal/executionPolicy']?.fixedMode, 'simple');
  assert.equal(Object.hasOwn(publicTool(tool).inputSchema?.properties || {}, 'executionMode'), true);
});


test('connection records persist exact tool scope and expose an authenticated scope-update route', () => {
  const connections = read('src/modules/mcp/connections.js');
  const routes = read('src/modules/mcp/routes.js');
  const protocol = read('src/modules/mcp/protocol.js');
  assert.match(connections, /toolAllowlist:\s*Array\.isArray\(connection\.toolAllowlist\)/);
  assert.match(connections, /setMcpConnectionToolScope/);
  assert.match(routes, /\/api\/mcp\/connections\/:connectionId\/tool-scope/);
  assert.match(protocol, /Array\.isArray\(connection\.toolAllowlist\)/);
  assert.match(protocol, /connection\.toolAllowlist\.includes\(tool\.name\)/);
});

test('gateway protocol enforces domain and capability-pack scope at tools/list and tools/call', () => {
  const protocol = read('src/modules/mcp/protocol.js');
  assert.match(protocol, /toolsForConnection\(connection, resourceKind\)/);
  assert.match(protocol, /gatewayToolsForScope\(MCP_TOOLS, domains, packs, connection\.toolAllowlist\)/);
  assert.match(protocol, /normalizeGatewayPacks\(connection\.gatewayPacks, domains\)/);
  assert.match(protocol, /scopedResourceTools\.some\(item => item\.name === requestedName\)/);
  assert.match(protocol, /toolAllowed\(tool, connection\.toolPolicy\)/);
  assert.match(protocol, /includeExecutionMode: allowExecutionMode/);
});
