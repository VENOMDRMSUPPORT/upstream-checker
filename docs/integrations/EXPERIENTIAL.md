# Experiential — Provider Reference

Main reference for adding Experiential (Experiential Labs) as a venom-router provider.
Evidence: live probes 2026-10-12 (root, GET /v1/models, chat ping max_tokens:5,
401/403/404/503 error shapes, billing-endpoint 404 sweep) + user dashboard
screenshot 2026-10-12 (marked screenshot-sourced where used).
No real key value is stored in this repo — use $EXPERIENTIAL_KEY.

## 0. Summary (ملخص)

| Field (الحقل) | Value (القيمة) |
|---|---|
| Provider name (اسم المزود) | Experiential (Experiential Labs) |
| Provider URL (رابط المزود) | https://api.experientiallabs.ai/ (API host — root 404 live) |
| API base (قاعدة الـ API) | https://api.experientiallabs.ai/v1 |
| Icon URL (مسار الأيقونة) | src/assets/providers/experiential.svg — in repo |
| Provider type (نوع المزود) | API KEY (Bearer, gateway virtual key) |
| Type color dot (لون النوع) | API Key (var(--type-apikey)) |
| Consumption (الاستهلاك) | محدود — Free models only (user rule 2026-10-11: PAYG excluded) — Promotional free set 5 ids (screenshot 2026-10-12)؛ chat ping live OK on qwen3.8-flash-next-uncensored (usage reported cost 1.03e-05 — dashboard says Free, screenshot-sourced) |
| Plans (الخطط) | Promotional free tier only observed (screenshot-sourced)؛ no plan-catalogue endpoint — me/account/user/billing/balance/credit/quota/subscription/usage/wallet all 404؛ PAYG / balance-deducting models excluded per standing rule — router never offers them |
| Key-fetchable: plan/quota/reset/expiry (بالمفتاح) | NO — no account endpoint (404 sweep)؛ plan/quota/reset/expiry/name-email NOT exposed via key |
| Needs web session (يحتاج جلسة ويب) | Dashboard / billing UI (no API endpoint found live) |

## 1. Overview + base URLs

- API host: https://api.experientiallabs.ai/ (root 404, FastAPI default detail Not Found, probed live 2026-10-12).
- Gateway API base: https://api.experientiallabs.ai/v1 (verified live — GET /v1/models + Bearer works).
- Style: OpenAI-compatible gateway (/v1/models, /v1/chat/completions) using virtual keys (see the 401 wording in §6).
- Catalogue observed: 292 models on GET /v1/models (single probe key, live 2026-10-12).
- Model entries carry capability flags (uncensored, supports_tools, supports_reasoning, emits_images etc) + context_window_tokens / maximum_output_tokens + pricing in nano USD per million tokens.
- Free-set mapping note: screenshot display names map to live ids 1:1 except Jev (Free) which maps to jev-latest — bare jev is ABSENT from the catalogue and 403 ungranted (see §3 + §5).

## 2. Auth

All /v1/* endpoints require a header:

```http
Authorization: Bearer $EXPERIENTIAL_KEY
```

Single probe key (no second account). No-auth / bad-key behaviour: 401 (see §6).
The gateway calls the credential a virtual key (see the 401 message wording).

## 3. Verified endpoints (probed live 2026-10-12)

### GET /v1/models (auth)

- Count observed: 292 models (single probe key, live 2026-10-12).
- Entry shape: id / object (model) / created (0) / owned_by (exp) / data_policy / uncensored /
  supports_tools / supports_embeddings / supports_image_generation / emits_images /
  supports_structured_output / supports_completions / supports_temperature / supports_top_p /
  supports_reasoning / reasoning_effort / chat_max_tokens_field (max_tokens) /
  temperature + top_p ranges / context_window_tokens / maximum_output_tokens / pricing.
- Example entry: aion-2.0 / owned_by exp / context 131072 / max output 32768 / reasoning medium /
  pricing input 800000000 + cached 200000000 + output 1600000000 nano USD per million tokens.
- Free ids (screenshot display names 2026-10-12 → live ids): Clef Flash (Free) → clef-flash؛
  Clef (Free) → clef؛ GPT-6 Luna Decisions (Free) → gpt-6-luna-decisions؛
  Qwen3.8 Flash Next Uncensored (Free) → qwen3.8-flash-next-uncensored؛
  Jev (Free) → jev-latest (bare jev ABSENT from catalogue).
- Free-id pricing fields (live): output 0 on clef / clef-flash / gpt-6-luna-decisions
  (cache_write nonzero on gpt-6-luna-decisions)؛ nonzero input+output on
  qwen3.8-flash-next-uncensored and jev-latest — §5 governs the allowlist (screenshot free set),
  not the raw pricing fields.
- See §5 for the full free-only roster framing (287 catalogue ids EXCLUDED per standing rule).

### POST /v1/chat/completions (auth, OpenAI-compatible)

Ping: POST https://api.experientiallabs.ai/v1/chat/completions with Bearer $EXPERIENTIAL_KEY
and body model=qwen3.8-flash-next-uncensored, messages=[ping], max_tokens=5.

- Observed live 2026-10-12: HTTP 200, finish_reason length, usage prompt 53 / completion 5 /
  total 58 (reasoning 5), cost 1.03e-05, is_byok false, provider experiential_cloud.
- content was null on this ping (max_tokens hit) — length stop, not an error؛ completion tokens 5.
- Route-down on the other free aliases the same day (HTTP 503 api_error / unavailable_route):
  clef-flash, clef, gpt-6-luna-decisions, jev-latest — granted aliases whose route was
  unavailable at probe time؛ retry after a short delay, do not document as dead.

### Billing/quota endpoints — 404 sweep (auth, live 2026-10-12)

No account/billing endpoint exists. All of these return 404 invalid_request_error / not_found
(Unsupported serving path, see §6): /v1/me, /v1/account, /v1/user, /v1/billing, /v1/balance,
/v1/credit, /v1/credits, /v1/quota, /v1/subscription, /v1/usage, /v1/wallet.
Plan/quota/reset/expiry/name-email are NOT key-fetchable here — §8 is screenshot-sourced.

## 4. Unverified / not probed

- Streaming (stream:true SSE data: chunks) — NOT probed live. Do not document as working until live-tested.
- Any /v1/* endpoint beyond /models and /chat/completions (except the §3 404 sweep).
- Image / audio / tool / embedding endpoints — none discovered؛ API host root 404.

## 5. Models roster — free-only allowlist (probed live 2026-10-12, per user exclusion rule 2026-10-11)

GET /v1/models returns a 292-id catalogue — but the router offers free models ONLY (standing user rule
2026-10-11: EXCLUDE any model that deducts from balance / needs token payment). User screenshot
2026-10-12 confirms the free set = Promotional 5. Free-only must be fetched live (no per-key
allowlist endpoint exists here — the catalogue is the same on the probe key؛ the free set is
screenshot-pinned, not key-derived).

> WARNING — the router MUST offer only the 5-id free set below؛ never offer any model outside
> the 5 — the other 287 catalogue ids stay EXCLUDED (PAYG / balance-deducting per user rule
> 2026-10-11). A key calling an ungranted alias fails live with 403 model_not_granted (see §6).
> Granted-but-route-down aliases fail with 503 unavailable_route — retry, do not drop them from the
> free set. Never hardcode the 292 catalogue as offerable.

Router allowlist — 5 Promotional free models (screenshot 2026-10-12, live ids verified 2026-10-12):

```text
clef-flash
clef
gpt-6-luna-decisions
qwen3.8-flash-next-uncensored
jev-latest
```

Display-name mapping (screenshot → live id): Clef Flash (Free) → clef-flash؛ Clef (Free) → clef؛
GPT-6 Luna Decisions (Free) → gpt-6-luna-decisions؛ Qwen3.8 Flash Next Uncensored (Free) →
qwen3.8-flash-next-uncensored؛ Jev (Free) → jev-latest. Bare jev is ABSENT from the catalogue
(403 model_not_granted live) — always use jev-latest.

Chat-ping status 2026-10-12: qwen3.8-flash-next-uncensored OK (200, finish length)؛ clef-flash,
clef, gpt-6-luna-decisions, jev-latest granted but route-down (503 unavailable_route at probe
time — transient, retry).

EXCLUDED — the other 287 catalogue ids (PAYG / balance-deducting — fetched live 2026-10-12,
NEVER offer per user rule 2026-10-11):

```text
aion-2.0
aion-3.0
aion-3.0-mini
aion-rp-llama-3.1-8b
claude-fable-5
claude-fable-5.1
claude-fable-latest
claude-haiku-4.5
claude-haiku-5.5
claude-haiku-latest
claude-opus-4.5
claude-opus-4.6
claude-opus-4.7
claude-opus-4.8
claude-opus-5
claude-opus-5.5
claude-opus-latest
claude-sonnet-4
claude-sonnet-4.5
claude-sonnet-4.6
claude-sonnet-5
claude-sonnet-5.5
claude-sonnet-latest
codestral-2508
codestral-embed
command-a
command-r-08-2024
command-r-plus-08-2024
command-r7b-12-2024
cydonia-24b-v4.1
deepseek-r1
deepseek-r1-0528
deepseek-v3.2
deepseek-v3.2-exp
deepseek-v3.2-speciale
deepseek-v4-flash
deepseek-v4-flash-0731
deepseek-v4-flash-latest
deepseek-v4-pro
deepseek-v4-pro-0813
deepseek-v4.1-flash
dolphin-mistral-24b-venice-edition
ernie-4.5-vl-424b-a47b
fugu-max
fugu-ultra
fugu-ultra-v2
gemini-2.5-flash
gemini-2.5-flash-image
gemini-2.5-flash-lite
gemini-2.5-pro
gemini-2.5-pro-preview
gemini-3-flash-preview
gemini-3-pro-image
gemini-3.1-flash-image
gemini-3.1-flash-lite
gemini-3.1-flash-lite-image
gemini-3.1-pro-preview
gemini-3.1-pro-preview-customtools
gemini-3.5-flash
gemini-3.5-flash-lite
gemini-3.6-flash
gemini-3.7-flash
gemini-3.8-flash
gemini-flash-latest
gemini-pro-latest
gemma-2-27b-it
gemma-3-12b-it
gemma-3-27b-it
gemma-3-4b-it
gemma-4-26b-a4b-it
gemma-4-31b-it
glm-4.6v
glm-4.7
glm-5
glm-5-turbo
glm-5.1
glm-5.2
glm-5.2-fast
glm-5.3
glm-5.3-flash
glm-5.3-flash-abliterated
glm-5v-turbo
glm-latest
gpt-3.5-turbo
gpt-3.5-turbo-0613
gpt-3.5-turbo-16k
gpt-3.5-turbo-instruct
gpt-4-turbo
gpt-4.1
gpt-4.1-mini
gpt-4.1-nano
gpt-4o
gpt-4o-mini
gpt-5
gpt-5-mini
gpt-5-nano
gpt-5.1
gpt-5.1-codex
gpt-5.1-codex-max
gpt-5.1-codex-mini
gpt-5.2
gpt-5.2-codex
gpt-5.3-codex
gpt-5.4
gpt-5.4-image-2
gpt-5.4-mini
gpt-5.4-nano
gpt-5.5
gpt-5.5-pro
gpt-5.6-luna
gpt-5.6-luna-pro
gpt-5.6-sol
gpt-5.6-terra
gpt-6-astra
gpt-6-luna
gpt-6-sol
gpt-6.1-sol
gpt-chat-latest
gpt-latest
gpt-mini-latest
gpt-oss-120b
gpt-oss-20b
gpt-oss-safeguard-20b
granite-4.0-h-micro
grok-4
grok-4-1-fast-non-reasoning
grok-4-1-fast-reasoning
grok-4.20
grok-4.20-multi-agent
grok-4.20-non-reasoning
grok-4.3
grok-4.5
grok-4.6
grok-4.7
grok-build-0.1
grok-code-fast-1
grok-latest
hermes-3-llama-3.1-405b
hermes-3-llama-3.1-70b
hermes-4-405b
hunyuan-a13b-instruct
hy-mt2-1.8b
hy-mt2-30b-a3b
hy-mt2-7b
hy3
hy3-preview
hy4-preview
inkling
inkling-small
kimi-k2-0905
kimi-k2-thinking
kimi-k2.5
kimi-k2.6
kimi-k2.7-code
kimi-k3
kimi-latest
laguna-s-2.1
laguna-xs-2.1
ling-3.0-flash
ling-3.0-flash-fin
ling-3.0-flash-sante
ling-3.0-flash-vl
llama-3-lunaris-8b
llama-3.1-70b-instruct
llama-3.1-euryale-70b
llama-3.3-70b-instruct
llama-3.3-euryale-70b
llama-4-maverick
llama-4-scout
llama-guard-4-12b
longcat-2.0
magnum-v4-72b
mercury-2
mimo-v2.5
mimo-v2.5-pro
mimo-v2.6-flash
mimo-v2.6-pro
mimo-v2.6-pro-ultraspeed
minimax-01
minimax-m1
minimax-m2
minimax-m2-her
minimax-m2.1
minimax-m2.5
minimax-m3
ministral-14b-2512
ministral-3-3b-instruct
ministral-3-8b-instruct
mistral-embed
mistral-large
mistral-large-2407
mistral-large-3
mistral-large-4
mistral-medium-3
mistral-medium-3-5
mistral-medium-3.1
mistral-nemo
mistral-saba
mistral-small-2603
mistral-small-3.1-24b-instruct
mistral-small-3.2-24b-instruct
mixtral-8x22b-instruct
morph-v3-fast
morph-v3-large
muse-spark-1.1
muse-spark-1.2
muse-spark-1.2-contributor
muse-spark-1.3
muse-spark-1.3-contributor
nemotron-3-nano-30b-a3b
nemotron-3-super-120b-a12b
nemotron-3-ultra-550b-a55b
nemotron-3.5-lightning
nova-2-lite-v1
nova-premier-v1
o3
o3-mini
o3-mini-high
o4-mini
o4-mini-high
perceptron-mk1
phi-4
qwen-mt-plus
qwen-plus
qwen-plus-2025-07-28
qwen2.5-vl-72b-instruct
qwen3-14b
qwen3-235b-a22b-instruct-2507
qwen3-32b
qwen3-coder-480b-a35b-instruct
qwen3-coder-flash
qwen3-coder-plus
qwen3-max
qwen3-max-thinking
qwen3-next-80b-a3b-instruct
qwen3-next-80b-a3b-thinking
qwen3-omni-30b-a3b-thinking
qwen3-vl-235b-a22b-instruct
qwen3-vl-8b-thinking
qwen3.5-122b-a10b
qwen3.5-27b
qwen3.5-35b-a3b
qwen3.5-397b-a17b
qwen3.5-9b
qwen3.5-flash-02-23
qwen3.5-plus-02-15
qwen3.5-plus-20260420
qwen3.6-27b
qwen3.6-35b-a3b
qwen3.6-flash
qwen3.6-max-preview
qwen3.6-plus
qwen3.7-flash
qwen3.7-max
qwen3.7-plus
qwen3.8-2.4t-a95b
qwen3.8-27b
qwen3.8-flash
qwen3.8-max
qwen3.8-max-0902
reka-edge
reka-flash-3
relace-apply-3
relace-search
remm-slerp-l2-13b
seed-1.6
seed-1.6-flash
seed-2-1-turbo
seed-2.0-code
seed-2.0-lite
seed-2.0-mini
skyfall-36b-v2
solar-pro-3
solar-pro4
sonar
sonar-pro
sonar-pro-search
sonar-reasoning-pro
step-3.5-flash
text-embedding-3-large
text-embedding-3-small
text-embedding-ada-002
trinity-large-thinking
ui-tars-1.5-7b
unslopnemo-12b
weaver
wizardlm-2-8x22b
```

## 6. Rate limits + errors

- Rate limits: none captured live (single-key probes, no headers recorded)؛ no documented RPM — provider id shows RPM n/a in app.
- 401 no key (live 2026-10-12): error type=authentication_error, code=invalid_key,
  message=A valid gateway Bearer key is required. Send the virtual key as Authorization: Bearer <key>.
- 401 bad key (live 2026-10-12): error type=authentication_error, code=invalid_key,
  message=The gateway key is invalid, expired, or revoked. Ask the gateway operator to issue a new virtual key.
- 403 ungranted alias (live 2026-10-12: bare jev + unknown model no-such-model-xyz — same shape):
  HTTP 403, error type=permission_error, param=model, code=model_not_granted,
  message=The requested model alias is not granted to this identity. GET /v1/models lists the model aliases available to this key.
- 503 route-down (live 2026-10-12: clef-flash, clef, gpt-6-luna-decisions, jev-latest chat pings):
  error type=api_error, code=unavailable_route,
  message=The authorized model route is unavailable. Retry after a short delay; if this persists, ask the gateway operator to check the alias deployments.
- 404 bad serving path (live 2026-10-12: whole §3 sweep incl /v1/me, /v1/usage, /v1/billing):
  HTTP 404, error type=invalid_request_error, code=not_found, message=Unsupported serving path: /v1/usage (path varies).
- 404 host root (live 2026-10-12: GET https://api.experientiallabs.ai/ no auth):
  HTTP 404, body detail=Not Found (FastAPI default — NOT the gateway envelope).

## 7. Router integration recipe (per COOKBOOK.md §1)

1. New src/renderer/providers/experiential.js (registers itself, nothing imports it): id=experiential,
   name=Experiential, baseUrl=https://api.experientiallabs.ai/v1, color=#ededed (in-repo experiential.svg
   artwork is a light mark fill on the dark sidebar — no brand color shipped),
   logo=../assets/providers/experiential.svg, modelsEndpoint=/models, chatEndpoint=/chat/completions.
2. Logo: src/assets/providers/experiential.svg (already in repo — verified).
3. src/renderer/index.html: script providers/experiential.js BEFORE app.js.
4. Fixture + count: extend scripts/live/fixture.mjs and bump READY in scripts/live/verify-db.mjs.
5. README.md: add the Experiential row to the providers table.
6. npm run repo:map (new file surfaces in CODE_MAP.md).

Accept: npm test then npm run verify:live.

## 8. Account & Quota (Raw → normalized, probed live 2026-10-12 + screenshot 2026-10-12)

| Router field | Raw source | Value observed / mapping |
|---|---|---|
| PLAN | - (no account endpoint; screenshot 2026-10-12) | Promotional free tier (screenshot-sourced) |
| QUOTA | - (no quota endpoint; chat usage.cost observed live) | live ping usage cost 1.03e-05 on qwen3.8-flash-next-uncensored (screenshot: Free — screenshot-sourced) |
| RESET TIME | - (no reset field exposed) | NOT EXPOSED via API key |
| EXPIRY | - (no expiry field exposed) | NOT EXPOSED via API key |
| NAME / EMAIL | - (no account endpoint) | NOT EXPOSED via API key |
