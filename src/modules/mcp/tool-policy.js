/**
 * What an MCP connection is allowed to reach.
 *
 * Risk alone was never enough to answer the question people actually ask
 * before connecting an AI client: "can it read my customers?" A tool that
 * reads a table's columns and a tool that reads the rows in it are both
 * read-only, and treating them the same is why an all-or-nothing switch is not
 * a real answer.
 *
 * So there are two axes. The subject is what a tool touches - business
 * records, schema, apps, automation, security, solutions - and is turned on or
 * off. The ceiling is how far any enabled subject may go: read, write, or
 * delete. A tool runs only if its subject is enabled and its risk is within the
 * ceiling, which means "let it read everything but change nothing" and "let it
 * build apps but never touch customer data" are both expressible.
 */

export const RISK_ORDER = Object.freeze({ read: 0, write: 1, destructive: 2 });
export const CEILINGS = Object.freeze(['read', 'write', 'destructive']);

export const SUBJECTS = Object.freeze([
  {
    id: 'data',
    label: 'Business data',
    hint: 'Rows in your tables - accounts, contacts, cases and anything else your organisation stores.',
    caution: 'This is the only subject that reaches customer data. Everything else is configuration.'
  },
  { id: 'schema', label: 'Schema', hint: 'Tables, columns, relationships, choices and keys.' },
  { id: 'apps', label: 'Apps and UI', hint: 'Forms, views, model-driven apps, sitemaps, command bars, dashboards and charts.' },
  { id: 'automation', label: 'Automation and code', hint: 'Cloud flows, business process flows, plug-ins, web resources and scripts.' },
  { id: 'security', label: 'Security', hint: 'Roles, teams, users, field security and record sharing.' },
  { id: 'alm', label: 'Solutions and ALM', hint: 'Solutions, publishing, dependencies, environment variables and connection references.' },
  { id: 'canvas', label: 'Canvas apps', hint: 'Canvas app source and live authoring sessions.' },
  { id: 'powerpages', label: 'Power Pages', hint: 'Power Pages sites, components and administration.' },
  { id: 'sharepoint', label: 'SharePoint', hint: 'SharePoint sites, lists and documents.' },
  { id: 'diagnostics', label: 'Diagnostics', hint: 'Connection checks, operation polling and environment overviews. No customer data.' }
]);

const SUBJECT_IDS = new Set(SUBJECTS.map(subject => subject.id));

/**
 * Ordered subject rules, most specific first.
 *
 * Order matters: `get_power_platform_operation` is a diagnostic even though it
 * contains "operation", and `grant_record_access` is security even though it
 * contains "record". Matching top to bottom keeps those readable rather than
 * demanding ever more contorted expressions.
 */
const SUBJECT_RULES = [
  // Deliberately small. Withholding these would leave a client unable to tell a
  // restriction from an outage, so it would report the restriction as a fault.
  // Everything else, including anything that returns configuration, is subject
  // to the policy like the rest.
  [/^(get_power_platform_operation|get_sharepoint_operation|get_power_pages_operation)$/, 'diagnostics'],
  [/^(environment_overview|discover_dataverse_api)$/, 'diagnostics'],
  [/connection$/, 'diagnostics'],

  // Audit history carries the old and new values of records, so it reaches
  // business data however much it looks like a diagnostic.
  [/^get_audit_/, 'data'],
  [/^(get_organization_settings|update_organization_setting|get_environment_administration|update_environment_management_setting)$/, 'alm'],

  [/access|sharing|principal|security|business_unit|^list_environment_users$|role|team|privilege/, 'security'],
  [/canvas/, 'canvas'],
  [/power_pages/, 'powerpages'],
  [/sharepoint/, 'sharepoint'],

  [/record|^query_records$|^execute_fetchxml$|bulk|sample_data|^search_dataverse$|^get_dataverse_changes$|^find_duplicate|import_data|export_data/, 'data'],
  [/solution|publish|dependenc|environment_variable|connection_reference|connection_replacement|pipeline/, 'alm'],
  [/flow|workflow|business_process|plugin|web_resource|webresource|script|trace/, 'automation'],
  [/form|view|sitemap|model_app|app_module|command_bar|ribbon|dashboard|chart|er_model/, 'apps'],
  [/table|column|relationship|choice|option_set|optionset|alternate_key|metadata/, 'schema']
];

/** The subject a tool belongs to. Never guesses: an unmatched tool is data. */
export function subjectFor(tool) {
  const name = String(tool?.name || '');
  if (tool?.group === 'sharepoint') return 'sharepoint';
  if (tool?.group === 'powerpages') return 'powerpages';
  for (const [pattern, subject] of SUBJECT_RULES) {
    if (pattern.test(name)) return subject;
  }
  // Anything a rule does not recognise is treated as reaching business data,
  // because that is the assumption that fails safe: a new tool is withheld
  // from a connection that was told it could not read records, rather than
  // quietly allowed because nobody classified it.
  return 'data';
}

export const DEFAULT_POLICY = Object.freeze({
  enabled: false,
  subjects: Object.freeze(SUBJECTS.map(subject => subject.id).filter(id => id !== 'data')),
  ceiling: 'write'
});

export function normalizePolicy(input) {
  if (!input || typeof input !== 'object') return { ...DEFAULT_POLICY, subjects: [...DEFAULT_POLICY.subjects] };
  const requested = Array.isArray(input.subjects) ? input.subjects : [];
  const subjects = [...new Set(requested.map(entry => String(entry || '').trim().toLowerCase()))].filter(id => SUBJECT_IDS.has(id));
  const ceiling = CEILINGS.includes(String(input.ceiling || '').toLowerCase()) ? String(input.ceiling).toLowerCase() : DEFAULT_POLICY.ceiling;
  return { enabled: input.enabled === true, subjects, ceiling };
}

/**
 * Whether one tool may run under a policy.
 *
 * Diagnostics are never withheld. A client that cannot ask whether the desktop
 * is connected cannot tell a restriction from an outage, and would report the
 * restriction as a fault.
 */
export function toolAllowed(tool, policy) {
  const active = normalizePolicy(policy);
  if (!active.enabled) return { allowed: true, subject: subjectFor(tool) };
  const subject = subjectFor(tool);
  if (subject === 'diagnostics') return { allowed: true, subject };
  if (!active.subjects.includes(subject)) {
    return { allowed: false, subject, reason: 'subject', detail: `${labelFor(subject)} tools are turned off for this MCP connection.` };
  }
  const risk = String(tool?.risk || 'read');
  if ((RISK_ORDER[risk] ?? 0) > (RISK_ORDER[active.ceiling] ?? 1)) {
    return {
      allowed: false,
      subject,
      reason: 'ceiling',
      detail: `This MCP connection allows ${active.ceiling === 'read' ? 'reading only' : active.ceiling === 'write' ? 'reading and writing, but not deleting' : 'everything'}, and this tool is ${risk === 'destructive' ? 'a delete' : 'a write'}.`
    };
  }
  return { allowed: true, subject };
}

export function labelFor(subjectId) {
  return SUBJECTS.find(subject => subject.id === subjectId)?.label || subjectId;
}

/** What a policy actually permits, for showing someone before they save it. */
export function summarizePolicy(tools, policy) {
  const active = normalizePolicy(policy);
  const bySubject = new Map(SUBJECTS.map(subject => [subject.id, { ...subject, total: 0, allowed: 0, byRisk: { read: 0, write: 0, destructive: 0 } }]));
  let allowed = 0;
  for (const tool of tools) {
    const subject = subjectFor(tool);
    const entry = bySubject.get(subject);
    if (!entry) continue;
    entry.total += 1;
    if (toolAllowed(tool, active).allowed) {
      entry.allowed += 1;
      entry.byRisk[tool.risk] = (entry.byRisk[tool.risk] || 0) + 1;
      allowed += 1;
    }
  }
  return {
    policy: active,
    totalTools: tools.length,
    allowedTools: allowed,
    withheldTools: tools.length - allowed,
    subjects: [...bySubject.values()]
  };
}
