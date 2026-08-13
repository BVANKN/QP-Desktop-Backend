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

async function executeTool(ctx, connection, tool, args, id) {
  const validationErrors = validateSchema(tool.inputSchema, args);
  if (tool.annotations.destructiveHint && args?.confirm !== true) validationErrors.push('arguments.confirm must be true after explicit user approval.');
  if (validationErrors.length) return jsonRpcError(id, -32602, 'Invalid tool arguments.', { errors: validationErrors });

  const desktop = desktopStatus(connection.userId, connection.tenantId, connection.environmentId);
  if (!desktop.connected) {
    const mismatch = desktop.environmentMatches === false;
    return jsonRpcError(id, -32002, 'Quicker Portal desktop is offline.', {
      remediation: mismatch
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
    if (executionResult?.ok === false) throw new Error(executionResult.error || 'Quicker Portal desktop action failed.');
    const value = executionResult?.result ?? executionResult;
    await recordTransmission({ connection, tool, requestId, arguments: args, result: value, startedAt });
    return { jsonrpc: '2.0', id, result: resultContent(value) };
  } catch (error) {
    await recordTransmission({ connection, tool, requestId, arguments: args, result: executionResult, error, startedAt }).catch(() => {});
    return { jsonrpc: '2.0', id, result: {
      content: [{ type: 'text', text: error.message || 'Quicker Portal tool execution failed.' }],
      structuredContent: { code: 'DESKTOP_EXECUTION_FAILED', error: error.message || String(error) },
      isError: true
    } };
  }
}

export async function handleMcpRequest(ctx, { scopedToolName } = {}) {
  if (!validateOrigin(ctx)) {
    return sendMcpJson(ctx, 403, jsonRpcError(null, -32000, 'Origin is not allowed.'));
  }

  let connection;
  try {
    const authorization = String(ctx.req.headers.authorization || '');
    connection = authorization.startsWith('Bearer qpmcp.')
      ? await authenticateMcpConnection({ userId: ctx.params.userId, tenantId: ctx.params.tenantId, authorization })
      : await authenticateMcpOAuthToken({ authorization, resource: requestResourceUrl(ctx) });
    if (connection.userId !== ctx.params.userId || connection.tenantId.toLowerCase() !== String(ctx.params.tenantId).toLowerCase()) {
      throw new Error('The access token is not valid for this MCP endpoint.');
    }
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
      serverInfo: { name: 'Quicker Portal Power Platform MCP', version: '1.0.0', description: 'Executes Power Platform operations through the user-connected Quicker Portal desktop.' },
      instructions: 'The selected Quicker Portal desktop and tenant are authoritative. Minimize columns and row counts on reads. Preview and confirm destructive changes. Managed solution components may be read-only.'
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
    const definitions = scopedToolName ? MCP_TOOLS.filter(item => item.name === scopedToolName) : MCP_TOOLS;
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
      uri: `quickerportal://environment/${connection.tenantId}/${connection.environmentId}`,
      name: connection.environmentName || connection.tenantName || 'Connected Power Platform environment',
      description: 'The live environment selected by the connected Quicker Portal desktop.',
      mimeType: 'application/json'
    }] } });
  }
  if (body.method === 'resources/read') {
    if (!hasScope(connection, 'mcp:read')) return sendMcpJson(ctx, 403, jsonRpcError(body.id, -32003, 'The access token needs mcp:read scope.'));
    return sendMcpJson(ctx, 200, { jsonrpc: '2.0', id: body.id, result: { contents: [{
      uri: body.params?.uri || `quickerportal://environment/${connection.tenantId}/${connection.environmentId}`,
      mimeType: 'application/json',
      text: JSON.stringify({ tenantId: connection.tenantId, tenantName: connection.tenantName, environmentId: connection.environmentId, environmentName: connection.environmentName, execution: 'connected-desktop' }, null, 2)
    }] } });
  }
  if (body.method === 'tools/call') {
    const requestedName = String(body.params?.name || '');
    if (scopedToolName && requestedName !== scopedToolName) return sendMcpJson(ctx, 200, jsonRpcError(body.id, -32602, `This endpoint only exposes ${scopedToolName}.`));
    const tool = MCP_TOOL_BY_NAME.get(requestedName);
    if (!tool) return sendMcpJson(ctx, 200, jsonRpcError(body.id, -32602, `Unknown tool: ${requestedName}.`));
    const requiredScope = tool.annotations.readOnlyHint ? 'mcp:read' : 'mcp:write';
    if (!hasScope(connection, requiredScope)) {
      return sendMcpJson(ctx, 403, jsonRpcError(body.id, -32003, `The access token needs ${requiredScope} scope.`), {
        'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl(ctx)}", error="insufficient_scope", scope="${INITIAL_OAUTH_SCOPES}"`
      });
    }
    const response = await executeTool(ctx, connection, tool, body.params?.arguments || {}, body.id);
    return sendMcpJson(ctx, 200, response);
  }
  if (isNotification) return sendAccepted(ctx);
  return sendMcpJson(ctx, 200, jsonRpcError(body.id, -32601, `Method not found: ${body.method}.`));
}
