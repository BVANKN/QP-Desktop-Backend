import test from 'node:test';
import assert from 'node:assert/strict';
import { useTemporaryDataDir, startTestServer, readLatestCode, VALID_PASSWORD } from './helpers/test-server.js';

process.env.NODE_ENV = 'production';
process.env.QP_VERIFICATION_STATIC_CODE = '';
const dataDir = useTemporaryDataDir();
const { config } = await import('../src/config/config.js');
const { assertProductionReadiness } = await import('../src/config/production-readiness.js');

test('production defaults never use a fixed verification code or a six-character password', () => {
  assert.equal(config.verification.staticCode, '');
  assert.equal(config.password.minLength, 15);
});

test('production startup rejects incomplete security configuration', () => {
  const safe = {
    env: 'production',
    storage: { persistent: true },
    verification: { staticCode: '' },
    mcp: { publicBaseUrl: 'https://qpbackend.onrender.com' },
    mail: { transport: 'smtp', from: 'Quicker Portal <noreply@example.com>', smtp: { host: 'smtp.example.com' } }
  };
  assert.doesNotThrow(() => assertProductionReadiness(safe));
  assert.throws(() => assertProductionReadiness({ ...safe, env: 'development', storage: { managedHost: true } }), /NODE_ENV=production/);
  assert.throws(() => assertProductionReadiness({ ...safe, storage: { persistent: false } }), /durable account storage/);
  assert.throws(() => assertProductionReadiness({ ...safe, storage: { persistent: true, managedHost: true, mode: 'filesystem' } }), /QP_BACKEND_PERSISTENT_VOLUME/);
  assert.throws(() => assertProductionReadiness({ ...safe, verification: { staticCode: '123456' } }), /empty QP_VERIFICATION_STATIC_CODE/);
  assert.throws(() => assertProductionReadiness({ ...safe, mcp: { publicBaseUrl: 'http://example.com' } }), /HTTPS/);
  assert.throws(() => assertProductionReadiness({ ...safe, mail: { ...safe.mail, transport: 'outbox' } }), /SMTP/);
});

test('production denies paid signup and self-service plan escalation', async () => {
  const server = await startTestServer();
  try {
    const paid = await server.call('POST', '/api/auth/signup/start', {
      name: 'Paid Attempt', username: 'paidattempt', email: 'paid@example.com', password: VALID_PASSWORD, planId: 'pro'
    });
    assert.equal(paid.status, 403);
    assert.equal(paid.body.code, 'PLAN_PAYMENT_REQUIRED');

    const started = await server.call('POST', '/api/auth/signup/start', {
      name: 'Free User', username: 'freeproduser', email: 'freeprod@example.com', password: VALID_PASSWORD
    });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const verified = await server.call('POST', '/api/auth/signup/verify', {
      pendingId: started.body.pendingId, code: readLatestCode(dataDir)
    });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    assert.equal(verified.body.plan.id, 'free');
    const upgrade = await server.call('POST', '/api/account/plan', { planId: 'pro' }, { accessToken: verified.body.accessToken });
    assert.equal(upgrade.status, 403);
    assert.equal(upgrade.body.code, 'PLAN_PAYMENT_REQUIRED');
  } finally {
    await server.close();
  }
});
