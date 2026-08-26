// Signing-key management. QP_SIGNING_SECRET takes precedence. Otherwise a
// 256-bit HMAC key set is generated once and stored in MongoDB when Atlas is
// configured, or in data/keys for local filesystem mode. Keys carry a `kid`
// so verification can continue to recognize rotated keys until tokens expire.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config/config.js';
import { base64UrlDecode, base64UrlEncode } from './crypto.js';
import { mongoCollection, mongoEnabled } from './mongo.js';

const keysDir = path.join(config.dataDir, 'keys');
const keyFile = path.join(keysDir, 'signing-keys.json');

let cache = null;

function loadOrCreateLocal() {
  if (cache) return cache;
  fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(keyFile)) {
    const parsed = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    if (!parsed?.activeKid || !Array.isArray(parsed?.keys) || !parsed.keys.length) {
      throw new Error('Signing key file is corrupt. Restore data/keys/signing-keys.json from backup.');
    }
    cache = parsed;
    return cache;
  }
  const kid = `k${Date.now().toString(36)}`;
  cache = {
    activeKid: kid,
    keys: [{ kid, createdAt: new Date().toISOString(), secret: base64UrlEncode(randomBytes(32)) }]
  };
  const tempPath = `${keyFile}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(cache, null, 2), { mode: 0o600 });
  fs.renameSync(tempPath, keyFile);
  return cache;
}

function signingKeysFromEnvironment() {
  const configured = String(process.env.QP_SIGNING_SECRET || '').trim();
  if (!configured) return null;
  if (configured.length < 32) throw new Error('QP_SIGNING_SECRET must contain at least 32 characters.');
  const secret = createHash('sha256').update(configured, 'utf8').digest();
  const kid = `env-${createHash('sha256').update(secret).digest('hex').slice(0, 16)}`;
  return {
    activeKid: kid,
    keys: [{ kid, createdAt: new Date().toISOString(), secret: base64UrlEncode(secret) }]
  };
}

export async function initializeSigningKeys() {
  if (cache) return cache;
  const fromEnvironment = signingKeysFromEnvironment();
  if (fromEnvironment) {
    cache = fromEnvironment;
    return cache;
  }
  if (!mongoEnabled()) return loadOrCreateLocal();

  const collection = await mongoCollection('server_secrets');
  const existing = await collection.findOne({ _id: 'token-signing-keys' });
  if (existing?.activeKid && Array.isArray(existing.keys) && existing.keys.length) {
    cache = { activeKid: existing.activeKid, keys: existing.keys };
    return cache;
  }

  const kid = `k${Date.now().toString(36)}`;
  const generated = {
    _id: 'token-signing-keys',
    activeKid: kid,
    keys: [{ kid, createdAt: new Date().toISOString(), secret: base64UrlEncode(randomBytes(32)) }]
  };
  try {
    await collection.insertOne(generated);
    cache = { activeKid: generated.activeKid, keys: generated.keys };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const winner = await collection.findOne({ _id: 'token-signing-keys' });
    if (!winner?.activeKid || !Array.isArray(winner.keys) || !winner.keys.length) throw error;
    cache = { activeKid: winner.activeKid, keys: winner.keys };
  }
  return cache;
}

function initializedStore() {
  if (cache) return cache;
  if (mongoEnabled()) {
    throw new Error('MongoDB signing keys are not initialized. Call initializeSigningKeys() before accepting requests.');
  }
  return loadOrCreateLocal();
}

export function activeSigningKey() {
  const store = initializedStore();
  const entry = store.keys.find(key => key.kid === store.activeKid);
  return { kid: entry.kid, secret: base64UrlDecode(entry.secret) };
}

export function signingKeyByKid(kid) {
  const store = initializedStore();
  const entry = store.keys.find(key => key.kid === kid);
  return entry ? { kid: entry.kid, secret: base64UrlDecode(entry.secret) } : null;
}
