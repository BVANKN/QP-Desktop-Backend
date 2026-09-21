// One MCP information architecture for every product surface. The renderer
// consumes these classifications instead of maintaining its own list of tool
// names, so adding a tool to the server automatically puts it in the correct
// Gateway area as long as it follows the established naming contract.
export const GATEWAY_DOMAINS = Object.freeze([
  { id: 'dataverse', label: 'Dataverse MCP', resource: 'power-platform', combinable: true },
  { id: 'power-automate', label: 'Power Automate MCP', resource: 'power-platform', combinable: true },
  { id: 'canvas', label: 'Canvas MCP', resource: 'power-platform', combinable: true },
  { id: 'development', label: 'Development MCP', resource: 'power-platform', combinable: true },
  { id: 'alm', label: 'ALM MCP', resource: 'power-platform', combinable: true },
  { id: 'powerpages', label: 'Power Pages MCP', resource: 'powerpages', combinable: true },
  { id: 'sharepoint', label: 'SharePoint MCP', resource: 'sharepoint', combinable: true },
  { id: 'devops', label: 'Azure DevOps MCP', resource: 'devops', combinable: true }
]);

export const GATEWAY_DOMAIN_IDS = Object.freeze(GATEWAY_DOMAINS.map(item => item.id));
export const POWER_PLATFORM_GATEWAY_DOMAIN_IDS = Object.freeze(GATEWAY_DOMAINS.filter(item => item.resource === 'power-platform').map(item => item.id));
const DOMAIN_ID_SET = new Set(GATEWAY_DOMAIN_IDS);

// Capability packs are a second level of server-enforced discovery scope. They
// deliberately group workflows rather than individual tools: one Dataverse MCP
// connection can stay convenient for a user while the AI only receives the
// subset of the catalog relevant to that role/task. Add future domain packs here
// and the generic connection UI can render them without another bespoke page.
export const GATEWAY_CAPABILITY_PACKS = Object.freeze({
  dataverse: Object.freeze([
    { id: 'data', order: 10, label: 'Data', description: 'Query, search, create, update, delete, import/export, bulk, duplicate, and change-tracking operations.', sections: Object.freeze(['Rows & query']) },
    { id: 'schema', order: 20, label: 'Schema', description: 'Tables, columns, relationships, choices, alternate keys, and ER metadata.', sections: Object.freeze(['Tables', 'Columns', 'Relationships', 'Choices']) },
    { id: 'app-design', order: 30, label: 'App Design', description: 'Forms, views, and model-driven app authoring.', sections: Object.freeze(['Forms', 'Views', 'Model-driven apps']) },
    { id: 'security', order: 40, label: 'Security', description: 'Roles, teams, users, privileges, business units, field security, and record access.', sections: Object.freeze(['Security']) },
    { id: 'diagnostics', order: 50, label: 'Diagnostics', description: 'Audit, environment overview, connection status, and Dataverse API discovery.', sections: Object.freeze(['Audit', 'Environment & discovery', 'Other platform tools']) }
  ])
});

export const GATEWAY_CORE_TOOLS = Object.freeze({
  dataverse: Object.freeze([
    'get_power_platform_connection',
    'get_power_platform_operation',
    'list_tables',
    'get_table',
    'list_columns',
    'get_column'
  ])
});

const CORE_TOOLS_BY_DOMAIN = new Map(Object.entries(GATEWAY_CORE_TOOLS).map(([domain, names]) => [domain, new Set(names)]));

const PACKS_BY_DOMAIN = new Map(Object.entries(GATEWAY_CAPABILITY_PACKS));
const PACK_BY_DOMAIN_SECTION = new Map();
for (const [domain, packs] of PACKS_BY_DOMAIN.entries()) {
  const sectionMap = new Map();
  for (const pack of packs) for (const sectionName of pack.sections) sectionMap.set(sectionName, pack);
  PACK_BY_DOMAIN_SECTION.set(domain, sectionMap);
}

const section = (domain, value) => ({ domain, section: value });

function classifyPowerPlatform(name) {
  if (/canvas/.test(name)) {
    if (/control|api|data_source/.test(name)) return section('canvas', 'Controls, APIs & data');
    if (/source|pending_diff|authoring|prerequisite|disconnect/.test(name)) return section('canvas', 'Source authoring');
    return section('canvas', 'Apps');
  }
  if (/cloud_flow|flow_run|flow_connection|connection_replacement/.test(name)) {
    if (/run/.test(name)) return section('power-automate', 'Runs');
    if (/connection|replacement/.test(name)) return section('power-automate', 'Connections');
    return section('power-automate', 'Cloud flows');
  }
  if (/business_process_flow/.test(name)) return section('power-automate', 'Business process flows');
  if (/^list_plugin|^get_plugin|plugin_|choose_plugin|register_plugin|save_plugin|rollback_plugin|trace/.test(name)) return section('development', 'Plug-ins');
  if (/web_resource/.test(name)) return section('development', 'Web resources');
  if (/command_bar|ribbon/.test(name)) return section('development', 'Command bars');
  if (/solution/.test(name)) return section('alm', /publisher/.test(name) ? 'Publishers' : 'Solutions');
  if (/environment_variable/.test(name)) return section('alm', 'Environment variables');
  if (/connection_reference/.test(name)) return section('alm', 'Connection references');
  if (/dependenc/.test(name)) return section('alm', 'Dependencies');
  if (/publish_customizations/.test(name)) return section('alm', 'Publish');
  if (/organization_setting|environment_administration|environment_management/.test(name)) return section('alm', 'Environment management');
  if (/model_app|app_module/.test(name)) return section('dataverse', 'Model-driven apps');
  if (/security|role|team|privilege|business_unit|field_security|secured_column|environment_users/.test(name)) return section('dataverse', 'Security');
  if (/record_access|record_sharing|principal_record/.test(name)) return section('dataverse', 'Security');
  if (/^list_forms$|^get_form$|_form$|form_layout|form_mapping/.test(name)) return section('dataverse', 'Forms');
  if (/^list_views$|^get_view$|_view$/.test(name)) return section('dataverse', 'Views');
  if (/relationship/.test(name)) return section('dataverse', 'Relationships');
  if (/choice|option_set|optionset/.test(name)) return section('dataverse', 'Choices');
  if (/column|alternate_key/.test(name)) return section('dataverse', 'Columns');
  if (/table|er_model/.test(name)) return section('dataverse', 'Tables');
  if (/record|fetchxml|search_dataverse|dataverse_changes|duplicate|bulk|sample_data|import_data|export_data/.test(name)) return section('dataverse', 'Rows & query');
  if (/audit/.test(name)) return section('dataverse', 'Audit');
  if (/get_power_platform_operation|get_power_platform_connection|environment_overview|discover_dataverse_api/.test(name)) return section('dataverse', 'Environment & discovery');
  return section('dataverse', 'Other platform tools');
}

function classifySharePoint(name) {
  if (/operation|connection/.test(name)) return section('sharepoint', 'Connection & operations');
  if (/site/.test(name)) return section('sharepoint', 'Sites');
  if (/drive|file|folder/.test(name)) return section('sharepoint', 'Files & folders');
  if (/column/.test(name)) return section('sharepoint', 'List columns');
  if (/list_item/.test(name)) return section('sharepoint', 'List items');
  if (/list/.test(name)) return section('sharepoint', 'Lists');
  return section('sharepoint', 'Other SharePoint tools');
}

function classifyPowerPages(name) {
  if (/operation|connection/.test(name)) return section('powerpages', 'Connection & operations');
  if (/security|access/.test(name)) return section('powerpages', 'Security & access');
  if (/language/.test(name)) return section('powerpages', 'Languages');
  if (/page_tree|content|component/.test(name)) return section('powerpages', 'Pages & components');
  if (/site_setting/.test(name)) return section('powerpages', 'Site settings');
  if (/site|inventory/.test(name)) return section('powerpages', 'Sites');
  return section('powerpages', 'Other Power Pages tools');
}

function classifyDevOps(name) {
  if (/operation|connection/.test(name)) return section('devops', 'Connection & operations');
  if (/organization|project|team|people/.test(name)) return section('devops', 'Organizations & projects');
  if (/work_item|area|iteration/.test(name)) return section('devops', 'Work items');
  if (/pull_request/.test(name)) return section('devops', 'Pull requests');
  if (/repositor|branch|file|commit/.test(name)) return section('devops', 'Repos & code');
  if (/pipeline|build/.test(name)) return section('devops', 'Pipelines & builds');
  if (/wiki/.test(name)) return section('devops', 'Wiki');
  if (/test_plan/.test(name)) return section('devops', 'Test plans');
  return section('devops', 'Other Azure DevOps tools');
}

export function classifyGatewayTool(tool) {
  const name = String(tool?.name || '').toLowerCase();
  const group = String(tool?.group || 'power-platform').toLowerCase();
  if (group === 'sharepoint') return classifySharePoint(name);
  if (group === 'powerpages') return classifyPowerPages(name);
  if (group === 'devops') return classifyDevOps(name);
  return classifyPowerPlatform(name);
}

export function capabilityPackForTool(tool) {
  const gateway = classifyGatewayTool(tool);
  return PACK_BY_DOMAIN_SECTION.get(gateway.domain)?.get(gateway.section) || null;
}

export function isGatewayCoreTool(tool) {
  const gateway = classifyGatewayTool(tool);
  return CORE_TOOLS_BY_DOMAIN.get(gateway.domain)?.has(String(tool?.name || '')) || false;
}

export function gatewayTool(tool) {
  const gateway = classifyGatewayTool(tool);
  const pack = capabilityPackForTool(tool);
  return {
    ...tool,
    gatewayDomain: gateway.domain,
    gatewaySection: gateway.section,
    gatewayCore: isGatewayCoreTool(tool),
    ...(pack ? { gatewayPackId: pack.id, gatewayPackLabel: pack.label, gatewayPackDescription: pack.description, gatewayPackOrder: pack.order } : {})
  };
}

export function normalizeGatewayDomains(value, { fallback = POWER_PLATFORM_GATEWAY_DOMAIN_IDS } = {}) {
  const source = Array.isArray(value) ? value : value == null ? fallback : [value];
  const normalized = [...new Set(source.map(item => String(item || '').trim().toLowerCase()).filter(Boolean))];
  if (!normalized.length) throw new Error('Select at least one MCP gateway category.');
  const invalid = normalized.filter(id => !DOMAIN_ID_SET.has(id));
  if (invalid.length) throw new Error(`Unknown MCP gateway category: ${invalid.join(', ')}.`);
  return normalized;
}

export function normalizeGatewayPacks(value, domains) {
  const selectedDomains = normalizeGatewayDomains(domains);
  const selectedDomainSet = new Set(selectedDomains);
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const output = {};
  for (const key of Object.keys(raw)) {
    if (!selectedDomainSet.has(key)) throw new Error(`Capability packs were supplied for an unselected MCP category: ${key}.`);
    if (!PACKS_BY_DOMAIN.has(key)) throw new Error(`MCP category ${key} does not define capability packs.`);
  }
  for (const domain of selectedDomains) {
    const definitions = PACKS_BY_DOMAIN.get(domain);
    if (!definitions?.length) continue;
    const allowed = new Set(definitions.map(pack => pack.id));
    const supplied = raw[domain];
    const requested = supplied == null
      ? definitions.map(pack => pack.id)
      : [...new Set((Array.isArray(supplied) ? supplied : [supplied]).map(item => String(item || '').trim().toLowerCase()).filter(Boolean))];
    if (!requested.length) throw new Error(`Select at least one ${domain} capability pack.`);
    const invalid = requested.filter(id => !allowed.has(id));
    if (invalid.length) throw new Error(`Unknown ${domain} capability pack: ${invalid.join(', ')}.`);
    output[domain] = requested;
  }
  return output;
}

export function gatewayToolsForDomains(tools, domains) {
  const allowed = new Set(normalizeGatewayDomains(domains));
  return tools.filter(tool => allowed.has(classifyGatewayTool(tool).domain));
}

export function normalizeGatewayToolAllowlist(value, tools, domains, packs) {
  if (value == null) return null;
  const requested = [...new Set((Array.isArray(value) ? value : [value]).map(item => String(item || '').trim()).filter(Boolean))];
  if (!requested.length) throw new Error('Select at least one MCP tool.');
  const base = gatewayToolsForScope(tools, domains, packs, null);
  const allowed = new Set(base.map(tool => tool.name));
  const invalid = requested.filter(name => !allowed.has(name));
  if (invalid.length) throw new Error(`Selected MCP tools are outside this endpoint scope: ${invalid.slice(0, 8).join(', ')}${invalid.length > 8 ? '…' : ''}.`);
  return requested;
}

export function gatewayToolsForScope(tools, domains, packs, toolAllowlist = null) {
  const selectedDomains = normalizeGatewayDomains(domains);
  const allowedDomains = new Set(selectedDomains);
  const normalizedPacks = normalizeGatewayPacks(packs, selectedDomains);
  const exactNames = toolAllowlist == null ? null : new Set(normalizeGatewayToolAllowlist(toolAllowlist, tools, selectedDomains, normalizedPacks));
  return tools.filter(tool => {
    const gateway = classifyGatewayTool(tool);
    if (!allowedDomains.has(gateway.domain)) return false;
    const selectedPacks = normalizedPacks[gateway.domain];
    const packAllowed = !selectedPacks || isGatewayCoreTool(tool) || Boolean(capabilityPackForTool(tool) && selectedPacks.includes(capabilityPackForTool(tool).id));
    if (!packAllowed) return false;
    return !exactNames || exactNames.has(tool.name);
  });
}

export function gatewayScopeSummary(tools, domains, packs, toolAllowlist = null) {
  const selected = normalizeGatewayDomains(domains);
  const normalizedPacks = normalizeGatewayPacks(packs, selected);
  const normalizedTools = normalizeGatewayToolAllowlist(toolAllowlist, tools, selected, normalizedPacks);
  const scopedTools = gatewayToolsForScope(tools, selected, normalizedPacks, normalizedTools);
  const counts = Object.fromEntries(selected.map(id => [id, 0]));
  const packCounts = {};
  const coreCounts = {};
  for (const tool of scopedTools) {
    const gateway = classifyGatewayTool(tool);
    counts[gateway.domain] += 1;
    if (isGatewayCoreTool(tool)) coreCounts[gateway.domain] = (coreCounts[gateway.domain] || 0) + 1;
    const pack = capabilityPackForTool(tool);
    if (pack) {
      packCounts[gateway.domain] ||= {};
      packCounts[gateway.domain][pack.id] = (packCounts[gateway.domain][pack.id] || 0) + 1;
    }
  }
  return {
    type: selected.length === 1 ? 'category' : 'combined',
    domains: selected,
    packs: normalizedPacks,
    toolAllowlist: normalizedTools,
    totalTools: scopedTools.length,
    counts,
    packCounts,
    coreCounts
  };
}
