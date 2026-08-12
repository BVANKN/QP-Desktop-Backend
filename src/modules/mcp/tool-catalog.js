// MCP-facing capability catalog. Each tool maps to an existing privileged
// Electron action; the desktop remains the Dataverse security boundary.
const string = description => ({ type: 'string', description });
const boolean = description => ({ type: 'boolean', description });
const number = (description, extra = {}) => ({ type: 'number', description, ...extra });
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
    timeoutMs: options.timeoutMs || 55_000
  });
}

const tableName = string('Dataverse table logical name, for example account or new_project.');
const columnName = string('Dataverse column logical name.');
const recordId = string('Dataverse record GUID.');
const confirm = boolean('Must be true after the user explicitly approves this destructive operation.');
const arbitraryPayload = { type: 'object', description: 'Dataverse values keyed by logical column name.', additionalProperties: true };

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
  tool('update_form', 'saveComponentDesigner', 'Update an unmanaged system form FormXML with validation and a rollback snapshot.', object({ id: string('System form GUID.'), formXml: string('Complete FormXML with a form root element.'), name: string('Optional form name.'), description: string('Optional description.'), publish: boolean('Publish the owning table after save.') }, ['id', 'formXml']), { readOnly: false, idempotent: true, fixedArguments: { kind: 'forms' } }),
  tool('publish_form', 'publishComponentDesigner', 'Publish the table customizations containing a system form.', object({ id: string('System form GUID.'), target: tableName, confirm: boolean('Confirm publishing this form.') }, ['id', 'confirm']), { readOnly: false, idempotent: true, fixedArguments: { kind: 'forms' } }),
  tool('list_views', 'developerAssets', 'List system views, optionally filtered to one table.', object({ tableLogicalName: tableName }), { fixedArguments: { kind: 'views' } }),
  tool('get_view', 'developerAssetDetail', 'Get a system view including FetchXML and LayoutXML.', object({ id: string('Saved query GUID.') }, ['id']), { fixedArguments: { kind: 'views' } }),
  tool('update_view', 'saveComponentDesigner', 'Update an unmanaged system view FetchXML and LayoutXML with validation and rollback.', object({ id: string('Saved query GUID.'), fetchXml: string('Complete FetchXML query.'), layoutXml: string('Complete view grid LayoutXML.'), name: string('Optional view name.'), description: string('Optional description.'), publish: boolean('Publish the owning table after save.') }, ['id', 'fetchXml', 'layoutXml']), { readOnly: false, idempotent: true, fixedArguments: { kind: 'views' } }),
  tool('publish_view', 'publishComponentDesigner', 'Publish the table customizations containing a system view.', object({ id: string('Saved query GUID.'), target: tableName, confirm: boolean('Confirm publishing this view.') }, ['id', 'confirm']), { readOnly: false, idempotent: true, fixedArguments: { kind: 'views' } }),
  tool('list_canvas_apps', 'developerAssets', 'List Canvas apps available through Dataverse metadata.', object(), { fixedArguments: { kind: 'canvasApps' } }),
  tool('get_canvas_app', 'developerAssetDetail', 'Get Canvas app metadata and related component details.', object({ id: string('Canvas app GUID.') }, ['id']), { fixedArguments: { kind: 'canvasApps' } }),

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
  tool('update_cloud_flow', 'updateFlow', 'Update an existing unmanaged cloud flow definition or metadata.', object({ workflowId: string('Cloud flow workflow GUID.'), definition: arbitraryPayload, connectionReferences: arbitraryPayload, name: string('Optional new display name.') }, ['workflowId']), { readOnly: false, idempotent: true, timeoutMs: 90_000 }),
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
  tool('update_web_resource', 'updateWebResource', 'Update an unmanaged web resource source or metadata.', object({ webResourceId: string('Web resource GUID.'), name: string('Web resource name.'), content: string('UTF-8 source content before Dataverse encoding.'), displayName: string('Display name.') }, ['webResourceId', 'content']), { readOnly: false, idempotent: true }),
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
