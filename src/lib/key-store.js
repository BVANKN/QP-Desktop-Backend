// Signing-key management. A 256-bit HMAC key is generated on first boot and
// persisted under data/keys with owner-only permissions. Keys carry a `kid`
// so rotation is possible: new tokens sign with the active key, verification
// accepts any listed key until old tokens expire.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../config/config.js';
import { base64UrlDecode, base64UrlEncode } from './crypto.js';

const keysDir = path.join(config.dataDir, 'keys');
const keyFile = path.join(keysDir, 'signing-keys.json');

let cache = null;

function loadOrCreate() {
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

export function activeSigningKey() {
  const store = loadOrCreate();
  const entry = store.keys.find(key => key.kid === store.activeKid);
  return { kid: entry.kid, secret: base64UrlDecode(entry.secret) };
}

export function signingKeyByKid(kid) {
  const store = loadOrCreate();
  const entry = store.keys.find(key => key.kid === kid);
  return entry ? { kid: entry.kid, secret: base64UrlDecode(entry.secret) } : null;
}
