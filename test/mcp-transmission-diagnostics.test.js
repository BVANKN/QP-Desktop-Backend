import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qp-mcp-diagnostics-'));
process.env.QP_BACKEND_DATA_DIR = directory;
process.env.MONGODB_URI = '';

const {
  buildTransmissionDiagnosticReport,
  clearTransmissionAnalytics,
  queryTransmissionAnalytics,
  recordTransmission,
  TRANSMISSION_RETENTION
} = await import('../src/modules/mcp/analytics.js');

after(() => fs.rm(directory, { recursive: true, force: true }));

function connection(environmentId = 'env-1') {
  return {
    id: `connection-${environmentId}`,
    userId: 'user-1',
    tenantId: 'tenant-1',
    tenantName: 'Tenant',
    environmentId,
    environmentName: environmentId,
    captureMode: 'detailed'
  };
}

test('transmission diagnostics retain sanitized payload and execution timing', async () => {
  const startedAt = Date.now() - 240;
  await recordTransmission({
    connection: connection(),
    tool: { name: 'update_record', action: 'mcpUpdateRecord', risk: 'write' },
    requestId: 'tx-1',
    arguments: { tableLogicalName: 'account', password: 'never-store-this', values: { name: 'Example' } },
    result: { ok: true, id: '11111111-1111-1111-1111-111111111111' },
    startedAt,
    lifecycle: {
      claimedAt: new Date(startedAt + 40).toISOString(),
      completedAt: new Date(startedAt + 220).toISOString(),
      clientInstanceId: 'desktop-1',
      execution: { mode: 'verified', verification: 'proven', handlerMs: 120, approvalMs: 30, approvalSource: 'session_grant' }
    }
  });

  const analytics = await queryTransmissionAnalytics('user-1', { tenantId: 'tenant-1', environmentId: 'env-1', includePayloads: true });
  assert.equal(analytics.summary.totalCalls, 1);
  assert.equal(analytics.transmissions[0].request.password, '[REDACTED]');
  assert.equal(analytics.transmissions[0].timing.queueMs, 40);
  assert.equal(analytics.transmissions[0].timing.approvalMs, 30);
  assert.equal(analytics.transmissions[0].execution.mode, 'verified');

  const report = await buildTransmissionDiagnosticReport('user-1', { tenantId: 'tenant-1', environmentId: 'env-1' }, { backend: { version: 'test' } });
  assert.equal(report.format, 'quicker-portal-mcp-transmission-diagnostics-v1');
  assert.deepEqual(report.retention, TRANSMISSION_RETENTION);
  assert.equal(report.performance.approval.count, 1);
  assert.equal(report.transmissions[0].request.password, '[REDACTED]');
});

test('clearing one environment preserves transmission history in another', async () => {
  const now = Date.now();
  await recordTransmission({
    connection: connection('env-2'),
    tool: { name: 'list_tables', action: 'tables', risk: 'read' },
    requestId: 'tx-2',
    arguments: {},
    result: { ok: true },
    startedAt: now,
    lifecycle: { claimedAt: new Date(now).toISOString(), completedAt: new Date(now).toISOString() }
  });

  const cleared = await clearTransmissionAnalytics('user-1', { tenantId: 'tenant-1', environmentId: 'env-1' });
  assert.equal(cleared.deleted, 1);
  assert.equal((await queryTransmissionAnalytics('user-1', { environmentId: 'env-1' })).summary.totalCalls, 0);
  assert.equal((await queryTransmissionAnalytics('user-1', { environmentId: 'env-2' })).summary.totalCalls, 1);
});

test('filesystem retention keeps exactly the newest bounded environment history', async () => {
  const base = Date.now() - 10_000;
  const rows = Array.from({ length: TRANSMISSION_RETENTION.maxPerEnvironment + 5 }, (_, index) => ({
    id: `seed-${index}`,
    time: new Date(base + index).toISOString(),
    userId: 'user-1',
    tenantId: 'tenant-1',
    environmentId: 'env-cap',
    toolName: 'list_tables',
    status: 'completed',
    tables: [],
    columns: [],
    recordIds: []
  }));
  const logPath = path.join(directory, 'mcp', 'transmissions.jsonl');
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);

  await recordTransmission({
    connection: connection('env-cap'),
    tool: { name: 'list_tables', action: 'tables', risk: 'read' },
    requestId: 'newest',
    arguments: {},
    result: { ok: true },
    startedAt: Date.now()
  });

  const analytics = await queryTransmissionAnalytics('user-1', { environmentId: 'env-cap', limit: 1000 });
  assert.equal(analytics.summary.totalCalls, TRANSMISSION_RETENTION.maxPerEnvironment);
  assert.equal(analytics.transmissions[0].id, 'newest');
  assert.equal(analytics.transmissions.some(row => row.id === 'seed-0'), false);
});
