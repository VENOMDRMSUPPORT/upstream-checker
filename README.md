# Upstream Checker

Desktop tool for testing AI model providers. Connect your API keys, discover
every model each key can reach, test them for real, benchmark them, and track
how they hold up over time.

Built with Electron for Windows. Current version: **1.4.1** (see
[CHANGELOG.md](CHANGELOG.md)).

## Features

- **Model testing** — sends a real prompt to each selected model and checks the
  answer. Chat, image and video models are each judged by the right standard.
  Hedged requests (the fastest correct answer wins), retries for transient
  failures, and per-kind time limits.
- **Multi-key discovery** — every active key is asked for its models, and each
  test goes out on a key that actually serves that model.
- **Rate limits and quotas** — per-key RPM pacing with round-robin, honours
  `Retry-After`, learns limits from 429s, and remembers per-model spent quotas
  until they reset.
- **Key usage** — quota left, expiry, last-24h stats and request history per key
  (Mirai API, Token Harbor).
- **Provider health** — optional background probe of every provider's keys.
- **Run history** — uptime per model, sparklines, regression detection with
  desktop notifications, and scheduled runs.
- **Benchmark** — 21 machine-checked tasks (reasoning & math, coding,
  instruction following, in three difficulty tiers) plus latency and
  throughput probes. Under a minute per model.
- **Model catalog** — live inventory across all connected providers, with
  benchmark scores compared against the Artificial Analysis leaderboard.
- **Venom profiles** — `venom-lite`, `venom-pro` and `venom-max`: virtual models
  that rank and weight real models from measured data on your own providers.
- **Export** — results as CSV or JSON, history as JSON.
- **Appearance** — dark and light themes, following the OS or set by hand, with
  preset or custom accent colours.
- **Auto-updates** — from GitHub Releases, installed silently.

## Integrated providers

All are OpenAI-compatible (`GET /models`, `POST /chat/completions`).

| Provider          | Base URL                               |
| ----------------- | -------------------------------------- |
| NARA Router       | `https://router.bynara.id/v1`          |
| Dark API          | `https://darkapi.dev/v1`               |
| Nexum Router      | `https://dialagram.me/router/v1`       |
| Mirai API         | `https://api.miraiapi.com/v1`          |
| Inception Labs    | `https://api.inceptionlabs.ai/v1`      |
| Token Harbor      | `https://tokenharbor.ai/v1`            |
| Experiential Labs | `https://api.experientiallabs.ai/v1`   |

## Pages

| Page      | What it does                                                        |
| --------- | ------------------------------------------------------------------- |
| Overview  | Summary of recent runs, uptime and regressions                      |
| Providers | **Connected**: your keys and their health/usage. **Integrated**: available providers to connect |
| Catalog   | Every model across providers, with benchmark results                |
| Check     | Pick models and run tests; results table with export                |
| Profiles  | The Venom profiles and the model roster behind each                 |
| Settings  | Appearance, Test, Schedule, Speed, Reliability, Model Catalog, History, Diagnostics, Data, About |

## Project structure

```
src/
  main.js              Main process: window, HTTP requests, config/history/catalog files,
                       request log, auto-updater
  preload.js           window.electronAPI bridge
  keystore.js          Encrypts API keys at rest (OS keystore / DPAPI)
  renderer/
    index.html         App shell and all pages
    app.js             Core logic: providers, keys, discovery, testing, history, UI
    benchmark.js       Benchmark suite
    catalog.js         Model catalog and leaderboard
    profiles.js        Venom profiles engine
    key-usage.js       Key usage row + drawer (provider-agnostic)
    ui-select.js       Custom <select> menu
    providers/*.js     One module per integrated provider
    data/              Leaderboard snapshot
    styles.css, fonts/
  assets/              Icons and provider logos
scripts/
  release.mjs          Tag, publish notes, build and upload a release
  generate-icons.js    Builds the icon set from one source image
  keystore-check.js    Verifies key encryption works on this machine
docs/superpowers/      Design specs and implementation plans
```

## Adding a provider

Create `src/renderer/providers/<id>.js` that registers into
`window.INTEGRATED_PROVIDERS` with a `meta` object (`id`, `name`, `baseUrl`,
`color`, `logo`, `modelsEndpoint`, `chatEndpoint`, optional `rateLimits`), and
load it in `index.html` before `app.js`. Optional hooks:

- `fetchModels` — custom discovery
- `classify(model)` — returns `chat`, `image` or `video`
- `fetchKeyUsage`, `fetchKeyHistory` — key usage drawer
- `readQuotaError`, `readUsageHeaders` — quota detection

## Data and security

Stored in the app's user-data folder (Settings › Data opens it):

- `config.json` — providers, keys and settings. API keys are encrypted with the
  OS keystore (`enc:v1:` prefix) and only decrypt for the same Windows user on
  the same machine.
- `history.json` — run history.
- `catalog.json` — model catalog and benchmark results.
- Request log — optional, with auth headers redacted.

## Development

Requires Node.js.

```bash
npm install            # install dependencies
npm start              # run in development
npm run build          # NSIS installer + portable (dist/)
npm run build:portable # portable only
npm run check:keystore # check key encryption
```

## Releasing

1. Bump `version` in `package.json` and add the entry to `CHANGELOG.md`.
2. Commit.
3. `npm run release`

The script creates the git tag, publishes the GitHub release with its notes,
then builds and uploads the installers. The GitHub token comes from `GH_TOKEN` /
`GITHUB_TOKEN` or `gh auth token`.

## Auto-updates

The app checks GitHub Releases (`VENOMDRMSUPPORT/upstream-checker`) on startup
and every 2 hours. Updates download on request and install silently on restart
or on the next close.

## License

Proprietary
