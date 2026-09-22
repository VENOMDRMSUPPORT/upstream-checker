# NARA Provider Module + Reliability + Speed — Design

Date: 2026-09-22
Status: Approved

## Goals

1. Extract the NARA (integrated) provider into its own file so each integrated
   provider is a self-contained module; custom providers keep the generic path.
2. Raise the model test success rate by retrying transient failures.
3. Speed up testing by running models concurrently instead of sequentially.

## Constraints from NaraRouter docs

- OpenAI-compatible endpoint: `POST /v1/chat/completions` (what the tester uses).
- PAYG limits: **30 requests/minute, 10 concurrent**. A concurrency pool of 5 is
  safely under the concurrent cap; 429s (RPM) are handled by retry + `Retry-After`.
- No per-model health endpoint exists, so dead models cannot be pre-filtered;
  retry recovers the transient 502s.

## Approach

### A. Integrated-provider module (adapter pattern)

No bundler; the renderer loads classic `<script>` tags. `src/renderer/providers/nara.js`
loads BEFORE `app.js` and registers itself:

```js
window.INTEGRATED_PROVIDERS = window.INTEGRATED_PROVIDERS || {};
window.INTEGRATED_PROVIDERS.nara = {
  meta: { id, name, baseUrl, plansUrl, color, modelsEndpoint, plansEndpoint, chatEndpoint },
  async fetchModels({ apiKey, baseUrl, plansUrl, apiRequest, formatContext, getFreeGroupName }) { /* plans-aware free/freemium */ },
};
```

- `meta` is plain serializable data (no functions) because `makeRuntimeProvider`
  uses `structuredClone`, which cannot clone functions. The `fetchModels` adapter
  lives only in the registry, looked up by id at fetch time.
- `app.js` builds `BUILTIN_PROVIDERS` from `window.INTEGRATED_PROVIDERS[*].meta`.
- The model-fetch handler delegates to `adapter.fetchModels(...)` when the active
  provider has one; otherwise it uses the existing generic all-models path (custom
  OpenAI-compatible providers).
- `p.planModels` (currently written but never read) is dropped.

### B. Reliability — retry with backoff

`testModel` retries up to **2** times (3 attempts total) on transient failures:
- Retryable HTTP: `429, 502, 503, 504`.
- Retryable transport: network error / timeout (the `apiRequest` promise rejects).
- Non-retryable: any other non-200 (400/401/404/…) — returned immediately.
- Backoff: `600ms * 2^attempt` (~600, ~1200) plus up to 300ms jitter.
- `429`: honor the `Retry-After` response header (seconds) when present, capped at
  10s; otherwise use the backoff above.
- Abort (`abortTesting`) short-circuits between attempts.
- The returned result reports the final attempt's `elapsed` as `time`.

### C. Speed — concurrency pool

The Test-All handler pre-creates all result rows in selection order (stable
table), then runs a **pool of 5 workers** pulling from a shared cursor. Each
worker tests one model, pushes its result, updates its row, and advances a
`completed` counter that drives the progress bar. `abortTesting` stops workers
from picking up new models. Concurrency = `min(5, selected.length)`.

### D. Settings

Fixed smart defaults in code (no new UI): `TEST_CONCURRENCY = 5`,
`MAX_TEST_RETRIES = 2`, backoff base 600ms, per-request timeout stays 60s
(in `main.js`, unchanged).

## Files

- New: `src/renderer/providers/nara.js` — nara meta + `fetchModels` adapter.
- Modify: `src/renderer/app.js` — build `BUILTIN_PROVIDERS` from registry; delegate
  fetch to adapter; add `sleep`/`retryDelay` + retry in `testModel`; rewrite
  Test-All loop as a concurrency pool.
- Modify: `src/renderer/index.html` — add `<script src="providers/nara.js">` before `app.js`.

## Testing

No automated framework. Verify with `node --check` on both JS files, an Electron
launch without a renderer crash, and manual runs: nara still fetches free/freemium
models; Test-All runs ~5-at-a-time (visibly faster); transient 502s now recover on
retry (fewer failures); Stop still halts; custom providers still fetch all models.

## Out of scope

- Prompt caching, Anthropic `/v1/messages`, image endpoints.
- Per-model health pre-filtering (no endpoint), UI-configurable settings.
