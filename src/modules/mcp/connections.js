import { JsonStore } from '../../lib/json-store.js';
import { randomId, randomToken, safeEqual, sha256Hex } from '../../lib/crypto.js';
import { mongoCollection, mongoEnabled } from '../../lib/mongo.js';
import { AuthenticationError, NotFoundError, ValidationError } from '../../core/errors.js';
import { normalizePolicy } from './tool-policy.js';

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
    // What this connection may reach. Absent on older records, which is why it
    // is normalized rather than read straight through.
    toolPolicy: normalizePolicy(connection.toolPolicy),
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
    tenantKey: tenantId.toLowerCase(),
    tenantName: String(input.tenantName || '').trim().slice(0, 160),
    environmentId,
    environmentKey: environmentId.toLowerCase(),
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
  if (mongoEnabled()) {
    const collection = await mongoCollection('mcp_connections');
    await collection.deleteMany({ revokedAt: { $ne: null, $lt: new Date(Date.now() - REVOKED_RETENTION_MS).toISOString() } });
    const activeCount = await collection.countDocuments({ userId, enabled: true });
    if (activeCount >= MAX_ACTIVE_CONNECTIONS_PER_USER) {
      throw new ValidationError(`A Quicker Portal account can have at most ${MAX_ACTIVE_CONNECTIONS_PER_USER} active MCP connections. Revoke an unused connection first.`);
    }
    await collection.insertOne(record);
  } else {
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
  }
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
  if (mongoEnabled()) {
    const rows = await (await mongoCollection('mcp_connections')).find({ userId, kind: { $nin: ['ide', 'sharepoint', 'powerpages'] } }).sort({ createdAt: -1 }).toArray();
    return rows.map(publicConnection);
  }
  const document = await store.read();
  return document.connections.filter(item => item.userId === userId && !['ide', 'sharepoint', 'powerpages'].includes(item.kind)).map(publicConnection);
}

/**
 * Creates the account's OAuth-only IDE resource once. Unlike Power Platform
 * connections it has no reusable static bearer key: MCP clients must complete
 * QP OAuth and the desktop bridge must present a live QP product session.
 */
export async function ensureIdeMcpConnection(userId) {
  const now = new Date().toISOString();
  if (mongoEnabled()) {
    const collection = await mongoCollection('mcp_connections');
    const updated = await collection.findOneAndUpdate(
      { userId, kind: 'ide' },
      {
        $set: { enabled: true, revokedAt: null },
        $setOnInsert: {
          id: randomId('ide'),
          kind: 'ide',
          userId,
          tenantId: 'ide',
          tenantKey: 'ide',
          tenantName: 'Quicker Portal IDE',
          environmentId: 'ide',
          environmentKey: 'ide',
          environmentName: 'Local workspaces',
          name: 'Quicker Portal IDE',
          captureMode: 'metadata',
          keyHash: null,
          keyPrefix: null,
          createdAt: now,
          lastUsedAt: null
        }
      },
      { upsert: true, returnDocument: 'after' }
    );
    return publicConnection(updated);
  }
  return store.update(document => {
    const existing = document.connections.find(item => item.userId === userId && item.kind === 'ide');
    if (existing) {
      existing.enabled = true;
      existing.revokedAt = null;
      return { result: publicConnection(existing) };
    }
    const connection = {
      id: randomId('ide'),
      kind: 'ide',
      userId,
      tenantId: 'ide',
      tenantKey: 'ide',
      tenantName: 'Quicker Portal IDE',
      environmentId: 'ide',
      environmentKey: 'ide',
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

/**
 * Creates the account's OAuth-only SharePoint resource. SharePoint credentials,
 * cookies, and access tokens never pass through this service: operations are
 * leased to the user's live Quicker Portal desktop browser session.
 */
export function sharePointMcpConnectionSeed(userId, { now = new Date().toISOString() } = {}) {
  // Fields in $set and $setOnInsert must be disjoint. MongoDB rejects an
  // upsert when the same path (for example enabled or revokedAt) appears in
  // both operators, even though the values are identical.
  const activation = { enabled: true, revokedAt: null };
  const insertOnly = {
    kind: 'sharepoint',
    userId,
    tenantId: 'sharepoint',
    tenantKey: 'sharepoint',
    tenantName: 'Local Microsoft session',
    environmentId: 'sharepoint',
    environmentKey: 'sharepoint',
    environmentName: 'Connected SharePoint site',
    name: 'Quicker Portal SharePoint MCP',
    captureMode: 'metadata',
    keyHash: null,
    keyPrefix: null,
    createdAt: now,
    lastUsedAt: null
  };
  return { activation, insertOnly };
}

export async function ensureSharePointMcpConnection(userId) {
  const { activation, insertOnly } = sharePointMcpConnectionSeed(userId);
  if (mongoEnabled()) {
    const updated = await (await mongoCollection('mcp_connections')).findOneAndUpdate(
      { userId, kind: 'sharepoint' },
      { $set: activation, $setOnInsert: { id: randomId('spmcp'), ...insertOnly } },
      { upsert: true, returnDocument: 'after' }
    );
    return publicConnection(updated);
  }
  return store.update(document => {
    const existing = document.connections.find(item => item.userId === userId && item.kind === 'sharepoint');
    if (existing) {
      existing.enabled = true;
      existing.revokedAt = null;
      return { result: publicConnection(existing) };
    }
    const connection = { id: randomId('spmcp'), ...insertOnly, ...activation };
    document.connections.push(connection);
    return { result: publicConnection(connection) };
  });
}

export function sharePointMcpConnectionEndpoint(endpointBase, userId) {
  return `${String(endpointBase).replace(/\/+$/, '')}/sharepoint/mcp/${encodeURIComponent(userId)}`;
}

export async function ensurePowerPagesMcpConnection(userId, input = {}) {
  const tenantId = cleanIdentifier(input.tenantId, 'tenantId');
  const environmentId = cleanIdentifier(input.environmentId, 'environmentId', 256);
  const tenantKey = `powerpages:${tenantId}`;
  const now = new Date().toISOString();
  const activation = {
    enabled: true,
    revokedAt: null,
    tenantName: String(input.tenantName || '').trim().slice(0, 160),
    environmentName: String(input.environmentName || '').trim().slice(0, 160)
  };
  const insertOnly = {
    kind: 'powerpages', userId, tenantId: tenantKey, tenantKey: tenantKey.toLowerCase(),
    sourceTenantId: tenantId, environmentId, environmentKey: environmentId.toLowerCase(),
    name: 'Quicker Portal Power Pages MCP', captureMode: 'metadata', keyHash: null,
    keyPrefix: null, createdAt: now, lastUsedAt: null
  };
  if (mongoEnabled()) {
    const updated = await (await mongoCollection('mcp_connections')).findOneAndUpdate(
      { userId, kind: 'powerpages', tenantKey: tenantKey.toLowerCase(), environmentKey: environmentId.toLowerCase() },
      { $set: activation, $setOnInsert: { id: randomId('ppmcp'), ...insertOnly } },
      { upsert: true, returnDocument: 'after' }
    );
    return publicConnection(updated);
  }
  return store.update(document => {
    const existing = document.connections.find(item => item.userId === userId && item.kind === 'powerpages' && item.tenantKey === tenantKey.toLowerCase() && item.environmentKey === environmentId.toLowerCase());
    if (existing) {
      Object.assign(existing, activation);
      return { result: publicConnection(existing) };
    }
    const connection = { id: randomId('ppmcp'), ...insertOnly, ...activation };
    document.connections.push(connection);
    return { result: publicConnection(connection) };
  });
}

export function powerPagesMcpConnectionEndpoint(endpointBase, userId, tenantId) {
  return `${String(endpointBase).replace(/\/+$/, '')}/powerpages/mcp/${encodeURIComponent(userId)}/${encodeURIComponent(tenantId)}`;
}

export function mcpConnectionEndpoint(endpointBase, connection) {
  const base = String(endpointBase).replace(/\/+$/, '');
  const path = `/mcp/${encodeURIComponent(connection.userId)}/${encodeURIComponent(connection.tenantId)}`;
  return `${base}${path}?connection_id=${encodeURIComponent(connection.id)}`;
}

export async function findMcpConnectionById(connectionId) {
  if (mongoEnabled()) {
    const document = await (await mongoCollection('mcp_connections')).findOne({ id: connectionId });
    if (!document) return null;
    const { _id, ...connection } = document;
    return connection;
  }
  const document = await store.read();
  return document.connections.find(item => item.id === connectionId) || null;
}

export async function activeMcpConnectionsForResource({ userId, tenantId }) {
  if (mongoEnabled()) {
    const rows = await (await mongoCollection('mcp_connections')).find({
      userId,
      tenantKey: String(tenantId).toLowerCase(),
      enabled: true
    }).toArray();
    return rows.map(({ _id, ...value }) => value);
  }
  const document = await store.read();
  return document.connections.filter(item => (
    item.enabled
    && item.userId === userId
    && item.tenantId.toLowerCase() === String(tenantId).toLowerCase()
  ));
}

export async function revokeMcpConnection(userId, connectionId) {
  if (mongoEnabled()) {
    const updated = await (await mongoCollection('mcp_connections')).findOneAndUpdate(
      { id: connectionId, userId },
      { $set: { enabled: false, revokedAt: new Date().toISOString() } },
      { returnDocument: 'after' }
    );
    if (!updated) throw new NotFoundError('MCP connection not found.');
    return publicConnection(updated);
  }
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

/**
 * Removes a connection record outright, rather than leaving a revoked row in
 * the list for the 90-day retention window.
 *
 * Revoking is the safe default and stays that way: it keeps a visible record
 * that the connection existed and when its access ended. Deleting is for
 * tidying the list afterwards, so it is a separate, explicit call.
 *
 * The auto-provisioned resources (IDE, SharePoint, Power Pages) are singletons
 * the product recreates on demand, so deleting one would only produce a
 * confusing gap. They are refused here as well as being absent from the list.
 *
 * Transmission analytics are stored separately and are untouched: deleting a
 * connection never erases the record of what it did.
 */
export async function deleteMcpConnection(userId, connectionId) {
  const id = cleanIdentifier(connectionId, 'MCP connection ID');
  if (mongoEnabled()) {
    const collection = await mongoCollection('mcp_connections');
    const existing = await collection.findOne({ id, userId });
    if (!existing) throw new NotFoundError('MCP connection not found.');
    assertDeletableConnection(existing);
    await collection.deleteOne({ id, userId });
    return { deleted: true, id, name: existing.name || '' };
  }
  let result;
  await store.update(document => {
    const connection = document.connections.find(item => item.id === id && item.userId === userId);
    if (!connection) throw new NotFoundError('MCP connection not found.');
    assertDeletableConnection(connection);
    document.connections = document.connections.filter(item => !(item.id === id && item.userId === userId));
    result = { deleted: true, id, name: connection.name || '' };
    return { result };
  });
  return result;
}

function assertDeletableConnection(connection) {
  const kind = connection.kind || 'power-platform';
  if (['ide', 'sharepoint', 'powerpages'].includes(kind)) {
    throw new ValidationError(`The ${kind} connection is provisioned automatically and cannot be deleted. Revoke it instead.`, { field: 'connectionId' });
  }
}

/**
 * Changes what one connection may reach.
 *
 * Stored on the connection rather than the account because the whole point is
 * that two clients can differ: a coding assistant that may read schema and
 * build views, and a support agent that may read records and nothing else,
 * should not have to be the same.
 */
export async function setMcpConnectionToolPolicy(userId, connectionId, policy) {
  const id = cleanIdentifier(connectionId, 'MCP connection ID');
  const toolPolicy = normalizePolicy(policy);
  if (mongoEnabled()) {
    const updated = await (await mongoCollection('mcp_connections')).findOneAndUpdate(
      { id, userId },
      { $set: { toolPolicy } },
      { returnDocument: 'after' }
    );
    if (!updated) throw new NotFoundError('MCP connection not found.');
    return publicConnection(updated);
  }
  let result;
  await store.update(document => {
    const connection = document.connections.find(item => item.id === id && item.userId === userId);
    if (!connection) throw new NotFoundError('MCP connection not found.');
    connection.toolPolicy = toolPolicy;
    result = publicConnection(connection);
    return { result };
  });
  return result;
}

export async function authenticateMcpConnection({ userId, tenantId, authorization }) {
  const token = String(authorization || '').startsWith('Bearer ')
    ? String(authorization).slice(7).trim()
    : '';
  if (!token || token.length > 512) throw new AuthenticationError('Provide the MCP bearer key.', 'MCP_KEY_REQUIRED');
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'qpmcp') throw new AuthenticationError('MCP bearer key is invalid.', 'MCP_KEY_INVALID');
  const connection = mongoEnabled()
    ? await (await mongoCollection('mcp_connections')).findOne({ id: parts[1] })
    : (await store.read()).connections.find(item => item.id === parts[1]);
  if (!connection || !connection.enabled || connection.userId !== userId || connection.tenantId.toLowerCase() !== String(tenantId).toLowerCase()) {
    throw new AuthenticationError('MCP bearer key is invalid or revoked.', 'MCP_KEY_INVALID');
  }
  if (!safeEqual(connection.keyHash, sha256Hex(token))) throw new AuthenticationError('MCP bearer key is invalid.', 'MCP_KEY_INVALID');
  const now = new Date().toISOString();
  if (!connection.lastUsedAt || Date.now() - Date.parse(connection.lastUsedAt) > 60_000) {
    if (mongoEnabled()) {
      void mongoCollection('mcp_connections').then(collection => collection.updateOne({ id: connection.id }, { $set: { lastUsedAt: now } })).catch(() => {});
    } else {
      store.update(current => {
        const found = current.connections.find(item => item.id === connection.id);
        if (found) found.lastUsedAt = now;
        return {};
      }).catch(() => {});
    }
  }
  return { ...connection, lastUsedAt: now };
}

export function mcpResourceMetadata(resourceUrl, serviceBaseUrl, { kind = 'power-platform', ide = false } = {}) {
  const resourceKind = ide ? 'ide' : kind;
  const isIde = resourceKind === 'ide';
  const isSharePoint = resourceKind === 'sharepoint';
  const isPowerPages = resourceKind === 'powerpages';
  return {
    resource: resourceUrl,
    resource_name: isIde ? 'Quicker Portal IDE MCP' : isSharePoint ? 'Quicker Portal SharePoint MCP' : isPowerPages ? 'Quicker Portal Power Pages MCP' : 'Quicker Portal Power Platform MCP',
    authorization_servers: [serviceBaseUrl.replace(/\/+$/, '')],
    scopes_supported: ['mcp:read', 'mcp:write', 'offline_access'],
    bearer_methods_supported: ['header'],
    resource_documentation: `${serviceBaseUrl.replace(/\/+$/, '')}${isIde ? '/api/ide/bootstrap' : isSharePoint ? '/api/mcp/sharepoint/bootstrap' : isPowerPages ? '/api/mcp/powerpages/bootstrap' : '/api/mcp/connections'}`,
    quicker_portal_authentication: isIde || isSharePoint || isPowerPages
      ? 'oauth-2.1-pkce-with-premium-quicker-portal-account'
      : 'oauth-2.1-pkce-or-tenant-scoped-static-bearer-key',
    ...(isSharePoint ? { sharepoint_authentication: 'connected-quicker-portal-desktop-browser-session; no customer app registration required' } : {}),
    ...(isPowerPages ? { power_pages_execution: 'selected-quicker-portal-desktop-environment-with-local-write-approval' } : {})
  };
}
