import test from 'node:test';
import assert from 'node:assert/strict';

import { McpSession } from '../src/modules/ide-codewriter/mcp/session.js';

test('equivalent safe path spellings share the same read authorization', () => {
  const session = new McpSession('transport-1', { userId: 'u', clientId: 'c', clientName: 'client' });
  session.noteRead('workspace-1', 'src\\feature\\app.js', 'rev-1');
  assert.equal(session.lastReadRevision('workspace-1', './src/feature/app.js'), 'rev-1');
  assert.equal(session.hasFreshRead('workspace-1', 'src//feature/app.js', 'rev-1'), true);
});

test('read authorization remains isolated between transport sessions', () => {
  const a = new McpSession('transport-a', { userId: 'u', clientId: 'c', clientName: 'client' });
  const b = new McpSession('transport-b', { userId: 'u', clientId: 'c', clientName: 'client' });
  a.noteRead('workspace-1', 'src/app.js', 'rev-1');
  assert.equal(a.hasFreshRead('workspace-1', 'src/app.js', 'rev-1'), true);
  assert.equal(b.hasFreshRead('workspace-1', 'src/app.js', 'rev-1'), false);
});

test('traversal cannot be used to alias a freshness ledger entry', () => {
  const session = new McpSession('transport-1', { userId: 'u', clientId: 'c', clientName: 'client' });
  assert.throws(() => session.noteRead('workspace-1', 'src/../app.js', 'rev-1'), /escape the workspace root/i);
});
