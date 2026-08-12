import { createHash } from 'node:crypto';
import { config } from '../../config/config.js';
import { JsonStore } from '../../lib/json-store.js';
import { randomId, randomToken, safeEqual, sha256Hex } from '../../lib/crypto.js';
import { login, logout } from '../auth/auth-service.js';
import { entitlementsForUser } from '../plans/subscription-store.js';
import { audit } from '../audit/audit.js';
import { activeMcpConnectionsForResource, findMcpConnectionById } from './connections.js';

const clientsStore = new JsonStore('mcp/oauth-clients.json', { version: 1, clients: [] });
const authorizationStore = new JsonStore('mcp/oauth-authorizations.json', { version: 1, requests: {} });
const tokenStore = new JsonStore('mcp/oauth-tokens.json', { version: 1, codes: {}, grants: {} });

const SUPPORTED_SCOPES = Object.freeze(['mcp:read', 'mcp:write', 'offline_access']);
const MAX_REDIRECT_URIS = 10;
const MAX_TEXT = 500;

export class OAuthError extends Error {
  constructor(error, description, status = 400) {
    super(description);
    this.name = 'OAuthError';
    this.oauthError = error;
    this.status = status;
  }
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function cleanText(value, maxLength = MAX_TEXT) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function parseScopes(value, { defaultScopes = ['mcp:read', 'mcp:write', 'offline_access'] } = {}) {
  const requested = cleanText(value, 500).split(/\s+/).filter(Boolean);
  const scopes = requested.length ? [...new Set(requested)] : [...defaultScopes];
  if (scopes.some(scope => !SUPPORTED_SCOPES.includes(scope))) {
    throw new OAuthError('invalid_scope', 'One or more requested scopes are not supported.');
  }
  if (!scopes.includes('mcp:read')) scopes.unshift('mcp:read');
  return scopes;
}

function validRedirectUri(value) {
  try {
    const uri = new URL(value);
    if (uri.hash || uri.username || uri.password) return false;
    if (uri.protocol === 'https:') return true;
    return uri.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(uri.hostname);
  } catch {
    return false;
  }
}

function normalizeResource(value, serviceBaseUrl) {
  let resource;
  try {
    resource = new URL(value);
  } catch {
    throw new OAuthError('invalid_target', 'The MCP resource URI is invalid.');
  }
  const service = new URL(serviceBaseUrl);
  if (resource.origin !== service.origin || resource.username || resource.password || resource.hash) {
    throw new OAuthError('invalid_target', 'The MCP resource does not belong to this authorization server.');
  }
  if (resource.protocol !== 'https:' && !(resource.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(resource.hostname))) {
    throw new OAuthError('invalid_target', 'The MCP resource must use HTTPS.');
  }
  const segments = resource.pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment));
  if (segments.length < 3 || segments[0] !== 'mcp') {
    throw new OAuthError('invalid_target', 'The MCP resource path is invalid.');
  }
  const userId = cleanText(segments[1], 128);
  const tenantId = cleanText(segments[2], 128);
  if (!userId || !tenantId) throw new OAuthError('invalid_target', 'The MCP resource scope is incomplete.');
  resource.searchParams.sort();
  return {
    resource: resource.toString(),
    userId,
    tenantId,
    connectionId: cleanText(resource.searchParams.get('connection_id'), 128)
  };
}

function clientPublicRecord(client) {
  return {
    client_id: client.id,
    client_id_issued_at: client.createdAt,
    client_name: client.name,
    redirect_uris: client.redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none'
  };
}

export function authorizationServerMetadata(serviceBaseUrl) {
  const issuer = normalizeBaseUrl(serviceBaseUrl);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: SUPPORTED_SCOPES,
    client_id_metadata_document_supported: false,
    service_documentation: `${issuer}/api/mcp/connections`
  };
}

export async function registerOAuthClient(input = {}) {
  const redirectUris = Array.isArray(input.redirect_uris) ? [...new Set(input.redirect_uris.map(String))] : [];
  if (!redirectUris.length || redirectUris.length > MAX_REDIRECT_URIS || redirectUris.some(uri => !validRedirectUri(uri))) {
    throw new OAuthError('invalid_redirect_uri', 'Provide one to ten HTTPS redirect URIs. Loopback HTTP is allowed only for local clients.');
  }
  const grantTypes = Array.isArray(input.grant_types) ? input.grant_types : ['authorization_code', 'refresh_token'];
  const responseTypes = Array.isArray(input.response_types) ? input.response_types : ['code'];
  const authMethod = input.token_endpoint_auth_method || 'none';
  if (!grantTypes.includes('authorization_code') || grantTypes.some(value => !['authorization_code', 'refresh_token'].includes(value))) {
    throw new OAuthError('invalid_client_metadata', 'Only authorization_code and refresh_token grants are supported.');
  }
  if (responseTypes.length !== 1 || responseTypes[0] !== 'code' || authMethod !== 'none') {
    throw new OAuthError('invalid_client_metadata', 'This server supports public PKCE clients with response type code and token auth method none.');
  }
  const client = {
    id: randomId('qpoacli'),
    name: cleanText(input.client_name || 'ChatGPT MCP client', 120),
    redirectUris,
    createdAt: nowSeconds(),
    lastUsedAt: null
  };
  await clientsStore.update(db => {
    db.clients = db.clients.filter(item => item.createdAt > nowSeconds() - 180 * 24 * 60 * 60);
    if (db.clients.length >= config.mcp.oauth.maxClients) {
      throw new OAuthError('temporarily_unavailable', 'The OAuth client registration limit has been reached.', 503);
    }
    db.clients.push(client);
  });
  await audit('mcp.oauth.client_registered', { clientId: client.id, clientName: client.name });
  return clientPublicRecord(client);
}

async function findClient(clientId) {
  const db = await clientsStore.read();
  return db.clients.find(item => item.id === clientId) || null;
}

async function resourceConnections(resourceInfo) {
  const connections = await activeMcpConnectionsForResource(resourceInfo);
  if (!connections.length) throw new OAuthError('access_denied', 'No active Quicker Portal MCP connection exists for this resource.', 403);
  if (!resourceInfo.connectionId) return connections;
  const selected = connections.find(item => item.id === resourceInfo.connectionId);
  if (!selected) throw new OAuthError('access_denied', 'The selected Quicker Portal MCP connection is unavailable.', 403);
  return [selected];
}

export async function beginAuthorization(params, serviceBaseUrl, requestContext = {}) {
  const responseType = cleanText(params.get('response_type'), 40);
  const clientId = cleanText(params.get('client_id'), 300);
  const redirectUri = cleanText(params.get('redirect_uri'), 2000);
  const codeChallenge = cleanText(params.get('code_challenge'), 128);
  const codeChallengeMethod = cleanText(params.get('code_challenge_method'), 20);
  const state = cleanText(params.get('state'), 2000);
  const resourceInfo = normalizeResource(params.get('resource'), serviceBaseUrl);
  if (responseType !== 'code') throw new OAuthError('unsupported_response_type', 'Only response_type=code is supported.');
  const client = await findClient(clientId);
  if (!client) throw new OAuthError('invalid_client', 'The OAuth client is unknown.', 401);
  if (!client.redirectUris.includes(redirectUri)) throw new OAuthError('invalid_request', 'The redirect_uri is not registered for this client.');
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge) || codeChallengeMethod !== 'S256') {
    throw new OAuthError('invalid_request', 'S256 PKCE with a valid code_challenge is required.');
  }
  const scopes = parseScopes(params.get('scope'));
  const connections = await resourceConnections(resourceInfo);
  const requestId = randomId('qpoar');
  const csrf = randomToken(24);
  const now = nowSeconds();
  const record = {
    id: requestId,
    clientId,
    redirectUri,
    responseType,
    codeChallenge,
    codeChallengeMethod,
    state,
    resource: resourceInfo.resource,
    resourceUserId: resourceInfo.userId,
    tenantId: resourceInfo.tenantId,
    fixedConnectionId: resourceInfo.connectionId || null,
    eligibleConnectionIds: connections.map(item => item.id),
    scopes,
    csrfHash: sha256Hex(csrf),
    createdAt: now,
    expiresAt: now + config.mcp.oauth.authorizationTtlSeconds,
    usedAt: null,
    ip: cleanText(requestContext.ip, 100),
    userAgent: cleanText(requestContext.userAgent, 200)
  };
  await authorizationStore.update(db => {
    for (const [id, item] of Object.entries(db.requests)) {
      if (item.expiresAt <= now || item.usedAt) delete db.requests[id];
    }
    db.requests[requestId] = record;
  });
  return authorizationPageModel(record, csrf, client, connections);
}

async function authorizationPageModel(record, csrf, knownClient, knownConnections) {
  if (!record || record.expiresAt <= nowSeconds() || record.usedAt || !safeEqual(record.csrfHash, sha256Hex(csrf))) {
    throw new OAuthError('invalid_request', 'This authorization request expired. Return to ChatGPT and try connecting again.');
  }
  const client = knownClient || await findClient(record.clientId);
  if (!client) throw new OAuthError('invalid_client', 'The OAuth client is no longer registered.', 401);
  const connections = knownConnections || (await activeMcpConnectionsForResource({ userId: record.resourceUserId, tenantId: record.tenantId }))
    .filter(item => record.eligibleConnectionIds.includes(item.id));
  if (!connections.length) throw new OAuthError('access_denied', 'No eligible MCP connection remains active.', 403);
  return { request: record, csrf, client, connections };
}

export async function resumeAuthorization(requestId, csrf) {
  const db = await authorizationStore.read();
  return authorizationPageModel(db.requests[cleanText(requestId, 128)], cleanText(csrf, 128));
}

function redirectWithResult(redirectUri, values) {
  const target = new URL(redirectUri);
  for (const [key, value] of Object.entries(values)) if (value) target.searchParams.set(key, value);
  return target.toString();
}

export async function completeAuthorization(input, requestContext = {}) {
  const requestId = cleanText(input.requestId, 128);
  const csrf = cleanText(input.csrf, 128);
  const model = await resumeAuthorization(requestId, csrf);
  const { request } = model;
  if (input.decision === 'deny') {
    await authorizationStore.update(db => {
      const current = db.requests[requestId];
      if (current && !current.usedAt) current.usedAt = nowSeconds();
    });
    await audit('mcp.oauth.authorization_denied', { clientId: request.clientId, userId: request.resourceUserId, tenantId: request.tenantId });
    return redirectWithResult(request.redirectUri, { error: 'access_denied', error_description: 'The user denied access.', state: request.state });
  }

  const identifier = cleanText(input.identifier, 254);
  const password = String(input.password || '').slice(0, config.password.maxLength + 1);
  if (!identifier || !password) throw new OAuthError('access_denied', 'Enter your Quicker Portal user name or email and password.', 401);
  let authenticated;
  try {
    authenticated = await login({ identifier, password, ip: requestContext.ip, userAgent: requestContext.userAgent });
  } finally {
    // The OAuth grant has its own rotating refresh token. The short-lived QP
    // login session exists only to apply the normal password/lockout policy.
    if (authenticated?.refreshToken) await logout({ refreshToken: authenticated.refreshToken });
  }
  if (authenticated.user.id !== request.resourceUserId) {
    throw new OAuthError('access_denied', 'Sign in with the Quicker Portal account that created this MCP endpoint.', 403);
  }
  const entitlements = await entitlementsForUser(authenticated.user.id);
  if (!entitlements.features.includes('mcp.server')) throw new OAuthError('access_denied', 'An active Quicker Portal Pro plan is required.', 403);

  const connectionId = request.fixedConnectionId || cleanText(input.connectionId, 128);
  if (!request.eligibleConnectionIds.includes(connectionId)) throw new OAuthError('access_denied', 'Select an eligible MCP connection.', 403);
  const connection = await findMcpConnectionById(connectionId);
  if (!connection?.enabled || connection.userId !== request.resourceUserId || connection.tenantId.toLowerCase() !== request.tenantId.toLowerCase()) {
    throw new OAuthError('access_denied', 'The selected MCP connection is no longer active.', 403);
  }

  const consumed = await authorizationStore.update(db => {
    const current = db.requests[requestId];
    if (!current || current.usedAt || current.expiresAt <= nowSeconds() || !safeEqual(current.csrfHash, sha256Hex(csrf))) return { result: false };
    current.usedAt = nowSeconds();
    return { result: true };
  });
  if (!consumed) throw new OAuthError('invalid_request', 'This authorization request was already completed.');

  const codeId = randomId('qpoac');
  const codeSecret = randomToken(32);
  const code = `${codeId}.${codeSecret}`;
  const now = nowSeconds();
  await tokenStore.update(db => {
    for (const [id, item] of Object.entries(db.codes)) if (item.expiresAt <= now || item.usedAt) delete db.codes[id];
    db.codes[codeId] = {
      id: codeId,
      codeHash: sha256Hex(code),
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      resource: request.resource,
      userId: request.resourceUserId,
      tenantId: request.tenantId,
      connectionId,
      scopes: request.scopes,
      createdAt: now,
      expiresAt: now + config.mcp.oauth.codeTtlSeconds,
      usedAt: null
    };
  });
  await audit('mcp.oauth.authorization_approved', { clientId: request.clientId, userId: request.resourceUserId, tenantId: request.tenantId, connectionId, scopes: request.scopes });
  return redirectWithResult(request.redirectUri, { code, state: request.state });
}

function pkceMatches(verifier, challenge) {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const calculated = createHash('sha256').update(verifier).digest('base64url');
  return safeEqual(calculated, challenge);
}

function createGrantTokens(grant, includeRefreshToken = true) {
  const accessSecret = randomToken(32);
  const accessToken = `qpoat.${grant.id}.${accessSecret}`;
  const refreshSecret = includeRefreshToken ? randomToken(32) : '';
  const refreshToken = includeRefreshToken ? `qport.${grant.id}.${refreshSecret}` : '';
  grant.accessTokenHash = sha256Hex(accessToken);
  grant.accessExpiresAt = nowSeconds() + config.mcp.oauth.accessTtlSeconds;
  if (includeRefreshToken) {
    grant.refreshTokenHash = sha256Hex(refreshToken);
    grant.refreshExpiresAt = nowSeconds() + config.mcp.oauth.refreshTtlSeconds;
  }
  return { accessToken, refreshToken };
}

function tokenResponse(grant, tokens) {
  return {
    access_token: tokens.accessToken,
    token_type: 'Bearer',
    expires_in: config.mcp.oauth.accessTtlSeconds,
    scope: grant.scopes.join(' '),
    ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {})
  };
}

export async function exchangeAuthorizationCode(input) {
  const clientId = cleanText(input.client_id, 300);
  const code = cleanText(input.code, 1000);
  const redirectUri = cleanText(input.redirect_uri, 2000);
  const verifier = cleanText(input.code_verifier, 256);
  const resource = cleanText(input.resource, 3000);
  if (!await findClient(clientId)) throw new OAuthError('invalid_client', 'The OAuth client is unknown.', 401);
  const [codeId] = code.split('.');
  let issued;
  await tokenStore.update(db => {
    const record = db.codes[codeId];
    if (!record || record.usedAt || record.expiresAt <= nowSeconds() || !safeEqual(record.codeHash, sha256Hex(code))) {
      throw new OAuthError('invalid_grant', 'The authorization code is invalid, expired, or already used.');
    }
    if (record.clientId !== clientId || record.redirectUri !== redirectUri || record.resource !== resource || !pkceMatches(verifier, record.codeChallenge)) {
      throw new OAuthError('invalid_grant', 'The authorization code binding could not be verified.');
    }
    record.usedAt = nowSeconds();
    const grant = {
      id: randomId('qpog'),
      clientId,
      userId: record.userId,
      tenantId: record.tenantId,
      connectionId: record.connectionId,
      resource: record.resource,
      scopes: record.scopes,
      createdAt: nowSeconds(),
      lastUsedAt: null,
      previousRefreshTokenHashes: [],
      revokedAt: null,
      revokedReason: null
    };
    const tokens = createGrantTokens(grant, grant.scopes.includes('offline_access'));
    db.grants[grant.id] = grant;
    issued = { grant, tokens };
  });
  await audit('mcp.oauth.token_issued', { grantId: issued.grant.id, clientId, userId: issued.grant.userId, connectionId: issued.grant.connectionId });
  return tokenResponse(issued.grant, issued.tokens);
}

export async function refreshOAuthToken(input) {
  const clientId = cleanText(input.client_id, 300);
  const presented = cleanText(input.refresh_token, 1000);
  const resource = cleanText(input.resource, 3000);
  if (!await findClient(clientId)) throw new OAuthError('invalid_client', 'The OAuth client is unknown.', 401);
  const parts = presented.split('.');
  if (parts.length !== 3 || parts[0] !== 'qport') throw new OAuthError('invalid_grant', 'The refresh token is invalid.');
  const grantId = parts[1];
  let issued;
  await tokenStore.update(db => {
    const grant = db.grants[grantId];
    const presentedHash = sha256Hex(presented);
    if (!grant || grant.clientId !== clientId || grant.resource !== resource || grant.revokedAt || grant.refreshExpiresAt <= nowSeconds()) {
      throw new OAuthError('invalid_grant', 'The refresh token is invalid or expired.');
    }
    if (grant.previousRefreshTokenHashes.includes(presentedHash)) {
      grant.revokedAt = nowSeconds();
      grant.revokedReason = 'refresh_token_reuse';
      issued = { reuseDetected: true, grant };
      return;
    }
    if (!safeEqual(grant.refreshTokenHash, presentedHash)) throw new OAuthError('invalid_grant', 'The refresh token is invalid.');
    grant.previousRefreshTokenHashes = [...grant.previousRefreshTokenHashes.slice(-9), grant.refreshTokenHash];
    const tokens = createGrantTokens(grant, true);
    grant.lastUsedAt = nowSeconds();
    issued = { grant, tokens };
  });
  if (issued?.reuseDetected) {
    await audit('mcp.oauth.refresh_reuse_detected', { grantId, clientId, userId: issued.grant.userId });
    throw new OAuthError('invalid_grant', 'Refresh token reuse was detected. Reconnect the MCP app.');
  }
  await audit('mcp.oauth.token_refreshed', { grantId, clientId, userId: issued.grant.userId, connectionId: issued.grant.connectionId });
  return tokenResponse(issued.grant, issued.tokens);
}

export async function revokeOAuthToken(input) {
  const presented = cleanText(input.token, 1000);
  const parts = presented.split('.');
  if (parts.length !== 3 || !['qpoat', 'qport'].includes(parts[0])) return;
  await tokenStore.update(db => {
    const grant = db.grants[parts[1]];
    if (!grant) return;
    const tokenHash = sha256Hex(presented);
    if (safeEqual(grant.accessTokenHash, tokenHash) || safeEqual(grant.refreshTokenHash, tokenHash)) {
      grant.revokedAt = nowSeconds();
      grant.revokedReason = 'client_revocation';
    }
  });
}

export async function authenticateMcpOAuthToken({ authorization, resource }) {
  const token = String(authorization || '').startsWith('Bearer ') ? String(authorization).slice(7).trim() : '';
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'qpoat') throw new OAuthError('invalid_token', 'The OAuth access token is invalid.', 401);
  const db = await tokenStore.read();
  const grant = db.grants[parts[1]];
  if (!grant || grant.revokedAt || grant.accessExpiresAt <= nowSeconds() || grant.resource !== resource || !safeEqual(grant.accessTokenHash, sha256Hex(token))) {
    throw new OAuthError('invalid_token', 'The OAuth access token is invalid, expired, or intended for another resource.', 401);
  }
  const connection = await findMcpConnectionById(grant.connectionId);
  if (!connection?.enabled || connection.userId !== grant.userId || connection.tenantId.toLowerCase() !== grant.tenantId.toLowerCase()) {
    throw new OAuthError('invalid_token', 'The Quicker Portal MCP connection was revoked.', 401);
  }
  if (!grant.lastUsedAt || nowSeconds() - grant.lastUsedAt > 60) {
    tokenStore.update(current => {
      const found = current.grants[grant.id];
      if (found) found.lastUsedAt = nowSeconds();
      return {};
    }).catch(() => {});
  }
  return { ...connection, oauth: true, oauthGrantId: grant.id, scopes: grant.scopes };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

export function renderAuthorizationPage(model, { error = '' } = {}) {
  const { request, csrf, client, connections } = model;
  const scopeLabels = {
    'mcp:read': 'Read Power Platform metadata and records through your connected desktop',
    'mcp:write': 'Request changes; Quicker Portal still asks for local approval',
    offline_access: 'Stay connected using rotating refresh tokens'
  };
  const connectionChoices = connections.map(connection => `
    <label class="connection-option">
      <input type="radio" name="connectionId" value="${escapeHtml(connection.id)}" ${connections.length === 1 ? 'checked' : ''} required>
      <span><strong>${escapeHtml(connection.environmentName || connection.name)}</strong><small>${escapeHtml(connection.tenantName || connection.tenantId)}</small></span>
    </label>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Quicker Portal MCP</title><style>
    *{box-sizing:border-box}body{margin:0;min-height:100vh;background:linear-gradient(135deg,#edf5ff,#f8f6fb 55%,#fff);color:#242424;font:14px/1.45 "Segoe UI",sans-serif;display:grid;place-items:center;padding:24px}.card{width:min(590px,100%);background:#fff;border:1px solid #ddd;border-radius:8px;box-shadow:0 16px 50px #18395d20;overflow:hidden}.head{padding:24px 28px 18px;border-bottom:1px solid #e5e5e5}.brand{display:flex;align-items:center;gap:10px;color:#0f6cbd;font-weight:600}.mark{width:30px;height:30px;border-radius:5px;background:#0f6cbd;color:#fff;display:grid;place-items:center}.head h1{font-size:24px;font-weight:600;margin:18px 0 4px}.head p{margin:0;color:#616161}.body{padding:22px 28px}.client{background:#f5f9fd;border-left:3px solid #0f6cbd;padding:12px 14px;margin-bottom:18px}.client strong,.client span{display:block}.client span{font-size:12px;color:#616161;margin-top:2px}.error{background:#fde7e9;color:#a4262c;padding:10px 12px;margin-bottom:16px;border-left:3px solid #c50f1f}.field{display:grid;gap:6px;margin-top:13px}.field>span,.section-title{font-size:12px;font-weight:600}.field input{height:38px;border:1px solid #8a8886;padding:0 10px;font:inherit}.field input:focus{outline:2px solid #0f6cbd;outline-offset:-1px}.connections{display:grid;gap:7px;margin-top:8px}.connection-option{display:flex;gap:10px;align-items:center;border:1px solid #ddd;padding:10px 12px;cursor:pointer}.connection-option:has(input:checked){border-color:#0f6cbd;background:#f3f9fd}.connection-option span{display:grid}.connection-option small{color:#616161}.permissions{margin:8px 0 0;padding:0;list-style:none;display:grid;gap:7px}.permissions li{display:flex;gap:8px;color:#424242}.permissions li:before{content:'✓';color:#107c10;font-weight:700}.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:22px}.actions button{min-height:36px;padding:0 16px;border:1px solid #8a8886;background:#fff;font:600 14px inherit;cursor:pointer}.actions .primary{background:#0f6cbd;border-color:#0f6cbd;color:#fff}.foot{font-size:11px;color:#616161;padding:13px 28px;background:#fafafa;border-top:1px solid #e5e5e5}@media(max-width:560px){body{padding:0}.card{border:0;border-radius:0;min-height:100vh}.head,.body{padding-left:20px;padding-right:20px}.actions{display:grid}.actions button{width:100%}}
  </style></head><body><main class="card"><header class="head"><div class="brand"><span class="mark">QP</span>Quicker Portal</div><h1>Connect your Power Platform environment</h1><p>Sign in to Quicker Portal and approve the access requested by ${escapeHtml(client.name)}.</p></header><section class="body">
    ${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ''}
    <div class="client"><strong>${escapeHtml(client.name)}</strong><span>${escapeHtml(request.resource)}</span></div>
    <form method="post" action="/oauth/authorize"><input type="hidden" name="requestId" value="${escapeHtml(request.id)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <label class="field"><span>User name or email</span><input name="identifier" autocomplete="username" maxlength="254" required autofocus></label>
      <label class="field"><span>Password</span><input type="password" name="password" autocomplete="current-password" maxlength="${config.password.maxLength}" required></label>
      <div class="field"><span class="section-title">Environment connection</span><div class="connections">${connectionChoices}</div></div>
      <div class="field"><span class="section-title">Permissions requested</span><ul class="permissions">${request.scopes.map(scope => `<li>${escapeHtml(scopeLabels[scope] || scope)}</li>`).join('')}</ul></div>
      <div class="actions"><button name="decision" value="deny" formnovalidate>Cancel</button><button class="primary" name="decision" value="approve">Authorize</button></div>
    </form></section><footer class="foot">Your Microsoft credentials remain in the Quicker Portal desktop. OAuth tokens are limited to this MCP endpoint and selected connection.</footer></main></body></html>`;
}

export function oauthErrorBody(error) {
  return {
    error: error instanceof OAuthError ? error.oauthError : 'server_error',
    error_description: error?.message || 'The OAuth request failed.'
  };
}
