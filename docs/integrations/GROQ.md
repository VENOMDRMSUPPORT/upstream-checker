# Groq — Provider Reference

Integrated provider module: `src/renderer/providers/groq.js`
(standard contract, no custom code). Evidence: Groq's published rate-limits and models
documentation, read 2026-11-11. Site: `https://console.groq.com`.

## 0. Summary

| Field | Value |
|---|---|
| Provider name | Groq |
| API base | `https://api.groq.com/openai/v1` |
| Icon | `src/assets/providers/groq.svg` — brand-colour monogram |
| Provider type | API KEY (Bearer, keys start `gsk_`) |
| Contract | Standard: `GET /models`, `POST /chat/completions` |
| Free tier | Yes — Free Plan, no credit card |

## 1. Free-tier facts (verified 2026-11-11)

- Limits are per model and apply at the **organization** level: every key in
  the same account shares one pool, so a second key adds no headroom.
- Small models (llama-3.1-8b-instant, openai/gpt-oss-20b): 30 req/min,
  14,400 req/day, 6,000 tokens/min, 500,000 tokens/day.
- Large models (llama-3.3-70b-versatile, openai/gpt-oss-120b, qwen/qwen3-32b):
  30 req/min, 1,000 req/day, 8,000 tokens/min, 200,000 tokens/day.
- Daily counters reset at midnight UTC. The account's own limits page is
  authoritative; the figures above are the published Free Plan table.

## 2. Quirks

- A few OpenAI parameters are rejected with 400: `logprobs`, `logit_bias`,
  `top_logprobs`, `messages[].name`; `n` must be 1 when set.
- Responses carry `x-ratelimit-*` headers — the requests figures there are
  per **day**, the token figures per **minute**.
- The roster turns over quarterly; discovery reads it live, nothing is
  hard-coded here.
