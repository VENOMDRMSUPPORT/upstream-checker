# Nexum Router — Provider Reference

Main reference for adding Nexum Router (by Dialagram) as a venom-router provider.
Evidence: live keyless probes 2026-10-12 (GET /v1/models no-auth + bad-key 401,
chat no-auth/bad-key 401 via Bearer + x-api-key, /models/ 307, /router/v1 301,
/router/claude/v1/models 401, account-endpoint 404 sweep) + official docs page
https://dialagram.me/nexum-router (reached via /docs redirect, Last updated 2026-08-31 —
marked docs-sourced where used) + Account page screenshot 2026-10-12
(marked screenshot-sourced where used) + in-repo nexum.js comments (live /models
shape + image/video note — marked in-repo where used).
NO with-key probe was possible (full key value never reached this doc pass) — see §4/§5.
No real key value is stored in this repo — use $NEXUM_KEY.

## 0. Summary (ملخص)

| Field (الحقل) | Value (القيمة) |
|---|---|
| Provider name (اسم المزود) | Nexum Router (by Dialagram) |
| Provider URL (رابط المزود) | https://dialagram.me/ (site + docs host) |
| API base (قاعدة الـ API) | https://dialagram.me/router/v1 |
| Icon URL (مسار الأيقونة) | src/assets/providers/nexum.svg — in repo |
| Provider type (نوع المزود) | API KEY (Bearer or x-api-key) |
| Type color dot (لون النوع) | API Key (var(--type-apikey)) |
| Consumption (الاستهلاك) | flat $5.50/week UNLIMITED sub — no free quota, no per-token billing, no RPM limits. Account page screenshot 2026-10-12 (screenshot-sourced): badges ACTIVE + Access Enabled؛ RATE LIMITS Infinity؛ 5 hour usage limit 100% remaining ∞؛ Weekly usage limit 100% remaining ∞, Resets every 7 days. Router allowlist = 6 docs-listed chat ids under the sub (§5) per user rule 2026-10-12 (EXCLUDE only real-paid-balance burners + non-chat modalities) |
| Plans (الخطط) | PLAN = DialaStudio Weekly Pass؛ AMOUNT $5.50؛ INTERVAL week (Account page screenshot 2026-10-12, screenshot-sourced). Docs (docs-sourced): one flat $5.50/week plan — every model and every tool included؛ no hourly limits, no weekly caps, no five-hour session windows؛ cancel anytime from the dashboard. No plan/account endpoint (404 sweep) — billing via Dialagram dashboard |
| Key-fetchable: plan/quota/reset/expiry (بالمفتاح) | NO — me/account/user/billing/balance/usage/subscription/wallet/keys/api-keys all 404 (live keyless sweep 2026-10-12)؛ plan/quota/renewal NOT exposed via key |
| Needs web session (يحتاج جلسة ويب) | Dialagram dashboard (API key creation, billing, usage dashboard — docs-sourced) + status page (docs-sourced) |

## 1. Overview + base URLs

- API base: https://dialagram.me/router/v1 (verified live — auth-gated, 401 without key, probed 2026-10-12).
- Site: https://dialagram.me/ (docs host).
- Docs: https://dialagram.me/docs redirects (302) to https://dialagram.me/nexum-router
  (Last updated: 2026-08-31, probed live 2026-10-12). No /router/docs (404).
- Claude Code endpoint: /router/claude (docs-sourced — set ANTHROPIC_BASE_URL and go؛
  /router/claude/v1/models is auth-gated too, 401 live 2026-10-12).
- Style: OpenAI-compatible (/v1/models, /v1/chat/completions) + Anthropic-compatible Claude endpoint.
- Docs-listed chat models (docs-sourced 2026-10-12): qwen-3.7-max (+ thinking variant
  qwen-3.7-max-thinking), xiaomi-mimo-2.6, xiaomi-mimo-2.5, meta-muse-spark-1.2,
  meta-muse-spark-1.3 — 6 chat ids.
- In-repo note (in-repo, nexum.js comments): live GET /v1/models returns id, object,
  created, owned_by, display_name, context_window, context_length, max_input_tokens, limit
  and nothing else — NO modality field. Nexum mixes chat + image + video behind the same
  endpoint (qwen-image answers a chat request with a markdown image link؛ wan-2.0 video).
- Key finding (per user rule 2026-10-12): the $5.50/week sub is real UNLIMITED usage
  (Infinity rate limits, 100% remaining — screenshot), NOT a free grant and NOT per-token
  billing — so working chat models under the sub are routable, same logic as a sub/unlimited
  pool. §5 governs. Catalogue NOT verified against live /models (no with-key probe).

## 2. Auth

All /router/v1/* requests require one of these headers (header names from the live 401
message, probed 2026-10-12):

```http
Authorization: Bearer $NEXUM_KEY
```

```http
x-api-key: $NEXUM_KEY
```

Docs: subscribe once, create an API key in the dashboard, point tools at one stable
endpoint (docs-sourced). Bad-key parity verified live on BOTH headers (same 401 shape,
see §6). No-auth / bad-key behaviour: 401 (see §6). Nothing is public here.
## 3. Verified endpoints (probed live 2026-10-12, keyless)

### GET /router/v1/models (auth-gated — key required)

- No-auth (live 2026-10-12): HTTP 401, body
  {"error":{"message":"Invalid or missing API key. Provide Authorization: Bearer <api_key>
  or x-api-key: <api_key>.","type":"invalid_request_error","param":null,"code":"invalid_api_key"}}.
- Bad-key via x-api-key: def-invalid-probe (live 2026-10-12): HTTP 401, shape
  {"type":"error","error":{"type":"authentication_error","message":"Invalid or missing API key.
  Provide Authorization: Bearer <api_key> or x-api-key: <api_key>.","code":"invalid_api_key"}}
  — NOTE the outer type:error wrapper present on x-api-key but not on bare no-auth (§6).
- Trailing slash GET /router/v1/models/ (live 2026-10-12): HTTP 307 (redirect, not probed further).
- Root GET /router/v1 (live 2026-10-12): HTTP 301 → http://dialagram.me:5000/router/v1/
  (backend port leak — do not use).
- Claude endpoint GET /router/claude/v1/models (live 2026-10-12): HTTP 401, same
  invalid_api_key message (auth-gated too).
- NO with-key /models fetch was possible — catalogue ids, prices, sub-covered marks
  NOT verified live. §5 ids are docs-sourced (see §5).

### POST /router/v1/chat/completions (auth-gated — key required)

- No-auth ping, model=x, max_tokens=2 (live 2026-10-12): HTTP 401, same invalid_api_key
  shape as /models no-auth.
- Bad-key ping via Bearer: def-invalid-probe, model=qwen-3.7-max, max_tokens=2
  (live 2026-10-12): HTTP 401, same invalid_api_key shape (no-key and bad-key
  indistinguishable on Bearer).
- Bad-key ping via x-api-key: def-invalid-probe, model=qwen-3.7-max, max_tokens=2
  (live 2026-10-12): HTTP 401, same invalid_api_key shape.
- NO with-key chat ping was possible — 200 vs 4xx shapes + usage in/out UNKNOWN (§4).

### Account/plan/usage endpoints — 404 sweep (keyless, live 2026-10-12)

No account/billing endpoint exists under the router base. All of these return 404:
/router/v1/me, /account, /user, /billing, /balance, /usage, /subscription, /wallet,
/keys, /api-keys. Plan/renewal/usage/name-email are NOT key-fetchable — §8 is
screenshot-sourced. No /api/models, /api/pricing, /api/plans either (in-repo note).

## 4. Unverified / not probed

- GET /router/v1/models WITH a real key (catalogue ids, display_names, context windows,
  prices/sub-covered marks) — NOT probed (full key value never reached this doc pass).
  Do not treat the §5 list as /models-verified.
- POST /router/v1/chat/completions WITH a real key on ANY id (200 shape, usage in/out,
  finish_reason) — NOT probed. Do not document any id as chat-200-verified until live-tested.
- Streaming (stream:true SSE) — NOT probed.
- /router/claude endpoint beyond the /v1/models 401 (Anthropic-compatible chat) — NOT probed.
- Image ids (qwen-image family) + video ids (wan-2.0 family) — known from the in-repo
  classify() note only, NOT probed live in this pass. Do not document as working.
- Dashboard/status pages (billing, usage dashboard, leaderboard) — docs-mentioned only.
- The live public leaderboard token volume (docs-sourced claim) — NOT checked.

## 5. Models roster — docs-listed chat ids under the weekly sub (docs + in-repo 2026-10-12؛ chat pings NOT verified — per user rule 2026-10-12)

Docs page https://dialagram.me/nexum-router lists these chat ids (docs-sourced 2026-10-12):
qwen-3.7-max (+ thinking variant qwen-3.7-max-thinking), xiaomi-mimo-2.6, xiaomi-mimo-2.5,
meta-muse-spark-1.2, meta-muse-spark-1.3. Per user rule 2026-10-12 (router base rule =
collect free models + free-quota-covered models + sub/unlimited models؛ EXCLUDE only models
that burn real paid balance): the $5.50/week plan is real UNLIMITED usage (Infinity rate
limits, 100% remaining — screenshot), so working chat models under the sub are routable.
No $0 / free-marked model concept here — coverage comes from the flat sub, not $0 pricing.

> WARNING — §5 ids are NOT chat-ping-verified and NOT /models-verified (no with-key probe
> was possible). Re-fetch GET /router/v1/models + chat-ping per key before offering؛ stop
> offering at NEXT RENEWAL 10/17/2026 2:50:30 AM unless the period renews, or if any real
> per-token charge appears.
Chat ids under the weekly sub (docs 2026-10-12) — note there is **no allowlist in the
app**: the adapter has no `fetchModels`, so the shared default discovery offers the whole
live `/v1/models` roster, and these six are only the documented chat ids (see §7):

```text
qwen-3.7-max
qwen-3.7-max-thinking
xiaomi-mimo-2.6
xiaomi-mimo-2.5
meta-muse-spark-1.2
meta-muse-spark-1.3
```

EXCLUDED — non-chat modalities behind the same endpoint (in-repo nexum.js classify(),
NOT probed live in this pass — excluded from chat routing until verified):

```text
qwen-image (family — answers chat with a markdown image link)
wan-2.0 (family — video)
```

Notes: the 6 allowlist ids come from the docs page model list (docs-sourced) — they are
NOT /models-verified and have NO live chat-200 in this pass. Docs position Xiaomi Mimo 2.5
for everyday work and Qwen 3.7 Max for flagship coding/agentic sessions (docs-sourced).
Image/video ids are excluded from CHAT routing only (classify() tags them so each is judged
by the right standard — in-repo). Re-check the catalogue per billing period.

## 6. Rate limits + errors

- Rate limits: UNLIMITED (screenshot-sourced 2026-10-12 — RATE LIMITS Infinity badge؛
  5 hour usage limit 100% remaining ∞؛ Weekly usage limit 100% remaining ∞, Resets every
  7 days). Docs corroboration (docs-sourced): no hourly limits, no weekly caps, no
  five-hour session windows. Docs usage comparison: weekly throughput matches/beats the
  Claude Code Max 20x ($200/month) ceiling at ~1/8 the price (docs-sourced claim, NOT checked).
- 401 no key (live 2026-10-12, /models no-auth AND chat no-auth): HTTP 401, body
  {"error":{"message":"Invalid or missing API key. Provide Authorization: Bearer <api_key>
  or x-api-key: <api_key>.","type":"invalid_request_error","param":null,"code":"invalid_api_key"}}.
- 401 bad key via x-api-key (live 2026-10-12, /models): HTTP 401, body
  {"type":"error","error":{"type":"authentication_error","message":"Invalid or missing API key.
  Provide Authorization: Bearer <api_key> or x-api-key: <api_key>.","code":"invalid_api_key"}}
  — outer type:error wrapper present (differs from bare no-auth shape above).
- 401 bad key via Bearer (live 2026-10-12, chat model=qwen-3.7-max): HTTP 401, same
  invalid_request_error shape as no-auth — no-key and bad-key indistinguishable on Bearer.
- 401 bad key via x-api-key (live 2026-10-12, chat model=qwen-3.7-max): HTTP 401, same
  invalid_request_error shape.
- 307 trailing slash (live 2026-10-12: GET /router/v1/models/): HTTP 307 redirect.
- 301 backend leak (live 2026-10-12: GET /router/v1): HTTP 301 → http://dialagram.me:5000/router/v1/.
- 404 bad serving path (live 2026-10-12: whole §3 sweep incl /v1/me, /v1/usage, /v1/billing):
  HTTP 404. No error-envelope shape recorded.
- 404 router docs (live 2026-10-12: /router/docs): HTTP 404 — docs live at /nexum-router.
- With-key 200/4xx chat shapes: UNKNOWN (§4).

## 7. How the app implements it

`src/renderer/providers/nexum.js` is the built-in adapter. It registers itself;
nothing imports it.

1. Provider module: id=nexum, name=Nexum Router,
   baseUrl=https://dialagram.me/router/v1, color=#10b981,
   logo=../assets/providers/nexum.svg, modelsEndpoint=/models,
   chatEndpoint=/chat/completions,
   billing {plan $5.50/week, interval weekly, usage unlimited} + unlimitedUsage block +
   classify() tagging image/video vs chat by id+display_name (in-repo — the only modality
   signal, since /models carries no modality field).
2. Logo: src/assets/providers/nexum.svg — ALREADY IN REPO (verified 2026-10-12 —
   gradient-frame tile: #06b6d4 → #10b981 → #f59e0b, dark core #0f172a → #020617).
3. src/renderer/index.html: script providers/nexum.js BEFORE app.js.
4. Fixture + count: the built-in count asserted by the live checks is
   **thirteen**.
5. README.md: the Nexum Router row in the providers table.
6. npm run repo:map (new file surfaces in CODE_MAP.md).

There is **no allowlist and no `fetchModels`**: the shared default discovery
offers everything `GET /v1/models` returns. What the adapter adds is a
`classify()` hook — Nexum mixes chat, image and video models behind one
endpoint, and `/v1/models` publishes no modality field, so name matching on
both `id` and `display_name` is the only signal available. It is what keeps a
generator from being judged by asking it what 2+2 is.

Accept: npm test then npm run verify:live.

## 8. Account & Quota (Raw → normalized, keyless probes + docs + Account screenshot 2026-10-12)

| Router field | Raw source | Value observed / mapping |
|---|---|---|
| PLAN | Account page (user screenshot 2026-10-12, screenshot-sourced) | Header "Ultra Pass billing and access status"؛ badges ACTIVE + Access Enabled؛ PLAN DialaStudio Weekly Pass؛ AMOUNT $5.50؛ INTERVAL week؛ START DATE 8/29/2026 2:47:27 AM — no key-fetchable plan |
| QUOTA | Account page (user screenshot 2026-10-12, screenshot-sourced) | No free quota — real unlimited usage: 5 hour usage limit 100% remaining ∞؛ Weekly usage limit 100% remaining ∞, Resets every 7 days. Docs corroboration (docs-sourced): no hourly limits, no weekly caps, no five-hour windows؛ every model + tool included |
| RESET TIME | Account page (user screenshot 2026-10-12, screenshot-sourced) | NEXT RENEWAL 10/17/2026 2:50:30 AM (current period 10/10/2026 2:50:30 AM → 10/17/2026 2:50:30 AM)؛ Weekly usage limit Resets every 7 days — NOT key-fetchable, re-check per period |
| EXPIRY | Account page (user screenshot 2026-10-12, screenshot-sourced) | NEXT RENEWAL 10/17/2026 2:50:30 AM unless the period renews (cancel anytime from dashboard — docs-sourced) |
| NAME / EMAIL | - (no account endpoint) | NOT EXPOSED via API key |
