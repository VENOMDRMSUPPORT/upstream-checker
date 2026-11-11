# Pollinations — Provider Reference

Integrated provider module: `src/renderer/providers/pollinations.js`
(standard contract, no custom code). Evidence: Pollinations' published API material,
read 2026-11-11, plus live keyless probes the same day: `GET
https://gen.pollinations.ai/v1/models` answered 200 in OpenAI shape, and the
legacy `https://text.pollinations.ai/models` listed a single anonymous-tier
model. Site: `https://pollinations.ai`.

## 0. Summary

| Field | Value |
|---|---|
| Provider name | Pollinations |
| API base | `https://gen.pollinations.ai/v1` |
| Icon | `src/assets/providers/pollinations.svg` — brand-colour monogram |
| Provider type | API KEY (Bearer, keys start `sk_`) |
| Contract | Standard: `GET /models`, `POST /chat/completions` |
| Free tier | Quest Pollen starter credit — no credit card |

## 1. What changed (verified 2026-11-11)

Pollinations used to be the keyless provider: open URLs on
`text.pollinations.ai`, no signup. That model has been replaced. The current
API lives on `gen.pollinations.ai`, is keyed, and prices every model in
**Pollen** (1 Pollen = $1). The free value now is **Quest Pollen**: small
one-off rewards (about 3 Pollen in total) for creating a first key and trying
each model type. After that, Pollen is bought or earned.

The legacy keyless lane still answers but lists one anonymous-tier model
(`openai-fast`, GPT-OSS 20B) and can return 402 — legacy and shrinking. This
entry therefore uses the keyed API. If a genuinely keyless provider class is
ever needed (a provider with no key record at all), it is its own design
step; nothing in Wave 1 depends on it.

## 2. Quirks

- The public catalog is large and mixes commercial, open and community
  models; per-model Pollen prices ride along in the catalog payload — a
  candidate price source for the catalog later, like OpenRouter's.
- Keys support per-key budgets and model permissions on the provider side;
  the app treats the key as a normal Bearer key.
