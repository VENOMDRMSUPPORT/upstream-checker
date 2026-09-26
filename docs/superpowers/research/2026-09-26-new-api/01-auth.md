# new-api study, part 01: authentication and the account system

Source studied: `C:\Users\venom\Desktop\new-api-research` at commit `c2b7a9a` (2026-09-25).
new-api is AGPL-3.0. This document describes behaviour, flows, data shapes and design
decisions in our own words, with `file:line` references into that tree. It copies no code
and quotes only short labels. Treat it as a functional spec and threat review for a
clean-room design in VENOM Router. The source was read, never run.

Paths are relative to the repo root. `web/src/...` is the React frontend.

Important context: this tree is much newer than the classic one-api/new-api auth most people
know. The old Gin cookie session and the `New-Api-User` header are gone. Dashboard auth is
now a short-lived JWT plus a rotating refresh cookie backed by a server-side session table
(`docs/authentication.md:3`). Several statements in `docs/authentication.md` are already out
of date compared with the code; they are listed in Appendix A.

---

## 0. Big picture in one screen

There are seven distinct credential types. Keeping them apart is the key to understanding the
whole system.

| # | Credential | Who holds it | Lifetime | Server storage | Used for |
|---|---|---|---|---|---|
| 1 | Dashboard access token (HS256 JWT) | Browser memory only | 15 min (`service/auth_token.go:20`) | Nothing (stateless, but checked against the session row) | `Authorization: Bearer` on `/api/*` |
| 2 | Refresh token (`<sid>.<64-char secret>`) | `new_api_refresh` cookie, HttpOnly, SameSite=Strict, path `/api/user/auth` | Up to 30 days (`service/auth_token.go:22`) | HMAC digest in `user_sessions.refresh_hash` | `POST /api/user/auth/refresh`, logout |
| 3 | Session hint cookie `new_api_has_session=1` | Script-readable cookie, path `/` | Same as refresh cookie | Nothing | Lets the SPA skip a pointless refresh call when anonymous |
| 4 | Personal access token (PAT, "system access token") | User's scripts | No expiry | **Plaintext** in `users.access_token` | Same dashboard API as #1, minus session-management and step-up actions |
| 5 | Relay API key (`sk-...`) | API clients | Optional expiry | **Plaintext** in `tokens.key` | `/v1/*` relay, token usage endpoints |
| 6 | Security proof (HS256 JWT, `X-Security-Proof`) | Browser, per action | 1 min (`service/auth_token.go:21`) | One-time row in `auth_flows` | Step-up auth for sensitive actions |
| 7 | Flow token (32 random bytes, base64url) | Browser, per ceremony | 5-10 min | HMAC digest in `auth_flows.token_hash` | OAuth state, 2FA login challenge, passkey ceremonies, 2FA setup, email binding |

Layers, top to bottom:

- `router/api-router.go` wires every `/api` route with its middleware chain.
- `middleware/auth.go` classifies the `Authorization` header (dashboard JWT vs PAT vs relay
  key) and enforces the minimum role (`UserAuth`, `AdminAuth`, `RootAuth`).
- `service/auth_token.go` and `service/auth_session.go` issue and validate JWTs, refresh
  tokens, cookies and security proofs.
- `model/user_session.go` and `model/auth_flow.go` are the persistent control plane, with a
  Redis cache that is fenced by versions and tombstones so that a stale cache can never
  re-authorize a revoked session.
- `users.auth_version` is a per-user security counter. Any password, role, status, group or
  second-factor change increments it, which kills every other session.
- Casbin (`service/authz/`) adds fine-grained admin permissions on top of the numeric role.

---

## 1. Registration

### 1.1 Entry points and toggles

| Path | Creates account? | Gatekeepers |
|---|---|---|
| `POST /api/user/register` (`router/api-router.go:77`) | Yes | `RegisterEnabled` and `PasswordRegisterEnabled` (`controller/user.go:218-225`), IP critical rate limit, Turnstile, anonymous body size limit |
| OAuth login callback `GET /api/oauth/:provider` | Yes, if the provider identity is unknown and `RegisterEnabled` | No Turnstile, no email verification (`controller/oauth.go:488-491`) |
| WeChat login `GET /api/oauth/wechat` | Yes, if unknown and `RegisterEnabled` (`controller/wechat.go:94-114`) | No Turnstile |
| Telegram OAuth | Never; the Telegram identity must already be bound (`controller/oauth.go:411-417`) | n/a |
| Passkey | Never; passkeys only attach to an existing account | n/a |
| Admin `POST /api/user/` (`controller/user.go:971-1027`) | Yes | Admin role; can only create roles below its own |
| Setup wizard `POST /api/setup` | Creates the first root | Only while the system is not initialised |

Toggles live in the `options` table and in memory (`common/constants.go:62-71`,
`model/option.go:42-50`): `PasswordLoginEnabled`, `PasswordRegisterEnabled`,
`EmailVerificationEnabled`, `RegisterEnabled`, `TurnstileCheckEnabled`, plus per-provider
enable flags. `RegisterEnabled=false` blocks all self-signup paths including OAuth and
WeChat; `PasswordRegisterEnabled=false` blocks only the password form.

### 1.2 Password registration flow (`controller/user.go:217-335`)

1. Reject if either toggle is off.
2. Decode the body straight into the full `User` struct, then trim the username and
   lower-case/trim the email (`controller/user.go:226-233`).
3. Run struct validation: username max 20 chars, password 8-128, display name max 20, email
   max 50 (`model/user.go:81-88`). There is no minimum username length, no character set, no
   reserved-name list.
4. If email verification is on: require `email` and `verification_code`, check the code
   against the in-memory store, and check the email is not used by any row including
   soft-deleted ones (`controller/user.go:242-259`).
5. Check whether the username (and the email, only when verification is on) exists among all
   rows including soft-deleted ones (`model/user.go:301-323`). Soft-deleted usernames are
   therefore reserved forever.
6. Resolve the inviter: the body field `aff_code` is the inviter's code, not the new user's
   (`controller/user.go:274-275`). Unknown codes are silently ignored.
7. Build a clean user with only username, password, display name = username, inviter, and
   role forced to common user (`controller/user.go:276-285`). This blocks mass assignment of
   role, quota, group and so on. Note: **when email verification is off, the submitted email
   is discarded**, so the account has no email and cannot use password reset.
8. Insert inside a transaction that first takes a per-dialect lock on the normalized email
   (PostgreSQL advisory lock, MySQL `FOR UPDATE` gap lock, SQLite relies on single writer;
   `model/user.go:385-409`), re-checks email availability, hashes the password, gives the
   new-user quota, and generates the user's own 4-character alphanumeric affiliate code
   (`model/user.go:685-709`).
9. After commit: seed a role-based sidebar config, write a "new user bonus" log, and if an
   inviter exists **and** payment compliance has been confirmed, credit the invitee bonus
   and increment the inviter's `aff_count`, `aff_quota`, `aff_history`
   (`model/user.go:711-741`, `model/user.go:582-595`).
10. Optionally create a default relay key: unlimited quota, never expires, group `auto` if
    the default-auto-group setting is on (`controller/user.go:302-328`).
11. Respond `{success:true}`. Registration does **not** log the user in.

### 1.3 Email verification codes (registration)

- `GET /api/verification?email=...&turnstile=...` (`router/api-router.go:44`). Guarded by a
  dedicated limiter of 2 requests per 30 s per IP
  (`middleware/email-verification-rate-limit.go:12-16`) and Turnstile. It does not check
  whether email verification is even enabled.
- Validates the address against the shared email policy: syntax, max 50, optional domain
  whitelist, optional "no `+` or `.` in local part" alias rule (`service/email_binding.go:35-54`).
- If the email is already used it answers "email already taken", which is an account
  enumeration oracle (`controller/misc.go:224-227`).
- The code is the first 6 hex characters of a random UUID (24 bits;
  `common/verification.go:26-33`), valid 10 minutes.
- Codes are kept in a **process-local map** keyed by purpose + email
  (`common/verification.go:21-45`). They are not shared between nodes and are lost on
  restart. Comparison is a plain string equality (`common/verification.go:47-56`). There is
  no attempt counter, and the registration path never deletes the code after use.

### 1.4 Turnstile / captcha (`middleware/turnstile-check.go:15-64`)

Cloudflare Turnstile only. When enabled, the token is read from the **query string**
parameter `turnstile`, posted to Cloudflare's siteverify endpoint together with the secret
and client IP, and the request is rejected unless the answer is `success`. It uses the
default HTTP client (no explicit timeout) and echoes raw network or decode errors back to the
client. Applied to: register, login, verification-code mail, password-reset mail, daily
check-in. Not applied to OAuth, WeChat, passkey or 2FA endpoints.

### 1.5 Affiliate / invite codes

- Every user gets a 4-character alphanumeric `aff_code` (`model/user.go:692`), unique index
  on `users.aff_code`. `GET /api/user/aff` lazily creates one if missing
  (`controller/user.go:439-462`). 62^4 is about 14.8 million codes, easy to enumerate, and a
  random collision would make the insert fail.
- OAuth signups carry the affiliate code inside the OAuth flow payload
  (`controller/oauth.go:33-39`, `controller/oauth.go:524-528`).
- `POST /api/user/aff_transfer` moves earned affiliate quota into the spendable balance under
  a row lock, with a minimum of one currency unit (`model/user.go:597-632`).

### 1.6 First user / root setup (setup wizard)

- On boot `CheckSetup` looks for a `setups` row; if absent but a root user exists, it writes
  the row and marks the system initialised (`model/main.go:93-120`).
- `GET /api/setup` returns `{status, root_init, database_type}` (`controller/setup.go:27-44`).
- `POST /api/setup` is **unauthenticated**. While not initialised, and if no root exists, it
  validates username length (max 12, not trimmed, no minimum), password confirmation and the
  8-128 policy, hashes with the current algorithm and inserts a root user with a large
  starting quota. It then saves "self-use mode" and "demo site" options and writes the
  `setups` row (`controller/setup.go:46-167`). Whoever reaches a fresh instance first becomes
  root.
- A legacy helper that would create `root` / `123456` still exists but has no callers
  (`model/main.go:70-91`).

---

## 2. Login

### 2.1 Password login (`controller/user.go:53-100`)

Request: `{username, password}` or, when transport encryption is on,
`{username, password_encrypted, encryption_key_id}`.

1. Reject if `PasswordLoginEnabled` is off.
2. Optional in-transit password encryption (`PASSWORD_LOGIN_ENCRYPTION_ENABLED`,
   `common/init.go:90`): the browser fetches an RSA-2048 public key from
   `GET /api/user/login/encryption-key` (`controller/user.go:36-51`) and sends either
   RSA-OAEP-SHA256 ciphertext or a v2 envelope (RSA-OAEP wrapped AES-256-GCM key, key id in
   the AAD) (`common/password_crypto.go:102-157`). The private key is generated once and
   stored in its own table, `login_encryption_keys`, so replicas share it
   (`model/password_crypto.go:18-60`). This is defence in depth on top of TLS; it does not
   replace TLS.
3. Look up the user with "username equals input OR email equals input"
   (`model/user.go:1068`). The email side is not normalized in this query, and nothing stops
   one user's username from equalling another user's email; the first row wins.
4. If not found, return immediately (no dummy hash, so response time reveals whether the
   account exists). If found but has no password (OAuth-only), fail. Otherwise verify the
   hash. A disabled account returns the same generic "wrong username or password" message
   (`model/user.go:1058-1083`).
5. Hand over to the shared post-authentication policy `setupLogin` (below).

### 2.2 Shared post-login policy (`controller/user.go:150-215`)

Every primary login method (password, OAuth, WeChat) goes through `setupLogin`:

1. `StartLoginVerification` loads a credential-free verification state for the user
   (status, role, auth version, has password, has TOTP, TOTP locked, has passkey;
   `model/login_verification.go:12-46`).
2. If the user has TOTP and/or a passkey, it creates a `login_verification` flow (5 min,
   bound to the user and the current `auth_version`) and returns a challenge instead of a
   session: `{require_verification:true, flow_token, expires_at, methods:[{method,
   available, reason}]}` (`service/login_verification.go:45-89`).
3. Otherwise it creates the login session directly (`controller/user.go:164-196`).
4. On success `writeLoginResponse` updates `last_login_at`, sets the refresh and hint
   cookies, marks the response `Cache-Control: no-store`, writes a login audit row and returns
   the auth bundle (`controller/user.go:198-215`).

Passkey (usernameless) login skips `setupLogin` and goes straight to session creation,
because the passkey ceremony already required user verification
(`controller/passkey.go:337-441`).

Login response shape (all methods):
`{success, data:{access_token, token_type:"Bearer", access_expires_at, session:{sid, current,
login_method, ip, user_agent, created_at, last_active_at, expires_at}, user:{...}}}`.
The `user` object is a whitelisted DTO without password, PAT or admin remarks
(`controller/user.go:491-523`).

### 2.3 Second step of login

- `POST /api/user/login/verify` (and its alias `/login/2fa`) takes
  `{flow_token, method:"2fa", code}` (`controller/login_verification.go:16-39`). It re-reads
  the flow without consuming it, verifies the TOTP or backup code (a bad code does not
  consume the flow, so the user can retry until the TOTP lockout triggers), and then
  consumes the flow and creates the session in one transaction that also re-checks status,
  auth version and the session caps (`service/login_verification.go:130-189`,
  `model/login_verification.go:52-90`).
- `POST /api/user/login/passkey/begin` and `/finish` do the same with a WebAuthn assertion
  bound to the login flow (`controller/login_verification.go:41-146`).

### 2.4 Password hashing (`common/account_password.go`)

- New hashes: **Argon2id**, memory 19 MiB (19456 KiB), iterations 2, parallelism 1, 16-byte
  random salt, 32-byte key, stored as a standard PHC-style string
  (`common/account_password.go:16-23`, `44-64`). These are the OWASP minimum parameters.
- An env switch `ACCOUNT_PASSWORD_HASH_ALGORITHM=bcrypt` exists only for rolling upgrades;
  in that mode passwords over 72 bytes are refused (`common/account_password.go:48-57`).
- Verification accepts Argon2id (only the exact parameter string the app writes, bounded
  input size, constant-time compare; `common/account_password.go:66-86`) or legacy bcrypt
  (`common/crypto.go:30-36`). Existing bcrypt hashes are **not** re-hashed on login.
- Policy: 8-128 Unicode characters, no normalization, no trimming, no complexity or breach
  check (`common/account_password.go:34-39`).

### 2.5 Rate limiting and brute force

- Global per-IP limit on all `/api`: 360 requests / 180 s (`common/init.go:123-125`).
- "Critical" per-IP limit: 20 requests / 20 min (`common/init.go:131-133`). It is **one
  shared bucket** (mark `CT`) for every route that uses it: login, register, 2FA step, passkey
  login, OAuth state and callback, password reset, refresh and logout
  (`middleware/rate-limit.go:174-179`). Users behind one NAT share the budget; the docs admit
  that even the refresh call eats into it (`docs/authentication.md:9`).
- With Redis the limiter is an atomic fixed window (burst up to 2x at a window edge;
  `middleware/rate-limit.go:17-36`); without Redis it is an in-memory sliding window per node.
  A Redis error fails closed with HTTP 500 (`middleware/rate-limit.go:116-120`).
- Per-user limits (`UserCriticalRateLimit`, same 20 / 20 min, keyed by user id) protect
  step-up verification, PAT generation, account-security email and affiliate transfer
  (`middleware/rate-limit.go:181-230`).
- There is **no per-account login throttle, no lockout, no failed-login counter and no audit
  of failed logins** (the login audit records successes only; `controller/user.go:128-144`).
  The only account-level lockout is for TOTP (5 failures lock 2FA for 5 minutes).
- Client IP comes from Gin with an explicit trusted-proxy list. Unset means loopback and
  private ranges are trusted; `none` means only the TCP peer
  (`middleware/trusted_proxies.go`, `docs/authentication.md:128-136`).

---

## 3. Sessions

### 3.1 Model

- `user_sessions` is the control plane (one row per browser login; `model/user_session.go:42-59`).
  Each row has a UUID `sid`, a per-session `version`, the user's `auth_version` at issue
  time, a status (`active` / `revoking` / `revoked`), the current and previous refresh
  digests, login method, IP, user agent, created / last active / expires timestamps and a
  revoke reason.
- Access tokens are HS256 JWTs with issuer `new-api`, audience `new-api-dashboard`, subject
  = user id, and custom claims `token_use`, `sid`, `uv` (user auth version), `sv` (session
  version), plus `jti`, `iat`, `nbf` and `exp` (`service/auth_token.go:43-83`). Role, status
  and group are deliberately **not** in the token; they are loaded from the user cache on
  every request (`service/auth_token.go:39-41`).
- Signing keys are derived per purpose with HMAC-SHA256 over `SESSION_SECRET`
  (access, security proof, refresh digest, refresh rotation, verification context, flow
  digests, cache keys; `service/auth_token.go:54-58`, `model/auth_flow.go:139-141`).
- `SESSION_SECRET` defaults to a random UUID per process if unset
  (`common/constants.go:35`); only the literal value `random_string` is refused
  (`common/init.go:50-59`). `CRYPTO_SECRET` falls back to `SESSION_SECRET`
  (`common/init.go:60-64`).

### 3.2 Issue (`service/auth_session.go:63-128`)

1. Load the user from cache; require enabled status and a positive auth version.
2. Enforce two caps per user: at most 50 active sessions (409 `AUTH_SESSION_LIMIT`) and at
   most 100 sessions created per 24 h including revoked ones (429
   `AUTH_SESSION_ISSUANCE_LIMIT`). Both are env-tunable
   (`common/constants.go:41-53`, `common/init.go:141-167`).
3. Generate a 64-character random refresh secret, store `HMAC(refresh-key, secret)`, create
   the row with a 30-day expiry, and publish it to the Redis session cache.
4. Return an access token plus the raw refresh token `sid.secret`, which only ever goes into
   the cookie.

### 3.3 Validate on every dashboard request (`middleware/auth.go:47-81`, `158-187`)

1. Read `Authorization`, accept either `Bearer <x>` or a bare single value
   (`middleware/auth.go:189-201`).
2. Parse the token without verifying first. If it carries the dashboard issuer, audience and
   a known `token_use`, it is treated as internal and must fully verify (algorithm pinned to
   HS256, exp required, 5 s leeway; `service/auth_token.go:107-124`, `183-205`). An internal
   token can never fall through to PAT or relay-key handling.
3. Load the session (Redis first, DB on miss) and require: same user, active, not revoked,
   not expired, same session version, same auth version. Then load the user and require
   enabled status and the same auth version (`service/auth_session.go:130-150`).
4. If it is not a dashboard JWT, try it as a PAT (section 4.1).
5. Check status, minimum role and username sanity, then place `id`, `role`, `username`,
   `group`, `session_id`, `auth_version`, `session_version` and a `use_access_token` flag in
   the request context (`middleware/auth.go:203-216`).
6. For admin and root routes, an audit writer wraps the response so every write is logged
   even if the handler forgot (`middleware/auth.go:70-80`).

Error contract: HTTP 401 with codes `AUTH_TOKEN_EXPIRED`, `AUTH_SESSION_REVOKED`,
`AUTH_UNAUTHORIZED`, `AUTH_USER_DISABLED`; 403 `AUTH_INSUFFICIENT_PRIVILEGE`; 500
`AUTH_INTERNAL_ERROR` (`middleware/auth.go:218-233`).

### 3.4 Refresh (`controller/auth_session.go:17-45`, `service/auth_session.go:217-277`)

- `POST /api/user/auth/refresh`, cookie-authenticated. Optional `X-Auth-Session: <sid>`
  header: if it disagrees with the cookie's sid the server answers 409
  `AUTH_SESSION_MISMATCH` and changes nothing.
- The next secret is **derived deterministically** as `HMAC(rotate-key, sid.currentSecret)`
  (`service/auth_session.go:434-436`). Rotation is a compare-and-swap on the current digest
  that moves the old digest into `previous_refresh_hash` with a 30-second grace window
  (`model/user_session.go:459-512`).
- Two tabs refreshing at the same time: the loser sees its digest in the "previous" slot
  within the grace window and, because the successor is deterministic, gets the same new
  token instead of being logged out (`service/auth_session.go:250-258`).
- Reuse detection: a recognised previous digest presented **after** the grace window revokes
  the whole session (`refresh_reuse`). An unknown digest is only rejected, so guessing
  cannot be used to kick a victim out (`model/user_session.go:514-548`).
- Before rotating it re-checks the user row directly in the DB as well as the cache; any
  status or auth-version mismatch revokes the session (`service/auth_session.go:235-247`).
- Invalid or revoked results also clear both cookies.

### 3.5 Cookies and CSRF (`service/auth_session.go:308-384`, `common/session_cookie.go:44-84`)

- Refresh cookie: `HttpOnly`, `SameSite=Strict`, `Path=/api/user/auth`, `Max-Age` equal to
  the session's remaining life, `Secure` only when `SESSION_COOKIE_SECURE=true`.
- Hint cookie: same flags except not HttpOnly and `Path=/`; written and cleared in lockstep.
- CSRF: the dashboard API itself is immune to classic CSRF because it needs a Bearer header
  that only in-memory JS holds. The only cookie-authenticated endpoints are refresh and
  logout; they rely on SameSite=Strict, and in secure mode also on an **Origin guard** that
  requires the `Origin` (or a single well-formed `Referer`) to equal the request's own
  origin or one of the exact HTTPS origins in `SESSION_COOKIE_TRUSTED_URL`
  (`middleware/auth_origin.go:18-76`). Secure mode refuses to start without that list; the
  list is not a CORS whitelist.
- Insecure mode (default) disables the Origin guard entirely and is documented as local
  development only (`docs/authentication.md:96-100`).

### 3.6 How the frontend knows the current user

- Tokens live only in JS memory; nothing is written to Web Storage
  (`docs/authentication.md:70`). `web/src/lib/auth-session.ts` holds the bundle, serialises
  refreshes across tabs with the Web Locks API (lock name for refresh) and broadcasts only
  the sid and login/logout events via BroadcastChannel (storage-event fallback).
- Cold start on public pages reads the hint cookie; if absent it renders anonymously without
  calling refresh. Protected routes and the login page always try refresh
  (`web/src/lib/session-hint.ts`, `docs/authentication.md:72-74`).
- It proactively refreshes when less than 60 s of access-token life remains
  (`web/src/lib/auth-session.ts:421-432`).
- `GET /api/user/self` returns the same DTO plus computed sidebar permissions and the admin
  capability matrix (`controller/user.go:464-486`).
- Every authenticated response carries a constant `Auth-Version` header, used by the frontend
  to detect a server that speaks the new protocol (`middleware/auth.go:204`).
- `New-Api-User` is gone from both backend and frontend (confirmed by search; also
  `docs/authentication.md:146`).

### 3.7 Logout and session management

- `POST /api/user/auth/logout` (`controller/auth_session.go:47-95`): if a valid Bearer is
  present, revoke that session (and clear the cookie if it belongs to the same sid);
  otherwise revoke by refresh cookie, which requires possession of the current digest (or the
  previous one inside the grace window; `model/user_session.go:608-659`). Mismatched sids
  return 409.
- `GET /api/user/sessions` lists active sessions of the current auth version, current first,
  max 100. `DELETE /api/user/sessions/:sid` revokes any own session. `POST
  /api/user/sessions/revoke-others` keeps only the current one (`controller/auth_session.go:97-162`).
  These three refuse PAT callers (`AUTH_SESSION_REQUIRED`).
- Revocation writes a Redis deny tombstone first, then updates the DB row under a row lock,
  then finalises the tombstone (`model/user_session.go:552-603`, `720-782`).

### 3.8 Security version (`auth_version`)

- Incremented inside the same transaction as: password change or reset, role/status/group
  change by an admin, 2FA enable/disable/backup-code regeneration, passkey register/delete,
  account delete (`model/user_auth_cache.go:177-202`, `model/user.go:819-858`).
- When the actor is the user themself, the current session is carried forward to the new
  version (its `version` also increments so old access JWTs die) and a fresh access token is
  returned; every other session is revoked (`service/auth_session.go:174-215`).
- Redis holds a "pending fence" before commit and a "committed floor" after commit per user,
  so a stale cached user snapshot is rejected (`model/user_auth_cache.go:1-229`).
- Email changes and username changes do **not** bump the version.

### 3.9 Cleanup and retention

The master node runs an hourly job that deletes expired sessions (but keeps rows still
inside the issuance window), deletes revoked rows older than 7 days, deletes auth flows 24 h
after expiry or consumption, and logs an alert if more than 5000 sessions were created in the
last hour (`service/auth_cleanup.go:15-51`, `model/user_session.go:784-872`).

Minor observation: on refresh, the new IP and user agent are shown in the response but the
DB row only updates `last_active_at` (`model/user_session.go:485-489`), so the device list
shows the login IP, not the last-seen IP.

---

## 4. API access tokens

There are two different "tokens" for machines. Do not confuse them.

### 4.1 Personal access token (PAT) for the dashboard API

- Generated by `GET|POST /api/user/token`, which requires a security proof for
  `access_token.generate` (`controller/access_token.go:24-49`). Format: standard base64 of
  21-24 random bytes (28-32 chars; `common/utils.go:246-252`). Returned once in the
  response.
- Stored **in plaintext** in `users.access_token` (char(32), unique index) with a creation
  time (`model/user.go:95-96`, `146-160`). One per user; generating replaces the old one.
  Revocation (`DELETE /api/user/token`, also proof-protected) nulls the column
  (`model/user.go:163-177`).
- Validation: any non-JWT `Authorization` value on a dashboard route is looked up with an
  exact DB match, uncached (`model/user.go:1228-1242`). Then the user is loaded from cache
  and the normal status and role checks apply.
- Scope: **full dashboard power of that user**, including every admin or root endpoint if
  the owner is admin or root. It cannot manage login sessions or obtain security proofs,
  because those require a session identity (`middleware/auth.go:118-145`).
- No expiry, no scopes, no IP allowlist. It survives password change and password reset
  (those only touch sessions).
- Each PAT-authenticated request writes an audit row keyed by the SHA-256 fingerprint of the
  PAT, and `GET /api/user/token/status` shows existence, fingerprint, creation time and the
  last-used time and IP (`middleware/audit.go:282-306`, `model/audit_log.go:61-70`,
  `model/audit_log.go:213-233`).

### 4.2 Relay API keys (`tokens` table)

- Format: 48 characters from `[0-9a-zA-Z]` using a CSPRNG (`common/utils.go:229-257`),
  about 285 bits. The `sk-` prefix is presentational: the server strips it. Stored without
  the prefix, **in plaintext**, in `tokens.key` (varchar 128, unique;
  `model/token.go:14-33`).
- The key is not returned on creation (`controller/token.go:278-359`); the UI fetches it with
  `POST /api/token/:id/key` or in bulk with `POST /api/token/batch/keys` (max 100), both
  behind the IP critical limit and audited (`controller/token.go:188-206`, `521-552`). So a
  key can be re-displayed at any time by anyone who holds the dashboard session.
- Per-key controls: name (max 50), status (1 enabled, 2 disabled, 3 expired, 4 exhausted;
  `common/constants.go:245-248`), `expired_time` (-1 = never), `remain_quota` or
  `unlimited_quota`, `used_quota`, model allowlist (`model_limits_enabled` + comma list),
  IP allowlist (`allow_ips`, newline-separated IPs or CIDRs), group, `auto` group list and
  cross-group retry. A per-user maximum token count is enforced at creation.
- Where the key is accepted (`middleware/auth.go:361-404`): `Authorization: Bearer`,
  `x-api-key` on Claude-style paths, `?key=` or `x-goog-api-key` on Gemini model paths,
  `mj-api-secret` for Midjourney, and the WebSocket subprotocol
  `openai-insecure-api-key.<key>` (`middleware/auth.go:482-504`). Anything after the first
  `-` in the key is parsed as a channel id; only admins may pin a channel this way
  (`middleware/auth.go:536-554`).
- Validation order per request (`model/token.go:220-258`, `middleware/auth.go:405-478`):
  find the key (Redis hash first, DB fallback), reject non-enabled status, reject expired or
  exhausted (status is written back to the DB only when Redis is off), check the client IP
  against the allowlist, load the owner from cache and reject disabled users, check the
  token's group is usable by the owner's group and still exists, then place quota, model
  limits and groups in context. The model allowlist is enforced later in the distributor
  (`middleware/distributor.go:57-70`).
- Caching: Redis key is `token:` + HMAC(CRYPTO_SECRET, key), TTL = `SYNC_FREQUENCY`
  (default 60 s). Every mutation first sets a 10-second fence and deletes the hash, so a
  concurrent reader cannot republish a stale snapshot (`model/token_cache.go:12-91`).
  Disabling or deleting a user invalidates all of that user's token caches
  (`model/token.go:484-515`).
- Read-only variant `TokenAuthReadOnly` (used by `/api/usage/token` and `/api/log/token`)
  allows expired or exhausted keys, rejects only disabled keys and disabled users
  (`middleware/auth.go:288-359`).

---

## 5. Password reset and email sending

### 5.1 Reset flow

1. `GET /api/reset_password?email=...&turnstile=...` (IP critical limit + Turnstile). Always
   answers success, which avoids enumeration here (`controller/misc.go:247-278`).
2. If exactly one user has that email (case-insensitive), a token = a full random UUID in hex
   (32 chars) is stored in the **same process-local map** as registration codes, and a mail
   with a link `<ServerAddress>/user/reset?email=<email>&token=<token>` is sent. The base URL
   is the admin-configured server address, not the Host header (good). The email is not URL-
   encoded in the link.
3. `POST /api/user/reset` with `{email, token}` (`controller/misc.go:280-313`): verify the
   token, then the **server generates a new random 12-hex-character password**, stores its
   hash while incrementing `auth_version`, revokes all sessions, deletes the token and
   **returns the new password in the JSON response** for the page to show
   (`model/user.go:1188-1213`). The user never chooses the new password in this flow.
4. The PAT and relay keys are left untouched. 2FA still applies at the next login.

Consequences: resets do not work across multiple nodes or after a restart; the token sits in
URLs (browser history, proxy logs, Referer); the new password is a 48-bit value displayed in
the browser.

### 5.2 Changing the password while logged in

`PUT /api/user/self` with `password` (and `original_password` unless the account has no
password yet) requires a security proof for `account.password.change` or
`account.password.set`. Inside one locked transaction it re-validates the session, the
current password and "new differs from old", writes the hash, bumps `auth_version`, sends a
security notification email and rotates the current session (`controller/user.go:854-902`,
`model/account_security.go:21-58`). The same endpoint without a password updates username
and display name without any step-up (`controller/user.go:903-909`).

### 5.3 Email binding and change (modern flow)

Unlike registration and reset, email binding is fully DB-backed and hardened
(`service/email_binding.go`, `model/email_binding.go`):

- Start requires a security proof bound to `{provider:"email", email}`
  (`controller/email_binding.go:20-56`).
- Codes are 6 decimal digits from a CSPRNG, stored only as bcrypt hashes inside the flow
  payload, valid 10 minutes, resend allowed after 60 s, locked after 5 wrong attempts
  (`model/email_binding.go:11-15`, `service/email_binding.go:151-178`).
- If the account already has an email and the step-up method was only password or OAuth, a
  second code is sent to the **old** address and both must be entered
  (`service/email_binding.go:73`). With TOTP or passkey step-up only the new address is
  verified, and the old address gets a notification instead.
- Completion takes the email lock, re-checks availability and writes the column
  (`model/email_binding.go:101-150`).

### 5.4 SMTP (`common/email.go`)

Settings in `options`: `SMTPServer`, `SMTPPort` (default 587), `SMTPAccount`, `SMTPFrom`,
`SMTPToken` (password), `SMTPSSLEnabled`, `SMTPStartTLSEnabled`, `SMTPInsecureSkipVerify`,
`SMTPForceAuthLogin` (`model/option.go:68-76`). Implicit TLS on port 465 or when SSL is on,
optional STARTTLS, LOGIN auth for Outlook-style servers, NTLM support, and a generated
Message-ID. `GET /api/option/` hides keys ending in Token/Secret/Key
(`controller/option.go:84-100`), but the SMTP password is stored in plaintext in the DB.

Security notifications ("password updated", "account linked", "email changed", etc.) are
sent to the account email after sensitive changes and never contain secrets
(`service/account_security.go:34-41`). Delivery failure is reported to the UI as a warning
but does not roll back the change.

---

## 6. 2FA, passkeys and step-up verification

### 6.1 TOTP (`common/totp.go`, `model/twofa.go`, `model/twofa_enrollment.go`)

- RFC 6238, SHA-1, 6 digits, 30 s period, issuer = system name
  (`common/totp.go:25-34`). Validation uses the library default (one step of skew each way).
- Secret stored in **plaintext** in `two_fas.secret` (`model/twofa.go:14-25`).
- No replay protection: the same code can be used again inside its window; only
  `last_used_at` is recorded (`model/twofa.go:272-298`).
- Lockout: 5 consecutive failures lock the factor for 300 s, updated with a
  compare-and-swap (`common/totp.go:14-22`, `model/twofa.go:84-129`).
- Enrollment (`controller/twofa.go:23-60`, `service/twofa.go:19-66`):
  1. `POST /api/user/2fa/setup` needs a proof for `2fa.setup` (password or OAuth if the user
     has no other factor). The server creates a disabled `two_fas` row plus hashed backup
     codes and a 5-minute session-bound flow, and returns `{secret, qr_code_data,
     backup_codes, flow_token, expires_at}`.
  2. `POST /api/user/2fa/enable` with `{flow_token, code}` checks the code against the
     pending secret (a digest of the secret is kept in the flow so a swapped secret is
     detected), enables the factor, bumps `auth_version` and rotates the session.
- Disable (`POST /api/user/2fa/disable`, proof `2fa.disable`) hard-deletes the factor and
  codes, bumps the version, rotates the session. Admins can force-disable for lower roles and
  all of that user's sessions are revoked (`controller/twofa.go:191-245`).
- `GET /api/user/2fa/status` returns enabled, locked and remaining backup codes.

### 6.2 Backup codes

- 4 codes, format `XXXX-XXXX` from `[A-Z0-9]` (`common/totp.go:14-22`, `64-79`). Generation
  maps a random byte modulo 36, a small bias. Stored as bcrypt hashes, one row each,
  single-use with a compare-and-swap on `is_used` (`model/twofa.go:192-223`).
- Accepted anywhere a TOTP code is accepted. The input is classified first (six digits =
  TOTP, eight alphanumerics = backup code) so one failure counts once
  (`service/security_verification.go:462-486`).
- Regeneration requires a proof for `2fa.backup_codes.regenerate`, which only accepts a real
  TOTP code, not a backup code (`service/security_verification.go:440-444`).

### 6.3 Passkeys / WebAuthn (`controller/passkey.go`, `service/passkey/`)

- Library: go-webauthn. **One passkey per user** (unique index on
  `passkey_credentials.user_id`; `model/passkey.go:23-43`).
- Registration: begin requires a proof for `passkey.register`; the passkey must be
  discoverable (resident key required) and user verification required; the session data and
  the consumed proof authorization are stored in a 5-minute session-bound flow. Finish
  re-validates that authorization, creates the credential, stores the RP ID, bumps
  `auth_version` and rotates the session (`controller/passkey.go:45-214`).
- Usernameless login: `POST /api/user/passkey/login/begin` returns discoverable-login options
  and a flow token; finish resolves the user by credential id, checks the stored RP ID, checks
  the user handle if it parses as a number, requires UV, updates sign count and clone flags,
  and issues a session (`controller/passkey.go:285-441`).
- Multiple RP IDs are supported (current plus legacy domains) with server-chosen selection
  and origin filtering (`service/passkey/service.go:29-158`). If no origins are configured,
  the origin is derived from the Host header and `X-Forwarded-Proto`
  (`service/passkey/service.go:160-253`), which trusts client-supplied headers.
- Delete needs a proof for `passkey.delete`; admins can reset a lower role's passkey, which
  also revokes sessions (`controller/passkey.go:216-248`, `443-490`).

### 6.4 Step-up "secure verification" (security proofs)

This is the most reusable design in the codebase.

- A fixed list of scopes, each with a strict context schema (`service/security_verification.go:17-37`,
  `76-142`): `channel.key.read` {channel_id}, `passkey.register`, `passkey.delete`,
  `2fa.setup`, `2fa.disable`, `2fa.backup_codes.regenerate`, `access_token.generate`,
  `access_token.revoke`, `account.binding.bind` {provider, email or wechat code},
  `account.binding.unbind` {provider_id}, `account.password.set`,
  `account.password.change`, `account.delete`.
- Method policy in one function (`service/security_verification.go:172-221`): if the user has
  TOTP and/or a passkey, only those are allowed; otherwise password, or OAuth re-login if the
  account has no password. Root can never self-delete. Only root can read channel keys.
- Flow: `GET /api/verify/methods?scope=...` lists methods. `POST /api/verify` with
  `{method, scope, context, code | password}` verifies TOTP or password directly; passkey uses
  `/api/user/passkey/verify/begin|finish`; OAuth uses `POST /api/oauth/state` with intent
  `verify` and the provider callback. All produce `{proof_token, expires_at, method, scope}`.
- The proof is a JWT signed with its own derived key, carrying user, sid, user auth version,
  session version, method, the single scope and an HMAC of the normalized context
  (`service/auth_token.go:126-181`). Its `jti` is a one-time `auth_flows` row.
- The protected handler sends the proof in `X-Security-Proof`; the middleware helper checks
  signature, identity, scope and context hash, re-checks the method is still allowed, and
  consumes the row atomically while re-validating the session under lock
  (`middleware/secure_verification.go:39-76`, `service/security_verification.go:348-382`).
  Consumption is committed before the action runs, so a failed action needs a new proof.
- PAT callers can never obtain a proof.

---

## 7. OAuth and third-party login

### 7.1 Providers present

| Provider | Code | Protocol details | Identity column | Can create account |
|---|---|---|---|---|
| GitHub | `oauth/github.go` | Code exchange with client secret, no PKCE; user id = numeric GitHub id; also reads verified emails for a legacy migration (`oauth/github.go:53-205`) | `users.github_id` | Yes |
| Discord | `oauth/discord.go` | Code exchange, no PKCE; `@me` endpoint (`oauth/discord.go:108-153`) | `users.discord_id` | Yes |
| OIDC (one built-in) | `oauth/oidc.go` | Code exchange with client secret, no PKCE, **no ID token validation, no nonce**; identity from the userinfo endpoint; requires `sub` and `email`; ignores `email_verified` (`oauth/oidc.go:51-158`) | `users.oidc_id` | Yes |
| LinuxDO | `oauth/linuxdo.go` | Code exchange; optional minimum trust level (`oauth/linuxdo.go:108-166`) | `users.linux_do_id` | Yes |
| Telegram | `oauth/telegram.go` | Real OIDC: PKCE S256 (verifier kept server-side in the flow), ID token verified against Telegram's JWKS with issuer and audience checks (`oauth/telegram.go:37-185`) | `users.telegram_id` + `external_identity_claims` | No, bind first |
| WeChat | `controller/wechat.go` | Not OAuth: the user sends a code obtained from a WeChat official account; the server asks a separate "WeChat server" to map it to an id (`controller/wechat.go:27-56`) | `users.wechat_id` | Yes |
| Custom providers (any number) | `oauth/generic.go`, table `custom_oauth_providers` | Generic code flow, no PKCE, no ID-token checks; JSON-path field mapping; optional claims-based access policy with custom deny message (`oauth/generic.go:90-287`) | `user_oauth_bindings` | Yes |

The old Telegram login widget endpoints now return 410 Gone (`controller/telegram.go:11-17`).
Custom providers are managed by root at `/api/custom-oauth-provider/*` (including OIDC
discovery fetch); their client secret is never returned (`model/custom_oauth_provider.go:39-67`).
`GET /api/status` publishes client ids, authorization endpoints and enable flags so the SPA
can build authorization URLs (`controller/misc.go:44-176`).

### 7.2 State handling (`controller/oauth.go:47-300`)

1. `POST /api/oauth/state` with `{provider, intent: login|bind|verify, aff?, scope?,
   context?}`. For `bind` the caller must be logged in with a session and present a proof for
   `account.binding.bind`; for `verify` the caller must be logged in. The server stores a
   10-minute `oauth` flow (provider, intent, user and session for bind/verify, affiliate code,
   proof authorization, Telegram PKCE data) and returns the opaque `flow_token`, which is used
   as the OAuth `state`.
2. The SPA redirects (login) or opens a popup (bind/verify) to the provider. The redirect URI
   is fixed to `<ServerAddress>/oauth/<provider>`.
3. The SPA callback page calls `GET /api/oauth/:provider?code=&state=`. The server finds the
   flow by state and provider. For bind and verify, the request must carry a Bearer token
   of the **same user and same session** that started the flow; the popup hands the result
   to its opener via same-origin `postMessage`, and only the opener calls the API
   (`docs/authentication.md:154`).
4. Code exchange and user info, then the flow is consumed atomically (for bind, inside the
   same transaction as the write).

Weakness: for `login` intent the state is not tied to the browser that started it (no cookie
or storage check on the callback page; `web/src/features/auth/lib/oauth-callback-mode.ts`
only remembers a redirect). An attacker can start a login with their own provider account
and send the victim the callback URL, logging the victim into the attacker's account (login
CSRF).

### 7.3 Find-or-create and linking rules (`controller/oauth.go:409-589`)

- Known provider id: log in as the bound user (deleted users are refused).
- Unknown id: **never auto-link by email.** If the provider email is already used by any
  account, login fails with "email already taken" (`controller/oauth.go:512-520`). Good
  against takeover, but it lets someone who controls a provider email squat an address.
- Legacy GitHub bindings that stored the login name are migrated to the numeric id only if
  the account has a second factor (migration is deferred into the login challenge) or one of
  GitHub's verified emails equals the account email (`controller/oauth.go:432-486`).
- New account: username = provider username if free and at most 20 chars, else
  `<provider>_<max user id + 1>`; display name from the provider; email copied from the
  provider without checking verification; role common; affiliate code honoured. Creation and
  binding happen in one transaction (`controller/oauth.go:493-586`).
- Then the normal `setupLogin` policy (2FA/passkey challenge if enrolled).

### 7.4 Binding and unbinding

- Bind: session + proof, provider round trip, reject if the provider id is already bound,
  then in one transaction consume the flow, re-validate the session and write only the one
  binding column (or the binding row for custom providers, or the claims row plus column for
  Telegram) (`controller/oauth.go:357-404`, `model/account_security.go:115-151`,
  `model/external_identity_claim.go:87-109`). A security notification email follows.
- Built-in provider columns only have plain indexes; uniqueness is a check-then-write. Custom
  bindings have real unique indexes (one binding per user per provider, one user per
  provider subject; `model/user_oauth_binding.go:11-17`). Telegram has a dedicated claims
  table with two unique indexes (`model/external_identity_claim.go:21-68`).
- Self unbind exists only for custom providers: `DELETE /api/user/oauth/bindings/:provider_id`
  with a proof for `account.binding.unbind` (`controller/custom_oauth.go:525-568`). It refuses
  to remove the last usable login method, taking into account which methods the admin has
  enabled (`model/account_security.go:70-113`).
- Admins can clear any binding (email, github, discord, oidc, wechat, telegram, linuxdo) of a
  lower-role user with `DELETE /api/user/:id/bindings/:binding_type`
  (`controller/user.go:720-759`, `model/user.go:917-954`), and custom bindings with the
  admin variant of the unbind route. Clearing does not bump `auth_version`.

---

## 8. Roles and authorization

### 8.1 Numeric roles and status (`common/constants.go:193-248`)

- Roles: guest 0, common user 1, admin 10, root 100. Guests cannot pass `UserAuth`.
- Status: enabled 1, disabled 2 (0 is avoided on purpose). Disabled users fail dashboard
  auth (`AUTH_USER_DISABLED`), relay auth and session refresh.
- `UserAuth`, `AdminAuth`, `RootAuth` are the same helper with a minimum role
  (`middleware/auth.go:100-116`). `TryUserAuth` identifies the caller if possible but never
  rejects (`middleware/auth.go:83-98`).

### 8.2 Management rules (`controller/user.go`)

- "Can manage target" = actor is root, or actor role is strictly higher
  (`controller/user.go:382-384`). Admins cannot touch other admins or root.
- `POST /api/user/manage` actions: enable, disable (never root), delete (soft, never root),
  promote to admin (root only), demote to common (never root), add quota
  (`controller/user.go:1053-1190`). Disable/demote bump `auth_version`, revoke sessions and
  invalidate token caches.
- `PUT /api/user/` (admin edit) can change username, display name, group, remark and
  password; it cannot change role (`controller/user.go:649-718`, `model/user.go:880-915`).
  Password or group changes revoke all sessions. The edit always writes the group value it
  receives, so a client that omits it clears the group.
- `DELETE /api/user/:id` hard-deletes the user and all auth data (sessions, flows, 2FA,
  passkeys, tokens, bindings, claims) (`model/user.go:1001-1055`).
- Root cannot be deleted by anyone, including itself.

### 8.3 Fine-grained admin permissions (Casbin)

- A Casbin model with subject, object, action and an allow/deny effect; policies in
  `casbin_rule`, roles in `authz_roles` (`service/authz/enforcer.go:19-31`,
  `model/casbin_rule.go`, `model/authz_role.go`).
- Built-in roles: `root` (superuser, allows everything) and `admin` (baseline grants). The
  mapping from numeric role to Casbin role is fixed: 100 -> root, 10 -> admin, others -> none
  (`service/authz/assignment.go:7-16`, `service/authz/role.go:19-36`).
- Registered resources: `channel` (read, operate, write, sensitive_write, secret_view),
  `audit` (read), `task_plugin` (bind). Admin baseline gets channel read/operate/write only
  (`service/authz/resources_channel.go`).
- Per-user overrides (allow or deny per action) can be set only by root when editing an
  admin; a user-level explicit rule wins over the role baseline
  (`service/authz/resolver.go:10-35`, `controller/user.go:1029-1043`).
- `RequirePermission(p)` is used after `AdminAuth` on channel routes, `GET /api/audit` and
  task plugin options (`middleware/auth.go:235-249`, `router/channel-router.go:21-39`).
- Other nodes reload policies every `SYNC_FREQUENCY` seconds
  (`service/authz/enforcer.go:84-94`).

### 8.4 Groups

- `users.group` (default `default`) is a pricing/routing tier, not a permission. The set of
  groups a user may put on a relay key is the global "usable groups" map, adjusted by
  per-group special rules, and always including the user's own group
  (`setting/user_usable_group.go`, `service/group.go:14-39`).
- Subscriptions can upgrade and later downgrade `users.group`; that refreshes the cache but
  does not log anyone out (`docs/authentication.md:11`).

---

## 9. Security weaknesses and questionable choices

Ordered by how much they matter for a public, paid service.

**High**

1. **Legacy code store for registration and reset** (`common/verification.go`). Codes live in
   a per-process map (breaks on restart and on more than one node), are compared without
   constant time, have no attempt limit, and the registration code is never invalidated.
   The reset token travels in a URL query, and reset ends with a server-chosen 48-bit
   password shown in the response (`controller/misc.go:280-313`). The newer email-binding
   flow in the same codebase already shows the right way (hashed, DB-backed, attempt-limited).
2. **Plaintext bearer secrets at rest.** Relay keys (`tokens.key`) and PATs
   (`users.access_token`) are stored and indexed in clear and can be re-displayed through the
   API. A DB dump or SQL injection leaks every customer key. TOTP secrets
   (`two_fas.secret`) and SMTP / OAuth client secrets in `options` are also in clear.
3. **PAT is an unscoped, non-expiring master key.** For an admin or root it grants the full
   admin API without 2FA, it survives password change and reset, and it is looked up with an
   uncached DB query per request.
4. **Weak login brute-force defence.** Only a per-IP bucket of 20 per 20 minutes, shared with
   refresh, logout, register, OAuth and reset; no per-account throttling, no lockout, no
   failed-login audit; Turnstile is optional. Distributed guessing is unmitigated, while
   honest users behind one NAT can be locked out of refresh.
5. **OAuth hardening gaps.** No PKCE (except Telegram), no ID-token signature/nonce check for
   OIDC and custom providers, login state not bound to the initiating browser (login CSRF),
   and provider emails trusted without `email_verified`.
6. **Unauthenticated setup wizard.** First visitor to a fresh deployment becomes root.
7. **Unsafe secret defaults.** Missing `SESSION_SECRET` silently means a random per-process
   key (all logins die on restart; multi-node breaks); `CRYPTO_SECRET` reuses it by default.

**Medium**

8. **Account enumeration** through registration ("user exists"), the verification-mail
   endpoint ("email taken"), login timing (no dummy hash for unknown users), and the
   username-or-email lookup that is not normalized and can collide across users.
9. **TOTP details:** plaintext secret, no replay prevention within the window, only 4 backup
   codes with slight modulo bias, 5-attempt lockout usable as a nuisance by anyone who knows
   the password.
10. **Uniqueness by convention.** `users.email` and the built-in provider id columns are not
    unique in the schema; correctness depends on dialect-specific locks or check-then-write.
11. **Thin identity rules.** Username max 20 with no minimum, charset or reserved names
    (setup allows 12, OAuth copies provider names). Soft-deleted names and emails stay
    reserved forever. Affiliate codes are 4 characters.
12. **Registration without verification discards the email**, leaving accounts with no
    recovery path.
13. **Email change does not bump `auth_version`** or revoke sessions, although email is the
    password-reset channel.
14. **State-changing GET endpoints:** sending the verification mail, sending the reset mail
    and WeChat login are GETs.
15. **Passkey origin auto-detection** trusts Host and `X-Forwarded-Proto` when origins are
    not configured.
16. **Turnstile token in the query string**, no HTTP timeout, raw errors echoed to clients.

**Low / design debt**

17. Doc drift (Appendix A) and a dead `root/123456` bootstrap helper.
18. Very elaborate Redis fencing (pending fences, committed floors, tombstones, observation
    deadlines). Correct-looking but a large surface; only worth it for multi-node.
19. CORS on key-authenticated read endpoints allows every origin with credentials flag set
    (`middleware/cors.go:9-16`). Harmless for bearer keys, but sloppy.
20. Session rows do not record last-seen IP or user agent after refresh.
21. Mixed delete semantics: self-delete is soft, admin delete is hard.

**Strengths worth copying**

- Short-lived in-memory access JWT plus HttpOnly, SameSite=Strict, path-scoped refresh
  cookie with server-side digest, rotation, grace window and reuse detection.
- Server-side session list with per-device revoke and "log out other devices".
- One security counter (`auth_version`) that invalidates every other session on any
  security change, while the acting session is carried forward.
- Argon2id with verify-time support for legacy bcrypt.
- Scoped, context-bound, single-use step-up proofs with one central method policy.
- A single `auth_flows` table for every short-lived ceremony, hashed tokens, atomic consume.
- No OAuth auto-linking by email; last-login-method guard on unlink; security notification
  emails; audit log for logins, security events and every PAT request.
- Per-user session caps and trusted-proxy configuration.

---

## 10. Auth-related database tables

Types are the GORM declarations. Where the tag has no explicit type, the physical type is the
dialect default for that Go type (for example `varchar(191)` or `longtext` on MySQL, `text`
on PostgreSQL/SQLite for strings). Timestamps are Unix seconds unless noted.

### 10.1 `users` (`model/user.go:79-115`)

| Column | Type | Index | Purpose |
|---|---|---|---|
| id | int PK autoincrement | PK | User id |
| username | string, max 20 (validation) | unique + index | Login name |
| password | string, not null | | Argon2id or bcrypt hash; empty for OAuth-only accounts |
| display_name | string, max 20 | index | Shown name |
| role | int, default 1 | | 0 guest, 1 user, 10 admin, 100 root |
| status | int, default 1 | | 1 enabled, 2 disabled |
| email | string, max 50 | index (not unique) | Account email, lower-cased; uniqueness enforced in code |
| github_id / discord_id / oidc_id / wechat_id / telegram_id / linux_do_id | string | index (not unique) | Built-in provider subjects |
| access_token | char(32), nullable | unique | PAT, plaintext |
| access_token_created_at | bigint, nullable | | PAT creation time |
| quota / used_quota / request_count | int | | Wallet and usage counters |
| group | varchar(64), default `default` | | Pricing tier |
| aff_code | varchar(32) | unique | Own invite code |
| aff_count / aff_quota / aff_history | int | | Invite statistics and earned quota |
| inviter_id | int | index | Who invited this user |
| deleted_at | timestamp, nullable | index | Soft delete |
| setting | text | | JSON user preferences (notifications, sidebar, language) |
| remark | varchar(255) | | Admin note, hidden from self DTO |
| stripe_customer | varchar(64) | index | Payment customer id |
| created_at | int64 autoCreateTime | | Registration time |
| last_login_at | int64, default 0 | | Last successful login |
| auth_version | bigint, not null, default 1 | | Security counter |

Transient (not stored): `verification_code`, `original_password`, `has_password`,
`admin_permissions`.

### 10.2 `user_sessions` (`model/user_session.go:42-59`)

| Column | Type | Index | Purpose |
|---|---|---|---|
| sid | varchar(64) | PK | UUID session id |
| user_id | int, not null | composite (user_id, status, expires_at); composite (user_id, created_at) | Owner |
| version | bigint, default 1 | | Per-session security version (`sv` claim) |
| user_auth_version | bigint | | User `auth_version` at issue/advance (`uv` claim) |
| status | varchar(16) | in both composites + (status, revoked_at) | active / revoking / revoked |
| refresh_hash | char(64) | | HMAC of current refresh secret |
| previous_refresh_hash | varchar(64) | | HMAC of previous secret (race grace, reuse detection) |
| previous_valid_until | bigint, default 0 | | End of grace window |
| login_method | varchar(32) | | password, 2fa, passkey, oauth:github, wechat, ... |
| ip | varchar(64) | | IP at login |
| user_agent | text | | UA at login (truncated to 512) |
| created_at | int64 | (user_id, created_at) | Issue time, used for issuance cap |
| last_active_at | bigint | | Last refresh |
| expires_at | bigint | own index + composite | Absolute expiry (30 days) |
| revoked_at | bigint, default 0 | (status, revoked_at) | Revocation time |
| revoked_reason | varchar(64) | | logout, user_revoked, refresh_reuse, password_changed, ... |

### 10.3 `auth_flows` (`model/auth_flow.go:45-57`)

| Column | Type | Index | Purpose |
|---|---|---|---|
| id | int64 PK | | Also used as the security-proof `jti` |
| token_hash | char(64), not null | unique | HMAC of the flow token or of an external assertion |
| purpose | varchar(32) | composite (purpose, expires_at) | oauth, login_verification, login_passkey, passkey_login, passkey_register, passkey_step_up, 2fa_setup, security_proof, email_binding, telegram_* |
| provider | varchar(64) | | OAuth provider slug |
| intent | varchar(16) | | login / bind / verify |
| user_id | int | index | Bound user |
| session_id | varchar(64) | index | Bound session |
| payload | text | | Server-owned JSON (PKCE verifier, WebAuthn session data, hashed codes, consumed proof) |
| created_at | datetime | | |
| expires_at | datetime, not null | composite | Expiry |
| consumed_at | datetime, nullable | index | One-time consumption marker |

### 10.4 Second factors

`two_fas` (`model/twofa.go:14-25`): id PK; user_id int unique; secret varchar(255)
plaintext; is_enabled bool; failed_attempts int; locked_until datetime; last_used_at
datetime; created_at, updated_at; deleted_at (index).

`two_fa_backup_codes` (`model/twofa.go:28-36`): id PK; user_id int (index); code_hash
varchar(255) bcrypt; is_used bool; used_at datetime; created_at; deleted_at (index).

`passkey_credentials` (`model/passkey.go:23-43`): id PK; user_id int **unique** (one per
user); rp_id varchar(253); credential_id varchar(512) unique (base64); public_key text
(base64); attestation_type; aaguid; sign_count uint32; clone_warning, user_present,
user_verified, backup_eligible, backup_state bools; transports text (JSON); attachment
varchar(32); last_used_at; created_at, updated_at; deleted_at.

### 10.5 External identities

`user_oauth_bindings` (`model/user_oauth_binding.go:11-17`): id PK; user_id int; provider_id
int; provider_user_id varchar(256); created_at. Unique (user_id, provider_id) and unique
(provider_id, provider_user_id).

`custom_oauth_providers` (`model/custom_oauth_provider.go:39-67`): id PK; name varchar(64);
slug varchar(64) unique; icon; enabled; client_id varchar(256); client_secret varchar(512)
(plaintext, never serialised); authorization/token/userinfo endpoints varchar(512); scopes
(default `openid profile email`); user_id/username/display_name/email field paths; well_known;
auth_style (0 auto, 1 params, 2 basic); access_policy text (JSON); access_denied_message;
created_at, updated_at.

`external_identity_claims` (`model/external_identity_claim.go:21-27`): id PK; provider
varchar(32); subject varchar(128); user_id int (index); created_at. Unique (provider,
subject) and unique (provider, user_id). Used for Telegram today.

### 10.6 Machine credentials

`tokens` (`model/token.go:14-33`): id PK; user_id int (index); key varchar(128) unique
(plaintext); status int default 1; name (index); created_time, accessed_time bigint;
expired_time bigint default -1; remain_quota int; unlimited_quota bool;
model_limits_enabled bool; model_limits text (comma list); allow_ips string (newline list);
used_quota int; group string; cross_group_retry bool; auto_groups text (JSON); deleted_at
(index).

PAT: `users.access_token` + `users.access_token_created_at` (above).

### 10.7 Authorization and audit

`authz_roles` (`model/authz_role.go`): id PK; key varchar(64) unique; name varchar(100);
description text; built_in, enabled bool; sort int; created_at, updated_at.

`casbin_rule` (`model/casbin_rule.go`): id PK; ptype, v0..v5 varchar(100); composite index
and composite unique index over all seven. Rows look like
`p, role:admin, channel, read, allow` or `p, user:42, channel, secret_view, deny`.

`audit_logs` (`model/audit_log.go:26-46`, may live in the separate log DB): event_id
varchar(64) unique; user_id and created_at composite index; username (index); actor_role;
category varchar(24) (`login`, `security`, `operation`, `access_token`); action
varchar(128); token_ref varchar(64) (PAT SHA-256 fingerprint; composite with created_at);
auth_method; ip; user_agent varchar(512); method; route; status; success; request_id (index);
content text; other json. Never auto-cleaned.

### 10.8 Configuration and bootstrap

`login_encryption_keys` (`model/password_crypto.go:18-21`): id PK; slot varchar(32) unique
(`active`); private_key_pem text.

`setups` (`model/setup.go`): id PK; version varchar(50); initialized_at bigint.

`options` (key PK, value text): all auth toggles, SMTP settings, OAuth client ids and
secrets, Turnstile keys, passkey settings, invite/new-user quotas, email domain rules.

### 10.9 Redis keys (cache only; DB is authoritative)

`auth:session:<hmac(sid)>` session snapshot or tombstone; `user:<id>` user snapshot;
`auth:user:fence:<id>` pending version; `auth:user:version:<id>` committed floor;
`token:<hmac(key)>` and `token:fence:<hmac(key)>`; `rateLimit:v2:ip:<mark>:<ip>` and
`rateLimit:v2:user:<mark>:<id>`.

---

## 11. Auth-related HTTP endpoints

Auth levels: **none**, **try** (identify if possible), **user**, **admin**, **root**,
**session** (user, and must be a browser session, not a PAT), **proof(scope)** (needs
`X-Security-Proof` for that scope), **key** (relay API key). "CT" = shared per-IP critical
limit (20 / 20 min), "UC:x" = per-user critical limit, "TS" = Turnstile, "EV" = 2 per 30 s
per IP. All responses use the `{success, message, data}` envelope unless noted.

### 11.1 Bootstrap and public info

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/api/setup` | none | | `{status, root_init, database_type}` |
| POST | `/api/setup` | none (only before init) | `{username, password, confirmPassword, SelfUseModeEnabled, DemoSiteEnabled}` | success/message |
| GET | `/api/status` | none | | Public config: auth toggles, OAuth client ids and endpoints, Turnstile site key, passkey RP settings, custom providers, `setup` flag |
| GET | `/api/user/groups` | none | | Usable groups map |

### 11.2 Registration, login, recovery

| Method | Path | Auth / guards | Request | Response |
|---|---|---|---|---|
| GET | `/api/verification` | none, EV, TS | query `email`, `turnstile` | success (mail sent) or "email taken" |
| POST | `/api/user/register` | none, CT, TS | `{username, password, email?, verification_code?, aff_code?}` + query `turnstile` | success only |
| GET | `/api/user/login/encryption-key` | none | | `{enabled, kid?, public_key?}` |
| POST | `/api/user/login` | none, CT, TS | `{username, password}` or `{username, password_encrypted, encryption_key_id}` | Auth bundle + user, or login challenge |
| POST | `/api/user/login/verify` (alias `/login/2fa`) | none, CT | `{flow_token, method:"2fa", code}` | Auth bundle + user |
| POST | `/api/user/login/passkey/begin` | none, CT | `{flow_token, rp_id?}` | `{flow_token, expires_at, options, rp_ids}` |
| POST | `/api/user/login/passkey/finish` | none, CT | `{flow_token, passkey_flow_token, credential}` | Auth bundle + user |
| POST | `/api/user/passkey/login/begin` | none, CT | `{rp_id?}` | `{options, rp_ids, flow_token, expires_at}` |
| POST | `/api/user/passkey/login/finish` | none, CT | `{flow_token, credential}` | Auth bundle + user (or challenge-free) |
| GET | `/api/reset_password` | none, CT, TS | query `email`, `turnstile` | always success |
| POST | `/api/user/reset` | none, CT | `{email, token}` | `data` = new generated password |

### 11.3 Session lifecycle

| Method | Path | Auth / guards | Request | Response |
|---|---|---|---|---|
| POST | `/api/user/auth/refresh` | refresh cookie, Origin guard (secure mode), CT | header `X-Auth-Session?` | `{access_token, token_type, access_expires_at, user, session}`; sets cookies; 401/409 codes |
| POST | `/api/user/auth/logout` | cookie and/or Bearer, Origin guard, CT | header `X-Auth-Session?` | `{revoked_sid, cookie_cleared}` or plain success; clears cookies |
| GET | `/api/user/sessions` | session | | list of session views |
| DELETE | `/api/user/sessions/:sid` | session | | `{revoked_sid, current}` |
| POST | `/api/user/sessions/revoke-others` | session | | `{revoked_count}` |

### 11.4 Profile and account security (all under `/api/user`, user auth unless noted)

| Method | Path | Auth / guards | Request | Response |
|---|---|---|---|---|
| GET | `/self` | user | | user DTO + permissions |
| PUT | `/self` | user, CT; proof(`account.password.change` or `.set`) when changing password | `{username?, display_name?}` or `{password, original_password}` or `{sidebar_modules}` or `{language}` | success; password change returns rotated access token + session |
| DELETE | `/self` | proof(`account.delete`) | | success, cookie cleared |
| PUT | `/setting` | user | notification settings (type, threshold, webhook, email, Bark, Gotify, flags) | success |
| GET | `/aff` | user | | own affiliate code |
| POST | `/aff_transfer` | user, UC:aff-transfer | `{quota}` | success |
| GET | `/token/status` | user | | `{exists, token_ref, created_at, last used}` |
| GET/POST | `/token` | proof(`access_token.generate`), CT, UC:access-token | | `data` = new PAT |
| DELETE | `/token` | proof(`access_token.revoke`), CT, UC:access-token | | success |
| GET | `/2fa/status` | user | | `{enabled, locked, backup_codes_remaining?}` |
| POST | `/2fa/setup` | proof(`2fa.setup`), UC:security-verification | | `{secret, qr_code_data, backup_codes, flow_token, expires_at}` |
| POST | `/2fa/enable` | session, UC:security-verification | `{flow_token, code}` | rotated access token + session |
| POST | `/2fa/disable` | proof(`2fa.disable`) | | rotated access token + session |
| POST | `/2fa/backup_codes` | proof(`2fa.backup_codes.regenerate`) | | rotated token + `backup_codes` |
| GET | `/passkey` | user | | `{enabled, last_used_at?}` |
| POST | `/passkey/register/begin` | proof(`passkey.register`), UC | | `{options, flow_token, expires_at}` |
| POST | `/passkey/register/finish` | session, UC | `{flow_token, credential}` | rotated token + session |
| POST | `/passkey/verify/begin` | session, UC | `{scope, context, rp_id?}` | `{options, flow_token, ...}` |
| POST | `/passkey/verify/finish` | session, UC | `{flow_token, credential}` | security proof |
| DELETE | `/passkey` | proof(`passkey.delete`) | | rotated token + session |
| GET | `/oauth/bindings` | user | | custom-provider bindings |
| DELETE | `/oauth/bindings/:provider_id` | proof(`account.binding.unbind`) | | success |

### 11.5 Step-up verification

| Method | Path | Auth / guards | Request | Response |
|---|---|---|---|---|
| GET | `/api/verify/methods` | session | query `scope` | `{scope, methods, oauth_providers, password_encryption_enabled}` |
| POST | `/api/verify` | session, CT, UC:security-verification | `{method: 2fa or password, scope, context?, code? , password? or password_encrypted + encryption_key_id}` | `{proof_token, expires_at, method, scope}` |

### 11.6 OAuth and bindings

| Method | Path | Auth / guards | Request | Response |
|---|---|---|---|---|
| POST | `/api/oauth/state` | try, CT; session + proof(`account.binding.bind`) for bind | `{provider, intent, aff?, scope?, context?}` | `{flow_token, expires_at, authorization_url?}` |
| GET | `/api/oauth/:provider` | try, CT; same-session Bearer for bind/verify | query `code`, `state`, `error?` | login: auth bundle or challenge; bind: success; verify: security proof |
| GET | `/api/oauth/wechat` | none, CT | query `code` | auth bundle or challenge |
| POST | `/api/oauth/wechat/bind` | user, CT, proof(`account.binding.bind` with code) | `{code}` | success |
| POST | `/api/oauth/email/bind/start` | user, CT, UC:account-security, EV, proof | `{email}` | `{flow_token, email, current_email (masked), old_email_required, expires_at, resend_at}` |
| POST | `/api/oauth/email/bind/resend` | same | `{flow_token}` | same shape |
| POST | `/api/oauth/email/bind` | user, CT, UC | `{flow_token, new_code, old_code?}` | `{notification_warning}` |
| GET/POST | `/api/oauth/telegram/login`, `/bind/start`, `/bind/:flow_token` | | | 410 Gone |

### 11.7 Relay keys and key-authenticated reads

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/token/` , `/search`, `/auto-groups`, `/:id` | user | Keys masked in lists |
| POST | `/api/token/` | user | Create; response has no key |
| PUT | `/api/token/` (`?status_only=1`) | user | Update fields or status |
| DELETE | `/api/token/:id`; POST `/api/token/batch` | user | Delete one or many |
| POST | `/api/token/:id/key`; `/api/token/batch/keys` | user, CT | Reveal full keys (max 100) |
| GET | `/api/usage/token/`, `/api/log/token` | key (read-only mode), CORS, CT | Usage for the presenting key |
| GET | `/dashboard/billing/subscription`, `/usage` (+ `/v1/...`) | key | OpenAI-style billing views |
| * | `/v1/*`, `/v1beta/*`, `/mj/*`, video, task routes | key | Relay |

### 11.8 Admin and root

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/user/`, `/api/user/search`, `/api/user/:id` | admin | List, search, read (lower roles only for read) |
| POST | `/api/user/` | admin | Create user (role below own; root may set admin permissions) |
| PUT | `/api/user/` | admin | Edit username, display name, group, remark, password |
| POST | `/api/user/manage` | admin | `{id, action, value?, mode?}` enable, disable, delete, promote, demote, add_quota |
| DELETE | `/api/user/:id` | admin (strictly higher role) | Hard delete |
| DELETE | `/api/user/:id/reset_passkey`, `/api/user/:id/2fa` | admin | Remove factor, revoke sessions |
| GET | `/api/user/2fa/stats` | admin | Adoption numbers |
| GET/DELETE | `/api/user/:id/oauth/bindings[/:provider_id]` | admin | Custom bindings |
| DELETE | `/api/user/:id/bindings/:binding_type` | admin | Clear built-in binding or email |
| GET | `/api/audit` | admin + `audit.read` | All audit logs (root rows hidden); `/api/audit/self` for users |
| GET | `/api/authz/catalog` | admin | Permission catalog |
| POST | `/api/channel/:id/key` | root + proof(`channel.key.read`) | Reveal upstream channel key |
| GET/PUT | `/api/option/`, PUT `/api/option/passkey/domains` | root | Auth and SMTP settings |
| * | `/api/custom-oauth-provider/*` | root | Manage custom providers, OIDC discovery |

---

## 12. Recommendations for VENOM

### 12.1 Scope reminder (from the owner)

Nothing auth-related is built in the current phase. The current phase is a local database
and logging layer for the Electron desktop admin app, which is single-user and local. The
study exists so that today's schema does not block a **future hosted site** that sells
venom-lite / venom-pro / venom-max subscriptions and issues API keys. So this section gives
(a) a concrete target schema for that future server, and (b) a clear answer about what the
desktop DB should hold now.

### 12.2 What the desktop DB should hold now

**Recommendation: no auth tables and no stored identity in the desktop DB now.**

Reasons:

- The app is single-user and local. The OS account already is the identity. A local password
  would protect nothing that disk access does not already expose, and it adds a
  forgotten-password support problem.
- Any auth table created now would be designed without the real server's requirements and
  would later need a migration anyway.
- The risky data in the desktop app today are upstream provider API keys. Protect those with
  OS-level encryption (Electron `safeStorage`, which uses DPAPI on Windows) rather than with
  an app login.

What to do now so the future is easy:

1. **Add one tiny `app_meta` key/value table** (for example `schema_version`,
   `installation_id` = a random UUID generated once, `created_at`). The installation id is
   useful later for pairing the desktop app with a hosted account or licence, and it is not a
   secret.
2. **Keep an `actor` column in the local log/audit tables** (text, default `local`). When the
   app later signs in to the hosted service, the same column can carry the remote user id,
   with no schema change.
3. **Use the same conventions the server will use**: integer Unix-seconds or ISO-8601 UTC
   timestamps consistently, text ids that can hold UUIDs, `created_at` / `updated_at` on every
   table, and a migrations table. These are cheap now and avoid a painful mapping later.
4. **Reserve, do not create,** a future `remote_account` table (desktop side) that would store
   only: remote user id, display email, the server's refresh credential encrypted with
   `safeStorage`, and last sync time. Create it only when the hosted login exists. Never store
   the user's password locally.

If the owner still wants a local lock screen later, make it an optional OS-backed unlock
(Windows Hello via the OS, or a passphrase that derives the `safeStorage`-independent key),
not a users table.

### 12.3 Keep (ideas worth reproducing on the hosted server)

- Short-lived access token in memory plus an HttpOnly, Secure, SameSite=Strict refresh cookie
  scoped to the refresh path; server stores only a keyed hash of the refresh secret; rotate on
  every refresh with a short grace window; revoke the whole session on reuse of a known old
  secret.
- A server-side `sessions` table with a device list, "revoke this device" and "log out
  everywhere else", and per-user caps on active and newly issued sessions.
- A per-user `auth_version` counter included in tokens; bump it on password, role, status,
  plan-tier-sensitive or second-factor changes; carry only the acting session forward.
- Role, status and plan are never trusted from the token; they are loaded per request (cache
  allowed with explicit invalidation).
- Argon2id for passwords (at least m=19 MiB, t=2, p=1), with a stored parameter string so
  parameters can be raised later, plus rehash-on-login when parameters change.
- One `auth_flows` (one-time token) table for OAuth state, 2FA login challenge, passkey
  ceremonies, email verification and password reset, storing only a keyed hash, a purpose, an
  expiry and a consumed marker, consumed atomically.
- Step-up verification: scoped, context-bound, single-use proofs required for password
  change, email change, 2FA changes, passkey changes, API key reveal/creation (if keys are
  ever re-displayable), account deletion and payout-like actions.
- Never auto-link OAuth accounts by email; require an explicit, logged-in, step-up bind; block
  unlinking the last login method.
- Security notification emails for every credential change, and an append-only audit table
  that records successes **and failures**.
- Generic error messages on login, and "always success" on reset requests.

### 12.4 Change (do it better than new-api)

1. **Hash all bearer secrets at rest.** API keys: format `vr_<env>_<keyid>_<secret>` (or
   similar), where `keyid` is a short public identifier used for lookup and display, and
   only `sha256(secret)` (fast hash is fine for 256-bit random secrets) plus the last 4
   characters are stored. Show the full key once at creation; never re-display. Same for any
   personal/admin token.
2. **Replace the PAT with scoped API keys.** One `api_keys` table serves both relay use and
   automation, with a `scopes` column (for example `relay`, `usage:read`, `account:read`),
   optional expiry, optional IP allowlist, and never an admin scope for customer accounts.
   Admin automation, if needed, uses separate short-lived admin keys that require 2FA to mint.
3. **Password reset done properly:** DB-backed token (32 random bytes, stored hashed), 30-60
   minute expiry, single use, token in the URL fragment or a POST form rather than the query
   string if possible; the user chooses the new password; on success bump `auth_version`,
   revoke all sessions, optionally prompt to rotate API keys, send a notification.
4. **Email verification codes** stored hashed in `auth_flows` with an attempt counter (5),
   resend cooldown and expiry. Registration always stores the email; accounts cannot be
   created without a verified email (the paying customer needs a recovery channel and
   receipts).
5. **Brute-force defence per account and per IP:** progressive delay or temporary lock per
   account after N failures, per-IP limits separate per endpoint (login, register, reset,
   refresh must not share one bucket), failed-login audit, a dummy hash on unknown users to
   flatten timing, Turnstile always on for register and on login after a few failures.
6. **OAuth:** authorization code + PKCE for every provider, state bound to the initiating
   browser (a short-lived HttpOnly cookie holding a hash of the state), `nonce` and full ID
   token verification for OIDC providers (issuer, audience, signature, expiry), accept a
   provider email only when `email_verified` is true, and store provider subjects in one
   `oauth_identities` table with real unique constraints.
7. **Encrypt secrets at rest** that must be recoverable: TOTP secrets, OAuth client secrets,
   SMTP password, payment webhook secrets. Use an application key-encryption key from the
   environment (AES-256-GCM with a key id column for rotation).
8. **TOTP:** store the last accepted time step to block replay, 10 backup codes of at least 10
   characters generated without modulo bias, stored with a slow hash, and a lockout that slows
   down rather than fully blocks.
9. **Fail fast on missing secrets:** refuse to start without the session/JWT secret and the
   encryption key; use separate keys per purpose (derive with HKDF from one master if
   desired).
10. **First-admin bootstrap:** never an open setup page. Create the first admin from a CLI
    command or a one-time setup token printed to the server log / provided by env, which is
    deleted after use.
11. **Normalize identities:** unique lower-cased email (a functional unique index or a stored
    `email_normalized` column), usernames with a minimum length, an allowed charset and a
    reserved list, and login by email only (or username only), never "either" in one query.
12. **Bump `auth_version` on email change** and on OAuth link/unlink as well.
13. **Use POST for every state-changing or mail-sending endpoint** and put captcha tokens in
    the body.
14. **Consistent deletion:** soft-delete with anonymisation after a retention period
    (GDPR-friendly), releasing the email and username only after that period.

### 12.5 Skip (not worth it for VENOM)

- Redis fencing machinery (pending fences, committed floors, observation deadlines). A
  single-region server with one Postgres can validate sessions with a primary-key lookup, or
  a small in-process cache with a 30-60 s TTL plus explicit invalidation. Add Redis only when
  there are several app nodes.
- In-browser RSA password encryption (TLS already covers it).
- Casbin per-user overrides. VENOM needs at most three roles (customer, support, owner) with a
  hard-coded permission map. Add a `role_permissions` table only if staff roles grow.
- WeChat, LinuxDO, Telegram and the generic custom-provider engine. Start with email+password
  and one or two mainstream providers (Google, GitHub). Keep the `oauth_identities` table
  generic so more can be added.
- Legacy GitHub login-name migration, legacy bcrypt write mode, the hint cookie (optional
  nicety), and multi-RP-ID passkey support.
- WebAuthn-as-primary login can wait; TOTP first, passkeys second, but design the tables now.

### 12.6 Target schema for the future hosted server

PostgreSQL types shown. `timestamptz` everywhere; ids are `uuid` (or `bigint` identity if
the owner prefers). Every table has `created_at timestamptz not null default now()`.
"KEK-encrypted" means AES-256-GCM with an application key, plus a `key_id` for rotation.

**users**

| Column | Type | Constraint | Notes |
|---|---|---|---|
| id | uuid | PK | |
| email | text | not null | As entered, for display |
| email_normalized | text | not null, **unique** | Lower-cased and trimmed |
| email_verified_at | timestamptz | null | Required before purchases |
| username | text | null, unique (case-insensitive) | Optional handle; 3-24 chars `[a-z0-9_-]`, reserved list |
| display_name | text | null | |
| password_hash | text | null | Argon2id PHC string; null = OAuth/passkey-only account |
| role | text | not null default `customer`, check in (`customer`,`support`,`owner`) | |
| status | text | not null default `active`, check in (`active`,`suspended`,`deleted`) | |
| auth_version | bigint | not null default 1 | Bumped on any security change |
| last_login_at | timestamptz | null | |
| referral_code | text | unique | 8+ chars, CSPRNG, no ambiguous letters |
| referred_by | uuid | FK users(id) null | |
| stripe_customer_id | text | unique null | Payment customer |
| deleted_at | timestamptz | null | Soft delete; anonymise after retention |
| updated_at | timestamptz | not null | |

**sessions**

| Column | Type | Constraint | Notes |
|---|---|---|---|
| id | uuid | PK | Session id (`sid` claim) |
| user_id | uuid | FK users on delete cascade, index (user_id, status, expires_at) | |
| version | bigint | not null default 1 | `sv` claim |
| user_auth_version | bigint | not null | `uv` claim |
| status | text | check in (`active`,`revoked`) | |
| refresh_hash | bytea/char(64) | not null | HMAC of current refresh secret |
| previous_refresh_hash | bytea/char(64) | null | Grace and reuse detection |
| previous_valid_until | timestamptz | null | |
| login_method | text | not null | password, google, github, passkey, ... |
| created_ip / last_ip | inet | | Track both |
| user_agent | text | | Truncated |
| last_active_at | timestamptz | not null | |
| expires_at | timestamptz | not null, index | Absolute cap (e.g. 30 days) |
| idle_expires_at | timestamptz | null | Optional idle timeout |
| revoked_at / revoked_reason | timestamptz / text | null | |

**auth_flows** (one-time tokens: OAuth state, login challenge, email verify, password
reset, passkey ceremony, step-up proof)

| Column | Type | Constraint | Notes |
|---|---|---|---|
| id | bigint identity | PK | Proof `jti` |
| token_hash | char(64) | **unique** | HMAC of the random token |
| purpose | text | not null, index (purpose, expires_at) | Enumerated in code |
| user_id | uuid | FK null, index | |
| session_id | uuid | FK null | For session-bound flows |
| provider / intent | text | null | OAuth |
| payload | jsonb | null | Server-owned data (hashed codes, PKCE verifier, WebAuthn data) |
| attempts | int | not null default 0 | Wrong-code counter |
| expires_at | timestamptz | not null | |
| consumed_at | timestamptz | null | Atomic `UPDATE ... WHERE consumed_at IS NULL` |

**oauth_identities**

| Column | Type | Constraint | Notes |
|---|---|---|---|
| id | uuid | PK | |
| user_id | uuid | FK users on delete cascade | |
| provider | text | not null | `google`, `github`, ... |
| subject | text | not null | Provider's stable user id |
| email_at_link | text | null | For support only |
| linked_at / last_login_at | timestamptz | | |
|  |  | **unique (provider, subject)**, **unique (user_id, provider)** | One account per identity, one identity per provider per user |

**mfa_totp**

| Column | Type | Constraint | Notes |
|---|---|---|---|
| user_id | uuid | PK, FK | One TOTP per user |
| secret_ciphertext | bytea | not null | KEK-encrypted |
| key_id | text | not null | KEK version |
| enabled_at | timestamptz | null | Null while pending |
| last_used_step | bigint | null | Replay protection |
| failed_attempts | int | default 0 | |
| locked_until | timestamptz | null | |

**mfa_recovery_codes**: id, user_id (FK, index), code_hash (Argon2id or bcrypt), used_at
null. Regenerating deletes the old set.

**passkeys** (design now, build later): id uuid PK; user_id FK index; credential_id bytea
**unique**; public_key bytea; sign_count bigint; transports text[]; aaguid uuid;
backup_eligible, backup_state bool; name text; last_used_at. Allow several per user.

**api_keys** (replaces both new-api `tokens` and the PAT)

| Column | Type | Constraint | Notes |
|---|---|---|---|
| id | uuid | PK | |
| user_id | uuid | FK users on delete cascade, index | |
| key_prefix | text | not null, **unique** | Public lookup id shown in UI, e.g. `vr_live_ab12cd34` |
| secret_hash | char(64) | not null | SHA-256 of the secret part |
| last4 | char(4) | not null | Display only |
| name | text | not null | |
| scopes | text[] | not null default `{relay}` | Checked per route |
| status | text | check in (`active`,`disabled`,`revoked`) | |
| expires_at | timestamptz | null | |
| allowed_ips | cidr[] | null | Optional allowlist |
| allowed_models | text[] | null | Optional model allowlist |
| spend_limit | bigint | null | Per-key cap in the smallest billing unit |
| spent | bigint | not null default 0 | |
| last_used_at / last_used_ip | timestamptz / inet | | Updated asynchronously |
| revoked_at | timestamptz | null | |

**plans** (venom-lite / pro / max): id text PK (`lite`,`pro`,`max`); name; price_cents int;
currency char(3); interval text check (`month`,`year`); included_quota bigint;
rate_limit_rpm int; max_api_keys int; allowed_models text[] or a join table; stripe_price_id
text unique; is_active bool; sort int.

**subscriptions**

| Column | Type | Constraint | Notes |
|---|---|---|---|
| id | uuid | PK | |
| user_id | uuid | FK users, index | |
| plan_id | text | FK plans | |
| status | text | check in (`trialing`,`active`,`past_due`,`canceled`,`expired`) | Mirrors the payment provider |
| provider | text | not null | `stripe`, ... |
| provider_subscription_id | text | **unique** | Idempotent webhook upserts |
| current_period_start / current_period_end | timestamptz | not null | |
| cancel_at_period_end | bool | default false | |
| quota_total / quota_used | bigint | not null default 0 | Reset each period |
| canceled_at / ended_at | timestamptz | null | |
|  |  | partial unique index on (user_id) where status in (`trialing`,`active`,`past_due`) | At most one live subscription per user |

**payment_events** (webhook idempotency): id; provider; provider_event_id **unique**; type;
payload jsonb; received_at; processed_at. new-api's `subscription_orders` uses a unique
`trade_no` for the same purpose (`model/subscription.go:214-228`).

**audit_log** (append-only): id bigint identity; occurred_at; actor_user_id null; actor_role;
target_user_id null; category (`login`,`security`,`admin`,`api_key`,`billing`); action;
success bool; ip inet; user_agent; request_id; details jsonb (never secrets). Index
(actor_user_id, occurred_at) and (category, occurred_at). Include failed logins.

**settings** (server config, non-secret) and **secrets** (KEK-encrypted values with key_id),
kept separate so a settings dump never contains credentials.

Rules that tie these together:

- Every session JWT carries `sub`, `sid`, `uv`, `sv`; a request is valid only if the session
  row is active with the same `sv` and `uv` and the user is active with the same
  `auth_version`.
- Plan changes do not bump `auth_version` (they are not a security event), matching
  new-api's choice (`docs/authentication.md:11`); entitlements are read per request from the
  live subscription.
- Relay requests authenticate with `api_keys` only; dashboard requests with sessions only;
  the two never cross.

### 12.7 Suggested build order for the hosted site (later phase)

1. users + sessions + auth_flows + audit_log, email+password with verified email, reset.
2. api_keys (hashed) + plans + subscriptions + payment_events.
3. TOTP + recovery codes + step-up proofs.
4. One or two OAuth providers with PKCE.
5. Passkeys.

---

## Appendix A. Documentation vs code differences

| `docs/authentication.md` says | Code does |
|---|---|
| Security proof valid 5 minutes (line 156) | 1 minute (`service/auth_token.go:21`) |
| Telegram binding uses a widget callback with a path `flow_token` and one-time widget assertions (line 154) | Widget endpoints return 410 Gone; Telegram uses OIDC + PKCE (`controller/telegram.go:11-17`, `oauth/telegram.go`) |
| First passkey registration without 2FA needs no proof; finish must carry the proof again (line 164) | Begin always requires a proof (password/OAuth if no factor); finish re-validates the stored authorization instead of a header (`controller/passkey.go:60`, `179`) |
| Scope list names only three proof scopes (lines 156-160) | Thirteen scopes exist (`service/security_verification.go:17-37`) |

## Appendix B. Relevant environment variables

`SESSION_SECRET`, `CRYPTO_SECRET`, `SESSION_COOKIE_SECURE`, `SESSION_COOKIE_TRUSTED_URL`,
`TRUSTED_PROXIES`, `PASSWORD_LOGIN_ENCRYPTION_ENABLED`, `ACCOUNT_PASSWORD_HASH_ALGORITHM`,
`USER_SESSION_ACTIVE_LIMIT`, `USER_SESSION_ISSUANCE_LIMIT`,
`USER_SESSION_ISSUANCE_WINDOW_SECONDS`, `USER_SESSION_REVOKED_RETENTION_DAYS`,
`USER_SESSION_HOURLY_ALERT_THRESHOLD`, `SYNC_FREQUENCY`, `GLOBAL_API_RATE_LIMIT*`,
`CRITICAL_RATE_LIMIT*`, `SEARCH_RATE_LIMIT*`, `SMTP_STARTTLS_ENABLE`,
`SMTP_INSECURE_SKIP_VERIFY`, `LINUX_DO_USER_ENDPOINT`, `NODE_TYPE` (master runs cleanup and
policy seeding), `REDIS_CONN_STRING`.

## Appendix C. Things not determined

- Runtime behaviour was not observed (the source was not run), so timing and cache effects
  are inferred from code.
- Exact physical column types on each database for fields without an explicit GORM type.
- Whether GitHub's public `email` field is always verified (external behaviour; the code
  itself treats it as unverified only for the legacy migration).
- The full React UX (screens, copy, error handling) beyond the auth-session library and the
  OAuth callback helpers that were checked.
