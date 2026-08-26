# QP-X-XRM Backend

Account, authentication, entitlement, Power Platform MCP, and live IDE MCP
service for Quicker Portal. The account service is built primarily on Node.js
built-ins; the IDE transport uses the official Model Context Protocol SDK,
Express, WebSocket, Zod, and gitignore parsing. Tests use Node's built-in
`node:test` runner.

## Quick start

```bash
npm start
```

The service listens on `http://127.0.0.1:4817` by default. Local development
uses the existing filesystem adapter; production uses MongoDB Atlas whenever
`MONGODB_URI` is configured.

Run the tests:

```bash
npm test
```

## Architecture

```
server.js                     entry point, signal handling
src/
  config/config.js            all configuration, env-var overridable
  core/
    errors.js                 error taxonomy -> HTTP status mapping
    logger.js                 JSON-lines logging with secret redaction
    http/router.js            method + path routing
    http/context.js           body parsing with size limits, JSON responses
    middleware/
      security.js             security headers, strict CORS allow-list
      rate-limit.js           sliding-window limiter
      authenticate.js         bearer verification + session liveness check
  lib/
    crypto.js                 scrypt hashing, HMAC, constant-time compare
    key-store.js              signing key generation, secret/Mongo persistence
    mongo.js                  Atlas pool, transactions, indexes, TTL setup
    tokens.js                 signed access tokens (HS256, algorithm pinned)
    json-store.js             local/test crash-safe persistence fallback
    validation.js             input normalization and policy
  modules/
    auth/auth-service.js      signup, verify, login, refresh, logout, password
    auth/session-store.js     refresh rotation + reuse detection
    users/user-repo.js        user records and unique indexes
    plans/plan-catalog.js     plan -> feature mapping (single source of truth)
    plans/subscription-store.js  subscriptions, entitlement derivation
    mail/mailer.js            outbox and SMTP transports
    mail/smtp-client.js       minimal SMTP client (STARTTLS, AUTH LOGIN)
    audit/audit.js            append-only security event log
    mcp/                      Streamable HTTP protocol, tool catalog, broker,
                              OAuth 2.1, connection keys, and transmission analytics
    ide-mcp/                  Premium per-user IDE MCP + WebSocket composition
    ide-codewriter/           live workspace, file, command, git, and verification engine
  routes.js                   HTTP surface
```

### Data layout

With `MONGODB_URI` configured, persistent application state is normalized into
MongoDB collections rather than stored as shared JSON blobs:

```
users                  product identity + password hashes
pending_signups        short-lived verification state (TTL)
sessions               rotating refresh-token families
subscriptions          authoritative plan state
mcp_connections        Power Platform + IDE MCP resources
mcp_jobs               durable desktop execution queue (terminal TTL)
oauth_clients          dynamically registered public OAuth clients
oauth_authorizations   short-lived authorization + CSRF state (TTL)
oauth_codes            one-time authorization codes (TTL)
oauth_grants           rotating OAuth access/refresh token hashes
audit_events           security audit trail
mcp_transmissions      redacted MCP transmission analytics
server_secrets         generated signing-key set when QP_SIGNING_SECRET is absent
```

Unique indexes protect user identifiers and resource IDs, TTL indexes clean up
short-lived records, and security-sensitive state changes use atomic updates or
MongoDB transactions where multiple documents must change together.

When MongoDB is not configured, local development and tests retain the original
`data/` JSON/JSONL adapter. The mail `outbox` transport also remains filesystem
based because it is a development transport, not application state.

## Security properties

**Passwords.** scrypt (N=32768, r=8, p=1) with a per-user random salt.
Parameters are stored inside the hash string, so costs can be raised later and
existing users are transparently rehashed on their next successful login.
Passwords are length-capped to prevent scrypt-based denial of service.

**Tokens.** Access tokens are JWT-compatible but the algorithm is pinned to
HS256 server-side — `alg: none` and key-confusion attacks are structurally
impossible. Claims carry the plan and entitlement list, so a modified token
fails signature verification. Keys carry a `kid` for rotation.

**Sessions.** Refresh tokens are 256-bit random values; only their SHA-256 is
persisted. Every refresh rotates the token. Presenting an already-rotated token
means it leaked, so the whole session family is revoked immediately. Sessions
have both a sliding expiry and an absolute cap.

**Account enumeration.** Login returns one identical error for unknown users and
wrong passwords, and performs a real scrypt verification against a dummy hash
when the identifier does not exist, so response timing does not leak existence.

**Signup.** Two-phase. `/signup/start` stores a pending registration with an
HMAC'd verification code — no user row exists until the code is proven. Codes
expire, are attempt-limited, and are resend-throttled.

**Lockout and rate limiting.** Per-IP and per-account budgets on login, plus
exponential account lockout after repeated failures.

**Entitlements.** Derived from the subscription store, never from client input.
`/api/auth/me` recomputes them from storage rather than trusting token claims.

**Auditing.** Every security-relevant event is persisted to the MongoDB
`audit_events` collection in Atlas mode (or append-only JSONL locally). Secrets
are never deliberately included in the audit payloads, and operational logging
continues to apply field-name redaction.

## API

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | — | Liveness probe |
| GET | `/api/plans` | — | Plan catalog |
| POST | `/api/auth/signup/start` | — | Begin signup, email a code |
| POST | `/api/auth/signup/resend` | — | Resend the code (throttled) |
| POST | `/api/auth/signup/verify` | — | Prove the code, create the account |
| POST | `/api/auth/login` | — | Sign in with username **or** email |
| POST | `/api/auth/refresh` | — | Rotate refresh token, mint access token |
| POST | `/api/auth/logout` | — | Revoke one session |
| POST | `/api/auth/logout-all` | Bearer | Revoke every session |
| GET | `/api/auth/me` | Bearer | Identity + authoritative entitlements |
| POST | `/api/auth/password` | Bearer | Change password, revokes all sessions |
| POST | `/api/account/plan` | Bearer | Change plan (payment is out of scope) |
| GET | `/api/mcp/tools` | QP Bearer + Pro | Governed Power Platform tool catalog |
| GET/POST | `/api/mcp/connections` | QP Bearer + Pro | List/create tenant-scoped MCP connections |
| DELETE | `/api/mcp/connections/:id` | QP Bearer + Pro | Revoke a connection key |
| GET | `/api/mcp/analytics` | QP Bearer + Pro | Stream-aggregate MCP transmission analytics |
| GET | `/.well-known/oauth-protected-resource/mcp/:userId/:tenantId` | — | RFC 9728 protected-resource discovery |
| GET | `/.well-known/oauth-authorization-server` | — | RFC 8414 authorization-server discovery |
| POST | `/oauth/register` | — | RFC 7591 dynamic registration for public PKCE clients |
| GET/POST | `/oauth/authorize` | — | User sign-in, consent, and authorization-code issuance |
| POST | `/oauth/token` | — | Authorization-code exchange and refresh-token rotation |
| POST | `/oauth/revoke` | — | Revoke an OAuth grant |
| POST | `/mcp/:userId/:tenantId` | OAuth or MCP Bearer | Stateless Streamable HTTP JSON-RPC endpoint |
| POST | `/mcp/:userId/:tenantId/:toolName` | OAuth or MCP Bearer | Optional one-tool-scoped endpoint |
| GET | `/api/ide/bootstrap` | QP Bearer + Premium | Return this user's IDE MCP and bridge endpoints |
| GET | `/api/ide/status` | QP Bearer + Premium | Live desktop/workspace/MCP session status |
| GET | `/api/ide/grants` | QP Bearer + Premium | List OAuth clients authorized for this IDE resource |
| DELETE | `/api/ide/grants/:clientId` | QP Bearer + Premium | Revoke one IDE OAuth client and its tokens |
| GET | `/.well-known/oauth-protected-resource/ide/mcp/:userId` | — | IDE RFC 9728 protected-resource discovery |
| POST | `/ide/mcp/:userId` | Resource-bound OAuth + Premium | Streamable HTTP IDE MCP endpoint |
| WebSocket | `/ide/bridge` | QP Bearer + Premium | Live desktop filesystem/command action bridge |

## MCP architecture

The backend is a broker, not a Dataverse credential store:

1. A Pro user creates an MCP connection in the Quicker Portal desktop.
2. The backend returns a connection-specific HTTPS endpoint. ChatGPT discovers protected-resource and authorization-server metadata, dynamically registers as a public client, and starts authorization code + S256 PKCE.
3. The user signs in to their Quicker Portal account and consents to the exact tenant/environment connection. Access and refresh tokens are opaque, resource-bound, stored only as SHA-256 hashes, and refresh tokens rotate on every use with replay detection.
4. The MCP client calls `initialize`, `tools/list`, or `tools/call` on the Streamable HTTP endpoint. `mcp:read` and `mcp:write` are enforced at the protocol boundary.
5. A tool call becomes a user/tenant/environment-scoped job. The connected desktop leases only jobs for its selected environment.
6. Reads execute with the desktop's existing delegated Microsoft token. Writes and destructive operations require a native one-time desktop approval.
7. The desktop returns the result; the backend records byte counts, duration, risk, detected tables/columns/record IDs, and optionally redacted payload values.

The server is stateless at the MCP protocol layer, so `GET` session streams and `DELETE` session termination return `405`; clients use JSON responses to `POST`. The standard endpoint exposes all tools, while the optional final path segment limits discovery and calls to one tool.

The generated connection also includes a one-time `qpmcp.*` bearer key for legacy clients that support custom headers but not OAuth. ChatGPT should use OAuth automatic discovery; do not paste the legacy key into ChatGPT. Revoking the Quicker Portal connection invalidates both OAuth grants and the legacy key.

### IDE MCP architecture

The IDE reuses the same Quicker Portal product account as the rest of the
desktop app. It has no separate IDE username, password, token store, or user
database.

1. A signed-in Premium desktop calls `/api/ide/bootstrap` with its short-lived
   QP product access token. The response contains `/ide/mcp/{userId}` and the
   `/ide/bridge` transport URL; it never contains a second reusable API key.
2. The desktop opens the WebSocket with that same rotating QP token. The
   backend verifies the session is still active and recomputes Premium
   entitlement before accepting it.
3. An external MCP client connects to the per-user MCP URL and completes the
   existing QP OAuth 2.1 authorization-code flow with S256 PKCE. Consent is
   bound to the exact IDE resource and QP user.
4. Reads, edits, file creation/deletion, commands, git checkpoints, and live
   output travel through the authenticated WebSocket to the user's desktop.
   The backend never mounts or reads the user's project directory.
5. Every MCP request rechecks current Premium entitlement. Signing out or
   downgrading also stops the desktop bridge immediately; revoking a grant
   invalidates that MCP client's hashed tokens.

## Configuration

Every value has a safe default; override with environment variables.

| Variable | Default | Purpose |
|---|---|---|
| `QP_BACKEND_HOST` | `127.0.0.1` | Bind address |
| `QP_BACKEND_PORT` | `4817` | Port |
| `MONGODB_URI` | unset | MongoDB Atlas connection URI. When set, MongoDB becomes authoritative persistent storage. |
| `MONGODB_DB_NAME` | `quicker_portal` | Atlas database name. |
| `MONGODB_MAX_POOL_SIZE` | `10` | Maximum MongoDB connection-pool size per backend process. |
| `QP_SIGNING_SECRET` | unset | Optional deployment secret used to derive the token-signing key; otherwise the generated key set is stored in MongoDB. |
| `QP_BACKEND_DATA_DIR` | `./data` | Filesystem fallback for local development/tests and the development mail outbox. |
| `QP_BACKEND_ALLOWED_ORIGINS` | localhost:5817 | CORS allow-list |
| `QP_BACKEND_TRUST_PROXY` | unset | Set to `1` only behind a trusted proxy |
| `QP_ACCESS_TOKEN_TTL_SECONDS` | `900` | Access token lifetime |
| `QP_REFRESH_TOKEN_TTL_SECONDS` | `2592000` | Refresh token lifetime |
| `QP_VERIFICATION_STATIC_CODE` | `123456` | Fixed signup code; set to `''` to email a random one. **Must be empty in production.** |
| `QP_MAIL_TRANSPORT` | `outbox` | `outbox` or `smtp` |
| `QP_MAIL_FROM` | no-reply@… | Sender address |
| `QP_SMTP_HOST` / `_PORT` / `_USER` / `_PASS` / `_SECURE` | — | SMTP settings |
| `QP_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `QP_MCP_PUBLIC_BASE_URL` | request origin | Public HTTPS base used in generated MCP endpoints |
| `QP_MCP_MAX_PAYLOAD_BYTES` | `10485760` | Maximum desktop result/request payload |
| `QP_MCP_DESKTOP_TIMEOUT_MS` | `105000` | Maximum wait for desktop execution; long metadata reads still use tool-specific limits |
| `QP_MCP_OAUTH_AUTHORIZATION_TTL_SECONDS` | `1200` | Pending sign-in/consent lifetime; an expired temporary request is safely rebuilt |
| `QP_MCP_OAUTH_CODE_TTL_SECONDS` | `300` | One-time authorization-code lifetime |
| `QP_MCP_OAUTH_ACCESS_TTL_SECONDS` | `900` | Resource-bound MCP access-token lifetime |
| `QP_MCP_OAUTH_REFRESH_TTL_SECONDS` | `2592000` | Rotating refresh-token lifetime |
| `QP_MCP_OAUTH_MAX_CLIENTS` | `1000` | Retained dynamic OAuth client limit |
| `QP_IDE_MCP_ALLOWED_HOSTS` | public MCP host + loopback | Exact Host allow-list for IDE Streamable HTTP |
| `QP_IDE_MCP_CLIENT_BUDGET_MS` | `60000` | End-to-end MCP client request budget |
| `QP_IDE_MCP_BRIDGE_RPC_TIMEOUT_MS` | budget minus 12s | Desktop action timeout with response headroom |
| `QP_IDE_MCP_BRIDGE_PING_TIMEOUT_MS` | `8000` | Desktop liveness probe timeout |
| `QP_IDE_MCP_MAX_READ_BYTES` | `1048576` | Maximum combined text returned by a read call |
| `QP_IDE_MCP_MAX_FILE_BYTES` | `5242880` | Maximum individual text file size |

### Verification codes are currently static

**Email delivery of the signup code is switched off.** Signup and resend hand
out a fixed code — `123456` — instead of mailing a random one. Everything
around delivery is unchanged: the code is still HMAC'd into the pending record,
still expires, is still attempt-limited, and resends still rotate it and reset
the counter, so the throttling behaviour is already what it will be once real
mail comes back.

To restore Gmail/SMTP delivery, clear the static code — nothing else needs
editing, and the random code and `sendMail` calls come back on their own:

```bash
QP_VERIFICATION_STATIC_CODE='' npm start
```

Or set `staticCode: ''` in `src/config/config.js` to make it permanent. The
tests read the same switch, so they pass either way.

> **This must be empty in production.** A fixed code means anyone who knows it
> can verify any address, which defeats email ownership entirely.

### Local development mail

The default `outbox` transport writes each message as a `.eml` file under
`data/outbox/`. To read a verification code during development:

```bash
grep -h "code is" data/outbox/*.eml | tail -1
```

## Deployment: MongoDB Atlas persistence

Managed hosts such as Render provide ephemeral container filesystems. Production
therefore uses MongoDB Atlas whenever `MONGODB_URI` is configured; the local
filesystem is not the source of truth for product accounts, sessions, MCP state,
or analytics.

Without MongoDB or an explicitly persistent fallback disk, the result is silent
data loss:

- Signup succeeds, and the account works for as long as the instance stays up.
- The instance restarts, redeploys, or idles out.
- If MongoDB Atlas is not configured and the filesystem is ephemeral, the same
  credentials are now rejected because the account no longer exists.
- MCP OAuth can also stop authorizing if its connection records/signing keys
  were stored only on that ephemeral filesystem.

The production configuration now uses MongoDB Atlas whenever `MONGODB_URI` is
present. Check the active storage mode at:

```bash
curl https://your-host/api/health
```

A healthy Atlas-backed response contains:

```json
{
  "ok": true,
  "storage": {
    "mode": "mongodb",
    "persistent": true,
    "database": "quicker_portal",
    "accounts": "present"
  }
}
```

`render.yaml` declares the required secret URI without embedding credentials:

```yaml
envVars:
  - key: MONGODB_URI
    sync: false
  - key: MONGODB_DB_NAME
    value: quicker_portal
  - key: QP_SIGNING_SECRET
    sync: false
```

`QP_SIGNING_SECRET` is optional. When omitted, Quicker Portal creates a random
256-bit signing key once and stores the key set in MongoDB. Supplying the secret
keeps token signing independent of the database and is recommended for stricter
production separation.

If an older deployment already has JSON data, configure Atlas and run:

```bash
npm run migrate:mongo
```

The migration is idempotent: stable IDs are upserted, JSONL history gets stable
migration keys, and rerunning it does not duplicate records.

## Production notes

Deliberate scope boundaries, and what to do before going live:

- **Payments are not implemented.** `/api/account/plan` changes the plan
  directly. Wire it to a payment provider's webhook or receipt verification
  before charging money.
- **Terminate TLS in front of this service.** It binds to loopback and speaks
  plain HTTP; run it behind a reverse proxy that handles certificates. Only set
  `QP_BACKEND_TRUST_PROXY=1` when a trusted proxy actually sets
  `X-Forwarded-For`, otherwise clients can spoof their rate-limit identity.
- **Keep `MONGODB_URI` secret.** It grants database access and must be configured
  through the hosting provider's secret environment, never committed to source.
- **Prefer `QP_SIGNING_SECRET` for production key separation.** The fallback
  Mongo-backed key set is durable, but a dedicated deployment secret prevents a
  database credential alone from exposing the token-signing key.
- **Rate-limit counters are still per-process.** Running many HTTP instances
  behind one origin should move rate-limit counters to a shared store.
- **Desktop heartbeats are intentionally in memory.** Durable MCP jobs are now
  shared through MongoDB, but a desktop heartbeat reflects a live connection to
  one backend process; use sticky routing or a shared presence layer before
  horizontally scaling the long-lived desktop bridge.
- **Back up Atlas.** Users, pending signups, sessions, subscriptions, MCP
  connections/jobs, OAuth state, audit events, and transmission analytics are
  stored in normalized collections with indexes and TTL cleanup where
  appropriate.

- **Detailed MCP analytics retain business payloads.** Credential-like keys are redacted and oversized strings are truncated, but ordinary Dataverse field values are retained by design. Apply retention/deletion policy and encryption at rest, or require metadata-only capture.
