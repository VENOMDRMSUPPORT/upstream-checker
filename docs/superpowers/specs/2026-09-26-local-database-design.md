# Local database (sub-project A) — design

Date: 2026-09-26
Status: approved in chat
Research: `docs/superpowers/research/2026-09-26-new-api/` (02 data model, 06 current persistence, 07 verification)

## Context and goal

Phase 2 of VENOM Router gives the local desktop admin app a database and a logging
system. It is split into three sub-projects, each with its own spec and plan:

- **A — local database** (this spec): replace `config.json`, `catalog.json` and
  `history.json` with SQLite, keep API keys in the main process only, and remove the
  data-loss paths the audit found.
- **B — logging system**: `venom-logs.db`, `request_logs` with benchmark-grade
  columns, batched writer, hourly roll-ups, retention (90 days raw, 12 months
  roll-ups), failed-request bodies kept 7 days.
- **C — log pages**: Request Log (in the "Test History" slot), Runs, Monitoring.

A hosted website that sells subscriptions to venom-lite / pro / max comes later. It is
not built now. This spec only avoids choices that would block it (see "Future server").

### Problems A must fix (verified in 07-verification.md)

1. Any failed read of `config.json` (corrupt JSON, EBUSY/EPERM from antivirus or
   OneDrive, a 0-byte file after power loss) is treated as an empty config. The
   renderer then seeds providers and writes, destroying every key. `saveWindowState`
   on window close is a second path that writes the defaults back.
2. Read-modify-write across two IPC calls loses concurrent updates (settings vs
   provider saves, provider vs provider).
3. Whole-file rewrites: the ~300 KB catalogue is sent and rewritten on every sync, even
   when nothing changed; `history.json` is rewritten on every run.
4. Write failures are silent; pending debounced saves are dropped on quit and on
   update install; no single-instance lock; no fsync.
5. Keys are decrypted on every read and handed to the renderer in plaintext.
   `settings.aaApiKey` is stored unencrypted.
6. Runs have no id; in-memory history grows without bound during a session.

## Decisions (made with the owner)

| Topic | Decision |
|---|---|
| Engine | `better-sqlite3` in the main process only |
| Keys | Stay in main. The renderer gets a placeholder and a hint |
| Bodies / retention | Belong to sub-project B (failed only, 7 days; 90 days raw, 12 months roll-ups) |

## 1. Database layer

### Files and settings

- `venom.db` in the app data folder (`app.getPath('userData')`, resolved by
  `src/user-data.js`).
- Opened once in main, before the window is created. Pragmas on open:
  `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`,
  `temp_store=MEMORY`.
- `app.requestSingleInstanceLock()`: a second launch focuses the existing window and
  exits, so two processes never open or migrate the DB at once.

### Code layout

```
src/db/index.js          open(), pragmas, migrate(), backup, close()
src/db/migrations.js     ordered list of { version, up(db) } — SQL strings inside JS
src/db/repos/settings.js settings rows (settings, test, window)
src/db/repos/secrets.js  encrypted named secrets (aaApiKey)
src/db/repos/providers.js providers + provider_keys
src/db/repos/catalog.js  models, model_keys, provider_sync, key_model_counts, catalog_meta
src/db/repos/history.js  test_runs + test_results
src/db/import-json.js    one-shot importer from the legacy JSON files
src/db/keys.js           placeholder ↔ secret resolution for api-request
```

Migrations live in a JS module (not `.sql` files) so they are bundled by
electron-builder's `files: ["src/**/*"]` without extra config.

### Migrations

- `PRAGMA user_version` holds the schema version. On open, each pending migration runs
  in its own transaction and bumps the version.
- **Backup before migrating** an existing, non-empty DB: `db.backup()` to
  `venom.db.bak-v<from>`; keep the last 3.
- **Downgrade guard**: if `user_version` is higher than the app knows, show a dialog
  ("This data was written by a newer VENOM Router. Update the app to open it.") and quit
  without writing.

### Schema v1

Conventions: timestamps are integer epoch ms; booleans are 0/1 integers; JSON columns
are `TEXT` named `*_json`; no reserved-word column names; real foreign keys.

```
meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)
  -- install_id (random UUID, created once), imported_from_json_at, app_version

settings(key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL)
  -- rows: 'settings' (without aaApiKey), 'test', 'window'

secrets(name TEXT PRIMARY KEY, cipher TEXT NOT NULL, updated_at INTEGER NOT NULL)
  -- 'aaApiKey'; cipher uses the existing enc:v1: envelope

providers(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
  rpm INTEGER, is_custom INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)

provider_keys(
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  name TEXT NOT NULL, cipher TEXT NOT NULL, hint TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0,
  quota_spent_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)
  INDEX provider_keys(provider_id, position)

models(
  provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
  name TEXT, kind TEXT, first_seen INTEGER, last_seen INTEGER, removed_at INTEGER,
  is_new INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT,        -- pricing, declaresTools, maxOutput, hasVision, hasReasoning,
                            -- isFree, isFreeForPaid, contextLabel, contextWindow, ownedBy
  bench_json TEXT, bench_history_json TEXT, bench_error TEXT,
  caps_json TEXT, caps_error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider_id, model_id))
  INDEX models(provider_id, removed_at)

model_keys(provider_id TEXT NOT NULL, model_id TEXT NOT NULL, key_id TEXT NOT NULL,
  PRIMARY KEY (provider_id, model_id, key_id),
  FOREIGN KEY (provider_id, model_id) REFERENCES models ON DELETE CASCADE)

provider_sync(provider_id TEXT PRIMARY KEY, last_sync_at INTEGER NOT NULL)
key_model_counts(key_id TEXT PRIMARY KEY, count INTEGER NOT NULL, at INTEGER NOT NULL)
catalog_meta(key TEXT PRIMARY KEY, value_json TEXT NOT NULL)
  -- 'leaderboard', 'leaderboardError', 'profiles'

test_runs(
  id INTEGER PRIMARY KEY, run_uid TEXT NOT NULL UNIQUE,   -- ULID, for future sync
  at INTEGER NOT NULL, provider_id TEXT NOT NULL, provider_name TEXT NOT NULL,
  prompt TEXT NOT NULL)
  INDEX test_runs(at), test_runs(provider_id, id)

test_results(
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL, status TEXT NOT NULL, time_ms INTEGER, tokens INTEGER,
  completion_tokens INTEGER, attempts INTEGER NOT NULL DEFAULT 1, correct INTEGER)
  INDEX test_results(run_id), test_results(model_id)
```

`models` keeps the benchmark blob and its 20-entry history as JSON on purpose: the
renderer's catalogue shape is preserved exactly in A. Normalising benchmarks into
`benchmark_runs` / `benchmark_items` belongs to B/C, where the log pages query them.
`model_keys.key_id` has no foreign key: `forgetKey` already cleans it, and keys are
deleted in a different transaction.

## 2. JSON import (one shot)

Runs in main after the DB opens and before the window is created, only when
`meta.imported_from_json_at` is absent and at least one legacy file exists.

1. Read each file with up to 3 attempts, 200 ms apart (covers transient EBUSY/EPERM).
2. `config.json` must parse to an object. If it cannot be read or parsed: nothing is
   written, a dialog names the file and the error ("Nothing was changed. Fix or move
   the file, then start VENOM Router again."), and the app quits.
3. `history.json` or `catalog.json` that cannot be read or parsed: import continues
   without it; the file is renamed `<name>.unreadable.json` and a warning dialog lists
   it after the window opens.
4. Everything is inserted in **one transaction**: providers and keys (ciphertext copied
   verbatim, no decrypt/re-encrypt; a plaintext legacy key is encrypted on the way in),
   `settings` / `test` / `window`, `aaApiKey` → `secrets` (encrypted), catalogue rows,
   history runs (a ULID per run, in file order).
5. `meta.imported_from_json_at` is set in the same transaction.
6. After commit, each imported file is renamed `<name>.imported.json`. Nothing is
   deleted. `requests.log` is left alone (sub-project B).

If the transaction fails, nothing is committed, the JSON files stay as they are, and
the dialog in step 2 is shown.

## 3. Keys stay in main

### What the renderer sees

`read-config` returns the same shape as today, except each key is
`{ id, name, key: 'venomkey:<id>', hint, active, quotaSpent, locked }`:

- `key` is a placeholder, never the secret.
- `hint` is the masked display string (the current `maskKey` output), computed in main.
- `locked: true` and `key: ''` when the ciphertext cannot be decrypted on this machine
  (today's behaviour).

The Artificial Analysis key is exposed as `settings.aaApiKey = 'venomsecret:aaApiKey'`
when set, `''` otherwise.

### Resolution in `api-request`

Before sending, main replaces every `venomkey:<id>` / `venomsecret:<name>` token found in
header values, the URL and a string body with the decrypted secret, **only if the
request's origin is allowed for that secret**:

- a provider key: the origin of its provider's `base_url`;
- `aaApiKey`: `https://artificialanalysis.ai`.

Otherwise the request is refused with `Key blocked: <host> is not this key's provider`.
A renderer compromised by injected script therefore cannot send a key elsewhere.
Decrypted secrets are cached in memory for the session and dropped when a key is
changed or deleted. `requests.log` records the request **before** substitution, so it
only ever holds placeholders.

### Writes and other key uses

- Adding a key: the renderer already holds the text the user typed; it may probe with it
  before saving (unchanged). `save-provider` accepts `key` in plaintext only for new or
  replaced keys; main encrypts it and returns the placeholder.
- Copying a key: new IPC `copy-key(keyId)`; main writes the secret to the clipboard.
- Provider modules are unchanged: they treat `apiKey` as an opaque string.

## 4. Saves, races and failures

### IPC surface (replaces whole-blob writes)

| New | Replaces | Behaviour |
|---|---|---|
| `save-settings(settings)` | settings part of `write-config` | upsert row `settings`; `aaApiKey` handled via secrets |
| `save-secret(name, value)` | — | encrypt + upsert, or delete on `''` |
| `save-test-definition(test)` | test part of `write-config` | upsert row `test` |
| `save-provider(provider)` | provider part of `write-config` | upsert provider, replace its key rows in one transaction; returns the provider as `read-config` would |
| `delete-provider(id)` | — | cascade |
| `copy-key(keyId)` | clipboard in renderer | main writes clipboard |
| `write-catalog(catalog)` | same name | kept for the renderer; main diffs against the DB and writes only changed rows in one transaction |
| `append-run(run)` | same name | inserts run + results, trims to `historyMaxRuns` (max 5000); returns `{ id, runUid }` |
| `read-config`, `read-catalog`, `read-history`, `clear-history` | same names | read from the DB; same shapes as today (runs gain `id`) |

`write-config` is removed. `saveWindowState` writes only the `window` row.
Built-in providers missing from the DB are seeded by the renderer with `save-provider`,
one provider at a time, so seeding can never overwrite another provider.

### Failures are loud

- IPC handlers throw on DB errors; the renderer shows a toast ("Couldn't save settings:
  …") and logs it. No read error is ever turned into an empty store.
- If `read-config` fails at startup, the renderer shows an error state and does not seed
  or write anything.

### Nothing pending is lost

- On `before-quit` (and before `quitAndInstall`), main asks the renderer to flush pending
  debounced saves (settings, test definition, catalogue), waits for the reply up to 2 s,
  then quits.
- The renderer caps its in-memory run history at `historyMaxRuns`, matching disk.

## 5. Build, packaging and tests

- Dependency: `better-sqlite3` (runtime). electron-builder rebuilds native modules for
  Electron and unpacks `.node` files from the asar by default; the build config is
  checked for that.
- A `postinstall` of `electron-builder install-app-deps` keeps the dev copy built for
  Electron's ABI.
- Tests run inside Electron's Node (`ELECTRON_RUN_AS_NODE=1`), because the native module
  is built for Electron, via `scripts/run-tests.js` (`npm test`). They cover migrations,
  every repo, the importer (happy path, unreadable config, unreadable catalogue/history,
  plaintext legacy key, idempotency), placeholder resolution and origin checks — against
  in-memory or temp-dir databases.
- The release script gains a smoke step on the packaged app: open the DB, write, read.
- Live check: the app runs over CDP on a scratch copy of the owner's data
  (`--user-data-dir`). Before/after counts must match: providers, keys per provider,
  models, runs, results, uptime of a sample of models, settings values.

## 6. Future server (not built)

Nothing auth-related enters the desktop DB. What A does to keep the door open:
`meta.install_id`, ULID `run_uid` on runs, integer epoch-ms timestamps, integer-only
money later (micro-USD in B), and repositories that can be pointed at another store.
The future server's tables (users, sessions, api_keys hashed, subscriptions, ledger)
are listed in research 01 and 02.

## Out of scope for A

Request logging, the log DB, log pages, benchmark normalisation, granular catalogue
IPC, an Electron upgrade, and anything on the future website.
