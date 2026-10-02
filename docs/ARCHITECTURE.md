# Architecture

How VENOM Router is put together, written so that a change can be made without
reading the whole source first. It is a map, not a specification: every claim
here was true of the code at the commit that added this file.

Read this after [AGENTS.md](../AGENTS.md), and [CODE_MAP.md](CODE_MAP.md) for
the per-file symbol index. Recipes for the common changes are in
[COOKBOOK.md](COOKBOOK.md).

## 1. Three layers, one rule

```
renderer  (src/renderer/*)      pages, DOM, test runs, the Models table
   |  window.electronAPI  -- 42 IPC channels, preload only
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
6. **IPC registration** — `registerDataIpc` (12 channels), `registerLogsIpc`
   (10 channels), `startCatalog` (the five `catalog:*` channels, which write
   through `repos.snapshots` and so cannot be registered before the store),
   `createApiRequester`, then the window.
7. **Window** — saved bounds, frameless, `icon.ico` on Windows; then
   `startUpdateChecks()` (5 s after load, then every 2 h).
8. **Quit (`will-quit`)** — update timers, then `stopLogs()` (purge timer →
   writer flush → `wal_checkpoint` → close), then `store.close()`. The log
   flushes before `venom.db` closes because the recorder reads provider and
   price rows from it.

Dev only: `watchRendererInDev` watches `src/renderer` and either swaps one CSS
sheet or reloads the page. Packaged builds never start it.

## 3. Data at rest

Everything lives in the user-data folder. `Settings › Data` opens it.

| File | Owner | Contents |
| --- | --- | --- |
| `venom.db` | `src/db` | providers, keys, settings, secrets, model pool, run history |
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
`provider_keys`, `snapshot_meta`, `roster_snapshot`, `models`, `model_keys`,
`provider_sync`, `key_model_counts`, `catalog_meta`, `test_runs`, `test_results`.
A key row holds ciphertext only (`CHECK (cipher GLOB 'enc:v1:?*')`); the plaintext
is decrypted once per session into a cache in main.

The catalog's rows live in `roster_snapshot` (one per provider+model, carrying
the provider's own facts with every derived field stripped) and `snapshot_meta`
(one per provider: when it was first seen, when the rows were fetched, how the
last attempt ended, and a quarantined mass drop). The merged reference is never
stored — it is rebuilt in memory from four cached documents at boot and after
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
2. **`createKeyResolver`** (`src/db/keys.js`) substitutes tokens — in the URL
   (URL-encoded), in a header (raw) and in a JSON body (JSON-escaped) — **only
   when the request's origin is that key's own provider**. A mismatch returns
   `blocked` and the request never leaves. The longest matching key id wins.
   It also returns `refs` (which key/secret) and `substitutions` (the real
   secrets, for the log's scrubber and nowhere else).
3. **`src/api-request.js`** sends it over `https`/`http` and guarantees the
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
5. **`src/logs/recorder.js`** turns the finished request into one row: source,
   run id, attempt, hedge flag, provider and key (from `refs`, else the single
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

## 5. Secrets

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

## 6. IPC surface

42 channels. The full generated list is in [CODE_MAP.md](CODE_MAP.md#ipc-channels).

| Group | Channels | Notes |
| --- | --- | --- |
| Window | `window-minimize`, `window-maximize`, `window-close`, `set-window-icon` | fire-and-forget |
| Requests | `api-request`, `cancel-api-request` | the only network path |
| Data | `read-config`, `database-explorer`, `save-settings`, `save-secret`, `save-test-definition`, `save-provider`, `merge-provider`, `delete-provider`, `copy-key`, `read-history`, `append-run`, `clear-history` | one thing per channel, so two writers cannot overwrite each other |
| Catalog | `catalog:ingest`, `catalog:read`, `catalog:health`, `catalog:sources`, `catalog:fetch-info` | the model pool and its four sources. **Every one resolves**: an outcome the page must act on is `{ ok: false, code, message }`, because `err.code` cannot cross `ipcMain.handle` — a rejection becomes a new Error carrying only its message |
| Request log | `logs-list`, `logs-get`, `logs-stats`, `logs-facets`, `logs-runs`, `logs-run-summary`, `logs-export`, `logs-info`, `logs-clear` | read-only except export and clear |
| Legacy log file | `read-log-info`, `open-request-log`, `clear-request-log` | the old `requests.log` |
| App / shell | `get-data-path`, `open-data-folder`, `open-external`, `notify-regression` | `open-external` accepts http(s) only |
| Updates | `download-update`, `install-update`, `check-for-updates-manual` | install flushes pending saves first |
| Close handshake | `flush-pending` (main→renderer), `flush-done` (renderer→main) | main waits at most 2 s |

## 7. Renderer

Load order matters: classic scripts, no modules, globals shared.

`providers/*.js` (register into `window.INTEGRATED_PROVIDERS`) →
`ui-select.js` → `ulid.js` → **`app.js`** → `key-usage.js` → `catalog.js` →
`logs-format.js` → `logs.js`.

- **`app.js`** is the core: settings, provider/key model, discovery, the test
  engine (hedging, retries, rate-limit pacing), history, exports, the shell and
  the router (`PAGES`, hash routes `#/provider/<id>`, `#/settings/<section>`,
  `#/history/<tab>`).
- **`catalog.js`** — the Models page. It holds no pool: discovery hands the
  adapter's roster to `catalog:ingest` and the page draws what `catalog:read`
  serves back, re-scored against today's reference. Three per-row actions, in
  the order health · fetch information · chat.
- **`logs.js`** — Test History (Runs/Requests) and Monitoring; exposes
  `window.LOGS` with `render()`, `renderMonitor()`, `sync()`, `tab()`.
- **`key-usage.js`** — per-key quota drawer, provider-agnostic; the log drawer
  reuses its panel CSS.
- Providers add behaviour through `meta` plus optional hooks:
  `fetchModels`, `classify(model)`, `fetchKeyUsage`, `fetchKeyHistory`,
  `readQuotaError`, `readUsageHeaders`.

Classic scripts share one global scope: a top-level `const` here can silently
shadow one in another file (the reason `logs-format.js` defines `logEscape`
instead of `escapeHtml`).

## 8. What proves what

| Command | Proves | Does **not** prove |
| --- | --- | --- |
| `npm test` | 552 tests over the data, log, request and catalog layers, under Electron's Node (~2 s) | anything in the renderer except the pure helpers it loads by text |
| `npm run verify:live` | the real app, launched on a scratch folder over CDP against a **mock** provider: import, log, pages, drawdown geometry, restart, single instance | a real provider, a real key, a real 429, a real stream |
| `npm run verify:catalog` | nothing downloads at boot; the four sources fill on a click; the Models page opens on its own path | anything about a real provider or a keyed fetch |
| `npm run repo:map -- --check` | CODE_MAP.md matches the tree | nothing about behaviour |
| `npm run check:keystore` | DPAPI round-trips on this machine | — |
| `npm start` | your build, your data | — |

Rules learned the hard way, both in [CLAUDE.md](../CLAUDE.md):
`textContent` proving text exists is not proof a person can see it — measure
geometry (`getBoundingClientRect`), and always drive a scratch
`--user-data-dir`, never the owner's folder.

## 9. Conventions that bite

- The version lives **only** in `package.json`; the window reads it over IPC.
- `docs/superpowers/plans|specs|research` are the *historical* design record
  (some plans are 300 KB). Read them for intent, never as current state.
  `docs/INDEX.md` is likewise historical — see its stub.
- Migration files are append-only: an entry that has shipped is never edited.
- A new column on `request_logs` is a new migration + `ROW_COLUMNS` in the
  writer + the recorder + the query layer. Missing one is silent data loss.
- `src/renderer/app.js`, `index.html` and `styles.css` are each thousands of
  lines with section-banner comments; grep a banner (`// ====`) or an element id
  before reading.
