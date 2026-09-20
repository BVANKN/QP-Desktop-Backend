// Single-process JSON persistence with isolated committed snapshots.
//
// Writes fsync a temporary file before replacing the live document by rename.
// A per-file promise chain serializes this process's read-modify-write cycles.
// This is not a cross-process database transaction or a guarantee against all
// filesystem/power-loss scenarios; multi-worker production uses MongoDB.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config/config.js';

const mutations = new Map(); // filePath -> settled tail of promise chain
const documents = new Map(); // one committed snapshot per file, across instances

function withStoreLock(storePath, task) {
  const previous = mutations.get(storePath) || Promise.resolve();
  const next = previous.then(task, task);
  const tail = next.then(() => {}, () => {});
  mutations.set(storePath, tail);
  void tail.then(() => {
    if (mutations.get(storePath) === tail) mutations.delete(storePath);
  });
  return next;
}

async function atomicWrite(filePath, data) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fsp.open(tempPath, 'wx', 0o600);
    await handle.writeFile(data, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(tempPath, filePath);
  } finally {
    // Do not replace the original write/rename error with a cleanup error.
    if (handle) await handle.close().catch(() => {});
    await fsp.unlink(tempPath).catch(() => {});
  }
}

export class JsonStore {
  constructor(relativePath, defaultValue) {
    this.filePath = path.resolve(config.dataDir, relativePath);
    this.defaultValue = structuredClone(defaultValue);
    if (!documents.has(this.filePath)) documents.set(this.filePath, { loaded: false, value: undefined, loading: null });
    this.state = documents.get(this.filePath);
  }

  async read() {
    const state = this.state;
    if (!state.loaded) {
      state.loading ||= (async () => {
        let value;
        try {
          value = JSON.parse(await fsp.readFile(this.filePath, 'utf8'));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          value = structuredClone(this.defaultValue);
        }
        state.value = value;
        state.loaded = true;
      })().finally(() => { state.loading = null; });
      await state.loading;
    }
    // Readers may edit their snapshot, but persistence always requires update().
    return structuredClone(state.value);
  }

  // Mutators edit a private working document. Publish only AFTER atomic rename
  // succeeds, so exceptions never leak uncommitted edits into other requests.
  async update(mutator) {
    return withStoreLock(this.filePath, async () => {
      const current = await this.read();
      const outcome = await mutator(current) || {};
      const nextValue = 'value' in outcome ? outcome.value : current;
      const serialized = JSON.stringify(nextValue, null, 2);
      if (serialized === undefined) throw new TypeError('A JSON store document must be JSON-serializable.');
      // Canonicalize before writing, and keep retained mutator/result references
      // separate from the committed cache. Memory and a restart now agree.
      const committed = JSON.parse(serialized);
      await atomicWrite(this.filePath, serialized);
      this.state.value = committed;
      this.state.loaded = true;
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

  // Bounded histories occasionally need a read/modify/rewrite transaction.
  // Keep the complete operation under the same lock as append() so a
  // concurrent MCP completion cannot be overwritten by retention or clearing.
  async updateEntries(mutator) {
    return withStoreLock(this.filePath, async () => {
      let source = '';
      try { source = await fsp.readFile(this.filePath, 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const current = source.split(/\r?\n/).filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      const outcome = await mutator(structuredClone(current)) || {};
      const entries = Array.isArray(outcome) ? outcome : outcome.entries ?? current;
      if (!Array.isArray(entries)) throw new TypeError('An append-only log update must return an entries array.');
      const body = entries.map(entry => JSON.stringify(entry)).join('\n');
      await atomicWrite(this.filePath, body ? `${body}\n` : '');
      return Array.isArray(outcome) ? entries.length : outcome.result;
    });
  }

  async readEntries() {
    return withStoreLock(this.filePath, async () => {
      let source;
      try { source = await fsp.readFile(this.filePath, 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      return source.split(/\r?\n/).filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
    });
  }

  async replaceEntries(entries) {
    return this.updateEntries(() => ({ entries: entries || [], result: entries?.length || 0 }));
  }
}

export function ensureDataDir() {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
}
