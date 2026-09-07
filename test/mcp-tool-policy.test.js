import test from 'node:test';
import assert from 'node:assert/strict';
import { MCP_TOOLS, MCP_TOOL_BY_NAME } from '../src/modules/mcp/tool-catalog.js';
import { CEILINGS, DEFAULT_POLICY, SUBJECTS, normalizePolicy, subjectFor, summarizePolicy, toolAllowed } from '../src/modules/mcp/tool-policy.js';

// Risk alone could never answer the question people ask before connecting an AI
// client: "can it read my customers?" Reading a table's columns and reading the
// rows in it are both read-only, so a single switch was not a real answer.
test('every tool is classified, and nothing escapes into an unpoliced gap', () => {
  const ids = new Set(SUBJECTS.map(subject => subject.id));
  const counts = {};
  for (const tool of MCP_TOOLS) {
    const subject = subjectFor(tool);
    assert.ok(ids.has(subject), `${tool.name} resolved to unknown subject ${subject}`);
    counts[subject] = (counts[subject] || 0) + 1;
  }
  assert.equal(Object.values(counts).reduce((total, value) => total + value, 0), MCP_TOOLS.length);

  // A tool nobody classified must fail safe as business data, so a connection
  // told it cannot read records does not silently gain a new way to.
  assert.equal(subjectFor({ name: 'some_future_tool_nobody_classified', group: 'power-platform' }), 'data');
});

test('the business-data subject is exactly the tools that reach records', () => {
  const data = MCP_TOOLS.filter(tool => subjectFor(tool) === 'data').map(tool => tool.name);
  for (const name of ['query_records', 'execute_fetchxml', 'create_record', 'update_record', 'delete_record', 'create_records_bulk', 'search_dataverse']) {
    assert.ok(data.includes(name), `${name} reaches records and must be in the data subject`);
  }
  // Audit history carries the old and new values of records, however much it
  // reads like a diagnostic.
  assert.ok(data.includes('get_audit_detail'), 'audit detail exposes record values');
  // Reading how a table is shaped is not reading what is in it.
  for (const name of ['list_tables', 'get_table_schema', 'list_columns']) {
    assert.equal(subjectFor(MCP_TOOL_BY_NAME.get(name)), 'schema', `${name} is schema, not data`);
  }
  // Sharing a record is a security decision, not a data read.
  assert.equal(subjectFor(MCP_TOOL_BY_NAME.get('grant_record_access')), 'security');
});

test('an unset policy changes nothing', () => {
  for (const tool of MCP_TOOLS.slice(0, 40)) {
    assert.equal(toolAllowed(tool, undefined).allowed, true);
    assert.equal(toolAllowed(tool, { enabled: false, subjects: [], ceiling: 'read' }).allowed, true, 'a disabled policy must not restrict');
  }
});

test('subjects and the ceiling compose', () => {
  const readOnly = { enabled: true, subjects: SUBJECTS.map(subject => subject.id), ceiling: 'read' };
  assert.equal(toolAllowed(MCP_TOOL_BY_NAME.get('query_records'), readOnly).allowed, true);
  const blockedWrite = toolAllowed(MCP_TOOL_BY_NAME.get('create_record'), readOnly);
  assert.equal(blockedWrite.allowed, false);
  assert.equal(blockedWrite.reason, 'ceiling');
  assert.match(blockedWrite.detail, /reading only/);

  // "Build apps, never touch customer data" has to be expressible.
  const builder = { enabled: true, subjects: ['schema', 'apps', 'alm'], ceiling: 'write' };
  assert.equal(toolAllowed(MCP_TOOL_BY_NAME.get('create_view'), builder).allowed, true);
  const blockedSubject = toolAllowed(MCP_TOOL_BY_NAME.get('query_records'), builder);
  assert.equal(blockedSubject.allowed, false);
  assert.equal(blockedSubject.reason, 'subject');
  assert.match(blockedSubject.detail, /Business data tools are turned off/);

  // A write ceiling still stops deletes.
  assert.equal(toolAllowed(MCP_TOOL_BY_NAME.get('delete_view'), builder).allowed, false);
  assert.equal(toolAllowed(MCP_TOOL_BY_NAME.get('delete_view'), { ...builder, ceiling: 'destructive' }).allowed, true);
});

test('diagnostics are never withheld', () => {
  const nothing = { enabled: true, subjects: [], ceiling: 'read' };
  for (const name of ['get_power_platform_connection', 'environment_overview', 'get_power_platform_operation']) {
    assert.equal(toolAllowed(MCP_TOOL_BY_NAME.get(name), nothing).allowed, true,
      `${name} must survive, or a client cannot tell a restriction from an outage`);
  }
});

test('a policy is normalized rather than trusted', () => {
  const cleaned = normalizePolicy({ enabled: 'yes', subjects: ['data', 'DATA', 'nonsense', ' schema '], ceiling: 'everything' });
  assert.equal(cleaned.enabled, false, 'only a real boolean enables it');
  assert.deepEqual(cleaned.subjects, ['data', 'schema'], 'unknown subjects are dropped and duplicates collapsed');
  assert.equal(cleaned.ceiling, DEFAULT_POLICY.ceiling, 'an unknown ceiling falls back rather than widening');
  assert.ok(CEILINGS.includes(cleaned.ceiling));
  assert.deepEqual(normalizePolicy(null).subjects, [...DEFAULT_POLICY.subjects]);
  assert.ok(!DEFAULT_POLICY.subjects.includes('data'), 'the default withholds business data');
});

test('a policy can be summarized before it is saved', () => {
  const summary = summarizePolicy(MCP_TOOLS, { enabled: true, subjects: ['schema', 'apps'], ceiling: 'write' });
  assert.equal(summary.totalTools, MCP_TOOLS.length);
  assert.equal(summary.allowedTools + summary.withheldTools, MCP_TOOLS.length);
  assert.ok(summary.allowedTools > 0 && summary.withheldTools > 0);
  const data = summary.subjects.find(subject => subject.id === 'data');
  assert.equal(data.allowed, 0, 'a subject that is off contributes nothing');
  assert.ok(data.total > 0, 'but its size is still reported, so the choice is informed');
});

// A retry is not a theft.
//
// Refresh rotation with reuse detection is right, but the retry window was
// bound to the client's IP address and lasted ten seconds. Hosted MCP clients
// call from a provider's egress pool, so two requests of one session routinely
// arrive from different addresses - and a client that timed out mid-request
// retried well after ten seconds. Both looked like a stolen token, and the
// response to a stolen token is to revoke the whole grant, which ended a live
// task and demanded a fresh sign-in.
test('a refresh retry survives a changed address and a slow retry', async () => {
  const { refreshClientFingerprint, replayVerdict } = await import('../src/lib/refresh-replay.js');
  const now = 1_000;
  const grace = 90;
  const client = ua => refreshClientFingerprint({ ip: 'irrelevant', userAgent: ua, includeIp: false });
  const replay = { previousHash: 'H', fingerprint: client('ChatGPT-User/1.0'), rotatedAt: now };
  const verdict = (options = {}) => replayVerdict(replay, {
    previousHash: 'H',
    fingerprint: options.fingerprint ?? client('ChatGPT-User/1.0'),
    now: now + (options.after ?? 3),
    graceSeconds: grace
  });

  // The address must not decide whether a session lives.
  assert.notEqual(
    refreshClientFingerprint({ ip: '52.230.10.7', userAgent: 'x' }),
    refreshClientFingerprint({ ip: '52.230.10.99', userAgent: 'x' }),
    'with the address included, one egress pool produces two identities'
  );
  assert.equal(
    refreshClientFingerprint({ ip: '52.230.10.7', userAgent: 'x', includeIp: false }),
    refreshClientFingerprint({ ip: '52.230.10.99', userAgent: 'x', includeIp: false }),
    'excluding it, the same client stays the same client'
  );

  assert.equal(verdict(), 'replay', 'an immediate retry is a retry');
  assert.equal(verdict({ after: 12 }), 'replay', 'so is one after twelve seconds');
  assert.equal(verdict({ after: 80 }), 'replay', 'and one after eighty');

  // Refusing costs a round trip; revoking costs the task. They are only
  // interchangeable if you assume every unrecognised retry is an attack.
  assert.equal(verdict({ fingerprint: client('curl/8.4') }), 'unverified-client');
  assert.equal(verdict({ fingerprint: '' }), 'unverified-client');

  // Genuine reuse - a token from further back in the chain, long after its
  // rotation - is still reuse and must still revoke.
  assert.equal(verdict({ after: 200 }), 'outside-window');
  assert.equal(replayVerdict(replay, { previousHash: 'OLDER', fingerprint: client('ChatGPT-User/1.0'), now: now + 3, graceSeconds: grace }), 'unknown');
  assert.equal(replayVerdict(null, { previousHash: 'H', fingerprint: 'f', now, graceSeconds: grace }), 'unknown');
});
