# Nara — Provider Reference

Reference for the NARA Router provider as the app implements it.
Evidence: live probes 2026-10-11 (site root, GET /v1/models per key,
GET /v1/me per key, chat ping max_tokens:5, 401/403/404 error shapes,
billing-endpoint 404 sweep) + user dashboard screenshots (marked
screenshot-sourced where used).
No real key value is stored in this repo — use $NARA_KEY_A / $NARA_KEY_B.

## 0. Summary (ملخص)

| Field (الحقل) | Value (القيمة) |
|---|---|
| Provider name (اسم المزود) | NARA Router (byNara) |
| Provider URL (رابط المزود) | https://router.bynara.id/ |
| API base (قاعدة الـ API) | https://router.bynara.id/v1 |
| Icon URL (مسار الأيقونة) | src/assets/providers/nara.svg — in repo |
| Provider type (نوع المزود) | API KEY (Bearer) |
| Type color dot (لون النوع) | API Key (var(--type-apikey)) |
| Consumption (الاستهلاك) | محدود — Free models only (user rule 2026-10-11: PAYG excluded) — Free daily 7M (screenshot)؛ Free-For-Paid 15M while holding qualifying credit (funded key-A Rp111,786.69 ~$6.25)؛ live GET /v1/me limit 100M on both probe keys, reset 00:00 UTC — router uses live values |
| Plans (الخطط) | Free plan only observed (screenshot-sourced: 15 req/min, reset 07:00 WIB, no expiry)؛ no plan-catalogue endpoint — billing/balance/quota/subscription all 404؛ PAYG / balance-deducting models excluded per standing rule — router never offers them |
| Key-fetchable: plan/quota/reset/expiry (بالمفتاح) | The API exposes them via `GET /v1/me` (plan, quota, reset, credit, usage, email), but the adapter does **not** fetch them: the key rows show the free-plan note from `meta.planNote` instead (see §7) |
| Needs web session (يحتاج جلسة ويب) | PAYG on/off toggle (dashboard UI, screenshot-sourced — no API endpoint found) |

## 1. Overview + base URLs

- Site: https://router.bynara.id/ (root 200, probed live 2026-10-11).
- OpenAI-compatible API base: https://router.bynara.id/v1 (discovered live — GET /v1/models + Bearer works).
- Style: OpenAI-compatible (/v1/models, /v1/chat/completions) + Nara-specific GET /v1/me (account/credit/quota/usage/models-allowlist).
- Catalogue observed: 51 models on GET /v1/models (identical set on both probe keys)؛ per-key entitlement allowlist via GET /v1/me models array (11 vs 51 — see §5).
- Model entries carry per-model IDR pricing (input_idr_per_1k, output_idr_per_1k, cache_read_idr_per_1k, plus /1m variants) + payg_enabled flag (PAYG on/off itself is dashboard-side, screenshot-sourced).

## 2. Auth

All /v1/* endpoints require a header:

```http
Authorization: Bearer $NARA_KEY_A
```

(Second account uses $NARA_KEY_B.) No-auth / bad-key behaviour: 401 (see §6).

## 3. Verified endpoints (probed live 2026-10-11)

### GET /v1/models (auth)

- Count observed: 51 models on BOTH probe keys (identical id sets, live 2026-10-11).
- NOTE: this is the catalogue, NOT the entitlement — the per-key allowlist lives in GET /v1/me models array (see §5 WARNING).
- Entry shape: id / object / owned_by (byNara) / name / context_window / vision / reasoning / payg_enabled / IDR price fields.
- Example entry: agnes-2.5-flash / Agnes 2.5 Flash / context 512000 / vision+reasoning true / payg true / input 0.1 + output 0.2 IDR per 1k.
- Full roster: see §5.

### GET /v1/me (auth) — account, credit, quota, usage, per-key models allowlist

Shape: account{email, plan} / credit{available, held, currency, usd_equivalent} / quota{unit, remaining, limit, reset_at} / usage{requests_today, requests_month, success_rate, tokens_today, tokens_month, tokens_all_time} / models array.

Observed live 2026-10-11 probe key-A (funded account): plan free, credit available 111786.689216000 IDR (held 0, usd_equivalent 6.25), quota tokens 100000000/100000000 reset_at 2026-10-12T00:00:00Z, usage month 3242 req / 3928208 tokens (all-time 4661198, success_rate 0.68877), models allowlist 11 ids.

Observed live 2026-10-11 probe key-B (zero-credit account): plan free, credit available 0.000000000 IDR (usd_equivalent 0.00), quota tokens 100000000/100000000 reset_at 2026-10-12T00:00:00Z, usage month 40 req / 2799 tokens (all-time 45030, success_rate 0.375), models allowlist full 51 ids.

(Both probe-key emails observed live, REDACTED — email is EXPOSED via API key here, unlike Apinex.)
- Credit cross-check (screenshot-sourced): key-A Rp111,786.69 approx $6.25 MATCHES live؛ key-B Rp0.00 MATCHES live.
- Quota note: live limit/remaining = 100M/100M on both keys؛ dashboard screenshots show Free daily 7M/7M and Free-For-Paid 15M/15M (funded) — screenshot-sourced, may reflect a different dashboard counter؛ the router uses live /v1/me values.
- reset_at 00:00 UTC = 07:00 WIB MATCHES screenshot reset 07.00 WIB.

### POST /v1/chat/completions (auth, OpenAI-compatible)

Ping: POST https://router.bynara.id/v1/chat/completions with Bearer $NARA_KEY_A and body model=agnes-2.5-flash, messages=[ping], max_tokens=5.

- Observed live 2026-10-11 on both keys: finish_reason stop, content starts with Pong, usage approx prompt 285 (cached 256) / completion 32-39 / total ~317-324, plus provider_specific_fields.matched_stop and reasoning_content present.
- One transient key-A attempt timed out (HTTP 000) — retried OK؛ not a router bug.
- Response carries reasoning_content alongside content on this model.

### Billing/quota endpoints — 404 sweep (auth, live 2026-10-11)

No dedicated billing endpoint exists. All of these return 404 not_found (same shape as unknown route, see §6): /v1/billing, /v1/balance, /v1/credit, /v1/credits, /v1/quota, /v1/subscription, /v1/usage, /v1/wallet, /v1/account, /v1/user.
Account/quota/credit data comes from GET /v1/me instead (see above + §8).

## 4. Unverified / not probed

- Streaming (stream:true SSE data: chunks) — NOT probed live. Do not document as working until live-tested.
- Any /v1/* endpoint beyond /models, /me, /chat/completions and the decision
  endpoint `/systemone` (except the §3 404 sweep).
- Image / audio / tool endpoints — none discovered؛ site root is a web app (root 200).

## 5. Models roster — free-only allowlist (probed live 2026-10-11, reframed per user exclusion rule 2026-10-12)

GET /v1/models returns the same 51-id catalogue on both keys — but the router offers free models ONLY (standing user rule 2026-10-11: EXCLUDE any model that deducts from balance / needs token payment). Nara screenshot 2026-10-12 confirms the free set = 11 ids: 6 Free (no cost) + 5 Free-for-paid (served free while holding qualifying credit).

> WARNING — the router MUST offer the free set only, and never any model outside it — the
> 40 PAYG / balance-deducting ids stay EXCLUDED even when a key allowlist includes them
> (key-B listed all 51 live). A key calling a non-allowlisted id fails live with 403
> forbidden (see §6). The free set is **derived live**, not hardcoded: the adapter reads
> the zero-price plans from `/api/plans` and the `free_for_paid` flag from
> `/api/pricing`, so it follows the provider's own catalogue (see §7). Never hardcode one
> roster for all keys.

Router allowlist — 6 Free models (no cost, screenshot 2026-10-12):

```text
agnes-2.5-flash
exo-stealh
jev
laguna-s-2.1
nemotron-3-ultra-free
nemotron-3.5-lightning-free
```

Router allowlist — 5 Free-for-paid models (served free while holding qualifying credit, screenshot 2026-10-12):

```text
agnes-3-flash
mimo-v2.6-flash-free
muse-spark-1.3-contributor-free
step-5-preview
stepfun-3.7-flash
```

Holds (screenshot 2026-10-12): agnes-3-flash Rp15k؛ mimo-v2.6-flash-free Rp35k؛ muse-spark-1.3-contributor-free Rp35k؛ step-5-preview Rp15k؛ stepfun-3.7-flash Rp10k. Key-A credit Rp111,786.69 covers all five holds.

EXCLUDED — the other 40 catalogue ids (PAYG / balance-deducting — listed for reference, NEVER offer per user rule 2026-10-11):

```text
agnes-video-v2.0
claude-fable-5.1
claude-haiku-5.5
claude-opus-4.8
claude-opus-5
claude-opus-5.5
claude-sonnet-5
claude-sonnet-5.5
deepseek-v4-flash-alibaba
deepseek-v4-flash-vision-exp
deepseek-v4.1-flash
gemini-3.1-pro-high
gemini-3.8-flash-high
glm-5.2
glm-5.3
glm-5.3-flash
gpt-5.6-luna
gpt-5.6-sol
gpt-5.6-terra
gpt-6-astra
gpt-6-luna
gpt-6-sol
gpt-6.1-sol
kimi-k2.7-code
kimi-k3
mimo-v2.5
mimo-v2.6-flash
mimo-v2.6-pro
minimax-m3
muse-spark-1.2
muse-spark-1.2-contributor
muse-spark-1.3
muse-spark-1.3-contributor
qwen3.8-27b
qwen3.8-flash
qwen3.8-max
qwen3.8-max-alibaba
deepseek-v4-flash
deepseek-v4-pro
mimo-v2.5-pro
```

## 6. Rate limits + errors

- Rate limit 15 req/min — screenshot-sourced (user dashboard)؛ no rate-limit headers captured live.
- 401 no key AND bad key (identical shape, live 2026-10-11): error type=unauthorized, message=A valid API key is required. (request_id uuid varies per call).
- 403 verified live 2026-10-11 (key-A + gpt-6-luna, not in key-A allowlist): error type=forbidden, message=Your plan does not include the requested model. A key calling a non-allowlisted model hits this — see the §5 WARNING.
- 404 unknown route (incl. the whole §3 billing-endpoint sweep): error type=not_found, message=The requested endpoint does not exist.
- 404 unknown model: error type=not_found, message=The requested model does not exist.

## 7. How the app implements it

`src/renderer/providers/nara.js` is the built-in adapter. It registers itself;
nothing imports it.

1. Provider module: id=nara, name=**NARA Router**,
   baseUrl=https://router.bynara.id/v1, color=#00d4ff, logoTone=bright,
   logo=../assets/providers/nara.svg, modelsEndpoint=/models,
   plansEndpoint=/api/plans, chatEndpoint=/chat/completions,
   pricingUrl=https://router.bynara.id/api/pricing,
   plansUrl=https://router.bynara.id/api/plans, decisionEndpoint=/systemone,
   rpm=30, freeTier=true, planNote='Free plan · 7M tokens/day'.
2. Logo: src/assets/providers/nara.svg (already in repo — verified).
3. src/renderer/index.html: script providers/nara.js BEFORE app.js.
4. Fixture + count: the built-in count asserted by the live checks is
   **eleven**.
5. README.md: the NARA Router row in the providers table.
6. npm run repo:map (new file surfaces in CODE_MAP.md).

Two hooks make this provider its own:

- **A custom `fetchModels`** that reads the provider's own public catalogue:
  `/api/pricing` for the per-model facts and the `free_for_paid` flag, and
  `/api/plans` for the genuinely-free tier (the models of any plan priced at
  zero). A model is offered when it is free **or** flagged free-for-paid, and
  the two are tagged differently so "free" and "free while holding credit" can
  never be confused. `/v1/me` is not called for discovery.
- **A `decisionProbe` / `readDecisionAnswer` pair** with
  `meta.decisionEndpoint = '/systemone'`: NARA Router relays Experiential's
  TypeSafe Jev, which refuses chat and answers only on the decision route.

Accept: npm test then npm run verify:live.

## 8. Account & Quota (Raw → normalized, probed live 2026-10-11)

| Router field | Raw source | Value observed / mapping |
|---|---|---|
| PLAN | GET /v1/me account.plan | both probe keys: plan free؛ key-A funded (credit Rp111,786.69 ~$6.25)؛ key-B zero credit. Screenshot: Free plan |
| QUOTA | GET /v1/me quota + usage + credit | key-A: limit 100M / remaining 100M, month 3,928,208 tokens (3,242 req)؛ key-B: 100M / 100M, month 2,799 tokens (40 req). Screenshot: Free daily 7M/7M, Free-For-Paid 15M/15M (funded) — router uses live /v1/me values |
| RESET TIME | GET /v1/me quota.reset_at | 2026-10-12T00:00:00Z on both keys (00:00 UTC = 07:00 WIB — matches screenshot reset 07.00 WIB) |
| EXPIRY | - (no expiry field exposed) | no expiry (screenshot-sourced: no expiry) |
| NAME / EMAIL | GET /v1/me account.email | EXPOSED via API key (both probe-key inboxes observed live, REDACTED) |
