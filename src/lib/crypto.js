// Cryptographic primitives built exclusively on node:crypto.
//
// Password hashing: scrypt with per-user random salt, parameters embedded in
// the stored string so costs can be raised later without breaking old hashes.
// Format: scrypt$N$r$p$<salt b64url>$<hash b64url>
import {
  scrypt,
  randomBytes,
  randomInt,
  timingSafeEqual,
  createHmac,
  createHash
} from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config/config.js';

const scryptAsync = promisify(scrypt);

export function base64UrlEncode(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

export function base64UrlDecode(text) {
  return Buffer.from(text, 'base64url');
}

export async function hashPassword(password) {
  const { scryptCost: N, scryptBlockSize: r, scryptParallelization: p, scryptKeyLength } = config.password;
  const salt = randomBytes(16);
  const derived = await scryptAsync(password.normalize('NFKC'), salt, scryptKeyLength, { N, r, p, maxmem: 128 * N * r * 2 });
  return `scrypt$${N}$${r}$${p}$${base64UrlEncode(salt)}$${base64UrlEncode(derived)}`;
}

export async function verifyPassword(password, storedHash) {
  try {
    const [scheme, nRaw, rRaw, pRaw, saltRaw, hashRaw] = String(storedHash || '').split('$');
    if (scheme !== 'scrypt') return false;
    const N = Number.parseInt(nRaw, 10);
    const r = Number.parseInt(rRaw, 10);
    const p = Number.parseInt(pRaw, 10);
    const salt = base64UrlDecode(saltRaw);
    const expected = base64UrlDecode(hashRaw);
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || !salt.length || !expected.length) return false;
    const derived = await scryptAsync(String(password).normalize('NFKC'), salt, expected.length, { N, r, p, maxmem: 128 * N * r * 2 });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// True when the stored hash uses weaker parameters than current config —
// callers rehash transparently on next successful login.
export function passwordNeedsRehash(storedHash) {
  const [scheme, nRaw] = String(storedHash || '').split('$');
  if (scheme !== 'scrypt') return true;
  return Number.parseInt(nRaw, 10) < config.password.scryptCost;
}

export function randomToken(bytes = 32) {
  return base64UrlEncode(randomBytes(bytes));
}

export function randomId(prefix) {
  return `${prefix}_${base64UrlEncode(randomBytes(12))}`;
}

// Numeric verification code with rejection-sampled uniform digits.
export function randomNumericCode(length = 6) {
  let code = '';
  for (let index = 0; index < length; index += 1) code += String(randomInt(0, 10));
  return code;
}

export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacSign(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

export function safeEqual(a, b) {
  const bufferA = Buffer.from(String(a));
  const bufferB = Buffer.from(String(b));
  // Compare same-length digests to keep timingSafeEqual applicable even when
  // lengths differ (length inequality is not secret here).
  const digestA = createHash('sha256').update(bufferA).digest();
  const digestB = createHash('sha256').update(bufferB).digest();
  return timingSafeEqual(digestA, digestB) && bufferA.length === bufferB.length;
}
