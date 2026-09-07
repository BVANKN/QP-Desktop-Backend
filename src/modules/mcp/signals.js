// Notifications only: persisted jobs and leases remain authoritative.
import { randomUUID } from 'node:crypto';
const epoch = randomUUID();
const versions = new Map();
const listeners = new Map();
export function signalVersion(key) { return versions.get(key) || epoch; }
export function notifySignal(key) {
  const version = randomUUID();
  versions.delete(key);
  versions.set(key, version);
  while (versions.size > 10000) versions.delete(versions.keys().next().value);
  for (const done of [...(listeners.get(key) || [])]) done(version);
}
export function waitForSignal(key, after, timeoutMs, signal) {
  if (signal?.aborted || after !== signalVersion(key)) return Promise.resolve(signalVersion(key));
  return new Promise(resolve => {
    let timer;
    const done = version => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const entries = listeners.get(key);
      entries?.delete(done);
      if (!entries?.size) listeners.delete(key);
      resolve(version);
    };
    const abort = () => done(signalVersion(key));
    let entries = listeners.get(key);
    if (!entries) listeners.set(key, entries = new Set());
    // Bound idle connection memory per account/job; callers can retry later.
    if (entries.size >= 32) { resolve(signalVersion(key)); return; }
    entries.add(done);
    timer = setTimeout(() => done(signalVersion(key)), Math.max(1, timeoutMs));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted || after !== signalVersion(key)) abort();
  });
}
