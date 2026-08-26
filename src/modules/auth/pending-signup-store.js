import { JsonStore } from '../../lib/json-store.js';
import { mongoCollection, mongoEnabled } from '../../lib/mongo.js';

const fileStore = new JsonStore('users/pending-signups.json', { pending: {} });

function clean(document) {
  if (!document) return null;
  const { _id, _rev, expiresAtDate, ...value } = document;
  return value;
}

export async function replacePendingSignup(record) {
  if (mongoEnabled()) {
    const collection = await mongoCollection('pending_signups');
    const document = {
      ...record,
      _rev: 1,
      expiresAtDate: new Date(record.expiresAt * 1000)
    };
    await collection.deleteMany({ expiresAt: { $lte: Math.floor(Date.now() / 1000) } });
    try {
      await collection.replaceOne({ email: record.email }, document, { upsert: true });
    } catch (error) {
      // Concurrent starts for the same address are resolved by the unique
      // email index; the latest request replaces whichever write won first.
      if (error?.code !== 11000) throw error;
      await collection.replaceOne({ email: record.email }, document, { upsert: false });
    }
    return record;
  }

  await fileStore.update(db => {
    for (const [key, entry] of Object.entries(db.pending)) {
      if (entry.email === record.email || entry.expiresAt <= Math.floor(Date.now() / 1000)) delete db.pending[key];
    }
    db.pending[record.id] = record;
  });
  return record;
}

export async function mutatePendingSignup(pendingId, mutator) {
  if (mongoEnabled()) {
    const collection = await mongoCollection('pending_signups');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await collection.findOne({ id: pendingId });
      const value = clean(current);
      const outcome = await mutator(value ? structuredClone(value) : null) || {};
      if (!current) return outcome.result;
      const revision = current._rev || 1;
      if (outcome.delete) {
        const removed = await collection.deleteOne({ id: pendingId, _rev: revision });
        if (removed.deletedCount === 1) return outcome.result;
        continue;
      }
      const next = outcome.value || value;
      const replacement = {
        ...next,
        _rev: revision + 1,
        expiresAtDate: new Date(next.expiresAt * 1000)
      };
      const updated = await collection.replaceOne({ id: pendingId, _rev: revision }, replacement);
      if (updated.matchedCount === 1) return outcome.result;
    }
    throw new Error('The signup session changed too many times while it was being updated. Retry the request.');
  }

  return fileStore.update(async db => {
    const current = db.pending[pendingId] || null;
    const outcome = await mutator(current) || {};
    if (!current) return { result: outcome.result };
    if (outcome.delete) delete db.pending[pendingId];
    else if (outcome.value) db.pending[pendingId] = outcome.value;
    return { result: outcome.result };
  });
}
