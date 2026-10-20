# DarkAPI — Provider Reference

Reference for the Dark API provider as the app implements it.
Evidence: live probes 2026-10-11 (models / chat / streaming /
billing discovery / errors). Site: `https://darkapi.dev`,
docs: `https://darkapi.dev/docs`.
No real key value is stored in this repo — use `$DARKAPI_KEY`.

## 0. Summary (ملخص)

| Field (الحقل) | Value (القيمة) |
|---|---|
| Provider name (اسم المزود) | Dark API |
| Provider URL (رابط المزود) | https://darkapi.dev |
| API base (قاعدة الـ API) | https://darkapi.dev/v1 |
| Icon URL (مسار الأيقونة) | `src/assets/providers/darkapi.svg` — in repo |
| Provider type (نوع المزود) | API KEY (Bearer only) |
| Type color dot (لون النوع) | API Key (var(--type-apikey)) |
| Consumption (الاستهلاك) | غير محدود — paid-only Unlimited plan (no free tier), no token quota |
| Plans (الخطط) | Unlimited JAILBREAK Model — $8.00 / 15 days, paid-only (from screenshot; NOT EXPOSED via API) |
| Key-fetchable: plan/quota/reset/expiry (بالمفتاح) | The API exposes spend (`billing/usage.total_usage`) and expiry (`access_until: 0`), but the adapter fetches **neither**: the plan is unlimited, so there is no quota to show and the key rows report the unlimited plan (see §7). NOT EXPOSED: plan / reset / name / email (screenshot: 5 days remaining) |
| Needs web session (يحتاج جلسة ويب) | name/email/plan (dashboard only — no user endpoint accepts the API key) |

## 1. Overview + base URLs

- OpenAI-compatible API base: `https://darkapi.dev/v1`
  (verified live 2026-10-11: `GET /v1/models` with a Bearer key returns
  http 200 + 36 models. The `api.darkapi.dev` host does NOT resolve —
  the default base is the working one; no per-key custom base was needed.)
- Docs page (`/docs`) is a React SPA shell — no crawlable endpoint catalogue;
  `GET /api/status` (no auth) returns dashboard module config JSON, not docs.
- Style: OpenAI-compatible (`/v1/models`, `/v1/chat/completions`).
- Stack hints: `new_api` fork (`x-new-api-version: v0.0.0`,
  error `type: new_api_error`, `x-oneapi-request-id` header), behind Cloudflare.
- Catalogue observed: **36 models** (single probe key).

## 2. Auth

All `/v1/*` JSON endpoints require a header:

```http
Authorization: Bearer $DARKAPI_KEY
```

`x-api-key` / `apikey` header variants are rejected identically
(`401 Invalid token`) — Bearer is the only working scheme.

## 3. Verified endpoints (probed live 2026-10-11)

### GET /v1/models (auth)

- Count observed: **36 models**.
- Top-level keys: `data` / `object` / `success`.
- Entry shape: `id` / `object` / `created` / `owned_by` /
  `supported_endpoint_types`.
- `created` is a placeholder (`1626777600` on all 36 entries); `owned_by`
  is generic (`openai` on all 36) — not the real vendor.

```json
{ "id": "qwen3.8-flash", "object": "model", "created": 1626777600,
  "owned_by": "openai", "supported_endpoint_types": ["openai"] }
```

- Full roster: see §5.

### POST /v1/chat/completions (auth, OpenAI-compatible)

Ping + `max_tokens` example:

```bash
curl -s https://darkapi.dev/v1/chat/completions \
  -H "Authorization: Bearer $DARKAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.8-flash","messages":[{"role":"user","content":"ping"}],"max_tokens":5}'
```

- Observed live 2026-10-11 (`qwen3.8-flash`, ping, `max_tokens: 5`, http 200):
  `choices[0].message.content` = `"pong"`, `finish_reason: length`.
- Response `model` echoes the sent id (`qwen3.8-flash`).
- Models emit `reasoning_content` (58 reasoning tokens on a bare ping —
  `max_tokens` budgets reasoning too, so keep it well above 5 for real replies).
- Prompt is heavy: a bare `ping` costs **2412 prompt tokens** (large injected
  system prompt) — budget accordingly, this is NOT a cheap ping.
- `usage` shape (no `cost_tokens`, unlike Apinex): `prompt_tokens` /
  `completion_tokens` / `total_tokens` /
  `completion_tokens_details.reasoning_tokens` + `text_tokens` /
  `prompt_tokens_details.cached_tokens` + `text_tokens`.
- Responses carry an extra top-level `_manifest` object (C2PA / AI DeepSign
  provenance payload, base64 `application/c2pa`) — harmless metadata,
  ignore it when parsing.
- Streaming (`"stream": true`, SSE `data:` chunks) works — confirmed live:
  chunks with `object: chat.completion.chunk`, `delta.role` / `delta.content` /
  `delta.reasoning_content`, `usage: null` on chunks.

### GET /v1/dashboard/billing/subscription (auth)

Works with an API Bearer key. Observed live 2026-10-11 (REDACTED):

```json
{
  "object": "billing_subscription",
  "has_payment_method": true,
  "soft_limit_usd": 100000000,
  "hard_limit_usd": 100000000,
  "system_hard_limit_usd": 100000000,
  "access_until": 0
}
```

### GET /v1/dashboard/billing/usage (auth)

Observed live 2026-10-11 (REDACTED) — note the NONZERO spend on this key:

```json
{ "object": "list", "total_usage": 779958.6900000001 }
```

(Query params untried — date-range filters may exist.)

### Billing/quota endpoints that do NOT exist (all 404 live 2026-10-11)

`GET /v1/balance`, `/v1/subscription`, `/v1/quota`, `/v1/usage`,
`/v1/billing`, `/v1/credit`, `/v1/tokens`,
`/v1/dashboard/billing/{credit,info,grants}`,
`/v1/dashboard/billing/subscription/token`, `/v1/dashboard/user/self`,
`/v1/user/self`, `/v1/api/user/self` — all return http 404:
`{"error":{"message":"Invalid URL (GET ...)","type":"invalid_request_error","param":"","code":""}}`.
Root-level `/balance`, `/subscription`, `/quota`, `/usage`, `/billing`,
`/models` serve the dashboard SPA (http 200 HTML), not JSON.

## 4. Unverified / needs web session (NOT probed live)

- `/v1/messages` — never probed on this provider.
- Claude-native / Gemini-native chat endpoints + function-calling — only
  OpenAI-style `/v1/chat/completions` was probed.
- `/api/user/*` — web-session auth only (untried; `GET /api/status` works
  WITHOUT auth and returns dashboard module config, not user data).
- 402/429 behaviour — neither triggerable with the probe key (see §6).

## 5. Models roster (36 — paid-only Unlimited plan, probed live 2026-10-11)

```text
north-mini-code
Atria-Dawn-Preview
kimi-k3
qwen3.8-27b-unsencored
qwen3.8-27b
ministral-14b-latest
longcat-2.5-preview
unrestricted
glm-5.3-flash
stealth/space-bunny-alpha
big-pickle
nemotron-3.5-lightning
codestral-latest
laguna-xs-2.1
nemotron-3-super
qwen3.8-flash
ling-3.1-flash
step-5-unrestricted
laguna-s-2.1
step-3.7-flash
muse-spark-1.3-contributor
glm-5.3
deepseek-v4.1-flash
muse-unrestricted
mimo-v2.6-flash
step-3.7-unrestricted
fledge-alpha
longcat-unrestricted
space-bunny
step-5-preview
deepseek-unrestricted
mimo-v2.5
nemotron-3-ultra
ling-3.0-flash-sante
dots-3-note-preview
big-pickle-unrestricted
```

(Naming notes: `Atria-Dawn-Preview` is the only CamelCase id; several
`-unrestricted` / jailbreak-flavoured ids match the plan in §8.)

> NOTE — the bare `unrestricted` id is excluded by the adapter (see §7), so the
> app shows 35 of these 36 ids. The suffixed routes (`step-5-unrestricted`,
> `muse-unrestricted`, …) stay: they name a base model and inherit its facts.

> NOTE — some model ids may return 503 / be down at times; this is normal
> provider-side churn. Skip/retry, do not treat it as a router bug.

## 6. Rate limits + errors

- No `x-ratelimit-*` / quota / `retry-after` headers on any response.
  Observed headers: `x-new-api-version: v0.0.0`, `x-oneapi-request-id`,
  Cloudflare (`cf-ray`, `cf-cache-status: DYNAMIC`).
- `401` no key AND bad key — identical shape (`request id` varies, REDACTED):
  `{"error":{"code":"","message":"Invalid token (request id: REDACTED)","type":"new_api_error"}}`
  (auth is checked before routing — even an unknown model id returns this
  401 shape when the key is bad).
- Unknown model → http **503** (not 404), `code: model_not_found` (id REDACTED):
  `{"error":{"code":"model_not_found","message":"No available channel for model no-such-model-xyz under group free (distributor) (request id: REDACTED)","type":"new_api_error"}}`
- `404` unknown route (http 404):
  `{"error":{"message":"Invalid URL (GET /v1/...)","type":"invalid_request_error","param":"","code":""}}`
- `402` / `429`: NOT observed — 10 rapid `GET /v1/models` burst returned
  ten `200`s (no throttle); quota errors not triggerable with the probe key.
- HEAD-vs-GET quirk: `HEAD /v1/models` returns 404 while `GET` returns
  401/200 — use GET for existence checks, never HEAD.

## 7. How the app implements it

`src/renderer/providers/darkapi.js` is the built-in adapter. It registers
itself; nothing imports it.

```js
window.INTEGRATED_PROVIDERS.darkapi = {
  meta: {
    id: 'darkapi', name: 'Dark API', baseUrl: 'https://darkapi.dev/v1',
    color: '#00e0a4', logo: '../assets/providers/darkapi.svg',
    logoTone: 'bright',
    modelsEndpoint: '/models', chatEndpoint: '/chat/completions',
    billing: { plan: '$8.00 / 15 days', usageLabel: 'Unlimited JAILBREAK' },
    unlimitedUsage: { label: 'Unlimited plan', range: '0 → ∞ tokens',
      detail: 'Unlimited model usage · no published request quota' },
  },
};
```

- **No `fetchModels`.** Dark API is a plain OpenAI-compatible provider with no
  free / free-for-paid tiers, so the shared default discovery
  (`GET /models` → show every model) is used.
- **No `fetchKeyUsage`.** The plan is unlimited, so there is no request quota
  to fetch and nothing to pace runs against: the key rows report the
  unlimited plan from `meta.unlimitedUsage`.
- **An `excludeModel` hook** that drops the bare modifiers
  (`unrestricted`, `uncensored`, `unsencored`, `abliterated`, `raw`). The bare
  `unrestricted` names no base model, so there is nothing to look up and
  nothing to inherit — showing it would be a row of dashes that reads like a
  data failure. The suffixed routes stay.
- Logo: `src/assets/providers/darkapi.svg`. The script is loaded from
  `src/renderer/index.html` before `app.js`; the built-in count asserted by
  the live checks is **eleven**.

**Accept:** `npm test` then `npm run verify:live`.

**Traps:** bare pings cost ~2.4k prompt tokens (injected system prompt);
reasoning models burn `max_tokens` on `reasoning_content`; chat `usage` has
no `cost_tokens` (unlike Apinex); responses carry an extra `_manifest`
(C2PA provenance) object — ignore it; entry shape carries extra
`supported_endpoint_types`; `created`/`owned_by` are placeholders;
Bearer is the only auth scheme; use GET (not HEAD) for endpoint checks.

## 8. Account & Quota (Raw → normalized, API probed live 2026-10-11 + dashboard screenshot)

| Router field | Raw source | Value observed / mapping |
|---|---|---|
| PLAN | dashboard screenshot (user-provided) | **Unlimited JAILBREAK Model** — custom base URL, **$8.00 / 15 days** (NOT EXPOSED via any API endpoint — no plan field exists in API responses) |
| QUOTA | dashboard screenshot: Total Quota | **Unlimited** (API side: `billing_subscription` limits are 100000000 sentinel; `billing/usage.total_usage` = 779958.69 — no token-quota numbers) |
| RESET TIME | - | NOT EXPOSED (no reset field on any endpoint; plan is time-boxed — 15-day cycle per screenshot) |
| EXPIRY | billing_subscription access_until + screenshot countdown | API: `access_until: 0` (no expiry set) — screenshot: **5 days remaining** on the 15-day cycle |
| NAME / EMAIL | - (no user endpoint accepts the API key) | NOT EXPOSED via API key |
