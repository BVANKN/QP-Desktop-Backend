// Only classified metadata is persisted: upstream messages can echo credentials or record data.
export function failureDiagnostics(error, result = {}) {
  const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value) ? value : undefined;
  const code = identifier(error?.code) || identifier(result?.code) || 'EXECUTION_ERROR';
  const statusValue = Number(error?.status || result?.status);
  const status = Number.isInteger(statusValue) && statusValue >= 400 && statusValue <= 599 ? statusValue : undefined;
  let summary = 'The desktop could not complete this operation.';
  let nextStep = 'Check the desktop connection and the AI client’s original error response for the service-specific explanation.';
  if (status === 401) { summary = 'The service rejected authentication.'; nextStep = 'Sign in again to the selected Microsoft account, then check the connection.'; }
  else if (status === 403) { summary = 'The service refused access.'; nextStep = 'Check the signed-in account’s permissions and the selected site or environment.'; }
  else if (status === 404) { summary = 'The requested service resource was not found.'; nextStep = 'Refresh the selected site or environment and confirm that the target still exists.'; }
  else if (status === 429) { summary = 'The service is throttling requests.'; nextStep = 'Wait for the retry interval before requesting more work.'; }
  else if (status === 409 || status === 412) { summary = 'The operation conflicted with the current service state.'; nextStep = 'Read the target again and resolve the conflict before submitting an update.'; }
  else if (status === 400) { summary = 'The service rejected the submitted operation.'; nextStep = 'Review the tool arguments, required fields and supported operations against the current target.'; }
  else if (status >= 500) { summary = 'The upstream service reported a server error.'; nextStep = 'Check service health and the target’s current state before trying again.'; }
  else if (/DENIED|APPROVAL/.test(code)) { summary = 'Desktop approval was denied or was not received in time.'; nextStep = 'Review the approval settings in Quicker Portal before submitting a new request.'; }
  else if (/TIMEOUT|EXPIRED|DEADLINE/.test(code)) { summary = 'The request exceeded its time limit.'; nextStep = 'Check desktop activity and read the target state; a timeout does not prove the operation was rolled back.'; }
  else if (/OFFLINE|DISCONNECTED|ENOTFOUND|ECONN/.test(code)) { summary = 'The execution connection was unavailable.'; nextStep = 'Check network access, sign-in and the desktop broker status.'; }
  const retry = Number(error?.retryAfterSeconds ?? result?.retryAfterSeconds);
  if (code === 'POWER_PAGES_UNAVAILABLE') {
    summary = 'Power Pages could not be read through either the administration API or the Dataverse fallback.';
    nextStep = 'Confirm the selected environment contains Power Pages, check access to its site tables, and review Power Platform administration consent.';
  } else if (code === 'POWER_PAGES_MODEL_UNRESOLVED') {
    summary = 'The site configuration could not be resolved in either the enhanced or standard Power Pages data model.';
    nextStep = 'Refresh the site list, confirm the site belongs to this environment, and check access to its Dataverse configuration tables.';
  }
  return { code, status, serviceCode: identifier(error?.dataverseCode || result?.dataverseCode),
    serviceRequestId: identifier(error?.requestId || result?.requestId),
    retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? Math.min(retry, 86400) : undefined,
    summary, nextStep,
    outcome: 'For writes, earlier steps may have completed. Verify current state before retrying; no automatic retry has been started.',
    messagePolicy: 'Raw service messages and submitted content are not stored in activity diagnostics.' };
}
