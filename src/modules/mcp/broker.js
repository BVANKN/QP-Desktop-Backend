import { JsonStore } from '../../lib/json-store.js';
import { randomId, randomToken, safeEqual, sha256Hex } from '../../lib/crypto.js';
import { mongoCollection, mongoEnabled } from '../../lib/mongo.js';
import { NotFoundError, ValidationError } from '../../core/errors.js';

const store = new JsonStore('mcp/jobs.json', { version: 1, jobs: [] });
const desktopHeartbeats = new Map();

const JOB_RETENTION_MS = 24 * 60 * 60_000;
const DEFAULT_LEASE_MS = 125_000;
const MAX_PENDING_JOBS_PER_USER = 50;

function prune(document) {
  const cutoff = Date.now() - JOB_RETENTION_MS;
  const retained = document.jobs.filter(job => Date.parse(job.createdAt) >= cutoff || !['completed', 'failed', 'expired'].includes(job.status));
  const active = retained.filter(job => !['completed', 'failed', 'expired'].includes(job.status));
  const terminal = retained.filter(job => ['completed', 'failed', 'expired'].includes(job.status)).slice(-2000);
  document.jobs = [...terminal, ...active].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
}

export async function enqueueDesktopToolCall({ connection, tool, arguments: args, requestId }) {
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
    arguments: {
      ...(tool.fixedArguments || {}),
      ...submittedArguments,
      ...(envelopedArguments && typeof envelopedArguments === 'object' && !Array.isArray(envelopedArguments)
        ? envelopedArguments
        : {})
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
    const pending = await collection.countDocuments({ userId: connection.userId, status: { $nin: ['completed', 'failed', 'expired'] } });
    if (pending >= MAX_PENDING_JOBS_PER_USER) {
      throw new ValidationError('Too many MCP calls are waiting for this Quicker Portal desktop. Let the current calls finish before sending more.');
    }
    await collection.insertOne(job);
  } else {
    await store.update(document => {
      prune(document);
      const pending = document.jobs.filter(item => item.userId === connection.userId && !['completed', 'failed', 'expired'].includes(item.status)).length;
      if (pending >= MAX_PENDING_JOBS_PER_USER) {
        throw new ValidationError('Too many MCP calls are waiting for this Quicker Portal desktop. Let the current calls finish before sending more.');
      }
      document.jobs.push(job);
      return { result: job };
    });
  }
  return job;
}

export async function claimDesktopJobs({ userId, tenantId, environmentId, clientInstanceId, limit = 1 }) {
  const nowMs = Date.now();
  const leaseToken = randomToken(24);
  if (mongoEnabled()) {
    const collection = await mongoCollection('mcp_jobs');
    const nowIso = new Date(nowMs).toISOString();
    await collection.updateMany(
      { status: 'leased', leaseExpiresAt: { $lte: nowIso } },
      { $set: { status: 'queued', leaseHash: null, clientInstanceId: null }, $unset: { leaseExpiresAt: '' } }
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
    const count = Math.min(Math.max(Number(limit) || 1, 1), 5);
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
    for (const job of document.jobs) {
      if (job.status === 'leased' && Date.parse(job.leaseExpiresAt || 0) <= nowMs) {
        job.status = 'queued';
        job.leaseHash = null;
        job.clientInstanceId = null;
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
    ).slice(0, Math.min(Math.max(Number(limit) || 1, 1), 5));
    for (const job of matches) {
      job.status = 'leased';
      job.claimedAt = new Date().toISOString();
      job.leaseExpiresAt = new Date(nowMs + DEFAULT_LEASE_MS).toISOString();
      job.leaseHash = sha256Hex(`${job.id}:${leaseToken}`);
      job.clientInstanceId = String(clientInstanceId || '').slice(0, 128);
    }
    return { result: matches.map(job => ({
      id: job.id,
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
    if (job.status !== 'leased') throw new ValidationError('MCP job is not currently leased.');
    if (!safeEqual(job.leaseHash || '', sha256Hex(`${job.id}:${leaseToken || ''}`))) {
      throw new ValidationError('MCP job lease is invalid.');
    }
    const status = error || result?.ok === false ? 'failed' : 'completed';
    const updated = await collection.updateOne(
      { id: jobId, userId, status: 'leased', leaseHash: job.leaseHash },
      {
        $set: {
          status,
          completedAt: new Date().toISOString(),
          result: result ?? null,
          error: String(error || result?.error || '').slice(0, 4000) || null,
          leaseHash: null,
          retentionAt: new Date(Date.now() + JOB_RETENTION_MS)
        }
      }
    );
    if (updated.matchedCount !== 1) throw new ValidationError('MCP job lease changed before completion.');
    return { id: jobId, status };
  }
  return store.update(document => {
    const job = document.jobs.find(item => item.id === jobId && item.userId === userId);
    if (!job) throw new NotFoundError('MCP job not found.');
    if (job.status !== 'leased') throw new ValidationError('MCP job is not currently leased.');
    if (!safeEqual(job.leaseHash || '', sha256Hex(`${job.id}:${leaseToken || ''}`))) {
      throw new ValidationError('MCP job lease is invalid.');
    }
    job.status = error || result?.ok === false ? 'failed' : 'completed';
    job.completedAt = new Date().toISOString();
    job.result = result ?? null;
    job.error = String(error || result?.error || '').slice(0, 4000) || null;
    job.leaseHash = null;
    return { result: { id: job.id, status: job.status } };
  });
}

async function waitForMongoDesktopJob(jobId, timeoutMs) {
  const collection = await mongoCollection('mcp_jobs');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
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
      const message = job.error || 'Desktop MCP execution failed.';
      await collection.updateOne(
        { id: jobId },
        { $set: { arguments: null, result: null, purgedAt: new Date().toISOString(), retentionAt: new Date(Date.now() + JOB_RETENTION_MS) } }
      );
      throw new Error(message);
    }
    await new Promise(resolve => setTimeout(resolve, 180));
  }

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
  const desktop = finalJob
    ? desktopStatus(finalJob.userId, finalJob.tenantId, finalJob.environmentId)
    : null;
  if (desktop && desktop.environmentMatches === false) {
    throw new Error(`The Quicker Portal desktop switched environments before this tool ran. Select ${finalJob.environmentId} in Quicker Portal and retry; the desktop is currently connected to ${desktop.environmentName || desktop.environmentId || 'another environment'}.`);
  }
  throw new Error('Timed out waiting for the connected Quicker Portal desktop. Keep Quicker Portal running and connected to this MCP connection environment, then retry.');
}

export async function waitForDesktopJob(jobId, timeoutMs) {
  if (mongoEnabled()) return waitForMongoDesktopJob(jobId, timeoutMs);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
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
      const message = job.error || 'Desktop MCP execution failed.';
      await store.update(current => {
        const failed = current.jobs.find(item => item.id === jobId);
        if (failed) {
          failed.arguments = null;
          failed.result = null;
          failed.purgedAt = new Date().toISOString();
        }
        return {};
      });
      throw new Error(message);
    }
    await new Promise(resolve => setTimeout(resolve, 180));
  }
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
  const desktop = timedOutJob
    ? desktopStatus(timedOutJob.userId, timedOutJob.tenantId, timedOutJob.environmentId)
    : null;
  if (desktop && desktop.environmentMatches === false) {
    throw new Error(`The Quicker Portal desktop switched environments before this tool ran. Select ${timedOutJob.environmentId} in Quicker Portal and retry; the desktop is currently connected to ${desktop.environmentName || desktop.environmentId || 'another environment'}.`);
  }
  throw new Error('Timed out waiting for the connected Quicker Portal desktop. Keep Quicker Portal running and connected to this MCP connection environment, then retry.');
}

export function heartbeatDesktop({ userId, tenantId, environmentId, environmentName, clientInstanceId, appVersion }) {
  const key = `${userId}:${String(tenantId).toLowerCase()}`;
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

export function desktopStatus(userId, tenantId, environmentId = '') {
  const snapshot = desktopHeartbeats.get(`${userId}:${String(tenantId).toLowerCase()}`);
  if (!snapshot) return { connected: false, lastSeenAt: null };
  const environmentMatches = !environmentId || !snapshot.environmentId || String(snapshot.environmentId).toLowerCase() === String(environmentId).toLowerCase();
  return { ...snapshot, connected: environmentMatches && Date.now() - Date.parse(snapshot.lastSeenAt) < 25_000, environmentMatches };
}
