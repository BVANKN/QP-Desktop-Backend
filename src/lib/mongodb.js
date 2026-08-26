// Shared MongoDB Atlas connection and one-time legacy user migration.
import { MongoClient } from 'mongodb';
import { JsonStore } from './json-store.js';

const uri = String(process.env.MONGODB_URI || '').trim();
const dbName = String(process.env.MONGODB_DB_NAME || 'QPC').trim();

let clientPromise;
let databasePromise;

function requireMongoUri() {
  if (!uri) {
    throw new Error('MONGODB_URI is not configured. Set it in the environment before starting the backend.');
  }
}

export async function getDb() {
  requireMongoUri();
  if (!databasePromise) {
    if (!clientPromise) {
      const client = new MongoClient(uri, {
        serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 10_000),
        maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE || 20)
      });
      clientPromise = client.connect().then(() => client);
    }
    databasePromise = clientPromise.then(client => client.db(dbName));
  }
  return databasePromise;
}

export async function initializeMongoDb() {
  const db = await getDb();
  const users = db.collection('users');

  await users.createIndex({ id: 1 }, { unique: true, name: 'uq_users_id' });
  await users.createIndex({ email: 1 }, { unique: true, name: 'uq_users_email' });
  await users.createIndex({ username: 1 }, { unique: true, name: 'uq_users_username' });

  // Migrate the old JSON user store once when MongoDB is empty. This keeps
  // existing accounts on the Render disk usable after the deployment changes
  // from JSON-backed users to MongoDB-backed users.
  if (await users.countDocuments() === 0) {
    const legacyStore = new JsonStore('users/users.json', {
      users: {},
      emailIndex: {},
      usernameIndex: {}
    });
    const legacy = await legacyStore.read();
    const legacyUsers = Object.values(legacy.users || {});
    if (legacyUsers.length) {
      await users.insertMany(legacyUsers, { ordered: false });
      return { migratedUsers: legacyUsers.length };
    }
  }

  return { migratedUsers: 0 };
}

export async function closeMongoDb() {
  if (!clientPromise) return;
  const client = await clientPromise;
  await client.close();
  clientPromise = undefined;
  databasePromise = undefined;
}
