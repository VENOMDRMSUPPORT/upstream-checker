# Cerebras — Provider Reference

Catalog provider (data entry in `src/renderer/providers/catalog-providers.js`,
no hand-written module). Evidence: Cerebras inference documentation
(rate limits / free-trial FAQ), read 2026-11-11. Site:
`https://cloud.cerebras.ai`.

## 0. Summary

| Field | Value |
|---|---|
| Provider name | Cerebras |
| API base | `https://api.cerebras.ai/v1` |
| Icon | `src/assets/providers/cerebras.svg` — brand-colour monogram |
| Provider type | API KEY (Bearer, keys start `csk_`) |
| Contract | Standard: `GET /models`, `POST /chat/completions` |
| Free tier | **No** — a one-time trial, see §1 |

## 1. The trial is not a free tier (verified 2026-11-11)

Cerebras's own documentation states it does not currently offer a no-cost
tier that renews automatically. What a new account gets:

- A one-time **$5 credit**, unlocked only after adding a verified payment
  method, expiring **30 days** after it is granted. When the credit is spent
  or expires, API access stops until more credit is bought.
- Trial limits: 5 req/min, 30,000 uncached tokens/min (90,000 total incl.
  cached), 1,000,000 tokens/hour and per day.
- Trial context is smaller than paid (about 65K tokens vs about 128K).

That is why the catalog entry carries `freeTier: false`: tagging trial
models FREE would tell the router they cost nothing forever. The provider is
still worth having — its wafer-scale inference is among the fastest
available — but as a paid provider with a trial, labelled honestly.

## 2. Quirks

- Input tokens plus `max_completion_tokens` reserve quota before the call
  runs; oversized output caps can fail a request that would otherwise fit.
- The public catalog is small (gpt-oss-120b, gemma-4-31b at verification
  time); discovery reads it live.
