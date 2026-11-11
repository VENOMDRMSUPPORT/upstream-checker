# OpenRouter — Provider Reference

Catalog provider (data entry in `src/renderer/providers/catalog-providers.js`,
no hand-written module). Evidence: OpenRouter's limits documentation, read
2026-11-11, plus a live keyless probe of `GET /api/v1/models` the same day
(200, `:free` variants present). Site: `https://openrouter.ai`.

## 0. Summary

| Field | Value |
|---|---|
| Provider name | OpenRouter |
| API base | `https://openrouter.ai/api/v1` |
| Icon | `src/assets/providers/openrouter.svg` — brand-colour monogram |
| Provider type | API KEY (Bearer) |
| Contract | Standard: `GET /models`, `POST /chat/completions` |
| Free tier | Yes — the `:free` model variants, no credit card |

## 1. Free-tier facts (verified 2026-11-11)

- A model id ending in `:free` costs $0 per token. Caps are **per account**:
  20 req/min and 50 req/day, rising to 1,000 req/day once the account has
  bought at least $10 of credits in its lifetime (a one-time threshold).
- Extra API keys do not raise the cap, failed attempts count against it, and
  a negative credit balance blocks even `:free` requests (402).
- Upstream providers can still 429 a `:free` model inside quota — the free
  variant runs on the subsidising provider's spare capacity.
- `GET /api/v1/key` reports the key's own free-model daily counter
  (`free_model_daily_requests`); a future `fetchKeyUsage` hook can surface it.

## 2. Quirks

- `/models` returns the whole marketplace (hundreds of ids, paid and free).
  The payload carries per-model pricing — a candidate source for catalog
  price enrichment later; discovery today records the ids like any provider.
- Attribution headers (`HTTP-Referer`, `X-Title`) are optional and only
  affect OpenRouter's public rankings; the app does not send them.
