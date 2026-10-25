# Muse AI — Provider Reference

Main reference for adding Muse AI as a venom-router provider. Muse is served
by a **local bridge** (MuseBridge) that drives the muse.ai web client in a
real browser, handles login automatically, keeps the session alive, and
exposes an OpenAI-compatible API on `127.0.0.1`. The app talks to the
bridge like any other provider.

Evidence, by kind:

- **LIVE (2026-10-20)** — a running bridge on `127.0.0.1:8787` was
  probed from this machine: `/health` (`ok: true, browser: up, loggedIn:
  true`), `/v1/models` (`muse`, `muse-agent`), `/admin/usage` (plan "Muse
  مجاني", weekly 2%, 1B tokens left), and a full chat round-trip
  (200, reply in ~20s).
- **SRC** — `MuseBridge/src/*.mjs` (the bridge's own source: `auth.mjs`
  session handling, `usage.mjs` quota mapping, `server.mjs` route table,
  `browser.mjs` worker pool).
- **DOC** — Meta's own documentation (`https://dev.meta.ai/docs/`), read
  2026-10-20.

No real key, token or account value is stored in this repo.

## 0. Summary (ملخص)

| Field (الحقل) | Value (القيمة) |
|---|---|
| Provider name (اسم المزود) | Muse AI |
| Provider URL (رابط المزود) | https://muse.ai/ — served locally by the MuseBridge on `127.0.0.1:8787` |
| API base (قاعدة الـ API) | `http://127.0.0.1:8787` (the bridge's default) |
| Icon URL (مسار الأيقونة) | `src/assets/providers/muse.png` — in repo (the official Muse mark) |
| Provider type (نوع المزود) | API KEY — the bridge's own API key, entered once |
| Type color dot (لون النوع) | API key (var(--type-apikey)) |
| Consumption (الاستهلاك) | weekly % used + additional tokens (1B free, never expires) |
| Plans (الخطط) | `Muse مجاني` (free) — the bridge reports the tier name |
| Key-fetchable: plan/quota/reset/expiry (بالمفتاح) | Yes — all of it, from `/admin/usage` |
| Needs web session (يحتاج جلسة ويب) | The bridge handles it automatically (credentials in its `.env`) |

## 1. Overview

The MuseBridge is a local OpenAI-compatible gateway. It drives a real
Chromium tab against muse.ai (the chat channel is a Noise-encrypted
WebSocket, so the browser is the only stable transport), keeps the session
alive over plain HTTP via `/api/session`, and rotates the short-lived
cookies. The app never sees a Muse session cookie — it only sees the
bridge's own API key.

### Endpoints the app uses

| Method | Path | What it returns |
|---|---|---|
| `GET` | `/health` | `{ ok, browser, loggedIn, ... }` — whether the bridge is up and signed in |
| `GET` | `/v1/models` | `{ data: [{ id: "muse" }, { id: "muse-agent" }] }` |
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat (streaming + non-streaming) |
| `GET` | `/admin/usage` | plan, tier, weekly %, tokens left, invite |
| `GET` | `/admin/refresh` | force a session refresh |
| `GET` | `/admin/logs` | bridge logs (for diagnostics) |

### Models (LIVE)

- `muse` — Muse Spark 1.3
- `muse-agent` — Muse Spark 1.3 (agent variant)

## 2. Auth

The bridge authenticates with a simple API key (`MUSE_API_KEY` in its
`.env`). The app stores that key encrypted, like any other provider key,
and sends it as `Authorization: Bearer <key>`. The bridge validates it with
a constant-time digest comparison.

The bridge handles the Muse account login itself: it reads `MUSE_EMAIL` and
`MUSE_PASSWORD` from its `.env`, drives the login flow in its Chromium tab,
and re-logs in automatically when the session is lost. The app never sees
the Muse account credentials.

## 3. Verified endpoints

### 3.1 GET /health (no auth)

```json
{ "ok": true, "uptimeSec": 914, "browser": "up", "loggedIn": true, "queue": 0, "active": 0, "model": "muse" }
```

### 3.2 GET /v1/models (auth: Bearer <bridge key>)

```json
{ "object": "list", "data": [
  { "id": "muse", "object": "model", "created": 1792509432, "owned_by": "muse.ai" },
  { "id": "muse-agent", "object": "model", "created": 1792509432, "owned_by": "muse.ai" }
] }
```

### 3.3 POST /v1/chat/completions (auth: Bearer <bridge key>)

OpenAI-compatible request and response, streaming and non-streaming. Verified
with a full round-trip: 200, reply in ~20s.

### 3.4 GET /admin/usage (auth: Bearer <bridge key>)

```json
{
  "plan": "Muse مجاني",
  "tier": { "id": "hatch_free", "code": "HATCH_FREE", "name": "Muse مجاني", "isPaid": false, "rank": 0 },
  "state": "METERED",
  "quotaStatus": "SUFFICIENT",
  "weekly": { "percent": 2, "resets": "2026-10-26", "resetsAt": 1793057551, "resetsInSeconds": 547202, "label": "2% مستخدَمة" },
  "tokens": { "percent": 0, "left": "1B", "balanceCredits": 40000000, "totalCredits": 40000000, "label": "0% مستخدَمة (تبقى 1 مليار رمز)" },
  "invite": { "code": "D6XPL9", "link": "https://muse.ai/join", "maxUses": 30, "useCount": 0, "usesRemaining": 30, "state": "eligible", "redeemed": true },
  "fetchedAt": "2026-10-20T15:32:29.157Z",
  "source": "hatch-api"
}
```

The usage is a percentage used and the tokens left — never a count of what
was spent. The bridge reads it from `hatch-api.meta.ai` using the account's
session cookies, so the app never touches a session cookie.

### 3.5 GET /admin/refresh (auth: Bearer <bridge key>)

Forces a session refresh: rotates the short-lived cookies and wakes the VM
if needed.

## 4. Rate limits + errors

- The bridge reports an exhausted allowance as a 402 with the reset time in
  the message. The app recognises this (`readQuotaError`) and holds the key
  out until the reset.
- A rate limit (429) is **not** a spent allowance and must not hold the key
  out — the two are different things.
- The weekly window and the additional tokens are separate: an account can
  be refused by one and still serve the other.

## 5. How the app implements it

`src/renderer/providers/muse.js` is the built-in adapter (the twelfth one).
It registers itself; nothing imports it.

```js
window.INTEGRATED_PROVIDERS.muse = {
  meta: {
    id: 'muse', name: 'Muse AI', baseUrl: 'http://127.0.0.1:8787',
    color: '#016fea', logo: '../assets/providers/muse.png',
    modelsEndpoint: '/v1/models', chatEndpoint: '/v1/chat/completions',
    auth: ['apikey'],
    planNote: 'Served by the MuseBridge on 127.0.0.1:8787',
    docsSource: 'MUSE.md §0',
  },
  async fetchKeyUsage({ baseUrl, apiRequest }) { /* reads /admin/usage */ },
  readQuotaError({ code, status, message }) { /* recognises 402 */ },
};
```

- **`auth: ['apikey']`** — a normal key, like every other provider. The
  user enters the bridge's API key once, and the app stores it encrypted.
- **`fetchKeyUsage`** reads the account's usage from the bridge's
  `/admin/usage`, with the bridge's API key asked for as the `venomkey:<id>`
  placeholder — main swaps the real key in, and only for the bridge's own
  origin. The weekly limit is the headline; the additional tokens are listed
  beside it.
- **No `fetchModels`.** The default discovery asks `/v1/models` with the
  key, exactly as it does for any other provider.
- **No OAuth flow.** The bridge handles login, session and refresh. The app
  never sees a Muse session cookie.
- Logo: `src/assets/providers/muse.png`. The script is loaded from
  `src/renderer/index.html` before `app.js`; the built-in count asserted by
  the live checks is **thirteen**.

**Prerequisite:** the MuseBridge must be running on `127.0.0.1:8787` (or
wherever the provider's base URL points). The app checks `/health` to
confirm the bridge is up and signed in.

**Accept:** `npm test` then `npm run verify:live`.

**Traps:** the bridge must be running for the provider to work (§5); the
usage is a percentage and the tokens left, never a count spent (§3.4); a
rate limit is not a spent allowance (§4).

## 6. Account & Quota (Raw → normalized)

| Router field | Raw source | Value observed |
|---|---|---|
| PLAN | `tier.name` on `/admin/usage` | `Muse مجاني` (free) |
| QUOTA | `weekly.percent`, `tokens.percent` | A percentage of the window used |
| RESET TIME | `weekly.resetsAt` (Unix seconds) | Shown as "Resets in …" |
| EXPIRY | — | — |
| TOKENS LEFT | `tokens.left` | `1B` (additional tokens, never expire) |
| NAME / EMAIL | — | The bridge does not expose the account email |
