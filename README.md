# VENOM Router

Windows desktop LLM router for connecting providers and API keys, discovering the
models each key can serve, testing them through one protected request path, and
reviewing health, history and request telemetry.

Built with Electron 33 and `better-sqlite3`. Current version: **2.1.2** (see
[CHANGELOG.md](CHANGELOG.md)). Formerly Upstream Checker — existing packaged
installs migrate their data folder in place.

## Features

- **Provider and key management** — connect nine integrated provider adapters,
  keep key values encrypted by Windows DPAPI, and never expose plaintext keys to
  the renderer.
- **Multi-key discovery** — ask every active key for its roster and retain which
  keys serve each model.
- **Route testing** — send prompts through the main-process request path with
  per-kind limits, retries, hedged requests, rate-limit pacing and cancellation.
- **Models Catalog** — merge cached reference sources with connected provider
  rosters, show context/pricing/capabilities and score provenance, and keep model
  health and roster activity history.
- **Provider health and activity** — one background sync cycle covers provider
  status, key verdicts, roster changes and the Model Activity notification feed.
- **Key usage** — provider-specific quota, expiry and request history hooks where
  the provider exposes them (including Mirai API and Token Harbor).
- **Test History and Monitoring** — keep run history plus a separate SQLite
  request log with filtering, statistics, exports, retention and secret scrubbing.
- **App lock and security** — local password gate, idle locking, inert locked UI,
  encrypted keys and a safe reset command that removes only the lock row.
- **Appearance and updates** — dark/light themes, five accent colours, provider
  logos and GitHub Release auto-updates.

The former benchmark suite and Routing Profiles page are not part of the current
2.1.x application. The catalog score is reference metadata and measured/provider
health data, not the retired benchmark product.

## Integrated providers

The built-in adapters are loaded from `src/renderer/providers/` and currently
include:

| Provider | Base URL |
| --- | --- |
| NARA Router | `https://router.bynara.id/v1` |
| Dark API | `https://darkapi.dev/v1` |
| Nexum Router | `https://dialagram.me/router/v1` |
| Mirai API | `https://api.miraiapi.com/v1` |
| Inception Labs | `https://api.inceptionlabs.ai/v1` |
| Token Harbor | `https://tokenharbor.ai/v1` |
| Experiential Labs | `https://api.experientiallabs.ai/v1` |
| Jerouter | `https://je.jerouter.web.id/v1` |
| Devora | see `src/renderer/providers/devora.js` |
| Apinex | `https://api.apinex.bond/v1` |
| KiosAPI | `https://kiosapi.com/v1` |

All adapters use the shared provider contract. Most expose OpenAI-compatible
`GET /models` and `POST /chat/completions`; provider-specific hooks may change
catalogue, classification, quota or endpoint behavior.

Detailed provider research lives in [docs/integrations/](docs/integrations/).
That directory distinguishes built-in adapters from reference material for
providers that are not currently loaded by the app.

## Pages

| Page | What it does |
| --- | --- |
| Overview | Recent runs, uptime and regressions |
| Providers | Connected keys, health/usage, integrated adapters and provider pages |
| Models Catalog | Connected/all model views, scores, capabilities, health and actions |
| Model Activity | Roster additions/removals and the notification bell |
| Provider | One provider's keys, discovered models, tests and result export |
| Test History | Runs and individual request history |
| Monitoring | Request-log statistics, facets and trends |
| Database | Bounded, read-only inspection of the local SQLite databases |
| Settings and Profile | Appearance, testing, schedule, reliability, catalog, history, logs, data and security |

## Project structure

```text
src/
  main.js                 Main process, boot order, IPC, updates and request gate
  preload.js              contextBridge surface; the renderer's only door to main
  api-request.js          One outbound HTTP/S request lifecycle
  auth/                   App lock, password hashing and auth IPC
  db/                     venom.db, migrations, repositories, encryption and import
  logs/                   venom-logs.db, recorder, writer, query and retention
  catalog/                Source cache, merge, scoring, snapshots and activity
  renderer/
    index.html            App shell, pages, drawers and modals
    app.js                Settings, providers, discovery, testing and routing shell
    catalog.js            Models Catalog page
    logs.js               Test History and Monitoring
    activity.js            Model Activity page and notification bell
    providers/*.js         One adapter per integrated provider
scripts/
  live/                   Scratch-folder CDP checks and mock provider
  repo-map.mjs            Generated CODE_MAP.md index
  run-tests.js            Runs tests under Electron's Node
  release.mjs             Release-only tag, publish and installer workflow
docs/
  ARCHITECTURE.md         Runtime and data-flow map
  CODE_MAP.md             Generated file/symbol/IPC index
  COOKBOOK.md             Change recipes and acceptance commands
  integrations/           Provider reference material
```

## Adding a provider

Create `src/renderer/providers/<id>.js`, register it in
`window.INTEGRATED_PROVIDERS`, add its logo, and load its script in
`src/renderer/index.html` before `app.js`. The shared `meta` contract includes
`id`, `name`, `baseUrl`, `color`, `logo`, `modelsEndpoint` and `chatEndpoint`.
Optional hooks include:

- `fetchModels` — custom discovery
- `classify(model)` — returns `chat`, `image`, `video` or another supported kind
- `fetchKeyUsage`, `fetchKeyHistory` — key usage drawer data
- `readQuotaError`, `readUsageHeaders` — quota detection and readings
- provider-specific decision probes when the adapter owns that behavior

Then update the fixture/count live checks, README table, code map and tests as
specified in [docs/COOKBOOK.md](docs/COOKBOOK.md).

## Data and security

The app owns two SQLite databases in its user-data folder, opened through main:

- `venom.db` — providers, encrypted keys, settings, catalog snapshots, roster
  events, test runs and the app lock.
- `venom-logs.db` — request rows, bounded request bodies and hourly roll-ups.

Legacy `config.json`, `history.json` and `catalog.json` files are import input for
pre-2.0 installations only; they are renamed after import. API keys use the
`enc:v1:` OS-encrypted envelope and are resolved only in main. Logs scrub resolved
secrets and redact authorization headers.

Settings › Data opens the active folder. Unpackaged `npm start` uses
`%APPDATA%\venom-router-dev`; packaged builds use `%APPDATA%\venom-router`. Tests
and live checks must use an explicit scratch `--user-data-dir`, never the owner's
real `%APPDATA%\venom-router` folder.

## Development

Requires Node.js and Windows-compatible Electron native dependencies.

```bash
npm install
npm start                         # owner workflow; not a test command
npm test                          # 702 tests under Electron's Node
npm run check                     # code-map freshness plus the full suite
npm run check:keystore            # DPAPI/safeStorage verification
npm run verify:live               # end-to-end mock-provider check on scratch data
npm run verify:catalog            # catalog boot/sync check
npm run verify:legend             # capability legend geometry check
npm run verify:sidebar            # catalog drawer geometry check
npm run verify:lock               # app-lock and reset-lock check
npm run build                     # Windows NSIS + portable installers in dist/
npm run build:portable            # Windows portable installer only
```

Live checks use a local mock provider and scratch data. A passing live check does
not prove behavior against a real provider, real key, real 429 or real stream.

## Releasing

The version is changed only in `package.json`, with a matching entry in
`CHANGELOG.md`. After the owner has exercised the build against real providers:

1. Commit the intended release changes.
2. Run `npm run release` only when explicitly requested by the owner.

The release script tags the current version, publishes GitHub release notes and
uploads installers. A release tag cannot be taken back.

## Auto-updates

The app checks GitHub Releases for `VENOMDRMSUPPORT/upstream-checker` after startup
and every two hours. Updates download on request and install on restart or close.

## License

Proprietary
