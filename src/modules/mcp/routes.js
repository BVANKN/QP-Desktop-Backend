import { authenticate } from '../../core/middleware/authenticate.js';
import { readFormBody, readJsonBody, sendHtml, sendJson, sendRedirect } from '../../core/http/context.js';
import { config } from '../../config/config.js';
import {
  createMcpConnection,
  devOpsMcpConnectionEndpoint,
  ensureDevOpsMcpConnection,
  ensurePowerPagesMcpConnection,
  ensureSharePointMcpConnection,
  setDevOpsMcpGrant,
  listMcpConnections,
  mcpConnectionEndpoint,
  mcpResourceMetadata,
  powerPagesMcpConnectionEndpoint,
  deleteMcpConnection,
  setMcpConnectionToolPolicy,
  setMcpConnectionToolScope,
  setMcpConnectionExecutionMode,
  revokeMcpConnection,
  sharePointMcpConnectionEndpoint
} from './connections.js';
import { claimDesktopJobs, completeDesktopJob, desktopStatus, heartbeatDesktop } from './broker.js';
import { waitForSignal } from './signals.js';
import { buildTransmissionDiagnosticReport, clearTransmissionAnalytics, queryTransmissionAnalytics, TRANSMISSION_RETENTION } from './analytics.js';
import { CEILINGS, DEFAULT_POLICY, DEVOPS_DEFAULT_POLICY, subjectsForResource, summarizePolicy } from './tool-policy.js';
import { GATEWAY_DOMAINS, GATEWAY_CAPABILITY_PACKS, gatewayTool, gatewayToolsForDomains, gatewayToolsForScope, gatewayScopeSummary } from './gateway-taxonomy.js';
import { summarizeDevOpsGrant } from './devops-grant.js';
import { MCP_TOOLS } from './tool-catalog.js';
import { handleMcpRequest } from './protocol.js';
import { entitlementsForUser } from '../plans/subscription-store.js';
import { ForbiddenError } from '../../core/errors.js';
import { consumeRateLimit } from '../../core/middleware/rate-limit.js';
import { logger } from '../../core/logger.js';
import { buildInfo } from '../../lib/build-info.js';
import { listOAuthGrantRecords } from './oauth-store.js';
import { buildConnectionHealth } from './connection-health.js';
import {
  OAuthError,
  authorizationServerMetadata,
  beginAuthorization,
  completeAuthorization,
  exchangeAuthorizationCode,
  oauthErrorBody,
  refreshOAuthToken,
  registerOAuthClient,
  renderAuthorizationPage,
  resumeAuthorization,
  revokeOAuthToken
} from './oauth.js';

async function requireMcpEntitlement(ctx) {
  const entitlements = await entitlementsForUser(ctx.auth.sub);
  if (!entitlements.features.includes('mcp.server')) {
    throw new ForbiddenError('Quicker Portal MCP is available on the Pro plan.', 'MCP_PLAN_REQUIRED');
  }
}

export function endpointBase(ctx) {
  if (config.mcp.publicBaseUrl) return config.mcp.publicBaseUrl.replace(/\/+$/, '');
  const protocol = process.env.QP_BACKEND_TRUST_PROXY === '1'
    ? String(ctx.req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim()
    : ctx.url.protocol.replace(':', '');
  return `${protocol}://${ctx.req.headers.host}`;
}

function protectedResourceUrl(ctx) {
  const base = endpointBase(ctx);
  const prefix = '/.well-known/oauth-protected-resource';
  const resourcePath = ctx.pathname.startsWith(`${prefix}/`) ? ctx.pathname.slice(prefix.length) : '/mcp';
  return `${base}${resourcePath}${ctx.url.search}`;
}

function sendOAuthError(ctx, error) {
  const status = error instanceof OAuthError ? error.status : 500;
  sendJson(ctx, status, oauthErrorBody(error));
}

function sendAuthorizationErrorPage(ctx, error) {
  const message = error?.expose === false ? 'The authorization request failed.' : error?.message || 'The authorization request failed.';
  sendHtml(ctx, error?.status || 400, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorization failed</title><style>body{font:14px "Segoe UI",sans-serif;background:#f5f5f5;color:#242424;display:grid;place-items:center;min-height:100vh;margin:0}.card{max-width:540px;background:#fff;border:1px solid #ddd;padding:28px;box-shadow:0 8px 28px #0002}h1{font-size:22px;font-weight:600;color:#a4262c}p{line-height:1.5}</style></head><body><main class="card"><h1>Authorization could not be completed</h1><p>${String(message).replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value])}</p><p>Return to ChatGPT and try connecting again.</p></main></body></html>`);
}

// Chromium applies form-action to redirects after a form POST. Permit only the
// pre-registered OAuth callback origin so the authorization code can return.
function authorizationPageHeaders(model) {
  let redirectOrigin = '';
  try {
    redirectOrigin = new URL(model?.request?.redirectUri || '').origin;
  } catch {
    // beginAuthorization/resumeAuthorization already validate redirect URIs.
  }
  const formActions = ["'self'", redirectOrigin].filter(Boolean).join(' ');
  return {
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action ${formActions}; base-uri 'none'; frame-ancestors 'none'`,
    'Referrer-Policy': 'no-referrer'
  };
}

function safeAuthorizationRetryPath(value) {
  const path = String(value || '').trim();
  if (!path.startsWith('/oauth/authorize?') || path.length > 12_000) return '';
  try {
    const parsed = new URL(path, 'https://quicker-portal.invalid');
    if (parsed.origin !== 'https://quicker-portal.invalid' || parsed.pathname !== '/oauth/authorize') return '';
    for (const required of ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'resource']) {
      if (!parsed.searchParams.get(required)) return '';
    }
    parsed.searchParams.set('qp_retry', '1');
    return `${parsed.pathname}?${parsed.searchParams.toString()}`;
  } catch {
    return '';
  }
}

export function registerMcpRoutes(router, { ideMcp } = {}) {
  router.get('/.well-known/oauth-protected-resource', ctx => {
    sendJson(ctx, 200, mcpResourceMetadata(`${endpointBase(ctx)}/mcp`, endpointBase(ctx)));
  });
  router.get('/.well-known/oauth-protected-resource/mcp/:userId/:tenantId', ctx => {
    sendJson(ctx, 200, mcpResourceMetadata(protectedResourceUrl(ctx), endpointBase(ctx)));
  });
  router.get('/.well-known/oauth-protected-resource/mcp/:userId/:tenantId/:toolName', ctx => {
    sendJson(ctx, 200, mcpResourceMetadata(protectedResourceUrl(ctx), endpointBase(ctx)));
  });
  router.get('/.well-known/oauth-protected-resource/gateway/mcp/:userId/:tenantId', ctx => {
    sendJson(ctx, 200, mcpResourceMetadata(protectedResourceUrl(ctx), endpointBase(ctx), { kind: 'gateway' }));
  });
  router.get('/.well-known/oauth-protected-resource/gateway/mcp/:userId/:tenantId/:domain', ctx => {
    sendJson(ctx, 200, mcpResourceMetadata(protectedResourceUrl(ctx), endpointBase(ctx), { kind: 'gateway' }));
  });
  router.get('/.well-known/oauth-protected-resource/ide/mcp/:userId', ctx => {
    sendJson(ctx, 200, mcpResourceMetadata(protectedResourceUrl(ctx), endpointBase(ctx), { ide: true }));
  });
  router.get('/.well-known/oauth-protected-resource/devops/mcp/:userId', ctx => {
    sendJson(ctx, 200, mcpResourceMetadata(protectedResourceUrl(ctx), endpointBase(ctx), { kind: 'devops' }));
  });
  router.get('/.well-known/oauth-protected-resource/sharepoint/mcp/:userId', ctx => {
    sendJson(ctx, 200, mcpResourceMetadata(protectedResourceUrl(ctx), endpointBase(ctx), { kind: 'sharepoint' }));
  });
  router.get('/.well-known/oauth-protected-resource/powerpages/mcp/:userId/:tenantId', ctx => {
    sendJson(ctx, 200, mcpResourceMetadata(protectedResourceUrl(ctx), endpointBase(ctx), { kind: 'powerpages' }));
  });

  router.get('/.well-known/oauth-authorization-server', ctx => {
    sendJson(ctx, 200, authorizationServerMetadata(endpointBase(ctx)));
  });
  router.post('/oauth/register', async ctx => {
    consumeRateLimit('oauth-register', ctx.ip, config.rateLimit.oauthRegister);
    try {
      const client = await registerOAuthClient(await readJsonBody(ctx));
      sendJson(ctx, 201, client);
    } catch (error) {
      sendOAuthError(ctx, error);
    }
  });
  router.get('/oauth/authorize', async ctx => {
    consumeRateLimit('oauth-authorize', ctx.ip, config.rateLimit.oauthAuthorize);
    try {
      const model = await beginAuthorization(ctx.url.searchParams, endpointBase(ctx), {
        ip: ctx.ip,
        userAgent: ctx.req.headers['user-agent']
      });
      sendHtml(ctx, 200, renderAuthorizationPage(model, {
        notice: ctx.url.searchParams.get('qp_retry') === '1'
          ? 'The previous sign-in request was refreshed. Please authorize again.'
          : ''
      }), authorizationPageHeaders(model));
    } catch (error) {
      sendAuthorizationErrorPage(ctx, error);
    }
  });
  router.post('/oauth/authorize', async ctx => {
    consumeRateLimit('oauth-authorize', ctx.ip, config.rateLimit.oauthAuthorize);
    const form = await readFormBody(ctx);
    const requestId = form.get('requestId') || '';
    const csrf = form.get('csrf') || '';
    const retryPath = safeAuthorizationRetryPath(form.get('retryPath'));
    try {
      const redirect = await completeAuthorization({
        requestId,
        csrf,
        decision: form.get('decision') || 'approve',
        identifier: form.get('identifier') || '',
        password: form.get('password') || '',
        connectionId: form.get('connectionId') || ''
      }, { ip: ctx.ip, userAgent: ctx.req.headers['user-agent'] });
      logger.info('MCP OAuth authorization approved; redirecting to the registered client.', {
        requestId,
        redirectOrigin: new URL(redirect).origin,
        requestIdHeader: ctx.requestId
      });
      sendRedirect(ctx, redirect, 303);
    } catch (error) {
      if (retryPath && ['authorization_missing', 'authorization_expired'].includes(error?.reason)) {
        logger.warn('MCP OAuth authorization transaction was refreshed.', {
          requestId,
          reason: error.reason,
          requestIdHeader: ctx.requestId
        });
        return sendRedirect(ctx, retryPath, 303);
      }
      try {
        const model = await resumeAuthorization(requestId, csrf);
        sendHtml(ctx, error?.status || 400, renderAuthorizationPage(model, { error: error.message }), authorizationPageHeaders(model));
      } catch {
        sendAuthorizationErrorPage(ctx, error);
      }
    }
  });
  router.post('/oauth/token', async ctx => {
    consumeRateLimit('oauth-token', ctx.ip, config.rateLimit.oauthToken);
    let grantType = 'unknown';
    try {
      const form = await readFormBody(ctx);
      const input = Object.fromEntries(form);
      grantType = String(input.grant_type || 'unknown').slice(0, 40);
      let tokens;
      if (input.grant_type === 'authorization_code') tokens = await exchangeAuthorizationCode(input);
      else if (input.grant_type === 'refresh_token') tokens = await refreshOAuthToken(input, {
        ip: ctx.ip,
        userAgent: ctx.req.headers['user-agent']
      });
      else throw new OAuthError('unsupported_grant_type', 'Only authorization_code and refresh_token are supported.');
      logger.info('MCP OAuth token grant completed.', {
        grantType,
        clientIdPrefix: String(input.client_id || '').slice(0, 16),
        requestIdHeader: ctx.requestId
      });
      sendJson(ctx, 200, tokens, { Pragma: 'no-cache' });
    } catch (error) {
      logger.warn('MCP OAuth token grant failed.', {
        grantType,
        error: error?.oauthError || error?.name || 'server_error',
        reason: error?.message || 'The token request failed.',
        requestIdHeader: ctx.requestId
      });
      sendOAuthError(ctx, error);
    }
  });
  router.post('/oauth/revoke', async ctx => {
    consumeRateLimit('oauth-token', ctx.ip, config.rateLimit.oauthToken);
    try {
      const form = await readFormBody(ctx);
      await revokeOAuthToken(Object.fromEntries(form));
      ctx.res.writeHead(200, { 'Cache-Control': 'no-store' });
      ctx.res.end();
    } catch (error) {
      sendOAuthError(ctx, error);
    }
  });

  router.get('/api/mcp/tools', authenticate, requireMcpEntitlement, ctx => {
    sendJson(ctx, 200, { ok: true, domains: GATEWAY_DOMAINS, capabilityPacks: GATEWAY_CAPABILITY_PACKS, tools: MCP_TOOLS.map(gatewayTool) });
  });
  // Azure DevOps runs as the Microsoft account signed in to the desktop, so
  // there is nothing tenant-side to configure: no app registration, no personal
  // access token. What there is to decide is which organizations and projects
  // an AI may reach, and that starts empty.
  router.get('/api/mcp/devops/bootstrap', authenticate, requireMcpEntitlement, async ctx => {
    const connection = await ensureDevOpsMcpConnection(ctx.auth.sub);
    const mcpUrl = devOpsMcpConnectionEndpoint(endpointBase(ctx), ctx.auth.sub);
    sendJson(ctx, 200, {
      ok: true,
      connection,
      grant: connection.devopsGrant,
      grantSummary: summarizeDevOpsGrant(connection.devopsGrant),
      mcpUrl,
      endpoint: mcpUrl,
      oauth: { url: mcpUrl, authentication: 'oauth', discovery: 'automatic', scopes: ['mcp:read', 'mcp:write', 'offline_access'] },
      desktop: desktopStatus(ctx.auth.sub, 'devops', 'devops'),
      devOps: {
        authentication: 'desktop-microsoft-account',
        appRegistrationRequired: false,
        personalAccessTokenRequired: false
      }
    });
  });
  router.put('/api/mcp/devops/access', authenticate, requireMcpEntitlement, async ctx => {
    const body = await readJsonBody(ctx);
    const connection = await setDevOpsMcpGrant(ctx.auth.sub, body?.grant ?? body);
    sendJson(ctx, 200, { ok: true, connection, grant: connection.devopsGrant, grantSummary: summarizeDevOpsGrant(connection.devopsGrant) });
  });
  router.get('/api/mcp/sharepoint/bootstrap', authenticate, requireMcpEntitlement, async ctx => {
    const connection = await ensureSharePointMcpConnection(ctx.auth.sub);
    const mcpUrl = sharePointMcpConnectionEndpoint(endpointBase(ctx), ctx.auth.sub);
    sendJson(ctx, 200, {
      ok: true,
      connection,
      mcpUrl,
      endpoint: mcpUrl,
      oauth: {
        url: mcpUrl,
        authentication: 'oauth',
        discovery: 'automatic',
        scopes: ['mcp:read', 'mcp:write', 'offline_access']
      },
      desktop: desktopStatus(ctx.auth.sub, 'sharepoint', 'sharepoint'),
      sharePoint: {
        authentication: 'connected-desktop-browser-session',
        appRegistrationRequired: false,
        customerTenantConfigurationRequired: false
      }
    });
  });
  router.get('/api/mcp/powerpages/bootstrap', authenticate, requireMcpEntitlement, async ctx => {
    const tenantId = ctx.url.searchParams.get('tenantId') || '';
    const environmentId = ctx.url.searchParams.get('environmentId') || '';
    const connection = await ensurePowerPagesMcpConnection(ctx.auth.sub, {
      tenantId,
      environmentId,
      tenantName: ctx.url.searchParams.get('tenantName') || '',
      environmentName: ctx.url.searchParams.get('environmentName') || ''
    });
    const mcpUrl = powerPagesMcpConnectionEndpoint(endpointBase(ctx), ctx.auth.sub, tenantId);
    sendJson(ctx, 200, {
      ok: true,
      connection,
      mcpUrl,
      endpoint: mcpUrl,
      oauth: { url: mcpUrl, authentication: 'oauth', discovery: 'automatic', scopes: ['mcp:read', 'mcp:write', 'offline_access'] },
      desktop: desktopStatus(ctx.auth.sub, `powerpages:${tenantId}`, environmentId),
      powerPages: { environmentId, modelDetection: 'automatic', execution: 'connected-desktop', localWriteApproval: true }
    });
  });
  router.get('/api/mcp/connection-health', authenticate, requireMcpEntitlement, async ctx => {
    const [connections, grants] = await Promise.all([listMcpConnections(ctx.auth.sub, { includeSpecial: true }), listOAuthGrantRecords({ userId: ctx.auth.sub })]);
    sendJson(ctx, 200, {
      ok: true, schemaVersion: 1, checkedAt: new Date().toISOString(), backend: buildInfo,
      oauthPolicy: { accessTtlSeconds: config.mcp.oauth.accessTtlSeconds, refreshTtlSeconds: config.mcp.oauth.refreshTtlSeconds, refreshRetryGraceSeconds: config.mcp.oauth.refreshRetryGraceSeconds },
      connections: buildConnectionHealth({ userId: ctx.auth.sub, connections, grants, desktopStatus, ideStatus: ideMcp?.status(ctx.auth.sub) })
    }, { 'Cache-Control': 'no-store' });
  });
  router.get('/api/mcp/connections', authenticate, requireMcpEntitlement, async ctx => {
    const connections = await listMcpConnections(ctx.auth.sub);
    sendJson(ctx, 200, { ok: true, connections: connections.map(connection => ({
      ...connection,
      endpoint: mcpConnectionEndpoint(endpointBase(ctx), connection),
      desktop: desktopStatus(ctx.auth.sub, connection.tenantId, connection.environmentId)
    })) });
  });
  router.get('/api/mcp/gateway/catalog', authenticate, requireMcpEntitlement, ctx => {
    const domains = GATEWAY_DOMAINS.map(domain => {
      const tools = gatewayToolsForDomains(MCP_TOOLS, [domain.id]);
      const packs = (GATEWAY_CAPABILITY_PACKS[domain.id] || []).map(pack => ({
        id: pack.id,
        label: pack.label,
        description: pack.description,
        toolCount: tools.filter(tool => gatewayTool(tool).gatewayPackId === pack.id).length,
        sections: [...pack.sections]
      }));
      return { ...domain, toolCount: tools.length, sections: [...new Set(tools.map(tool => gatewayTool(tool).gatewaySection))], packs };
    });
    sendJson(ctx, 200, { ok: true, domains, capabilityPacks: GATEWAY_CAPABILITY_PACKS, combined: gatewayScopeSummary(MCP_TOOLS, domains.map(domain => domain.id)), ide: { combined: false, reason: 'IDE MCP remains a dedicated local-workspace endpoint with its own authorization and file-safety contract.' } });
  });
  router.post('/api/mcp/connections', authenticate, requireMcpEntitlement, async ctx => {
    const body = await readJsonBody(ctx);
    const created = await createMcpConnection(ctx.auth.sub, body, endpointBase(ctx));
    sendJson(ctx, 201, { ok: true, ...created });
  });
  router.delete('/api/mcp/connections/:connectionId', authenticate, requireMcpEntitlement, async ctx => {
    const connection = await revokeMcpConnection(ctx.auth.sub, ctx.params.connectionId);
    sendJson(ctx, 200, { ok: true, connection });
  });
  // Separate from the revoke route on purpose. Removing the record is not a
  // stronger revoke, it is a different decision, and it should not be
  // reachable by varying a flag on the same request.
  // What a connection may reach, and what that choice actually permits. The
  // catalog is returned with it so the desktop never has to keep its own copy
  // of the classification in step with the server's.
  // A connection's policy only ever governs its own resource's tools, so the
  // subjects offered and the counts shown are that resource's alone. Counting
  // every tool in the catalog made a Power Platform connection look as though
  // it withheld SharePoint and Azure DevOps tools it could never have used.
  const resourceTools = resource => resource === 'gateway' ? MCP_TOOLS : MCP_TOOLS.filter(tool => (tool.group || 'power-platform') === resource);
  const policyResource = value => (['power-platform', 'devops', 'sharepoint', 'powerpages', 'gateway'].includes(String(value || '')) ? String(value) : 'power-platform');
  const connectionTools = connection => {
    const base = connection?.kind === 'gateway' ? gatewayToolsForScope(MCP_TOOLS, connection.gatewayDomains, connection.gatewayPacks, connection.toolAllowlist) : resourceTools(policyResource(connection?.kind));
    return Array.isArray(connection?.toolAllowlist) ? base.filter(tool => connection.toolAllowlist.includes(tool.name)) : base;
  };
  router.get('/api/mcp/tool-policy/catalog', authenticate, requireMcpEntitlement, ctx => {
    const resource = policyResource(ctx.url.searchParams.get('resource'));
    sendJson(ctx, 200, {
      ok: true,
      resource,
      subjects: subjectsForResource(resource),
      ceilings: CEILINGS,
      defaultPolicy: resource === 'devops' ? DEVOPS_DEFAULT_POLICY : DEFAULT_POLICY,
      totalTools: resourceTools(resource).length
    });
  });
  router.put('/api/mcp/connections/:connectionId/tool-policy', authenticate, requireMcpEntitlement, async ctx => {
    const body = await readJsonBody(ctx);
    const connection = await setMcpConnectionToolPolicy(ctx.auth.sub, ctx.params.connectionId, body?.policy ?? body);
    sendJson(ctx, 200, { ok: true, connection, summary: summarizePolicy(connectionTools(connection), connection.toolPolicy) });
  });
  router.put('/api/mcp/connections/:connectionId/tool-scope', authenticate, requireMcpEntitlement, async ctx => {
    const body = await readJsonBody(ctx);
    const connection = await setMcpConnectionToolScope(ctx.auth.sub, ctx.params.connectionId, body?.toolAllowlist ?? body?.tools ?? body);
    sendJson(ctx, 200, { ok: true, connection, tools: connectionTools(connection).map(gatewayTool) });
  });
  router.put('/api/mcp/connections/:connectionId/execution-mode', authenticate, requireMcpEntitlement, async ctx => {
    const body = await readJsonBody(ctx);
    const connection = await setMcpConnectionExecutionMode(ctx.auth.sub, ctx.params.connectionId, body?.executionMode);
    sendJson(ctx, 200, { ok: true, connection });
  });
  router.post('/api/mcp/tool-policy/preview', authenticate, requireMcpEntitlement, async ctx => {
    const body = await readJsonBody(ctx);
    sendJson(ctx, 200, { ok: true, summary: summarizePolicy(resourceTools(policyResource(body?.resource)), body?.policy ?? body) });
  });
  router.delete('/api/mcp/connections/:connectionId/permanent', authenticate, requireMcpEntitlement, async ctx => {
    const deleted = await deleteMcpConnection(ctx.auth.sub, ctx.params.connectionId);
    sendJson(ctx, 200, { ok: true, ...deleted });
  });
  router.get('/api/mcp/analytics', authenticate, requireMcpEntitlement, async ctx => {
    const analytics = await queryTransmissionAnalytics(ctx.auth.sub, {
      tenantId: ctx.url.searchParams.get('tenantId') || '',
      environmentId: ctx.url.searchParams.get('environmentId') || '',
      toolName: ctx.url.searchParams.get('toolName') || '',
      transmissionId: ctx.url.searchParams.get('transmissionId') || '',
      includePayloads: ctx.url.searchParams.get('includePayloads') === 'true',
      since: ctx.url.searchParams.get('since') || '',
      limit: ctx.url.searchParams.get('limit') || 200
    });
    sendJson(ctx, 200, { ok: true, analytics, retention: TRANSMISSION_RETENTION });
  });
  router.get('/api/mcp/analytics/report', authenticate, requireMcpEntitlement, async ctx => {
    const report = await buildTransmissionDiagnosticReport(ctx.auth.sub, {
      tenantId: ctx.url.searchParams.get('tenantId') || '',
      environmentId: ctx.url.searchParams.get('environmentId') || '',
      toolName: ctx.url.searchParams.get('toolName') || ''
    }, {
      backend: buildInfo,
      node: process.version
    });
    sendJson(ctx, 200, { ok: true, report });
  });
  router.delete('/api/mcp/analytics', authenticate, requireMcpEntitlement, async ctx => {
    if (ctx.url.searchParams.get('confirm') !== 'true') throw new ForbiddenError('Confirm clearing MCP transmission history before continuing.');
    const cleared = await clearTransmissionAnalytics(ctx.auth.sub, {
      tenantId: ctx.url.searchParams.get('tenantId') || '',
      environmentId: ctx.url.searchParams.get('environmentId') || '',
      toolName: ctx.url.searchParams.get('toolName') || ''
    });
    sendJson(ctx, 200, { ok: true, ...cleared, retention: TRANSMISSION_RETENTION });
  });

  router.post('/api/mcp/bridge/heartbeat', authenticate, requireMcpEntitlement, async ctx => {
    const body = await readJsonBody(ctx);
    const desktop = heartbeatDesktop({ ...body, userId: ctx.auth.sub });
    sendJson(ctx, 200, { ok: true, desktop });
  });
  router.post('/api/mcp/bridge/wait', authenticate, requireMcpEntitlement, async ctx => {
    const body = await readJsonBody(ctx);
    const controller = new AbortController();
    const close = () => controller.abort();
    ctx.res.once('close', close);
    try {
      const version = await waitForSignal(`desktop:${ctx.auth.sub}`, String(body.after || ''), 25_000, controller.signal);
      if (!controller.signal.aborted) sendJson(ctx, 200, { ok: true, version });
    } finally { ctx.res.removeListener('close', close); }
  });
  router.get('/api/mcp/bridge/jobs', authenticate, requireMcpEntitlement, async ctx => {
    const jobs = await claimDesktopJobs({
      userId: ctx.auth.sub,
      tenantId: ctx.url.searchParams.get('tenantId') || '',
      environmentId: ctx.url.searchParams.get('environmentId') || '',
      clientInstanceId: ctx.url.searchParams.get('clientInstanceId') || '',
      limit: ctx.url.searchParams.get('limit') || 1
    });
    sendJson(ctx, 200, { ok: true, jobs });
  });
  router.post('/api/mcp/bridge/jobs', authenticate, requireMcpEntitlement, async ctx => {
    const body = await readJsonBody(ctx);
    const jobs = await claimDesktopJobs({ tenantId: String(body.tenantId || ''), environmentId: String(body.environmentId || ''), clientInstanceId: String(body.clientInstanceId || ''), claimId: String(body.claimId || ''), userId: ctx.auth.sub, limit: 1 });
    sendJson(ctx, 200, { ok: true, jobs });
  });
  router.post('/api/mcp/bridge/jobs/:jobId/complete', authenticate, requireMcpEntitlement, async ctx => {
    const body = await readJsonBody(ctx, config.mcp.maxPayloadBytes);
    const job = await completeDesktopJob({ ...body, userId: ctx.auth.sub, jobId: ctx.params.jobId });
    sendJson(ctx, 200, { ok: true, job });
  });

  router.post('/gateway/mcp/:userId/:tenantId', ctx => handleMcpRequest(ctx, { resourceKind: 'gateway' }));
  router.get('/gateway/mcp/:userId/:tenantId', ctx => handleMcpRequest(ctx, { resourceKind: 'gateway' }));
  router.delete('/gateway/mcp/:userId/:tenantId', ctx => handleMcpRequest(ctx, { resourceKind: 'gateway' }));
  router.post('/gateway/mcp/:userId/:tenantId/:domain', ctx => handleMcpRequest(ctx, { resourceKind: 'gateway' }));
  router.get('/gateway/mcp/:userId/:tenantId/:domain', ctx => handleMcpRequest(ctx, { resourceKind: 'gateway' }));
  router.delete('/gateway/mcp/:userId/:tenantId/:domain', ctx => handleMcpRequest(ctx, { resourceKind: 'gateway' }));

  router.post('/mcp/:userId/:tenantId', ctx => handleMcpRequest(ctx));
  router.get('/mcp/:userId/:tenantId', ctx => handleMcpRequest(ctx));
  router.delete('/mcp/:userId/:tenantId', ctx => handleMcpRequest(ctx));
  router.post('/mcp/:userId/:tenantId/:toolName', ctx => handleMcpRequest(ctx, { scopedToolName: ctx.params.toolName }));
  router.get('/mcp/:userId/:tenantId/:toolName', ctx => handleMcpRequest(ctx, { scopedToolName: ctx.params.toolName }));
  router.post('/devops/mcp/:userId', ctx => handleMcpRequest(ctx, { resourceKind: 'devops' }));
  router.get('/devops/mcp/:userId', ctx => handleMcpRequest(ctx, { resourceKind: 'devops' }));
  router.delete('/devops/mcp/:userId', ctx => handleMcpRequest(ctx, { resourceKind: 'devops' }));
  router.post('/sharepoint/mcp/:userId', ctx => handleMcpRequest(ctx, { resourceKind: 'sharepoint' }));
  router.get('/sharepoint/mcp/:userId', ctx => handleMcpRequest(ctx, { resourceKind: 'sharepoint' }));
  router.delete('/sharepoint/mcp/:userId', ctx => handleMcpRequest(ctx, { resourceKind: 'sharepoint' }));
  router.post('/powerpages/mcp/:userId/:tenantId', ctx => handleMcpRequest(ctx, { resourceKind: 'powerpages' }));
  router.get('/powerpages/mcp/:userId/:tenantId', ctx => handleMcpRequest(ctx, { resourceKind: 'powerpages' }));
  router.delete('/powerpages/mcp/:userId/:tenantId', ctx => handleMcpRequest(ctx, { resourceKind: 'powerpages' }));
}
