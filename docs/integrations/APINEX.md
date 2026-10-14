# Apinex — Provider Reference

Main reference for adding Apinex as a venom-router provider.
Evidence: `G:\Venom-Projects\key_models.json`, `key_headers.txt`,
`apinex.bundle.js` (path presence only), live public probes 2026-10-11,
re-probed live 2026-10-11 (balance / subscription key-A + key-B / chat / streaming / errors).
No real key value is stored in this repo — use `$APINEX_KEY`.

## 0. Summary (ملخص)

| Field (الحقل) | Value (القيمة) |
|---|---|
| Provider name (اسم المزود) | Apinex |
| Provider URL (رابط المزود) | https://apinex.bond |
| API base (قاعدة الـ API) | https://api.apinex.bond/v1 |
| Icon URL (مسار الأيقونة) | `src/assets/providers/apinex.png` — in repo |
| Provider type (نوع المزود) | API KEY (Bearer; `x-api-key` also accepted) |
| Type color dot (لون النوع) | API Key (var(--type-apikey)) |
| Consumption (الاستهلاك) | محدود — FREE tier: 10M tokens/day (resets 00:00 UTC)؛ SUBSCRIPTION tier: `tokenLimit` quota for the plan's `days` period, no daily reset |
| Plans (الخطط) | FREE 10M/day + 4 plans: 10d/$5/500M, 20d/$10/1.1B, 30d/$20/2.5B, 30d/$30/5B featured (full table in §3, live `GET /api/public/subscriptions`) |
| Key-fetchable: plan/quota/reset/expiry (بالمفتاح) | YES plan (`subscription.plan`/`plan_label`) + quota (`token_limit`/`tokens_used`/`tokens_remaining`) + reset (`resets_at_utc`) + expiry (`expires_at_utc`) + balance (`/v1/balance`) |
| Needs web session (يحتاج جلسة ويب) | name/email (`/api/user/me` — web session only, NOT via API key) |

## 1. Overview + base URLs

- OpenAI-compatible API base: `https://api.apinex.bond/v1`
- Web / public base (no auth): `https://apinex.bond`
- Style: OpenAI-compatible (`/v1/models`, `/v1/chat/completions`).
- Catalogue observed: **36 models** on `GET /v1/models`.

## 2. Auth

All `/v1/*` endpoints require a header:

```http
Authorization: Bearer $APINEX_KEY
```

(`x-api-key` is also accepted per the missing-key error text.)
Public `https://apinex.bond/api/public/*` endpoints need no auth.

## 3. Verified endpoints (re-probed live 2026-10-11 — balance / subscription / chat / streaming)

### GET /v1/models (auth)

- Count observed: **36 models** (both probe keys, re-probed live 2026-10-11).
- Entry shape: `id` / `object` / `created` / `owned_by`.

```json
{ "object": "list", "data": [
  { "id": "gpt-6-luna", "object": "model", "created": 1787834917, "owned_by": "apinex" }
]}
```

- Full roster: see §5. Source file: `G:\Venom-Projects\key_models.json`.
- Response header observed: `x-ratelimit-limit: 60` (see `key_headers.txt`).

### POST /v1/chat/completions (auth, OpenAI-compatible)

Ping + `max_tokens` example:

```bash
curl -s https://api.apinex.bond/v1/chat/completions \
  -H "Authorization: Bearer $APINEX_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"free/qwen-3.8-max","messages":[{"role":"user","content":"ping"}],"max_tokens":5}'
```

- Standard OpenAI request/response (`model`, `messages`, `choices[0].message.content`).
- Observed live 2026-10-11 (`free/qwen-3.8-max`, ping, `max_tokens: 5`):
  `choices[0].message.role` = `assistant`, content starts with `Pong`;
  `usage` = `{prompt_tokens: 249, completion_tokens: 63, total_tokens: 312, cost_tokens: 0}`.
- `usage` object carries **`cost_tokens`** in addition to prompt/completion tokens
  (`cost_tokens: 0` observed live 2026-10-11).
- Streaming (`"stream": true`, SSE `data:` chunks) works — confirmed live 2026-10-11:
  chunks with `object: chat.completion.chunk`, `delta.role: assistant`,
  `sla_metrics.ttft_ms` present, terminal `usage` includes `cost_tokens: 0`.

### GET /v1/balance (auth)

Shape (`object: balance`): `balance_usd` / `reserved_usd` / `api_key{id, spend_limit_usd, spent_usd, reserved_usd, remaining_usd, limit_reached}`.

Observed live 2026-10-11 on both probe keys (identical shape/values apart from key id, REDACTED):

```json
{
  "object": "balance",
  "balance_usd": 0,
  "reserved_usd": 0,
  "api_key": {
    "id": "REDACTED",
    "spend_limit_usd": null,
    "spent_usd": 0,
    "reserved_usd": 0,
    "remaining_usd": null,
    "limit_reached": false
  }
}
```

### GET /v1/subscription (auth)

Shape (`object: subscription`): `mode` / `plan` / `plan_label` / `unlimited` /
`token_limit` / `tokens_used` / `tokens_remaining` /
`expires_at_utc` / `resets_at_utc` / `allowed`.

Observed live 2026-10-11 probe key-A, subscription tier
(not a generic default — values vary per key/plan):

```json
{
  "object": "subscription",
  "mode": "subscription",
  "plan": "10_days",
  "plan_label": "20 days",
  "unlimited": false,
  "token_limit": 1100000000,
  "tokens_used": 52665,
  "tokens_remaining": 1099947335,
  "expires_at_utc": "2026-10-30T22:42:24.926Z",
  "resets_at_utc": null,
  "allowed": true
}
```

Observed live 2026-10-11 probe key-B, free tier:

```json
{
  "object": "subscription",
  "mode": "free",
  "plan": null,
  "plan_label": "FREE",
  "unlimited": false,
  "token_limit": 10000000,
  "tokens_used": 7268,
  "tokens_remaining": 9992732,
  "expires_at_utc": null,
  "resets_at_utc": "2026-10-12T00:00:00.000Z",
  "allowed": true
}
```

### Public web endpoints (no auth) — all probed live 2026-10-11

| Endpoint | Notes |
|---|---|
| `GET https://apinex.bond/api/public/subscriptions` | `freeDailyTokens` (10000000) + `plans[]` (`key`, `label`, `days`, `priceUsd`, `kind`, `tokenLimit`, `isFeatured`) |
| `GET https://apinex.bond/api/public/rate-limits` | `{"rpmFree":5,"rpmSubscription":30,"subscriberPriority":true}` |
| `GET https://apinex.bond/api/public/models` | `{"models":[{id, provider, name, contextWindow, weight, allowFree, dollarsPer1M, tags, health}]}` |
| `GET https://apinex.bond/api/public/status` | `{"generatedAt","windowHours":168,"models":[{id,name,provider,state,uptimePct,hours:[{at,state}]}]}` |

### GET /api/public/subscriptions (no auth) — plans table, live 2026-10-11

`freeDailyTokens: 10000000` (FREE-tier daily quota, resets 00:00 UTC) + `plans[]`:

| key | label | days | priceUsd | tokenLimit | isFeatured |
|---|---|---|---|---|---|
| day1 | 10 days | 10 | 5 | 500000000 | false |
| day7 | 20 days | 20 | 10 | 1100000000 | false |
| day14 | 30 days | 30 | 20 | 2500000000 | false |
| day30 | 30 days | 30 | 30 | 5000000000 | true |

Subscription = `tokenLimit` quota for the plan's `days` period, no daily reset.

## 4. Unverified / needs web session (NOT probed live)

Found in `apinex.bundle.js` by exact-path grep; presence confirmed,
behaviour **not** probed. Do not document as working until live-tested.

- `/v1/auth/credentials_login`
- `/v1/messages`
- `/v1/responses`
- `/v1/images/*` — seen: `/v1/images/edits`, `/v1/images/generations`
  (plus `/playground` variants of each)
- `/v1/tools/*` — seen: `/v1/tools/*`, `/v1/tools/`, `/v1/tools/captcha/solve`,
  `/v1/tools/solana/rpc`, `/v1/tools/translator`, `/v1/tools/translator/languages`,
  `/v1/tools/twitter/*` (article, list/*, spaces/detail, trends, tweet/*, user/*),
  `/v1/tools/voice/stt`, `/v1/tools/voice/tts`,
  `/v1/tools/web/`, `/v1/tools/web/contents`, `/v1/tools/web/research`, `/v1/tools/web/search`
- `/api/user/*` — seen, incl. `/api/user/checkin`, `/api/user/xp/checkin`,
  `/api/user/keys`, `/api/user/subscriptions`, `/api/user/usage`, `/api/user/me`
  (plus many more: billing/*, jackpot/*, nft/*, roulette/*, xp/*, telegram/* —
  web-session auth, not API-key auth)
- `/api/auth/*` — seen: `/api/auth/login`, `/api/auth/login/status`, `/api/auth/me`
  (web-session auth, not API-key auth)

## 5. Models roster — FREE tier (25) vs SUBSCRIPTION tier (full 36, re-probed live 2026-10-11)

Sources: public models endpoint (no auth) allowFree flag
+ authenticated models endpoint (36 ids, identical set on both probe keys).

> WARNING — the router MUST fetch and filter models by key tier: FREE-tier keys
> MUST only offer allowFree-true ids; allowFree-false ids consume balance
> and fail on balance-less keys (402 Insufficient balance, see §6).
> SUBSCRIPTION-tier keys get the full 36-id roster. Never hardcode one roster
> for both tiers — re-fetch allowFree live, it changes (healthCheckedAt).

FREE tier (allowFree true, 25 — the only ids a free key may call):

```text
claude-sonnet-5.5
deepseek-v4.1-flash
gemini-3.8-flash
gpt-6.1-sol
free/qwen-3.8-max
grok-4.7
claude-opus-5.5
deepseek-v4-flash
free/deepseek-v4.1-flash
gemini-3.1-pro
gpt-6-astra
claude-fable-5.1
free/deepseek-v4-flash-0731
deepseek-v4-pro
gpt-6-luna
claude-opus-5
free/deepseek-v4-pro-0813
gpt-5.6-terra
claude-sonnet-5
free/gpt-6-luna
free/glm-5.3-flash
free/mimo-v2.6-pro
glm-5.3-flash
glm-5.3
kimi-k3
```

SUBSCRIPTION tier (full roster, 36 = the FREE 25 above + these 11 balance-consuming):

```text
free/minimax-m3.1
free/minimax-m3
free/mimo-v2.6-flash
free/claude-sonnet-4.6
free/hy4
free/kimi-k3
free/claude-opus-4.6
free/gemini-3.8-flash
free/muse-spark-1.3
free/gemini-3.1-pro
free/kimi-k2.8
```

## 6. Rate limits + errors

- `x-ratelimit-limit: 60` observed on `GET /v1/models` (see `key_headers.txt`).
- Public rate limits: `rpmFree` 5 / `rpmSubscription` 30 (`/api/public/rate-limits`).
- `401` no key: `{"error":{"message":"Missing API key (Bearer or x-api-key)","type":"authentication_error","param":null,"code":null}}`
- `401` bad key: `{"error":{"message":"Invalid API key","type":"authentication_error","param":null,"code":null}}`
- `402` verified live 2026-10-11 (paid `gpt-6-luna`, zero balance): `{"error":{"message":"Insufficient balance","type":"billing_error","param":null,"code":null}}`.
  A free-tier key calling an `allowFree: false` model hits this — see the §5 WARNING.
- `404` unknown route: `{"message":"Route GET:/v1/... not found","error":"Not Found","statusCode":404}`.
- `404` unknown model: `Model not found`.

## 7. Router integration recipe (per COOKBOOK.md §1)

1. New `src/renderer/providers/apinex.js` (registers itself, nothing imports it):
   ```js
   window.INTEGRATED_PROVIDERS = window.INTEGRATED_PROVIDERS || {};
   window.INTEGRATED_PROVIDERS.apinex = {
     meta: {
       id: 'apinex', name: 'Apinex', baseUrl: 'https://api.apinex.bond/v1',
       color: '#22d3ee', logo: '../assets/providers/apinex.png',
       modelsEndpoint: '/models', chatEndpoint: '/chat/completions',
     },
   };
   ```
2. Logo: `src/assets/providers/apinex.png` (match existing provider art).
3. `src/renderer/index.html`: `<script src="providers/apinex.js"></script>` **before** `app.js`.
4. Fixture + count: extend `scripts/live/fixture.mjs` and bump `READY` in
   `scripts/live/verify-db.mjs`.
5. `README.md`: add the Apinex row to the providers table.
6. `npm run repo:map` (new file surfaces in `CODE_MAP.md`).

**Accept:** `npm test` then `npm run verify:live`.

## 8. Account & Quota (Raw → normalized, probed live 2026-10-11)

| Router field | Raw source | Value observed / mapping |
|---|---|---|
| PLAN | GET /v1/subscription plan / plan_label / mode | subscription key-A: plan `10_days` / label `20 days` (verbatim mismatch observed live); free key-B: plan null / label `FREE` / mode `free` |
| QUOTA | subscription token_limit / tokens_used / tokens_remaining + GET /v1/balance balance_usd | key-A: 1100000000 / 52665 / 1099947335; key-B free: 10000000 / 7268 / 9992732; balance_usd 0 on both probe keys |
| RESET TIME | subscription resets_at_utc | subscription tier: null (no daily reset — quota is tokenLimit for plan days); free tier: `2026-10-12T00:00:00.000Z` (00:00 UTC daily reset) |
| EXPIRY | subscription expires_at_utc | subscription key-A: `2026-10-30T22:42:24.926Z`; free key-B: null |
| NAME / EMAIL | - (/api/user/me needs web session) | NOT EXPOSED via API key |
