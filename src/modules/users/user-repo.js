// User persistence backed by MongoDB Atlas.
// The exported repository API intentionally stays the same so auth-service,
// routes, and IDE/MCP modules do not need to know which database is used.
import { getDb } from '../../lib/mongodb.js';
import { randomId } from '../../lib/crypto.js';

const COLLECTION = 'users';

async function usersCollection() {
  const db = await getDb();
  return db.collection(COLLECTION);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

export async function findUserById(userId) {
  const users = await usersCollection();
  return users.findOne({ id: String(userId) });
}

export async function findUserByIdentifier(identifier) {
  const users = await usersCollection();
  const normalized = String(identifier || '').trim().toLowerCase();
  return users.findOne({
    $or: [
      { email: normalized },
      { username: normalized }
    ]
  });
}

export async function emailInUse(email) {
  const users = await usersCollection();
  return Boolean(await users.findOne({ email: normalizeEmail(email) }, { projection: { _id: 1 } }));
}

export async function usernameInUse(username) {
  const users = await usersCollection();
  return Boolean(await users.findOne({ username: normalizeUsername(username) }, { projection: { _id: 1 } }));
}

export async function createUser({ name, username, email, passwordHash, planId }) {
  const users = await usersCollection();
  const normalizedEmail = normalizeEmail(email);
  const normalizedUsername = normalizeUsername(username);
  const now = new Date().toISOString();
  const user = {
    id: randomId('usr'),
    name,
    username: normalizedUsername,
    email: normalizedEmail,
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

  try {
    await users.insertOne(user);
    // MongoDB adds an internal _id to the inserted object. Keep that
    // implementation detail out of the domain user returned to auth-service.
    delete user._id;
    return { ok: true, user };
  } catch (error) {
    // Unique indexes are the final authority, protecting against concurrent
    // signup requests that race between the availability checks and insert.
    if (error?.code === 11000) {
      const conflictField = Object.keys(error.keyPattern || {})[0];
      return {
        ok: false,
        conflict: conflictField === 'username' ? 'username' : 'email'
      };
    }
    throw error;
  }
}

export async function updateUser(userId, mutator) {
  const users = await usersCollection();
  const user = await users.findOne({ id: String(userId) });
  if (!user) return null;

  await mutator(user);
  user.updatedAt = new Date().toISOString();
  delete user._id;

  const result = await users.replaceOne({ id: String(userId) }, user);
  return result.matchedCount ? user : null;
}

// Public projection — everything safe to hand to a client.
export function publicUser(user) {
  if (!user) return null;
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

export async function accountCount() {
  const users = await usersCollection();
  return users.countDocuments();
}
