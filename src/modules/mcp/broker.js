import { JsonStore } from '../../lib/json-store.js';
import { randomId, randomToken, safeEqual, sha256Hex } from '../../lib/crypto.js';
import { mongoCollection, mongoEnabled } from '../../lib/mongo.js';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import { recordTransmission } from './analytics.js';
import { logger } from '../../core/logger.js';
import { notifySignal, signalVersion, waitForSignal } from './signals.js';

const store = new JsonStore('mcp/jobs.json', { version: 1, jobs: [] });
const desktopHeartbeats = new Map();
const claimsInFlight = new Map();

function claimedEnvelope(job, leaseToken) {
  return { id: job.id, userId: job.userId, tenantId: job.tenantId, environmentId: job.environmentId, requestId: job.requestId, toolName: job.toolName, action: job.action, risk: job.risk, arguments: job.arguments, createdAt: job.createdAt, expiresAt: job.expiresAt, leaseToken };
}

const JOB_RETENTION_MS = 24 * 60 * 60_000;
// The lease must outlive the longest 120s desktop action plus result-upload
// latency. Otherwise a healthy long PAC/Dataverse call can be re-queued while
// the first desktop execution is still completing.
const DEFAULT_LEASE_MS = 150_000;
const MAX_PENDING_JOBS_PER_USER = 50;
const TERMINAL_STATUSES = ['completed', 'failed', 'expired', 'outcome_unknown'];

function prune(document) {
  const cutoff = Date.now() - JOB_RETENTION_MS;
  const retained = document.jobs.filter(job => Date.parse(job.createdAt) >= cutoff || !TERMINAL_STATUSES.includes(job.status));
  const active = retained.filter(job => !TERMINAL_STATUSES.includes(job.status));
  const terminal = retained.filter(job => TERMINAL_STATUSES.includes(job.status)).slice(-2000);
  document.jobs = [...terminal, ...active].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
}

function desktopJobFailure(job) {
  const result = job?.result && typeof job.result === 'object' ? job.result : null;
  const error = new Error(job?.error || result?.error || 'Desktop MCP execution failed.');
  error.code = result?.code || 'DESKTOP_EXECUTION_FAILED';
  if (result?.details) error.details = result.details;
  return error;
}

export async function enqueueDesktopToolCall({ connection, tool, arguments: args, requestId }) {
  if (Buffer.byteLength(JSON.stringify(args || {})) > 4 * 1024 * 1024) {
    throw new ValidationError('MCP arguments exceed the 4 MiB desktop delivery limit. Use targeted edits or smaller batches.');
  }
  const now = new Date().toISOString();
  const submittedArguments = { ...(args || {}) };
  const envelopedArguments = tool.argumentEnvelope && submittedArguments[tool.argumentEnvelope];
  if (tool.argumentEnvelope) delete submittedArguments[tool.argumentEnvelope];
  const job = {
    id: randomId('job'),
    requestId,
    connectionId: connection.id,
    userId: connection.userId,
    tenantId: connection.tenantId,
    tenantKey: String(connection.tenantId || '').toLowerCase(),
    environmentId: connection.environmentId,
    environmentKey: String(connection.environmentId || '').toLowerCase(),
    toolName: tool.name,
    action: tool.action,
    risk: tool.risk,
    auditContext: { id: connection.id, userId: connection.userId, tenantId: connection.tenantId, environmentId: connection.environmentId, tenantName: connection.tenantName || '', environmentName: connection.environmentName || '', captureMode: connection.captureMode || 'metadata' },
    arguments: {
      ...submittedArguments,
      ...(envelopedArguments && typeof envelopedArguments === 'object' && !Array.isArray(envelopedArguments)
        ? envelopedArguments
        : {}),
      // The advertised operation is immutable even when a flexible payload
      // happens to contain a field such as kind, mode, or operation.
      ...(tool.fixedArguments || {})
    },
    status: 'queued',
    createdAt: now,
    expiresAt: new Date(Date.now() + tool.timeoutMs).toISOString(),
    claimedAt: null,
    completedAt: null,
    result: null,
    error: null
  };
  if (mongoEnabled()) {
    const collection = await mongoCollection('mcp_jobs');
    const pending = await collection.countDocuments({ userId: connection.userId, status: { $nin: TERMINAL_STATUSES } });
    if (pending >= MAX_PENDING_JOBS_PER_USER) {
      throw new ValidationError('Too many MCP calls are waiting for this Quicker Portal desktop. Let the current calls finish before sending more.');
    }
    await collection.insertOne(job);
  } else {
    await store.update(document => {
      prune(document);
      const pending = document.jobs.filter(item => item.userId === connection.userId && !TERMINAL_STATUSES.includes(item.status)).length;
      if (pending >= MAX_PENDING_JOBS_PER_USER) {
        throw new ValidationError('Too many MCP calls are waiting for this Quicker Portal desktop. Let the current calls finish before sending more.');
      }
      document.jobs.push(job);
      return { result: job };
    });
  }
  notifySignal(`desktop:${job.userId}`);
  return job;
}

export async function claimDesktopJobs(args) {
  const key = args.claimId ? JSON.stringify([args.userId, args.tenantId, args.environmentId, args.clientInstanceId, args.claimId]) : null;
  if (key && claimsInFlight.has(key)) return claimsInFlight.get(key);
  const pending = claimDesktopJobsOnce(args).finally(() => { if (key) claimsInFlight.delete(key); });
  if (key) claimsInFlight.set(key, pending);
  return pending;
}

async function claimDesktopJobsOnce({ userId, tenantId, environmentId, clientInstanceId, claimId, limit = 1 }) {
  const nowMs = Date.now();
  if (claimId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claimId)) throw new ValidationError('claimId must be a fresh UUID retained across delivery retries.');
  const claimKey = claimId ? sha256Hex(JSON.stringify([userId, tenantId, environmentId, clientInstanceId, claimId])) : null;
  const leaseToken = claimKey ? sha256Hex(`lease:${claimKey}`) : randomToken(24);
  if (mongoEnabled()) {
    const collection = await mongoCollection('mcp_jobs');
    if (claimKey) {
      const previous = await collection.findOne({ userId, claimKey });
      if (previous) return previous.status === 'leased' ? [claimedEnvelope(previous, leaseToken)] : [];
    }
    const nowIso = new Date(nowMs).toISOString();
    await collection.updateMany(
      { status: 'leased', leaseExpiresAt: { $lte: nowIso } },
      { $set: { status: 'outcome_unknown', error: 'The desktop lease expired after acceptance. Inspect current state before repeating a mutation.', retentionAt: new Date(nowMs + JOB_RETENTION_MS) } }
    );
    await collection.updateMany(
      { status: 'queued', expiresAt: { $lte: nowIso } },
      {
        $set: {
          status: 'expired',
          error: 'The connected Quicker Portal desktop did not accept the job in time.',
          arguments: null,
          result: null,
          purgedAt: nowIso,
          retentionAt: new Date(Date.now() + JOB_RETENTION_MS)
        }
      }
    );
    const claimed = [];
    const count = 1;
    for (let index = 0; index < count; index += 1) {
      const job = await collection.findOneAndUpdate(
        {
          status: 'queued',
          userId,
          tenantKey: String(tenantId).toLowerCase(),
          $or: [
            { environmentKey: '' },
            { environmentKey: null },
            { environmentKey: String(environmentId || '').toLowerCase() }
          ]
        },
        {
          $set: {
            status: 'leased',
            claimKey,
            claimedAt: nowIso,
            leaseExpiresAt: new Date(nowMs + DEFAULT_LEASE_MS).toISOString(),
            clientInstanceId: String(clientInstanceId || '').slice(0, 128)
          }
        },
        { sort: { createdAt: 1 }, returnDocument: 'after' }
      );
      if (!job) break;
      const leaseHash = sha256Hex(`${job.id}:${leaseToken}`);
      const secured = await collection.findOneAndUpdate(
        { id: job.id, status: 'leased', leaseHash: null },
        { $set: { leaseHash } },
        { returnDocument: 'after' }
      );
      if (!secured) continue;
      claimed.push({
        id: secured.id,
        userId: secured.userId,
        tenantId: secured.tenantId,
        environmentId: secured.environmentId,
        requestId: secured.requestId,
        toolName: secured.toolName,
        action: secured.action,
        risk: secured.risk,
        arguments: secured.arguments,
        createdAt: secured.createdAt,
        expiresAt: secured.expiresAt,
        leaseToken
      });
    }
    heartbeatDesktop({ userId, tenantId, environmentId, clientInstanceId });
    return claimed;
  }

  const claimed = await store.update(document => {
    prune(document);
    if (claimKey) {
      const previous = document.jobs.find(job => job.userId === userId && job.claimKey === claimKey);
      if (previous) return { result: previous.status === 'leased' ? [claimedEnvelope(previous, leaseToken)] : [] };
    }
    for (const job of document.jobs) {
      if (job.status === 'leased' && Date.parse(job.leaseExpiresAt || 0) <= nowMs) {
        job.status = 'outcome_unknown';
        job.error = 'The desktop lease expired after acceptance. Inspect current state before repeating a mutation.';
      }
      if (job.status === 'queued' && Date.parse(job.expiresAt) <= nowMs) {
        job.status = 'expired';
        job.error = 'The connected Quicker Portal desktop did not accept the job in time.';
        job.arguments = null;
        job.result = null;
        job.purgedAt = new Date().toISOString();
      }
    }
    const matches = document.jobs.filter(job =>
      job.status === 'queued' &&
      job.userId === userId &&
      job.tenantId.toLowerCase() === String(tenantId).toLowerCase() &&
      (!job.environmentId || job.environmentId.toLowerCase() === String(environmentId).toLowerCase())
    ).slice(0, 1);
    for (const job of matches) {
      job.status = 'leased';
      job.claimKey = claimKey;
      job.claimedAt = new Date().toISOString();
      job.leaseExpiresAt = new Date(nowMs + DEFAULT_LEASE_MS).toISOString();
      job.leaseHash = sha256Hex(`${job.id}:${leaseToken}`);
      job.clientInstanceId = String(clientInstanceId || '').slice(0, 128);
    }
    return { result: matches.map(job => ({
      id: job.id,
      userId: job.userId,
      tenantId: job.tenantId,
      environmentId: job.environmentId,
      requestId: job.requestId,
      toolName: job.toolName,
      action: job.action,
      risk: job.risk,
      arguments: job.arguments,
      createdAt: job.createdAt,
      expiresAt: job.expiresAt,
      leaseToken
    })) };
  });
  heartbeatDesktop({ userId, tenantId, environmentId, clientInstanceId });
  return claimed;
}

export async function completeDesktopJob({ userId, jobId, leaseToken, result, error }) {
  if (mongoEnabled()) {
    const collection = await mongoCollection('mcp_jobs');
    const job = await collection.findOne({ id: jobId, userId });
    if (!job) throw new NotFoundError('MCP job not found.');
    const suppliedHash = sha256Hex(`${job.id}:${leaseToken || ''}`);
    if (['completed', 'failed'].includes(job.status) && safeEqual(job.completionHash || '', suppliedHash)) return { id: job.id, status: job.status, acknowledged: true };
    if (!['leased', 'outcome_unknown'].includes(job.status)) throw new ValidationError('MCP job is not currently leased.');
    if (!safeEqual(job.leaseHash || '', sha256Hex(`${job.id}:${leaseToken || ''}`))) {
      throw new ValidationError('MCP job lease is invalid.');
    }
    const status = error || result?.ok === false ? 'failed' : 'completed';
    const updated = await collection.updateOne(
      { id: jobId, userId, status: { $in: ['leased', 'outcome_unknown'] }, leaseHash: job.leaseHash },
      {
        $set: {
          status,
          completedAt: new Date().toISOString(),
          result: result ?? null,
          error: String(error || result?.error || '').slice(0, 4000) || null,
          leaseHash: null,
          completionHash: suppliedHash,
          retentionAt: new Date(Date.now() + JOB_RETENTION_MS)
        }
      }
    );
    if (updated.matchedCount !== 1) throw new ValidationError('MCP job lease changed before completion.');
    notifySignal(`job:${jobId}`);
    await auditCompletion(job, result, error);
    return { id: jobId, status };
  }
  let auditJob;
  const completed = await store.update(document => {
    const job = document.jobs.find(item => item.id === jobId && item.userId === userId);
    if (!job) throw new NotFoundError('MCP job not found.');
    const suppliedHash = sha256Hex(`${job.id}:${leaseToken || ''}`);
    if (['completed', 'failed'].includes(job.status) && safeEqual(job.completionHash || '', suppliedHash)) return { result: { id: job.id, status: job.status, acknowledged: true } };
    if (!['leased', 'outcome_unknown'].includes(job.status)) throw new ValidationError('MCP job is not currently leased.');
    if (!safeEqual(job.leaseHash || '', sha256Hex(`${job.id}:${leaseToken || ''}`))) {
      throw new ValidationError('MCP job lease is invalid.');
    }
    job.status = error || result?.ok === false ? 'failed' : 'completed';
    job.completedAt = new Date().toISOString();
    job.result = result ?? null;
    job.error = String(error || result?.error || '').slice(0, 4000) || null;
    job.leaseHash = null;
    job.completionHash = suppliedHash;
    auditJob = { ...job };
    return { result: { id: job.id, status: job.status } };
  });
  notifySignal(`job:${jobId}`);
  if (auditJob) await auditCompletion(auditJob, result, error);
  return completed;
}

async function auditCompletion(job, result, error) {
  if (!job.auditContext) return;
  let timer;
  const failure = error || result?.ok === false ? Object.assign(new Error(error || result?.error || 'Desktop operation failed.'), { code: result?.code, status: result?.status, dataverseCode: result?.dataverseCode, requestId: result?.requestId, retryAfterSeconds: result?.retryAfterSeconds }) : null;
  const delivery = recordTransmission({ connection: job.auditContext, tool: { name: job.toolName, action: job.action, risk: job.risk }, requestId: job.requestId || job.id, arguments: job.arguments, result: result?.result ?? result, error: failure, startedAt: Date.parse(job.createdAt) })
    .catch(auditError => logger.warn('MCP completion audit could not be stored', { jobId: job.id, code: auditError.code || 'AUDIT_DELIVERY_FAILED' }));
  // The result is already durable. Telemetry must not hold its acknowledgment
  // hostage; a slow write can finish independently after this short budget.
  try { await Promise.race([delivery, new Promise(resolve => { timer = setTimeout(resolve, 500); })]); }
  finally { clearTimeout(timer); }
}

async function waitForMongoDesktopJob(jobId, timeoutMs, leavePending = false) {
  const collection = await mongoCollection('mcp_jobs');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const version = signalVersion(`job:${jobId}`);
    const job = await collection.findOne({ id: jobId });
    if (!job) throw new NotFoundError('MCP job was removed before completion.');
    if (job.status === 'completed') {
      const snapshot = { ...job };
      delete snapshot._id;
      const purgedAt = new Date().toISOString();
      await collection.updateOne(
        { id: jobId, status: 'completed' },
        { $set: { arguments: null, result: null, purgedAt, retentionAt: new Date(Date.now() + JOB_RETENTION_MS) } }
      );
      return snapshot;
    }
    if (['failed', 'expired'].includes(job.status)) {
      const failure = desktopJobFailure(job);
      await collection.updateOne(
        { id: jobId },
        { $set: { arguments: null, result: null, purgedAt: new Date().toISOString(), retentionAt: new Date(Date.now() + JOB_RETENTION_MS) } }
      );
      throw failure;
    }
    await waitForSignal(`job:${jobId}`, version, Math.min(2000, Math.max(1, deadline - Date.now())));
  }

  if (leavePending) return pendingDesktopOperation(await collection.findOne({ id: jobId }));
  const timedOut = await collection.findOneAndUpdate(
    { id: jobId, status: { $nin: ['completed', 'failed'] } },
    {
      $set: {
        status: 'expired',
        error: 'Timed out waiting for the connected Quicker Portal desktop.',
        arguments: null,
        result: null,
        purgedAt: new Date().toISOString(),
        retentionAt: new Date(Date.now() + JOB_RETENTION_MS)
      }
    },
    { returnDocument: 'after' }
  );
  const finalJob = timedOut || await collection.findOne({ id: jobId });
  // The status the job expired in is the diagnosis: still `queued` means no
  // desktop ever claimed it, which is a different fault from one that was
  // accepted and ran out of time.
  throw desktopWaitFailure(finalJob, timedOut?.claimedAt ? 'leased' : 'queued');
}

export async function waitForDesktopJob(jobId, timeoutMs, { leavePending = false } = {}) {
  if (mongoEnabled()) return waitForMongoDesktopJob(jobId, timeoutMs, leavePending);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const version = signalVersion(`job:${jobId}`);
    const document = await store.read();
    const job = document.jobs.find(item => item.id === jobId);
    if (!job) throw new NotFoundError('MCP job was removed before completion.');
    if (job.status === 'completed') {
      return store.update(current => {
        const completed = current.jobs.find(item => item.id === jobId);
        if (!completed || completed.status !== 'completed') throw new NotFoundError('The completed MCP job could not be consumed.');
        const snapshot = structuredClone(completed);
        completed.arguments = null;
        completed.result = null;
        completed.purgedAt = new Date().toISOString();
        return { result: snapshot };
      });
    }
    if (['failed', 'expired'].includes(job.status)) {
      const failure = desktopJobFailure(job);
      await store.update(current => {
        const failed = current.jobs.find(item => item.id === jobId);
        if (failed) {
          failed.arguments = null;
          failed.result = null;
          failed.purgedAt = new Date().toISOString();
        }
        return {};
      });
      throw failure;
    }
    await waitForSignal(`job:${jobId}`, version, Math.min(2000, Math.max(1, deadline - Date.now())));
  }
  if (leavePending) return pendingDesktopOperation((await store.read()).jobs.find(item => item.id === jobId));
  await store.update(document => {
    const job = document.jobs.find(item => item.id === jobId);
    if (job && !['completed', 'failed'].includes(job.status)) {
      job.status = 'expired';
      job.error = 'Timed out waiting for the connected Quicker Portal desktop.';
      job.arguments = null;
      job.result = null;
      job.purgedAt = new Date().toISOString();
    }
    return {};
  });
  const document = await store.read();
  const timedOutJob = document.jobs.find(item => item.id === jobId);
  throw desktopWaitFailure(timedOutJob, timedOutJob?.claimedAt ? 'leased' : 'queued');
}

export function heartbeatDesktop({ userId, tenantId, environmentId, environmentName, clientInstanceId, appVersion }) {
  const key = `${userId}:${String(tenantId).toLowerCase()}:${String(environmentId || '').toLowerCase()}:${clientInstanceId || ''}`;
  for (const [existingKey, value] of desktopHeartbeats) {
    if (Date.now() - Date.parse(value.lastSeenAt) > 120_000) desktopHeartbeats.delete(existingKey);
  }
  const snapshot = {
    userId,
    tenantId,
    environmentId: environmentId || '',
    environmentName: environmentName || '',
    clientInstanceId: clientInstanceId || '',
    appVersion: appVersion || '',
    lastSeenAt: new Date().toISOString()
  };
  desktopHeartbeats.set(key, snapshot);
  return snapshot;
}

/**
 * Why a job was never picked up.
 *
 * A job that expires while still queued was never claimed by any desktop, and
 * the reason is almost always that the connection is bound to one environment
 * while the desktop is on another - the claim filter matches on the environment
 * key, so nothing else can happen. The server knows both values, and saying
 * "keep Quicker Portal running" when Quicker Portal is already running and
 * heartbeating sends people to look in the one place the fault is not.
 */
export function desktopWaitFailure(job, phase = 'queued') {
  if (!job) return new Error('Timed out waiting for the connected Quicker Portal desktop. The request is no longer available.');
  const heartbeats = [...desktopHeartbeats.values()]
    .filter(item => item.userId === job.userId && String(item.tenantId).toLowerCase() === String(job.tenantId).toLowerCase())
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  const live = heartbeats.filter(item => Date.now() - Date.parse(item.lastSeenAt) < 25_000);
  const wanted = String(job.environmentId || '');

  if (!heartbeats.length) {
    return new Error(`Timed out waiting for the Quicker Portal desktop. No desktop has reported in for this connection${wanted ? ` and environment ${wanted}` : ''}. Open Quicker Portal, sign in, and keep it running.`);
  }
  if (!live.length) {
    return new Error(`Timed out waiting for the Quicker Portal desktop. It was last seen at ${heartbeats[0].lastSeenAt} and has stopped reporting in. Bring Quicker Portal back to the foreground and retry.`);
  }
  const matching = live.filter(item => !wanted || String(item.environmentId || '').toLowerCase() === wanted.toLowerCase());
  if (!matching.length) {
    const on = live.map(item => item.environmentName || item.environmentId || 'an unnamed environment');
    return new Error(
      `This MCP connection is bound to environment ${job.environmentName || wanted}, but the running Quicker Portal desktop is on ${[...new Set(on)].join(', ')}. `
      + `The request was never picked up because of that mismatch. Select ${job.environmentName || wanted} in Quicker Portal and retry, or use the MCP URL for the environment the desktop is actually on.`
    );
  }
  if (phase === 'leased') {
    return new Error(
      'The Quicker Portal desktop accepted this tool call but did not finish it in time. It is running and on the right environment, so the request itself is doing more work than the tool allows - narrow it, or retry.'
    );
  }
  return new Error(
    'Timed out waiting for the connected Quicker Portal desktop. It is running and on the right environment, but never picked the request up. Retry; if it repeats, the desktop is busy with other MCP calls.'
  );
}

export function desktopStatus(userId, tenantId, environmentId = '') {
  const candidates = [...desktopHeartbeats.values()].filter(item => item.userId === userId && String(item.tenantId).toLowerCase() === String(tenantId).toLowerCase()).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  const snapshot = candidates.find(item => !environmentId || String(item.environmentId || '').toLowerCase() === String(environmentId).toLowerCase()) || candidates[0];
  if (!snapshot) return { connected: false, lastSeenAt: null };
  // A heartbeat that does not say which environment it is on cannot be taken
  // as a match. It used to be, and the consequence was silent: the tool call
  // was told the desktop was connected, the job was queued, and then the claim
  // filter - which requires the environment keys to be equal - could never
  // match it. The job sat queued until it expired, so the caller waited the
  // full tool timeout and got a generic "desktop did not respond" with no
  // indication that an environment was involved at all.
  const environmentMatches = !environmentId
    || (Boolean(snapshot.environmentId) && String(snapshot.environmentId).toLowerCase() === String(environmentId).toLowerCase());
  return { ...snapshot, connected: environmentMatches && Date.now() - Date.parse(snapshot.lastSeenAt) < 25_000, environmentMatches };
}

function pendingDesktopOperation(job) {
  if (!job) throw new NotFoundError('MCP operation not found.');
  // Completion may win in the last polling interval. Return its known outcome.
  if (job.status === 'completed') return job;
  if (['failed', 'expired'].includes(job.status)) throw desktopJobFailure(job);
  const error = new Error('The desktop operation is still pending. Poll its operation ID; do not resubmit the original mutation.');
  error.code = 'MCP_OPERATION_PENDING';
  error.details = { operationId: job.id, status: job.status, expiresAt: job.expiresAt, pollAfterMs: 2000 };
  throw error;
}

export async function getDesktopOperation({ userId, connectionId, operationId }) {
  const job = mongoEnabled()
    ? await (await mongoCollection('mcp_jobs')).findOne({ id: operationId, userId, connectionId })
    : (await store.read()).jobs.find(item => item.id === operationId && item.userId === userId && item.connectionId === connectionId);
  if (!job) throw new NotFoundError('This operation is not available to this MCP connection.');
  const overdue = Date.parse(job.expiresAt) <= Date.now();
  const status = overdue && job.status === 'leased' ? 'outcome_unknown' : overdue && job.status === 'queued' ? 'expired' : job.status;
  return {
    operationId: job.id, toolName: job.toolName, status,
    completed: ['completed', 'failed', 'expired'].includes(status),
    ...(job.result !== null ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(status === 'outcome_unknown' ? { guidance: 'The desktop has not returned a final outcome. Inspect current state before retrying a mutation; it may already have succeeded.' } : {}),
    ...(job.purgedAt ? { resultPurged: true } : {}),
    pollAfterMs: 2000
  };
}
