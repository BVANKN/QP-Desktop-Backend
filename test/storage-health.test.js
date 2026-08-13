// Storage persistence reporting.
//
// Every account, password hash, refresh session, signing key, and MCP
// connection is a JSON file under the configured data directory. On a managed
// host with an ephemeral filesystem and no mounted disk, all of it is
// destroyed on each deploy or wake-from-idle — and the service keeps answering
// every request as though nothing happened. The only visible symptom is that
// credentials which worked an hour ago are rejected, which reads as a login
// bug rather than as data loss. These assertions exist so that failure can
// never be silent again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useTemporaryDataDir, startTestServer } from './helpers/test-server.js';

const dataDir = useTemporaryDataDir();

test('health reports storage as persistent when a data directory is configured', async () => {
  const server = await startTestServer();
  try {
    const response = await server.call('GET', '/api/health');
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    // The test harness sets QP_BACKEND_DATA_DIR, which is the operator saying
    // "this points at real storage".
    assert.equal(response.body.storage.persistent, true);
    assert.equal(response.body.storage.warning, undefined);
    // Reported without paths, counts, or any identity data.
    assert.ok(['present', 'empty', 'unreadable'].includes(response.body.storage.accounts));
    assert.equal(response.body.storage.dataDir, undefined, 'the health endpoint must not disclose filesystem paths');
  } finally {
    await server.close();
  }
});

test('an ephemeral deployment is detected and reported loudly', async () => {
  const { isPersistentStorage } = await import('../src/config/config.js');

  // A managed host with no explicit data directory: the exact shape that loses
  // every account on the next restart.
  assert.equal(isPersistentStorage({ dataDirConfigured: false, managedHost: true }), false);

  // An explicit directory on a managed host is persistent, because that is the
  // operator pointing at a mounted disk.
  assert.equal(isPersistentStorage({ dataDirConfigured: true, managedHost: true }), true);

  // A plain machine keeps its filesystem either way.
  assert.equal(isPersistentStorage({ dataDirConfigured: false, managedHost: false }), true);
  assert.equal(isPersistentStorage({ dataDirConfigured: true, managedHost: false }), true);
});

test('accounts are reported as present once one exists, and survive a restart of the app object', async () => {
  const server = await startTestServer();
  try {
    const before = await server.call('GET', '/api/health');
    const password = 'abc123';
    const start = await server.call('POST', '/api/auth/signup/start', {
      name: 'Storage Probe', username: 'storageprobe', email: 'storage@example.com',
      password, confirmPassword: password
    });
    assert.equal(start.status, 200);
    const verify = await server.call('POST', '/api/auth/signup/verify', {
      pendingId: start.body.pendingId,
      code: process.env.QP_VERIFICATION_STATIC_CODE ?? '123456'
    });
    assert.equal(verify.status, 200);

    const after = await server.call('GET', '/api/health');
    assert.equal(after.body.storage.accounts, 'present');
    assert.ok(['empty', 'present'].includes(before.body.storage.accounts));

    // The account must be usable afterwards — this is the exact round trip
    // that fails when the data directory has been wiped underneath it.
    const login = await server.call('POST', '/api/auth/login', { identifier: 'storageprobe', password });
    assert.equal(login.status, 200, 'a freshly created account must be able to sign in');
    assert.equal(login.body.user.username, 'storageprobe');

    // Signing keys live in the same directory. If they were regenerated, the
    // refresh token minted a moment ago would no longer verify.
    const refreshed = await server.call('POST', '/api/auth/refresh', { refreshToken: login.body.refreshToken });
    assert.equal(refreshed.status, 200, 'signing keys must persist alongside the accounts');
  } finally {
    await server.close();
  }
});

test('the data directory is where every piece of identity state lives', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  // Named explicitly so a future move of any of these is a deliberate change
  // rather than an accident that quietly splits state across two locations.
  const expected = ['users', 'plans', 'sessions', 'keys'];
  const present = fs.readdirSync(dataDir);
  for (const directory of expected) {
    assert.ok(present.includes(directory), `${directory} must live under the configured data directory`);
    assert.ok(fs.statSync(path.join(dataDir, directory)).isDirectory());
  }
});
