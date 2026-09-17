// Dependency-free regression entry point; works without shell glob expansion.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const tests = readdirSync(path.join(root, 'test', 'reliability'))
  .filter(name => /\.test\.(?:mjs|js)$/.test(name)).sort()
  .map(name => path.join('test', 'reliability', name));
if (!tests.length) throw new Error('No reliability regression tests were found.');
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=2', ...tests], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
