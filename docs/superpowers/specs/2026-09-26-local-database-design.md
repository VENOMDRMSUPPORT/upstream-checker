# Local database (sub-project A) — design

Date: 2026-09-26
Status: approved with required changes by the delegated spec reviewer; changes applied (rev 2)
Research: `docs/superpowers/research/2026-09-26-new-api/` (02 data model, 06 current persistence, 07 verification)

## Context and goal

Phase 2 of VENOM Router gives the local desktop admin app a database and a logging
system. It is split into three sub-projects, each with its own spec and plan:

- **A — local database** (this spec): replace `config.json`, `catalog.json` and
  `history.json` with SQLite, keep API keys in the main process, and remove the
  data-loss paths the audit found.
- **B — logging system**: `venom-logs.db`, `request_logs` with benchmark-grade
  columns, batched writer, hourly roll-ups, retention (90 days raw, 12 months
  roll-ups), failed-request bodies kept 7 days.
- **C — log pages**: Request Log (in the "Test History" slot), Runs, Monitoring.

A hosted website that sells subscriptions to venom-lite / pro / max comes later and is
not built now. This spec only avoids choices that would block it (see "Future server").

### Problems A must fix (verified in 07-verification.md)

1. Any failed read of `config.json` (corrupt JSON, EBUSY/EPERM from antivirus or
   OneDrive, a 0-byte file after power loss) is treated as an empty config; the renderer
   then seeds providers and writes, destroying every key. `saveWindowState` on window
   close is a second path that writes the defaults back. Failed catalogue, settings,
   test-definition and history reads are likewise turned into empty stores that a later
   save writes over real data.
2. Read-modify-write across two IPC calls loses concurrent updates.
3. Whole-file rewrites: the ~300 KB catalogue on every sync; `history.json` on every run.
4. Write failures are silent; pending debounced saves are dropped on close and on update
   install; no single-instance lock; no fsync.
5. Keys are decrypted on every read and handed to the renderer in plaintext.
   `settings.aaApiKey` is stored unencrypted.
6. Runs have no id; in-memory history grows without bound during a session.

## Decisions (made with the owner)

| Topic | Decision |
|---|---|
| Engine | `better-sqlite3`, pinned `~12.11` (see §6), main process only |
| Keys | Stay in main. The renderer gets a placeholder and a display hint |
| Bodies / retention | Sub-project B (failed only, 7 days; 90 days raw, 12 months roll-ups) |
| Downgrade | An older build run after the upgrade starts empty. Accepted |

## 1. Database layer

### Files and settings

- `venom.db` in the app data folder (`app.getPath('userData')`, resolved by
  `src/user-data.js`).
- Opened once in main inside `app.whenReady()` (safeStorage and dialogs need it), before
  the window is created. Pragmas on open: `journal_mode=WAL`, `synchronous=NORMAL`,
  `foreign_keys=ON`, `busy_timeout=5000`, `temp_store=MEMORY`. WAL with
  `synchronous=NORMAL` can lose the last commits on power loss but does not corrupt the
  file.
- Closed in `will-quit`.

### Single instance

`app.requestSingleInstanceLock()` is called right after `app.setPath('userData')` and
before the DB opens (the lock is per userData folder). A second instance calls
`app.quit()` and returns; the first handles `second-instance` by restoring and focusing
its window.

### Open failures

If opening, a pragma or `migrate()` throws (corrupt file, locked file, disk full): a
dialog names the file and the error, then the app quits. No new file is created, no
import runs, nothing is renamed.

If `venom.db` is missing but `*.imported.json` files exist (the DB was deleted or moved),
the app does not start empty silently: a dialog offers "Re-import from the saved files"
or "Start empty". Re-import runs §2 on the `*.imported.json` files and leaves them where
they are (no second rename).

### Code layout

```
src/db/index.js           open(dir, cipher), pragmas, migrate(), backup, close()
src/db/migrations.js      ordered list of { version, up(db) } — SQL strings inside JS
src/db/cipher.js          electron-backed cipher { available(), encrypt(s), decrypt(s) }
src/db/repos/settings.js  settings rows (settings, test, window)
src/db/repos/secrets.js   encrypted named secrets (aaApiKey)
src/db/repos/providers.js providers + provider_keys, merge
src/db/repos/catalog.js   models, model_keys, provider_sync, key_model_counts, catalog_meta
src/db/repos/history.js   test_runs + test_results
src/db/import-json.js     one-shot importer from the legacy JSON files
src/db/keys.js            placeholder ↔ secret resolution for api-request
```

`src/db/*` never `require('electron')` at load time. Everything that encrypts or
decrypts takes an injected cipher `{ available(), encrypt(text), decrypt(text) }`;
`src/db/cipher.js` builds the real one from `safeStorage` and the existing `enc:v1:`
envelope in `src/keystore.js`. Tests inject a fake cipher. Migrations live in a JS module
so electron-builder's `files: ["src/**/*"]` bundles them.

### Migrations

- `PRAGMA user_version` holds the schema version. Each pending migration runs in its own
  transaction and bumps the version.
- **Backup before migrating** an existing, non-empty DB: `db.backup()` to
  `venom.db.bak-v<from>`; keep the last 3.
- **Downgrade guard**: if `user_version` is higher than the app knows, a dialog ("This
  data was written by a newer VENOM Router. Update the app to open it.") and quit without
  writing.

### Schema v1

Conventions: timestamps are integer epoch ms; booleans are 0/1 integers; JSON columns are
`TEXT` named `*_json`; no reserved-word column names. Foreign keys are declared only where
listed below; catalogue and history rows deliberately reference provider and key ids
**without** foreign keys, because they keep rows for deleted providers and keys (today's
behaviour).

```
meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)
  -- install_id (random UUID), imported_from_json_at (epoch ms, or 'none' on a fresh
  -- install with no legacy files), app_version

settings(key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL)
  -- rows: 'settings' (every field except aaApiKey, including legacy mediaPrompt),
  --       'test', 'window'

secrets(name TEXT PRIMARY KEY, cipher TEXT NOT NULL, updated_at INTEGER NOT NULL)
  -- 'aaApiKey'; cipher uses the enc:v1: envelope

providers(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
  rpm INTEGER, is_custom INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)

provider_keys(                                  -- FK: provider_id → providers ON DELETE CASCADE
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  name TEXT NOT NULL, cipher TEXT NOT NULL,     -- always enc:v1:…; never plaintext, never ''
  active INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0,
  quota_spent_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)
  INDEX provider_keys(provider_id, position)

models(                                         -- no FK to providers
  provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
  name TEXT, kind TEXT, first_seen INTEGER, last_seen INTEGER, removed_at INTEGER,
  is_new INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT, bench_json TEXT, history_json TEXT, bench_error TEXT,
  caps_json TEXT, caps_error TEXT, updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider_id, model_id))
  INDEX models(provider_id, removed_at)

model_keys(provider_id TEXT NOT NULL, model_id TEXT NOT NULL, key_id TEXT NOT NULL,
  PRIMARY KEY (provider_id, model_id, key_id),
  FOREIGN KEY (provider_id, model_id) REFERENCES models ON DELETE CASCADE)   -- no FK on key_id

provider_sync(provider_id TEXT PRIMARY KEY, last_sync_at INTEGER NOT NULL)   -- no FK
key_model_counts(key_id TEXT PRIMARY KEY, count INTEGER NOT NULL, at INTEGER NOT NULL)  -- no FK
catalog_meta(key TEXT PRIMARY KEY, value_json TEXT NOT NULL)
  -- 'leaderboard', 'leaderboardError', 'profiles'

test_runs(                                      -- no FK to providers
  id INTEGER PRIMARY KEY, run_uid TEXT NOT NULL UNIQUE,   -- ULID, for future sync
  at INTEGER NOT NULL, provider_id TEXT NOT NULL, provider_name TEXT NOT NULL,
  prompt TEXT NOT NULL)
  INDEX test_runs(at), test_runs(provider_id, id)

test_results(                                   -- FK: run_id → test_runs ON DELETE CASCADE
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL, status TEXT NOT NULL, time_ms INTEGER, tokens INTEGER,
  completion_tokens INTEGER, attempts INTEGER NOT NULL DEFAULT 1, correct INTEGER)
  INDEX test_results(run_id), test_results(model_id)
```

No `hint` column: a masked key still contains plaintext characters, and nothing
plaintext is stored today.

### Catalogue entry ↔ row mapping

A renderer catalogue entry `models['<providerId>::<modelId>']` maps as follows; `key` is
derived on read as `providerId + '::' + id`.

| Entry field | Column |
|---|---|
| `providerId`, `id` | `provider_id`, `model_id` |
| `name`, `kind`, `firstSeen`, `lastSeen`, `removedAt`, `isNew` | `name`, `kind`, `first_seen`, `last_seen`, `removed_at`, `is_new` |
| `pricing`, `declaresTools`, `maxOutput`, `hasVision`, `hasReasoning`, `isFree`, `isFreeForPaid`, `contextLabel`, `contextWindow`, `ownedBy` | `summary_json` (object with exactly these keys) |
| `bench` | `bench_json` |
| `history` (last 20 benches) | `history_json` |
| `benchError` | `bench_error` |
| `caps`, `capsError` | `caps_json`, `caps_error` |
| `keyIds` | rows in `model_keys` |
| top-level `lastSync[pid]` | `provider_sync` |
| top-level `keyModels[kid]` | `key_model_counts` |
| top-level `leaderboard`, `leaderboardError`, `profiles` | `catalog_meta` rows |

Unknown extra fields on an entry are preserved in `summary_json` under `extra`, so a
round trip never drops data. `models` keeps the benchmark blob as JSON on purpose;
normalising benchmarks belongs to B/C.

## 2. JSON import (one shot)

Runs in main after the DB opens and before the window is created, when
`meta.imported_from_json_at` is absent. On a fresh DB with no legacy files, it sets
`imported_from_json_at = 'none'`, so a `config.json` that appears later is never imported
into a DB that already has seeded providers.

1. **Read** each file with up to 3 attempts, 200 ms apart.
   - An I/O error (EBUSY, EPERM…) that survives the retries on **any** file aborts the
     whole import: nothing is written, the dialog explains the file is in use, the app
     quits, and the import runs again next launch.
   - A **parse** failure of `config.json` (or a non-object) aborts the same way.
   - A parse failure of `history.json` or `catalog.json`: the import continues without
     it, the file is renamed `<name>.unreadable.json` after commit, and a warning dialog
     lists it once the window is open.
2. **Normalise** legacy rows:
   - runs missing `prompt` → `''`; missing `providerName` → the provider id;
   - a key without an id → `key_<ms>`; a duplicate key id → re-assigned and logged;
   - malformed catalogue entries and history runs/results are skipped and counted; the
     warning dialog reports the counts;
   - `settings` is imported verbatim minus `aaApiKey` (so `mediaPrompt` and unknown
     fields survive).
3. **Providers and keys**: ciphertext (`enc:v1:…`) is copied verbatim; nothing is
   decrypted. A plaintext legacy key is encrypted on the way in; if safeStorage is not
   available, the import aborts with the dialog (plaintext is never stored). Legacy
   custom providers are imported with `is_custom = 1` exactly as stored. A provider or
   key row that cannot be written aborts the import.
4. `aaApiKey`: if already `enc:v1:` it is copied, otherwise encrypted, into `secrets`.
5. Everything is written in **one transaction**, which also sets
   `meta.imported_from_json_at`.
6. After commit, each imported file is renamed `<name>.imported.json` (or
   `<name>.imported-<ms>.json` if that name exists, because rename overwrites on
   Windows). A failed rename is logged and not fatal. Nothing is deleted.
   `requests.log` is left alone (sub-project B).

If the transaction fails, nothing is committed, the JSON files stay as they are, and the
dialog is shown.

## 3. Keys stay in main

### What the renderer sees

`read-config` returns today's shape, except each key is
`{ id, name, key: 'venomkey:<id>', hint, active, quotaSpent, locked }`:

- `key` is a placeholder, never the secret.
- `hint` is today's `maskKey` output, computed in main from the decrypted value at read
  time and never stored. `hint = ''` and `key = ''` when the key is locked (its
  ciphertext does not decrypt on this machine).

`settings.aaApiKey` is `'venomsecret:aaApiKey'` when set and `''` otherwise.

### Resolution in `api-request`

Before sending, main replaces every `venomkey:<id>` / `venomsecret:<name>` token in header
values, the URL and a string body with the decrypted secret, only if the request's
origin is allowed for that secret:

- a provider key: the origin of its provider's `base_url`;
- `aaApiKey`: `https://artificialanalysis.ai`.

Rules:

- Token ids match the longest valid id (`venomkey:key_12` never resolves as `key_1`).
- Inside a string body that parses as JSON, the secret is inserted JSON-escaped.
- A refusal never rejects the IPC promise: it resolves `{ status: 0, blocked: true,
  error: 'Key blocked: <host> is not this key's provider' }` and is logged.
- `requests.log` records the request before substitution, so it only holds placeholders.
- Decrypted secrets are cached in memory for the session and dropped when a key is
  replaced or deleted.

This is defence in depth: it stops a key from reaching the wrong host by mistake or
through an injected URL. It is not a boundary against a fully compromised renderer, which
could repoint `base_url` through `save-provider` or read the clipboard after `copy-key`.

### Renderer changes this requires

- `maskKey(k.key)` → `k.hint` at `app.js:1047`, `app.js:5117`, `key-usage.js:471`.
- Both clipboard sites (`app.js:1103`, `app.js:5607`) → `copy-key(keyId)`.
- The custom → built-in merge (`app.js:621-646`) → `merge-provider(fromId, intoId)`.
- The Artificial Analysis key input (`catalog.js:1076`, `1111`, `1114`) never shows the
  token: it is empty with a "Saved" indicator; saving an empty or unchanged field is a
  no-op; new text goes through `save-secret('aaApiKey', text)`, after which the renderer
  sets `settings.aaApiKey` to the placeholder. A "Remove" control next to the indicator
  calls `save-secret('aaApiKey', '')`.
- "Reset settings" (`app.js:4057`) does not delete the secret.
- After `save-provider`, the renderer swaps each key object for the returned one in
  place (the Connect flow reuses the object from `storeKey`, `app.js:1134`,
  `3505-3516`), so no plaintext stays in memory.
- Provider modules are unchanged: they treat `apiKey` as an opaque string. Mirai's
  session maps keep working because a placeholder is stable per key.

## 4. Saves, races and failures

### IPC surface

| Channel | Replaces | Behaviour |
|---|---|---|
| `save-settings(settings)` | settings part of `write-config` | upsert row `settings`; `aaApiKey` is stripped and ignored |
| `save-secret(name, value)` | — | encrypt + upsert; `''` deletes |
| `save-test-definition(test)` | test part of `write-config` | upsert row `test` |
| `save-provider(provider)` | provider part of `write-config` | see below; returns the provider as `read-config` would |
| `merge-provider(fromId, intoId)` | array edits in `app.js:621-646` | one transaction: move key rows, dedupe by decrypted value (by ciphertext for locked keys), delete the source provider |
| `delete-provider(id)` | — | cascade |
| `copy-key(keyId)` | clipboard in renderer | main writes the clipboard |
| `write-catalog(catalog, opts)` | same name | main diffs against in-memory row hashes and writes only changed rows, one transaction; refuses to empty a non-empty model set unless `opts.reset === true` |
| `append-run(run)` | same name | insert run + results, trim to `historyMaxRuns` (max 5000); returns `{ id, runUid }` |
| `read-config`, `read-catalog`, `read-history`, `clear-history` | same names | read from the DB; same shapes as today; runs gain `id` |
| `flush-pending` (main → renderer), `flush-done` (renderer → main) | — | close handshake below |

`write-config` is removed. Only the Clear and Reset buttons (`catalog.js:1127-1142`) send
`write-catalog` with `{ reset: true }`.

**`save-provider` key semantics** (upsert by id):

- `key` equal to `venomkey:<same id>`, or `''`, on an existing row → keep the stored
  cipher (never write `''`, never delete because of it);
- any other string → encrypt it as the new or replacement secret;
- key ids present in the DB but missing from the payload → delete the row and drop its
  cached secret;
- a `venomkey:` placeholder whose id belongs to another provider → the call fails;
- `created_at` is preserved; `position` follows payload order.

Built-in providers missing from the DB are seeded by the renderer with `save-provider`,
one at a time, so seeding never touches another provider.

### Failures are loud

- IPC handlers throw on DB errors; the renderer shows a toast ("Couldn't save settings:
  …") and logs it.
- **Startup read gate**: if `read-config`, `read-catalog` or `read-history` fails at
  startup, the renderer shows an error state and a global gate blocks every write
  (`save-*`, `merge-provider`, `delete-provider`, `write-catalog`, `append-run`).
  `loadSettings`, `loadTestDefinition`, `loadHistory` and catalogue `load()` no longer
  substitute defaults or an empty store on error.

### Nothing pending is lost

- **Window close** (the X button, Alt+F4, the title-bar close): the first `close` event
  calls `preventDefault()`, sends `flush-pending`, waits for `flush-done` up to 2 s,
  writes the `window` row, then `destroy()`s the window.
- **Install update**: `install-update` runs the same flush before `quitAndInstall`
  (electron-updater launches the installer before quitting, so the flush must finish
  first).
- The renderer caps its in-memory run history at `historyMaxRuns`, matching disk.

## 5. Verification

- **Unit tests** (in-memory or temp-dir DBs, fake cipher): migrations and the downgrade
  guard; pragmas and WAL on a temp file (`:memory:` reports `memory`); every repo;
  `save-provider` key semantics; `merge-provider`; catalogue deep-equal round trip on a
  fixture; history trim; the importer (happy path, config I/O error, config parse error,
  unreadable catalogue/history, malformed rows skipped and counted, plaintext legacy key,
  safeStorage unavailable, legacy custom provider, `mediaPrompt` kept, idempotency,
  rename collision); placeholder resolution (headers, URL, JSON body escaping,
  longest-id match, origin refusal).
- **Live check by agents**: a **synthetic fixture** userData (plaintext, `enc:v1:`,
  locked and legacy-custom keys, fake provider URLs) drives the app over CDP. The owner's
  real data is never copied, so the app's timers cannot send live requests with real keys.
- **Owner-run check**: a script the owner runs on their own data (read-only, networking
  off, no decryption) compares counts before and after import: providers, keys per
  provider, models, runs, results, settings values.
- Review subagents after each task group, and a final whole-branch review.

## 6. Build and packaging

- `better-sqlite3@~12.11`: the 12.10–12.11 releases ship `electron-v130-win32-x64`
  prebuilds (Electron 33 = Node 20.18, ABI 130); 13.x requires Node ≥ 22 and would fall
  back to a source build. Any Electron upgrade means re-checking prebuilds.
- `postinstall`: `electron-builder install-app-deps`, so the dev copy matches Electron's
  ABI.
- electron-builder unpacks `.node` files from the asar by default; the packaged build is
  checked for `app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node`.
- **Tests** run under Electron's Node: `scripts/run-tests.js` lists `test/**/*.test.js`
  itself (Node 20 has no globs in `--test`) and spawns `electron --test <files>` with
  `ELECTRON_RUN_AS_NODE=1`. `npm test` runs it.
- **Release smoke**: `scripts/release.mjs` builds with `--publish never`, runs the
  packaged app with `--smoke-test --user-data-dir=<temp>` (open DB, write, read, exit
  code 0), and only then publishes.

## 7. Future server (not built)

Nothing auth-related enters the desktop DB. What A does to keep the door open:
`meta.install_id`, ULID `run_uid` on runs, integer epoch-ms timestamps, integer-only money
later (micro-USD in B), and repositories that can be pointed at another store. The future
server's tables (users, sessions, hashed api_keys, subscriptions, ledger) are listed in
research 01 and 02.

## Plan phases

The plan is ordered into testable phases:

1. DB layer, importer, the new IPC surface and the startup read gate, with
   `read-config` still returning plaintext keys.
2. Keys in main (§3).
3. Close flush and the single-instance lock.
4. Packaging and the release smoke step.

Phases are not released on their own; the branch ships when all four are done.

## Out of scope for A

Request logging, the log DB, log pages, benchmark normalisation, granular catalogue IPC,
an Electron upgrade, and anything on the future website.
