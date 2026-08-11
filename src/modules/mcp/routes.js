import { authenticate } from '../../core/middleware/authenticate.js';
import { readJsonBody, sendJson } from '../../core/http/context.js';
import { config } from '../../config/config.js';
import { createMcpConnection, listMcpConnections, mcpResourceMetadata, revokeMcpConnection } from './connections.js';
import { claimDesktopJobs, completeDesktopJob, desktopStatus, heartbeatDesktop } from './broker.js';
import { queryTransmissionAnalytics } from './analytics.js';
import { MCP_TOOLS } from './tool-catalog.js';
import { handleMcpRequest } from './protocol.js';
import { entitlementsForUser } from '../plans/subscription-store.js';
import { ForbiddenError } from '../../core/errors.js';

async function requireMcpEntitlement(ctx) {
  const entitlements = await entitlementsForUser(ctx.auth.sub);
  if (!entitlements.features.includes('mcp.server')) {
    throw new ForbiddenError('Quicker Portal MCP is available on the Pro plan.', 'MCP_PLAN_REQUIRED');
  }
}

function endpointBase(ctx) {
  if (config.mcp.publicBaseUrl) return config.mcp.publicBaseUrl.replace(/\/+$/, '');
  const protocol = process.env.QP_BACKEND_TRUST_PROXY === '1'
    ? String(ctx.req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim()
    : ctx.url.protocol.replace(':', '');
  return `${protocol}://${ctx.req.headers.host}`;
}

export function registerMcpRoutes(router) {
  router.get('/.well-known/oauth-protected-resource', ctx => {
    sendJson(ctx, 200, mcpResourceMetadata(`${endpointBase(ctx)}/mcp`, endpointBase(ctx)));
  });

  router.get('/api/mcp/tools', authenticate, requireMcpEntitlement, ctx => {
    sendJson(ctx, 200, { ok: true, tools: MCP_TOOLS });
  });
  router.get('/api/mcp/connections', authenticate, requireMcpEntitlement, async ctx => {
    const connections = await listMcpConnections(ctx.auth.sub);
    sendJson(ctx, 200, { ok: true, connections: connections.map(connection => ({
      ...connection,
      endpoint: `${endpointBase(ctx)}/mcp/${encodeURIComponent(ctx.auth.sub)}/${encodeURIComponent(connection.tenantId)}`,
      desktop: desktopStatus(ctx.auth.sub, connection.tenantId, connection.environmentId)
    })) });
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
  router.get('/api/mcp/analytics', authenticate, requireMcpEntitlement, async ctx => {
    const analytics = await queryTransmissionAnalytics(ctx.auth.sub, {
      tenantId: ctx.url.searchParams.get('tenantId') || '',
      environmentId: ctx.url.searchParams.get('environmentId') || '',
      toolName: ctx.url.searchParams.get('toolName') || '',
      since: ctx.url.searchParams.get('since') || '',
      limit: ctx.url.searchParams.get('limit') || 200
    });
    sendJson(ctx, 200, { ok: true, analytics });
  });

  router.post('/api/mcp/bridge/heartbeat', authenticate, requireMcpEntitlement, async ctx => {
    const body = await readJsonBody(ctx);
    const desktop = heartbeatDesktop({ userId: ctx.auth.sub, ...body });
    sendJson(ctx, 200, { ok: true, desktop });
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
  router.post('/api/mcp/bridge/jobs/:jobId/complete', authenticate, requireMcpEntitlement, async ctx => {
    const body = await readJsonBody(ctx, config.mcp.maxPayloadBytes);
    const job = await completeDesktopJob({ userId: ctx.auth.sub, jobId: ctx.params.jobId, ...body });
    sendJson(ctx, 200, { ok: true, job });
  });

  router.post('/mcp/:userId/:tenantId', ctx => handleMcpRequest(ctx));
  router.get('/mcp/:userId/:tenantId', ctx => handleMcpRequest(ctx));
  router.delete('/mcp/:userId/:tenantId', ctx => handleMcpRequest(ctx));
  router.post('/mcp/:userId/:tenantId/:toolName', ctx => handleMcpRequest(ctx, { scopedToolName: ctx.params.toolName }));
  router.get('/mcp/:userId/:tenantId/:toolName', ctx => handleMcpRequest(ctx, { scopedToolName: ctx.params.toolName }));
}
