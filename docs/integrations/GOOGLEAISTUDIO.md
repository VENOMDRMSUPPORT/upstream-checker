# Google AI Studio — Provider Reference

Catalog provider (data entry in `src/renderer/providers/catalog-providers.js`,
no hand-written module). Evidence: Google's Gemini API documentation
(OpenAI compatibility, pricing, rate limits) and the Gemini API terms, read
2026-11-11. Keys: `https://aistudio.google.com` (Get API key).

## 0. Summary

| Field | Value |
|---|---|
| Provider name | Google AI Studio |
| API base | `https://generativelanguage.googleapis.com/v1beta/openai` |
| Icon | `src/assets/providers/googleaistudio.svg` — brand-colour monogram |
| Provider type | API KEY (Bearer — the Gemini API key) |
| Contract | Standard: `GET /models`, `POST /chat/completions` via Google's OpenAI-compatible layer |
| Free tier | Yes — no credit card |

## 1. What this entry is (and is not)

This is the **Gemini API key** from AI Studio, spoken to through Google's
OpenAI-compatibility layer (Google labels that layer beta). It is not the
Google AI Pro subscription and it is not Antigravity: subscription quota
windows (the 5-hour and weekly allowances) belong to the Antigravity /
Google-account plane, not to this key. The same key also works on the native
Gemini API; this app uses the compatible layer so the standard contract
applies with no wire.

## 2. Free-tier facts (verified 2026-11-11)

- Limits are per **project** and per model — extra keys in the same project
  add nothing. Google no longer publishes a central table; the authoritative
  numbers are in the AI Studio rate-limit console for the project.
- Community-tracked Flash figures (October 2026): about 10–15 req/min and
  about 1,500 req/day. Daily quota resets at midnight Pacific.
- First-connect check: confirm the ids the compatible layer returns from
  `GET /models` are bare model names (e.g. `gemini-2.5-flash`); the native
  API prefixes ids with `models/`.

## 3. Privacy note (must stay visible)

Under the Gemini API terms, on the **unpaid** tier Google may use submitted
content to improve its products; the paid tier is exempt. The catalog entry's
rate-limit lines repeat this in the provider drawer so the trade-off is seen
before real work is routed through a free key.
