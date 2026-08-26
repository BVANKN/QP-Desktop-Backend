// End-to-end coverage of the signup -> verify -> login -> refresh lifecycle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useTemporaryDataDir, startTestServer, readLatestCode, VALID_PASSWORD } from './helpers/test-server.js';

const dataDir = useTemporaryDataDir();
const server = await startTestServer();

test.after(() => server.close());

async function registerUser({ name = 'Bharath Anirudh', username, email, planId } = {}) {
  const start = await server.call('POST', '/api/auth/signup/start', {
    name,
    username,
    email,
    password: VALID_PASSWORD,
    confirmPassword: VALID_PASSWORD,
    planId
  });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const code = readLatestCode(dataDir);
  const verified = await server.call('POST', '/api/auth/signup/verify', { pendingId: start.body.pendingId, code });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  return { start: start.body, session: verified.body, code };
}

test('health and plan catalog are public', async () => {
  const health = await server.call('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);

  const plans = await server.call('GET', '/api/plans');
  assert.equal(plans.status, 200);
  assert.deepEqual(plans.body.plans.map(plan => plan.id), ['free', 'pro']);
  // Free plan must never carry reports or developer app entitlements.
  const free = plans.body.plans.find(plan => plan.id === 'free');
  assert.ok(!free.features.includes('reports.insights'));
  assert.ok(!free.features.includes('developer.apps'));
});

test('signup requires verification before the account exists', async () => {
  const start = await server.call('POST', '/api/auth/signup/start', {
    name: 'Unverified Person',
    username: 'unverified',
    email: 'unverified@example.com',
    password: VALID_PASSWORD,
    confirmPassword: VALID_PASSWORD
  });
  assert.equal(start.status, 200);
  assert.ok(start.body.pendingId);
  // No user row yet, so login must fail.
  const login = await server.call('POST', '/api/auth/login', { identifier: 'unverified', password: VALID_PASSWORD });
  assert.equal(login.status, 401);
  assert.equal(login.body.code, 'INVALID_CREDENTIALS');
});

test('completed signup issues tokens and defaults to the free plan', async () => {
  const { session } = await registerUser({ username: 'freeuser', email: 'free@example.com' });
  assert.equal(session.plan.id, 'free');
  assert.ok(session.accessToken);
  assert.ok(session.refreshToken);
  assert.deepEqual(session.entitlements.sort(), ['dataverse.columns', 'dataverse.flows', 'dataverse.tables']);
  // Password material must never leave the server.
  assert.equal(JSON.stringify(session).includes(VALID_PASSWORD), false);
  assert.equal(session.user.passwordHash, undefined);
});

test('wrong verification code is rejected and consumes an attempt', async () => {
  const start = await server.call('POST', '/api/auth/signup/start', {
    name: 'Code Tester',
    username: 'codetester',
    email: 'codetester@example.com',
    password: VALID_PASSWORD,
    confirmPassword: VALID_PASSWORD
  });
  const wrong = await server.call('POST', '/api/auth/signup/verify', { pendingId: start.body.pendingId, code: '000000' });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /not correct/);
  // The correct code still works afterwards.
  const right = await server.call('POST', '/api/auth/signup/verify', { pendingId: start.body.pendingId, code: readLatestCode(dataDir) });
  assert.equal(right.status, 200);
});

test('login accepts either username or email', async () => {
  await registerUser({ username: 'dualid', email: 'dualid@example.com' });

  const byUsername = await server.call('POST', '/api/auth/login', { identifier: 'dualid', password: VALID_PASSWORD });
  assert.equal(byUsername.status, 200);

  const byEmail = await server.call('POST', '/api/auth/login', { identifier: 'dualid@example.com', password: VALID_PASSWORD });
  assert.equal(byEmail.status, 200);

  // Case-insensitive identifiers.
  const mixedCase = await server.call('POST', '/api/auth/login', { identifier: 'DualID@Example.com', password: VALID_PASSWORD });
  assert.equal(mixedCase.status, 200);
});

test('login failures are indistinguishable for unknown vs wrong password', async () => {
  await registerUser({ username: 'enumtest', email: 'enumtest@example.com' });
  const wrongPassword = await server.call('POST', '/api/auth/login', { identifier: 'enumtest', password: 'Wrong-Password-123!' });
  const unknownUser = await server.call('POST', '/api/auth/login', { identifier: 'nosuchuser', password: 'Wrong-Password-123!' });
  assert.equal(wrongPassword.status, unknownUser.status);
  assert.equal(wrongPassword.body.error, unknownUser.body.error);
  assert.equal(wrongPassword.body.code, unknownUser.body.code);
});

test('duplicate email and username are refused at signup start', async () => {
  await registerUser({ username: 'takenuser', email: 'taken@example.com' });

  const dupeEmail = await server.call('POST', '/api/auth/signup/start', {
    name: 'Other Person', username: 'otherperson', email: 'taken@example.com',
    password: VALID_PASSWORD, confirmPassword: VALID_PASSWORD
  });
  assert.equal(dupeEmail.status, 409);
  assert.equal(dupeEmail.body.code, 'EMAIL_IN_USE');

  const dupeUsername = await server.call('POST', '/api/auth/signup/start', {
    name: 'Other Person', username: 'takenuser', email: 'other@example.com',
    password: VALID_PASSWORD, confirmPassword: VALID_PASSWORD
  });
  assert.equal(dupeUsername.status, 409);
  assert.equal(dupeUsername.body.code, 'USERNAME_TAKEN');
});

test('/me returns the caller identity and entitlements', async () => {
  const { session } = await registerUser({ username: 'meuser', email: 'me@example.com' });
  const me = await server.call('GET', '/api/auth/me', undefined, { accessToken: session.accessToken });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.username, 'meuser');
  assert.equal(me.body.plan.id, 'free');
});

test('refresh rotation tolerates an immediate same-client retry but still revokes cross-client replay', async () => {
  const { session } = await registerUser({ username: 'refreshuser', email: 'refresh@example.com' });

  const first = await server.call('POST', '/api/auth/refresh', { refreshToken: session.refreshToken });
  assert.equal(first.status, 200);
  assert.notEqual(first.body.refreshToken, session.refreshToken);

  // Real clients can issue two refreshes concurrently or retry after losing the
  // first response. The same immediately-previous token from the same client
  // must return the already-issued rotation instead of revoking the session.
  const retry = await server.call('POST', '/api/auth/refresh', { refreshToken: session.refreshToken });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.refreshToken, first.body.refreshToken);

  // The same old token from a different client fingerprint is still replay and
  // revokes the complete session family.
  const replay = await server.call('POST', '/api/auth/refresh', { refreshToken: session.refreshToken }, {
    headers: { 'User-Agent': 'different-refresh-client' }
  });
  assert.equal(replay.status, 401);
  assert.equal(replay.body.code, 'SESSION_REVOKED');

  const afterRevoke = await server.call('POST', '/api/auth/refresh', { refreshToken: first.body.refreshToken });
  assert.equal(afterRevoke.status, 401);
});

test('logout revokes the session so its access token stops working', async () => {
  const { session } = await registerUser({ username: 'logoutuser', email: 'logout@example.com' });
  const before = await server.call('GET', '/api/auth/me', undefined, { accessToken: session.accessToken });
  assert.equal(before.status, 200);

  await server.call('POST', '/api/auth/logout', { refreshToken: session.refreshToken });

  const after = await server.call('GET', '/api/auth/me', undefined, { accessToken: session.accessToken });
  assert.equal(after.status, 401);
  assert.equal(after.body.code, 'SESSION_REVOKED');
});

test('changing password revokes every existing session', async () => {
  const { session } = await registerUser({ username: 'pwuser', email: 'pw@example.com' });
  const newPassword = 'An0ther-Str0ng-Secret!';
  const changed = await server.call('POST', '/api/auth/password', {
    currentPassword: VALID_PASSWORD,
    newPassword,
    confirmPassword: newPassword
  }, { accessToken: session.accessToken });
  assert.equal(changed.status, 200);

  const stale = await server.call('GET', '/api/auth/me', undefined, { accessToken: session.accessToken });
  assert.equal(stale.status, 401);

  const oldPasswordLogin = await server.call('POST', '/api/auth/login', { identifier: 'pwuser', password: VALID_PASSWORD });
  assert.equal(oldPasswordLogin.status, 401);

  const newPasswordLogin = await server.call('POST', '/api/auth/login', { identifier: 'pwuser', password: newPassword });
  assert.equal(newPasswordLogin.status, 200);
});
