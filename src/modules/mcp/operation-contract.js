// These tools may pause for native file consent or a long registration. A
// client which exposes the original tool but not the generic poller can use
// the same tool to read its existing job; this never dispatches desktop work.
export const RESUMABLE_PLUGIN_TOOLS = new Set([
  'choose_plugin_artifact', 'register_plugin_artifact',
  'update_plugin_assembly_binary', 'save_plugin_step'
]);

export function resumableSchema(schema) {
  return {
    type: 'object',
    properties: {
      ...schema.properties,
      resumeOperationId: { type: 'string', minLength: 1, maxLength: 128, description: 'Read the existing operation from this same tool and MCP connection. Send this field alone; never repeat file selection or registration to fetch a result.' }
    },
    additionalProperties: false,
    if: { required: ['resumeOperationId'] },
    then: { maxProperties: 1 },
    else: schema
  };
}

export function pollToolFor(resourceKind) {
  return resourceKind === 'sharepoint' ? 'get_sharepoint_operation'
    : resourceKind === 'powerpages' ? 'get_power_pages_operation' : 'get_power_platform_operation';
}

export function operationContract(operation, resourceKind) {
  const pending = ['queued', 'leased'].includes(operation.status);
  const resumable = RESUMABLE_PLUGIN_TOOLS.has(operation.toolName);
  const raw = operation.result;
  const failed = ['failed', 'expired'].includes(operation.status) || raw?.ok === false;
  const hasOutput = operation.status === 'completed' && !operation.resultPurged && !failed && raw != null;
  const output = hasOutput ? (raw?.ok === true && Object.hasOwn(raw, 'result') ? raw.result : raw) : undefined;
  const guidance = pending
    ? `Work is still running or awaiting desktop consent. Poll after pollAfterMs.${resumable ? ' If the poll tool is unavailable, call resumeTool with resumeArguments only.' : ''} Do not repeat the original request.`
    : hasOutput
    ? output?.canceled ? 'File selection was canceled. Stop; do not reopen the picker without a new user request.'
      : operation.toolName === 'choose_plugin_artifact' ? 'File selection finished. Use output.artifactToken for registration/update; do not select the file again. Selection alone does not register the assembly.'
      : 'The operation finished. Read output, then verify the live Dataverse state before reporting success.'
    : operation.guidance || 'No successful result is available. Inspect the error or current state; do not blindly repeat registration.';
  return {
    ...operation,
    pending,
    pollTool: pollToolFor(resourceKind),
    pollArguments: { operationId: operation.operationId },
    ...(resumable ? { resumeTool: operation.toolName, resumeArguments: { resumeOperationId: operation.operationId } } : {}),
    ...(hasOutput ? { output } : {}),
    guidance
  };
}
