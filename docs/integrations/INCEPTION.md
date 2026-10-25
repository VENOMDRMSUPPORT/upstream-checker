# Inception — Provider Reference

Main reference for adding Inception (Inception Labs) as a venom-router provider.
Evidence: live probes 2026-10-12 (root, GET /v1/models with+without auth, chat pings max_tokens:5,
400/401/403/404 error shapes, billing-endpoint 404 sweep) + official docs
https://docs.inceptionlabs.ai/ (authentication.md, models.md, get-started.md, rate-limits —
marked docs-sourced where used).
No real key value is stored in this repo — use $INCEPTION_KEY.

## 0. Summary (ملخص)

| Field (الحقل) | Value (القيمة) |
|---|---|
| Provider name (اسم المزود) | Inception (Inception Labs) |
| Provider URL (رابط المزود) | https://api.inceptionlabs.ai/ (API host — root 404 live) |
| API base (قاعدة الـ API) | https://api.inceptionlabs.ai/v1 |
| Icon URL (مسار الأيقونة) | src/assets/providers/inception.svg — in repo |
| Provider type (نوع المزود) | API KEY (Bearer) |
| Type color dot (لون النوع) | API Key (var(--type-apikey)) |
| Consumption (الاستهلاك) | per-token pricing on all live ids (all nonzero) — covered by 200M FREE-token grant (Amount Due N/A, no card, no spending limit). Dashboard Billing page screenshot 2026-10-12 (screenshot-sourced): Custom 200M free-token allocation granted instead of standard 100M؛ Tokens Used 15,753 / 200,000,000 (0.01%)؛ Estimated Amount Due N/A. Router allowlist = 3 working chat models under free quota (§5) per user rule correction 2026-10-12 (EXCLUDE only real-paid-balance burners) |
| Plans (الخطط) | CURRENT PLAN = Free (100M free tokens, no credit card — dashboard Billing page screenshot 2026-10-12, screenshot-sourced). Custom allocation: 200M granted (screenshot-sourced). Rate limits Free Tier (Limits page screenshot 2026-10-12, screenshot-sourced): API Requests 1,000/min؛ Input Tokens 1,000,000/min؛ Output Tokens 100,000/min؛ exceed → 429 Too Many Requests. + Pay As You Go + Enterprise. Monthly Spending Limit: No limit set (screenshot-sourced). No plan/account endpoint (404 sweep) — billing via platform dashboard |
| Key-fetchable: plan/quota/reset/expiry (بالمفتاح) | NO — me/account/user/billing/balance/credit/quota/subscription/usage/wallet all 404؛ plan/quota/reset/expiry/name-email NOT exposed via key |
| Needs web session (يحتاج جلسة ويب) | Platform dashboard https://platform.inceptionlabs.ai (API keys, billing, usage — docs-sourced) |

## 1. Overview + base URLs

- API host: https://api.inceptionlabs.ai/ (root 404, FastAPI detail Not Found, probed live 2026-10-12).
- API base: https://api.inceptionlabs.ai/v1 (verified live — GET /v1/models works, WITH and WITHOUT Bearer).
- Docs: https://docs.inceptionlabs.ai/ (Mintlify؛ llms.txt index present, probed live 2026-10-12).
- Style: OpenAI-compatible (/v1/models, /v1/chat/completions) with extra docs endpoints
  (/v1/decisions, /v1/fim/completions, /v1/edit/completions — NOT probed, see §4).
- Catalogue observed: 3 models on GET /v1/models (single probe key, live 2026-10-12).
- Model entries carry OpenRouter-style fields: context_length / max_output_length / pricing
  (per-token strings) / supported_endpoints / supported_features / openrouter.slug / datacenters.
- Key finding (corrected per user 2026-10-12): all 3 live ids carry nonzero per-token pricing,
  but usage is covered by the 200M FREE-token grant (Amount Due N/A, no card, no spending limit —
  screenshots) — same logic as Nara's free-quota pool. Working chat models are routable while the
  free-quota balance covers. §5 governs.

## 2. Auth

All /v1/* chat/completions requests require a header (docs: get-started/authentication.md):

```http
Authorization: Bearer $INCEPTION_KEY
```

Docs: keys are generated in the Inception Platform dashboard
(https://platform.inceptionlabs.ai/dashboard/api-keys) and exported as INCEPTION_API_KEY
(docs-sourced). Single probe key. No-auth / bad-key behaviour on chat: 401 (see §6).
NOTE — GET /v1/models is PUBLIC here (no-auth returns the same 3-model 200 as Bearer,
probed live 2026-10-12).

## 3. Verified endpoints (probed live 2026-10-12)

### GET /v1/models (public — auth optional)

- Count observed: 3 models — identical with and without Bearer (live 2026-10-12):
- mercury-2 (ctx 128000 / max out 50000 / prompt 0.00000025 / completion 0.00000075 /
  cache-read 0.000000025 / endpoints [chat.completions]).
- mercury-2.5 (ctx 260000 / max out 65536 / prompt 0.00000004 / completion 0.00000015 /
  cache-read 0.000000004 / endpoints [chat.completions]).
- mercury-decide (ctx 65536 / max out 50000 / prompt 0.00000004 / completion 0 /
  cache 0 / endpoints [decisions] — Typed-decision preview, Decisions endpoint only).
- NO free / $0 model: every id has nonzero prompt pricing (mercury-decide completion is 0
  but prompt is nonzero and it is decisions-endpoint-only — still balance-deducting).
- Docs pricing table (docs-sourced, get-started/models.md): Mercury 2.5 in $0.04 / out $0.15;
  Mercury 2 in $0.25 / out $0.75; Mercury Decide in $0.02, cached $0, out $0 — all nonzero.

### POST /v1/chat/completions (auth, OpenAI-compatible)

Ping: POST https://api.inceptionlabs.ai/v1/chat/completions with Bearer $INCEPTION_KEY
and body model=mercury-2.5, messages=[Ping], max_tokens=5.

- Observed live 2026-10-12: HTTP 200, id chatcmpl-..., finish_reason length, usage prompt 12 /
  completion 8 / total 20 (reasoning 8), content null (max_tokens hit — length stop, not error).
- mercury-2 ping also 200 (usage prompt 3 / completion 6 / total 9, cached 2, reasoning 6).
- mercury-small ping also 200 (usage prompt 4 / completion 7 / total 11, cached 3, reasoning 7)
  — NOTE: mercury-small is NOT in GET /v1/models (chat accepts a 6-id vocabulary, see below).
- Chat vocabulary (from the live 400 error message, see §6): mercury, mercury-2, mercury-2.5,
  mercury-coder, mercury-coder-small, mercury-small. mercury-decide is NOT chat-capable
  (decisions endpoint only — chat returns 400 for it).
- Legacy ids mercury / mercury-coder / mercury-coder-small return 403 model_access_denied on
  this key (accounts created before 2026-02-24 only — see §6).

### Billing/quota endpoints — 404 sweep (auth, live 2026-10-12)

No account/billing endpoint exists. All of these return 404 detail=Not Found (FastAPI default,
see §6): /v1/me, /v1/account, /v1/user, /v1/billing, /v1/balance, /v1/credit, /v1/credits,
/v1/quota, /v1/subscription, /v1/usage, /v1/wallet.
Plan/quota/reset/expiry/name-email are NOT key-fetchable here — §8 is docs-sourced.

## 4. Unverified / not probed

- POST /v1/decisions (mercury-decide endpoint — docs: api-reference/decisions/create-a-decision.md)
  — NOT probed live. Do not document as working until live-tested.
- POST /v1/fim/completions and /v1/edit/completions (Mercury Edit 2 — docs-sourced) — NOT probed.
- Streaming (stream:true SSE data: chunks) — NOT probed live.
- Any /v1/* endpoint beyond /models and /chat/completions (except the §3 404 sweep).
- Mercury Voice (docs pricing row — NOT in the live /v1/models catalogue, NOT probed).

## 5. Models roster — 3-id allowlist under free quota (probed live 2026-10-12, per user rule correction 2026-10-12)

GET /v1/models returns a 3-id catalogue with nonzero per-token pricing — but per user rule
correction 2026-10-12 (router base rule = collect free models + free-quota-covered models +
sub/unlimited models؛ EXCLUDE only models that burn real paid balance): Inception's 200M
allocation is a FREE grant (Amount Due N/A, no card, no spending limit — screenshots), so
working chat models are routable under free quota, same logic as Nara's free-quota pool.
No $0 / free-marked model exists here — coverage comes from the free grant, not $0 pricing.

> WARNING — check the free-quota balance before a large run (Estimated Amount Due N/A);
> re-fetch GET /v1/models + chat-ping per key before offering；stop offering when the
> pool is exhausted or any real charge appears.

Roster as served to the app — there is **no allowlist**: the adapter has no
`fetchModels`, so the shared default discovery offers every id `GET /v1/models`
returns, minus the `excludeModel` ids below. The three working chat models
observed live 2026-10-12:

```text
mercury-2
mercury-2.5
mercury-small
```

EXCLUDED — not chat-workable on this key (fetched live 2026-10-12):

```text
mercury-decide
mercury
mercury-coder
mercury-coder-small
```

Notes: mercury-2 + mercury-2.5 are catalogue ids with chat 200 live. mercury-small chat ping
returned 200 live though it is NOT in GET /v1/models (chat accepts a 6-id vocabulary) — the
adapter cannot offer it, because it is not in the roster the key publishes. mercury-decide is
decisions-endpoint-only (chat returns 400 for it) and is currently offered as a chat row, because
the adapter does not exclude it. mercury / mercury-coder / mercury-coder-small returned 403
model_access_denied on the probe key (pre-2026-02-24 accounts only). The adapter's own
`excludeModel` drops only the edit/fim ids (`mercury-edit`, `mercury-fim`).

## 6. Rate limits + errors

- Rate limits (docs-sourced, get-started/rate-limits — NOT observed in headers):
  Free Tier 1000 req/min + 1M input tok/min + 100K output tok/min؛
  Pay As You Go 3000 / 3M / 300K؛ Enterprise Custom.
- 401 no key (live 2026-10-12, chat without Bearer): HTTP 401, error type=authentication_error,
  code=invalid_api_key, message=Incorrect API key provided.
- 401 bad key (live 2026-10-12, chat with sk_bad...): HTTP 401, SAME shape as no-key
  (type=authentication_error, code=invalid_api_key, message=Incorrect API key provided) —
  no-key and bad-key are indistinguishable here.
- 403 legacy model (live 2026-10-12: mercury, mercury-coder, mercury-coder-small chat):
  HTTP 403, error type=model_access_denied, code=model_access_denied,
  message=Model `mercury` is only available to accounts created before February 24, 2026.
  Please use Mercury 2 or Mercury Edit models instead. (model name varies).
- 400 unknown / non-chat model (live 2026-10-12: nope-not-a-model AND mercury-decide via chat —
  same shape): HTTP 400, error type=invalid_request_error, code=invalid_request_error,
  message=[{type=value_error, loc=[body, model],
  msg=Value error, Model must be one of the following: mercury, mercury-2, mercury-2.5,
  mercury-coder, mercury-coder-small, mercury-small}].
  NOTE — this message is the source of the 6-id chat vocabulary (§3).
- 404 bad serving path (live 2026-10-12: whole §3 sweep incl /v1/me, /v1/usage, /v1/billing):
  HTTP 404, body detail=Not Found (FastAPI default — NOT an error envelope).
- 404 host root (live 2026-10-12: GET https://api.inceptionlabs.ai/ AND https://api.inceptionlabs.ai/v1
  no auth): HTTP 404, empty body on / and detail=Not Found on /v1.

## 7. How the app implements it

`src/renderer/providers/inception.js` is the built-in adapter. It registers
itself; nothing imports it.

1. Provider module: id=inception, name=**Inception Labs**,
   baseUrl=https://api.inceptionlabs.ai/v1, color=#f9f6ef (the in-repo
   inception.svg artwork is a brand-cream tile mark on the dark sidebar),
   logo=../assets/providers/inception.svg, logoTone=mono,
   modelsEndpoint=/models, chatEndpoint=/chat/completions,
   tokenLimitField=max_completion_tokens, rpm=1000,
   freeTier=true, planNote='Free plan · 200M free-token grant'.
2. Logo: src/assets/providers/inception.svg (already in repo — verified).
3. src/renderer/index.html: script providers/inception.js BEFORE app.js.
4. Fixture + count: the built-in count asserted by the live checks is
   **thirteen**.
5. README.md: the Inception Labs row in the providers table.
6. npm run repo:map (new files surface in CODE_MAP.md).

Three details make this provider its own:

- **No `fetchModels`.** The default discovery is used, so the offered roster is
  whatever `GET /v1/models` returns — see §5 for what that means in practice.
- **An `excludeModel` hook** that drops the edit/fim ids: Mercury Edit serves
  `/fim/completions` and `/edit/completions` instead of chat, so testing it
  would report a working model as broken.
- **A `meta.keyCheck`** — `GET /v1/models` answers 200 with any key or none,
  so the key check is a one-token chat request, which answers 401
  `invalid_api_key` for a bad key.

Accept: npm test then npm run verify:live.

## 8. Account & Quota (Raw → normalized, probed live 2026-10-12 + docs-sourced)

| Router field | Raw source | Value observed / mapping |
|---|---|---|
| PLAN | Dashboard Billing + Limits pages (user screenshots 2026-10-12, screenshot-sourced) | Free = CURRENT PLAN (100M free tokens, no credit card — Billing page)؛ Limits page Current Tier Free (1,000 API req/min, 1M input tok/min, 100K output tok/min, exceed → 429) — no key-fetchable plan |
| QUOTA | Dashboard Billing page (user screenshot 2026-10-12, screenshot-sourced) | Custom free token allocation 200M granted instead of standard 100M؛ Tokens Used 15,753 / 200,000,000 (0.01%)؛ Estimated Amount Due N/A؛ Monthly Spending Limit: No limit set. Corroboration (screenshots 2026-10-12, screenshot-sourced): API Usage page Mercury Total Tokens 16,055 (Edit 0, Decide 0), log 10/12/2026 12:54:13 AM v1/chat/completions mercury-2 SUCCESS + 12:53:39 AM /v1/chat/completions CLIENT ERROR؛ Welcome page last-24h TOTAL REQUESTS 5, TOTAL TOKENS 40 (INPUT 19, OUTPUT 21). The 200M pool is a FREE grant covering usage (Due N/A, no card, no limit) — working chat models routable under free quota per user rule correction 2026-10-12 (§5 allowlist = 3 ids) |
| RESET TIME | - (no reset field exposed) | NOT EXPOSED via API key |
| EXPIRY | - (no expiry field exposed) | NOT EXPOSED via API key |
| NAME / EMAIL | - (no account endpoint) | NOT EXPOSED via API key |
