import test from 'node:test';
import assert from 'node:assert/strict';
import { MCP_TOOLS } from '../src/modules/mcp/tool-catalog.js';
import { GATEWAY_DOMAINS, capabilityPackForTool, classifyGatewayTool } from '../src/modules/mcp/gateway-taxonomy.js';

test('every advertised MCP tool has exactly one Gateway domain and section', () => {
  const domains = new Set(GATEWAY_DOMAINS.map(item => item.id));
  assert.equal(domains.size, GATEWAY_DOMAINS.length);
  for (const tool of MCP_TOOLS) {
    const classified = classifyGatewayTool(tool);
    assert.ok(domains.has(classified.domain), `${tool.name}: unknown domain ${classified.domain}`);
    assert.ok(classified.section, `${tool.name}: missing section`);
  }
});

test('core Power Platform families land in the intended Gateway areas', () => {
  const byName = new Map(MCP_TOOLS.map(tool => [tool.name, tool]));
  const expect = (name, domain, gatewaySection) => assert.deepEqual(classifyGatewayTool(byName.get(name)), { domain, section: gatewaySection });
  expect('create_table', 'dataverse', 'Tables');
  expect('edit_form_layout', 'dataverse', 'Forms');
  expect('create_cloud_flow', 'power-automate', 'Cloud flows');
  expect('create_business_process_flow', 'power-automate', 'Business process flows');
  expect('patch_canvas_source_file', 'canvas', 'Source authoring');
  expect('register_plugin_artifact', 'development', 'Plug-ins');
  expect('create_web_resource', 'development', 'Web resources');
  expect('create_solution', 'alm', 'Solutions');
  expect('create_environment_variable', 'alm', 'Environment variables');
  expect('list_power_pages_sites', 'powerpages', 'Sites');
  expect('list_sharepoint_sites', 'sharepoint', 'Sites');
  expect('query_devops_work_items', 'devops', 'Work items');
});


test('every Dataverse tool belongs to a capability pack', () => {
  for (const tool of MCP_TOOLS) {
    const classified = classifyGatewayTool(tool);
    if (classified.domain !== 'dataverse') continue;
    assert.ok(capabilityPackForTool(tool)?.id, `${tool.name}: missing Dataverse capability pack`);
  }
});
