// User persistence. Users live in data/users/users.json; unique lookups go
// through normalized email and username indexes maintained in the same
// atomic update as the user document, so they can never drift.
import { JsonStore } from '../../lib/json-store.js';
import { randomId } from '../../lib/crypto.js';
import { mongoCollection, mongoEnabled } from '../../lib/mongo.js';

const usersStore = new JsonStore('users/users.json', { users: {}, emailIndex: {}, usernameIndex: {} });

function cleanMongoDocument(document) {
  if (!document) return null;
  const { _id, _rev, ...value } = document;
  return value;
}

export async function findUserById(userId) {
  if (mongoEnabled()) {
    return cleanMongoDocument(await (await mongoCollection('users')).findOne({ id: userId }));
  }
  const db = await usersStore.read();
  return db.users[userId] || null;
}

export async function findUserByIdentifier(identifier) {
  const normalized = String(identifier || '').trim().toLowerCase();
  if (mongoEnabled()) {
    return cleanMongoDocument(await (await mongoCollection('users')).findOne({ $or: [{ email: normalized }, { username: normalized }] }));
  }
  const db = await usersStore.read();
  const userId = db.emailIndex[normalized] || db.usernameIndex[normalized];
  return userId ? db.users[userId] || null : null;
}

export async function emailInUse(email) {
  if (mongoEnabled()) return Boolean(await (await mongoCollection('users')).findOne({ email }, { projection: { _id: 1 } }));
  const db = await usersStore.read();
  return Boolean(db.emailIndex[email]);
}

export async function usernameInUse(username) {
  if (mongoEnabled()) return Boolean(await (await mongoCollection('users')).findOne({ username }, { projection: { _id: 1 } }));
  const db = await usersStore.read();
  return Boolean(db.usernameIndex[username]);
}

// Creates the user only if email and username are still free at write time
// (checked inside the store lock — no TOCTOU races).
export async function createUser({ name, username, email, passwordHash, planId }) {
  const now = new Date().toISOString();
  const user = {
    id: randomId('usr'),
    name,
    username,
    email,
    passwordHash,
    status: 'active',
    emailVerifiedAt: now,
    planId,
    createdAt: now,
    updatedAt: now,
    passwordChangedAt: now,
    failedLoginCount: 0,
    lockedUntil: null
  };
  if (mongoEnabled()) {
    try {
      await (await mongoCollection('users')).insertOne({ ...user, _rev: 1 });
      return { ok: true, user };
    } catch (error) {
      if (error?.code !== 11000) throw error;
      if (error?.keyPattern?.email) return { ok: false, conflict: 'email' };
      if (error?.keyPattern?.username) return { ok: false, conflict: 'username' };
      const collection = await mongoCollection('users');
      if (await collection.findOne({ email }, { projection: { _id: 1 } })) return { ok: false, conflict: 'email' };
      return { ok: false, conflict: 'username' };
    }
  }
  return usersStore.update(db => {
    if (db.emailIndex[email]) return { result: { ok: false, conflict: 'email' } };
    if (db.usernameIndex[username]) return { result: { ok: false, conflict: 'username' } };
    db.users[user.id] = user;
    db.emailIndex[email] = user.id;
    db.usernameIndex[username] = user.id;
    return { result: { ok: true, user } };
  });
}

export async function updateUser(userId, mutator) {
  if (mongoEnabled()) {
    const collection = await mongoCollection('users');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await collection.findOne({ id: userId });
      if (!current) return null;
      const revision = current._rev || 1;
      const user = cleanMongoDocument(current);
      mutator(user);
      user.updatedAt = new Date().toISOString();
      const result = await collection.updateOne({ id: userId, _rev: revision }, { $set: { ...user, _rev: revision + 1 } });
      if (result.matchedCount === 1) return user;
    }
    throw new Error('The user record changed too many times while it was being updated. Retry the request.');
  }
  return usersStore.update(db => {
    const user = db.users[userId];
    if (!user) return { result: null };
    mutator(user);
    user.updatedAt = new Date().toISOString();
    return { result: user };
  });
}

// Public projection — everything safe to hand to a client.
export function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    planId: user.planId,
    emailVerifiedAt: user.emailVerifiedAt,
    createdAt: user.createdAt
  };
}

/**
 * How many accounts the authoritative store currently holds. Health reporting
 * uses this to distinguish an empty database from one that already contains
 * product identities without disclosing counts or account data.
 */
export async function accountCount() {
  if (mongoEnabled()) return (await mongoCollection('users')).countDocuments({});
  const db = await usersStore.read();
  return Object.keys(db.users || {}).length;
}
