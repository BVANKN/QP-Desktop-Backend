// Central configuration. Every value can be overridden with environment
// variables so the same build runs in dev, staging, and production without
// code changes. Secrets are never hardcoded — the signing key is generated
// on first boot and persisted with restrictive permissions (see key-store.js).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) throw new Error(`Environment variable ${name} must be an integer, got "${raw}".`);
  return value;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

/**
 * Whether state written to the data directory survives a restart.
 *
 * An explicitly configured data directory is taken as the operator having
 * pointed it at real storage — a mounted disk, a volume, a host path. Without
 * one, on a host that advertises itself as managed, the container filesystem
 * is all there is, and it is recreated on every deploy and every wake from
 * idle. Exported as a plain function so the rule itself can be asserted rather
 * than inferred from whichever environment the tests happen to run in.
 */
export function isPersistentStorage({ dataDirConfigured, managedHost }) {
  return Boolean(dataDirConfigured) || !managedHost;
}

export const config = Object.freeze({
  env: process.env.NODE_ENV || 'development',
  host: process.env.QP_BACKEND_HOST || '127.0.0.1',
  port: intEnv('QP_BACKEND_PORT', 4817),

  // Filesystem layout. dataDir holds all persistent state and is created with
  // owner-only permissions on boot.
  dataDir: process.env.QP_BACKEND_DATA_DIR || path.join(backendRoot, 'data'),

  // Whether the state written to dataDir actually survives a restart.
  //
  // Every account, password hash, refresh session, token signing key, and MCP
  // connection is a JSON file under dataDir. On a managed host the container
  // filesystem is recreated on each deploy, restart, and wake from idle, so
  // without a mounted disk all of it is destroyed — and the only symptom is
  // that credentials which worked an hour ago are suddenly rejected, with a
  // perfectly healthy-looking service behind them.
  //
  // An explicitly configured dataDir is taken as the operator having pointed
  // it at a real volume. Without one, on a host that advertises itself as
  // managed, the storage is ephemeral and the service says so loudly.
  storage: Object.freeze({
    dataDirConfigured: Boolean(process.env.QP_BACKEND_DATA_DIR),
    managedHost: Boolean(
      process.env.RENDER ||
      process.env.DYNO ||
      process.env.K_SERVICE ||
      process.env.WEBSITE_INSTANCE_ID ||
      process.env.FLY_APP_NAME
    ),
    get persistent() {
      return isPersistentStorage(this);
    }
  }),

  // Origins allowed to call this API from a browser context. The Electron
  // main process talks to us server-to-server (no Origin header), so this
  // list only matters if a renderer ever calls the API directly.
  allowedOrigins: (process.env.QP_BACKEND_ALLOWED_ORIGINS || 'http://127.0.0.1:5817,http://localhost:5817')
    .split(',').map(origin => origin.trim()).filter(Boolean),

  // Request handling limits.
  maxBodyBytes: intEnv('QP_BACKEND_MAX_BODY_BYTES', 64 * 1024),
  requestTimeoutMs: intEnv('QP_BACKEND_REQUEST_TIMEOUT_MS', 15_000),

  mcp: Object.freeze({
    // Render supplies RENDER_EXTERNAL_URL for public web services. Prefer an
    // explicit value elsewhere so OAuth metadata never advertises an internal
    // HTTP origin when TLS terminates at the hosting edge.
    publicBaseUrl: process.env.QP_MCP_PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '',
    maxPayloadBytes: intEnv('QP_MCP_MAX_PAYLOAD_BYTES', 10 * 1024 * 1024),
    desktopTimeoutMs: intEnv('QP_MCP_DESKTOP_TIMEOUT_MS', 55_000),
    oauth: Object.freeze({
      authorizationTtlSeconds: intEnv('QP_MCP_OAUTH_AUTHORIZATION_TTL_SECONDS', 20 * 60),
      codeTtlSeconds: intEnv('QP_MCP_OAUTH_CODE_TTL_SECONDS', 5 * 60),
      accessTtlSeconds: intEnv('QP_MCP_OAUTH_ACCESS_TTL_SECONDS', 15 * 60),
      refreshTtlSeconds: intEnv('QP_MCP_OAUTH_REFRESH_TTL_SECONDS', 30 * 24 * 60 * 60),
      maxClients: intEnv('QP_MCP_OAUTH_MAX_CLIENTS', 1000)
    })
  }),

  token: Object.freeze({
    issuer: 'qp-x-xrm-backend',
    audience: 'quicker-portal-desktop',
    accessTtlSeconds: intEnv('QP_ACCESS_TOKEN_TTL_SECONDS', 15 * 60),
    refreshTtlSeconds: intEnv('QP_REFRESH_TOKEN_TTL_SECONDS', 30 * 24 * 60 * 60),
    // Sliding refresh: each rotation extends the session up to this absolute cap.
    sessionAbsoluteTtlSeconds: intEnv('QP_SESSION_ABSOLUTE_TTL_SECONDS', 90 * 24 * 60 * 60)
  }),

  password: Object.freeze({
    minLength: 6,
    // Cap prevents scrypt DoS through multi-megabyte passwords.
    maxLength: 128,
    // scrypt parameters (OWASP-recommended interactive cost).
    scryptCost: 1 << 15,
    scryptBlockSize: 8,
    scryptParallelization: 1,
    scryptKeyLength: 64
  }),

  verification: Object.freeze({
    // TEMPORARY — development only.
    //
    // Gmail/SMTP delivery is switched off, so signup and resend hand out this
    // fixed code instead of emailing a random one. To restore real delivery:
    // set this to '' (or QP_VERIFICATION_STATIC_CODE='') and uncomment the two
    // blocks marked "STATIC CODE" in src/modules/auth/auth-service.js.
    //
    // This MUST be empty in production: a fixed code means anyone who knows it
    // can verify any address, which defeats email ownership entirely.
    staticCode: process.env.QP_VERIFICATION_STATIC_CODE ?? '123456',
    codeLength: 6,
    ttlSeconds: intEnv('QP_VERIFICATION_TTL_SECONDS', 10 * 60),
    maxAttempts: 5,
    resendCooldownSeconds: 60,
    maxResends: 5
  }),

  lockout: Object.freeze({
    // Account lockout after consecutive failures, with exponential backoff.
    maxFailures: 5,
    baseDelaySeconds: 30,
    maxDelaySeconds: 15 * 60
  }),

  rateLimit: Object.freeze({
    // Global per-IP ceiling.
    global: { windowMs: 60_000, max: 300 },
    // Sensitive endpoints get much tighter budgets.
    login: { windowMs: 60_000, max: 10 },
    signup: { windowMs: 60 * 60_000, max: 20 },
    verify: { windowMs: 60_000, max: 10 },
    resend: { windowMs: 60 * 60_000, max: 10 },
    refresh: { windowMs: 60_000, max: 30 },
    oauthRegister: { windowMs: 60 * 60_000, max: 30 },
    oauthAuthorize: { windowMs: 60_000, max: 20 },
    oauthToken: { windowMs: 60_000, max: 60 }
  }),

  mail: Object.freeze({
    // "outbox" writes .eml files under data/outbox — the zero-dependency
    // default for local/dev. "smtp" uses the built-in minimal SMTP client.
    transport: process.env.QP_MAIL_TRANSPORT || 'outbox',
    from: process.env.QP_MAIL_FROM || 'Quicker Portal <no-reply@quickerportal.local>',
    smtp: Object.freeze({
      host: process.env.QP_SMTP_HOST || '',
      port: intEnv('QP_SMTP_PORT', 587),
      secure: boolEnv('QP_SMTP_SECURE', false),
      user: process.env.QP_SMTP_USER || '',
      pass: process.env.QP_SMTP_PASS || ''
    })
  }),

  logging: Object.freeze({
    // JSON lines to stdout; the audit trail is a separate append-only file.
    level: process.env.QP_LOG_LEVEL || 'info'
  })
});
