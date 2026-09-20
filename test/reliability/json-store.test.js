import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qp-store-regression-'));
process.env.QP_BACKEND_DATA_DIR = directory;
const { JsonStore, AppendOnlyLog } = await import('../../src/lib/json-store.js');
after(() => fs.rm(directory, { recursive: true, force: true }));
test('a throwing mutator leaves committed memory and disk unchanged', async () => {
  const store = new JsonStore('rollback.json', { count: 0 });
  await store.update(value => { value.count = 1; });
  await assert.rejects(store.update(value => { value.count = 99; throw new Error('cancel transaction'); }), /cancel transaction/);
  assert.equal((await store.read()).count, 1);
  assert.equal(JSON.parse(await fs.readFile(store.filePath)).count, 1);
  await store.update(value => { value.count++; });
  assert.equal((await store.read()).count, 2, 'a failure must not poison the next transaction');
});
test('read results and retained mutator objects cannot mutate committed state', async () => {
  const store = new JsonStore('isolation.json', { rows: [{ value: 1 }] });
  const first = await store.read(); first.rows[0].value = 50;
  assert.equal((await store.read()).rows[0].value, 1);
  let retained;
  const result = await store.update(value => { retained = value; value.rows[0].value = 2; return { result: value.rows[0] }; });
  retained.rows[0].value = 90; result.value = 100;
  assert.equal((await store.read()).rows[0].value, 2);
});
test('multiple store instances share committed state and serialize concurrent increments', async () => {
  const first = new JsonStore('shared.json', { count: 0 });
  const second = new JsonStore('shared.json', { count: 0 });
  await Promise.all([first.read(), second.read()]);
  await Promise.all(Array.from({ length: 60 }, (_, index) => (index % 2 ? first : second).update(value => { value.count++; })));
  assert.equal((await first.read()).count, 60);
  assert.equal((await second.read()).count, 60);
  assert.equal(JSON.parse(await fs.readFile(first.filePath)).count, 60);
});
test('failed atomic replacement rolls back memory and cleans temporary files', async () => {
  const store = new JsonStore('failure.json', { value: 0 });
  await store.update(value => { value.value = 1; });
  await fs.rename(store.filePath, `${store.filePath}.saved`);
  await fs.mkdir(store.filePath);
  await assert.rejects(store.update(value => { value.value = 2; }));
  assert.equal((await store.read()).value, 1);
  assert.deepEqual((await fs.readdir(directory)).filter(name => name.startsWith('failure.json.') && name.endsWith('.tmp')), []);
  await fs.rmdir(store.filePath); await fs.rename(`${store.filePath}.saved`, store.filePath);
  await store.update(value => { value.value++; });
  assert.equal((await store.read()).value, 2);
});
test('serialization failures cannot leave circular or partial data in the cache', async () => {
  const store = new JsonStore('serialize.json', { value: 1 });
  await assert.rejects(store.update(value => { value.value = 2; value.self = value; }));
  assert.deepEqual(await store.read(), { value: 1 });
});
test('in-memory snapshots have the same JSON representation as persisted state', async () => {
  const store = new JsonStore('canonical.json', {});
  await store.update(() => ({ value: { date: new Date('2026-01-01T00:00:00Z'), absent: undefined, value: NaN } }));
  assert.deepEqual(await store.read(), JSON.parse(await fs.readFile(store.filePath)));
});
test('concurrent audit appends remain individually parseable and complete', async () => {
  const log = new AppendOnlyLog('audit.jsonl');
  await Promise.all(Array.from({ length: 30 }, (_, id) => log.append({ id })));
  const rows = (await fs.readFile(log.filePath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(new Set(rows.map(row => row.id)).size, 30);
});
test('concurrent bounded-log updates are atomic and do not lose entries', async () => {
  const log = new AppendOnlyLog('bounded.jsonl');
  await Promise.all(Array.from({ length: 40 }, (_, id) => log.updateEntries(entries => ({
    entries: [...entries, { id }]
  }))));
  const rows = await log.readEntries();
  assert.equal(rows.length, 40);
  assert.equal(new Set(rows.map(row => row.id)).size, 40);
});
