import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../src/config/config.js';
import { closeMongo, initializeMongo } from '../src/lib/mongo.js';

if (!config.mongo.uri) {
  throw new Error('MONGODB_URI is required for migration. Set it in the environment before running npm run migrate:mongo.');
}

const db = await initializeMongo();
const root = config.dataDir;
const counts = {};

try {
async function readJson(relativePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function upsertMany(collectionName, records, { key = 'id', transform = value => value } = {}) {
  const rows = records.map(transform).filter(Boolean);
  if (!rows.length) {
    counts[collectionName] = 0;
    return;
  }
  const collection = db.collection(collectionName);
  const operations = rows.map(value => ({
    updateOne: {
      filter: { [key]: value[key] },
      update: { $setOnInsert: value },
      upsert: true
    }
  }));
  await collection.bulkWrite(operations, { ordered: false });
  counts[collectionName] = rows.length;
}

const users = await readJson('users/users.json', { users: {} });
await upsertMany('users', Object.values(users.users || {}), {
  transform: user => ({ ...user, _rev: user._rev || 1 })
});

const pending = await readJson('users/pending-signups.json', { pending: {} });
await upsertMany('pending_signups', Object.values(pending.pending || {}), {
  transform: entry => ({ ...entry, _rev: entry._rev || 1, expiresAtDate: new Date(entry.expiresAt * 1000) })
});

const sessions = await readJson('sessions/sessions.json', { sessions: {} });
await upsertMany('sessions', Object.values(sessions.sessions || {}));

const subscriptions = await readJson('plans/subscriptions.json', { subscriptions: {} });
await upsertMany('subscriptions', Object.values(subscriptions.subscriptions || {}));

const connections = await readJson('mcp/connections.json', { connections: [] });
await upsertMany('mcp_connections', connections.connections || [], {
  transform: entry => ({
    ...entry,
    tenantKey: String(entry.tenantId || '').toLowerCase(),
    environmentKey: String(entry.environmentId || '').toLowerCase()
  })
});

const jobs = await readJson('mcp/jobs.json', { jobs: [] });
await upsertMany('mcp_jobs', jobs.jobs || [], {
  transform: job => ({
    ...job,
    tenantKey: String(job.tenantId || '').toLowerCase(),
    environmentKey: String(job.environmentId || '').toLowerCase(),
    ...(['completed', 'failed', 'expired'].includes(job.status)
      ? { retentionAt: new Date(Date.now() + 24 * 60 * 60_000) }
      : {})
  })
});

const clients = await readJson('mcp/oauth-clients.json', { clients: [] });
await upsertMany('oauth_clients', clients.clients || []);

const authorizations = await readJson('mcp/oauth-authorizations.json', { requests: {} });
await upsertMany('oauth_authorizations', Object.values(authorizations.requests || {}), {
  transform: entry => ({ ...entry, expiresAtDate: new Date(entry.expiresAt * 1000) })
});

const tokens = await readJson('mcp/oauth-tokens.json', { codes: {}, grants: {} });
await upsertMany('oauth_codes', Object.values(tokens.codes || {}), {
  transform: entry => ({ ...entry, expiresAtDate: new Date(entry.expiresAt * 1000) })
});
await upsertMany('oauth_grants', Object.values(tokens.grants || {}), {
  transform: entry => ({ ...entry, _rev: entry._rev || 1 })
});

if (!process.env.QP_SIGNING_SECRET) {
  const keys = await readJson('keys/signing-keys.json', null);
  if (keys?.activeKid && Array.isArray(keys.keys) && keys.keys.length) {
    await db.collection('server_secrets').updateOne(
      { _id: 'token-signing-keys' },
      { $setOnInsert: { activeKid: keys.activeKid, keys: keys.keys } },
      { upsert: true }
    );
    counts.server_secrets = 1;
  }
}

async function migrateJsonLines(relativePath, collectionName, mapEntry) {
  let text;
  try {
    text = await fs.readFile(path.join(root, relativePath), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      counts[collectionName] = 0;
      return;
    }
    throw error;
  }
  const collection = db.collection(collectionName);
  const operations = [];
  let lineNumber = 0;
  for (const raw of text.split(/\r?\n/)) {
    lineNumber += 1;
    if (!raw.trim()) continue;
    let entry;
    try { entry = JSON.parse(raw); } catch { continue; }
    const value = mapEntry(entry, raw, lineNumber);
    if (!value) continue;
    const filter = collectionName === 'mcp_transmissions'
      ? { id: value.id }
      : { migrationKey: value.migrationKey };
    operations.push({ updateOne: { filter, update: { $setOnInsert: value }, upsert: true } });
    if (operations.length >= 500) {
      await collection.bulkWrite(operations.splice(0), { ordered: false });
    }
  }
  if (operations.length) await collection.bulkWrite(operations, { ordered: false });
  counts[collectionName] = text.split(/\r?\n/).filter(Boolean).length;
}

await migrateJsonLines('audit/security-events.jsonl', 'audit_events', (entry, raw, lineNumber) => ({
  ...entry,
  migrationKey: createHash('sha256').update(`${lineNumber}\n${raw}`).digest('hex')
}));

await migrateJsonLines('mcp/transmissions.jsonl', 'mcp_transmissions', entry => entry?.id ? {
  ...entry,
  tenantKey: String(entry.tenantId || '').toLowerCase(),
  environmentKey: String(entry.environmentId || '').toLowerCase()
} : null);

console.log(JSON.stringify({
  ok: true,
  database: config.mongo.database,
  sourceDataDir: root,
  migrated: counts
}, null, 2));
} finally {
  await closeMongo();
}
