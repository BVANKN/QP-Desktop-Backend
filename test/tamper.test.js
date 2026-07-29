// Adversarial tests: the client must not be able to grant itself entitlements
// by forging, editing, or downgrading tokens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { useTemporaryDataDir, startTestServer, readLatestCode, VALID_PASSWORD } from './helpers/test-server.js';

const dataDir = useTemporaryDataDir();
const server = await startTestServer();

test.after(() => server.close());

async function freeUser(username) {
  const start = await server.call('POST', '/api/auth/signup/start', {
    name: 'Tamper Tester', username, email: `${username}@example.com`,
    password: VALID_PASSWORD, confirmPassword: VALID_PASSWORD
  });
  const verified = await server.call('POST', '/api/auth/signup/verify', {
    pendingId: start.body.pendingId,
    code: readLatestCode(dataDir)
  });
  return verified.body;
}

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

function encodeSegment(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

test('editing the plan claim invalidates the signature', async () => {
  const session = await freeUser('tamperplan');
  const [header, payload, signature] = session.accessToken.split('.');
  const claims = decodeSegment(payload);
  assert.equal(claims.plan, 'free');

  claims.plan = 'pro';
  claims.entitlements = ['reports.insights', 'developer.apps', 'dataverse.advanced'];
  const forged = `${header}.${encodeSegment(claims)}.${signature}`;

  const attempt = await server.call('GET', '/api/auth/me', undefined, { accessToken: forged });
  assert.equal(attempt.status, 401);
  assert.equal(attempt.body.code, 'TOKEN_INVALID');
});

test('alg:none tokens are refused', async () => {
  const session = await freeUser('tampernone');
  const claims = decodeSegment(session.accessToken.split('.')[1]);
  claims.plan = 'pro';
  const noneToken = `${encodeSegment({ alg: 'none', typ: 'JWT' })}.${encodeSegment(claims)}.`;

  const attempt = await server.call('GET', '/api/auth/me', undefined, { accessToken: noneToken });
  assert.equal(attempt.status, 401);
});

test('tokens signed with an attacker key are refused', async () => {
  const session = await freeUser('tamperkey');
  const [headerSegment, payloadSegment] = session.accessToken.split('.');
  const header = decodeSegment(headerSegment);
  const claims = decodeSegment(payloadSegment);
  claims.plan = 'pro';
  claims.entitlements = ['reports.insights'];

  const attackerKey = randomBytes(32);
  const signingInput = `${encodeSegment(header)}.${encodeSegment(claims)}`;
  const signature = createHmac('sha256', attackerKey).update(signingInput).digest('base64url');

  const attempt = await server.call('GET', '/api/auth/me', undefined, { accessToken: `${signingInput}.${signature}` });
  assert.equal(attempt.status, 401);
});

test('expired tokens are refused', async () => {
  const session = await freeUser('tamperexpiry');
  const [headerSegment, payloadSegment] = session.accessToken.split('.');
  const claims = decodeSegment(payloadSegment);
  claims.exp = Math.floor(Date.now() / 1000) - 10;
  const stale = `${headerSegment}.${encodeSegment(claims)}.${session.accessToken.split('.')[2]}`;

  const attempt = await server.call('GET', '/api/auth/me', undefined, { accessToken: stale });
  assert.equal(attempt.status, 401);
});

test('server-side entitlements are authoritative even if the client lies', async () => {
  const session = await freeUser('tampertruth');
  // /me recomputes plan from the subscription store, not from token claims.
  const me = await server.call('GET', '/api/auth/me', undefined, { accessToken: session.accessToken });
  assert.equal(me.body.plan.id, 'free');
  assert.ok(!me.body.entitlements.includes('reports.insights'));
});

test('upgrading the plan grants entitlements only through the server', async () => {
  const session = await freeUser('tamperupgrade');
  const upgraded = await server.call('POST', '/api/account/plan', { planId: 'pro' }, { accessToken: session.accessToken });
  assert.equal(upgraded.status, 200);
  assert.equal(upgraded.body.plan.id, 'pro');
  assert.ok(upgraded.body.entitlements.includes('reports.insights'));
  assert.ok(upgraded.body.entitlements.includes('developer.apps'));

  // The freshly minted token carries the new claims and verifies cleanly.
  const me = await server.call('GET', '/api/auth/me', undefined, { accessToken: upgraded.body.accessToken });
  assert.equal(me.body.plan.id, 'pro');
});

test('unknown plan identifiers are rejected', async () => {
  const session = await freeUser('tamperplanid');
  const attempt = await server.call('POST', '/api/account/plan', { planId: 'enterprise-unlimited' }, { accessToken: session.accessToken });
  assert.equal(attempt.status, 400);
  const stillFree = await server.call('GET', '/api/auth/me', undefined, { accessToken: session.accessToken });
  assert.equal(stillFree.body.plan.id, 'free');
});

test('protected endpoints refuse missing or malformed authorization', async () => {
  for (const token of [undefined, 'not-a-token', 'a.b.c', '', 'Bearer']) {
    const response = await server.call('GET', '/api/auth/me', undefined, { accessToken: token });
    assert.equal(response.status, 401, `token ${JSON.stringify(token)} should be rejected`);
  }
});

test('oversized and malformed bodies are rejected safely', async () => {
  const huge = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'x'.repeat(200_000), password: VALID_PASSWORD })
  });
  assert.equal(huge.status, 413);

  const malformed = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json'
  });
  assert.equal(malformed.status, 400);

  const wrongType = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'identifier=admin'
  });
  assert.equal(wrongType.status, 400);
});

test('passwords are accepted on length alone, with no complexity rules', async () => {
  // Product decision: 6 characters is the only requirement. Simple, common,
  // and identity-derived passwords are all allowed.
  const accepted = ['abc123', 'password', 'simpleuser'];
  for (const [index, password] of accepted.entries()) {
    const response = await server.call('POST', '/api/auth/signup/start', {
      name: 'Simple Password',
      username: `simpleuser${index}`,
      email: `simple${index}@example.com`,
      password,
      confirmPassword: password
    });
    assert.equal(response.status, 200, `"${password}" should be accepted (got ${JSON.stringify(response.body)})`);
  }

  // Below the minimum is still refused.
  const tooShort = await server.call('POST', '/api/auth/signup/start', {
    name: 'Short Password', username: 'shortpw', email: 'short@example.com',
    password: 'abc12', confirmPassword: 'abc12'
  });
  assert.equal(tooShort.status, 400);
  assert.match(tooShort.body.error, /at least 6 characters/);

  // The upper bound remains: unbounded input is a scrypt DoS vector.
  const tooLong = 'a'.repeat(129);
  const overLimit = await server.call('POST', '/api/auth/signup/start', {
    name: 'Long Password', username: 'longpw', email: 'long@example.com',
    password: tooLong, confirmPassword: tooLong
  });
  assert.equal(overLimit.status, 400);
});

test('mismatched password confirmation is rejected', async () => {
  const response = await server.call('POST', '/api/auth/signup/start', {
    name: 'Mismatch', username: 'mismatchuser', email: 'mismatch@example.com',
    password: VALID_PASSWORD, confirmPassword: `${VALID_PASSWORD}x`
  });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /do not match/);
});

test('unknown endpoints and methods return structured errors without leaking internals', async () => {
  const missing = await server.call('GET', '/api/does-not-exist');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'NOT_FOUND');

  const wrongMethod = await server.call('GET', '/api/auth/login');
  assert.equal(wrongMethod.status, 405);

  const serialized = JSON.stringify(missing.body);
  assert.ok(!serialized.includes('/Volumes'), 'error responses must not leak filesystem paths');
});
