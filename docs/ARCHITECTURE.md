# Architecture

How VENOM Router is put together, written so that a change can be made without
reading the whole source first. It is a map, not a specification: keep claims
here synchronized with the current code and the generated code map.

Read this after [AGENTS.md](../AGENTS.md), and [CODE_MAP.md](CODE_MAP.md) for
the per-file symbol index. Recipes for the common changes are in
[COOKBOOK.md](COOKBOOK.md).

## 1. Three layers, one rule

```
renderer  (src/renderer/*)      pages, DOM, test runs, the Models table
   |  window.electronAPI  -- the contextBridge surface, preload only
preload   (src/preload.js)      contextBridge: the only door
   |  ipcRenderer.invoke / send
main      (src/main.js + src/db + src/logs + src/catalog)   all I/O, all secrets, all network
```

- The renderer has **no Node and no network**: `contextIsolation: true`,
  `nodeIntegration: false`, and a CSP with `connect-src 'none'`
  (`src/renderer/index.html`). Every outbound request goes through main.
- Main owns both databases and every timer. There is exactly one window and one
  instance per data folder (`app.requestSingleInstanceLock()`).
- `src/db` and `src/logs` never `require('electron')` — the cipher and the log
  are injected. That is what lets the whole data layer run under plain Node in
  the tests, and `test/main-wiring.test.js` asserts it.
- `src/router` also never requires `electron`, so the routing plane loads under
  plain Node in its tests. It lives in main and is described in §5.

## 2. Boot order (src/main.js)

The order is deliberate; each step exists because doing it later caused a bug.

1. **`--smoke-test` guard** — refuses to run without `--user-data-dir`, before
   the real data folder is resolved, moved or locked. Used by
   `scripts/release.mjs` to prove the packaged build opens both databases.
2. **`resolveUserDataDir`** (`src/user-data.js`) — moves
   `%APPDATA%\upstream-checker` to `%APPDATA%\venom-router` once. Skipped
   entirely when `--user-data-dir` is passed (dev and every test run). If the
   rename fails because an older version is running, the legacy folder keeps
   being used and the move is retried next launch.
3. **Single-instance lock** — immediately after `setPath`, because the lock is
   per userData and a second instance would double every timer and race writes.
4. **`startDatabase()`** — opens `venom.db`, sets `app_version`, then runs the
   one-shot legacy import (`src/db/import-json.js`) and renames the JSON files
   `*.imported.json`. A failure to open or to import **stops the app with the
   reason on screen**; carrying on with an empty store is how keys were once
   overwritten. A missing database with saved copies present asks the owner:
   re-import or start empty.
5. **`startLogs()`** — opens `venom-logs.db` and wires the recorder, price book
   and purge scheduler. This one *never throws upward*: a log database that
   will not open turns logging off for the session, says why in `logs-info`,
   and the app runs on.
6. **`createAuthLock()`** — the app lock (`src/auth`). Built after the database,
   because its one row (`app_lock`, schema v4) lives in `venom.db`, and before
   the window, because the request gate below consults it. `ensureDefault()`
   writes the shipped default password when there is no row — a fresh install,
   or one just reset by `npm run reset:lock`. The idle limit is read from
   `lockIdleMin` here and re-read on every `save-settings`; it is arithmetic in
   `isLocked()`, so there is no timer to reschedule.
7. **IPC registration** — `registerDataIpc` (`copy-key` is gated on the lock),
  `registerLogsIpc`, `registerAuthIpc`, `startCatalog` (the `catalog:*` channels,
  which write through `repos.snapshots` and so cannot be registered before the
   store), then the key resolver, `createApiRequester` (gated on the lock) and
  `startVenomRouter()` (§5), then the window.
8. **Window** — saved bounds, frameless, `icon.ico` on Windows; then
   `startUpdateChecks()` (5 s after load, then every 2 h).
9. **Quit (`will-quit`)** — update timers, then `stopLogs()` (purge timer →
   writer flush → `wal_checkpoint` → close), then the local gateway's socket is
   stopped, then `store.close()`. The log flushes before `venom.db` closes
   because the recorder reads provider and price rows from it.

Dev only: `watchRendererInDev` watches `src/renderer` and either swaps one CSS
sheet or reloads the page. Packaged builds never start it.

## 3. Data at rest

Everything lives in the user-data folder. `Settings › Data` opens it.

| File | Owner | Contents |
| --- | --- | --- |
| `venom.db` | `src/db` | providers, keys, settings, secrets, catalog snapshots, roster events, run history, the app lock |
| `venom-logs.db` | `src/logs` | every request, failed-request bodies, hourly roll-ups |
| `venom.db.bak-v<N>` | `src/db` | copy taken before a migration (newest 3 kept) |
| `config.imported.json`, … | import | the pre-2.0 files, renamed and never deleted |
| `requests.log` | legacy | no longer written; Settings can still show and delete it |

**Pragmas** — both connections: `busy_timeout=5000`, `journal_mode=WAL`,
`synchronous=NORMAL`, `temp_store=MEMORY`; `venom.db` also `foreign_keys=ON`.
The log file sets `auto_vacuum=INCREMENTAL` while it is still empty, so the
purge can hand pages back later. `PRAGMA user_version` is the schema version;
each pending migration runs in its own transaction with its version bump.

**venom.db tables** — `meta`, `settings`, `secrets`, `providers`,
`provider_keys`, `snapshot_meta`, `roster_snapshot`, `roster_events`, `models`,
`model_keys`, `provider_sync`, `key_model_counts`, `catalog_meta`, `app_lock`,
`catalog_scores`, `router_cooldowns`, `router_sessions`, `test_runs`,
`test_results`.
A key row holds ciphertext only (`CHECK (cipher GLOB 'enc:v1:?*')`); the plaintext
is decrypted once per session into a cache in main.

Schema v6 added the routing plane's tables and two columns on `provider_keys`:
`tier` (`subscription`/`free`/`cheap`/`paid`, default `paid`) and
`quota_pool_id` (keys that share one quota bucket). `catalog_scores` holds the
last scored reference rows so the Models page and the router have values in
0 ms at boot, before any sync. `router_cooldowns` holds the three-level
isolation state (model-on-key, key, provider) with millisecond expiry, and
`router_sessions` pins a cascade session to its tier/model/key with its
escalation level. The migration is additive: an older row reads as the paid
tier.

The catalog's rows live in `roster_snapshot` (one per provider+model, carrying
the provider's own facts with every derived field stripped) and `snapshot_meta`
(one per provider: when it was first seen, when the rows were fetched, how the
last attempt ended, and a quarantined mass drop). The merged reference is never
stored — it is rebuilt in memory from the cached source documents at boot and after
every sync. `models` and its neighbours are the pre-2.0 pool: migration v3 empties
them and no writer fills them again, so treat anything read from `models` as a
bug.

**venom-logs.db tables** — `meta`, `request_logs`, `request_bodies`,
`usage_hourly`. No foreign keys: a row outlives the provider and key it names.
Retention defaults are 90 days of rows, 7 days of bodies, 12 months of roll-ups
(`src/logs/settings.js`), purged 30 s after start and then daily, in chunks,
yielding between chunks and whenever a request is in flight.

## 4. The request lifecycle

The single path every outbound call takes.

1. **Renderer** calls `electronAPI.apiRequest({ url, headers, body, requestId, timeoutMs, source, runId, attempt, hedgeIndex, testGroup, trigger })`.
   It never holds a key: where a key goes it writes `venomkey:<keyId>`, and
   `venomsecret:openRouterApiKey` for the OpenRouter key.
2. **The lock gate** (`src/main.js`) — the only two channels that hand over a
   secret or spend quota are refused while the app is locked: `api-request`
   resolves `{ outcome: 'locked' }` here, and `copy-key` answers
   `{ ok: false, code: 'LOCKED' }` in `src/db/ipc.js`. A request that does go
   through also counts as activity, so the idle deadline moves on main's own
   code rather than on the renderer having reported anything.
3. **`createKeyResolver`** (`src/db/keys.js`) substitutes tokens — in the URL
   (URL-encoded), in a header (raw) and in a JSON body (JSON-escaped) — **only
   when the request's origin is that key's own provider**. A mismatch returns
   `blocked` and the request never leaves. The longest matching key id wins.
   It also returns `refs` (which key/secret) and `substitutions` (the real
   secrets, for the log's scrubber and nowhere else).
4. **`src/api-request.js`** sends it over `https`/`http` and guarantees the
   request **finishes exactly once** — response end, body cut off, socket
   timeout, transport error, or a resolver refusal. `finish()` resolves the
   renderer's promise first; the log record is built in `setImmediate`
   afterwards, so logging can never slow a reply or break one. Failures resolve
   (with `error`, `elapsed`, `networkError`) rather than reject, so the reply
   keeps its fields.
   Timing: `timeoutMs` is a *socket inactivity* timeout (default 60 s);
   `firstByteMs` is the first body byte, `firstTokenMs` the first chunk
   carrying model text.
4. **Cancel** — `cancel-api-request(requestId, reason)` with `hedge_lost`
   (a faster hedge won), `stop` (the user) or `deadline` (per-kind limit).
   Anything else is recorded as `stop`; an unknown or finished id is a no-op.
5. **`src/logs/recorder.js`** turns the finished request into one row: source,   run id, attempt, hedge flag, provider and key (from `refs`, else the single
   provider with that origin), endpoint, model, status, HTTP status, error
   class/code/message, latency, TTFT, tokens, cost (from the pool's
   `summary_json.pricing`), and a bounded `meta_json`. Stored text is scrubbed
   with `substitutions` in every form a secret can come back in (raw, JSON,
   `\/`-escaped, URL-encoded); auth headers are redacted; bodies are kept only
   per the `logLevel` setting (`off` | `errors` | `all`).
6. **`src/logs/writer.js`** batches: flush at 250 ms or 500 rows, one
   transaction for rows + bodies + hourly roll-ups. Nothing here throws to the
   caller — a batch that cannot be written is dropped and counted
   (`logs-info` shows the count), warned about at most once a minute.
7. **`src/logs/ipc.js`** serves the pages: `logs-list`, `logs-get`,
   `logs-stats`, `logs-facets`, `logs-runs`, `logs-run-summary`,
   `logs-export`, `logs-info`, `logs-clear`. Registered even when logging is
   off: every read answers empty and `logs-info` carries the reason.

**Status values** in a row: `ok`, `cancelled`, `blocked`, `timeout`, `error`
(with `error_class` one of `auth`, `rate_limit`, `quota`, `bad_request`,
`server`, `network`, `other`).

## 5. The router plane

`src/router/index.js` is the local multi-account router: it turns the scored
roster into three routing pools and serves them from one HTTP endpoint on
`127.0.0.1`. It never requires `electron`, so it loads under plain Node in
`test/router/router.test.js`.

**Wiring** (`src/main.js`). After the key resolver is built, `startVenomRouter()`
builds the key pool and the smart catalog from the roster's scored rows and
registers `router:status`, `router:refresh` and `router:profiles`. The gateway
object exists from that moment but binds **no socket**: the socket opens on the
first roster rows or the first explicit status/refresh query, never because a
window opened. A busy port logs a warning and leaves the desktop untouched.

**The three profiles.** `buildSmartCatalog` splits the roster into `venom-lite`
(free and near-free rows, cheapest first), `venom-pro` (tool-capable rows,
split into an efficient and a capable rung) and `venom-max` (documented-score
frontier rows, at most three, preferring different providers). A row that
cannot answer in text never becomes a candidate. A row the reference cannot
score still enters the pools with an explicit `est-heuristic` estimate so it
ranks last instead of vanishing — and that estimate is never written to
`catalog_scores`.

**Two identities.** `upstreamModelId(provider, model)` (`provider::model`) is
the dispatch address; `canonicalSlug(provider, model)` is only the
scoring/benchmark lookup key. Collapsing listings for display never breaks
key binding.

**Key pool.** `KeyPoolManager` drains tiers in the order subscription → free →
cheap → paid, picking within a tier by power-of-two-choices over the
least-recently-failed keys. Keys sharing a `quota_pool_id` count once, so a
shared bucket is never read as spare capacity. Failures are isolated on three
levels: a 429 cools model-on-key, a 402/401 cools the key (and its pool), and
three consecutive server errors trip the provider. Cooldowns are persisted in
`router_cooldowns`.

**Cascade.** `VenomCascadeEngine` runs the request: `venom-pro` watches the
conversation's `role: "tool"` results and escalates a stalled session to the
capable pool with a handoff note; `venom-max` fans out to up to three routes
and merges the drafts with a lead-analyst pass (longest draft as the fallback).
A plain-text tool call is rescued into the OpenAI tool-call shape. Streaming
pipes the provider's bytes through after its own `200 OK`; failover is only
possible before the first chunk.

**Secrets.** The router sends `venomkey:<keyId>` placeholders and lets the same
resolver every other request uses swap in the real value, so a secret never
crosses into the router, the renderer or a log row.

The user-facing contract — endpoints, headers, tiers, the Venom Profiles page
and what it does not prove — is in [LOCAL_GATEWAY.md](LOCAL_GATEWAY.md).

## 6. Secrets

- At rest: `enc:v1:` + base64(safeStorage/DPAPI), and the OS master key lives in
  `Local State` inside the same data folder — which is why the folder is moved
  whole rather than copied. A value encrypted on another machine is kept
  untouched and reported as **locked**, never overwritten with an empty string.
- In flight: placeholders, resolved in main, only to the secret's own origin
  (`SECRET_ORIGINS` in `src/db/repos/secrets.js`).
- In the log: scrubbed before it is stored; the renderer's copy of a response is
  never scrubbed.
- The renderer receives a masked hint and a `venomkey:` placeholder, nothing
  more. `copy-key` writes the clipboard in main so the page never sees it.
- A signed-in account (the OAuth plane, §7) holds a second secret: its access
  token, in its own encrypted column, reached by the `venomoauth:` placeholder
  and resolved by the same origin rule.

## 7. IPC surface

The generated [CODE_MAP.md](CODE_MAP.md#ipc-channels) is the source of truth for
the current registered invoke/handle channels, including the router channels.
The auth module adds `auth:*` channels, and the close handshake uses the two
one-way messages `flush-pending` and `flush-done`; read the grouped table below
rather than treating the generated list as the entire runtime wire.

| Group | Channels | Notes |
| --- | --- | --- |
| Window | `window-minimize`, `window-maximize`, `window-close`, `set-window-icon` | fire-and-forget |
| Requests | `api-request`, `cancel-api-request` | the only network path. `api-request` **resolves** `{ outcome: 'locked' }` while the app is locked, and is not recorded in the request log — nothing was sent for a row to describe |
| Data | `read-config`, `database-explorer`, `save-settings`, `save-secret`, `save-test-definition`, `save-provider`, `merge-provider`, `delete-provider`, `copy-key`, `read-history`, `append-run`, `clear-history` | one thing per channel, so two writers cannot overwrite each other. `copy-key` is gated on the lock and answers `{ ok: false, code: 'LOCKED' }` |
| Catalog | `catalog:ingest`, `catalog:read`, `catalog:health`, `catalog:sources`, `catalog:fetch-info`, `catalog:events`, `catalog:events-read` | the catalog roster, its sources and its change feed. **Every one resolves**: an outcome the page must act on is `{ ok: false, code, message }`, because `err.code` cannot cross `ipcMain.handle` — a rejection becomes a new Error carrying only its message |
| App lock | `auth:status`, `auth:unlock`, `auth:change`, `auth:lock`, `auth:activity` | same resolving contract. `auth:locked` travels the other way (main→renderer) when the idle limit ends a session. No reply ever carries the stored hash |
| OAuth | `oauth-start`, `oauth-status`, `oauth-cancel`, `oauth-reopen`, `oauth-usage`, `oauth-renew` | a provider that signs in on a web page (docs/OAUTH_PROVIDERS.md). `oauth-start` returns the code to type; `oauth-status` is a read and answers even while the app is locked; the ones that act are gated on the lock and answer `{ ok: false, code: 'LOCKED' }`. Main keeps the flow, the token and the credential — the renderer never sees a secret |
| Wire | `wire:build`, `wire:parse` | a provider that does not speak OpenAI: the page asks main to build the request that provider understands and to read the answer it sends back. The provider's own address comes from the database, never from the page, so a key can only ever travel to the provider it belongs to (src/wire/) |
| Router | `router:status`, `router:refresh`, `router:profiles` | routing status and profile data; defined in `src/main.js` and exposed through `src/preload.js` |
| Request log | `logs-list`, `logs-get`, `logs-stats`, `logs-facets`, `logs-runs`, `logs-run-summary`, `logs-export`, `logs-info`, `logs-clear` | read-only except export and clear |
| Legacy log file | `read-log-info`, `open-request-log`, `clear-request-log` | the old `requests.log` |
| App / shell | `get-data-path`, `open-data-folder`, `open-external`, `notify-regression` | `open-external` accepts http(s) only |
| Updates | `download-update`, `install-update`, `check-for-updates-manual` | install flushes pending saves first |
| Close handshake | `flush-pending` (main→renderer), `flush-done` (renderer→main) | main waits at most 2 s |

## 8. Renderer

Load order matters: classic local scripts, no runtime imports or template fetches.

`providers/*.js` (register into `window.INTEGRATED_PROVIDERS`) →
`ui-select.js` → `ui-stepper.js` → `ulid.js` → **`lock.js`** → **`profile.js`** →
`provider-facts.js` → `catalog-caps.js` → **renderer units** →
**`profile-badges.js`** → **`app.js`** → `key-usage.js` → `catalog.js` →
`logs-format.js` → `logs.js` → `database.js` → `activity.js` →
**`router-status.js`**.

`catalog-caps.js` is a plain classic script of pure capability readers (three
states: true, false and the null that means "nobody published this"), not a
unit on `window.VENOM_RENDERER`. `profile-badges.js` and `router-status.js`
are standalone classic scripts as well; both degrade to an empty result when
their channel is unavailable, so a missing page never breaks another one.

Renderer units register on **`window.VENOM_RENDERER`** before app.js composes them:

| File | Namespace | Owns |
| --- | --- | --- |
| `test-response.js` | `responses` | Pure response/usage/Retry-After parsing, asset lookup and result ranking |
| `test-policy.js` | `policy.create(deps)` | Quota predicates, private denied pairs, key cooldowns, learned RPM and pacing |
| `test-attempts.js` | `attempts.create(deps)` | Chat/image/video/decision requests and parameter negotiation through injected IPC |
| `test-runner.js` | `runner.create(deps)` | Adaptive hedging, deadline cancellation, retry rounds and model budgets |
| `settings-defaults.js` | `defaults` | Shipped settings, themes, accents and legacy accent mapping |
| `appearance.js` | `appearance.create(deps)` | Theme/accent/density controls, icon debounce and system-theme listener |
| `updates.js` | `updates.create(deps)` | Update badge/modal state and inert release-note rendering |
| `sidebar-effects.js` | `effects` | Deterministic stars and the accessible signature heart |
| `results-table.js` | `results.create(deps)` | Results rows, sorting/filtering, response modal, CSV/JSON export and clear state |
| `settings-panel.js` | `settingsPanel.create(deps)` | Settings form conversion, cost estimate, section navigation and page preparation |
| `provider-store.js` | `providerStore.create(deps)` | Stable runtime provider map, saved-provider hydration, safe key reconciliation, per-provider save and legacy custom-provider cleanup |
| `provider-detail.js` | `providerDetail.create(deps)` | Single-provider page header, breadcrumbs, key-list rendering and key-action delegation |
| `provider-actions.js` | `providerActions.create(deps)` | Key checks, toggles/deletion, undo, row expansion and post-action view refresh through injected persistence |
| `provider-keys.js` | `providerKeys.create(deps)` | Shared key status, countdown updates, provider key panels and connected-row key markup |
| `provider-roster.js` | `providerRoster.create(deps)` | Connected/integrated roster state, filtering, sorting, responsive layout and delegated roster actions |
| `provider-models.js` | `providerModels.create(deps)` | Provider-owned fetched model rosters and selections, per-key discovery, catalog ingestion and metadata normalization |
| `provider-view.js` | `providerView.create(deps)` | Shared provider identity, health, capability, legend, card and connected-row presentation |
| `page-router.js` | `pageRouter.create(deps)` | Hash-route parsing/synchronization and deep-link delegation |
| `shell.js` | `shell.create(deps)` | Shell navigation, page-entry lifecycle, Overview summaries, health lamp and responsive navigation |

Factory internals are closure-scoped. Mutable app state is supplied through
**live getters**, especially settings, current page and abort state: Data reset
replaces the settings object, and Stop can change while a request is pending.
App.js keeps compatibility aliases used by existing consumers (for example
`isKeySpent` in key-usage.js and `parseChatCompletion` in catalog.js). It still owns
request IDs/tags, run coordination, settings persistence and shared provider
presentation helpers. Shell navigation, page-entry lifecycle and Overview
summaries are composed through `shell.js`; results-table and settings-panel
behavior is also composed through their factories. It is not yet an
initialization-only entry point.

- **`lock.js`** — the app lock screen, `window.LOCK`. Loaded before `app.js`
  because `app.js`'s `start()` is gated: it asks `auth:status` first and does no
  startup work at all until the password is accepted. Shows and hides the panel,
  owns the canvas particle field (stopped on hide, on blur and under reduced
  motion), and never decides anything — whether the app is locked and whether a
  password is right are main's answers.
- **`profile.js`** — the header's Administrator menu: **Lock now** and **Sign
  out**. Both call `auth:lock`, which clears main's session and sends
  `auth:locked` back.
- **`app.js`** composes the units and owns general settings, key mutations,
  run history, results/exports and cross-page business behavior.
- **`provider-store.js`** owns the stable runtime provider map and its read,
  seed, legacy cleanup and save reconciliation path. It calls the app's typed
  persistence boundary and leaves page refresh, catalog invalidation and the
  `providers-changed` event behind explicit callbacks.
- **`provider-detail.js`** owns the single-provider page's header and key-list
  DOM. It receives live provider/page getters and delegates key mutations to
  app-owned actions, so it does not own request policy or persistence.
- **`provider-roster.js`** owns the connected/integrated Providers page state,
  responsive layout, filtering/sorting, and page-level event delegation. It
  receives live provider/history getters and calls app-owned key and discovery
  actions through callbacks. Provider card and shared key-panel markup are
  separate from its page state.
- **`provider-keys.js`** owns the shared key-status view, expiry and relative-time
  updates, and the key rows embedded in provider cards and connected-provider
  rows. Key mutations remain app callbacks; it never reads or renders secret
  values, only the masked hint.
- **`provider-actions.js`** owns provider-key checks and interactions, including
  activation, two-step deletion with Undo, and connected-row expansion. It uses
  the provider store's save callback and the main-owned request path; key
  material stays in the provider records and never crosses into presentation.
- **`provider-view.js`** owns shared provider identity, status, capabilities,
  authentication labels, legends, cards and connected-row markup. Health and
  run data arrive through live getters; rate-limit and key actions stay behind
  app callbacks.
- **`provider-models.js`** owns discovery and catalog handoff. Each runtime
  provider record is the source for its fetched model list and selected models;
  app.js and existing classic-script consumers use narrow compatibility getters.
- **`page-router.js`** owns hash parsing, URL synchronization and deep-link
  delegation for `#/provider/<id>`, `#/settings/<section>` and `#/history/<tab>`.
  Page rendering and shell navigation are delegated to `shell.js`.
- **`shell.js`** owns shell navigation, page visibility and lifecycle dispatch,
  responsive navigation behavior, and the Overview's quick stats, run panels
  and system-health lamp. It calls page modules through injected callbacks and
  does not own their data.
- **`catalog.js`** — the Models page. It holds no pool: discovery hands the
  adapter's roster to `catalog:ingest` and the page draws what `catalog:read`
  serves back, re-scored against today's reference. Three per-row actions, in
  the order health · fetch information · chat.
- **`logs.js`** — Test History (Runs/Requests) and Monitoring; exposes
  `window.LOGS` with `render()`, `renderMonitor()`, `sync()`, `tab()`.
- **`activity.js`** — the header bell and the Model Activity page. Reads the
  roster-event feed (`catalog:events`), never the roster itself; exposes
  `window.ACTIVITY` with `init()`, `render()`, `renderIfShown()`, `refreshBell()`.
- **`router-status.js`** — the Venom Profiles page. Reads `router:profiles`
  (falling back to `router:status` counts) and draws the three policy cards,
  the per-profile dossiers, the fleet totals and the eligible target lists;
  the Refresh action calls `router:refresh`.
- **`profile-badges.js`** — the shared LITE/PRO/MAX badge identity. It indexes
  the profiles payload by provider/model, bare model id and upstream id, and
  is reused by the Models Catalog rows, the Model Activity feed and the
  Monitoring log rows.
- **`key-usage.js`** — per-key quota drawer, provider-agnostic; the log drawer
  reuses its panel CSS.
- Providers add behaviour through `meta` plus optional hooks:
  `fetchModels`, `classify(model)`, `excludeModel(model)`, `fetchKeyUsage`,
  `fetchKeyHistory`, `readQuotaError`, `readUsageHeaders`,
  `decisionProbe`, `readDecisionAnswer`, and — for a provider that does not
  speak OpenAI — `buildChatRequest` / `parseChatResponse`.
- A provider that does not speak OpenAI has a **wire**: `src/wire/<id>.js`
  holds its whole protocol — the request it understands and the answer it
  sends back. The wire lives in main, so the page and the routing gateway
  speak the same one; the page reaches it through `wire:build` / `wire:parse`.
- `meta.auth` says what kind of credential the provider takes — `apikey` (the
  default), `oauth`, `none` — and the roster counts the accounts accordingly.
  A provider that signs in on a web page declares its flow in `meta.oauth`
  and is driven by the OAuth plane (docs/OAUTH_PROVIDERS.md).

Legacy classic scripts share a lexical global scope: a duplicate top-level
`const` can stop a script from loading. New units keep their internals inside
factories/IIFEs instead of adding more lexical globals. Production-module tests
use `test/renderer/module-loader.js` to evaluate complete scripts, not source
slices that depend on comments or line positions.

**Catalog readiness has two stages:** `state.loaded` means the local snapshot
was read. The first provider-discovery pass runs asynchronously afterwards;
`state.lastSyncAt > 0 && !state.syncing` means that pass completed, whether it
succeeded or failed. A live test asserting provider-published rows must wait for
the pass, then assert the actual rows; a new scratch database can be empty while
`loaded` is already true. This does not change startup behavior.

## 9. What proves what

| Command | Proves | Does **not** prove |
| --- | --- | --- |
| `npm test` | the complete current test suite under Electron's Node; the command output reports its current count | actual Electron UI visibility or real-provider behavior |
| `npm run verify:live` | the real app, launched on a scratch folder over CDP against a **mock** provider: import, log, pages, drawdown geometry, restart, single instance | a real provider, a real key, a real 429, a real stream |
| `npm run verify:catalog` | nothing downloads at boot; the sources fill on a click; the Models page opens on its own path | anything about a real provider or a keyed fetch |
| `npm run verify:lock` | the lock screen covers the viewport, the emblem paints (its pixels are counted, not its URL read), the shell is `inert`, the colours ignore a forced theme and accent, and the shipped default opens it | that the lock resists anyone with code execution as this Windows user — it does not |
| `node scripts/live/verify-renderer-modules.mjs` | module composition, appearance, persistence and navigation end to end, plus the router-page geometry check | a real provider, key, stream or 429 |
| `npm run reset:lock -- "<dir>"` | deletes the saved password and nothing else | anything about the rest of the data; it touches one row |
| `npm run repo:map -- --check` | CODE_MAP.md matches the tree | nothing about behaviour |
| `npm run check:keystore` | DPAPI round-trips on this machine | — |
| `npm start` | your build, your data | — |

Rules learned the hard way, both in [CLAUDE.md](../CLAUDE.md):
`textContent` proving text exists is not proof a person can see it — measure
geometry (`getBoundingClientRect`), and always drive a scratch
`--user-data-dir`, never the owner's folder.

Every live gate opens the app lock first, with `app.unlockAndWait()` from
`scripts/live/cdp.mjs`: the lock is the front door, so a gate that waited for
the page without opening it would time out on the panel rather than on what it
came to measure. It resolves the same `{ ok }` value `auth:unlock` always does,
so a gate can assert the unlock happened instead of assuming it.

## 10. Conventions that bite

- The version lives **only** in `package.json`; the window reads it over IPC.
- The documents in `docs/` describe the code as it is **now**. There is no
  parallel set of historical plans to consult; the history lives in `git log`
  and in [../CHANGELOG.md](../CHANGELOG.md). When a change makes a sentence in
  [ARCHITECTURE.md](ARCHITECTURE.md) or [COOKBOOK.md](COOKBOOK.md) wrong, fix
  the sentence in the same change.
- Migration files are append-only: an entry that has shipped is never edited.
  The app lock's table arrived that way (v4). Its row is written by `src/auth`
  at startup rather than by the migration, because a password hash frozen into a
  shipped migration could never be changed.
- A repo in `src/db/repos` prepares its statements **lazily** if its table
  arrives in a late migration: `open()` assembles every repo before it knows
  which migrations will run, and `test/db/open.test.js` opens files against a
  truncated migration list on purpose.
- A new column on `request_logs` is a new migration + `ROW_COLUMNS` in the
  writer + the recorder + the query layer. Missing one is silent data loss.
- `src/renderer/app.js`, `index.html` and `styles.css` are each thousands of
  lines with section-banner comments; grep a banner (`// ====`) or an element id
  before reading.
