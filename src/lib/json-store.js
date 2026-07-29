// Crash-safe JSON persistence.
//
// Every store is a single JSON document on disk. Writes go to a temp file,
// fsync, then atomic rename — a crash mid-write can never corrupt the live
// file. A per-store promise chain serializes mutations so concurrent request
// handlers cannot interleave read-modify-write cycles.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/config.js';

const mutations = new Map(); // storePath -> tail of promise chain

function withStoreLock(storePath, task) {
  const tail = mutations.get(storePath) || Promise.resolve();
  const next = tail.then(task, task);
  // Keep the chain alive but don't let one failure poison later writers.
  mutations.set(storePath, next.catch(() => {}));
  return next;
}

async function atomicWrite(filePath, data) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fsp.open(tempPath, 'w', 0o600);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tempPath, filePath);
}

export class JsonStore {
  constructor(relativePath, defaultValue) {
    this.filePath = path.join(config.dataDir, relativePath);
    this.defaultValue = defaultValue;
    this.cache = undefined;
  }

  async read() {
    if (this.cache !== undefined) return this.cache;
    try {
      this.cache = JSON.parse(await fsp.readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.cache = structuredClone(this.defaultValue);
    }
    return this.cache;
  }

  // mutator receives the current document and returns { value?, result? }.
  // The (possibly replaced) document is persisted atomically before resolve.
  async update(mutator) {
    return withStoreLock(this.filePath, async () => {
      const current = await this.read();
      const outcome = await mutator(current) || {};
      const nextValue = 'value' in outcome ? outcome.value : current;
      await atomicWrite(this.filePath, JSON.stringify(nextValue, null, 2));
      this.cache = nextValue;
      return outcome.result;
    });
  }
}

// Append-only JSON-lines file (audit trail). Appends are serialized and
// fsynced; the file is never rewritten.
export class AppendOnlyLog {
  constructor(relativePath) {
    this.filePath = path.join(config.dataDir, relativePath);
  }

  async append(entry) {
    const line = `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`;
    await withStoreLock(this.filePath, async () => {
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const handle = await fsp.open(this.filePath, 'a', 0o600);
      try {
        await handle.writeFile(line, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
  }
}

export function ensureDataDir() {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
}
