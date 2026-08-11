import { randomUUID } from 'node:crypto';
import { config } from '../../config/config.js';
import { readJsonBody } from '../../core/http/context.js';
import { authenticateMcpConnection } from './connections.js';
import { MCP_TOOLS, MCP_TOOL_BY_NAME, publicTool } from './tool-catalog.js';
import { desktopStatus, enqueueDesktopToolCall, waitForDesktopJob } from './broker.js';
import { recordTransmission } from './analytics.js';
import { entitlementsForUser } from '../plans/subscription-store.js';

const LATEST_PROTOCOL = '2025-11-25';
const SUPPORTED_PROTOCOLS = new Set([LATEST_PROTOCOL, '2025-06-18', '2025-03-26']);

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
    return jsonRpcError(id, -32002, 'Quicker Portal desktop is offline.', {
      remediation: 'Open Quicker Portal, sign in with this Quicker Portal account, and select the configured tenant/environment.',
      lastSeenAt: desktop.lastSeenAt
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
  if (ctx.method === 'GET') {
    ctx.res.writeHead(405, { Allow: 'POST, DELETE', 'Cache-Control': 'no-store' });
    return ctx.res.end();
  }
  if (ctx.method === 'DELETE') {
    ctx.res.writeHead(405, { Allow: 'POST', 'Cache-Control': 'no-store' });
    return ctx.res.end();
  }

  let connection;
  try {
    connection = await authenticateMcpConnection({
      userId: ctx.params.userId,
      tenantId: ctx.params.tenantId,
      authorization: ctx.req.headers.authorization
    });
  } catch (error) {
    const baseUrl = String(config.mcp.publicBaseUrl || `${ctx.url.protocol}//${ctx.req.headers.host}`).replace(/\/+$/, '');
    return sendMcpJson(ctx, 401, jsonRpcError(null, -32001, error.message), {
      'WWW-Authenticate': `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`
    });
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
    const tools = scopedToolName ? MCP_TOOLS.filter(item => item.name === scopedToolName) : MCP_TOOLS;
    return sendMcpJson(ctx, 200, { jsonrpc: '2.0', id: body.id, result: { tools: tools.map(publicTool) } });
  }
  if (body.method === 'resources/list') {
    return sendMcpJson(ctx, 200, { jsonrpc: '2.0', id: body.id, result: { resources: [{
      uri: `quickerportal://environment/${connection.tenantId}/${connection.environmentId}`,
      name: connection.environmentName || connection.tenantName || 'Connected Power Platform environment',
      description: 'The live environment selected by the connected Quicker Portal desktop.',
      mimeType: 'application/json'
    }] } });
  }
  if (body.method === 'resources/read') {
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
    const response = await executeTool(ctx, connection, tool, body.params?.arguments || {}, body.id);
    return sendMcpJson(ctx, 200, response);
  }
  if (isNotification) return sendAccepted(ctx);
  return sendMcpJson(ctx, 200, jsonRpcError(body.id, -32601, `Method not found: ${body.method}.`));
}
