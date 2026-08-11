// Request context: safe body parsing with size limits, client IP resolution,
// and JSON response helpers.
import { randomUUID } from 'node:crypto';
import { PayloadTooLargeError, ValidationError } from '../errors.js';
import { config } from '../../config/config.js';

export function createContext(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  return {
    req,
    res,
    url,
    method: req.method,
    pathname: url.pathname,
    requestId: randomUUID(),
    // This service binds to loopback by default. If deployed behind a
    // reverse proxy, set QP_BACKEND_TRUST_PROXY=1 so the first
    // X-Forwarded-For hop is used for rate limiting.
    ip: resolveClientIp(req),
    params: {},
    auth: null,
    startedAt: process.hrtime.bigint()
  };
}

function resolveClientIp(req) {
  if (process.env.QP_BACKEND_TRUST_PROXY === '1') {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}

export async function readJsonBody(ctx, maxBytes = config.maxBodyBytes) {
  const { req } = ctx;
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new ValidationError('Content-Type must be application/json.');
  }
  const declaredLength = Number.parseInt(req.headers['content-length'] || '0', 10);
  if (declaredLength > maxBytes) throw new PayloadTooLargeError();

  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > maxBytes) throw new PayloadTooLargeError();
    chunks.push(chunk);
  }
  if (!received) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ValidationError('Request body is not valid JSON.');
  }
}

export function sendJson(ctx, status, body, extraHeaders = {}) {
  if (ctx.res.writableEnded) return;
  const payload = JSON.stringify(body);
  ctx.res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  ctx.res.end(payload);
}
