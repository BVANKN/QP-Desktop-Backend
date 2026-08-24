import { JsonStore } from '../../lib/json-store.js';
import { randomId, randomToken, safeEqual, sha256Hex } from '../../lib/crypto.js';
import { AuthenticationError, NotFoundError, ValidationError } from '../../core/errors.js';

const store = new JsonStore('mcp/connections.json', { version: 1, connections: [] });
const MAX_ACTIVE_CONNECTIONS_PER_USER = 20;
const REVOKED_RETENTION_MS = 90 * 24 * 60 * 60_000;

function cleanIdentifier(value, field, maxLength = 128) {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength || !/^[a-zA-Z0-9._:@-]+$/.test(text)) {
    throw new ValidationError(`${field} is invalid.`, { field });
  }
  return text;
}

function publicConnection(connection) {
  return {
    id: connection.id,
    kind: connection.kind || 'power-platform',
    name: connection.name,
    userId: connection.userId,
    tenantId: connection.tenantId,
    tenantName: connection.tenantName,
    environmentId: connection.environmentId,
    environmentName: connection.environmentName,
    captureMode: connection.captureMode,
    enabled: connection.enabled,
    keyPrefix: connection.keyPrefix,
    createdAt: connection.createdAt,
    lastUsedAt: connection.lastUsedAt || null,
    revokedAt: connection.revokedAt || null
  };
}

export async function createMcpConnection(userId, input, endpointBase) {
  const tenantId = cleanIdentifier(input.tenantId, 'tenantId');
  const environmentId = cleanIdentifier(input.environmentId || tenantId, 'environmentId', 256);
  const name = String(input.name || input.environmentName || 'Quicker Portal MCP').trim().slice(0, 100);
  const captureMode = input.captureMode === 'metadata' ? 'metadata' : 'detailed';
  const id = randomId('mcp');
  const secret = randomToken(32);
  const apiKey = `qpmcp.${id}.${secret}`;
  const now = new Date().toISOString();
  const record = {
    id,
    kind: 'power-platform',
    userId,
    tenantId,
    tenantName: String(input.tenantName || '').trim().slice(0, 160),
    environmentId,
    environmentName: String(input.environmentName || '').trim().slice(0, 160),
    name,
    captureMode,
    enabled: true,
    keyHash: sha256Hex(apiKey),
    keyPrefix: `${apiKey.slice(0, 18)}...`,
    createdAt: now,
    lastUsedAt: null,
    revokedAt: null
  };
  await store.update(document => {
    const revokedCutoff = Date.now() - REVOKED_RETENTION_MS;
    document.connections = document.connections.filter(item => !item.revokedAt || Date.parse(item.revokedAt) >= revokedCutoff);
    const activeCount = document.connections.filter(item => item.userId === userId && item.enabled).length;
    if (activeCount >= MAX_ACTIVE_CONNECTIONS_PER_USER) {
      throw new ValidationError(`A Quicker Portal account can have at most ${MAX_ACTIVE_CONNECTIONS_PER_USER} active MCP connections. Revoke an unused connection first.`);
    }
    document.connections.push(record);
    return { result: record };
  });
  const endpoint = mcpConnectionEndpoint(endpointBase, record);
  return {
    connection: publicConnection(record),
    apiKey,
    endpoint,
    configuration: {
      type: 'http',
      url: endpoint,
      headers: { Authorization: `Bearer ${apiKey}` }
    },
    oauth: {
      url: endpoint,
      authentication: 'oauth',
      discovery: 'automatic',
      scopes: ['mcp:read', 'mcp:write', 'offline_access']
    }
  };
}

export async function listMcpConnections(userId) {
  const document = await store.read();
  return document.connections.filter(item => item.userId === userId && item.kind !== 'ide').map(publicConnection);
}

/**
 * Creates the account's OAuth-only IDE resource once. Unlike Power Platform
 * connections it has no reusable static bearer key: MCP clients must complete
 * QP OAuth and the desktop bridge must present a live QP product session.
 */
export async function ensureIdeMcpConnection(userId) {
  return store.update(document => {
    const existing = document.connections.find(item => item.userId === userId && item.kind === 'ide');
    if (existing) {
      existing.enabled = true;
      existing.revokedAt = null;
      return { result: publicConnection(existing) };
    }
    const now = new Date().toISOString();
    const connection = {
      id: randomId('ide'),
      kind: 'ide',
      userId,
      tenantId: 'ide',
      tenantName: 'Quicker Portal IDE',
      environmentId: 'ide',
      environmentName: 'Local workspaces',
      name: 'Quicker Portal IDE',
      captureMode: 'metadata',
      enabled: true,
      keyHash: null,
      keyPrefix: null,
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null
    };
    document.connections.push(connection);
    return { result: publicConnection(connection) };
  });
}

export function ideMcpConnectionEndpoint(endpointBase, userId) {
  return `${String(endpointBase).replace(/\/+$/, '')}/ide/mcp/${encodeURIComponent(userId)}`;
}

export function mcpConnectionEndpoint(endpointBase, connection) {
  const base = String(endpointBase).replace(/\/+$/, '');
  const path = `/mcp/${encodeURIComponent(connection.userId)}/${encodeURIComponent(connection.tenantId)}`;
  return `${base}${path}?connection_id=${encodeURIComponent(connection.id)}`;
}

export async function findMcpConnectionById(connectionId) {
  const document = await store.read();
  return document.connections.find(item => item.id === connectionId) || null;
}

export async function activeMcpConnectionsForResource({ userId, tenantId }) {
  const document = await store.read();
  return document.connections.filter(item => (
    item.enabled
    && item.userId === userId
    && item.tenantId.toLowerCase() === String(tenantId).toLowerCase()
  ));
}

export async function revokeMcpConnection(userId, connectionId) {
  let updated;
  await store.update(document => {
    const connection = document.connections.find(item => item.id === connectionId && item.userId === userId);
    if (!connection) throw new NotFoundError('MCP connection not found.');
    connection.enabled = false;
    connection.revokedAt = new Date().toISOString();
    updated = publicConnection(connection);
    return { result: updated };
  });
  return updated;
}

export async function authenticateMcpConnection({ userId, tenantId, authorization }) {
  const token = String(authorization || '').startsWith('Bearer ')
    ? String(authorization).slice(7).trim()
    : '';
  if (!token || token.length > 512) throw new AuthenticationError('Provide the MCP bearer key.', 'MCP_KEY_REQUIRED');
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'qpmcp') throw new AuthenticationError('MCP bearer key is invalid.', 'MCP_KEY_INVALID');
  const document = await store.read();
  const connection = document.connections.find(item => item.id === parts[1]);
  if (!connection || !connection.enabled || connection.userId !== userId || connection.tenantId.toLowerCase() !== String(tenantId).toLowerCase()) {
    throw new AuthenticationError('MCP bearer key is invalid or revoked.', 'MCP_KEY_INVALID');
  }
  if (!safeEqual(connection.keyHash, sha256Hex(token))) throw new AuthenticationError('MCP bearer key is invalid.', 'MCP_KEY_INVALID');
  const now = new Date().toISOString();
  if (!connection.lastUsedAt || Date.now() - Date.parse(connection.lastUsedAt) > 60_000) {
    store.update(current => {
      const found = current.connections.find(item => item.id === connection.id);
      if (found) found.lastUsedAt = now;
      return {};
    }).catch(() => {});
  }
  return { ...connection, lastUsedAt: now };
}

export function mcpResourceMetadata(resourceUrl, serviceBaseUrl, { ide = false } = {}) {
  return {
    resource: resourceUrl,
    resource_name: ide ? 'Quicker Portal IDE MCP' : 'Quicker Portal Power Platform MCP',
    authorization_servers: [serviceBaseUrl.replace(/\/+$/, '')],
    scopes_supported: ['mcp:read', 'mcp:write', 'offline_access'],
    bearer_methods_supported: ['header'],
    resource_documentation: `${serviceBaseUrl.replace(/\/+$/, '')}${ide ? '/api/ide/bootstrap' : '/api/mcp/connections'}`,
    quicker_portal_authentication: ide
      ? 'oauth-2.1-pkce-with-premium-quicker-portal-account'
      : 'oauth-2.1-pkce-or-tenant-scoped-static-bearer-key'
  };
}
