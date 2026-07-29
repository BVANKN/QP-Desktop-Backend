// HTTP application: wires middleware, router, and error mapping around
// node:http. Exported separately from server.js so tests can boot the app on
// an ephemeral port.
import http from 'node:http';
import { config } from './config/config.js';
import { logger } from './core/logger.js';
import { createContext, sendJson } from './core/http/context.js';
import { applyCors, applySecurityHeaders } from './core/middleware/security.js';
import { consumeRateLimit } from './core/middleware/rate-limit.js';
import { buildRouter } from './routes.js';
import { ensureDataDir } from './lib/json-store.js';
import { pruneExpiredSessions } from './modules/auth/session-store.js';
import { AppError } from './core/errors.js';

export function createApp() {
  ensureDataDir();
  const router = buildRouter();

  const server = http.createServer(async (req, res) => {
    const ctx = createContext(req, res);
    res.setHeader('X-Request-Id', ctx.requestId);
    applySecurityHeaders(res);
    if (applyCors(req, res)) return;

    try {
      consumeRateLimit('global', ctx.ip, config.rateLimit.global);
      const match = router.match(ctx.method, ctx.pathname);
      if (!match) {
        return sendJson(ctx, 404, { ok: false, code: 'NOT_FOUND', error: 'Unknown endpoint.' });
      }
      if (match.methodMismatch) {
        return sendJson(ctx, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'Method not allowed.' });
      }
      ctx.params = match.params;
      for (const handler of match.handlers) {
        await handler(ctx);
        if (res.writableEnded) break;
      }
      if (!res.writableEnded) {
        sendJson(ctx, 500, { ok: false, code: 'NO_RESPONSE', error: 'Handler produced no response.' });
      }
    } catch (error) {
      handleError(ctx, error);
    } finally {
      const durationMs = Number(process.hrtime.bigint() - ctx.startedAt) / 1e6;
      logger.info('request', {
        requestId: ctx.requestId,
        method: ctx.method,
        path: ctx.pathname,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
        ip: ctx.ip
      });
    }
  });

  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = Math.min(config.requestTimeoutMs, 10_000);

  // Hourly session pruning keeps the sessions file bounded.
  const pruneTimer = setInterval(() => {
    pruneExpiredSessions().catch(error => logger.error('Session prune failed', { error: error.message }));
  }, 60 * 60_000);
  pruneTimer.unref?.();

  return server;
}

function handleError(ctx, error) {
  if (error instanceof AppError && error.expose) {
    const headers = error.retryAfterSeconds ? { 'Retry-After': String(error.retryAfterSeconds) } : {};
    return sendJson(ctx, error.status, {
      ok: false,
      code: error.code,
      error: error.message,
      ...(error.details ? { details: error.details } : {}),
      ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {})
    }, headers);
  }
  logger.error('Unhandled error', { requestId: ctx.requestId, path: ctx.pathname, error: error.message, stack: error.stack });
  sendJson(ctx, 500, { ok: false, code: 'INTERNAL_ERROR', error: 'Something went wrong. Try again.' });
}
