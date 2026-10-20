# The local gateway

VENOM Router can expose its own accounts as one local OpenAI- or
Anthropic-compatible endpoint. Point any client at `127.0.0.1` and it talks to
whichever key and model the router picks, instead of to one provider you had to
choose by hand.

Everything in this document is implemented in `src/router/index.js` and wired in
`src/main.js`. The renderer never sees a secret: the router sends
`venomkey:<keyId>` placeholders through the same resolver every other request
uses, and the secret is swapped for the real value inside main only.

## 1. Turning it on

There is no switch. The gateway exists as soon as the app has roster data, and
it binds its socket **lazily** — on the first roster rows, or on the first
`router:status` / `router:refresh` query. Opening a window never makes the app
listen on a port by itself.

| Where | What |
| --- | --- |
| Settings › Models Catalog › **Local gateway port** | `routerGatewayPort`, 1024–65535, default `28228`. The change applies after a restart. |
| **Venom Profiles** page (Routing group in the nav) | Live status: bound port, active/total keys, cooldowns, per-profile targets, and a **Refresh** action. |
| `router:status`, `router:refresh`, `router:profiles` | The IPC channels the page reads. All three resolve; none carries a secret. |

If the port is busy — another router on this machine already owns it — the
gateway logs a warning and the desktop carries on unaffected. Move the port
rather than expecting the app to fail.

## 2. The three profiles

The router splits the scored roster into three pools and drains them in a fixed
order.

| Profile | What it serves | Pool rule |
| --- | --- | --- |
| `venom-lite` | Cheap and fast. Free and near-free rows (or rows served by a free/subscription key), cheapest first, then highest score. | Reasoning effort `low`. |
| `venom-pro` | The default. Tool-capable rows above the score floor, split into an *efficient* rung (starts fast) and a *capable* rung (the escalation target). | Reasoning effort `medium`, rising to `high` after escalation. |
| `venom-max` | Frontier only: rows with a documented score, at most three, preferring different providers. | Fanned out in parallel and merged by a lead-analyst pass. Reasoning effort `high`. |

A row that cannot answer in text — a published image/audio/video modality, or a
declared generator kind — is never a routing candidate. A row the reference
cannot score still enters the pools, but with an explicit heuristic estimate
(`est-heuristic`) so it ranks last instead of silently disappearing.

## 3. The endpoint contract

```text
base URL: http://127.0.0.1:28228/v1
models:   venom-lite | venom-pro | venom-max
```

| Route | Behaviour |
| --- | --- |
| `GET /v1/models` | The three virtual models plus the top roster rows, deduplicated by provider/model. |
| `POST /v1/chat/completions` | OpenAI shape. `model` must be one of the three profiles; anything else falls back to `venom-pro`. |
| `POST /v1/messages` | Anthropic shape, same routing. |

- **Streaming.** `"stream": true` returns Server-Sent Events: OpenAI chunks
  ending in `data: [DONE]`, or Anthropic `message_start` … `message_stop`.
  With the live dispatcher wired, the provider's bytes are piped through after
  its own `200 OK`; failover to the next route is only possible before the
  first chunk, because the connection is pinned afterwards.
- **Headers.** Every reply carries `X-Venom-Routed-Via: <provider>/<model>` and
  `X-Venom-Cascade-Reason: direct|escalated`.
- **Tool calls.** A reply that emitted a tool call as prose instead of
  `tool_calls` is rescued into the OpenAI tool-call shape before it is sent.
- **Tool output.** Long `role: "tool"` messages are trimmed losslessly before
  dispatch, so a huge tool result does not eat the model's context.
- **Errors.** No live route answers `503`; an upstream failure answers `502`.

External tools (Claude Code, Cursor, Cline) can use the gateway URL with any
placeholder key — the real keys stay in `venom.db` and are only resolved by
main.

## 4. Key tiers and failure isolation

Each key carries a tier (`provider_keys.tier`): `subscription`, `free`, `cheap`
or `paid`, defaulting to `paid` so an older row behaves exactly as before.
Within the drain order, keys are picked by power-of-two-choices over the
least-recently-failed ones.

Keys that share one quota bucket can be marked with the same
`quota_pool_id`, so a shared bucket is never mistaken for spare capacity.

Failures are isolated on three levels, so one bad route never takes the others
down:

| Level | Tripped by | Effect |
| --- | --- | --- |
| model-on-key | a 429 on one model | only that model on that key is paused |
| key | a 402 or 401 | that key is paused, and its quota pool gets a short pause |
| provider | three consecutive server errors | the provider is paused |

A `Retry-After` from the provider sets the pause length; without one the
router falls back to its own defaults.

## 5. The Venom Profiles page

The **Venom Profiles** page (Routing group) reads `router:profiles` and shows
the policy cards, the per-profile dossiers, the fleet totals and the eligible
target lists. Profile badges (LITE / PRO / MAX) carry the same identity into
the Models Catalog rows, the Model Activity feed and the Monitoring log rows.

Measured outcomes on that page come from the request log, filtered to routed
requests only (`source = 'venom-router'` — the tag the gateway sends on every
routed request, and the one the recorder's source whitelist accepts). A profile
with fewer than five logged routed requests reports "insufficient evidence"
instead of a rate.

## 6. What the gateway does not do

- It does not invent a score. Rows the reference cannot score stay unscored on
  the Models page; the router's heuristic estimate is internal and is never
  written to `catalog_scores`.
- It does not merge listings into the dispatch address. `providerId::modelId`
  is the upstream id; the canonical slug is only a scoring lookup key.
- It does not expose a key value to the renderer, to a client, or to a log row.
- It does not start a server process outside the app. The socket lives and dies
  with the app.

## 7. Verification

```text
npm run repo:map -- --check        # the map matches the tree
npm test -- test/router/router.test.js
npm run check                      # map freshness + the full suite
```

`npm run verify:live` still drives the app against a **mock** provider on
scratch data. It has never seen a real key, a real 429 or a real stream, so
cite it as proof of the app path, never as proof of routing.