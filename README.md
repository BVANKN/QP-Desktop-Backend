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

The service listens on `http://127.0.0.1:4817` by default and creates its data
directory on first boot.

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
    key-store.js              signing key generation, persistence, rotation
    tokens.js                 signed access tokens (HS256, algorithm pinned)
    json-store.js             atomic crash-safe JSON persistence
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

All state lives under `data/` (owner-only `0700` directories, `0600` files):

```
data/
  users/users.json            user records + email/username indexes
  users/pending-signups.json  unverified signups (no user row exists yet)
  plans/subscriptions.json    subscription + plan state, kept separate from identity
  sessions/sessions.json      refresh sessions (hashes only, never raw tokens)
  keys/signing-keys.json      HMAC signing keys
  audit/security-events.jsonl append-only audit trail
  mcp/connections.json        MCP connection metadata + bearer-key hashes
  mcp/oauth-clients.json      dynamically registered public OAuth clients
  mcp/oauth-authorizations.json short-lived authorization + CSRF records
  mcp/oauth-tokens.json       authorization-code and rotating-token hashes
  mcp/jobs.json               short-lived desktop execution queue
  mcp/transmissions.jsonl     append-only redacted transmission history
  outbox/*.eml                sent mail when using the outbox transport
```

Writes are atomic: temp file, `fsync`, then `rename`. A per-file promise chain
serializes read-modify-write cycles so concurrent requests cannot interleave.

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

**Auditing.** Every security-relevant event is appended to
`data/audit/security-events.jsonl`. Secrets are redacted from logs by field name.

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
| `QP_BACKEND_DATA_DIR` | `./data` | State directory. **Must point at a mounted disk on any managed host** — see the deployment section. |
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

## Deployment: the data directory must be a real disk

**This is the single most important thing about running this service.**

Every user record, password hash, refresh session, token signing key, and MCP
connection is a JSON file under `QP_BACKEND_DATA_DIR`. Managed hosts (Render,
Heroku, Cloud Run, App Service, Fly) give a container an *ephemeral*
filesystem: it is recreated on every deploy, every restart, and every wake from
idle. `data/` is deliberately gitignored, so a deploy never carries state with
it either.

Without a mounted disk the result is total, silent data loss:

- Signup succeeds, and the account works for as long as the instance stays up.
- The instance restarts, redeploys, or idles out.
- The same credentials are now rejected — the account no longer exists.
- MCP OAuth stops authorizing, because both the connection records and the
  signing keys that validate its tokens went with it.

Nothing in the API surface looks wrong while this happens, which is what makes
it expensive to diagnose. So the service now says it plainly:

```bash
curl https://your-host/api/health
```

```json
{
  "ok": true,
  "storage": {
    "persistent": false,
    "accounts": "present",
    "warning": "Accounts are stored on an ephemeral filesystem and will be lost on the next restart. Mount a disk and set QP_BACKEND_DATA_DIR to it."
  }
}
```

`"persistent": false` means the next restart wipes every account. The same
condition is logged at `error` level on boot.

`render.yaml` in this repository declares the disk and points
`QP_BACKEND_DATA_DIR` at its mount:

```yaml
disk:
  name: qp-backend-data
  mountPath: /var/data
  sizeGB: 1
envVars:
  - key: QP_BACKEND_DATA_DIR
    value: /var/data
```

Mounting a disk on Render requires a paid instance type. On a free instance the
service loses its data on every spin-down regardless of configuration — there
is no setting that avoids this, only a database or a disk.

## Production notes

Deliberate scope boundaries, and what to do before going live:

- **Payments are not implemented.** `/api/account/plan` changes the plan
  directly. Wire it to a payment provider's webhook or receipt verification
  before charging money.
- **Terminate TLS in front of this service.** It binds to loopback and speaks
  plain HTTP; run it behind a reverse proxy that handles certificates. Only set
  `QP_BACKEND_TRUST_PROXY=1` when a trusted proxy actually sets
  `X-Forwarded-For`, otherwise clients can spoof their rate-limit identity.
- **Keep MCP OAuth state on durable storage.** OAuth clients, grants, connection
  records, signing keys, and product accounts currently use `QP_BACKEND_DATA_DIR`.
  Render's default filesystem is ephemeral, so attach a persistent disk and set
  this directory to its mount path, or replace the JSON repositories with a
  transactional database before production. A restart without durable storage
  invalidates active ChatGPT connections and can also lose product accounts.
- **Rate-limit counters are per-process.** Running multiple instances needs a
  shared store; the interface in `rate-limit.js` is the seam.
- **Back up `data/keys/signing-keys.json`.** Losing it invalidates every issued
  token (users simply sign in again). Leaking it lets an attacker mint valid
  tokens — treat it as a secret and rotate by adding a new key and switching
  `activeKid`.
- **The JSON stores suit single-node deployments.** The repository interfaces
  (`user-repo.js`, `session-store.js`, `subscription-store.js`) are the seam to
  swap in a database without touching business logic.
- **The MCP broker is single-node.** Desktop heartbeats are in memory and jobs use the local JSON store. Multi-instance deployment needs a shared transactional queue, distributed leases, and a shared analytics store.
- **Detailed MCP analytics retain business payloads.** Credential-like keys are redacted and oversized strings are truncated, but ordinary Dataverse field values are retained by design. Apply retention/deletion policy and encryption at rest, or require metadata-only capture.
