# KiosAPI — Provider Reference

Main reference for adding KiosAPI as a venom-router provider.
Evidence: live probes 2026-10-11 (models free + pro / chat / streaming /
billing discovery / errors). Site: `https://kiosapi.com/`,
docs: `https://docs.kiosapi.com/`.
No real key value is stored in this repo — use `$KIOS_FREE_KEY` / `$KIOS_PRO_KEY`.

## 0. Summary (ملخص)

| Field (الحقل) | Value (القيمة) |
|---|---|
| Provider name (اسم المزود) | KiosAPI |
| Provider URL (رابط المزود) | https://kiosapi.com/ |
| API base (قاعدة الـ API) | https://kiosapi.com/v1 |
| Icon URL (مسار الأيقونة) | `src/assets/providers/kiosapi.png` — in repo |
| Provider type (نوع المزود) | API KEY (Bearer) |
| Type color dot (لون النوع) | API Key (var(--type-apikey)) |
| Consumption (الاستهلاك) | محدود — sentinel limits + usage numbers per key |
| Plans (الخطط) | NOT EXPOSED via API (no plan field; only hint: `under group Free (distributor)` inside error-message strings) |
| Key-fetchable: plan/quota/reset/expiry (بالمفتاح) | The API exposes them (quota via the `100000000` sentinel limits + `billing/usage.total_usage`, expiry via `access_until: 0`), but the adapter deliberately does **not** fetch them: sentinel limits are not a quota, so the key rows honestly report "No quota published" (see §7) |
| Needs web session (يحتاج جلسة ويب) | name/email/plan (`/api/user/*` — web session only, NOT via API key) |

## 1. Overview + base URLs

- OpenAI-compatible API base: `https://kiosapi.com/v1`
  (per docs "API Base URL" page: point `base_url` at `https://kiosapi.com/v1/`
  and use the KiosAPI key where the SDK expects its own).
- Web dashboard base (SPA shell, no JSON without a session): `https://kiosapi.com`
- Style: OpenAI-compatible (`/v1/models`, `/v1/chat/completions`).
- Stack hints: `new_api` fork (`x-new-api-version: v1.0.0-rc.43`,
  error `type: new_api_error`, `x-oneapi-request-id` header), behind Cloudflare.
- Catalogue observed: **26 models** (free key) / **38 models** (pro key);
  the free roster is a strict subset of the pro roster.

## 2. Auth

All `/v1/*` JSON endpoints require a header:

```http
Authorization: Bearer $KIOS_FREE_KEY
```

Dashboard `/api/user/*` endpoints do NOT accept API keys (web-session access
token only — `401 AUTH_UNAUTHORIZED` with a Bearer API key).

## 3. Verified endpoints (probed live 2026-10-11)

### GET /v1/models (auth)

- Count observed: **26 models** (free key) / **38 models** (pro key).
- Top-level keys: `data` / `object` / `success`.
- Entry shape: `id` / `object` / `created` / `owned_by` /
  `supported_endpoint_types`.
- `created` is a placeholder (`1626777600` on every entry); `owned_by` is
  generic (`openai` on 24/26 free entries, `newapi` on 2) — not the real vendor.

```json
{ "id": "qwen3-8b", "object": "model", "created": 1626777600,
  "owned_by": "openai", "supported_endpoint_types": ["openai"] }
```

- Full roster: see §5.

### POST /v1/chat/completions (auth, OpenAI-compatible)

Ping + `max_tokens` example:

```bash
curl -s https://kiosapi.com/v1/chat/completions \
  -H "Authorization: Bearer $KIOS_FREE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3-8b","messages":[{"role":"user","content":"ping"}],"max_tokens":5}'
```

- Observed live 2026-10-11 (`qwen3-8b`, ping, `max_tokens: 5`, http 200):
  `choices[0].message.content` = `"\n\nPong!"`, `finish_reason: length`.
- Response `model` echoes the canonical id (`Qwen/Qwen3-8B`), not the alias sent.
- Models emit `reasoning_content` (191 reasoning tokens on a bare ping —
  `max_tokens` budgets reasoning too, so keep it well above 5 for real replies).
- `usage` shape (no `cost_tokens`, unlike Apinex): `prompt_tokens` /
  `completion_tokens` / `total_tokens` /
  `completion_tokens_details.reasoning_tokens` /
  `prompt_tokens_details.cached_tokens` + `prompt_cache_{hit,miss}_tokens`.
- Streaming (`"stream": true`, SSE `data:` chunks) works — confirmed live:
  chunks with `object: chat.completion.chunk`, `delta.role` / `delta.content` /
  `delta.reasoning_content`, plus per-chunk `usage`.

### GET /v1/dashboard/billing/subscription (auth)

Works with an API Bearer key (unlike `/api/user/*`). Identical on both probe
keys (REDACTED). Observed live 2026-10-11:

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

Observed live 2026-10-11 (free key, REDACTED):

```json
{ "object": "list", "total_usage": 0 }
```

(Query params untried — date-range filters may exist.)

### Billing/quota endpoints that do NOT exist (all 404 live 2026-10-11)

`GET /v1/balance`, `/v1/subscription`, `/v1/quota`, `/v1/usage`,
`/v1/billing`, `/v1/credit`, `/v1/tokens`,
`/v1/dashboard/billing/{credit,info,grants}`,
`/v1/dashboard/billing/subscription/token`, `/v1/dashboard/user/self`,
`/v1/user/self` — all return http 404:
`{"error":{"message":"Invalid URL (GET ...)","type":"invalid_request_error","param":"","code":""}}`.
Root-level `/balance`, `/subscription`, `/quota`, `/usage`, `/billing` serve
the dashboard SPA (http 200 HTML), not JSON.

## 4. Unverified / needs web session (NOT probed live)

- `/v1/messages` — referenced in the docs site bundle, never probed.
- Claude-native / Gemini-native chat endpoints + function-calling — the docs
  nav lists `api-reference/chat/{general,claude-native,gemini-native,
  function-calling}` pages; only OpenAI-style `/v1/chat/completions` was probed.
- `/api/user/*` (incl. `/api/user/self`, `/api/user/token`) — web-session auth
  only (`401 {"code":"AUTH_UNAUTHORIZED",...}` with an API key).
- 402/429 behaviour — neither triggerable with the probe keys (see §6).

## 5. Models roster — FREE no-balance (26) vs FUNDED $5/pro (38, probed live 2026-10-11)

FREE-tier roster (26 — key with no balance; strict subset of funded):

```text
laguna-s-2.1
agnes-3.0-flash
lfm-2.5-2.6b
nemotron-3-ultra-550b-a55b
qwen3.8-27b-free
qwen3.8-flash-free
qwen3-8b
north-mini-code
glm-4-9b-0414
deepseek-v4-flash-free
sensenova-6.8-flash-lite
openrouter/free
glm-z1-9b-0414
nemotron-3.5-lightning
agnes-2.5-flash
glyph-cluster
laguna-xs-2.1
deepseek-v4-flash-vision-exp-free
hunyuan-mt-7b
qwen2.5-7b-instruct
atria-dawn-preview
nemotron-3-super-120b-a12b
step-5-preview-free
apodex-1.1-mini
dots-3-note-preview
ling-3.1-flash
```

FUNDED ($5) / pro key adds 12 (38 total) — OBSERVED ROSTER DIFF (funding-to-roster link seen on probe keys only; NOT a verified price-to-models mapping — no endpoint exposes it):

```text
diffusiongemma-26b-a4b-it
deepseek-v4.1-flash-free
longcat-2.5-preview
big-pickle
muse-spark-1.2-contributor
muse-spark-1.3-contributor
gpt-oss-20b
space-bunny-alpha
mimo-v2.6-flash
glm-5.3-flash-free
llama-3.2-11b-vision-instruct
glm-5.3-free
```

> WARNING — fetch the roster per key via `GET /v1/models` and only offer
> ids that key returned; never assume pro ids on a free key — a free key on a
> pro-only model fails with 503 `model_not_found` (`under group Free`
> (distributor)`, see §6).

## 6. Rate limits + errors

- No `x-ratelimit-*` / quota headers on any response. Observed headers:
  `x-new-api-version`, `x-oneapi-request-id`, Cloudflare (`cf-ray`,
  `cf-cache-status: DYNAMIC`).
- `401` no key AND bad key — identical shape (`request id` varies, REDACTED):
  `{"error":{"code":"","message":"Invalid token (request id: REDACTED)","type":"new_api_error"}}`
- Unknown model → http **503** (not 404), `code: model_not_found` (id REDACTED):
  `{"error":{"code":"model_not_found","message":"No available channel for model no-such-model-xyz under group Free (distributor) (request id: REDACTED)","type":"new_api_error"}}`
- Free key on a pro-only model → same 503 `model_not_found` shape
  (`under group Free (distributor)`).
- `404` unknown route (http 404):
  `{"error":{"message":"Invalid URL (GET /v1/...)","type":"invalid_request_error","param":"","code":""}}`
- `402` / `429`: NOT observed — neither triggerable with the probe keys.
- The error-message group tag (`under group Free (distributor)`) is the only
  key-tier signal exposed by the API.

## 7. How the app implements it

`src/renderer/providers/kiosapi.js` is the built-in adapter.
It registers itself; nothing imports it.

```js
window.INTEGRATED_PROVIDERS.kiosapi = {
  meta: {
    id: 'kiosapi', name: 'KiosAPI', baseUrl: 'https://kiosapi.com/v1',
    color: '#a78bfa', logo: '../assets/providers/kiosapi.png',
    modelsEndpoint: '/models', chatEndpoint: '/chat/completions',
    freeTier: true,
    planNote: 'Limited consumption · quota not published',
  },
};
```

- **No `fetchModels`.** The roster already differs per key, and the shared
  default discovery asks every active key and records which ones served each
  model, so a free key and a funded key merge into one honest list without a
  special case. A model a key cannot call simply is not in that key's roster,
  so the 503 `model_not_found` trap (§5/§6) never fires on a key that was
  never offered the id.
- **No `fetchKeyUsage`.** The only billing answers are sentinel limits
  (`soft/hard/system_hard_limit_usd` all `100000000`) and `access_until: 0` —
  no real quota, reset or expiry exists to show, so the key rows honestly
  report "No quota published". Plan, name and email sit behind `/api/user/*`,
  which takes a web session and refuses an API key.
- Logo: `src/assets/providers/kiosapi.png`. The script is loaded from
  `src/renderer/index.html` before `app.js`; the built-in count asserted by
  the live checks is **thirteen**.

**Accept:** `npm test` then `npm run verify:live`.

**Traps:** catalogue differs per key (26 vs 38 — no special case needed);
entry shape carries extra `supported_endpoint_types`; `created`/`owned_by`
are placeholders; chat `usage` has no `cost_tokens` (unlike Apinex);
reasoning models burn `max_tokens` on `reasoning_content`.

## 8. Account & Quota (Raw → normalized, probed live 2026-10-11)

Raw provider facts. The adapter consumes **none** of them (see §7): there is no
real quota to show.

| Router field | Raw source | Value observed / mapping |
|---|---|---|
| PLAN | — (no plan field on any endpoint) | NOT EXPOSED (only hint: `under group Free (distributor)` inside error-message strings) |
| QUOTA | billing_subscription soft/hard/system_hard limit_usd + billing/usage total_usage | limits 100000000 (sentinel look), usage 0; no token-quota numbers |
| RESET TIME | - | NOT EXPOSED |
| EXPIRY | billing_subscription access_until | 0 = no expiry set |
| NAME / EMAIL | - (/api/user/* needs a web session) | NOT EXPOSED via API key |
