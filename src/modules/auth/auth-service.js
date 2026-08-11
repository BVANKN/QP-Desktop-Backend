// Authentication flows.
//
// Signup is two-phase: /signup/start stores a *pending registration* (no user
// row yet) with a hashed verification code; /signup/verify creates the real
// user only after the emailed code is proven. Login accepts username or
// email, applies per-account exponential lockout, and equalizes timing for
// unknown identifiers. All tokens are issued through the session store with
// rotation + reuse detection.
import { timingSafeEqual, createHmac } from 'node:crypto';
import { config } from '../../config/config.js';
import {
  AuthenticationError,
  ConflictError,
  RateLimitError,
  ValidationError
} from '../../core/errors.js';
import {
  hashPassword,
  verifyPassword,
  passwordNeedsRehash,
  randomId,
  randomNumericCode
} from '../../lib/crypto.js';
import { activeSigningKey } from '../../lib/key-store.js';
import { issueAccessToken } from '../../lib/tokens.js';
import { JsonStore } from '../../lib/json-store.js';
import {
  createUser,
  emailInUse,
  findUserByIdentifier,
  findUserById,
  publicUser,
  updateUser,
  usernameInUse
} from '../users/user-repo.js';
import {
  createSession,
  revokeAllSessionsForUser,
  revokeSessionByRefreshToken,
  rotateSession
} from './session-store.js';
import { ensureSubscription, entitlementsForUser } from '../plans/subscription-store.js';
import { DEFAULT_PLAN_ID, planById } from '../plans/plan-catalog.js';
import { sendMail, verificationEmail } from '../mail/mailer.js';
import { audit } from '../audit/audit.js';

const pendingStore = new JsonStore('users/pending-signups.json', { pending: {} });

// A fixed dummy hash so login timing is identical whether or not the
// identifier exists (prevents user enumeration through response timing).
let dummyHashPromise = null;
function dummyHash() {
  dummyHashPromise ||= hashPassword('dummy-timing-equalizer-password');
  return dummyHashPromise;
}


// STATIC CODE — temporary, development only.
//
// Gmail/SMTP delivery is switched off, so signup hands out a fixed code
// instead of emailing a random one. Everything around it is unchanged: the
// code is still HMAC'd into the pending record, still expires, and is still
// attempt-limited, so only the delivery step is short-circuited.
//
// To restore real email: set config.verification.staticCode to '' (or export
// QP_VERIFICATION_STATIC_CODE=''). The random code and the sendMail calls come
// back on their own — nothing here needs editing.
function issueVerificationCode() {
  const fixed = config.verification.staticCode;
  return fixed ? String(fixed) : randomNumericCode(config.verification.codeLength);
}

function verificationDeliveryDisabled() {
  return Boolean(config.verification.staticCode);
}

function codeDigest(pendingId, code) {
  // HMAC with the server signing key: the pending file alone is not enough
  // to recover or forge a 6-digit code offline.
  return createHmac('sha256', activeSigningKey().secret).update(`${pendingId}:${code}`).digest('hex');
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

async function issueTokensForUser(user, { ip, userAgent }) {
  const entitlements = await entitlementsForUser(user.id);
  const { session, refreshToken } = await createSession({ userId: user.id, ip, userAgent });
  const access = issueAccessToken({
    user,
    sessionId: session.id,
    planId: entitlements.planId,
    entitlements: entitlements.features
  });
  return {
    user: publicUser(user),
    plan: { id: entitlements.planId, name: planById(entitlements.planId).name },
    entitlements: entitlements.features,
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
    refreshToken,
    sessionId: session.id
  };
}

// ---------------------------------------------------------------- signup ---

export async function startSignup({ name, username, email, password, planId, ip }) {
  const requestedPlan = planById(planId || DEFAULT_PLAN_ID).id;

  if (await usernameInUse(username)) {
    throw new ConflictError('That user name is already taken.', 'USERNAME_TAKEN');
  }
  if (await emailInUse(email)) {
    throw new ConflictError('An account with that email already exists. Sign in instead.', 'EMAIL_IN_USE');
  }

  const passwordHash = await hashPassword(password);
  const pendingId = randomId('pnd');
  const code = issueVerificationCode();

  await pendingStore.update(db => {
    // One live pending signup per email — restarting signup invalidates
    // earlier codes for that address.
    for (const [key, entry] of Object.entries(db.pending)) {
      if (entry.email === email || entry.expiresAt <= nowSeconds()) delete db.pending[key];
    }
    db.pending[pendingId] = {
      id: pendingId,
      name,
      username,
      email,
      passwordHash,
      planId: requestedPlan,
      codeHash: codeDigest(pendingId, code),
      expiresAt: nowSeconds() + config.verification.ttlSeconds,
      attempts: 0,
      resends: 0,
      lastSentAt: nowSeconds(),
      createdIp: ip || ''
    };
  });

  // STATIC CODE: email delivery is commented out. Uncomment this line — or
  // just clear config.verification.staticCode, which makes the guard fall
  // through to it — to send the real message again.
  if (!verificationDeliveryDisabled()) {
    await sendMail({ to: email, ...verificationEmail({ name, code, ttlMinutes: Math.round(config.verification.ttlSeconds / 60) }) });
  }
  await audit('signup.started', { pendingId, email, username, ip, staticCode: verificationDeliveryDisabled() });

  return {
    pendingId,
    email,
    expiresInSeconds: config.verification.ttlSeconds,
    resendCooldownSeconds: config.verification.resendCooldownSeconds
  };
}

export async function resendSignupCode({ pendingId, ip }) {
  const code = issueVerificationCode();
  const entry = await pendingStore.update(db => {
    const pending = db.pending[pendingId];
    if (!pending || pending.expiresAt <= nowSeconds()) return { result: null };
    if (pending.resends >= config.verification.maxResends) return { result: { blocked: 'max_resends' } };
    if (nowSeconds() - pending.lastSentAt < config.verification.resendCooldownSeconds) return { result: { blocked: 'cooldown' } };
    pending.resends += 1;
    pending.lastSentAt = nowSeconds();
    pending.attempts = 0;
    pending.codeHash = codeDigest(pendingId, code);
    pending.expiresAt = nowSeconds() + config.verification.ttlSeconds;
    return { result: { pending } };
  });

  if (!entry) throw new ValidationError('This signup session has expired. Start over.');
  if (entry.blocked === 'max_resends') throw new RateLimitError('Too many codes requested. Start the signup again later.', 3600);
  if (entry.blocked === 'cooldown') throw new RateLimitError('Please wait before requesting another code.', config.verification.resendCooldownSeconds);

  // STATIC CODE: see issueVerificationCode above. Resending still rotates the
  // stored hash and resets the attempt counter, so the throttling behaviour is
  // exactly what it will be once delivery is switched back on.
  if (!verificationDeliveryDisabled()) {
    await sendMail({
      to: entry.pending.email,
      ...verificationEmail({ name: entry.pending.name, code, ttlMinutes: Math.round(config.verification.ttlSeconds / 60) })
    });
  }
  await audit('signup.code_resent', { pendingId, ip, staticCode: verificationDeliveryDisabled() });
  return { pendingId, resendCooldownSeconds: config.verification.resendCooldownSeconds };
}

export async function verifySignup({ pendingId, code, ip, userAgent }) {
  const verdict = await pendingStore.update(db => {
    const pending = db.pending[pendingId];
    if (!pending || pending.expiresAt <= nowSeconds()) return { result: { status: 'expired' } };
    if (pending.attempts >= config.verification.maxAttempts) {
      delete db.pending[pendingId];
      return { result: { status: 'too_many_attempts' } };
    }
    const expected = Buffer.from(pending.codeHash, 'hex');
    const provided = Buffer.from(codeDigest(pendingId, code), 'hex');
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      pending.attempts += 1;
      return { result: { status: 'wrong_code', attemptsLeft: config.verification.maxAttempts - pending.attempts } };
    }
    delete db.pending[pendingId];
    return { result: { status: 'ok', pending } };
  });

  if (verdict.status === 'expired') throw new ValidationError('This signup session has expired. Start over.');
  if (verdict.status === 'too_many_attempts') {
    await audit('signup.verification_blocked', { pendingId, ip });
    throw new RateLimitError('Too many incorrect codes. Start the signup again.', 300);
  }
  if (verdict.status === 'wrong_code') {
    await audit('signup.wrong_code', { pendingId, ip, attemptsLeft: verdict.attemptsLeft });
    throw new ValidationError(`That code is not correct. ${verdict.attemptsLeft} attempt${verdict.attemptsLeft === 1 ? '' : 's'} left.`);
  }

  const { pending } = verdict;
  const created = await createUser({
    name: pending.name,
    username: pending.username,
    email: pending.email,
    passwordHash: pending.passwordHash,
    planId: pending.planId
  });
  if (!created.ok) {
    // Someone claimed the email/username between start and verify.
    throw new ConflictError(
      created.conflict === 'email'
        ? 'An account with that email was just created. Sign in instead.'
        : 'That user name was just taken. Start the signup again.',
      created.conflict === 'email' ? 'EMAIL_IN_USE' : 'USERNAME_TAKEN'
    );
  }

  await ensureSubscription(created.user.id, pending.planId);
  await audit('signup.completed', { userId: created.user.id, email: pending.email, ip });
  return issueTokensForUser(created.user, { ip, userAgent });
}

// ----------------------------------------------------------------- login ---

export async function login({ identifier, password, ip, userAgent }) {
  const user = await findUserByIdentifier(identifier);

  if (!user) {
    // Equalize timing with a real scrypt verification, then fail generically.
    await verifyPassword(password, await dummyHash());
    await audit('login.failed', { identifier: String(identifier).slice(0, 64), reason: 'unknown_identifier', ip });
    throw new AuthenticationError('Invalid user name or password.', 'INVALID_CREDENTIALS');
  }

  const lockedUntil = user.lockedUntil ? Date.parse(user.lockedUntil) : 0;
  if (lockedUntil > Date.now()) {
    const retryAfterSeconds = Math.ceil((lockedUntil - Date.now()) / 1000);
    await audit('login.blocked_lockout', { userId: user.id, ip, retryAfterSeconds });
    throw new RateLimitError('Too many failed attempts. This account is temporarily locked.', retryAfterSeconds);
  }

  const passwordOk = await verifyPassword(password, user.passwordHash);
  if (!passwordOk) {
    await updateUser(user.id, current => {
      current.failedLoginCount = (current.failedLoginCount || 0) + 1;
      if (current.failedLoginCount >= config.lockout.maxFailures) {
        const excess = current.failedLoginCount - config.lockout.maxFailures;
        const delaySeconds = Math.min(config.lockout.baseDelaySeconds * 2 ** excess, config.lockout.maxDelaySeconds);
        current.lockedUntil = new Date(Date.now() + delaySeconds * 1000).toISOString();
      }
    });
    await audit('login.failed', { userId: user.id, reason: 'wrong_password', ip });
    throw new AuthenticationError('Invalid user name or password.', 'INVALID_CREDENTIALS');
  }

  if (user.status !== 'active') {
    await audit('login.blocked_status', { userId: user.id, status: user.status, ip });
    throw new AuthenticationError('This account is disabled. Contact support.', 'ACCOUNT_DISABLED');
  }

  // Success: clear failure state; transparently upgrade weak legacy hashes.
  await updateUser(user.id, current => {
    current.failedLoginCount = 0;
    current.lockedUntil = null;
    current.lastLoginAt = new Date().toISOString();
  });
  if (passwordNeedsRehash(user.passwordHash)) {
    const upgraded = await hashPassword(password);
    await updateUser(user.id, current => { current.passwordHash = upgraded; });
  }

  await ensureSubscription(user.id, user.planId);
  await audit('login.succeeded', { userId: user.id, ip });
  return issueTokensForUser(user, { ip, userAgent });
}

// --------------------------------------------------------------- refresh ---

export async function refresh({ refreshToken, ip, userAgent }) {
  const rotated = await rotateSession(refreshToken);
  if (!rotated.ok) {
    if (rotated.reason === 'reuse') {
      throw new AuthenticationError('Session security check failed. Sign in again.', 'SESSION_REVOKED');
    }
    throw new AuthenticationError('Refresh token is invalid or expired.', 'REFRESH_INVALID');
  }
  const user = await findUserById(rotated.session.userId);
  if (!user || user.status !== 'active') {
    throw new AuthenticationError('This account is disabled. Contact support.', 'ACCOUNT_DISABLED');
  }
  const entitlements = await entitlementsForUser(user.id);
  const access = issueAccessToken({
    user,
    sessionId: rotated.session.id,
    planId: entitlements.planId,
    entitlements: entitlements.features
  });
  await audit('session.refreshed', { userId: user.id, sessionId: rotated.session.id, ip, userAgent: String(userAgent || '').slice(0, 80) });
  return {
    user: publicUser(user),
    plan: { id: entitlements.planId, name: planById(entitlements.planId).name },
    entitlements: entitlements.features,
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
    refreshToken: rotated.refreshToken,
    sessionId: rotated.session.id
  };
}

// ---------------------------------------------------------------- logout ---

export async function logout({ refreshToken }) {
  const session = await revokeSessionByRefreshToken(refreshToken);
  if (session) await audit('logout', { userId: session.userId, sessionId: session.id });
  return { ok: true };
}

export async function logoutAll(userId) {
  const count = await revokeAllSessionsForUser(userId);
  await audit('logout.all', { userId, sessions: count });
  return { revokedSessions: count };
}

// -------------------------------------------------------------- password ---

export async function changePassword({ userId, currentPassword, newPassword, ip }) {
  const user = await findUserById(userId);
  if (!user) throw new AuthenticationError('Account not found.', 'ACCOUNT_DISABLED');
  const ok = await verifyPassword(currentPassword, user.passwordHash);
  if (!ok) {
    await audit('password.change_failed', { userId, ip });
    throw new AuthenticationError('Current password is incorrect.', 'INVALID_CREDENTIALS');
  }
  const nextHash = await hashPassword(newPassword);
  await updateUser(userId, current => {
    current.passwordHash = nextHash;
    current.passwordChangedAt = new Date().toISOString();
  });
  // Changing the password invalidates every session — the caller signs in
  // again with the new credential.
  await revokeAllSessionsForUser(userId, 'password_changed');
  await audit('password.changed', { userId, ip });
  return { ok: true };
}
