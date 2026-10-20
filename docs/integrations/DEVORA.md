# Devora — Provider Reference

Main reference for adding Devora as a venom-router provider.
Evidence: HeX-verified 2026-10-13 (GET /v1/models with-key 200 1-model roster,
no-auth 401 shape, POST /v1/chat/completions 200 with usage, site-root 200
landing + no favicon — marked HeX-verified where used) + in-repo devora.js
comments (default-discovery note, billing block — marked in-repo where used)
+ user-reported event unlimited / 7 days left (marked user-reported/UNVERIFIED
where used).
No real key value is stored in this repo — use $DEVORA_KEY.

## 0. Summary (ملخص)

| Field (الحقل) | Value (القيمة) |
|---|---|
| Provider name | Devora |
| Provider URL | https://devora.my.id (HeX-verified 2026-10-13: 200 landing) |
| API base | https://api.devora.my.id/v1 (OpenAI-compatible, HeX-verified 2026-10-13) |
| Icon URL | src/assets/providers/devora.svg — IN repo (Pixel-created 417B, HeX-read 2026-10-13: mint #12b3a4 + ink #17140d, logoTone bright) |
| Provider type | API KEY (Bearer) |
| Type color dot | API Key (var(--type-apikey)) + Free Tier (freeTier:true, in-repo devora.js) |
| Consumption | Event UNLIMITED plan (user-reported, UNVERIFIED — 7 days left per user report). Router allowlist = 1 served id under the sub (section 5) per user rule 2026-10-12 |
| Plans | Event unlimited plan, 7 days left (user-reported, UNVERIFIED). No plan/account endpoint observed — section 4 |
| Key-fetchable plan/quota/reset/expiry | NO observed — no account endpoint probed (section 4, UNKNOWN) |
| Needs web session | UNKNOWN — no management surface observed |

## 1. Overview + base URLs

- OpenAI-compatible API base: https://api.devora.my.id/v1 (HeX-verified
  2026-10-13 — GET /v1/models with key answers 200 with the 1-id roster;
  POST /v1/chat/completions answers 200 with usage).
- Site root: https://devora.my.id returns HTTP 200 landing, no favicon
  (HeX-verified 2026-10-13).
- Style: OpenAI-compatible (/v1/models, /v1/chat/completions).
- Catalogue observed: 1 unique id on GET /v1/models with key
  (HeX-verified 2026-10-13): devora-01/deepseek/deepseek-v4.1-flash
  (DeepSeek V4.1 Flash, ctx 1000000, caps reasoning+tools, pricing
  credits_per_million in 400 / out 1000).
- Entry shape: id devora-01/deepseek/deepseek-v4.1-flash / display
  DeepSeek V4.1 Flash / context 1000000 / caps reasoning+tools /
  pricing credits_per_million in 400 / out 1000 (HeX-verified).
  credits_per_million is NOT parsed by the catalog (in-repo devora.js
  note) — informational only under the unlimited plan.
- Key finding (per user rule 2026-10-12): the event plan is reported
  UNLIMITED usage (user-reported, UNVERIFIED), NOT a free grant — so the
  1 served id is routable (section 5).

## 2. Auth

All gated calls require a header. GET /v1/models without a key is refused
(HeX-verified 2026-10-13).

    Authorization: Bearer $DEVORA_KEY

No-auth behaviour on the models roster: 401 invalid_api_key
(HeX-verified 2026-10-13). Bad-key shape: UNKNOWN (section 4).

## 3. Verified endpoints (HeX-verified 2026-10-13, with-key + no-auth)

### GET /v1/models (auth-gated — key required)

- With-key (HeX-verified): HTTP 200, data of 1 entry:
  devora-01/deepseek/deepseek-v4.1-flash.
- No-auth (HeX-verified): HTTP 401, code invalid_api_key.
- Count: 1 unique id. Context: 1000000. Caps: reasoning+tools.
  Pricing: credits_per_million in 400 / out 1000 (informational).
- NOTE: no per-key allowlist evidence beyond the single served id. Router
  offers the 1 served id (section 5).

### POST /v1/chat/completions (auth-gated — key required)

- With-key ping model=devora-01/deepseek/deepseek-v4.1-flash max_tokens=2
  (HeX-verified 2026-10-13): HTTP 200 with usage.
- No-auth / bad-key chat shapes: UNKNOWN (section 4).

### Site root (HeX-verified 2026-10-13)

- GET / (site root): HTTP 200 landing, no favicon.

## 4. Unverified / not probed

- GET /v1/models WITH a synthetic bad key (401 shape detail) — UNKNOWN.
- POST /v1/chat/completions no-auth / bad-key shapes — UNKNOWN.
- 404 unknown-model shape with any key — UNKNOWN.
- Streaming (stream:true SSE) — NOT probed.
- Any account/plan/quota/usage/billing endpoint (/v1/me, /usage, /billing,
  /wallet, /keys or similar) — NOT probed. Do not assume paths.
- Logo file src/assets/providers/devora.svg — IN repo (Pixel-created 417B, HeX-read 2026-10-13: mint #12b3a4 + ink #17140d, logoTone bright).
- Event-plan expiry / renewal (7 days left is user-reported, UNVERIFIED).

## 5. Models roster — the 1 served id under the event sub (roster-verified HeX 2026-10-13; chat ping HeX-verified)

GET /v1/models with key answers the 1-id roster (HeX-verified). Per user
rule 2026-10-12 (collect free + free-quota-covered + sub/unlimited models;
this event plan is reported UNLIMITED usage, user-reported UNVERIFIED):
the 1 served id is routable.

WARNING — chat-ping verified here only for the single HeX ping
(max_tokens=2, section 3). Stop offering at plan EXPIRY (7 days left per
user report, UNVERIFIED) unless renewed, or if any real per-token charge
appears.
Roster growth (user-reported 2026-10-13, UNVERIFIED): user reports fetch
now returns 4 models (2 working) vs the HeX-verified 1-id roster above —
ids UNKNOWN, do not invent them; re-probe GET /v1/models with key to
confirm before expanding the allowlist.

Router allowlist — 1 served id (HeX-verified roster):

    devora-01/deepseek/deepseek-v4.1-flash

Notes: context 1000000. Caps reasoning+tools. Re-check the roster per
billing period.

## 6. Rate limits + errors

- Rate limits: UNLIMITED chat under the event sub (user-reported,
  UNVERIFIED). No rate-limit headers captured. No RPM declared in-repo.
- 200 roster (HeX-verified: GET /v1/models with key): HTTP 200, data of
  1 entry.
- 401 models no-auth (HeX-verified): HTTP 401, code invalid_api_key.
- 200 chat (HeX-verified): HTTP 200 with usage,
  model=devora-01/deepseek/deepseek-v4.1-flash max_tokens=2.
- Bad-key / unknown-model / site-error shapes: UNKNOWN (section 4).
- With-key 200/4xx chat shapes beyond the HeX ping: UNKNOWN (section 4).

## 7. How the app implements it

1. Provider module EXISTS: src/renderer/providers/devora.js (registers
   itself, nothing imports it): id=devora, name=Devora,
   baseUrl=https://api.devora.my.id/v1, color=#12b3a4 (teal, in-repo value), logo=../assets/providers/devora.svg,
   logoTone bright + freeTier:true + planNote 'Event unlimited · free' (in-repo; user-reported plan, UNVERIFIED),
   modelsEndpoint=/models, chatEndpoint=/chat/completions, billing plan
   Event unlimited + unlimitedUsage block (in-repo). Default discovery —
   no fetchModels (in-repo note: context_length/caps handled by default;
   credits_per_million informational under unlimited plan).
2. Logo: src/assets/providers/devora.svg — IN REPO (Pixel-created 417B, HeX-read 2026-10-13; logoTone bright).
3. src/renderer/index.html: script providers/devora.js BEFORE app.js.
4. Fixture + count: the built-in count asserted by the live checks
   (scripts/live/verify-db.mjs, legend/sidebar/provider-table) is **eleven**.
5. README row: docs/integrations/README.md Devora row.
6. npm run repo:map (new files surface in CODE_MAP.md).

Accept: npm test then npm run verify:live.

NOTE — provider id devora integrated in app; allowlist = 1 served id under
the event unlimited sub while ACTIVE (section 5 WARNING — only the HeX
ping is chat-verified; expiry 7 days left is user-reported UNVERIFIED).

## 8. Account & Quota (Raw → normalized, HeX-verified context + user-reported plan)

| Router field | Raw source | Value observed / mapping |
|---|---|---|
| PLAN | User-reported context 2026-10-13 (UNVERIFIED) | Event unlimited plan — no key-fetchable plan |
| QUOTA | User-reported context + in-repo billing block | Reported unlimited usage, no published per-key quota |
| RESET TIME | No quota endpoint observed | UNKNOWN — NOT key-fetchable |
| EXPIRY | User-reported context 2026-10-13 (UNVERIFIED) | 7 days left unless renewed |
| NAME / EMAIL | Probed surface (HeX-verified) | NOT EXPOSED via API key (models roster carries no identity) |
