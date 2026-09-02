import { randomUUID } from 'node:crypto';
import { config } from '../../config/config.js';
import { readJsonBody } from '../../core/http/context.js';
import { authenticateMcpConnection } from './connections.js';
import { authenticateMcpOAuthToken } from './oauth.js';
import { MCP_TOOLS, MCP_TOOL_BY_NAME, publicTool } from './tool-catalog.js';
import { desktopStatus, enqueueDesktopToolCall, waitForDesktopJob } from './broker.js';
import { recordTransmission } from './analytics.js';
import { entitlementsForUser } from '../plans/subscription-store.js';
import { logger } from '../../core/logger.js';

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
    const exposed = publicTool(toolDefinitions[index]);
    const toolBytes = Buffer.byteLength(JSON.stringify(exposed));
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

function validateSchema(schema, value, path = 'arguments', errors = []) {
  if (!schema || !schema.type) return errors;
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${path} must be an object.`);
      return errors;
    }
    for (const key of schema.required || []) {
      if (!(key in value) || value[key] === undefined || value[key] === null || value[key] === '') errors.push(`${path}.${key} is required.`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties || {}, key)) errors.push(`${path}.${key} is not supported.`);
    }
    for (const [key, child] of Object.entries(value)) if (schema.properties?.[key]) validateSchema(schema.properties[key], child, `${path}.${key}`, errors);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) errors.push(`${path} must be an array.`);
    else {
      if (schema.minItems && value.length < schema.minItems) errors.push(`${path} needs at least ${schema.minItems} items.`);
      if (schema.maxItems && value.length > schema.maxItems) errors.push(`${path} supports at most ${schema.maxItems} items.`);
      value.forEach((item, index) => validateSchema(schema.items, item, `${path}[${index}]`, errors));
    }
  } else if (schema.type === 'string' && typeof value !== 'string') errors.push(`${path} must be a string.`);
  else if (schema.type === 'boolean' && typeof value !== 'boolean') errors.push(`${path} must be a boolean.`);
  else if (schema.type === 'number' && typeof value !== 'number') errors.push(`${path} must be a number.`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} must be one of: ${schema.enum.join(', ')}.`);
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} must be at least ${schema.minimum}.`);
  if (typeof value === 'number' && schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} must be at most ${schema.maximum}.`);
  return errors;
}

function resultContent(value) {
  let text;
  try { text = JSON.stringify(value, null, 2); } catch { text = String(value); }
  if (text.length > 80_000) text = `${text.slice(0, 80_000)}\n…response truncated in text; use structuredContent for the complete result.`;
  const structuredContent = value && typeof value === 'object' && !Array.isArray(value) ? value : { value };
  return { content: [{ type: 'text', text }], structuredContent, isError: false };
}

async function executeTool(ctx, connection, tool, args, id, resourceKind = 'power-platform') {
  const validationErrors = validateSchema(tool.inputSchema, args);
  if (tool.annotations.destructiveHint && args?.confirm !== true) validationErrors.push('arguments.confirm must be true after explicit user approval.');
  if (validationErrors.length) return jsonRpcError(id, -32602, 'Invalid tool arguments.', { errors: validationErrors });

  const desktop = desktopStatus(connection.userId, connection.tenantId, connection.environmentId);
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
      remediation: desktop.connected
        ? 'The desktop execution channel is ready. Read current Dataverse state before every write and verify created components afterward.'
        : 'Open Quicker Portal, sign in with this Premium account, select this MCP endpoint’s environment, and keep the desktop app running while the AI works.'
    };
    await recordTransmission({ connection, tool, requestId, arguments: args, result: value, startedAt });
    return { jsonrpc: '2.0', id, result: resultContent(value) };
  }
  if (!desktop.connected) {
    const mismatch = desktop.environmentMatches === false;
    return jsonRpcError(id, -32002, 'Quicker Portal desktop is offline.', {
      remediation: resourceKind === 'sharepoint'
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
    });
  }

  const startedAt = Date.now();
  const requestId = `mcp_${randomUUID()}`;
  let executionResult;
  try {
    const job = await enqueueDesktopToolCall({ connection, tool, arguments: args, requestId });
    const completed = await waitForDesktopJob(job.id, Math.min(tool.timeoutMs, config.mcp.desktopTimeoutMs));
    executionResult = completed.result;
    if (executionResult?.ok === false) {
      const desktopError = new Error(executionResult.error || 'Quicker Portal desktop action failed.');
      desktopError.code = executionResult.code || 'DESKTOP_EXECUTION_FAILED';
      desktopError.details = executionResult.details;
      throw desktopError;
    }
    const value = executionResult?.result ?? executionResult;
    await recordTransmission({ connection, tool, requestId, arguments: args, result: value, startedAt });
    return { jsonrpc: '2.0', id, result: resultContent(value) };
  } catch (error) {
    await recordTransmission({ connection, tool, requestId, arguments: args, result: executionResult, error, startedAt }).catch(() => {});
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
    const endpointTenantId = resourceKind === 'sharepoint' ? 'sharepoint' : resourceKind === 'powerpages' ? `powerpages:${ctx.params.tenantId}` : ctx.params.tenantId;
    const authorization = String(ctx.req.headers.authorization || '');
    connection = resourceKind === 'power-platform' && authorization.startsWith('Bearer qpmcp.')
      ? await authenticateMcpConnection({ userId: ctx.params.userId, tenantId: endpointTenantId, authorization })
      : await authenticateMcpOAuthToken({ authorization, resource: requestResourceUrl(ctx) });
    if (connection.userId !== ctx.params.userId || connection.tenantId.toLowerCase() !== String(endpointTenantId).toLowerCase()) {
      throw new Error('The access token is not valid for this MCP endpoint.');
    }
    if ((connection.kind || 'power-platform') !== resourceKind) throw new Error('The access token is not valid for this MCP resource type.');
  } catch (error) {
    return sendMcpJson(ctx, 401, jsonRpcError(null, -32001, error.message), {
      'WWW-Authenticate': `Bearer realm="quicker-portal-mcp", resource_metadata="${resourceMetadataUrl(ctx)}", scope="${INITIAL_OAUTH_SCOPES}"`
    });
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
  const resourceTools = MCP_TOOLS.filter(tool => tool.group === resourceKind);
  const isSharePoint = resourceKind === 'sharepoint';
  const isPowerPages = resourceKind === 'powerpages';

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
      serverInfo: isSharePoint
        ? { name: 'Quicker Portal SharePoint MCP', version: '1.0.0', description: 'Safely reads and updates the SharePoint site connected in the user’s Quicker Portal desktop.' }
        : isPowerPages
        ? { name: 'Quicker Portal Power Pages MCP', version: '1.0.0', description: 'Builds and operates Power Pages sites through the selected Quicker Portal desktop environment.' }
        : { name: 'Quicker Portal Power Platform MCP', version: '1.0.0', description: 'Executes Power Platform operations through the user-connected Quicker Portal desktop.' },
      instructions: isSharePoint
        ? 'The connected Quicker Portal desktop browser session is the only authoritative SharePoint identity and site. Never ask for tenant IDs, client IDs, client secrets, app registrations, Microsoft passwords, cookies, or access tokens. Start with get_sharepoint_connection. Discover current site, drive, list, column, and item IDs before acting. Before changing a list, column, file, or list item, call its exact get/read tool immediately first and use the returned ETag or revision when available; stale writes must be re-read, never forced. For text files use patch_sharepoint_file with the exact SHA-256 revision and targeted anchors returned by read_sharepoint_file; never ask the user to paste the complete file and never reconstruct unchanged content from memory. For list items, send only changed fields using internal column names and the current ETag. Create a list first, then create each requested column with create_sharepoint_column; do not invent internal names or unsupported column types. Column type and internal name are immutable after creation, so create a replacement only after explaining the migration impact. Follow paging links for large libraries and lists. Keep reads bounded. Preview the exact target in your response and use delete tools only after explicit user confirmation. If the desktop or SharePoint session is disconnected, explain that the user must reconnect it in Quicker Portal rather than requesting credentials.'
        : isPowerPages
        ? 'The selected Quicker Portal desktop environment is authoritative. Start with get_power_pages_connection and list_power_pages_sites. Use create_power_pages_site only after confirming the exact environment, name, subdomain, base language, and template. Never assume whether a site uses the standard or enhanced model: get_power_pages_site or inspect_power_pages_inventory detects it. Before updating or deleting a component, call read_power_pages_component immediately first and pass its exact SHA-256 revision; stale writes must be re-read, never forced. Send only changed component fields. Do not ask the user to paste a complete site export. Components include pages, files, templates, snippets, links, forms, lists, table permissions, column permission profiles, roles, access rules, redirects, cloud flows, and UX components. Use site lifecycle and security tools only for documented operations. Certificate private material is accepted only for an explicit local-approved upload and is never returned by read tools. Treat site provisioning, public visibility, WAF, IP restrictions, domains, certificates, SSL, AFD routing, data-model changes, and deletion as high-impact. Explain the exact site and intended effect before writes; destructive calls require confirm=true and fresh current state. Do not claim completion until the desktop returns the operation result and a follow-up read confirms current state.'
        : 'The selected Quicker Portal desktop and tenant are authoritative. Start every multi-step build with get_power_platform_connection; if it reports offline, stop mutation work and give its exact reconnection instruction. For a new project, create or choose the publisher and unmanaged solution first, then create components with that solution unique name or add existing components explicitly. Use create_relationship for lookups: preflight eligibility and do not claim success unless the result says verified=true and contains the materialized lookup metadata. Build model-driven apps in dependency order: tables and choices, scalar columns, relationships/lookups, forms/views/resources, app components, semantic sitemap, ValidateApp, security access, then publish. After every create, use the corresponding get or inventory tool and treat a missing canonical record as failure. Read the latest component before changing it. For existing cloud flows, forms, views, text web resources, and Canvas source, use patch_*: send targeted operations or exact anchors, never ask the user for a complete artifact and never reconstruct unchanged content from memory. The desktop performs read-modify-validate-write with stale-write protection. Canvas authoring requires status, connect, sync and poll, list/read/search, revision-bound patch, diff review, apply, and terminal verified=true. Use complete replacements only for explicit import or recovery. Use create_records once for bounded multi-row creation. Preview security privilege changes before applying them. PCF source changes belong in the IDE/build workflow; add the resulting component to the solution and verify inventory. Minimize reads, use one logical operation per approval, require confirm=true for destructive changes, and never edit managed components directly.'
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
    const definitions = scopedToolName ? resourceTools.filter(item => item.name === scopedToolName) : resourceTools;
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
      uri: isSharePoint ? 'quickerportal://sharepoint/current-site' : isPowerPages ? `quickerportal://powerpages/${connection.environmentId}` : `quickerportal://environment/${connection.tenantId}/${connection.environmentId}`,
      name: connection.environmentName || connection.tenantName || (isSharePoint ? 'Connected SharePoint site' : isPowerPages ? 'Power Pages environment' : 'Connected Power Platform environment'),
      description: isSharePoint ? 'The SharePoint site currently connected in the user’s Quicker Portal desktop browser session.' : isPowerPages ? 'Power Pages sites in the selected live desktop environment.' : 'The live environment selected by the connected Quicker Portal desktop.',
      mimeType: 'application/json'
    }] } });
  }
  if (body.method === 'resources/read') {
    if (!hasScope(connection, 'mcp:read')) return sendMcpJson(ctx, 403, jsonRpcError(body.id, -32003, 'The access token needs mcp:read scope.'));
    return sendMcpJson(ctx, 200, { jsonrpc: '2.0', id: body.id, result: { contents: [{
      uri: body.params?.uri || (isSharePoint ? 'quickerportal://sharepoint/current-site' : isPowerPages ? `quickerportal://powerpages/${connection.environmentId}` : `quickerportal://environment/${connection.tenantId}/${connection.environmentId}`),
      mimeType: 'application/json',
      text: JSON.stringify(isSharePoint
        ? { resource: 'sharepoint', site: connection.environmentName, execution: 'connected-desktop-browser-session', appRegistrationRequired: false }
        : isPowerPages
        ? { resource: 'powerpages', environmentId: connection.environmentId, environmentName: connection.environmentName, execution: 'connected-desktop', modelDetection: 'automatic', localWriteApproval: true }
        : { tenantId: connection.tenantId, tenantName: connection.tenantName, environmentId: connection.environmentId, environmentName: connection.environmentName, execution: 'connected-desktop' }, null, 2)
    }] } });
  }
  if (body.method === 'tools/call') {
    const requestedName = String(body.params?.name || '');
    if (scopedToolName && requestedName !== scopedToolName) return sendMcpJson(ctx, 200, jsonRpcError(body.id, -32602, `This endpoint only exposes ${scopedToolName}.`));
    const tool = MCP_TOOL_BY_NAME.get(requestedName);
    if (!tool || tool.group !== resourceKind) return sendMcpJson(ctx, 200, jsonRpcError(body.id, -32602, `Unknown tool: ${requestedName}.`));
    const requiredScope = tool.annotations.readOnlyHint ? 'mcp:read' : 'mcp:write';
    if (!hasScope(connection, requiredScope)) {
      return sendMcpJson(ctx, 403, jsonRpcError(body.id, -32003, `The access token needs ${requiredScope} scope.`), {
        'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl(ctx)}", error="insufficient_scope", scope="${INITIAL_OAUTH_SCOPES}"`
      });
    }
    const response = await executeTool(ctx, connection, tool, body.params?.arguments || {}, body.id, resourceKind);
    return sendMcpJson(ctx, 200, response);
  }
  if (isNotification) return sendAccepted(ctx);
  return sendMcpJson(ctx, 200, jsonRpcError(body.id, -32601, `Method not found: ${body.method}.`));
}
