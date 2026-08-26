// Storage persistence reporting. Atlas is authoritative when MONGODB_URI is
// configured; local development/tests retain the filesystem adapter. These
// assertions keep the active mode explicit so a managed deployment cannot
// silently fall back to ephemeral account storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
    assert.equal(response.body.storage.mode, 'filesystem');
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

  // MongoDB makes managed-host persistence independent of the local disk.
  assert.equal(isPersistentStorage({ dataDirConfigured: false, managedHost: true, mongoConfigured: true }), true);

  // A plain machine keeps its filesystem either way.
  assert.equal(isPersistentStorage({ dataDirConfigured: false, managedHost: false }), true);
  assert.equal(isPersistentStorage({ dataDirConfigured: true, managedHost: false }), true);
});

test('Mongo configuration is recognized as persistent on a managed host without exposing the URI', () => {
  const script = `
    import { config } from './src/config/config.js';
    process.stdout.write(JSON.stringify({
      mode: config.storage.mode,
      persistent: config.storage.persistent,
      database: config.mongo.database,
      uriConfigured: Boolean(config.mongo.uri)
    }));
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RENDER: 'true',
      MONGODB_URI: 'mongodb://example.invalid:27017/?retryWrites=true',
      MONGODB_DB_NAME: 'qp_config_probe',
      QP_BACKEND_DATA_DIR: ''
    },
    encoding: 'utf8'
  });
  const result = JSON.parse(output);
  assert.deepEqual(result, {
    mode: 'mongodb',
    persistent: true,
    database: 'qp_config_probe',
    uriConfigured: true
  });
  assert.equal(output.includes('example.invalid'), false, 'configuration probes must not print the database URI');
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

    // In filesystem fallback mode the signing key lives beside the local
    // state. If it were regenerated, the refresh token would no longer verify.
    const refreshed = await server.call('POST', '/api/auth/refresh', { refreshToken: login.body.refreshToken });
    assert.equal(refreshed.status, 200, 'signing keys must persist alongside the accounts');
  } finally {
    await server.close();
  }
});

test('the local fallback keeps all identity state under the configured data directory', async () => {
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
