# TokenHarbor — Provider Reference

Main reference for adding Token Harbor as a venom-router provider.
Evidence: live keyless probes 2026-10-12 (site root, /v1, GET /v1/models no-auth 401,
chat no-auth/bad-key 429 auth-limiter, /v1/* 404 sweep, GET /v1/messages 405) +
public /models picker free segment (fetched live 2026-10-12) + official docs
https://tokenharbor.ai/docs (flight-data markdown: quickstart, universal-key, rate-limits,
api/models how-we-bill, billing credits/subscription/cashback/referrals, web-chat/limits —
marked docs-sourced where used) + user dashboard screenshots 2026-10-12 (Overview +
Usage 7D — marked screenshot-sourced where used).
NO with-key probe was possible (only the key prefix was supplied, never the full value),
so chat 200s are NOT verified — §§4-5 govern.
No real key value is stored in this repo — use $TOKENHARBOR_KEY.

## 0. Summary (ملخص)

| Field (الحقل) | Value (القيمة) |
|---|---|
| Provider name (اسم المزود) | Token Harbor |
| Provider URL (رابط المزود) | https://tokenharbor.ai/ (site host — root 200 site HTML live) |
| API base (قاعدة الـ API) | https://tokenharbor.ai/v1 |
| Icon URL (مسار الأيقونة) | src/assets/providers/tokenharbor.svg — in repo |
| Provider type (نوع المزود) | API KEY (Bearer) |
| Type color dot (لون النوع) | API Key (var(--type-apikey)) |
| Consumption (الاستهلاك) | $0 on :free routes — picker shows priceIn 0 / priceOut 0 / isFree true (live 2026-10-12)؛ free routes never charge balance (docs). Everything else metered per-token passthrough + 0% markup (docs). Screenshot Usage 7D: 10 req, 322 tok, Est Spend $0.00. Router allowlist = 3 :free ids (§5)؛ paid base ids EXCLUDED (burn real wallet/Pass balance) |
| Plans (الخطط) | Free Access = current tier (Overview screenshot 2026-10-12, screenshot-sourced: Free allowance 0% used, Resets in 5d 6h؛ 1 key created). Paid: top-up packs $10/$50/$100, never expire (docs) + Passes Agent $0.99 first month then $1.99 / Office $9.99 / Frontier $99 with $10/$35/$180 4-week usage-value allowances (docs). New accounts start $0 — no welcome credit (docs) |
| Key-fetchable: plan/quota/reset/expiry (بالمفتاح) | PARTIAL — no account/plan/quota endpoint (/v1/me, /usage, /billing, /wallet, /keys all 404 HTML live)؛ allowance readable only via chat-response headers x-th-free-used-pct / x-th-free-resets / x-th-plan (implemented in provider code, NOT observed live — §4) |
| Needs web session (يحتاج جلسة ويب) | Dashboard https://tokenharbor.ai/dashboard (keys, billing, usage — docs-sourced) |

## 1. Overview + base URLs

- Site host: https://tokenharbor.ai/ (root 200 Next.js site HTML, probed live 2026-10-12).
- API base: https://tokenharbor.ai/v1 (verified live — GET /v1/models answers 401 JSON
  invalid_api_key without a key = auth-gated API؛ docs confirm it needs your key like
  every other /v1 call).
- Docs: https://tokenharbor.ai/docs (Next.js؛ full page markdown embedded in flight data,
  extracted live 2026-10-12).
- Live picker: https://tokenharbor.ai/models (segments Frontier / Value / Free / TH-Rudder؛
  free segment initialSegment=free, serverNow 2026-10-11T22:32:47Z — fetched live).
- Style: OpenAI-compatible (/v1/models, /v1/chat/completions) plus Anthropic-compatible
  /v1/messages, /v1/responses and /v1/images/generations (docs-sourced؛ only chat/models
  touched live, keyless).
- Key finding: free = explicit `:free` route ids priced $0/$0 (picker live) that draw on a
  rolling 7x24h free allowance and never charge balance (docs). TH-Rudder is unlimited-free
  but Webchat-only (no API surface id observed — excluded, §5).
- RPM 60 (user input 2026-10-12؛ docs confirm free accounts 60 req/min + 1800/hr per account).

## 2. Auth

All /v1/* calls require a header (docs: getting-started/quickstart + universal-key):

```http
Authorization: Bearer $TOKENHARBOR_KEY
```

Docs: Universal Key = OpenAI-shaped bearer, one key reaches every model/provider؛ first key
auto-created on sign-in and shown ONCE (hash only afterwards)؛ more keys any time from
/dashboard/api-keys. Format = fixed tag prefix + 64-char base64url random (docs-sourced —
prefix itself never written here). No key-management API exists (dashboard only).
GET /v1/models NEEDS the key (401 invalid_api_key without — live). Unlike Inception,
nothing here is public.

## 3. Verified endpoints (probed live 2026-10-12, keyless)

### GET /v1/models (auth REQUIRED)

- No-auth returns 401 JSON (full body recorded live 2026-10-12):
  {"error":{"message":"Invalid or revoked API key. Rotate your key at
  https://tokenharbor.ai/dashboard.","type":"invalid_api_key","code":"invalid_api_key"}}
- With-key catalogue NOT fetched (full key value never received — §4).
- Docs: returns the callable model ids as JSON for SDKs that pre-fetch the catalog
  (docs-sourced, api/models knowing-what-you-are-paying).

### /v1/* account-path sweep — all 404 HTML (no-auth, live 2026-10-12)

GET /v1/me, /v1/usage, /v1/billing, /v1/wallet, /v1/keys → 404 Next.js HTML catch-all page
(NOT API JSON). GET /v1 → 404 HTML. No key-fetchable account/plan/quota endpoint observed.
GET /v1/messages → 405 empty body (endpoint exists؛ GET refused — POST shape NOT probed).

### Public /models picker free segment (fetched live 2026-10-12)

- Exactly 3 freeRows, each priceIn 0 / priceOut 0 / isFree true / promo false:
- claude-haiku-5.5:free (Claude Haiku 5.5, anthropic, Index 43.4, in text/image/file) —
  badge "Limited time": freeUntil 2026-10-15T13:00:00+00:00 ("Free until 10/15/2026 —
  standard pricing applies afterward").
- deepseek-v4.1-flash:free (DeepSeek V4.1 Flash, deepseek, Index 39.5, in text/image) —
  freeUntil null.
- mimo-v2.6-flash:free (MiMo V2.6 Flash, xiaomi, Index 37.9, in text/image/audio/video) —
  freeUntil null.
- TH-Rudder segment: NO separate surface id — header "TH-Rudder — Unlimited free —
  Web chat only", payload rudderFree:true. Webchat-only → not API-routable (§5).
- Paid rows carry per-1M in/out prices (picker sample: claude-opus-5.5 $4.00/$20.00 —
  page content, not a probe).

## 4. Unverified / not probed

- GET /v1/models WITH key (per-key catalogue ids/prices/free marks) — NOT probed
  (full key value never received).
- POST /v1/chat/completions with key on any model (200 vs 4xx shapes, usage in/out) —
  NOT probed. §5 ids are docs+picker+screenshot-supported, NOT chat-ping-verified.
- True no-key / bad-key chat error shapes — NOT observed (both attempts hit the failed-auth
  rate limiter first, §6). Do not document a 401 chat shape until live-tested.
- deepseek-v4-flash (screenshot Usage 7D top-models 10% row): NO picker free-segment match؛
  exact callable id unconfirmed — NOT allowlisted pending a key probe (may be a retired /
  renamed route or a display form of deepseek-v4.1-flash:free — unknown).
- Chat-response usage headers (x-th-free-used-pct / x-th-free-resets / x-th-plan) and the
  429 free_tier_limit_reached refusal shape — implemented in provider code, NOT observed live.
- Streaming, /v1/messages, /v1/responses, /v1/images/generations, X-TH-Cache-Control bypass /
  force-refresh, per-key spend caps (429 spend_limit_exceeded), vendor lists (403
  vendor_not_allowed) — docs describe them, none probed.

## 5. Models roster — 3-id :free allowlist (picker + docs + screenshots 2026-10-12؛ chat pings NOT verified — per user rule 2026-10-12)

Free = explicit :free routes: $0 in/out (picker live), never charge balance, draw on the
rolling 7x24h free allowance (docs billing/cashback). Paid base ids are metered per-token
against wallet/Pass balance (docs how-we-bill) → EXCLUDED (real-balance burners).

> WARNING — §5 ids are NOT chat-ping-verified (no with-key probe was possible).
> Re-fetch GET /v1/models + chat-ping per key before offering؛ offer only ids the key's
> /models prices at $0/$0؛ stop offering when the free allowance is spent
> (429 free_tier_limit_reached) or any real charge appears.

Router allowlist — :free API ids (picker live 2026-10-12):

```text
claude-haiku-5.5:free
deepseek-v4.1-flash:free
mimo-v2.6-flash:free
```

EXCLUDED — real-balance burners or not API-workable (live 2026-10-12):

```text
(all paid base ids — metered per-token vs wallet/Pass, e.g. claude-opus-5.5, claude-sonnet-5.5, gpt-6-astra, deepseek-v4.1-flash)
TH-Rudder (unlimited-free but Webchat-only — no API surface id observed)
deepseek-v4-flash (screenshot-only 10% usage row — callable id unconfirmed, pending key probe)
```

Notes: screenshot Usage 7D corroborates the same families at $0.00 Est Spend
(claude-haiku-5.5 50%, deepseek-v4.1-flash 20%). claude-haiku-5.5:free is Limited-time
(free until 2026-10-15T13:00Z, then standard pricing — re-check after). The free allowance
is a per-key rolling 7-day window (docs + Overview screenshot "Resets in 5d 6h").

## 6. Rate limits + errors

- Rate limits (docs-sourced, api/rate-limits — NOT observed in headers):
  Free accounts 60 req/min + 1800/hr per account shared across keys/models؛ per IP 100/min
  + 3000/hr؛ image generation 10/min + 150/hr؛ free promo models carry no extra per-model
  limit؛ concurrency unlimited every plan؛ paid accounts (active Pass or topped-up wallet)
  have NO request-rate limit.
- Over-rate (docs): HTTP 429 with Retry-After header.
- 401 no key on models (live 2026-10-12): type=invalid_api_key, code=invalid_api_key,
  message=Invalid or revoked API key. Rotate your key at https://tokenharbor.ai/dashboard.
  (full body in §3).
- 429 failed-auth limiter (live 2026-10-12 — chat WITHOUT key AND with bad key BOTH hit it):
  HTTP 429, type=rate_limit_exceeded, code=rate_limit_exceeded,
  message=Too many failed authentication attempts. Try again later.
  NOTE — the limiter tripped during probing, so the TRUE no-key/bad-key chat shapes are
  still unknown (§4). Do not treat this 429 as the auth-error shape.
- 404 unknown /v1 path (live 2026-10-12: /v1/me, /usage, /billing, /wallet, /keys, bare /v1):
  HTTP 404 Next.js HTML page — NOT an API error envelope.
- 405 wrong method (live 2026-10-12: GET /v1/messages): HTTP 405, empty body.
- Per-key spend caps (docs-sourced, universal-key): Daily/Weekly/Monthly USD caps, rolling
  windows؛ over → 429 spend_limit_exceeded + Retry-After. Vendor allow/block lists →
  403 vendor_not_allowed (dashboard has no editor — applies only to keys that carry one).
- Spent free allowance (provider-code-observed, NOT live): 429 free_tier_limit_reached,
  message names the reset ("Your next rolling 7-day period starts on ...").
- Exact cache (docs-sourced, how-we-bill): identical model+messages+sampling within 5 min on
  chat → billed $0 with X-TH-Cache-Layer: exact؛ tools-carrying requests skip it.
  Long repeated prefixes (>=1024 tok) → up to 90% off via maker prompt cache.

## 7. Router integration recipe (per COOKBOOK.md §1)

1. Provider module EXISTS: src/renderer/providers/tokenharbor.js (registers itself, nothing
   imports it): id=tokenharbor, name=Token Harbor, baseUrl=https://tokenharbor.ai/v1,
   color=#e64980 (logo is a cream #F8F6F2 mono mark, re-inked per theme),
   logo=../assets/providers/tokenharbor.svg, modelsEndpoint=/models,
   chatEndpoint=/chat/completions, freeTier:true, rpm:60. Fetch = key's $0/$0 :free ids
   only (missing/partial pricing treated as paid)؛ quota-code + usage-header readers built in.
2. Logo: src/assets/providers/tokenharbor.svg (already in repo — verified).
3. src/renderer/index.html: script providers/tokenharbor.js BEFORE app.js (verify present).
4. Fixture + count: extend scripts/live/fixture.mjs and bump READY in scripts/live/verify-db.mjs.
5. README.md row: FORBIDDEN by this task's scope (integrations doc only) — NOT done here.
6. npm run repo:map (only if files changed — none changed here besides this doc).

Accept: npm test then npm run verify:live.

NOTE — provider id tokenharbor already integrated in app؛ allowlist = 3 :free ids NOT yet
chat-ping-verified (§5 WARNING governs — verify live per key before routing traffic).

## 8. Account & Quota (Raw → normalized, keyless probes + docs + user screenshots 2026-10-12)

| Router field | Raw source | Value observed / mapping |
|---|---|---|
| PLAN | Dashboard Overview page (user screenshot 2026-10-12, screenshot-sourced) + docs | Free Access = current tier (Free allowance 0% used, Resets in 5d 6h؛ 1 key created). Paid upsell shown: Explore Passes Agent $0.99 first month then $1.99 (docs billing/subscription: Office $9.99, Frontier $99؛ $10/$35/$180 4-week usage-value allowances, NOT wallet credit). New accounts $0 — no welcome credit (docs billing/credits) |
| QUOTA | Dashboard Overview + Usage 7D pages (user screenshots 2026-10-12, screenshot-sourced) + docs | Free allowance 0% used, Resets in 5d 6h (Overview). Usage Last-7-days: 10 Requests, 322 Tokens (Input 190, 0% cached, Output 132), Est Spend $0.00, Avg/Req 32 tk. Top models: claude-haiku-5.5 50%, deepseek-v4.1-flash 20%, deepseek-v4-flash 10%. By API key DD...tzXZ: 10 req, $0.00. TH-Rudder: free for everyone, Limited time, Unlimited use limited-time-only in Webchat, campaign route never billed. Data&privacy: free-models-enabled toggle ON. Free allowance = rolling 7x24h personal period from first free request, measured in list-price value not requests, 0–100% bar (docs billing/cashback) |
| RESET TIME | Overview screenshot + docs | Resets in 5d 6h (screenshot). Rolling 7x24h personal period (docs — not calendar week)؛ campaigns carry their own end date or share the free-tier allowance (docs) |
| EXPIRY | Docs billing/credits + billing/subscription | Top-up credits NEVER expire. Free allowance refreshes each rolling period (unused does not carry). Pass allowances: 4-week cycle split in 7-day windows, no carry-over, not added to wallet |
| NAME / EMAIL | Keyless 404 sweep (live 2026-10-12) + docs | NOT EXPOSED via API key (/v1/me /usage /billing /wallet /keys all 404؛ no key-management API — dashboard only) |
