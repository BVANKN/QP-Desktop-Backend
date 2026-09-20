// These tools may pause for native file consent or a long registration. A
// client which exposes the original tool but not the generic poller can use
// the same tool to read its existing job; this never dispatches desktop work.
export const RESUMABLE_PLUGIN_TOOLS = new Set([
  'choose_plugin_artifact', 'register_plugin_artifact',
  'update_plugin_assembly_binary', 'save_plugin_step', 'save_plugin_step_image',
  'rollback_plugin_registration', 'create_business_process_flow'
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
    : resourceKind === 'devops' ? 'get_devops_operation'
    : resourceKind === 'powerpages' ? 'get_power_pages_operation' : 'get_power_platform_operation';
}


function durationMs(start, end) {
  const left = Date.parse(start || '');
  const right = Date.parse(end || '');
  return Number.isFinite(left) && Number.isFinite(right) && right >= left ? right - left : null;
}

function operationTimings(operation) {
  const result = operation?.result?.result ?? operation?.result;
  const handlerMs = Number(result?._desktopExecution?.handlerMs ?? operation?.result?.execution?.handlerMs);
  const timings = {
    queueMs: durationMs(operation?.createdAt, operation?.claimedAt),
    totalMs: durationMs(operation?.createdAt, operation?.completedAt),
    ...(Number.isFinite(handlerMs) && handlerMs >= 0 ? { handlerMs } : {})
  };
  return Object.fromEntries(Object.entries(timings).filter(([, value]) => value !== null));
}

export function operationContract(operation, resourceKind) {
  const pending = ['queued', 'leased', 'outcome_unknown'].includes(operation.status);
  const resumable = RESUMABLE_PLUGIN_TOOLS.has(operation.toolName);
  const raw = operation.result;
  const failed = ['failed', 'expired', 'expired_unreconciled'].includes(operation.status) || raw?.ok === false;
  const hasOutput = operation.status === 'completed' && !operation.resultPurged && !failed && raw != null;
  const output = hasOutput ? (raw?.ok === true && Object.hasOwn(raw, 'result') ? raw.result : raw) : undefined;
  const guidance = pending
    ? operation.status === 'outcome_unknown'
      ? `The desktop accepted this operation but its terminal response is not known yet. Keep polling in this task and reconcile current platform state before any retry. Never repeat the original mutation while its outcome is uncertain.${resumable ? ' If the poll tool is unavailable, call resumeTool with resumeArguments only after pollAfterMs.' : ''}`
      : `Work is still running or awaiting desktop consent. Continue polling in this task using pollTool and pollArguments until terminal; do not end the task or ask the user to say continue merely because polling is needed.${resumable ? ' If the poll tool is unavailable, call resumeTool with resumeArguments only after pollAfterMs.' : ''} Keep approval prompts intact and honor user cancellation. Do not repeat the original request.`
    : hasOutput
    ? output?.canceled ? 'File selection was canceled. Stop; do not reopen the picker without a new user request.'
      : output?.requiresVerification ? 'The write succeeded but verification is pending. Read output.nextTool with output.nextArguments; preserve the component ID and rollback token. Do not repeat the write or claim deployment is complete.'
      : output?.requiresUserAction ? (output.message || 'User action is required. Preserve the returned plan and continuation token; do not repeat creation.')
      : operation.toolName === 'choose_plugin_artifact' ? 'File selection finished. Use output.artifactToken for registration/update; do not select the file again. Selection alone does not register the assembly.'
      : 'The operation finished. Read output, then verify the live Dataverse state before reporting success.'
    : operation.guidance || 'No successful result is available. Inspect the error or current state; do not blindly repeat registration.';
  return {
    ...operation,
    pending,
    pollTool: pollToolFor(resourceKind),
    pollArguments: { operationId: operation.operationId,waitMs:20000 },
    ...(pending ? { continuePolling:true, nextAction:'poll', requiresChatReply:false, ...(operation.status === 'outcome_unknown' ? { outcomeUncertain:true, reconcileBeforeRetry:true } : {}) } : {}),
    ...(resumable ? { resumeTool: operation.toolName, resumeArguments: { resumeOperationId: operation.operationId } } : {}),
    ...(hasOutput ? { output } : {}),
    timings: operationTimings(operation),
    guidance
  };
}
