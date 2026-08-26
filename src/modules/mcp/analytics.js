import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { AppendOnlyLog } from '../../lib/json-store.js';
import { config } from '../../config/config.js';
import { mongoCollection, mongoEnabled } from '../../lib/mongo.js';

const log = new AppendOnlyLog('mcp/transmissions.jsonl');
const SENSITIVE_KEY = /(authorization|token|secret|password|cookie|connectionstring|clientsecret|certificate|privatekey)/i;
const TABLE_KEY = /(table|entity)(logical)?name$/i;
const COLUMN_KEY = /(column|attribute|field)(logical)?name$/i;
const RECORD_KEY = /(record|row|object)(id)?$/i;

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

function redact(value, depth = 0) {
  if (depth > 12) return '[depth limit]';
  if (Array.isArray(value)) return value.slice(0, 250).map(item => redact(item, depth + 1));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && value.length > 4000) return `${value.slice(0, 4000)}…[truncated]`;
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, SENSITIVE_KEY.test(key) ? '[REDACTED]' : redact(child, depth + 1)]));
}

export async function recordTransmission({ connection, tool, requestId, arguments: args, result, error, startedAt }) {
  const requestSummary = summarizePayload(args);
  const responseSummary = summarizePayload(result);
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
    durationMs: Date.now() - startedAt,
    requestBytes: byteLength(args),
    responseBytes: byteLength(result),
    tables: [...new Set([...requestSummary.tables, ...responseSummary.tables])],
    columns: [...new Set([...requestSummary.columns, ...responseSummary.columns])],
    recordIds: [...new Set([...requestSummary.recordIds, ...responseSummary.recordIds])],
    error: error ? String(error.message || error).slice(0, 4000) : null,
    captureMode: connection.captureMode,
    request: connection.captureMode === 'detailed' ? redact(args) : undefined,
    response: connection.captureMode === 'detailed' ? redact(result) : undefined
  };
  if (mongoEnabled()) {
    await (await mongoCollection('mcp_transmissions')).insertOne(entry);
  } else {
    await log.append(entry);
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
      (filters.tenantId && entry.tenantId.toLowerCase() !== String(filters.tenantId).toLowerCase()) ||
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
