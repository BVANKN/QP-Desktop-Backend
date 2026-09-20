import { randomUUID } from 'node:crypto';
import { config } from '../../config/config.js';
import { readJsonBody } from '../../core/http/context.js';
import { authenticateMcpConnection } from './connections.js';
import { authenticateMcpOAuthToken, OAuthError } from './oauth.js';
import { mcpAuthFailure } from './auth-failure.js';
import { MCP_TOOLS, MCP_TOOL_BY_NAME, publicTool } from './tool-catalog.js';
import { toolAllowed } from './tool-policy.js';
import { RESUMABLE_PLUGIN_TOOLS, operationContract, pollToolFor } from './operation-contract.js';
import { currentDesktopEnvironment, waitForDesktopReady, enqueueDesktopToolCall, waitForDesktopJob, getDesktopOperation } from './broker.js';
import { POWER_PLATFORM_AUTHORING, CONTINUATION_INSTRUCTIONS } from './power-platform-authoring.js';
import { recordTransmission } from './analytics.js';
import { entitlementsForUser } from '../plans/subscription-store.js';
import { logger } from '../../core/logger.js';
import { validateSchema } from './schema-validator.js';
import { executionModeSchema, splitExecutionArguments } from './execution-mode.js';
import { summarizeDevOpsGrant } from './devops-grant.js';

// Endpoints addressed by user and tenant only, with no environment segment in
// the URL. For these the environment is whatever the desktop is on, not
// whatever was stored when the endpoint was first prepared.
const ENVIRONMENT_FOLLOWS_DESKTOP = new Set(['powerpages']);

const LATEST_PROTOCOL = '2025-11-25';
const SUPPORTED_PROTOCOLS = new Set([LATEST_PROTOCOL, '2025-06-18', '2025-03-26']);
// ChatGPT discovers every tool after the initial connection. Request the full
// connector grant up front so write tools do not immediately require a second
// authorization, and request offline access so the connection can be renewed.
const INITIAL_OAUTH_SCOPES = 'mcp:read mcp:write offline_access';
// Keep each discovery response comfortably below hosted-client and proxy
// payload thresholds. Command Workbench schemas are intentionally rich, so a
// fixed item count alone is not enough to bound a page.
const TOOL_PAGE_MAX_ITEMS = 20;
const TOOL_PAGE_MAX_BYTES = 48 * 1024;
const TOOL_CURSOR_PREFIX = 'qp-tools-v1:';
const toolDescriptors = new WeakMap();
const MCP_RESULT_MAX_BYTES = 768 * 1024;

function jsonRpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

function sendMcpJson(ctx, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  ctx.res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers
  });
  ctx.res.end(payload);
}

function sendAccepted(ctx) {
  ctx.res.writeHead(202, { 'Cache-Control': 'no-store' });
  ctx.res.end();
}

function validateOrigin(ctx) {
  const origin = String(ctx.req.headers.origin || '');
  if (!origin) return true;
  return config.allowedOrigins.includes(origin);
}

function publicBaseUrl(ctx) {
  if (config.mcp.publicBaseUrl) return String(config.mcp.publicBaseUrl).replace(/\/+$/, '');
  const protocol = process.env.QP_BACKEND_TRUST_PROXY === '1'
    ? String(ctx.req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim()
    : ctx.url.protocol.replace(':', '');
  return `${protocol}://${ctx.req.headers.host}`;
}

function requestResourceUrl(ctx) {
  const resource = new URL(`${publicBaseUrl(ctx)}${ctx.pathname}${ctx.url.search}`);
  resource.searchParams.sort();
  return resource.toString();
}

function resourceMetadataUrl(ctx) {
  return `${publicBaseUrl(ctx)}/.well-known/oauth-protected-resource${ctx.pathname}${ctx.url.search}`;
}

function hasScope(connection, scope) {
  return !connection.oauth || connection.scopes?.includes(scope);
}

function parseToolCursor(value, total) {
  if (value === undefined || value === null || value === '') return 0;
  const cursor = String(value);
  if (!cursor.startsWith(TOOL_CURSOR_PREFIX)) return -1;
  const offset = Number(cursor.slice(TOOL_CURSOR_PREFIX.length));
  return Number.isSafeInteger(offset) && offset >= 0 && offset < total ? offset : -1;
}

function pageTools(toolDefinitions, cursor) {
  const start = parseToolCursor(cursor, toolDefinitions.length);
  if (start < 0) return null;

  const tools = [];
  let estimatedBytes = 0;
  for (let index = start; index < toolDefinitions.length && tools.length < TOOL_PAGE_MAX_ITEMS; index += 1) {
    const definition = toolDefinitions[index];
    let descriptor = toolDescriptors.get(definition);
    if (!descriptor) {
      const exposed = publicTool(definition);
      descriptor = { exposed, bytes: Buffer.byteLength(JSON.stringify(exposed)) };
      toolDescriptors.set(definition, descriptor);
    }
    const { exposed, bytes: toolBytes } = descriptor;
    // Always return at least one tool, even if a future individual descriptor
    // is larger than the normal page budget.
    if (tools.length && estimatedBytes + toolBytes > TOOL_PAGE_MAX_BYTES) break;
    tools.push(exposed);
    estimatedBytes += toolBytes;
  }

  const nextOffset = start + tools.length;
  return {
    tools,
    ...(nextOffset < toolDefinitions.length ? { nextCursor: `${TOOL_CURSOR_PREFIX}${nextOffset}` } : {}),
    estimatedBytes
  };
}

export { validateSchema } from './schema-validator.js';

function verificationState(value, tool) {
  if (tool?.risk === 'read') return 'read_completed';
  if (value?.outcomeUnknown === true || value?.outcome_unknown === true) return 'outcome_uncertain';
  if (value?.verified === true || value?.verification === 'verified') return 'verified';
  if (value?.verified === false || value?.requiresVerification === true || value?.verification === 'pending') return 'verification_pending';
  return 'not_proven';
}

function withExecutionEvidence(value, tool, mode) {
  if (!tool || !mode) return value;
  const state = verificationState(value, tool);
  const evidence = {
    mode,
    risk: tool.risk,
    verification: state,
    uncertainMutationRule: 'reconcile-before-retry',
    ...(mode === 'verified' && !['verified', 'read_completed'].includes(state) ? {
      requiresVerification: true,
      guidance: state === 'outcome_uncertain'
        ? 'Do not repeat this mutation. Reconcile the current platform state first.'
        : 'Do not report this write as verified until a canonical readback or domain verification proves it.'
    } : {}),
    ...(mode === 'autonomous' ? {
      continueAutonomously: !['verified', 'read_completed'].includes(state),
      guidance: state === 'outcome_uncertain'
        ? 'Reconcile current state before any repair or retry. Never repeat an uncertain mutation blindly.'
        : !['verified', 'read_completed'].includes(state)
        ? 'Diagnose with current-state reads, apply only a safe targeted repair when evidence identifies one, then re-verify. Stop when verified or human action is required.'
        : 'Verification evidence is sufficient; stop unless the user requested additional work.'
    } : {})
  };
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...value, _execution: evidence }
    : { value, _execution: evidence };
}

function resultContent(value, { tool, mode } = {}) {
  const structuredContent = withExecutionEvidence(value && typeof value === 'object' && !Array.isArray(value) ? value : { value }, tool, mode);
  let compact;
  try { compact = JSON.stringify(structuredContent); } catch { compact = String(structuredContent); }
  const estimatedBytes = Buffer.byteLength(compact);
  if (estimatedBytes > MCP_RESULT_MAX_BYTES) {
    const mutationCompleted = Boolean(tool && tool.risk !== 'read');
    const overflow = {
      code: 'MCP_RESULT_TOO_LARGE',
      estimatedBytes,
      maxBytes: MCP_RESULT_MAX_BYTES,
      resultOmitted: true,
      ...(mutationCompleted ? {
        writeSucceeded: true,
        verification: verificationState(value, tool),
        retrySafe: false,
        guidance: 'The mutation completed but its returned evidence exceeded the MCP result budget. Do not repeat the mutation. Read the current platform state with a targeted tool and continue verification from that state.'
      } : {
        guidance: 'The read produced more data than the MCP result budget. Use table/search filters, a bounded page size, or a continuation cursor.'
      })
    };
    return {
      content: [{ type: 'text', text: `${overflow.code}: ${overflow.guidance} (${estimatedBytes} bytes > ${MCP_RESULT_MAX_BYTES} byte budget).` }],
      structuredContent: overflow,
      // A representation overflow is an error for a read. For a completed
      // mutation, surfacing isError=true would invite some MCP clients to
      // repeat a write that has already happened. Preserve success and force
      // reconcile/readback instead.
      isError: !mutationCompleted
    };
  }
  let text;
  try { text = JSON.stringify(structuredContent, null, 2); } catch { text = String(structuredContent); }
  if (text.length > 80_000) text = `${text.slice(0, 80_000)}\n…text view truncated; structuredContent remains within the bounded result budget.`;
  return { content: [{ type: 'text', text }], structuredContent, isError: false };
}

async function executeTool(ctx, connection, tool, args, id, resourceKind = 'power-platform', scopedToolName = '') {
  const validationErrors = validateSchema(executionModeSchema(tool.inputSchema, tool), args);
  const resumeOnly = RESUMABLE_PLUGIN_TOOLS.has(tool.name) && typeof args?.resumeOperationId === 'string' && Object.keys(args || {}).every(key => ['resumeOperationId', 'executionMode'].includes(key));
  if (tool.annotations.destructiveHint && !resumeOnly && args?.confirm !== true) validationErrors.push('arguments.confirm must be true after explicit user approval.');
  if (validationErrors.length) return jsonRpcError(id, -32602, 'Invalid tool arguments.', { errors: validationErrors });

  if (tool.quarantined) {
    return { jsonrpc: '2.0', id, result: {
      content: [{ type: 'text', text: `MCP_TOOL_QUARANTINED: ${tool.quarantineReason || 'This operation is temporarily blocked pending a safety regression.'}` }],
      structuredContent: { code: 'MCP_TOOL_QUARANTINED', tool: tool.name, quarantined: true, reason: tool.quarantineReason || 'Safety regression required before execution.' },
      isError: true
    } };
  }

  const split = splitExecutionArguments(args, tool);
  const executionMode = split.mode;
  const toolArgs = split.arguments;
  const resume = RESUMABLE_PLUGIN_TOOLS.has(tool.name) && Object.hasOwn(toolArgs, 'resumeOperationId');
  if (resume || (tool.execution === 'server' && tool.action === 'mcpOperationStatus')) {
    try {
      const operation = await getDesktopOperation({
        userId: connection.userId, connectionId: connection.id,
        operationId: resume ? toolArgs.resumeOperationId : toolArgs.operationId,
        expectedToolName: resume ? tool.name : scopedToolName && scopedToolName !== tool.name ? scopedToolName : undefined,
        waitMs: resume ? 0 : toolArgs.waitMs
      });
      const result = resultContent(operationContract(operation, resourceKind), { tool, mode: executionMode });
      result.isError = ['failed', 'expired', 'expired_unreconciled'].includes(operation.status) || operation.result?.ok === false;
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: error.message }], isError: true } };
    }
  }

  const desktop = await waitForDesktopReady(connection.userId, connection.tenantId, connection.environmentId);
  if (tool.execution === 'server') {
    const startedAt = Date.now();
    const requestId = `mcp_${randomUUID()}`;
    const value = {
      connected: Boolean(desktop.connected),
      resource: resourceKind,
      configuredEnvironment: {
        tenantId: connection.tenantId,
        tenantName: connection.tenantName || null,
        environmentId: connection.environmentId,
        environmentName: connection.environmentName || null
      },
      desktop: {
        connected: Boolean(desktop.connected),
        lastSeenAt: desktop.lastSeenAt || null,
        environmentMatches: desktop.environmentMatches,
        environmentId: desktop.environmentId || null,
        environmentName: desktop.environmentName || null
      },
      ...(resourceKind === 'devops' ? {
        // What this connection may reach, straight from the record the desktop
        // will enforce. An empty grant is the most common reason a new
        // connection "cannot see anything", so it is stated rather than implied.
        grant: connection.devopsGrant || { organizations: {} },
        grantSummary: summarizeDevOpsGrant(connection.devopsGrant),
        grantGuidance: summarizeDevOpsGrant(connection.devopsGrant).empty
          ? 'No Azure DevOps organizations or projects have been granted to this connection yet. Ask the user to grant them in Quicker Portal under Azure DevOps MCP; nothing can be read until they do.'
          : 'Work only inside the granted organizations and projects.'
      } : {}),
      remediation: desktop.connected
        ? 'The desktop execution channel is ready. Read current Dataverse state before every write and verify created components afterward.'
        : 'Open Quicker Portal, sign in with this Premium account, select this MCP endpoint’s environment, and keep the desktop app running while the AI works.'
    };
    await recordTransmission({ connection, tool, requestId, arguments: toolArgs, result: value, startedAt }).catch(error => logger.warn('MCP audit delivery failed after a known result', { message: error.message }));
    return { jsonrpc: '2.0', id, result: resultContent(value, { tool, mode: executionMode }) };
  }
  if (!desktop.connected) {
    const mismatch = desktop.environmentMatches === false;
    return { jsonrpc:'2.0',id,result:{ isError:true,content:[{type:'text',text:mismatch
      ? 'The desktop is on a different environment. Select the configured environment before continuing.'
      : 'The desktop did not reconnect within the recovery window. No work was dispatched. Check its connection health; this is not an OAuth rejection.'}],structuredContent:{
      code:mismatch ? 'DESKTOP_ENVIRONMENT_MISMATCH' : 'DESKTOP_UNAVAILABLE', dispatched:false,
      remediation: resourceKind === 'devops'
        ? 'Open Quicker Portal, sign in with this Premium account and with the Microsoft account that belongs to the Azure DevOps organization, then keep the desktop app running while the AI works.'
        : resourceKind === 'sharepoint'
        ? 'Open Quicker Portal, sign in with this Premium account, then connect the SharePoint site from SharePoint MCP. Keep the desktop app running while the AI works.'
        : resourceKind === 'powerpages'
        ? 'Open Quicker Portal, sign in with this Premium account, select the configured Dataverse environment, and keep Power Pages MCP open while the AI works.'
        : mismatch
        ? `The desktop is connected to ${desktop.environmentName || desktop.environmentId || 'another environment'}. Select the environment configured for this MCP connection and retry.`
        : 'Open Quicker Portal, sign in with this Quicker Portal account, and select the configured tenant/environment.',
      lastSeenAt: desktop.lastSeenAt,
      environmentMatches: desktop.environmentMatches,
      desktopEnvironmentId: desktop.environmentId || null,
      desktopEnvironmentName: desktop.environmentName || null
    } } };
  }

  const startedAt = Date.now();
  const requestId = `mcp_${randomUUID()}`;
  let executionResult;
  let acceptedJob = false;
  try {
    const job = await enqueueDesktopToolCall({ connection, tool, arguments: toolArgs, requestId, executionMode });
    acceptedJob = true;
    // Complete fast calls inline. Long work gets a polling handle before a
    // hosted client's HTTP deadline; the mutation itself is never re-executed.
    const completed = await waitForDesktopJob(job.id, Math.min(25_000, tool.timeoutMs, config.mcp.desktopTimeoutMs), { leavePending: true });
    executionResult = completed.result;
    if (executionResult?.ok === false) {
      const desktopError = new Error(executionResult.error || 'Quicker Portal desktop action failed.');
      desktopError.code = executionResult.code || 'DESKTOP_EXECUTION_FAILED';
      desktopError.details = executionResult.details;
      throw desktopError;
    }
    const value = executionResult?.result ?? executionResult;
    // The completion endpoint records both inline and deferred outcomes.
    return { jsonrpc: '2.0', id, result: resultContent(value, { tool, mode: executionMode }) };
  } catch (error) {
    if (error.code === 'MCP_OPERATION_PENDING') {
      return { jsonrpc: '2.0', id, result: resultContent(operationContract({ ...error.details, toolName: tool.name, completed: false }, resourceKind), { tool, mode: executionMode }) };
    }
    if (!acceptedJob) await recordTransmission({ connection, tool, requestId, arguments: toolArgs, result: executionResult, error, startedAt }).catch(() => {});
    return { jsonrpc: '2.0', id, result: {
      content: [{ type: 'text', text: error.message || 'Quicker Portal tool execution failed.' }],
      structuredContent: {
        code: error.code || 'DESKTOP_EXECUTION_FAILED',
        error: error.message || String(error),
        ...(error.details ? { details: error.details } : {})
      },
      isError: true
    } };
  }
}

export async function handleMcpRequest(ctx, { scopedToolName, resourceKind = 'power-platform' } = {}) {
  if (!validateOrigin(ctx)) {
    return sendMcpJson(ctx, 403, jsonRpcError(null, -32000, 'Origin is not allowed.'));
  }

  let connection;
  try {
    const endpointTenantId = resourceKind === 'sharepoint' ? 'sharepoint' : resourceKind === 'devops' ? 'devops' : resourceKind === 'powerpages' ? `powerpages:${ctx.params.tenantId}` : ctx.params.tenantId;
    const authorization = String(ctx.req.headers.authorization || '');
    connection = resourceKind === 'power-platform' && authorization.startsWith('Bearer qpmcp.')
      ? await authenticateMcpConnection({ userId: ctx.params.userId, tenantId: endpointTenantId, authorization })
      : await authenticateMcpOAuthToken({ authorization, resource: requestResourceUrl(ctx) });
    if (connection.userId !== ctx.params.userId || connection.tenantId.toLowerCase() !== String(endpointTenantId).toLowerCase()) {
      throw new OAuthError('invalid_token', 'The access token is not valid for this MCP endpoint.', 401);
    }
    if ((connection.kind || 'power-platform') !== resourceKind) throw new OAuthError('invalid_token', 'The access token is not valid for this MCP resource type.', 401);

    // This endpoint is addressed by user and tenant only, so the environment
    // cannot come from the URL. Taking it from the connection record froze it
    // at whatever was selected when the endpoint was first prepared: signing in
    // and choosing an environment in Quicker Portal changed nothing, and jobs
    // were queued against an environment key no running desktop would claim.
    // The environment the desktop is on is the environment this connection is
    // for. Scope is unchanged - the token still fixes the user and the tenant.
    if (ENVIRONMENT_FOLLOWS_DESKTOP.has(resourceKind)) {
      const live = currentDesktopEnvironment(connection.userId, connection.tenantId);
      if (live && String(live.environmentId).toLowerCase() !== String(connection.environmentId || '').toLowerCase()) {
        connection = { ...connection, environmentId: live.environmentId, environmentName: live.environmentName || connection.environmentName || '' };
      }
    }
  } catch (error) {
    const failure = mcpAuthFailure(error);
    if (failure.status === 503) logger.warn('MCP authentication service unavailable', { requestId: ctx.requestId, error: error.name });
    return sendMcpJson(ctx, failure.status, jsonRpcError(null, failure.code, failure.message), failure.challenge ? {
      'WWW-Authenticate': `Bearer realm="quicker-portal-mcp", error="invalid_token", resource_metadata="${resourceMetadataUrl(ctx)}", scope="${INITIAL_OAUTH_SCOPES}"`
    } : failure.status === 503 ? { 'Retry-After': '5' } : {});
  }

  // Authenticate method probes before returning transport capabilities. This
  // lets hosted clients discover OAuth from an initial GET while authorized
  // clients still learn that this endpoint uses stateless POST responses.
  if (ctx.method === 'GET') {
    ctx.res.writeHead(405, { Allow: 'POST', 'Cache-Control': 'no-store' });
    return ctx.res.end();
  }
  if (ctx.method === 'DELETE') {
    ctx.res.writeHead(405, { Allow: 'POST', 'Cache-Control': 'no-store' });
    return ctx.res.end();
  }

  const entitlements = await entitlementsForUser(connection.userId);
  if (!entitlements.features.includes('mcp.server')) {
    return sendMcpJson(ctx, 403, jsonRpcError(null, -32003, 'Quicker Portal MCP requires an active Pro plan.'));
  }

  let body;
  try {
    body = await readJsonBody(ctx, config.mcp.maxPayloadBytes);
  } catch (error) {
    return sendMcpJson(ctx, error.status || 400, jsonRpcError(null, -32700, error.message || 'Invalid JSON.'));
  }
  if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return sendMcpJson(ctx, 400, jsonRpcError(body?.id, -32600, 'Invalid JSON-RPC request.'));
  }
  const isNotification = body.id === undefined || body.id === null;
  // The connection's own policy decides which tools exist for it. Filtering the
  // advertised list as well as the call is deliberate: a model that cannot see
  // a tool does not plan around it, propose it, or ask the user to enable
  // something mid-task. Refusing at call time alone would leave it doing all
  // three.
  const resourceTools = MCP_TOOLS.filter(tool => tool.group === resourceKind && toolAllowed(tool, connection.toolPolicy).allowed);
  const isSharePoint = resourceKind === 'sharepoint';
  const isPowerPages = resourceKind === 'powerpages';
  const isDevOps = resourceKind === 'devops';

  if (body.method === 'initialize') {
    const requested = String(body.params?.protocolVersion || LATEST_PROTOCOL);
    if (!SUPPORTED_PROTOCOLS.has(requested)) return sendMcpJson(ctx, 200, jsonRpcError(body.id, -32602, `Unsupported MCP protocol version ${requested}.`));
    logger.info('MCP client initialized.', {
      protocolVersion: requested,
      clientName: String(body.params?.clientInfo?.name || 'unknown').slice(0, 80),
      requestIdHeader: ctx.requestId
    });
    return sendMcpJson(ctx, 200, { jsonrpc: '2.0', id: body.id, result: {
      protocolVersion: requested,
      capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
      serverInfo: isDevOps
        ? { name: 'Quicker Portal Azure DevOps MCP', version: '1.0.0', description: 'Reads and updates Azure DevOps work items, comments, repositories, pull requests, pipelines and wikis in the organizations and projects the user granted, as the Microsoft account signed in to their Quicker Portal desktop.' }
        : isSharePoint
        ? { name: 'Quicker Portal SharePoint MCP', version: '1.0.0', description: 'Safely reads and updates the SharePoint site connected in the user’s Quicker Portal desktop.' }
        : isPowerPages
        ? { name: 'Quicker Portal Power Pages MCP', version: '1.0.0', description: 'Builds and operates Power Pages sites through the selected Quicker Portal desktop environment.' }
        : { name: 'Quicker Portal Power Platform MCP', version: '1.0.0', description: 'Executes Power Platform operations through the user-connected Quicker Portal desktop.' },
      instructions: CONTINUATION_INSTRUCTIONS + '\n' + (!isDevOps && !isSharePoint && !isPowerPages ? POWER_PLATFORM_AUTHORING + '\n' : '') + "Execution modes are server policy, not separate tool catalogs. Reads default to simple; writes and destructive tools default to verified. simple executes the requested operation once; verified requires canonical verification evidence before reporting a write as proven; autonomous keeps using safe current-state reads, diagnosis and targeted repair tools until verification is sufficient or human action is required. Propagate executionMode on follow-up calls. A result with pending=true is accepted work, not success or failure. Poll the returned pollTool with operationId after pollAfterMs; do not resubmit the original mutation. If the status is outcome_unknown, it remains non-terminal during reconciliation: keep polling and inspect current state before any retry. Never auto-repeat a mutation with an uncertain outcome. Report per-item failures and partial/truncated inventory explicitly. For plug-ins use the Dataverse connector, not only IDE build tools: inspect assemblies/types/steps/images, choose or confirm the built artifact once, register or update, save exact steps and images, then read back and verify solution membership. If writeSucceeded=true with verification=pending, read get_plugin_registration by the returned ID; do not repeat the write. Report required user action and exact errors instead of generic manual-registration advice. " + (isDevOps
        ? 'You act as the Microsoft account signed in to the user\'s Quicker Portal desktop, inside the Azure DevOps organizations and projects the user granted to this connection - never more than that account can already do, and never outside the grant. Never ask for personal access tokens, passwords, client IDs or app registrations. Start with list_devops_organizations and list_devops_projects: they return only what is granted, so work only with those. If a call is refused as not granted, tell the user which organization or project to grant in Quicker Portal under Azure DevOps MCP; do not look for a way around it. To answer questions about work, prefer query_devops_work_items with structured filters over hand-written WIQL. Before updating a work item, read it with get_devops_work_item and pass its rev as expectedRevision; if the update reports a conflict, read it again rather than forcing. Azure DevOps has no direct messages: to message someone, find them with search_devops_people and add a comment with add_devops_work_item_comment or add_devops_pull_request_comment, passing them in mentions so they are actually notified. Plain @name text notifies nobody. Pull requests you create are drafts unless the user asks otherwise. Running a pipeline has real effects - deployments, packages, spent minutes - so confirm the exact pipeline and branch with the user first, and never try to pass pipeline variables. Deleting a work item moves it to the recycle bin and requires confirm=true after explicit user approval. Report partial or truncated results, and items withheld outside the grant, explicitly.'
        : isSharePoint
        ? 'The connected Quicker Portal desktop browser session is the only authoritative SharePoint identity and site. Never ask for tenant IDs, client IDs, client secrets, app registrations, Microsoft passwords, cookies, or access tokens. Start with get_sharepoint_connection. Discover current site, drive, list, column, and item IDs before acting. Before changing a list, column, file, or list item, call its exact get/read tool immediately first and use the returned ETag or revision when available; stale writes must be re-read, never forced. For text files use patch_sharepoint_file with the exact SHA-256 revision and targeted anchors returned by read_sharepoint_file; never ask the user to paste the complete file and never reconstruct unchanged content from memory. For list items, send only changed fields using internal column names and the current ETag. Create a list first, then create each requested column with create_sharepoint_column; do not invent internal names or unsupported column types. Column type and internal name are immutable after creation, so create a replacement only after explaining the migration impact. Follow paging links for large libraries and lists. Keep reads bounded. Preview the exact target in your response and use delete tools only after explicit user confirmation. If the desktop or SharePoint session is disconnected, explain that the user must reconnect it in Quicker Portal rather than requesting credentials.'
        : isPowerPages
        ? 'The selected Quicker Portal desktop environment is authoritative. Start with get_power_pages_connection and list_power_pages_sites. Use create_power_pages_site only after confirming the exact environment, name, subdomain, base language, and template. Never assume whether a site uses the standard or enhanced model: get_power_pages_site or inspect_power_pages_inventory detects it. Before updating or deleting a component, call read_power_pages_component immediately first and pass its exact SHA-256 revision; stale writes must be re-read, never forced. Send only changed component fields. Do not ask the user to paste a complete site export. Components include pages, files, templates, snippets, links, forms, lists, table permissions, column permission profiles, roles, access rules, redirects, cloud flows, and UX components. Use site lifecycle and security tools only for documented operations. Certificate private material is accepted only for an explicit local-approved upload and is never returned by read tools. Treat site provisioning, public visibility, WAF, IP restrictions, domains, certificates, SSL, AFD routing, data-model changes, and deletion as high-impact. Explain the exact site and intended effect before writes; destructive calls require confirm=true and fresh current state. Do not claim completion until the desktop returns the operation result and a follow-up read confirms current state.'
        : 'The selected Quicker Portal desktop and tenant are authoritative. Start every multi-step build with get_power_platform_connection; if it reports offline, stop mutation work and give its exact reconnection instruction. For a new project, create or choose the publisher and unmanaged solution first, then create components with that solution unique name or add existing components explicitly. Use create_relationship for lookups: preflight eligibility and do not claim success unless the result says verified=true and contains the materialized lookup metadata. Build model-driven apps in dependency order: tables and choices, scalar columns, relationships/lookups, forms/views/resources, app components, semantic sitemap, ValidateApp, security access, then publish. After every create, use the corresponding get or inventory tool and treat a missing canonical record as failure. Read the latest component before changing it. For existing cloud flows, forms, views, text web resources, Business Process Flows, and Canvas source, use patch_*: send targeted operations or exact anchors, never ask the user for a complete artifact and never reconstruct unchanged content from memory. For a BPF, call get_business_process_flow immediately first and use its revision; it returns a structural summary of stages and steps by default, so pass include with xaml or clientData only when you are composing an edit against their exact text. Structural BPF edits must change the current XAML and clientdata as a matched pair; never edit generated processstage.clientdata directly. For the first BPF use create_business_process_flow with authoringMode=designer, the intended uniqueName, primaryTable, solutionUniqueName and stages; this requires designer interaction, not XML from the user. Preserve the handoffToken and verify with complete_business_process_flow_creation after Save. Use list_business_process_flow_templates only for optional template reuse. Complete XAML/clientdata is for an exact solution artifact or recovery. Validate before activation, preserve the previous active/draft state unless the user requests a state change, and use the returned rollback token if compilation fails. The desktop performs read-modify-validate-write with stale-write protection. For Canvas, connect and sync, then list/read/search the current .pa.yaml source before revision-bound patches and diff review. Compile success without canonical verification is not success; never claim the Canvas app was updated unless the terminal operation returns verified=true. Use complete replacements only for explicit import or recovery. For two or more rows, always use create_records once instead of repeatedly calling create_record. Preview security privilege changes before applying them. PCF changes belong in source files in the IDE/build workflow; add the resulting component to the solution and verify inventory. Minimize reads, use one logical operation per approval, require confirm=true for destructive changes, and never edit managed components directly.')
    } }, { 'MCP-Protocol-Version': requested });
  }
  if (body.method === 'notifications/initialized' || body.method.startsWith('notifications/')) return sendAccepted(ctx);
  if (body.method === 'ping') return sendMcpJson(ctx, 200, { jsonrpc: '2.0', id: body.id, result: {} });
  if (body.method === 'tools/list') {
    if (!hasScope(connection, 'mcp:read')) {
      return sendMcpJson(ctx, 403, jsonRpcError(body.id, -32003, 'The access token needs mcp:read scope.'), {
        'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl(ctx)}", error="insufficient_scope", scope="${INITIAL_OAUTH_SCOPES}"`
      });
    }
    const scopedAvailable = resourceTools.some(item => item.name === scopedToolName);
    const definitions = scopedToolName ? resourceTools.filter(item => item.name === scopedToolName || (scopedAvailable && item.name === pollToolFor(resourceKind))) : resourceTools;
    const page = pageTools(definitions, body.params?.cursor);
    if (!page) return sendMcpJson(ctx, 200, jsonRpcError(body.id, -32602, 'The tools/list cursor is invalid or expired.'));
    logger.info('MCP tool catalog page listed.', {
      count: page.tools.length,
      nextPage: Boolean(page.nextCursor),
      estimatedBytes: page.estimatedBytes,
      requestIdHeader: ctx.requestId
    });
    const { estimatedBytes, ...result } = page;
    return sendMcpJson(ctx, 200, { jsonrpc: '2.0', id: body.id, result });
  }
  if (body.method === 'resources/list') {
    if (!hasScope(connection, 'mcp:read')) return sendMcpJson(ctx, 403, jsonRpcError(body.id, -32003, 'The access token needs mcp:read scope.'));
    return sendMcpJson(ctx, 200, { jsonrpc: '2.0', id: body.id, result: { resources: [{
      uri: isDevOps ? 'quickerportal://devops/grant' : isSharePoint ? 'quickerportal://sharepoint/current-site' : isPowerPages ? `quickerportal://powerpages/${connection.environmentId}` : `quickerportal://environment/${connection.tenantId}/${connection.environmentId}`,
      name: isDevOps ? 'Granted Azure DevOps organizations and projects' : connection.environmentName || connection.tenantName || (isSharePoint ? 'Connected SharePoint site' : isPowerPages ? 'Power Pages environment' : 'Connected Power Platform environment'),
      description: isDevOps ? 'The Azure DevOps organizations and projects this connection may reach.' : isSharePoint ? 'The SharePoint site currently connected in the user’s Quicker Portal desktop browser session.' : isPowerPages ? 'Power Pages sites in the selected live desktop environment.' : 'The live environment selected by the connected Quicker Portal desktop.',
      mimeType: 'application/json'
    }] } });
  }
  if (body.method === 'resources/read') {
    if (!hasScope(connection, 'mcp:read')) return sendMcpJson(ctx, 403, jsonRpcError(body.id, -32003, 'The access token needs mcp:read scope.'));
    return sendMcpJson(ctx, 200, { jsonrpc: '2.0', id: body.id, result: { contents: [{
      uri: body.params?.uri || (isDevOps ? 'quickerportal://devops/grant' : isSharePoint ? 'quickerportal://sharepoint/current-site' : isPowerPages ? `quickerportal://powerpages/${connection.environmentId}` : `quickerportal://environment/${connection.tenantId}/${connection.environmentId}`),
      mimeType: 'application/json',
      text: JSON.stringify(isDevOps
        ? { resource: 'devops', execution: 'connected-desktop-microsoft-account', grant: connection.devopsGrant || { organizations: {} }, appRegistrationRequired: false, personalAccessTokenRequired: false }
        : isSharePoint
        ? { resource: 'sharepoint', site: connection.environmentName, execution: 'connected-desktop-browser-session', appRegistrationRequired: false }
        : isPowerPages
        ? { resource: 'powerpages', environmentId: connection.environmentId, environmentName: connection.environmentName, execution: 'connected-desktop', modelDetection: 'automatic', localWriteApproval: true }
        : { tenantId: connection.tenantId, tenantName: connection.tenantName, environmentId: connection.environmentId, environmentName: connection.environmentName, execution: 'connected-desktop' }, null, 2)
    }] } });
  }
  if (body.method === 'tools/call') {
    const requestedName = String(body.params?.name || '');
    if (scopedToolName && requestedName !== scopedToolName && !(requestedName === pollToolFor(resourceKind) && resourceTools.some(item => item.name === scopedToolName))) return sendMcpJson(ctx, 200, jsonRpcError(body.id, -32602, `This endpoint only exposes ${scopedToolName} and its operation-status tool.`));
    const tool = MCP_TOOL_BY_NAME.get(requestedName);
    if (!tool || tool.group !== resourceKind) return sendMcpJson(ctx, 200, jsonRpcError(body.id, -32602, `Unknown tool: ${requestedName}.`));
    // Enforced here too, not only in the advertised list: a client may have
    // cached an older list, or simply guessed a name.
    const permitted = toolAllowed(tool, connection.toolPolicy);
    if (!permitted.allowed) {
      return sendMcpJson(ctx, 200, jsonRpcError(body.id, -32003, `${requestedName} is not available on this MCP connection. ${permitted.detail}`, {
        code: 'MCP_TOOL_NOT_PERMITTED',
        subject: permitted.subject,
        reason: permitted.reason,
        remediation: 'Change what this connection may reach in Quicker Portal, under the MCP connection\'s access settings.'
      }));
    }
    const requiredScope = tool.annotations.readOnlyHint ? 'mcp:read' : 'mcp:write';
    if (!hasScope(connection, requiredScope)) {
      return sendMcpJson(ctx, 403, jsonRpcError(body.id, -32003, `The access token needs ${requiredScope} scope.`), {
        'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl(ctx)}", error="insufficient_scope", scope="${INITIAL_OAUTH_SCOPES}"`
      });
    }
    const response = await executeTool(ctx, connection, tool, body.params?.arguments || {}, body.id, resourceKind, scopedToolName);
    return sendMcpJson(ctx, 200, response);
  }
  if (isNotification) return sendAccepted(ctx);
  return sendMcpJson(ctx, 200, jsonRpcError(body.id, -32601, `Method not found: ${body.method}.`));
}
