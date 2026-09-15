import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConnectionHealth, grantHealth, recordRefreshHealth } from '../src/modules/mcp/connection-health.js';

const grant = () => ({ userId: 'owner', connectionId: 'connection', tenantId: 'tenant', createdAt: 100, accessExpiresAt: 1000, refreshExpiresAt: 2000, refreshTokenHash: 'SECRET', accessTokenHash: 'SECRET', resource: 'https://private/SECRET' });
test('old grants have unknown refresh history and access expiry is distinct from lost renewal', () => {
  assert.equal(grantHealth(grant(), 500).state, 'access_valid');
  assert.equal(grantHealth(grant(), 1500).state, 'access_expired_refresh_available');
  assert.equal(grantHealth(grant(), 2500).state, 'refresh_expired');
  assert.equal(grantHealth({ ...grant(), refreshTokenHash: null }, 500).state, 'no_refresh_token');
  assert.equal(grantHealth(grant(), 500).lastSuccessAt, null);
  assert.equal(grantHealth(grant(), 500).observedSince, null);
});
test('durable latest-attempt telemetry preserves last failure after a successful renewal', () => {
  const value = grant(); recordRefreshHealth(value, 'refreshed', 600);
  recordRefreshHealth(value, 'retry_client_unverified', 601);
  assert.equal(grantHealth(value, 602).lastResult, 'retry_client_unverified');
  recordRefreshHealth(value, 'retry_replayed', 603);
  const health = grantHealth(value, 604);
  assert.equal(health.lastSuccessAt, new Date(603000).toISOString());
  assert.equal(health.lastFailure, 'retry_client_unverified');
  assert.equal(health.observedSince, new Date(600000).toISOString());
  assert.doesNotMatch(JSON.stringify(health), /SECRET|Hash|resource/);
});
test('connection health isolates owners and connections, uses IDE hub, and strips heartbeat identities', () => {
  const connections = [{ id: 'connection', userId: 'owner', name: 'Mine', tenantId: 'tenant', environmentId: 'env', enabled: true }, { id: 'ide', userId: 'owner', name: 'IDE', kind: 'ide' }, { id: 'foreign', userId: 'other', name: 'FOREIGN' }];
  const rows = buildConnectionHealth({ userId: 'owner', connections, grants: [grant(), { ...grant(), userId: 'other' }, { ...grant(), connectionId: 'ide', tenantId: 'ide' }],
    desktopStatus: () => ({ connected: false, environmentMatches: false, userId: 'SECRET', clientInstanceId: 'SECRET', appVersion: '0.9.1' }), ideStatus: { agents: 1, workspaces: ['SECRET'] }, now: 500 });
  assert.equal(rows.length, 2); assert.equal(rows[0].sessions.length, 1);
  assert.equal(rows[0].desktop.environmentMatches, false);
  assert.equal(rows[1].desktop.connected, true);
  assert.doesNotMatch(JSON.stringify(rows), /SECRET|FOREIGN|userId|clientInstanceId/);
});
test('unknown IDE bridge state is not reported as offline; session truncation is explicit', () => {
  const rows = buildConnectionHealth({ userId: 'owner', connections: [], grants: Array.from({ length: 25 }, () => ({ ...grant(), tenantId: 'ide' })), desktopStatus: () => ({}), now: 500 });
  assert.equal(rows[0].desktop.connected, null);
  assert.equal(rows[0].sessionCount, 25); assert.equal(rows[0].sessions.length, 20); assert.equal(rows[0].sessionsTruncated, true);
});
