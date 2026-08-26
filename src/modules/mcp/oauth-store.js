import { JsonStore } from '../../lib/json-store.js';
import { mongoCollection, mongoEnabled, withMongoTransaction } from '../../lib/mongo.js';

const clientsFileStore = new JsonStore('mcp/oauth-clients.json', { version: 1, clients: [] });
const authorizationsFileStore = new JsonStore('mcp/oauth-authorizations.json', { version: 1, requests: {} });
const tokensFileStore = new JsonStore('mcp/oauth-tokens.json', { version: 1, codes: {}, grants: {} });

function clean(document) {
  if (!document) return null;
  const { _id, _rev, expiresAtDate, ...value } = document;
  return value;
}

export async function registerOAuthClientRecord(client, { maxClients, cutoff }) {
  if (mongoEnabled()) {
    const collection = await mongoCollection('oauth_clients');
    await collection.deleteMany({ createdAt: { $lte: cutoff } });
    if (await collection.countDocuments({}) >= maxClients) return false;
    await collection.insertOne(client);
    return true;
  }
  return clientsFileStore.update(db => {
    db.clients = db.clients.filter(item => item.createdAt > cutoff);
    if (db.clients.length >= maxClients) return { result: false };
    db.clients.push(client);
    return { result: true };
  });
}

export async function findOAuthClientRecord(clientId) {
  if (mongoEnabled()) return clean(await (await mongoCollection('oauth_clients')).findOne({ id: clientId }));
  const db = await clientsFileStore.read();
  return db.clients.find(item => item.id === clientId) || null;
}

export async function listOAuthClientRecords() {
  if (mongoEnabled()) return (await (await mongoCollection('oauth_clients')).find({}).toArray()).map(clean);
  return (await clientsFileStore.read()).clients;
}

export async function saveOAuthAuthorization(record) {
  if (mongoEnabled()) {
    await (await mongoCollection('oauth_authorizations')).insertOne({
      ...record,
      expiresAtDate: new Date(record.expiresAt * 1000)
    });
    return;
  }
  await authorizationsFileStore.update(db => {
    for (const [id, item] of Object.entries(db.requests)) {
      if (item.expiresAt <= record.createdAt || item.usedAt) delete db.requests[id];
    }
    db.requests[record.id] = record;
  });
}

export async function findOAuthAuthorizationRecord(requestId) {
  if (mongoEnabled()) return clean(await (await mongoCollection('oauth_authorizations')).findOne({ id: requestId }));
  return (await authorizationsFileStore.read()).requests[requestId] || null;
}

export async function markOAuthAuthorizationUsed(requestId, { csrfHash, now }) {
  if (mongoEnabled()) {
    const result = await (await mongoCollection('oauth_authorizations')).updateOne(
      { id: requestId, usedAt: null, expiresAt: { $gt: now }, csrfHash },
      { $set: { usedAt: now } }
    );
    return result.modifiedCount === 1;
  }
  return authorizationsFileStore.update(db => {
    const current = db.requests[requestId];
    if (!current || current.usedAt || current.expiresAt <= now || current.csrfHash !== csrfHash) return { result: false };
    current.usedAt = now;
    return { result: true };
  });
}

export async function consumeAuthorizationAndCreateCode({ requestId, csrfHash, now, codeRecord }) {
  if (mongoEnabled()) {
    return withMongoTransaction(async ({ db, session }) => {
      const consumed = await db.collection('oauth_authorizations').updateOne(
        { id: requestId, usedAt: null, expiresAt: { $gt: now }, csrfHash },
        { $set: { usedAt: now } },
        { session }
      );
      if (consumed.modifiedCount !== 1) return false;
      await db.collection('oauth_codes').insertOne({
        ...codeRecord,
        expiresAtDate: new Date(codeRecord.expiresAt * 1000)
      }, { session });
      return true;
    });
  }
  return authorizationsFileStore.update(async db => {
    const current = db.requests[requestId];
    if (!current || current.usedAt || current.expiresAt <= now || current.csrfHash !== csrfHash) return { result: false };
    current.usedAt = now;
    await tokensFileStore.update(tokens => {
      for (const [id, item] of Object.entries(tokens.codes)) if (item.expiresAt <= now || item.usedAt) delete tokens.codes[id];
      tokens.codes[codeRecord.id] = codeRecord;
    });
    return { result: true };
  });
}

export async function findOAuthCodeRecord(codeId) {
  if (mongoEnabled()) return clean(await (await mongoCollection('oauth_codes')).findOne({ id: codeId }));
  return (await tokensFileStore.read()).codes[codeId] || null;
}

export async function consumeCodeAndCreateGrant({ codeId, codeHash, now, grant }) {
  if (mongoEnabled()) {
    return withMongoTransaction(async ({ db, session }) => {
      const consumed = await db.collection('oauth_codes').updateOne(
        { id: codeId, usedAt: null, expiresAt: { $gt: now }, codeHash },
        { $set: { usedAt: now } },
        { session }
      );
      if (consumed.modifiedCount !== 1) return false;
      await db.collection('oauth_grants').insertOne({ ...grant, _rev: 1 }, { session });
      return true;
    });
  }
  return tokensFileStore.update(db => {
    const record = db.codes[codeId];
    if (!record || record.usedAt || record.expiresAt <= now || record.codeHash !== codeHash) return { result: false };
    record.usedAt = now;
    db.grants[grant.id] = grant;
    return { result: true };
  });
}

export async function findOAuthGrantRecord(grantId) {
  if (mongoEnabled()) return clean(await (await mongoCollection('oauth_grants')).findOne({ id: grantId }));
  return (await tokensFileStore.read()).grants[grantId] || null;
}

export async function mutateOAuthGrant(grantId, mutator) {
  if (mongoEnabled()) {
    const collection = await mongoCollection('oauth_grants');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await collection.findOne({ id: grantId });
      const value = clean(current);
      const outcome = await mutator(value ? structuredClone(value) : null) || {};
      if (!current) return outcome.result;
      const revision = current._rev || 1;
      if (outcome.write === false) {
        const stillCurrent = await collection.findOne({ id: grantId, _rev: revision }, { projection: { _id: 1 } });
        if (stillCurrent) return outcome.result;
        continue;
      }
      const next = outcome.value || value;
      const replacement = { ...next, _rev: revision + 1 };
      const updated = await collection.replaceOne({ id: grantId, _rev: revision }, replacement);
      if (updated.matchedCount === 1) return outcome.result;
    }
    throw new Error('The OAuth grant changed too many times while it was being updated. Retry the request.');
  }
  return tokensFileStore.update(async db => {
    const current = db.grants[grantId] || null;
    const outcome = await mutator(current) || {};
    if (current && outcome.value) db.grants[grantId] = outcome.value;
    return { result: outcome.result };
  });
}

export async function listOAuthGrantRecords({ userId, tenantId }) {
  if (mongoEnabled()) {
    const filter = { userId };
    if (tenantId !== undefined) filter.tenantId = tenantId;
    return (await (await mongoCollection('oauth_grants')).find(filter).toArray()).map(clean);
  }
  return Object.values((await tokensFileStore.read()).grants).filter(grant => (
    grant.userId === userId && (tenantId === undefined || grant.tenantId === tenantId)
  ));
}

export async function revokeOAuthClientGrants({ userId, tenantId, clientId, now, reason }) {
  if (mongoEnabled()) {
    const result = await (await mongoCollection('oauth_grants')).updateMany(
      { userId, tenantId, clientId, revokedAt: null },
      { $set: { revokedAt: now, revokedReason: reason } }
    );
    return result.modifiedCount;
  }
  return tokensFileStore.update(db => {
    let revoked = 0;
    for (const grant of Object.values(db.grants)) {
      if (grant.userId !== userId || grant.tenantId !== tenantId || grant.clientId !== clientId || grant.revokedAt) continue;
      grant.revokedAt = now;
      grant.revokedReason = reason;
      revoked += 1;
    }
    return { result: revoked };
  });
}
