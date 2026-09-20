import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { failureDiagnostics } from './failure-diagnostics.js';
import { AppendOnlyLog } from '../../lib/json-store.js';
import { config } from '../../config/config.js';
import { mongoCollection, mongoEnabled } from '../../lib/mongo.js';

const log = new AppendOnlyLog('mcp/transmissions.jsonl');
const SENSITIVE_KEY = /(authorization|token|secret|password|cookie|connectionstring|clientsecret|certificate|privatekey)/i;
const TABLE_KEY = /(table|entity)(logical)?name$/i;
const COLUMN_KEY = /(column|attribute|field)(logical)?name$/i;
const RECORD_KEY = /(record|row|object)(id)?$/i;

export const TRANSMISSION_RETENTION = Object.freeze({
  maxPerEnvironment: 250,
  maxAgeDays: 30
});
const TRANSMISSION_RETENTION_MS = TRANSMISSION_RETENTION.maxAgeDays * 24 * 60 * 60_000;

function byteLength(value) {
  try { return Buffer.byteLength(JSON.stringify(value ?? null)); } catch { return 0; }
}

function walk(value, pathParts, summary, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.slice(0, 500).forEach((item, index) => walk(item, [...pathParts, String(index)], summary, depth + 1));
    return;
  }
  if (typeof value !== 'object') {
    const key = pathParts.at(-1) || '';
    const text = typeof value === 'string' ? value : String(value);
    if (TABLE_KEY.test(key) && text) summary.tables.add(text);
    if (COLUMN_KEY.test(key) && text) summary.columns.add(text);
    if (RECORD_KEY.test(key) && /^[{(]?[0-9a-f-]{32,38}[})]?$/i.test(text)) summary.recordIds.add(text.replace(/[{}()]/g, ''));
    return;
  }
  for (const [key, child] of Object.entries(value)) walk(child, [...pathParts, key], summary, depth + 1);
}

function summarizePayload(value) {
  const summary = { tables: new Set(), columns: new Set(), recordIds: new Set() };
  walk(value, [], summary);
  const inspect = (node, depth = 0) => {
    if (depth > 10 || node === null || node === undefined) return;
    if (Array.isArray(node)) {
      node.slice(0, 500).forEach(item => inspect(item, depth + 1));
      return;
    }
    if (typeof node !== 'object') return;
    if (Array.isArray(node.select)) node.select.forEach(name => typeof name === 'string' && summary.columns.add(name));
    if (node.values && typeof node.values === 'object' && !Array.isArray(node.values)) {
      Object.keys(node.values).forEach(name => summary.columns.add(name.replace(/@odata\.bind$/i, '')));
    }
    for (const [key, child] of Object.entries(node)) {
      if (typeof child === 'string' && /^[{(]?[0-9a-f-]{36}[})]?$/i.test(child) && /id$/i.test(key)) {
        summary.recordIds.add(child.replace(/[{}()]/g, ''));
      }
      if (/fetchxml/i.test(key) && typeof child === 'string') {
        for (const match of child.matchAll(/<(?:entity|link-entity)\b[^>]*\bname=["']([^"']+)["']/gi)) summary.tables.add(match[1]);
        for (const match of child.matchAll(/<attribute\b[^>]*\bname=["']([^"']+)["']/gi)) summary.columns.add(match[1]);
      }
      inspect(child, depth + 1);
    }
  };
  inspect(value);
  return {
    tables: [...summary.tables].slice(0, 100),
    columns: [...summary.columns].slice(0, 250),
    recordIds: [...summary.recordIds].slice(0, 250)
  };
}

export function redact(value, depth = 0) {
  if (depth > 12) return '[depth limit]';
  if (Array.isArray(value)) return value.slice(0, 250).map(item => redact(item, depth + 1));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && /^[\s]*[\[{]/.test(value)) {
      if (value.length > 64_000) return '[serialized document omitted]';
      try { return redact(JSON.parse(value), depth + 1); } catch { return '[unparsed document omitted]'; }
    }
    if (typeof value === 'string' && /^\s*</.test(value)) return '[XML/source document omitted]';
    if (typeof value === 'string' && value.length > 4000) return `${value.slice(0, 4000)}…[truncated]`;
    return value;
  }
  const sensitiveValue = SENSITIVE_KEY.test(String(value.name || value.key || value.logicalName || ''));
  const sourceKeys = /^(clientdata|content|source|formxml|layoutxml|definition|oldtext|newtext|text|certificatebase64)$/i;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    SENSITIVE_KEY.test(key) || (sensitiveValue && /^(value|defaultvalue|currentvalue)$/i.test(key)) ? '[REDACTED]'
      : sourceKeys.test(key) && typeof child === 'string' ? '[source payload omitted from analytics]'
      : redact(child, depth + 1)
  ]));
}

export async function recordTransmission({ connection, tool, requestId, arguments: args, result, error, startedAt, lifecycle = null }) {
  const requestSummary = summarizePayload(args);
  const responseSummary = summarizePayload(result);
  const nowMs = Date.now();
  const createdMs = Number.isFinite(Number(startedAt)) ? Number(startedAt) : nowMs;
  const claimedMs = lifecycle?.claimedAt ? Date.parse(lifecycle.claimedAt) : NaN;
  const completedMs = lifecycle?.completedAt ? Date.parse(lifecycle.completedAt) : nowMs;
  const execution = lifecycle?.execution && typeof lifecycle.execution === 'object'
    ? lifecycle.execution
    : result?._desktopExecution && typeof result._desktopExecution === 'object'
      ? result._desktopExecution
      : null;
  const totalMs = Math.max(0, nowMs - createdMs);
  const queueMs = Number.isFinite(claimedMs) ? Math.max(0, claimedMs - createdMs) : null;
  const desktopMs = Number.isFinite(claimedMs) && Number.isFinite(completedMs) ? Math.max(0, completedMs - claimedMs) : null;
  const handlerMs = Number.isFinite(Number(execution?.handlerMs)) ? Math.max(0, Number(execution.handlerMs)) : null;
  const approvalMs = Number.isFinite(Number(execution?.approvalMs)) ? Math.max(0, Number(execution.approvalMs)) : null;
  const desktopOverheadMs = desktopMs === null ? null : Math.max(0, desktopMs - (handlerMs || 0) - (approvalMs || 0));
  const unclassifiedMs = Math.max(0, totalMs - (queueMs || 0) - (approvalMs || 0) - (handlerMs || 0) - (desktopOverheadMs || 0));
  const entry = {
    id: requestId,
    time: new Date().toISOString(),
    userId: connection.userId,
    tenantId: connection.tenantId,
    tenantKey: String(connection.tenantId || '').toLowerCase(),
    tenantName: connection.tenantName,
    environmentId: connection.environmentId,
    environmentKey: String(connection.environmentId || '').toLowerCase(),
    environmentName: connection.environmentName,
    connectionId: connection.id,
    toolName: tool.name,
    desktopAction: tool.action,
    risk: tool.risk,
    status: error ? 'failed' : 'completed',
    durationMs: totalMs,
    requestBytes: byteLength(args),
    responseBytes: byteLength(result),
    tables: [...new Set([...requestSummary.tables, ...responseSummary.tables])],
    columns: [...new Set([...requestSummary.columns, ...responseSummary.columns])],
    recordIds: [...new Set([...requestSummary.recordIds, ...responseSummary.recordIds])],
    timing: {
      createdAt: new Date(createdMs).toISOString(),
      claimedAt: lifecycle?.claimedAt || null,
      completedAt: lifecycle?.completedAt || null,
      queueMs,
      approvalMs,
      handlerMs,
      desktopMs,
      desktopOverheadMs,
      unclassifiedMs,
      totalMs
    },
    execution: execution ? {
      mode: execution.mode || null,
      verification: execution.verification || null,
      reconcileBeforeRetry: execution.reconcileBeforeRetry === true,
      continueAutonomously: execution.continueAutonomously === true,
      approvalSource: execution.approvalSource || null
    } : undefined,
    desktopClientInstanceId: lifecycle?.clientInstanceId || undefined,
    // Service errors can echo submitted credentials. Keep classification for
    // analytics; the original actionable error is returned to the caller only.
    error: error ? `Operation failed (${String(error.code || 'EXECUTION_ERROR').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80)}). Inspect the caller response for details.` : null,
    captureMode: connection.captureMode,
    diagnostics: error ? failureDiagnostics(error, result) : undefined,
    request: connection.captureMode === 'detailed' ? redact(args) : undefined,
    response: connection.captureMode === 'detailed' ? redact(result) : undefined,
    retentionAt: new Date(nowMs + TRANSMISSION_RETENTION_MS)
  };
  if (mongoEnabled()) {
    const collection = await mongoCollection('mcp_transmissions');
    await collection.insertOne(entry);
    await collection.deleteMany({
      userId: entry.userId,
      tenantKey: entry.tenantKey,
      environmentKey: entry.environmentKey,
      time: { $lt: new Date(nowMs - TRANSMISSION_RETENTION_MS).toISOString() }
    });
    const overflow = await collection.find({ userId: entry.userId, tenantKey: entry.tenantKey, environmentKey: entry.environmentKey })
      .sort({ time: -1 }).skip(TRANSMISSION_RETENTION.maxPerEnvironment).project({ _id: 1 }).toArray();
    if (overflow.length) await collection.deleteMany({ _id: { $in: overflow.map(item => item._id) } });
  } else {
    const cutoff = nowMs - TRANSMISSION_RETENTION_MS;
    await log.updateEntries(entries => {
      const all = [...entries, entry];
      const scoped = all.filter(item => item.userId === entry.userId
        && String(item.tenantId || '').toLowerCase() === entry.tenantKey
        && String(item.environmentId || '').toLowerCase() === entry.environmentKey);
      const keepEntries = new Set(scoped
        .filter(item => Date.parse(item.time || 0) >= cutoff)
        .sort((a, b) => Date.parse(b.time || 0) - Date.parse(a.time || 0))
        .slice(0, TRANSMISSION_RETENTION.maxPerEnvironment));
      const retained = all.filter(item => {
        if (Date.parse(item.time || 0) < cutoff) return false;
        const sameScope = item.userId === entry.userId
          && String(item.tenantId || '').toLowerCase() === entry.tenantKey
          && String(item.environmentId || '').toLowerCase() === entry.environmentKey;
        return !sameScope || keepEntries.has(item);
      });
      return { entries: retained };
    });
  }
  return entry;
}

async function queryMongoTransmissionAnalytics(userId, filters = {}) {
  const collection = await mongoCollection('mcp_transmissions');
  const limit = Math.min(Math.max(Number(filters.limit) || 200, 1), 1000);
  const transmissionId = String(filters.transmissionId || '').trim();
  const includePayloads = filters.includePayloads === true || filters.includePayloads === 'true';
  const sinceMs = filters.since ? Date.parse(filters.since) : 0;
  const match = { userId };
  if (filters.tenantId) match.tenantKey = String(filters.tenantId).toLowerCase();
  if (filters.environmentId) match.environmentKey = String(filters.environmentId).toLowerCase();
  if (filters.toolName) match.toolName = filters.toolName;
  if (transmissionId) match.id = transmissionId;
  if (sinceMs) match.time = { $gte: new Date(sinceMs).toISOString() };

  const [summaryRows, byTool, byTable, transmissions, tables, columns, records] = await Promise.all([
    collection.aggregate([
      { $match: match },
      { $group: {
        _id: null,
        totalCalls: { $sum: 1 },
        successfulCalls: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
        failedCalls: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
        requestBytes: { $sum: { $ifNull: ['$requestBytes', 0] } },
        responseBytes: { $sum: { $ifNull: ['$responseBytes', 0] } }
      } }
    ]).toArray(),
    collection.aggregate([
      { $match: match },
      { $group: {
        _id: '$toolName',
        calls: { $sum: 1 },
        failures: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
        requestBytes: { $sum: { $ifNull: ['$requestBytes', 0] } },
        responseBytes: { $sum: { $ifNull: ['$responseBytes', 0] } }
      } },
      { $sort: { calls: -1 } }
    ]).toArray(),
    collection.aggregate([
      { $match: match },
      { $unwind: '$tables' },
      { $group: {
        _id: '$tables',
        transmissions: { $sum: 1 },
        columns: { $addToSet: '$columns' },
        recordIds: { $addToSet: '$recordIds' }
      } },
      { $sort: { transmissions: -1 } }
    ]).toArray(),
    collection.find(match, includePayloads ? {} : { projection: { request: 0, response: 0, _id: 0 } })
      .sort({ time: -1 }).limit(limit).toArray(),
    collection.distinct('tables', match),
    collection.distinct('columns', match),
    collection.distinct('recordIds', match)
  ]);

  const baseRow = summaryRows[0] || { totalCalls: 0, successfulCalls: 0, failedCalls: 0, requestBytes: 0, responseBytes: 0 };
  const { _id: ignoredSummaryId, ...base } = baseRow;
  return {
    summary: {
      ...base,
      tablesTouched: tables.length,
      columnsTouched: columns.length,
      recordsTouched: records.length
    },
    byTool: byTool.map(row => ({ name: row._id, calls: row.calls, failures: row.failures, requestBytes: row.requestBytes, responseBytes: row.responseBytes })),
    byTable: byTable.map(row => ({
      name: row._id,
      transmissions: row.transmissions,
      columns: [...new Set((row.columns || []).flat())],
      recordIds: [...new Set((row.recordIds || []).flat())]
    })),
    transmissions: transmissions.map(({ _id, ...entry }) => entry)
  };
}

export async function queryTransmissionAnalytics(userId, filters = {}) {
  if (mongoEnabled()) return queryMongoTransmissionAnalytics(userId, filters);
  const limit = Math.min(Math.max(Number(filters.limit) || 200, 1), 1000);
  const transmissionId = String(filters.transmissionId || '').trim();
  const includePayloads = filters.includePayloads === true || filters.includePayloads === 'true';
  const sinceMs = filters.since ? Date.parse(filters.since) : 0;
  const filePath = path.join(config.dataDir, 'mcp/transmissions.jsonl');
  try { await fsp.access(filePath); } catch (error) {
    if (error.code === 'ENOENT') return emptyAnalytics();
    throw error;
  }
  const selected = [];
  const byTool = new Map();
  const byTable = new Map();
  const summary = { totalCalls: 0, successfulCalls: 0, failedCalls: 0, requestBytes: 0, responseBytes: 0, tables: new Set(), columns: new Set(), records: new Set() };
  const lines = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.userId !== userId ||
      (filters.tenantId && String(entry.tenantId || '').toLowerCase() !== String(filters.tenantId).toLowerCase()) ||
      (filters.environmentId && String(entry.environmentId).toLowerCase() !== String(filters.environmentId).toLowerCase()) ||
      (filters.toolName && entry.toolName !== filters.toolName) ||
      (transmissionId && entry.id !== transmissionId) ||
      (sinceMs && Date.parse(entry.time) < sinceMs)) continue;
    summary.totalCalls += 1;
    summary.successfulCalls += entry.status === 'completed' ? 1 : 0;
    summary.failedCalls += entry.status === 'failed' ? 1 : 0;
    summary.requestBytes += entry.requestBytes || 0;
    summary.responseBytes += entry.responseBytes || 0;
    (entry.tables || []).forEach(value => summary.tables.add(value));
    (entry.columns || []).forEach(value => summary.columns.add(value));
    (entry.recordIds || []).forEach(value => summary.records.add(value));
    selected.push(includePayloads ? entry : { ...entry, request: undefined, response: undefined });
    if (selected.length > limit) selected.shift();
    const tool = byTool.get(entry.toolName) || { name: entry.toolName, calls: 0, failures: 0, requestBytes: 0, responseBytes: 0 };
    tool.calls += 1;
    tool.failures += entry.status === 'failed' ? 1 : 0;
    tool.requestBytes += entry.requestBytes || 0;
    tool.responseBytes += entry.responseBytes || 0;
    byTool.set(entry.toolName, tool);
    for (const tableName of entry.tables || []) {
      const table = byTable.get(tableName) || { name: tableName, transmissions: 0, columns: new Set(), records: new Set() };
      table.transmissions += 1;
      (entry.columns || []).forEach(column => table.columns.add(column));
      (entry.recordIds || []).forEach(id => table.records.add(id));
      byTable.set(tableName, table);
    }
  }
  return {
    summary: {
      totalCalls: summary.totalCalls,
      successfulCalls: summary.successfulCalls,
      failedCalls: summary.failedCalls,
      requestBytes: summary.requestBytes,
      responseBytes: summary.responseBytes,
      tablesTouched: summary.tables.size,
      columnsTouched: summary.columns.size,
      recordsTouched: summary.records.size
    },
    byTool: [...byTool.values()].sort((a, b) => b.calls - a.calls),
    byTable: [...byTable.values()].map(item => ({ ...item, columns: [...item.columns], recordIds: [...item.records] })).sort((a, b) => b.transmissions - a.transmissions),
    transmissions: selected.reverse()
  };
}

function emptyAnalytics() {
  return {
    summary: { totalCalls: 0, successfulCalls: 0, failedCalls: 0, requestBytes: 0, responseBytes: 0, tablesTouched: 0, columnsTouched: 0, recordsTouched: 0 },
    byTool: [],
    byTable: [],
    transmissions: []
  };
}

function analyticsMatchEntry(entry, userId, filters = {}) {
  return entry.userId === userId
    && (!filters.tenantId || String(entry.tenantId || '').toLowerCase() === String(filters.tenantId).toLowerCase())
    && (!filters.environmentId || String(entry.environmentId || '').toLowerCase() === String(filters.environmentId).toLowerCase())
    && (!filters.toolName || entry.toolName === filters.toolName);
}

export async function clearTransmissionAnalytics(userId, filters = {}) {
  if (mongoEnabled()) {
    const match = { userId };
    if (filters.tenantId) match.tenantKey = String(filters.tenantId).toLowerCase();
    if (filters.environmentId) match.environmentKey = String(filters.environmentId).toLowerCase();
    if (filters.toolName) match.toolName = filters.toolName;
    const result = await (await mongoCollection('mcp_transmissions')).deleteMany(match);
    return { deleted: result.deletedCount || 0 };
  }
  return log.updateEntries(entries => {
    const retained = entries.filter(entry => !analyticsMatchEntry(entry, userId, filters));
    return { entries: retained, result: { deleted: entries.length - retained.length } };
  });
}

function percentile(values, fraction) {
  const ordered = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!ordered.length) return null;
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1))];
}

function timingSummary(rows, key) {
  const values = rows.map(row => row?.timing?.[key]).filter(value => value !== null && value !== undefined).map(Number).filter(Number.isFinite);
  if (!values.length) return { count: 0, averageMs: null, p50Ms: null, p95Ms: null, maxMs: null };
  return {
    count: values.length,
    averageMs: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
    p50Ms: percentile(values, 0.50),
    p95Ms: percentile(values, 0.95),
    maxMs: Math.max(...values)
  };
}

function bottleneckFor(entry) {
  const timing = entry?.timing || {};
  const total = Number(timing.totalMs ?? entry?.durationMs) || 0;
  const queue = Number(timing.queueMs) || 0;
  const approval = Number(timing.approvalMs) || 0;
  const handler = Number(timing.handlerMs) || 0;
  const desktopOverhead = Number(timing.desktopOverheadMs) || 0;
  if (entry?.status === 'failed' && handler <= 50) return 'contract_or_local_validation';
  if (queue >= 2000 && queue >= handler) return 'bridge_queue';
  if (approval >= 2000 && approval >= handler) return 'approval_wait';
  if (handler >= 2000 && handler >= Math.max(queue, approval, desktopOverhead)) return 'desktop_handler_or_dataverse';
  if (desktopOverhead >= 2000) return 'desktop_or_result_transport';
  if (total >= 2000) return 'unclassified_or_client_roundtrip';
  return 'healthy_or_small';
}

export async function buildTransmissionDiagnosticReport(userId, filters = {}, runtime = {}) {
  const analytics = await queryTransmissionAnalytics(userId, {
    ...filters,
    includePayloads: true,
    limit: TRANSMISSION_RETENTION.maxPerEnvironment
  });
  const transmissions = analytics.transmissions || [];
  const chronological = [...transmissions].sort((a, b) => Date.parse(a?.timing?.createdAt || a.time || 0) - Date.parse(b?.timing?.createdAt || b.time || 0));
  const interCallGapById = new Map();
  let previous = null;
  for (const row of chronological) {
    if (previous) {
      const currentCreated = Date.parse(row?.timing?.createdAt || row.time || 0);
      const previousCompleted = Date.parse(previous?.timing?.completedAt || previous.time || 0);
      if (Number.isFinite(currentCreated) && Number.isFinite(previousCompleted)) interCallGapById.set(row.id, Math.max(0, currentCreated - previousCompleted));
    }
    previous = row;
  }
  const transmissionsWithGaps = transmissions.map(row => ({ ...row, interCallGapMs: interCallGapById.get(row.id) ?? null }));
  const bottlenecks = {};
  for (const row of transmissionsWithGaps) {
    const name = bottleneckFor(row);
    bottlenecks[name] = (bottlenecks[name] || 0) + 1;
  }
  const slowest = [...transmissionsWithGaps]
    .sort((a, b) => (Number(b.durationMs) || 0) - (Number(a.durationMs) || 0))
    .slice(0, 25)
    .map(row => ({ id: row.id, time: row.time, toolName: row.toolName, desktopAction: row.desktopAction, status: row.status, durationMs: row.durationMs, timing: row.timing, bottleneck: bottleneckFor(row) }));
  const reportPayloadBudgetBytes = 24 * 1024 * 1024;
  let reportPayloadBytes = 0;
  let payloadsOmitted = 0;
  const reportTransmissions = transmissionsWithGaps.map(row => {
    const payloadBytes = byteLength(row.request) + byteLength(row.response);
    if (reportPayloadBytes + payloadBytes <= reportPayloadBudgetBytes) {
      reportPayloadBytes += payloadBytes;
      return row;
    }
    payloadsOmitted += 1;
    return { ...row, request: row.request === undefined ? undefined : '[omitted from exported report: payload budget reached]', response: row.response === undefined ? undefined : '[omitted from exported report: payload budget reached]', reportPayloadOmitted: true };
  });
  return {
    format: 'quicker-portal-mcp-transmission-diagnostics-v1',
    generatedAt: new Date().toISOString(),
    scope: { tenantId: filters.tenantId || '', environmentId: filters.environmentId || '', toolName: filters.toolName || '' },
    retention: TRANSMISSION_RETENTION,
    exportLimits: { reportPayloadBudgetBytes, reportPayloadBytes, payloadsOmitted },
    runtime,
    summary: analytics.summary,
    byTool: analytics.byTool,
    byTable: analytics.byTable,
    performance: {
      total: timingSummary(transmissions, 'totalMs'),
      queue: timingSummary(transmissions, 'queueMs'),
      approval: timingSummary(transmissions, 'approvalMs'),
      handler: timingSummary(transmissions, 'handlerMs'),
      desktop: timingSummary(transmissions, 'desktopMs'),
      desktopOverhead: timingSummary(transmissions, 'desktopOverheadMs'),
      unclassified: timingSummary(transmissions, 'unclassifiedMs'),
      interCallGap: (() => {
        const values = transmissionsWithGaps.map(row => row.interCallGapMs).filter(value => value !== null && value !== undefined).map(Number).filter(Number.isFinite);
        if (!values.length) return { count: 0, averageMs: null, p50Ms: null, p95Ms: null, maxMs: null, over5Seconds: 0 };
        return { count: values.length, averageMs: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length), p50Ms: percentile(values, 0.50), p95Ms: percentile(values, 0.95), maxMs: Math.max(...values), over5Seconds: values.filter(value => value >= 5000).length };
      })(),
      bottlenecks,
      slowest
    },
    timingDefinitions: {
      queueMs: 'Job creation until the desktop claims the job. Large values point to bridge/wake/claim latency.',
      approvalMs: 'Time spent resolving desktop approval. Session auto-approval should be near zero.',
      handlerMs: 'Time inside the actual Quicker Portal desktop tool handler, including Dataverse work performed by that handler.',
      desktopMs: 'Desktop claim until the backend receives completion.',
      desktopOverheadMs: 'Desktop time not explained by approval or handler execution; includes local orchestration and result upload.',
      unclassifiedMs: 'Remaining end-to-end time outside measured queue/approval/handler/desktop-overhead segments.',
      totalMs: 'End-to-end time from MCP job creation until completion analytics are recorded.',
      interCallGapMs: 'Time from the previous transmission completing until this transmission was created. Large values can expose AI/client reasoning or tool-selection delay between otherwise healthy MCP calls.'
    },
    transmissions: reportTransmissions
  };
}
