// In-memory sliding-window rate limiter keyed by caller-chosen dimensions
// (IP, IP+identifier, ...). State is per-process; if this service is ever
// scaled horizontally, move the counters to a shared store — the interface
// stays the same.
import { RateLimitError } from '../errors.js';

const buckets = new Map(); // key -> { count, windowStart }

// Periodic sweep keeps the map bounded even under key-spray attacks.
const SWEEP_INTERVAL_MS = 5 * 60_000;
let sweeper = null;

function ensureSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (now - bucket.windowStart > bucket.windowMs * 2) buckets.delete(key);
    }
  }, SWEEP_INTERVAL_MS);
  sweeper.unref?.();
}

export function consumeRateLimit(name, key, { windowMs, max }) {
  ensureSweeper();
  const bucketKey = `${name}:${key}`;
  const now = Date.now();
  let bucket = buckets.get(bucketKey);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    bucket = { count: 0, windowStart: now, windowMs };
    buckets.set(bucketKey, bucket);
  }
  bucket.count += 1;
  if (bucket.count > max) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.windowStart + windowMs - now) / 1000));
    throw new RateLimitError('Too many requests. Try again later.', retryAfterSeconds);
  }
}

// Test hook.
export function resetRateLimits() {
  buckets.clear();
}
