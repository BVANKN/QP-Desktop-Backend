import { MongoClient } from 'mongodb';
import { config } from '../config/config.js';
import { logger } from '../core/logger.js';

let client = null;
let database = null;
let connecting = null;

export function mongoEnabled() {
  return Boolean(config.mongo.uri);
}

export async function initializeMongo() {
  if (!mongoEnabled()) return null;
  if (database) return database;
  if (connecting) return connecting;

  connecting = (async () => {
    const nextClient = new MongoClient(config.mongo.uri, {
      maxPoolSize: config.mongo.maxPoolSize,
      minPoolSize: 0,
      maxIdleTimeMS: config.mongo.maxIdleTimeMs,
      serverSelectionTimeoutMS: config.mongo.serverSelectionTimeoutMs,
      connectTimeoutMS: config.mongo.connectTimeoutMs,
      retryReads: true,
      retryWrites: true,
      appName: 'quicker-portal-backend'
    });
    try {
      await nextClient.connect();
      const nextDatabase = nextClient.db(config.mongo.database);
      await nextDatabase.command({ ping: 1 });
      await ensureIndexes(nextDatabase);
      client = nextClient;
      database = nextDatabase;
      logger.info('MongoDB persistence connected', { database: config.mongo.database });
      return database;
    } catch (error) {
      await nextClient.close().catch(() => {});
      throw error;
    }
  })();

  try {
    return await connecting;
  } catch (error) {
    connecting = null;
    throw new Error(`MongoDB connection failed: ${error.message}`, { cause: error });
  }
}

export async function mongoCollection(name) {
  const db = await initializeMongo();
  if (!db) throw new Error('MongoDB is not configured. Set MONGODB_URI before using Mongo persistence.');
  return db.collection(name);
}

export async function withMongoTransaction(task) {
  const db = await initializeMongo();
  if (!db || !client) throw new Error('MongoDB is not configured.');
  const session = client.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await task({ db, session });
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary'
    });
    return result;
  } finally {
    await session.endSession();
  }
}

export async function closeMongo() {
  const current = client;
  client = null;
  database = null;
  connecting = null;
  if (current) await current.close();
}

async function ensureIndexes(db) {
  await Promise.all([
    db.collection('users').createIndexes([
      { key: { id: 1 }, name: 'user_id', unique: true },
      { key: { email: 1 }, name: 'user_email', unique: true },
      { key: { username: 1 }, name: 'user_username', unique: true }
    ]),
    db.collection('pending_signups').createIndexes([
      { key: { id: 1 }, name: 'pending_id', unique: true },
      { key: { email: 1 }, name: 'pending_email', unique: true },
      { key: { expiresAtDate: 1 }, name: 'pending_expiry', expireAfterSeconds: 0 }
    ]),
    db.collection('sessions').createIndexes([
      { key: { id: 1 }, name: 'session_id', unique: true },
      { key: { refreshTokenHash: 1 }, name: 'session_refresh_hash', unique: true },
      { key: { previousTokenHashes: 1 }, name: 'session_previous_hashes' },
      { key: { userId: 1, revokedAt: 1 }, name: 'session_user_active' }
    ]),
    db.collection('subscriptions').createIndexes([
      { key: { id: 1 }, name: 'subscription_id', unique: true },
      { key: { userId: 1 }, name: 'subscription_active_user', unique: true, partialFilterExpression: { status: 'active' } }
    ]),
    db.collection('mcp_connections').createIndexes([
      { key: { id: 1 }, name: 'mcp_connection_id', unique: true },
      { key: { userId: 1 }, name: 'mcp_ide_user', unique: true, partialFilterExpression: { kind: 'ide' } },
      { key: { userId: 1, tenantKey: 1, enabled: 1 }, name: 'mcp_connection_resource' }
    ]),
    db.collection('mcp_jobs').createIndexes([
      { key: { id: 1 }, name: 'mcp_job_id', unique: true },
      { key: { userId: 1, tenantKey: 1, environmentKey: 1, status: 1, createdAt: 1 }, name: 'mcp_job_claim' },
      { key: { retentionAt: 1 }, name: 'mcp_job_retention', expireAfterSeconds: 0 }
    ]),
    db.collection('oauth_clients').createIndexes([
      { key: { id: 1 }, name: 'oauth_client_id', unique: true },
      { key: { createdAt: 1 }, name: 'oauth_client_created' }
    ]),
    db.collection('oauth_authorizations').createIndexes([
      { key: { id: 1 }, name: 'oauth_authorization_id', unique: true },
      { key: { expiresAtDate: 1 }, name: 'oauth_authorization_expiry', expireAfterSeconds: 0 }
    ]),
    db.collection('oauth_codes').createIndexes([
      { key: { id: 1 }, name: 'oauth_code_id', unique: true },
      { key: { expiresAtDate: 1 }, name: 'oauth_code_expiry', expireAfterSeconds: 0 }
    ]),
    db.collection('oauth_grants').createIndexes([
      { key: { id: 1 }, name: 'oauth_grant_id', unique: true },
      { key: { userId: 1, tenantId: 1, clientId: 1, revokedAt: 1 }, name: 'oauth_grant_user_client' }
    ]),
    db.collection('audit_events').createIndexes([
      { key: { time: -1 }, name: 'audit_time' },
      { key: { migrationKey: 1 }, name: 'audit_migration_key', unique: true, sparse: true }
    ]),
    db.collection('mcp_transmissions').createIndexes([
      { key: { id: 1 }, name: 'transmission_id', unique: true },
      { key: { userId: 1, time: -1 }, name: 'transmission_user_time' },
      { key: { userId: 1, tenantKey: 1, environmentKey: 1, toolName: 1, time: -1 }, name: 'transmission_filter' }
    ])
  ]);
}
