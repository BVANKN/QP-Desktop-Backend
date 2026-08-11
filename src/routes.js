// API surface. Handlers validate input, apply endpoint-specific rate limits,
// and delegate to services. No business logic lives here.
import { Router } from './core/http/router.js';
import { readJsonBody, sendJson } from './core/http/context.js';
import { authenticate } from './core/middleware/authenticate.js';
import { consumeRateLimit } from './core/middleware/rate-limit.js';
import { config } from './config/config.js';
import {
  requireObject,
  cleanString,
  normalizeEmail,
  normalizeUsername,
  normalizeDisplayName,
  validatePassword,
  requireVerificationCode
} from './lib/validation.js';
import { ValidationError } from './core/errors.js';
import {
  startSignup,
  resendSignupCode,
  verifySignup,
  login,
  refresh,
  logout,
  logoutAll,
  changePassword
} from './modules/auth/auth-service.js';
import { publicPlanCatalog, planById, PLANS } from './modules/plans/plan-catalog.js';
import { changePlan, entitlementsForUser } from './modules/plans/subscription-store.js';
import { findUserById, publicUser, updateUser } from './modules/users/user-repo.js';
import { issueAccessToken } from './lib/tokens.js';
import { audit } from './modules/audit/audit.js';
import { registerMcpRoutes } from './modules/mcp/routes.js';

export function buildRouter() {
  const router = new Router();

  registerMcpRoutes(router);

  router.get('/api/health', ctx => {
    sendJson(ctx, 200, { ok: true, service: 'qp-x-xrm-backend', time: new Date().toISOString() });
  });

  router.get('/api/plans', ctx => {
    sendJson(ctx, 200, { ok: true, plans: publicPlanCatalog() });
  });

  // ------------------------------------------------------------- signup ---

  router.post('/api/auth/signup/start', async ctx => {
    consumeRateLimit('signup', ctx.ip, config.rateLimit.signup);
    const body = requireObject(await readJsonBody(ctx));
    const name = normalizeDisplayName(body.name);
    const username = normalizeUsername(body.username);
    const email = normalizeEmail(body.email);
    const password = validatePassword(body.password);
    if (body.confirmPassword !== undefined && body.confirmPassword !== body.password) {
      throw new ValidationError('Passwords do not match.', { field: 'confirmPassword' });
    }
    const planId = body.planId === undefined ? undefined : planById(cleanString(body.planId, { field: 'Plan', maxLength: 20 })).id;
    const result = await startSignup({ name, username, email, password, planId, ip: ctx.ip });
    sendJson(ctx, 200, { ok: true, ...result });
  });

  router.post('/api/auth/signup/resend', async ctx => {
    consumeRateLimit('resend', ctx.ip, config.rateLimit.resend);
    const body = requireObject(await readJsonBody(ctx));
    const pendingId = cleanString(body.pendingId, { field: 'Signup session', maxLength: 64 });
    const result = await resendSignupCode({ pendingId, ip: ctx.ip });
    sendJson(ctx, 200, { ok: true, ...result });
  });

  router.post('/api/auth/signup/verify', async ctx => {
    consumeRateLimit('verify', ctx.ip, config.rateLimit.verify);
    const body = requireObject(await readJsonBody(ctx));
    const pendingId = cleanString(body.pendingId, { field: 'Signup session', maxLength: 64 });
    const code = requireVerificationCode(body.code);
    const result = await verifySignup({ pendingId, code, ip: ctx.ip, userAgent: ctx.req.headers['user-agent'] });
    sendJson(ctx, 200, { ok: true, ...result });
  });

  // -------------------------------------------------------------- login ---

  router.post('/api/auth/login', async ctx => {
    consumeRateLimit('login-ip', ctx.ip, config.rateLimit.login);
    const body = requireObject(await readJsonBody(ctx));
    const identifier = cleanString(body.identifier ?? body.username ?? body.email, { field: 'User name or email', maxLength: 254 });
    const password = cleanString(body.password, { field: 'Password', maxLength: config.password.maxLength + 1 });
    // Second dimension: throttle attempts against one account across IPs.
    consumeRateLimit('login-id', identifier.toLowerCase(), config.rateLimit.login);
    const result = await login({ identifier, password, ip: ctx.ip, userAgent: ctx.req.headers['user-agent'] });
    sendJson(ctx, 200, { ok: true, ...result });
  });

  router.post('/api/auth/refresh', async ctx => {
    consumeRateLimit('refresh', ctx.ip, config.rateLimit.refresh);
    const body = requireObject(await readJsonBody(ctx));
    const refreshToken = cleanString(body.refreshToken, { field: 'Refresh token', maxLength: 512 });
    const result = await refresh({ refreshToken, ip: ctx.ip, userAgent: ctx.req.headers['user-agent'] });
    sendJson(ctx, 200, { ok: true, ...result });
  });

  router.post('/api/auth/logout', async ctx => {
    const body = requireObject(await readJsonBody(ctx));
    const refreshToken = cleanString(body.refreshToken, { field: 'Refresh token', maxLength: 512, required: false });
    if (refreshToken) await logout({ refreshToken });
    sendJson(ctx, 200, { ok: true });
  });

  router.post('/api/auth/logout-all', authenticate, async ctx => {
    const result = await logoutAll(ctx.auth.sub);
    sendJson(ctx, 200, { ok: true, ...result });
  });

  // ------------------------------------------------------------ account ---

  router.get('/api/auth/me', authenticate, async ctx => {
    const user = await findUserById(ctx.auth.sub);
    if (!user) return sendJson(ctx, 404, { ok: false, code: 'NOT_FOUND', error: 'Account not found.' });
    const entitlements = await entitlementsForUser(user.id);
    sendJson(ctx, 200, {
      ok: true,
      user: publicUser(user),
      plan: { id: entitlements.planId, name: planById(entitlements.planId).name },
      entitlements: entitlements.features,
      session: { id: ctx.auth.sid, accessTokenExpiresAt: ctx.auth.exp }
    });
  });

  router.post('/api/auth/password', authenticate, async ctx => {
    const body = requireObject(await readJsonBody(ctx));
    const currentPassword = cleanString(body.currentPassword, { field: 'Current password', maxLength: config.password.maxLength + 1 });
    const newPassword = validatePassword(body.newPassword);
    if (body.confirmPassword !== undefined && body.confirmPassword !== body.newPassword) {
      throw new ValidationError('Passwords do not match.', { field: 'confirmPassword' });
    }
    const result = await changePassword({ userId: ctx.auth.sub, currentPassword, newPassword, ip: ctx.ip });
    sendJson(ctx, 200, { ok: true, ...result });
  });

  // Plan change. Payment processing is out of scope by design — when a
  // payment provider is added, this endpoint verifies the provider's webhook
  // or receipt before switching the subscription. Until then it acts as the
  // mock checkout the product flow needs.
  router.post('/api/account/plan', authenticate, async ctx => {
    const body = requireObject(await readJsonBody(ctx));
    const requested = cleanString(body.planId, { field: 'Plan', maxLength: 20 }).toLowerCase();
    if (!PLANS[requested]) throw new ValidationError('Unknown plan.', { field: 'planId' });
    const subscription = await changePlan(ctx.auth.sub, requested);
    await updateUser(ctx.auth.sub, current => { current.planId = subscription.planId; });
    const user = await findUserById(ctx.auth.sub);
    const entitlements = await entitlementsForUser(ctx.auth.sub);
    // Same session, fresh claims — the old access token simply ages out.
    const access = issueAccessToken({
      user,
      sessionId: ctx.auth.sid,
      planId: entitlements.planId,
      entitlements: entitlements.features
    });
    await audit('plan.changed', { userId: ctx.auth.sub, planId: subscription.planId, ip: ctx.ip });
    sendJson(ctx, 200, {
      ok: true,
      user: publicUser(user),
      plan: { id: entitlements.planId, name: planById(entitlements.planId).name },
      entitlements: entitlements.features,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt
    });
  });

  return router;
}
