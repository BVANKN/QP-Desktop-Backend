import express from 'express';
import { config } from '../../config/config.js';
import { verifyAccessToken } from '../../lib/tokens.js';
import { isSessionActive } from '../auth/session-store.js';
import { findUserById, publicUser } from '../users/user-repo.js';
import { entitlementsForUser } from '../plans/subscription-store.js';
import { authenticateMcpOAuthToken } from '../mcp/oauth.js';
import { ensureIdeMcpConnection, ideMcpConnectionEndpoint } from '../mcp/connections.js';
import { ContentCache } from '../ide-codewriter/workspace/content-cache.js';
import { WorkspaceRegistry } from '../ide-codewriter/workspace/registry.js';
import { AgentHub } from '../ide-codewriter/bridge/hub.js';
import { SessionRegistry } from '../ide-codewriter/mcp/session.js';
import { createMcpRouter } from '../ide-codewriter/mcp/http.js';

function publicBase(req) {
  if (config.mcp.publicBaseUrl) return config.mcp.publicBaseUrl.replace(/\/+$/, '');
  const protocol = process.env.QP_BACKEND_TRUST_PROXY === '1'
    ? String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim()
    : 'http';
  return `${protocol}://${req.headers.host}`;
}

function requestResource(req) {
  const resource = new URL(req.originalUrl, publicBase(req));
  resource.searchParams.sort();
  return resource.toString();
}

async function premiumIdentityFromProductToken(token) {
  const verdict = verifyAccessToken(token);
  if (!verdict.valid) return null;
  const claims = verdict.payload;
  if (!(await isSessionActive(claims.sid, claims.sub))) return null;
  const entitlements = await entitlementsForUser(claims.sub);
  if (!entitlements.features.includes('mcp.server')) return null;
  const user = await findUserById(claims.sub);
  if (!user || user.status !== 'active') return null;
  return { user: publicUser(user), tokenId: claims.sid };
}

function bearerToken(req) {
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || '').trim());
  return match?.[1] || '';
}

/**
 * The proven CodeWriter workspace engine hosted inside the QP account service.
 * QP remains the only OAuth issuer and identity database; this subsystem owns
 * only live workspace indexes, MCP transport sessions, and WebSocket agents.
 */
export function createIdeMcpSubsystem() {
  const contentCache = new ContentCache();
  const registry = new WorkspaceRegistry({ contentCache });
  const sessions = new SessionRegistry();
  const base = String(config.mcp.publicBaseUrl || `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`).replace(/\/+$/, '');
  const mcpUrlForUser = userId => ideMcpConnectionEndpoint(base, userId);

  const users = {
    async verifyAppToken(token) {
      return premiumIdentityFromProductToken(token);
    }
  };
  const hub = new AgentHub({ users, registry, bridgePath: '/ide/bridge', mcpUrlForUser });
  const context = {
    registry,
    hub,
    contentCache,
    sessions,
    activeRuns: new Map(),
    mcpUrl: `${base}/ide/mcp`,
    resourceMetadataUrlFor: req => `${publicBase(req)}/.well-known/oauth-protected-resource/ide/mcp/${encodeURIComponent(req.params.userId || '')}`
  };

  const authenticate = async req => {
    const connection = await authenticateMcpOAuthToken({
      authorization: req.headers.authorization,
      resource: requestResource(req)
    });
    if (connection.kind !== 'ide' || connection.tenantId !== 'ide' || connection.userId !== req.params.userId) {
      throw Object.assign(new Error('This OAuth token does not belong to this IDE workspace resource.'), { status: 403 });
    }
    const entitlements = await entitlementsForUser(connection.userId);
    if (!entitlements.features.includes('mcp.server')) {
      throw Object.assign(new Error('Quicker Portal IDE MCP requires an active Premium account.'), { status: 403 });
    }
    const user = await findUserById(connection.userId);
    if (!user) throw Object.assign(new Error('The Quicker Portal account no longer exists.'), { status: 401 });
    const scopes = [...(connection.scopes || [])];
    if (scopes.includes('mcp:read')) scopes.push('workspace:read');
    if (scopes.includes('mcp:write')) scopes.push('workspace:write');
    return {
      token: bearerToken(req),
      clientId: connection.oauthClientId || 'qp-oauth-client',
      scopes: [...new Set(scopes)],
      extra: {
        userId: user.id,
        userEmail: user.email,
        clientName: connection.oauthClientId || 'MCP client',
        connectionId: connection.id
      }
    };
  };

  const mcpRouter = createMcpRouter(context, { authenticate });
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const origin = String(req.headers.origin || '');
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, WWW-Authenticate');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });
  app.use('/ide/mcp/:userId', mcpRouter);
  app.use((_req, res) => res.status(404).json({ error: 'Unknown Quicker Portal IDE endpoint.' }));
  app.use((error, _req, res, _next) => {
    if (!res.headersSent) res.status(error?.status || 500).json({ error: error?.message || 'IDE MCP request failed.' });
  });

  return {
    handles(pathname) {
      return pathname === '/ide/mcp' || pathname.startsWith('/ide/mcp/');
    },
    handle(req, res) {
      app(req, res);
    },
    attach(server) {
      hub.attach(server);
    },
    async bootstrap(userId, endpointBase) {
      const connection = await ensureIdeMcpConnection(userId);
      return {
        userId,
        connection,
        mcpUrl: ideMcpConnectionEndpoint(endpointBase, userId),
        bridgeUrl: `${String(endpointBase).replace(/\/+$/, '')}/ide/bridge`,
        scopes: ['mcp:read', 'mcp:write', 'offline_access']
      };
    },
    status(userId) {
      const userSessions = sessions.listForUser(userId);
      return {
        agents: hub.agentsForUser(userId).length,
        workspaces: registry.listForUser(userId).map(workspace => workspace.toJSON()),
        sessions: userSessions.map(session => session.toJSON()),
        transportSessions: userSessions.length,
        uptimeSeconds: Math.floor(process.uptime())
      };
    },
    async close() {
      await mcpRouter.close();
      await hub.close();
      sessions.stop();
    }
  };
}
