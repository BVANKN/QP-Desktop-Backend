import { hashPassword } from '../../lib/crypto.js';
import { createUser, findUserByIdentifier } from './user-repo.js';

export const SAMPLE_USER = Object.freeze({
  name: 'Sample User',
  username: 'sample123',
  email: '123@gmail.com',
  password: '123123',
  planId: 'pro'
});

/**
 * Idempotently provisions the documented sample account into an empty or
 * existing JSON store. Set QP_SEED_SAMPLE_USER=false to disable it on a
 * public deployment after onboarding.
 */
export async function ensureSampleUser() {
  if (String(process.env.QP_SEED_SAMPLE_USER || 'true').toLowerCase() === 'false') return { created: false, disabled: true };
  const existing = await findUserByIdentifier(SAMPLE_USER.email);
  if (existing) return { created: false, user: existing };
  const passwordHash = await hashPassword(SAMPLE_USER.password);
  const result = await createUser({ ...SAMPLE_USER, passwordHash });
  return { created: Boolean(result?.ok), user: result?.user || null, conflict: result?.conflict || '' };
}
