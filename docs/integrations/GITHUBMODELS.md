# GitHub Models — Provider Reference

Integrated provider module: `src/renderer/providers/githubmodels.js`
(standard contract, no custom code). Evidence: GitHub's GitHub Models documentation
(rate limits, REST endpoints), read 2026-11-11. Site:
`https://github.com/marketplace/models`.

## 0. Summary

| Field | Value |
|---|---|
| Provider name | GitHub Models |
| API base | `https://models.github.ai/inference` |
| Icon | `src/assets/providers/githubmodels.svg` — brand-colour monogram |
| Provider type | API KEY (Bearer — a GitHub personal access token) |
| Contract | Standard: `GET /models`, `POST /chat/completions` |
| Free tier | Yes — the prototyping tier, no credit card |

## 1. Free-tier facts (verified 2026-11-11)

- Limits are per GitHub account **and** per model, set by the model's tier:
  Low 15 req/min and 150 req/day; High 10 req/min and 50 req/day; per-request
  caps of 8,000 input and 4,000 output tokens. Copilot plan can raise them.
- Model ids are `publisher/model` (e.g. `openai/gpt-4o`); discovery reads
  them live from the token's catalog.
- GitHub's terms restrict the free tier to prototyping and experimentation;
  production use moves to paid access or BYOK.

## 2. Open questions (recorded, not hidden)

- One secondary source claims the service was retired on 2026-07-30. That is
  **not corroborated**: GitHub's documentation still describes the tier, and
  November 2026 sources describe it operating. The catalog endpoint could
  not be verified from the build machine (its network proxy answered a stub
  instead of the catalog JSON).
- First-connect check with a real token settles it: if discovery returns the
  catalog, the entry is live; if the endpoint is gone, removing a catalog
  entry is a one-line data change by design.
- Token note: fine-grained personal access tokens need model access granted;
  a classic token works as issued.
