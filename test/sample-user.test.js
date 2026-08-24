import test from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLE_USER } from '../src/modules/users/sample-user.js';
import { hashPassword, verifyPassword } from '../src/lib/crypto.js';

test('documented sample credentials use the normal scrypt verifier', async () => {
  assert.equal(SAMPLE_USER.email, '123@gmail.com');
  assert.equal(SAMPLE_USER.password, '123123');
  assert.equal(SAMPLE_USER.planId, 'pro');
  const hash = await hashPassword(SAMPLE_USER.password);
  assert.equal(await verifyPassword(SAMPLE_USER.password, hash), true);
  assert.equal(await verifyPassword('wrong-password', hash), false);
});
