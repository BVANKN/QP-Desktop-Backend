import test from 'node:test';
import assert from 'node:assert/strict';

import { McpSession, SessionRegistry } from '../src/modules/ide-codewriter/mcp/session.js';

test('equivalent safe path spellings share the same read authorization', () => {
  const session = new McpSession('transport-1', { userId: 'u', clientId: 'c', clientName: 'client' });
  session.noteRead('workspace-1', 'src\\feature\\app.js', 'rev-1');
  assert.equal(session.lastReadRevision('workspace-1', './src/feature/app.js'), 'rev-1');
  assert.equal(session.hasFreshRead('workspace-1', 'src//feature/app.js', 'rev-1'), true);
});

test('authenticated client read authorization survives transport replacement', () => {
  const registry = new SessionRegistry();
  try {
    const identity = { userId: 'u', clientId: 'chatgpt-client', clientName: 'ChatGPT' };
    const first = registry.get('transport-a', identity);
    first.noteRead('workspace-1', 'src/app.js', 'rev-1');
    registry.drop('transport-a');
    const second = registry.get('transport-b', identity);
    assert.equal(second.hasFreshRead('workspace-1', 'src/app.js', 'rev-1'), true);
  } finally {
    registry.stop();
  }
});

test('read authorization remains isolated between OAuth clients and users', () => {
  const registry = new SessionRegistry();
  try {
    const source = registry.get('transport-a', { userId: 'u', clientId: 'client-a', clientName: 'A' });
    source.noteRead('workspace-1', 'src/app.js', 'rev-1');
    assert.equal(registry.get('transport-b', { userId: 'u', clientId: 'client-b', clientName: 'B' }).hasFreshRead('workspace-1', 'src/app.js', 'rev-1'), false);
    assert.equal(registry.get('transport-c', { userId: 'other-user', clientId: 'client-a', clientName: 'A' }).hasFreshRead('workspace-1', 'src/app.js', 'rev-1'), false);
  } finally {
    registry.stop();
  }
});

test('traversal cannot be used to alias a freshness ledger entry', () => {
  const session = new McpSession('transport-1', { userId: 'u', clientId: 'c', clientName: 'client' });
  assert.throws(() => session.noteRead('workspace-1', 'src/../app.js', 'rev-1'), /escape the workspace root/i);
});
