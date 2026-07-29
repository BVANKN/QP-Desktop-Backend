// Minimal signed-token implementation (JWT-compatible, HS256 only).
//
// The algorithm is pinned server-side: the header's `alg` is written by us and
// verified to be exactly HS256 — "alg: none" and key-confusion attacks are
// structurally impossible. Claims carry the user's plan and entitlements, so
// a client cannot grant itself features without breaking the HMAC.
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config/config.js';
import { base64UrlDecode, base64UrlEncode, hmacSign, randomId } from './crypto.js';
import { activeSigningKey, signingKeyByKid } from './key-store.js';

function encodeSegment(value) {
  return base64UrlEncode(Buffer.from(JSON.stringify(value), 'utf8'));
}

export function issueAccessToken({ user, sessionId, entitlements, planId }) {
  const now = Math.floor(Date.now() / 1000);
  const key = activeSigningKey();
  const header = { alg: 'HS256', typ: 'JWT', kid: key.kid };
  const payload = {
    iss: config.token.issuer,
    aud: config.token.audience,
    sub: user.id,
    sid: sessionId,
    jti: randomId('jti'),
    iat: now,
    nbf: now - 5,
    exp: now + config.token.accessTtlSeconds,
    name: user.name,
    username: user.username,
    email: user.email,
    plan: planId,
    entitlements
  };
  const signingInput = `${encodeSegment(header)}.${encodeSegment(payload)}`;
  const signature = base64UrlEncode(hmacSign(key.secret, signingInput));
  return { token: `${signingInput}.${signature}`, expiresAt: payload.exp, payload };
}

export function verifyAccessToken(token) {
  if (typeof token !== 'string' || token.length > 8192) return { valid: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed' };
  let header;
  let payload;
  try {
    header = JSON.parse(base64UrlDecode(parts[0]).toString('utf8'));
    payload = JSON.parse(base64UrlDecode(parts[1]).toString('utf8'));
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (header?.alg !== 'HS256' || header?.typ !== 'JWT') return { valid: false, reason: 'bad_header' };
  const key = signingKeyByKid(header.kid);
  if (!key) return { valid: false, reason: 'unknown_key' };
  const expected = hmacSign(key.secret, `${parts[0]}.${parts[1]}`);
  let provided;
  try {
    provided = base64UrlDecode(parts[2]);
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { valid: false, reason: 'bad_signature' };
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== config.token.issuer || payload.aud !== config.token.audience) return { valid: false, reason: 'bad_claims' };
  if (typeof payload.nbf === 'number' && payload.nbf > now + 30) return { valid: false, reason: 'not_yet_valid' };
  if (typeof payload.exp !== 'number' || payload.exp <= now) return { valid: false, reason: 'expired' };
  return { valid: true, payload };
}
