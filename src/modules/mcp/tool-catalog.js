// MCP-facing capability catalog. Each tool maps to an existing privileged
// Electron action; the desktop remains the Dataverse security boundary.
const string = description => ({ type: 'string', description });
const boolean = description => ({ type: 'boolean', description });
const number = (description, extra = {}) => ({ type: 'number', description, ...extra });
const array = (items, description, extra = {}) => ({ type: 'array', items, description, ...extra });
const object = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
});

function tool(name, action, description, inputSchema = object(), options = {}) {
  const readOnly = options.readOnly !== false;
  return Object.freeze({
    name,
    action,
    description,
    inputSchema,
    annotations: {
      title: options.title || name.split('_').map(word => word[0].toUpperCase() + word.slice(1)).join(' '),
      readOnlyHint: readOnly,
      destructiveHint: Boolean(options.destructive),
      idempotentHint: Boolean(options.idempotent),
      openWorldHint: false
    },
    risk: options.destructive ? 'destructive' : readOnly ? 'read' : 'write',
    fixedArguments: options.fixedArguments || undefined,
    argumentEnvelope: options.argumentEnvelope || undefined,
    timeoutMs: options.timeoutMs || 55_000
  });
}

const tableName = string('Dataverse table logical name, for example account or new_project.');
const columnName = string('Dataverse column logical name.');
const recordId = string('Dataverse record GUID.');
const confirm = boolean('Must be true after the user explicitly approves this destructive operation.');
const arbitraryPayload = { type: 'object', description: 'Dataverse values keyed by logical column name.', additionalProperties: true };
const jsonPatchOperation = {
  type: 'object',
  description: 'One targeted JSON operation. Paths are RFC 6901 JSON Pointers into the exact document returned by the read tool.',
  properties: {
    op: { type: 'string', enum: ['add', 'set', 'replace', 'remove', 'merge', 'test'], description: 'test verifies a value; add requires a missing key; set upserts; replace/remove require an existing target; merge recursively updates an object.' },
    path: string('RFC 6901 JSON Pointer, for example /properties/definition/actions/Get_account/inputs/parameters/$top.'),
    value: { description: 'JSON value used by add, set, replace, merge, or test.' }
  },
  required: ['op', 'path'],
  additionalProperties: false
};
const anchoredTextEdit = object({
  mode: { type: 'string', enum: ['replace', 'append', 'prepend'], description: 'Use replace for normal edits. Append/prepend are available for intentional boundary insertions.' },
  oldText: string('Exact current text anchor. It must occur exactly once unless expectedOccurrences is supplied.'),
  newText: string('Replacement text. Use an empty string to delete the anchor.'),
  text: string('Text for append or prepend mode.'),
  expectedOccurrences: number('Exact number of anchors that must match before replacement.', { minimum: 1 })
});
const revision = string('Optional SHA-256 revision returned by the corresponding read tool. If supplied, a stale write is rejected.');
// Canvas authoring has many small, purpose-specific tools. Keep their repeated
// fields compact so the paged tools/list response stays inexpensive without
// sacrificing the operation-specific guidance models need.
const canvasAppId = string('Canvas app GUID.');
const canvasPath = string('Relative .pa.yaml source path.');
const canvasContext = { appId: canvasAppId };
const canvasAnchoredEdit = object({
  mode: { type: 'string', enum: ['replace', 'append', 'prepend'] },
  oldText: string('Exact current anchor for replace.'),
  newText: string('Replacement text.'),
  text: string('Text for append/prepend.'),
  expectedOccurrences: number('Required anchor count.', { minimum: 1 })
});
const commandSurface = { type: 'string', enum: ['mainGrid', 'mainForm', 'subgrid', 'associated'], description: 'Supported model-driven app command-bar surface.' };
const commandParameter = object({
  type: { type: 'string', enum: ['CrmParameter', 'StringParameter', 'BoolParameter', 'IntParameter', 'DecimalParameter'], description: 'Ribbon command parameter element type.' },
  name: string('Parameter name. Required for URL parameters.'),
  value: string('Serialized parameter value. CrmParameter values include PrimaryControl, SelectedControl, SelectedControlSelectedItemIds, and PrimaryEntityTypeName.')
}, ['type', 'value']);
const commandAction = object({
  type: { type: 'string', enum: ['javascript', 'url'], description: 'Command action type.' },
  library: string('JavaScript web resource name, for example $webresource:new_/commands.js.'),
  functionName: string('JavaScript function to invoke.'),
  url: string('Absolute HTTPS URL for a URL action.'),
  parameters: array(commandParameter, 'Ordered action parameters.', { maxItems: 24 })
}, ['type']);
const commandRuleType = {
  type: 'string',
  enum: ['EntityRule', 'FormStateRule', 'FormTypeRule', 'SelectionCountRule', 'ValueRule', 'EntityPrivilegeRule', 'RecordPrivilegeRule', 'EntityPropertyRule', 'OrganizationSettingRule', 'CustomRule'],
  description: 'Classic ribbon rule condition.'
};
const commandRule = {
  type: 'object',
  description: 'One rule. Besides type, use the rule-specific fields returned by get_command_bar_control (for example field/value, minimum/maximum, privilegeType, or library/functionName/parameters).',
  properties: { type: commandRuleType },
  required: ['type'],
  additionalProperties: true
};
const commandDefinitionProperties = {
  name: string('Unique command name used to generate stable RibbonDiffXml identifiers.'),
  label: string('Visible command label.'),
  surface: commandSurface,
  action: commandAction
};
const createCommandDefinition = {
  type: 'object',
  description: 'Command definition. Required: name, label, surface, action. Optional: prefix, description, sequence, controlType, image16, image32, displayRules, and enableRules.',
  properties: commandDefinitionProperties,
  required: ['name', 'label', 'surface', 'action'],
  additionalProperties: true
};
const cloneCommandDefinition = {
  type: 'object',
  description: 'Clone overrides. name is required; optional properties match create_command_bar_control.command.',
  properties: {
    name: commandDefinitionProperties.name,
    label: commandDefinitionProperties.label,
    surface: commandDefinitionProperties.surface,
    sequence: number('New placement sequence.', { minimum: 1 })
  },
  required: ['name'],
  additionalProperties: true
};
const commandChanges = {
  type: 'object',
  description: 'Fields to replace. Supports label, description, surface, sequence, image16, image32, action, displayRules, and enableRules. Rule arrays replace the complete corresponding set; omitted fields are preserved.',
  properties: {
    label: string('New visible label.'),
    surface: commandSurface,
    sequence: number('New placement sequence.', { minimum: 1 }),
    action: commandAction
  },
  additionalProperties: true
};
const commandChangeContext = {
  logicalName: tableName,
  solutionUniqueName: string('Unmanaged solution unique name that owns the command-bar customization.'),
  controlId: string('Exact command-bar control identifier.'),
  changes: commandChanges,
  displayRules: array(commandRule, 'Complete replacement display-rule set.', { maxItems: 32 }),
  enableRules: array(commandRule, 'Complete replacement enable-rule set.', { maxItems: 32 }),
  copyRules: boolean('When cloning, copy supported display and enable rules from the source command.'),
  surface: commandSurface,
  includeXml: boolean('Include generated RibbonDiffXml in preview output. Leave false for smaller MCP responses.'),
  confirm: boolean('Must be true after explicit user approval of deployment and publish.')
};
const commandPreviewMutation = {
  type: 'object',
  description: 'Operation-specific payload. create: command. clone: controlId, optional surface/command/copyRules. update: controlId/changes. rules: controlId and displayRules and/or enableRules. hide, unhide, or delete: controlId. includeXml is optional for every operation.',
  additionalProperties: true
};

export const MCP_TOOLS = Object.freeze([
  tool('environment_overview', 'environmentInsights', 'Summarize tables, flows, solutions, applications, security, and governance signals in the connected environment.'),
  tool('list_tables', 'tables', 'List Dataverse table metadata in the connected environment.', object({ force: boolean('Bypass the desktop metadata cache.') })),
  tool('get_table', 'tableDetail', 'Get detailed metadata for one Dataverse table.', object({ logicalName: tableName }, ['logicalName'])),
  tool('get_table_schema', 'tableSchemaDetails', 'Get a table schema package including columns, relationships, forms, and views.', object({ logicalName: tableName }, ['logicalName'])),
  tool('list_columns', 'columns', 'List columns for one Dataverse table.', object({ logicalName: tableName }, ['logicalName'])),
  tool('list_all_columns', 'allColumns', 'List columns across all tables. Prefer list_columns when the table is known.'),
  tool('get_column', 'columnDetail', 'Get detailed metadata for one Dataverse column.', object({ tableLogicalName: tableName, columnLogicalName: columnName }, ['tableLogicalName', 'columnLogicalName'])),
  tool('get_er_model', 'erDiagramMetadata', 'Get environment-wide Dataverse relationship metadata for ER analysis.'),
  tool('get_component_dependencies', 'componentRelated', 'Get dependencies and related components for a Power Platform component.', object({ componentType: number('Dataverse solution component type.'), objectId: string('Component GUID.') }, ['componentType', 'objectId'])),

  tool('list_forms', 'developerAssets', 'List model-driven system forms, optionally filtered to one table.', object({ tableLogicalName: tableName }), { fixedArguments: { kind: 'forms' } }),
  tool('get_form', 'developerAssetDetail', 'Get a form including its FormXML, ownership, managed state, and dependencies.', object({ id: string('System form GUID.') }, ['id']), { fixedArguments: { kind: 'forms' } }),
  tool('patch_form', 'patchComponentDesigner', 'Preferred form editor: read the latest FormXML on the desktop, apply exact anchored edits, validate it, and conditionally save it with rollback. Do not ask the user to provide complete FormXML.', object({ id: string('System form GUID.'), edits: array(anchoredTextEdit, 'Ordered edits against the current FormXML.', { minItems: 1, maxItems: 128 }), expectedRevision: revision, name: string('Optional form name.'), description: string('Optional description.'), publish: boolean('Publish the owning table after save.') }, ['id', 'edits']), { readOnly: false, idempotent: true, fixedArguments: { kind: 'forms' } }),
  tool('update_form', 'saveComponentDesigner', 'Complete FormXML replacement for import/recovery scenarios. Prefer patch_form for normal changes so current content is preserved.', object({ id: string('System form GUID.'), formXml: string('Complete FormXML with a form root element.'), name: string('Optional form name.'), description: string('Optional description.'), publish: boolean('Publish the owning table after save.') }, ['id', 'formXml']), { readOnly: false, idempotent: true, fixedArguments: { kind: 'forms' } }),
  tool('publish_form', 'publishComponentDesigner', 'Publish the table customizations containing a system form.', object({ id: string('System form GUID.'), target: tableName, confirm: boolean('Confirm publishing this form.') }, ['id', 'confirm']), { readOnly: false, idempotent: true, fixedArguments: { kind: 'forms' } }),
  tool('list_views', 'developerAssets', 'List system views, optionally filtered to one table.', object({ tableLogicalName: tableName }), { fixedArguments: { kind: 'views' } }),
  tool('get_view', 'developerAssetDetail', 'Get a system view including FetchXML and LayoutXML.', object({ id: string('Saved query GUID.') }, ['id']), { fixedArguments: { kind: 'views' } }),
  tool('patch_view', 'patchComponentDesigner', 'Preferred view editor: read the latest FetchXML/LayoutXML on the desktop, apply targeted exact edits, validate both documents, and conditionally save with rollback. Supply at least one edit array; never reconstruct unchanged XML.', object({ id: string('Saved query GUID.'), fetchXmlEdits: array(anchoredTextEdit, 'Ordered edits against current FetchXML.', { minItems: 1, maxItems: 128 }), layoutXmlEdits: array(anchoredTextEdit, 'Ordered edits against current LayoutXML.', { minItems: 1, maxItems: 128 }), expectedRevision: revision, name: string('Optional view name.'), description: string('Optional description.'), publish: boolean('Publish the owning table after save.') }, ['id']), { readOnly: false, idempotent: true, fixedArguments: { kind: 'views' } }),
  tool('update_view', 'saveComponentDesigner', 'Complete FetchXML and LayoutXML replacement for import/recovery scenarios. Prefer patch_view for normal changes.', object({ id: string('Saved query GUID.'), fetchXml: string('Complete FetchXML query.'), layoutXml: string('Complete view grid LayoutXML.'), name: string('Optional view name.'), description: string('Optional description.'), publish: boolean('Publish the owning table after save.') }, ['id', 'fetchXml', 'layoutXml']), { readOnly: false, idempotent: true, fixedArguments: { kind: 'views' } }),
  tool('publish_view', 'publishComponentDesigner', 'Publish the table customizations containing a system view.', object({ id: string('Saved query GUID.'), target: tableName, confirm: boolean('Confirm publishing this view.') }, ['id', 'confirm']), { readOnly: false, idempotent: true, fixedArguments: { kind: 'views' } }),
  tool('list_canvas_apps', 'developerAssets', 'List Canvas apps available through Dataverse metadata.', object(), { fixedArguments: { kind: 'canvasApps' } }),
  tool('get_canvas_app', 'developerAssetDetail', 'Get Canvas app metadata and related component details.', object({ id: string('Canvas app GUID.') }, ['id']), { fixedArguments: { kind: 'canvasApps' } }),
  tool('get_canvas_authoring_status', 'canvasAuthoringStatus', 'Get Canvas prerequisites, connection, baseline, pending changes, and operations.', object({ ...canvasContext, appName: string('Optional display name.') }, ['appId'])),
  tool('connect_canvas_authoring', 'canvasAuthoringStartConnect', 'Connect in the background to this app open in coauthoring-enabled Studio. Returns an operation ID to poll.', object({ ...canvasContext, appName: string('Optional display name.') }, ['appId']), { readOnly: false, timeoutMs: 55_000 }),
  tool('sync_canvas_authoring_source', 'canvasAuthoringStartSync', 'Sync authoritative live source before reads or edits. Returns an operation ID to poll.', object({ ...canvasContext, appName: string('Optional display name.') }, ['appId']), { timeoutMs: 55_000 }),
  tool('get_canvas_authoring_operation', 'canvasAuthoringOperation', 'Get progress/result for a Canvas operation.', object({ ...canvasContext, operationId: string('Start-operation ID; omit for latest.') }, ['appId'])),
  tool('list_canvas_source_files', 'canvasAuthoringFiles', 'List synchronized .pa.yaml files, revisions, sizes, and change states.', object(canvasContext, ['appId'])),
  tool('read_canvas_source_file', 'canvasAuthoringReadFile', 'Read current Canvas YAML and its write revision (maximum 2,000 lines).', object({ ...canvasContext, path: canvasPath, startLine: number('First line.', { minimum: 1 }), endLine: number('Inclusive last line.', { minimum: 1 }) }, ['appId', 'path'])),
  tool('search_canvas_source', 'canvasAuthoringSearch', 'Search current Canvas YAML before editing.', object({ ...canvasContext, query: string('Text or regex.'), isRegex: boolean('Regex mode.'), caseSensitive: boolean('Case-sensitive mode.'), maxResults: number('1–500 matches.', { minimum: 1, maximum: 500 }) }, ['appId', 'query'])),
  tool('patch_canvas_source_file', 'canvasAuthoringPatchFile', 'Preferred targeted Canvas editor with stale-revision protection. Never ask the user for the whole app. Use create=true and revision "new" only for a new .pa.yaml file.', object({ ...canvasContext, path: canvasPath, expectedRevision: string('Latest read revision, or "new".'), create: boolean('Create a missing file.'), edits: array(canvasAnchoredEdit, 'Ordered exact edits.', { minItems: 1, maxItems: 128 }) }, ['appId', 'path', 'expectedRevision', 'edits']), { readOnly: false, idempotent: true, timeoutMs: 55_000 }),
  tool('delete_canvas_source_file', 'canvasAuthoringDeleteFile', 'Delete one current-revision .pa.yaml file; _EditorState is protected.', object({ ...canvasContext, path: canvasPath, expectedRevision: string('Latest read revision.'), confirm }, ['appId', 'path', 'expectedRevision', 'confirm']), { readOnly: false, destructive: true, timeoutMs: 55_000 }),
  tool('get_canvas_pending_diff', 'canvasAuthoringDiff', 'Summarize pending source changes; path adds exact before/after source.', object({ ...canvasContext, path: canvasPath }, ['appId'])),
  tool('apply_canvas_authoring_changes', 'canvasAuthoringStartCompile', 'Validate, apply, and canonical re-sync in the background. Returns an operation ID; success requires result.verified=true.', object(canvasContext, ['appId']), { readOnly: false, timeoutMs: 55_000 }),
  tool('discard_canvas_pending_changes', 'canvasAuthoringDiscard', 'Restore the synchronized local baseline without changing the live app.', object({ ...canvasContext, confirm }, ['appId', 'confirm']), { readOnly: false, destructive: true, timeoutMs: 55_000 }),
  tool('list_canvas_controls', 'canvasAuthoringDiscovery', 'List current Microsoft Canvas controls.', object(canvasContext, ['appId']), { fixedArguments: { toolName: 'list_controls' } }),
  tool('describe_canvas_control', 'canvasAuthoringDiscovery', 'Describe one listed Canvas control.', object({ ...canvasContext, name: string('Exact control name.') }, ['appId', 'name']), { fixedArguments: { toolName: 'describe_control' } }),
  tool('list_canvas_apis', 'canvasAuthoringDiscovery', 'List current Canvas APIs/connectors.', object(canvasContext, ['appId']), { fixedArguments: { toolName: 'list_apis' } }),
  tool('describe_canvas_api', 'canvasAuthoringDiscovery', 'Describe one listed Canvas API.', object({ ...canvasContext, name: string('Exact API name.') }, ['appId', 'name']), { fixedArguments: { toolName: 'describe_api' } }),
  tool('list_canvas_data_sources', 'canvasAuthoringDiscovery', 'List the live app data sources.', object(canvasContext, ['appId']), { fixedArguments: { toolName: 'list_data_sources' } }),
  tool('get_canvas_data_source_schema', 'canvasAuthoringDiscovery', 'Get one listed data-source schema.', object({ ...canvasContext, name: string('Exact data-source name.') }, ['appId', 'name']), { fixedArguments: { toolName: 'get_data_source_schema' } }),

  tool('query_records', 'mcpQueryRecords', 'Read Dataverse rows with bounded OData query options. Use select to minimize transmitted data.', object({
    tableLogicalName: tableName,
    select: { type: 'array', items: columnName, maxItems: 100, description: 'Columns to return.' },
    filter: string('OData filter expression. The desktop validates length and rejects URL injection.'),
    orderBy: string('OData orderby expression.'),
    top: number('Maximum rows, from 1 to 5000.', { minimum: 1, maximum: 5000 }),
    includeFormattedValues: boolean('Include Dataverse formatted-value annotations.')
  }, ['tableLogicalName'])),
  tool('execute_fetchxml', 'fetchxml', 'Execute FetchXML against the connected environment with Dataverse paging.', object({ fetchXml: string('Complete FetchXML query.'), pageSize: number('Rows per page, from 1 to 5000.', { minimum: 1, maximum: 5000 }) }, ['fetchXml'])),
  tool('create_record', 'mcpCreateRecord', 'Create one Dataverse row. Returns the created record identifier.', object({ tableLogicalName: tableName, values: arbitraryPayload }, ['tableLogicalName', 'values']), { readOnly: false }),
  tool('update_record', 'mcpUpdateRecord', 'Update selected values on one Dataverse row.', object({ tableLogicalName: tableName, recordId, values: arbitraryPayload }, ['tableLogicalName', 'recordId', 'values']), { readOnly: false, idempotent: true }),
  tool('delete_record', 'mcpDeleteRecord', 'Permanently delete one Dataverse row after explicit approval.', object({ tableLogicalName: tableName, recordId, confirm }, ['tableLogicalName', 'recordId', 'confirm']), { readOnly: false, destructive: true }),

  tool('create_table', 'createTable', 'Create a custom Dataverse table from the supplied table definition.', object({ definition: arbitraryPayload }, ['definition']), { readOnly: false }),
  tool('update_table', 'updateTable', 'Update supported metadata for a custom Dataverse table.', object({ logicalName: tableName, changes: arbitraryPayload }, ['logicalName', 'changes']), { readOnly: false, idempotent: true }),
  tool('delete_table', 'deleteTable', 'Delete a custom Dataverse table after explicit approval.', object({ logicalName: tableName, confirm }, ['logicalName', 'confirm']), { readOnly: false, destructive: true }),
  tool('create_column', 'createColumn', 'Create a Dataverse column on a custom table.', object({ tableLogicalName: tableName, definition: arbitraryPayload }, ['tableLogicalName', 'definition']), { readOnly: false }),
  tool('update_column', 'updateColumn', 'Update supported metadata for a Dataverse column.', object({ tableLogicalName: tableName, columnLogicalName: columnName, changes: arbitraryPayload }, ['tableLogicalName', 'columnLogicalName', 'changes']), { readOnly: false, idempotent: true }),
  tool('delete_column', 'deleteColumn', 'Delete a custom Dataverse column after explicit approval.', object({ tableLogicalName: tableName, columnLogicalName: columnName, confirm }, ['tableLogicalName', 'columnLogicalName', 'confirm']), { readOnly: false, destructive: true }),
  tool('publish_customizations', 'publishAll', 'Publish all pending Dataverse customizations.', object({ confirm: boolean('Confirm publishing changes for the connected environment.') }, ['confirm']), { readOnly: false, idempotent: true, timeoutMs: 90_000 }),

  tool('list_cloud_flows', 'flows', 'List Power Automate cloud flows available in the environment.'),
  tool('get_cloud_flow', 'flowDetail', 'Get a cloud flow definition, connection references, status, and metadata.', object({ workflowId: string('Cloud flow workflow GUID.') }, ['workflowId'])),
  tool('create_cloud_flow', 'createFlow', 'Create a cloud flow from clientdata/definition metadata. Create it disabled unless the user explicitly requests activation.', object({ name: string('Flow display name.'), definition: arbitraryPayload, connectionReferences: arbitraryPayload, activate: boolean('Activate after creation.') }, ['name', 'definition']), { readOnly: false, timeoutMs: 90_000 }),
  tool('patch_cloud_flow', 'patchFlowDefinition', 'Preferred flow editor: the desktop reads current clientdata, applies targeted JSON operations, validates the flow, and conditionally saves it. Never ask the user to paste or return the complete workflow JSON.', object({ workflowId: string('Cloud flow workflow GUID.'), operations: array(jsonPatchOperation, 'Ordered targeted operations against clientdata returned by get_cloud_flow.', { minItems: 1, maxItems: 128 }), expectedRevision: revision, name: string('Optional new display name.'), description: string('Optional new description.') }, ['workflowId', 'operations']), { readOnly: false, idempotent: true, timeoutMs: 90_000 }),
  tool('update_cloud_flow', 'updateFlow', 'Update flow metadata or completely replace its definition for import/recovery. Prefer patch_cloud_flow for existing-flow logic changes; complete workflow JSON is not required for targeted edits.', object({ workflowId: string('Cloud flow workflow GUID.'), definition: arbitraryPayload, connectionReferences: arbitraryPayload, name: string('Optional new display name.'), description: string('Optional new description.') }, ['workflowId']), { readOnly: false, idempotent: true, timeoutMs: 90_000 }),
  tool('set_cloud_flow_state', 'setFlowState', 'Enable or disable a cloud flow.', object({ workflowId: string('Cloud flow workflow GUID.'), enabled: boolean('True to enable, false to disable.'), confirm: boolean('Confirm changing the live flow state.') }, ['workflowId', 'enabled', 'confirm']), { readOnly: false, idempotent: true }),
  tool('delete_cloud_flow', 'deleteFlow', 'Delete an unmanaged cloud flow after explicit approval.', object({ workflowId: string('Cloud flow workflow GUID.'), confirm }, ['workflowId', 'confirm']), { readOnly: false, destructive: true }),

  tool('list_solutions', 'solutions', 'List Power Platform solutions and their layer metadata.'),
  tool('get_solution', 'solutionDetail', 'Get details for one Power Platform solution.', object({ solutionId: string('Solution GUID.'), uniqueName: string('Solution unique name.') })),
  tool('get_solution_inventory', 'solutionInventory', 'Inventory components inside one solution.', object({ solutionId: string('Solution GUID.'), uniqueName: string('Solution unique name.') })),
  tool('update_solution_version', 'updateSolutionVersion', 'Update the version of an unmanaged solution.', object({ solutionId: string('Solution GUID.'), version: string('Four-part solution version.') }, ['solutionId', 'version']), { readOnly: false, idempotent: true }),
  tool('export_solution', 'exportSolution', 'Export a solution through Dataverse. The resulting archive remains on the user desktop.', object({ uniqueName: string('Solution unique name.'), managed: boolean('Export as managed.') }, ['uniqueName']), { readOnly: false, timeoutMs: 120_000 }),

  tool('list_model_apps', 'mdaApps', 'List model-driven applications in the environment.'),
  tool('get_model_app', 'mdaAppDetail', 'Get model-driven app metadata, navigation components, access, and branding.', object({ appModuleId: string('App module GUID.') }, ['appModuleId'])),
  tool('create_model_app', 'createMdaApp', 'Create a model-driven app shell.', object({ name: string('App display name.'), uniqueName: string('App unique name.'), description: string('App description.') }, ['name', 'uniqueName']), { readOnly: false }),
  tool('update_model_app', 'updateMdaApp', 'Update editable model-driven app metadata.', object({ appModuleId: string('App module GUID.'), changes: arbitraryPayload }, ['appModuleId', 'changes']), { readOnly: false, idempotent: true }),
  tool('publish_model_app', 'publishMdaApp', 'Publish a model-driven app.', object({ appModuleId: string('App module GUID.'), confirm: boolean('Confirm publishing this application.') }, ['appModuleId', 'confirm']), { readOnly: false, idempotent: true, timeoutMs: 90_000 }),
  tool('open_model_app', 'openMdaApp', 'Open a model-driven app in the restricted Quicker Portal browser on the connected desktop.', object({ appModuleId: string('App module GUID.'), appUrl: string('Optional known app URL.') }, ['appModuleId']), { readOnly: false }),

  tool('list_web_resources', 'webResources', 'List web resources, with type and managed-state metadata.'),
  tool('get_web_resource', 'webResourceDetail', 'Get one web resource including decoded source when supported.', object({ webResourceId: string('Web resource GUID.') }, ['webResourceId'])),
  tool('get_web_resource_usage', 'webResourceUsage', 'Find forms and other components that use a web resource.', object({ webResourceId: string('Web resource GUID.') }, ['webResourceId'])),
  tool('patch_web_resource', 'patchWebResource', 'Preferred text web-resource editor: the desktop reads current decoded source, applies unique exact-anchor edits, conditionally saves, and optionally publishes. Do not send the complete existing file.', object({ webResourceId: string('Web resource GUID.'), edits: array(anchoredTextEdit, 'Ordered source edits.', { minItems: 1, maxItems: 128 }), expectedRevision: revision, name: string('Optional web resource name.'), displayName: string('Optional display name.'), description: string('Optional description.'), publish: boolean('Publish after a successful save.') }, ['webResourceId', 'edits']), { readOnly: false, idempotent: true }),
  tool('update_web_resource', 'updateWebResource', 'Complete source replacement for import/recovery. Prefer patch_web_resource for normal code edits so unchanged source is preserved.', object({ webResourceId: string('Web resource GUID.'), name: string('Web resource name.'), content: string('Complete UTF-8 source content before Dataverse encoding.'), displayName: string('Display name.'), description: string('Optional description.') }, ['webResourceId', 'content']), { readOnly: false, idempotent: true }),
  tool('publish_web_resource', 'publishWebResource', 'Publish one web resource.', object({ webResourceId: string('Web resource GUID.'), confirm: boolean('Confirm publishing this web resource.') }, ['webResourceId', 'confirm']), { readOnly: false, idempotent: true }),
  tool('add_web_resource_to_form', 'applyWebResourceFormRegistration', 'Register a JavaScript web resource and handler on a model-driven form event.', object({ webResourceId: string('Web resource GUID.'), formId: string('System form GUID.'), event: string('Form event, such as onload or onsave.'), functionName: string('JavaScript function name.'), passExecutionContext: boolean('Pass execution context to the handler.'), confirm: boolean('Confirm changing the form XML.') }, ['webResourceId', 'formId', 'event', 'functionName', 'confirm']), { readOnly: false }),

  tool('list_connection_references', 'connectionReferences', 'List connection references and binding status.'),
  tool('get_connection_reference', 'connectionReferenceDetail', 'Get a connection reference, dependencies, and using flows.', object({ connectionReferenceId: string('Connection reference GUID.') }, ['connectionReferenceId'])),
  tool('update_connection_reference', 'updateConnectionReference', 'Update an unmanaged connection reference.', object({ connectionReferenceId: string('Connection reference GUID.'), changes: arbitraryPayload }, ['connectionReferenceId', 'changes']), { readOnly: false, idempotent: true }),
  tool('list_environment_variables', 'environmentVariables', 'List environment variable definitions, current/default values, and dependencies.'),
  tool('update_environment_variable', 'updateEnvironmentVariable', 'Set or clear an environment variable current value.', object({ definitionId: string('Environment variable definition GUID.'), value: {}, clear: boolean('Clear the current value.') }, ['definitionId']), { readOnly: false, idempotent: true }),

  tool('list_security_roles', 'roles', 'List Dataverse security roles.'),
  tool('list_environment_users', 'users', 'List enabled Dataverse users.'),
  tool('get_role_users', 'roleUsers', 'List users assigned to a security role.', object({ roleId: string('Security role GUID.') }, ['roleId'])),

  tool('list_plugin_registrations', 'pluginRegistrationCatalog', 'List plug-in assemblies, types, steps, images, service endpoints, and registration health.'),
  tool('list_plugin_trace_logs', 'pluginTraceLogs', 'List plug-in trace logs for an assembly with bounded filters.', object({ pluginAssemblyId: string('Plug-in assembly GUID.'), top: number('Maximum records.', { minimum: 1, maximum: 5000 }) }, ['pluginAssemblyId'])),
  tool('get_plugin_trace_log', 'pluginTraceLogDetail', 'Get a plug-in trace record including exception, message block, configuration, and performance details.', object({ pluginTraceLogId: string('Plug-in trace log GUID.') }, ['pluginTraceLogId'])),
  tool('set_plugin_trace_level', 'setPluginTraceSetting', 'Set environment plug-in trace logging level.', object({ level: { type: 'string', enum: ['Off', 'Exception', 'All'], description: 'Trace logging level.' }, confirm: boolean('Confirm the environment-wide trace setting change.') }, ['level', 'confirm']), { readOnly: false, idempotent: true }),
  tool('set_plugin_steps_state', 'setPluginStepsState', 'Enable or disable selected plug-in steps.', object({ stepIds: { type: 'array', items: string('SDK message processing step GUID.'), minItems: 1, maxItems: 200 }, enabled: boolean('True to enable, false to disable.'), confirm: boolean('Confirm changing plug-in execution.') }, ['stepIds', 'enabled', 'confirm']), { readOnly: false, idempotent: true }),
  tool('choose_plugin_artifact', 'selectPluginArtifact', 'Open the connected desktop file picker for a compiled .dll or .nupkg and return a short-lived artifact token.', object({ mode: { type: 'string', enum: ['register', 'update'], description: 'Register accepts .dll or .nupkg; update accepts .dll.' } }, ['mode']), { readOnly: false }),
  tool('register_plugin_artifact', 'registerPluginArtifact', 'Register a desktop-selected plug-in assembly or package using its short-lived artifact token.', object({ artifactToken: string('Token returned by choose_plugin_artifact.'), name: string('Registration name.'), uniqueName: string('Package unique name.'), version: string('Package version.'), description: string('Description.'), isolationMode: number('1 for none or 2 for sandbox.'), solutionUniqueName: string('Optional unmanaged solution unique name.'), confirm: boolean('Confirm uploading this plug-in artifact.') }, ['artifactToken', 'confirm']), { readOnly: false, timeoutMs: 120_000 }),
  tool('update_plugin_assembly_binary', 'updatePluginAssemblyBinary', 'Replace an existing unmanaged plug-in assembly binary using a desktop-selected artifact token.', object({ assemblyId: string('Plug-in assembly GUID.'), artifactToken: string('Token returned by choose_plugin_artifact in update mode.'), description: string('Optional description.'), isolationMode: number('1 for none or 2 for sandbox.'), solutionUniqueName: string('Optional unmanaged solution unique name.'), confirm: boolean('Confirm replacing the assembly binary.') }, ['assemblyId', 'artifactToken', 'confirm']), { readOnly: false, idempotent: true, timeoutMs: 120_000 }),
  tool('list_plugin_message_filters', 'pluginMessageFilters', 'List primary/secondary table filters available for an SDK message.', object({ messageId: string('SDK message GUID.') }, ['messageId'])),
  tool('save_plugin_step', 'savePluginStep', 'Create or update a plug-in or webhook execution step with rollback support.', object({ stepId: string('Existing step GUID when updating.'), pluginTypeId: string('Plug-in type GUID.'), serviceEndpointId: string('Webhook/service endpoint GUID instead of pluginTypeId.'), messageId: string('SDK message GUID.'), messageFilterId: string('Optional SDK message filter GUID.'), name: string('Step name.'), description: string('Description.'), stage: number('10 pre-validation, 20 pre-operation, or 40 post-operation.'), mode: number('0 synchronous or 1 asynchronous.'), rank: number('Execution order, starting at 1.'), filteringAttributes: string('Comma-separated update-filtering attributes.'), configuration: string('Unsecure configuration.'), secureConfig: string('Secure configuration, retained only by Dataverse.'), solutionUniqueName: string('Optional unmanaged solution unique name.'), confirm: boolean('Confirm saving the execution step.') }, ['messageId', 'name', 'stage', 'mode', 'confirm']), { readOnly: false }),

  tool('list_command_bar_targets', 'ribbonTargets', 'List tables and applications with command bar/ribbon customizations.'),
  tool('get_command_bar_definition', 'ribbonDefinition', 'Get effective command metadata and editable RibbonDiffXml for one table.', object({ logicalName: tableName, solutionUniqueName: string('Optional unmanaged solution unique name used to load editable RibbonDiffXml.') }, ['logicalName'])),
  tool('list_command_bar_controls', 'ribbonCommandCatalog', 'List classic and modern commands for a table with labels, surfaces, actions, rules, hidden state, app scope, and safe editing capabilities. Results are bounded; filter by surface or search text for large ribbons.', object({
    logicalName: tableName,
    solutionUniqueName: string('Optional unmanaged solution unique name. Supply it to identify controls editable in that solution layer.'),
    surface: { type: 'string', enum: ['all', 'mainGrid', 'mainForm', 'subgrid', 'associated', 'quickForm', 'globalHeader', 'dashboard', 'other'], description: 'Command surface filter.' },
    source: { type: 'string', enum: ['all', 'modern', 'unmanaged-draft', 'inherited-classic'], description: 'Customization source filter.' },
    appModuleId: string('Optional model-driven app GUID for modern app actions.'),
    search: string('Search labels, identifiers, descriptions, commands, and surfaces.'),
    limit: number('Maximum controls returned, from 1 to 500.', { minimum: 1, maximum: 500 })
  }, ['logicalName']), { timeoutMs: 90_000 }),
  tool('get_command_bar_control', 'ribbonCommandCatalog', 'Get one command-bar control with its action parameters, display rules, enable rules, surface, source, and supported editing operations.', object({
    logicalName: tableName,
    solutionUniqueName: string('Optional unmanaged solution unique name.'),
    controlId: string('Exact control identifier returned by list_command_bar_controls.'),
    surface: { type: 'string', enum: ['all', 'mainGrid', 'mainForm', 'subgrid', 'associated', 'quickForm', 'globalHeader', 'dashboard', 'other'], description: 'Optional surface disambiguation.' }
  }, ['logicalName', 'controlId']), { fixedArguments: { detail: true, limit: 10 }, timeoutMs: 90_000 }),
  tool('preview_command_bar_change', 'previewRibbonCommandChange', 'Compile and validate a semantic classic command-bar change without importing or publishing it. Always preview before a live command-bar mutation.', object({
    logicalName: commandChangeContext.logicalName,
    solutionUniqueName: commandChangeContext.solutionUniqueName,
    operation: { type: 'string', enum: ['create', 'clone', 'update', 'rules', 'hide', 'unhide', 'delete'], description: 'Change to preview.' },
    mutation: commandPreviewMutation
  }, ['logicalName', 'solutionUniqueName', 'operation', 'mutation']), { argumentEnvelope: 'mutation' }),
  tool('create_command_bar_control', 'applyRibbonCommandChange', 'Create and publish a classic button, dropdown, or split button on a main grid, main form, subgrid, or associated view in an unmanaged solution. Deployment has automatic recovery and returns a rollback token.', object({
    logicalName: commandChangeContext.logicalName,
    solutionUniqueName: commandChangeContext.solutionUniqueName,
    command: createCommandDefinition,
    confirm: commandChangeContext.confirm
  }, ['logicalName', 'solutionUniqueName', 'command', 'confirm']), { readOnly: false, fixedArguments: { operation: 'create' }, timeoutMs: 120_000 }),
  tool('clone_command_bar_control', 'applyRibbonCommandChange', 'Clone a supported inherited classic command into an editable unmanaged command without overwriting the original. Unsupported compound rules or action types are rejected rather than changed silently.', object({
    logicalName: commandChangeContext.logicalName,
    solutionUniqueName: commandChangeContext.solutionUniqueName,
    controlId: commandChangeContext.controlId,
    surface: commandChangeContext.surface,
    command: cloneCommandDefinition,
    copyRules: commandChangeContext.copyRules,
    confirm: commandChangeContext.confirm
  }, ['logicalName', 'solutionUniqueName', 'controlId', 'command', 'confirm']), { readOnly: false, fixedArguments: { operation: 'clone' }, timeoutMs: 120_000 }),
  tool('update_command_bar_control', 'applyRibbonCommandChange', 'Update the placement, label, tooltip, images, action, or rules of a classic control owned by the selected unmanaged solution. Rule arrays replace the complete rule set when supplied.', object({
    logicalName: commandChangeContext.logicalName,
    solutionUniqueName: commandChangeContext.solutionUniqueName,
    controlId: commandChangeContext.controlId,
    changes: commandChanges,
    confirm: commandChangeContext.confirm
  }, ['logicalName', 'solutionUniqueName', 'controlId', 'changes', 'confirm']), { readOnly: false, idempotent: true, fixedArguments: { operation: 'update' }, timeoutMs: 120_000 }),
  tool('replace_command_bar_rules', 'applyRibbonCommandChange', 'Replace or remove display and enable rules of a classic control owned by the selected unmanaged solution. Supplied arrays replace that complete rule set; pass an empty array to remove it, and omit the other set to preserve it.', object({
    logicalName: commandChangeContext.logicalName,
    solutionUniqueName: commandChangeContext.solutionUniqueName,
    controlId: commandChangeContext.controlId,
    displayRules: commandChangeContext.displayRules,
    enableRules: commandChangeContext.enableRules,
    confirm: commandChangeContext.confirm
  }, ['logicalName', 'solutionUniqueName', 'controlId', 'confirm']), { readOnly: false, idempotent: true, fixedArguments: { operation: 'rules' }, timeoutMs: 120_000 }),
  tool('hide_command_bar_control', 'applyRibbonCommandChange', 'Hide an inherited or custom classic command-bar control by adding a HideCustomAction to the selected unmanaged solution.', object({
    logicalName: commandChangeContext.logicalName,
    solutionUniqueName: commandChangeContext.solutionUniqueName,
    controlId: commandChangeContext.controlId,
    confirm: commandChangeContext.confirm
  }, ['logicalName', 'solutionUniqueName', 'controlId', 'confirm']), { readOnly: false, idempotent: true, fixedArguments: { operation: 'hide' }, timeoutMs: 120_000 }),
  tool('unhide_command_bar_control', 'applyRibbonCommandChange', 'Remove this solution layer’s HideCustomAction for a classic command-bar control.', object({
    logicalName: commandChangeContext.logicalName,
    solutionUniqueName: commandChangeContext.solutionUniqueName,
    controlId: commandChangeContext.controlId,
    confirm: commandChangeContext.confirm
  }, ['logicalName', 'solutionUniqueName', 'controlId', 'confirm']), { readOnly: false, idempotent: true, fixedArguments: { operation: 'unhide' }, timeoutMs: 120_000 }),
  tool('delete_custom_command_bar_control', 'deleteRibbonCommand', 'Permanently remove a CustomAction owned by the selected unmanaged solution and clean up its unreferenced command, rules, and labels. Inherited commands cannot be deleted; hide them instead.', object({
    logicalName: commandChangeContext.logicalName,
    solutionUniqueName: commandChangeContext.solutionUniqueName,
    controlId: commandChangeContext.controlId,
    confirm: commandChangeContext.confirm
  }, ['logicalName', 'solutionUniqueName', 'controlId', 'confirm']), { readOnly: false, destructive: true, fixedArguments: { operation: 'delete' }, timeoutMs: 120_000 }),
  tool('rollback_command_bar_deployment', 'rollbackRibbonCommandChange', 'Restore and publish the pre-deployment solution backup using the rollback token returned by a command-bar write. Tokens expire after four hours and when the desktop session ends.', object({
    rollbackToken: string('Rollback token returned by a command-bar deployment.'),
    confirm: boolean('Must be true after explicit user approval to restore the previous command bar.')
  }, ['rollbackToken', 'confirm']), { readOnly: false, destructive: true, timeoutMs: 120_000 }),
  tool('deploy_command_bar_definition', 'deployRibbonDiff', 'Validate and deploy table RibbonDiffXml through Quicker Portal Command Workbench with rollback support.', object({ logicalName: tableName, metadataId: string('Table metadata GUID returned by list_command_bar_targets.'), ribbonDiffXml: string('Complete RibbonDiffXml payload.'), solutionUniqueName: string('Unmanaged solution unique name.'), confirm: boolean('Confirm deploying and publishing command bar customization.') }, ['logicalName', 'metadataId', 'ribbonDiffXml', 'solutionUniqueName', 'confirm']), { readOnly: false, timeoutMs: 120_000 }),

  tool('open_cloud_flow', 'openPowerAutomateFlow', 'Open a cloud flow in the restricted Quicker Portal browser on the connected desktop.', object({ workflowId: string('Cloud flow workflow GUID.'), flowUrl: string('Optional known flow URL.') }, ['workflowId']), { readOnly: false }),
  tool('open_canvas_app', 'openCanvasApp', 'Open a canvas app in the restricted Quicker Portal browser on the connected desktop.', object({ appId: string('Canvas app ID.'), appUrl: string('Optional known play URL.') }, ['appId']), { readOnly: false })
]);

export const MCP_TOOL_BY_NAME = new Map(MCP_TOOLS.map(item => [item.name, item]));

export function publicTool(toolDefinition) {
  const securitySchemes = [{
    type: 'oauth2',
    scopes: [toolDefinition.annotations.readOnlyHint ? 'mcp:read' : 'mcp:write']
  }];
  return {
    name: toolDefinition.name,
    description: toolDefinition.description,
    inputSchema: toolDefinition.inputSchema,
    annotations: toolDefinition.annotations,
    securitySchemes,
    _meta: {
      securitySchemes,
      'quickerportal/action': toolDefinition.action,
      'quickerportal/risk': toolDefinition.risk,
      'quickerportal/execution': 'connected-desktop'
    }
  };
}
