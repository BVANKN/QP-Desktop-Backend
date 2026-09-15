// Only explicit diagnostic fields leave this module. Never expose grant records,
// token hashes, replay envelopes, resource URLs, client names or request headers.
export function recordRefreshHealth(grant, result, now = Math.floor(Date.now() / 1000)) {
  const previous = grant.refreshHealth || {};
  const success = result === 'refreshed' || result === 'retry_replayed';
  grant.refreshHealth = {
    observedSince: previous.observedSince || now,
    lastAttemptAt: now,
    lastResult: result,
    lastSuccessAt: success ? now : previous.lastSuccessAt || null,
    lastFailureAt: success ? previous.lastFailureAt || null : now,
    lastFailure: success ? previous.lastFailure || null : result
  };
}

const results = new Set(['refreshed', 'retry_replayed', 'retry_client_unverified', 'refresh_token_reuse', 'refresh_expired', 'resource_mismatch']);
const iso = value => Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : null;

export function grantHealth(grant, now = Math.floor(Date.now() / 1000)) {
  const history = grant.refreshHealth || {};
  const renewable = Boolean(grant.refreshTokenHash) && grant.refreshExpiresAt > now;
  const state = grant.revokedAt ? 'revoked'
    : !grant.refreshTokenHash ? 'no_refresh_token'
    : !renewable ? 'refresh_expired'
    : grant.accessExpiresAt > now ? 'access_valid' : 'access_expired_refresh_available';
  return {
    state,
    createdAt: iso(grant.createdAt),
    accessExpiresAt: iso(grant.accessExpiresAt),
    refreshExpiresAt: iso(grant.refreshExpiresAt),
    hasRefreshToken: Boolean(grant.refreshTokenHash),
    revokedAt: iso(grant.revokedAt),
    revokedReason: ['refresh_token_reuse', 'client_revocation'].includes(grant.revokedReason) ? grant.revokedReason : grant.revokedAt ? 'revoked' : null,
    observedSince: iso(history.observedSince),
    lastAttemptAt: iso(history.lastAttemptAt),
    lastResult: results.has(history.lastResult) ? history.lastResult : null,
    lastSuccessAt: iso(history.lastSuccessAt),
    lastFailureAt: iso(history.lastFailureAt),
    lastFailure: results.has(history.lastFailure) ? history.lastFailure : null
  };
}

export function buildConnectionHealth({ userId, connections, grants, desktopStatus, ideStatus, now = Math.floor(Date.now() / 1000) }) {
  // Defend again here even though repositories already filter by owner.
  const owned = grants.filter(grant => grant.userId === userId);
  const rows = connections.filter(connection => connection.userId === userId).map(connection => {
    const desktop = connection.kind === 'ide'
      ? { connected: ideStatus ? Number(ideStatus.agents) > 0 : null }
      : desktopStatus(userId, connection.tenantId, connection.environmentId);
    return {
      name: connection.name, kind: connection.kind || 'power-platform', enabled: connection.enabled,
      desktop: { connected: desktop.connected ?? null, lastSeenAt: desktop.lastSeenAt || null,
        environmentMatches: desktop.environmentMatches ?? null, appVersion: desktop.appVersion || null },
      grants: owned.filter(grant => grant.connectionId === connection.id)
    };
  });
  // IDE uses its own websocket hub, not the Dataverse heartbeat broker.
  if (!rows.some(row => row.kind === 'ide')) rows.push({ name: 'Quicker Portal IDE', kind: 'ide', enabled: true,
    desktop: { connected: ideStatus ? Number(ideStatus.agents) > 0 : null, lastSeenAt: null, environmentMatches: null, appVersion: null },
    grants: owned.filter(grant => grant.tenantId === 'ide') });
  return rows.map(({ grants: sessions, ...row }) => ({ ...row,
    sessionCount: sessions.length,
    sessionsTruncated: sessions.length > 20,
    sessions: sessions.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 20).map(grant => grantHealth(grant, now))
  }));
}
