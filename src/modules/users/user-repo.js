// User persistence. Users live in data/users/users.json; unique lookups go
// through normalized email and username indexes maintained in the same
// atomic update as the user document, so they can never drift.
import { JsonStore } from '../../lib/json-store.js';
import { randomId } from '../../lib/crypto.js';

const usersStore = new JsonStore('users/users.json', { users: {}, emailIndex: {}, usernameIndex: {} });

export async function findUserById(userId) {
  const db = await usersStore.read();
  return db.users[userId] || null;
}

export async function findUserByIdentifier(identifier) {
  const db = await usersStore.read();
  const normalized = String(identifier || '').trim().toLowerCase();
  const userId = db.emailIndex[normalized] || db.usernameIndex[normalized];
  return userId ? db.users[userId] || null : null;
}

export async function emailInUse(email) {
  const db = await usersStore.read();
  return Boolean(db.emailIndex[email]);
}

export async function usernameInUse(username) {
  const db = await usersStore.read();
  return Boolean(db.usernameIndex[username]);
}

// Creates the user only if email and username are still free at write time
// (checked inside the store lock — no TOCTOU races).
export async function createUser({ name, username, email, passwordHash, planId }) {
  return usersStore.update(db => {
    if (db.emailIndex[email]) return { result: { ok: false, conflict: 'email' } };
    if (db.usernameIndex[username]) return { result: { ok: false, conflict: 'username' } };
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
    db.users[user.id] = user;
    db.emailIndex[email] = user.id;
    db.usernameIndex[username] = user.id;
    return { result: { ok: true, user } };
  });
}

export async function updateUser(userId, mutator) {
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
