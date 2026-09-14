import test from 'node:test';
import assert from 'node:assert/strict';
import { MCP_TOOL_BY_NAME } from '../src/modules/mcp/tool-catalog.js';
import { validateSchema } from '../src/modules/mcp/schema-validator.js';

const tool = MCP_TOOL_BY_NAME.get('choose_plugin_artifact');
test('artifact picker exposes desktop path hints and explicit file consent', () => {
  assert.equal(tool.action, 'selectPluginArtifact');
  assert.equal(tool.risk, 'write');
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.timeoutMs, 120_000);
  for (const args of [
    { mode: 'register' },
    { mode: 'register', defaultPath: '/Users/example/Project/bin/Release', selectionMode: 'picker' },
    { mode: 'update', defaultPath: 'C:\\Project\\bin\\Release\\Plugin.dll', selectionMode: 'confirm' }
  ]) assert.deepEqual(validateSchema(tool.inputSchema, args), []);
  assert.match(tool.description, /hands-free/);
  assert.match(tool.description, /does not register or upload/);
});

test('MCP cannot request automatic file access or confirmation without a path', () => {
  for (const args of [
    { mode: 'register', selectionMode: 'confirm' },
    { mode: 'register', selectionMode: 'automatic' },
    { mode: 'register', defaultPath: 'a'.repeat(1025) },
    { mode: 'register', defaultPath: '' },
    { mode: 'register', approved: true },
    { mode: 'register', autoApprove: true }
  ]) assert.ok(validateSchema(tool.inputSchema, args).length);
});
