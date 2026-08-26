import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { activeSigningKey } from './key-store.js';
import { base64UrlDecode, base64UrlEncode, sha256Hex } from './crypto.js';

const VERSION = 'v1';
const AAD = Buffer.from('quicker-portal-refresh-replay-v1', 'utf8');

function encryptionKey() {
  return createHmac('sha256', activeSigningKey().secret)
    .update('quicker-portal:refresh-replay:key:v1', 'utf8')
    .digest();
}

/**
 * A short-lived client fingerprint used only to distinguish a legitimate
 * duplicate refresh request from replay by a different client. It is never
 * exposed and contains no raw IP or user-agent data.
 */
export function refreshClientFingerprint({ ip = '', userAgent = '' } = {}) {
  const normalizedIp = String(ip || '').trim().slice(0, 128);
  const normalizedAgent = String(userAgent || '').trim().slice(0, 512);
  if (!normalizedIp && !normalizedAgent) return '';
  return sha256Hex(`${normalizedIp}\n${normalizedAgent}`);
}

/** Encrypts the already-issued refresh response for a very short retry window. */
export function sealRefreshReplay(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${base64UrlEncode(iv)}.${base64UrlEncode(ciphertext)}.${base64UrlEncode(tag)}`;
}

/** Returns null for malformed/stale-key ciphertext rather than leaking details. */
export function openRefreshReplay(value) {
  try {
    const [version, ivRaw, bodyRaw, tagRaw] = String(value || '').split('.');
    if (version !== VERSION || !ivRaw || !bodyRaw || !tagRaw) return null;
    const iv = base64UrlDecode(ivRaw);
    const body = base64UrlDecode(bodyRaw);
    const tag = base64UrlDecode(tagRaw);
    if (iv.length !== 12 || tag.length !== 16 || body.length > 8192) return null;
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
    const parsed = JSON.parse(plaintext.toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function replayWithinGrace(replay, { previousHash, fingerprint, now, graceSeconds }) {
  if (!replay || !previousHash || !fingerprint) return false;
  if (replay.previousHash !== previousHash || replay.fingerprint !== fingerprint) return false;
  const rotatedAt = Number(replay.rotatedAt);
  return Number.isFinite(rotatedAt) && now >= rotatedAt && now - rotatedAt <= graceSeconds;
}
