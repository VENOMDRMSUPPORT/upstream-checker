# VENOM Router Integration Guide

Merges the Gemini-reviewed router plane into this checkout
(`G:\Venom-Projects\venom-router`). All paths below are relative to the repo
root. The desktop boot behavior is unchanged: the gateway is best-effort and a
busy port or an empty roster only logs a warning.

## 1. What was added

| File | Purpose |
| --- | --- |
| `src/router/index.js` | Smart catalog split (venom-lite/pro/max), three-level key pool, cascade engine, local HTTP gateway on `127.0.0.1:28228`, score persistence helpers. No `require('electron')`, so tests load it under plain Node. |
| `src/db/migrations.js` (version 6) | `provider_keys.tier` (`subscription`/`free`/`cheap`/`paid`, default `paid`), `provider_keys.quota_pool_id`, plus `catalog_scores`, `router_cooldowns`, `router_sessions`. Append-only; older rows read as the paid tier. |
| `src/db/repos/providers.js` | Surfaces `tier`/`quotaPoolId` on every key, persists them when the v6 columns exist (falls back to the v5 shape on old test files), adds `listAllActiveKeys()` and `setKeyTier()` for the router. |
| `src/main.js` | Builds the key pool + smart catalog after `keyResolver`, binds the gateway lazily (first roster data or first `router:status`/`refresh` query — never at boot, so opening a window listens to nothing), refreshes on every roster write, stops the gateway on `will-quit`. |
| `src/preload.js` | Exposes `routerStatus()` / `routerRefresh()` for a future Models-page tab. No UI reads secrets through them. |
| `test/router/router.test.js` | 10 tests: identity split, waterfall order, model-on-key isolation, cascade escalation, compression, tool-call rescue, gateway shapes, score persistence. |
| `test/db/open.test.js`, `providers.test.js`, `ipc.test.js` | Updated to schema v6 (sequence fixtures moved to v7). |

## 2. Design decisions kept from the review

- **Upstream id vs match key.** `upstreamModelId(provider, model)` is the
  dispatch address used for `model_keys` and API calls;
  `canonicalSlug(provider, model)` is only the scoring/benchmark lookup key.
  Collapsing listings for display never breaks key binding.
- **No guessed scores.** Rows the reference cannot score stay `null` on the
  Models page (existing tests pin this). The router ranks such rows last
  internally via `evaluateModelCapabilities` flagged `router-heuristic` — the
  flag never lands in `catalog_scores`.
- **Three-level isolation.** A 429 on `claude-opus` cools only
  `model:claude-opus` on that key; a 402/401 cools the key; repeated 5xx trips
  the provider circuit breaker. Siblings keep serving.
- **Waterfall.** `subscription` drains first (prepaid expiry), then `free`,
  then `cheap`, then `paid`; paid keys spread by power-of-two-choices over the
  least-failed key. Keys sharing a `quota_pool_id` count once.
- **Persisted scores.** `persistCatalogScores` writes only measured/estimated
  rows after each build, so the next boot has values in 0ms before any sync.

## 3. Using the three models

Point any OpenAI-compatible client at the local gateway:

```text
base URL: http://127.0.0.1:28228/v1
models:   venom-lite | venom-pro | venom-max
```

The port is configurable: Settings › Models Catalog › Local gateway port
(`routerGatewayPort`, 1024–65535, default 28228, applies after restart).
Move it when a sibling router on this machine (9Router, OmniRoute) already
owns the default — the Venom Router page and `router:status` always report the
bound port. A busy port stays a warning; the desktop is unaffected.

- `GET /v1/models` lists the three virtual models plus the top roster rows.
- `POST /v1/chat/completions` (OpenAI shape) and `POST /v1/messages`
  (Anthropic shape) accept `model: venom-lite|venom-pro|venom-max`.
  Anything else falls back to `venom-pro`.
- Pass `"stream": true` for Server-Sent Events: OpenAI chunks plus
  `data: [DONE]`, or Anthropic `message_start` … `message_stop`. Framing is
  done at the gateway (upstream is still fetched whole through api-request),
  so clients get valid frames with an early first chunk.
- Replies carry `X-Venom-Routed-Via: <provider>/<model>` and
  `X-Venom-Cascade-Reason: direct|escalated`.
- `venom-lite`: cheapest fast pool, `reasoningEffort: low`, tool-call rescue on.
- `venom-pro`: starts on the efficient pool, watches `role: "tool"` results
  and escalates the pinned session to the capable pool with a
  `VENOM CASCADE HANDOFF` note on the first tool error.
- `venom-max`: fans out to up to 3 frontier rows on diverse providers and
  synthesizes the drafts analyst-style.

External tools (Claude Code, Cursor, Cline) use the gateway URL with any
placeholder key — upstream secrets stay in `venom.db` and travel only through
the existing `venomkey:<id>` resolver.

## 4. Operating the key tiers

```js
store.repos.providers.setKeyTier('key_1', 'subscription');
store.repos.providers.setKeyTier('key_2', 'free', 'shared-org-quota');
```

Tiers survive `save-provider` round-trips. A key left at the default `paid`
behaves exactly like a v5 install.

## 5. Verification

```text
npm run repo:map -- --check
npm test -- test/router/router.test.js
npm run check
```

`npm run verify:live` still drives the app against a mock provider on scratch
data — it has never seen a real key or a real 429, so cite it as the app-path
proof only, not as routing proof.

## 6. In-app status page

The `Venom Profiles` nav item (Routing group) renders policy cards, per-profile
dossiers and eligible target lists from `router:profiles` (falling back to
`router:status` counts), with measured outcomes from routed log rows and a
Refresh button wired to `router:refresh`. Covered by
`test/renderer/router-status.test.js` and a geometry check in
`scripts/live/verify-renderer-modules.mjs`.
