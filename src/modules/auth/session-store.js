// Refresh-token sessions with rotation and theft detection.
//
// A session is created at login. The refresh token handed to the client is a
// 256-bit random value; only its SHA-256 lands on disk, so a leaked data file
// cannot be replayed. Each refresh rotates the token. If a *previous*
// (already-rotated) token is ever presented again, someone is replaying a
// stolen token — the whole session family is revoked immediately.
import { JsonStore } from '../../lib/json-store.js';
import { randomId, randomToken, sha256Hex } from '../../lib/crypto.js';
import { config } from '../../config/config.js';
import { mongoCollection, mongoEnabled } from '../../lib/mongo.js';
import { audit } from '../audit/audit.js';

const sessionsStore = new JsonStore('sessions/sessions.json', { sessions: {} });

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export async function createSession({ userId, ip, userAgent }) {
  const refreshToken = randomToken(32);
  const session = {
    id: randomId('ses'),
    userId,
    refreshTokenHash: sha256Hex(refreshToken),
    previousTokenHashes: [],
    createdAt: nowSeconds(),
    lastRefreshAt: nowSeconds(),
    expiresAt: nowSeconds() + config.token.refreshTtlSeconds,
    absoluteExpiresAt: nowSeconds() + config.token.sessionAbsoluteTtlSeconds,
    revokedAt: null,
    revokedReason: null,
    createdIp: ip || '',
    userAgent: String(userAgent || '').slice(0, 200)
  };
  if (mongoEnabled()) {
    await (await mongoCollection('sessions')).insertOne(session);
  } else {
    await sessionsStore.update(db => {
      db.sessions[session.id] = session;
    });
  }
  return { session, refreshToken };
}

export async function isSessionActive(sessionId, userId) {
  if (mongoEnabled()) {
    return Boolean(await (await mongoCollection('sessions')).findOne({
      id: sessionId,
      userId,
      revokedAt: null,
      expiresAt: { $gt: nowSeconds() }
    }, { projection: { _id: 1 } }));
  }
  const db = await sessionsStore.read();
  const session = db.sessions[sessionId];
  return Boolean(session && session.userId === userId && !session.revokedAt && session.expiresAt > nowSeconds());
}

// Rotate a refresh token. Returns:
//   { ok: true, session, refreshToken }         — success, new token issued
//   { ok: false, reason: 'reuse', session }     — replay of rotated token; session revoked
//   { ok: false, reason: 'invalid' }            — unknown/expired/revoked
export async function rotateSession(presentedToken) {
  const presentedHash = sha256Hex(String(presentedToken || ''));
  if (mongoEnabled()) {
    const collection = await mongoCollection('sessions');
    const current = await collection.findOne({ refreshTokenHash: presentedHash });
    if (current) {
      const now = nowSeconds();
      if (current.revokedAt || current.expiresAt <= now || current.absoluteExpiresAt <= now) {
        return { ok: false, reason: 'invalid' };
      }
      const refreshToken = randomToken(32);
      const nextHash = sha256Hex(refreshToken);
      const nextPrevious = [...(current.previousTokenHashes || []).slice(-9), current.refreshTokenHash];
      const nextExpiresAt = Math.min(now + config.token.refreshTtlSeconds, current.absoluteExpiresAt);
      const updated = await collection.findOneAndUpdate(
        { id: current.id, refreshTokenHash: presentedHash, revokedAt: null },
        { $set: { refreshTokenHash: nextHash, previousTokenHashes: nextPrevious, lastRefreshAt: now, expiresAt: nextExpiresAt } },
        { returnDocument: 'after' }
      );
      if (updated) {
        const { _id, ...session } = updated;
        return { ok: true, session, refreshToken };
      }
      // A concurrent refresh may already have rotated this token. Fall through
      // to reuse detection so token replay never succeeds twice.
    }
    const victim = await collection.findOne({ previousTokenHashes: presentedHash });
    if (victim && !victim.revokedAt) {
      const revokedAt = nowSeconds();
      await collection.updateOne({ id: victim.id, revokedAt: null }, { $set: { revokedAt, revokedReason: 'refresh_token_reuse' } });
      const { _id, ...session } = { ...victim, revokedAt, revokedReason: 'refresh_token_reuse' };
      await audit('session.reuse_detected', { userId: victim.userId, sessionId: victim.id });
      return { ok: false, reason: 'reuse', session };
    }
    return { ok: false, reason: 'invalid' };
  }

  const outcome = await sessionsStore.update(db => {
    const sessions = Object.values(db.sessions);
    const current = sessions.find(session => session.refreshTokenHash === presentedHash);
    if (current) {
      if (current.revokedAt || current.expiresAt <= nowSeconds() || current.absoluteExpiresAt <= nowSeconds()) {
        return { result: { ok: false, reason: 'invalid' } };
      }
      const refreshToken = randomToken(32);
      current.previousTokenHashes = [...current.previousTokenHashes.slice(-9), current.refreshTokenHash];
      current.refreshTokenHash = sha256Hex(refreshToken);
      current.lastRefreshAt = nowSeconds();
      current.expiresAt = Math.min(nowSeconds() + config.token.refreshTtlSeconds, current.absoluteExpiresAt);
      return { result: { ok: true, session: current, refreshToken } };
    }
    const victim = sessions.find(session => session.previousTokenHashes.includes(presentedHash));
    if (victim) {
      victim.revokedAt = nowSeconds();
      victim.revokedReason = 'refresh_token_reuse';
      return { result: { ok: false, reason: 'reuse', session: victim } };
    }
    return { result: { ok: false, reason: 'invalid' } };
  });
  if (!outcome.ok && outcome.reason === 'reuse') {
    await audit('session.reuse_detected', { userId: outcome.session.userId, sessionId: outcome.session.id });
  }
  return outcome;
}

export async function revokeSessionByRefreshToken(presentedToken) {
  const presentedHash = sha256Hex(String(presentedToken || ''));
  if (mongoEnabled()) {
    const updated = await (await mongoCollection('sessions')).findOneAndUpdate(
      { refreshTokenHash: presentedHash, revokedAt: null },
      { $set: { revokedAt: nowSeconds(), revokedReason: 'logout' } },
      { returnDocument: 'after' }
    );
    if (!updated) return null;
    const { _id, ...session } = updated;
    return session;
  }
  return sessionsStore.update(db => {
    const session = Object.values(db.sessions).find(entry => entry.refreshTokenHash === presentedHash && !entry.revokedAt);
    if (!session) return { result: null };
    session.revokedAt = nowSeconds();
    session.revokedReason = 'logout';
    return { result: session };
  });
}

export async function revokeAllSessionsForUser(userId, reason = 'logout_all') {
  if (mongoEnabled()) {
    const result = await (await mongoCollection('sessions')).updateMany(
      { userId, revokedAt: null },
      { $set: { revokedAt: nowSeconds(), revokedReason: reason } }
    );
    return result.modifiedCount;
  }
  return sessionsStore.update(db => {
    let count = 0;
    for (const session of Object.values(db.sessions)) {
      if (session.userId === userId && !session.revokedAt) {
        session.revokedAt = nowSeconds();
        session.revokedReason = reason;
        count += 1;
      }
    }
    return { result: count };
  });
}

// Housekeeping: drop sessions expired for over a week to keep the file small.
export async function pruneExpiredSessions() {
  const cutoff = nowSeconds() - 7 * 24 * 60 * 60;
  if (mongoEnabled()) {
    const result = await (await mongoCollection('sessions')).deleteMany({
      $or: [
        { expiresAt: { $lt: cutoff } },
        { revokedAt: { $ne: null, $lt: cutoff } }
      ]
    });
    return result.deletedCount;
  }
  return sessionsStore.update(db => {
    let removed = 0;
    for (const [id, session] of Object.entries(db.sessions)) {
      if (session.expiresAt < cutoff || (session.revokedAt && session.revokedAt < cutoff)) {
        delete db.sessions[id];
        removed += 1;
      }
    }
    return { result: removed };
  });
}
