# Jerouter — Provider Reference

Main reference for adding Jerouter (Jerouter V2) as a venom-router provider.
Evidence: live keyless + synthetic-bad-key probes 2026-10-12 (GET /v1/models
public roster, chat no-auth/bad-key 401 shapes, unknown-model 404 shape,
Anthropic POST /v1/messages no-auth/bad-key 401 shapes, image POST
/v1/images/generations no-auth/bad-key 401 shapes, unknown-route + site-root
shapes) + HeX-verified with-key evidence 2026-10-12 (chat model=big-pickle 200,
usage prompt 31 / completion 5 — marked HeX-verified where used) + in-repo
jerouter.js comments (image model=ig 1 gen/min, Anthropic base — marked
in-repo where used).
NO with-key probe was run in this doc pass (full key value never reached it),
so chat 200s beyond the HeX-verified ping are NOT verified — sections 4-5 govern.
No real key value is stored in this repo — use $JEROUTER_KEY.

## 0. Summary (ملخص)

| Field (الحقل) | Value (القيمة) |
|---|---|
| Provider name | Jerouter (Jerouter V2) |
| Provider URL | Telegram-bot only, no site — official access https://t.me/Jerouter_bot (HeX-verified 2026-10-12) |
| API base | https://je.jerouter.web.id/v1 (OpenAI-compatible, verified live) + Anthropic base https://je.jerouter.web.id (in-repo + HeX context) |
| Icon URL | src/assets/providers/jerouter.png — in repo (verified 2026-10-12) |
| Provider type | API KEY (Bearer) |
| Type color dot | API Key (var(--type-apikey)) |
| Consumption | $3/month UNLIMITED Pro plan — paid-only, no free quota, no per-token billing (HeX-verified). Router allowlist = all 44 served ids under the sub (section 5) per user rule 2026-10-12 |
| Plans | Pro plan $3/month unlimited, active until 11 Nov 2026 (HeX-verified). No plan/account endpoint observed — management via Telegram bot |
| Key-fetchable plan/quota/reset/expiry | NO observed — no account endpoint probed live in this pass (section 4) |
| Needs web session | Telegram bot https://t.me/Jerouter_bot (key issue + billing — HeX-verified) |

## 1. Overview + base URLs

- OpenAI-compatible API base: https://je.jerouter.web.id/v1 (verified live —
  GET /v1/models answers 200 with the 44-id roster keyless, probed 2026-10-12).
- Anthropic base: https://je.jerouter.web.id — POST /v1/messages is auth-gated
  (401 no-auth/bad-key shapes live 2026-10-12); no with-key ping in this pass.
- NO site: Telegram-bot only (HeX-verified 2026-10-12). Site root GET /
  returns HTTP 404 empty body (live 2026-10-12).
- Style: OpenAI-compatible (/v1/models, /v1/chat/completions) + Anthropic
  POST /v1/messages + image POST /v1/images/generations (in-repo: model=ig,
  1 gen/min — NOT probed with-key, section 4).
- Catalogue observed: 44 unique ids on GET /v1/models, identical with no key
  and with a synthetic bad key (live — the roster is PUBLIC, no per-key
  allowlist observed). All owned_by jerouter-v2. Context 262144 (32 ids) or
  524288 (12 ids). Vision true on 23 ids.
- Entry shape: id / object (model) / owned_by (jerouter-v2) / context_length /
  context_window / vision (bool) / capabilities-vision / architecture
  (input_modalities, modality, output_modalities). No pricing fields.
- Key finding (per user rule 2026-10-12): the $3/month sub is real UNLIMITED
  usage (HeX-verified), NOT a free grant — so all 44 served ids are routable
  except the bare-modifier id the module excludes (section 5).

## 2. Auth

All gated calls require a header. GET /v1/models is the exception — it
answers 200 WITHOUT any key (live 2026-10-12).

    Authorization: Bearer $JEROUTER_KEY

No-auth / bad-key behaviour on gated routes: 401 with per-surface shapes
(see section 6). Only the models roster is public.
## 3. Verified endpoints (probed live 2026-10-12, keyless + synthetic bad-key)

### GET /v1/models (PUBLIC — no key needed)

- No-auth (live): HTTP 200, body object:list with data of 44 entries.
- Synthetic-bad-key via Bearer (live): HTTP 200, SAME 44-id roster.
- Count: 44 unique ids. Context: 262144 x32, 524288 x12. owned_by jerouter-v2.
  vision=true on 23 ids.
- NOTE: public catalogue — NO per-key allowlist evidence. Router offers all 44
  served ids minus the module bare-modifier exclusion (section 5).
- Full roster: see section 5.

### POST /v1/chat/completions (auth-gated — key required)

- No-auth ping model=big-pickle max_tokens=2 (live): HTTP 401, body
  error code invalid_api_key, message "Invalid API key.".
- Bad-key ping same body (live): HTTP 401, body code invalid_api_key, message
  "API key is not authorized." — message differs from no-auth.
- Bad-key + unknown model no-such-model-xyz (live): HTTP 404, body message
  "Model not found or inactive.", type api_error, code model_not_found —
  model resolution answers BEFORE auth here.
- HeX-verified with-key ping (HeX-verified 2026-10-12): model=big-pickle 200,
  usage prompt 31 / completion 5. No other with-key chat shape verified here.

### POST /v1/messages — Anthropic surface (auth-gated)

- No-auth (live): HTTP 401, code missing_api_key, message "No API key
  provided. Send it as Authorization: Bearer <key>.",
  type invalid_request_error.
- Bad-key (live): HTTP 401, code invalid_key, message "Invalid API key. Check
  that you copied the whole key.", type invalid_request_error.
- NO with-key ping in this pass (section 4).

### POST /v1/images/generations (auth-gated)

- No-auth model=ig (live): HTTP 401, same missing_api_key shape as above.
- Bad-key model=ig (live): HTTP 401, same invalid_key shape as above.
- In-repo note (in-repo, jerouter.js): image model=ig, 1 gen/min limit. The
  limit was NOT exercised live (no key) — section 4.

### Unknown route + site root (live)

- GET /v1/no-such-route-xyz no-auth: HTTP 401 missing_api_key shape — auth
  runs before routing under /v1.
- GET / (site root): HTTP 404, empty body. No web app — Telegram bot only.

## 4. Unverified / not probed

- GET /v1/models WITH a real key (any per-key mark) — NOT probed. Section 5
  ids are roster-verified (public 200), NOT per-key-verified.
- POST /v1/chat/completions WITH a real key on any id except the HeX-verified
  big-pickle ping — NOT probed. No other id is chat-200-verified.
- 404 unknown-model shape WITH a real key — NOT probed (only bad-key 404 seen).
- POST /v1/messages WITH a real key — NOT probed.
- POST /v1/images/generations WITH a real key (200 shape, 1 gen/min) — NOT
  probed. Image generation is NOT documented as working.
- Streaming (stream:true SSE) — NOT probed.
- Any account/plan/quota/usage/billing endpoint (/v1/me, /usage, /billing,
  /wallet, /keys or similar) — NOT probed. Do not assume paths.
## 5. Models roster — all 44 served ids under the unlimited sub (roster-verified live 2026-10-12; chat pings NOT verified except HeX big-pickle)

GET /v1/models answers the same 44-id roster with no key and with a synthetic
bad key (live) — the catalogue is public. Per user rule 2026-10-12 (collect
free + free-quota-covered + sub/unlimited models; this $3/month plan is real
UNLIMITED usage, HeX-verified): all 44 served ids are routable EXCEPT the
bare-modifier id the provider module excludes. No $0/free concept here —
coverage comes from the flat sub.

WARNING — section 5 ids are roster-verified but NOT chat-ping-verified here
(except HeX big-pickle). Chat-ping per key before offering; offer only ids the
key sub serves; stop offering at plan EXPIRY 11 Nov 2026 unless renewed, or if
any real per-token charge appears.

Router allowlist — 43 served ids (live roster minus module exclusion):

    apodex-1.1-mini
    big-pickle
    big-pickle-unrestricted
    claude-haiku-5.5
    claude-opus-4-6
    claude-sonnet-4-6
    deepseek-unrestricted
    deepseek-v4.1-flash
    dots-3-note-preview
    exo
    glm-5.3-flash
    glm-5.3-flash-unrestricted
    grok-4.6
    grok-4.7
    jerouter
    jev-1.13
    laguna-s-2.1
    laguna-xs-2.1
    ling-3.0-flash-sante
    ling-3.1-flash
    longcat-2.5-preview
    longcat-unrestricted
    mimo-v2.6-flash
    muse-spark-1.3-contributor
    muse-unrestricted
    nemotron-3-super
    nemotron-3-ultra
    nemotron-3-ultra-unrestricted
    nemotron-3.5-lightning
    north-mini-code
    qwen3.7-max
    qwen3.7-plus
    qwen3.8-27b
    qwen3.8-27b-unsencored
    qwen3.8-flash
    qwen3.8-omni-flash
    sonnet-unrestricted
    space-bunny
    step-3.7-flash
    step-3.7-unrestricted
    step-5-preview
    step-5-preview-opencode
    step-5-unrestricted

EXCLUDED — bare modifier with no base model (module excludeModel, same rule as
Dark API; the exclusion lives in the provider module):

    unrestricted

Notes: 12 ids carry 524288 context; the other 32 carry 262144. Vision=true on
23 ids. Re-check the roster per billing period.
## 6. Rate limits + errors

- Rate limits: UNLIMITED chat under the $3/month Pro sub (HeX-verified).
  Image: 1 gen/min (in-repo jerouter.js comment — NOT exercised live). No
  rate-limit headers captured live.
- 200 public roster (live: GET /v1/models no-auth AND synthetic bad-key):
  HTTP 200, object:list with 44 entries. No-auth and bad-key INDISTINGUISHABLE.
- 401 chat no-auth (live): HTTP 401, code invalid_api_key, message
  "Invalid API key.".
- 401 chat bad-key on a REAL model id (live): HTTP 401, code invalid_api_key,
  message "API key is not authorized." — same code, different message.
- 404 chat bad-key + unknown model (live): HTTP 404, message "Model not found
  or inactive.", type api_error, code model_not_found. With-key 404 UNKNOWN.
- 401 Anthropic/image no-auth (live): HTTP 401, code missing_api_key, message
  "No API key provided. Send it as Authorization: Bearer <key>.",
  type invalid_request_error.
- 401 Anthropic/image bad-key (live): HTTP 401, code invalid_key, message
  "Invalid API key. Check that you copied the whole key.",
  type invalid_request_error.
- 401 unknown /v1 path no-auth (live): HTTP 401 missing_api_key shape.
- 404 site root (live: GET /): HTTP 404, empty body.
- Headers observed live: x-jerouter-provider Jerouter, x-jerouter-route oracle
  (models/anthropic/image) or cloudflare (chat), x-jerouter-edge-dispatcher
  production (chat), x-anti-resale with Telegram contacts (chat 401s).
- With-key 200/4xx chat shapes beyond HeX big-pickle: UNKNOWN (section 4).

## 7. How the app implements it

1. Provider module EXISTS: src/renderer/providers/jerouter.js (registers
   itself, nothing imports it): id=jerouter, name=Jerouter,
   baseUrl=https://je.jerouter.web.id/v1, color=#f97316 (in-repo value),
   logo=../assets/providers/jerouter.png, logoTone=bright,
   modelsEndpoint=/models, chatEndpoint=/chat/completions, billing plan $3 /
   month + unlimitedUsage block + excludeModel() for bare modifiers.
2. Logo: src/assets/providers/jerouter.png — ALREADY IN REPO (verified).
3. src/renderer/index.html: script providers/jerouter.js BEFORE app.js.
4. Fixture + count: the built-in count asserted by the live checks
   (scripts/live/verify-db.mjs, legend/sidebar/provider-table) is **eleven**.
5. README row: docs/integrations/README.md Jerouter row (venom-router/README.md
   itself is Pixel-owned, untouched).
6. npm run repo:map (new file surfaces in CODE_MAP.md).

Accept: npm test then npm run verify:live.

NOTE — provider id jerouter integrated in app; allowlist = 43 served ids under
the $3/month unlimited sub while ACTIVE (section 5 WARNING — chat-ping per key
before routing; only big-pickle is HeX-verified).

## 8. Account & Quota (Raw → normalized, HeX-verified context + keyless probes)

| Router field | Raw source | Value observed / mapping |
|---|---|---|
| PLAN | HeX-verified context 2026-10-12 | Pro plan $3/month unlimited, paid-only Telegram-bot service — no key-fetchable plan |
| QUOTA | HeX-verified context + in-repo billing block | Real unlimited usage, no published per-key quota; image 1 gen/min (in-repo, NOT live) |
| RESET TIME | No quota endpoint observed | Monthly billing cycle (interval monthly, in-repo) — NOT key-fetchable |
| EXPIRY | HeX-verified context 2026-10-12 | Active until 11 Nov 2026 unless renewed |
| NAME / EMAIL | Keyless probe surface (live) | NOT EXPOSED via API key (public roster carries no identity) |
