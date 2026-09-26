# Logging System (Sub-project B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every outbound request the desktop app makes in a local log database (`venom-logs.db`) with benchmark-grade timings, tokens, cost, hourly roll-ups with an approximate p95, captured bodies, retention and a query API that the log pages (sub-project C) will read.

**Architecture:** A new `src/logs/` layer (better-sqlite3, its own connection, synchronous, main process only): pure `classify.js` / `scrub.js`, a batched `writer.js` that inserts rows, bodies and hourly roll-ups in one transaction, chunked `retention.js`, `query.js` and `ipc.js`. `api-request` moves into `src/api-request.js` as a finish-once requester: every request ends through one `finish()`, which resolves the renderer's promise first and only then, in `setImmediate`, hands a `done` object to `src/logs/recorder.js`. `resolve()` in `src/db/keys.js` now also reports which keys it substituted (refs) and the placeholder → secret pairs (substitutions, in memory only, used to scrub stored text). The renderer tags every call with `source` / `runId` / `attempt` / `hedgeIndex` / `testGroup` / `trigger` / `paramSwap` and gives each cancel a reason.

**Tech Stack:** Electron 33 (Node 20.18), better-sqlite3 `~12.11.1` (already a dependency), plain-JS renderer (no bundler), `node:test` run under Electron's Node by `scripts/run-tests.js`, CDP live checks driven by Node 24's `fetch`/`WebSocket` (`scripts/live/*.mjs`).

**Spec:** `docs/superpowers/specs/2026-09-26-logging-system-design.md` (rev 2, approved). Research: `docs/superpowers/research/2026-09-26-new-api/03-logs.md`.

**Execution notes:**
- Work only in the worktree `C:\Users\venom\Desktop\venom-router-logging` (Git Bash: `/c/Users/venom/Desktop/venom-router-logging`), branch `feat/logging-system` (already checked out). Every command below runs from that folder. Never read, write or run anything in `C:\Users\venom\Desktop\UPSTREAM CHECKER` (the owner's checkout on `main`), never run npm from any other folder, never open `%APPDATA%`.
- One commit per task. Never push. A dedicated reviewer after each task, and a whole-branch review at the end. This branch merges to `main` together with sub-project C, never alone.
- The suite is 133/133 before Task 1. Each task states the new total.
- Any live launch uses a scratch `--user-data-dir` under `%TEMP%` (`scripts/live/cdp.mjs` refuses anything inside `%APPDATA%`). Kill only processes you started. Never send keyboard shortcuts to the owner's windows.
- Use the Edit tool for every edit to an existing file (scripted `String.replace` eats `$$`; unquoted heredocs eat backslashes).

## Global Constraints

- Release: built on `feat/logging-system` in the separate worktree; merged to `main` together with C, never alone. The owner's checkout stays on `main`.
- File `venom-logs.db` next to `venom.db` in the app data folder, opened in main by the same `better-sqlite3` dependency, on its own connection.
- Pragmas: `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `temp_store=MEMORY`; `auto_vacuum=INCREMENTAL` set when the file is created, before the first table.
- Own `PRAGMA user_version` and migration list, one transaction per migration; the version is read before any other pragma, so a newer schema is never written. No backup before log migrations.
- `startLogs()` runs in its own try/catch, after `startDatabase()` succeeds and before `registerDataIpc` / `createWindow`. On failure: logging off for the session, error to electron-log, `logs-info` returns `{ enabled: false, error }`, the renderer shows one status warning "Request logging is off: …". The app never quits because of the log DB.
- `--smoke-test` also opens the log DB in its scratch folder and writes and reads one row.
- `will-quit` order: stop the purge timer → stop the flush timer → flush the queue synchronously → close the log DB → close `venom.db`. The startup-failure path closes the log DB too.
- The dropped-rows counter is kept in memory and mirrored to `meta` when a write succeeds.
- Conventions: integer epoch-ms timestamps, 0/1 booleans, `*_json` TEXT columns, money as integer micro-USD, no foreign keys.
- `meta_json` keys allowed: `requestId`, `timeoutMs`, `cancelReason`, `trigger` (`manual` | `scheduled`), `hedgeIndex`, `testGroup`, `paramSwap`. Nothing else; never headers.
- Sources: `route_test`, `benchmark`, `health`, `key_check`, `key_usage`, `discovery`, `pricing`, `leaderboard`, `other`; unknown or missing → `other`.
- Cancel reasons `hedge_lost` | `stop` | `deadline`. `deadline` → `status = timeout`, `error_class = timeout`; `stop` and `hedge_lost` → `cancelled`. The reason goes into `meta_json.cancelReason`.
- `status`: `ok | error | timeout | cancelled | blocked`. `error_class`: `auth | rate_limit | quota | bad_request | server | network | timeout | blocked | other`.
- `substitutions` (placeholder → secret) stay in memory only: never in the record, `meta_json`, electron-log or any IPC reply. Scrubbing replaces raw, JSON-escaped, `\/`-escaped and `encodeURIComponent` forms, longest first, in stored text only.
- Bodies: `settings.logLevel` (`off` = Off, `errors` = Failed only, `all` = All). Main reads it from the settings row, caches it, refreshes on `save-settings`; the per-request `logLevel` parameter is removed. New install (row without `logLevel`, or no row) → `'errors'`; a stored value is never changed. "Failed" = any status other than `ok` and `cancelled`. Request body = the unresolved one; headers redacted (`authorization`, `x-api-key`, `api-key`, `cookie`); response scrubbed; each clipped to 8 KB, `truncated = 1` when clipped.
- Writer: `add()` never blocks or throws into `api-request`; flush every 250 ms or at once at 500 records, in one transaction (rows, bodies, roll-ups). A failed flush drops that batch, counts it, logs to electron-log at most once a minute. Queue cap 10 000; beyond it the oldest are dropped and counted.
- `requests.log` is not written (`appendRequestLog` removed). `read-log-info`, `open-request-log`, `clear-request-log` keep working on the old file.
- Retention (settings row, UI in C): `logRetentionDays` 90, `bodyRetentionDays` 7, `statsRetentionMonths` 12. Purge 30 s after startup, then every 24 h, deferred while requests are in flight; chunks of 1 000 via a fresh short query per chunk, yielding between chunks; then `PRAGMA incremental_vacuum(2000)` in steps and `wal_checkpoint(TRUNCATE)`; `meta.last_purge_at`.
- Parsing: JSON responses parsed whole only up to 1 MB; larger bodies and all SSE streams scanned from their ends.
- Query API: read-only except export and clear; errors propagate; when logging is off, reads return empty results; filter arrays capped at 50; `text` escapes `%` and `_`; `limit` ≤ 200.
- `src/logs/*` never requires electron at load. Tests: `node:test`, `npm test` from the worktree root (Electron's Node via `scripts/run-tests.js`).
- The owner's workflow does not change beyond the spec: no new npm scripts, no new launch flags, no new settings UI beyond the "Request bodies" relabel and the Diagnostics & Logs copy.
- Code style: CommonJS in main-side code, plain browser scripts in `src/renderer` (top-level functions are globals shared across files), ESM only under `scripts/live/`. Comments explain why. Everything on disk is English.

## Review Focus

1. **Logging slowing or breaking a request** (a recorder bug, or a 5 MB streamed reply to classify): the renderer's reply arrives unchanged and before any logging work runs; a 5 MB stream is classified from its ends in under 250 ms. Tests: Task 12 `a recorder that throws never touches the reply, and runs only after it`; Task 2 `a 5 MB stream is read from its ends in under 250 ms`.
2. **A cancel racing the end** (Stop pressed as a reply lands, a second cancel, a cancel for an id that already finished or never existed): exactly one record, the first ending wins, nothing throws. Test: Task 12 `a cancel after the end, a second cancel and an unknown id change nothing` (and the second-cancel assertion in `a mid-stream cancel resolves as cancelled and reports once with the reason`).
3. **A secret stored through an echo the scrubber must still catch** (a provider echoing the key JSON-escaped, `\/`-escaped or URL-encoded, inside the error code or the model field, or one key containing another): no form of any substituted secret in any queued row or body. Test: Task 11 `no form of a substituted secret reaches a queued record`.
4. **The log DB failing mid-session** (disk full, file locked): batches dropped and counted, electron-log warned at most once a minute, `add()` never throws, a failed batch leaves no roll-up behind, and the count reaches `meta` once writes recover. Test: Task 4 `a failing database drops batches, warns once a minute, and the count reaches meta once writes recover`.
5. **Purge against the UI and quitting** (a large first purge, requests in flight, the app quitting mid-purge): other work runs between chunks, the purge waits while requests are in flight, and closing the DB mid-purge ends it quietly. Tests: Task 5 `purge lets other work run between chunks`, `closing the database mid-purge ends it without throwing`, `scheduler: defers while requests are in flight`.

## Spec rulings made while planning

1. `api-request` moves to `src/api-request.js` (no electron) so its finish-once guarantees can be integration-tested against a local HTTP server; `main.js` only wires it.
2. Files beyond the spec's layout, each with one job: `src/logs/settings.js` (`readLogSettings`), `src/logs/lookups.js` (price book and provider lookup on `venom.db`), `src/logs/recorder.js` (builds the record in `setImmediate`).
3. `open()` returns `{ db, file, migration, writer, repos: { meta, query }, close }`. `close()` stops the flush timer, flushes, checkpoints and closes; the purge scheduler lives in main and is stopped first (`stopLogs()`).
4. On refusal `resolve()` returns only the refused ref, so `key_id` names it. Refs dedupe by kind + id; substitutions dedupe by placeholder. Placeholder text = `venomkey:<id>` / `venomsecret:<name>` as matched.
5. The quota codes (`insufficient_quota`, `quota_exceeded`, `billing_hard_limit_reached`) are checked for every non-2xx status before the status table, so a 401 or 429 carrying one is `quota`.
6. A URL that cannot be parsed, or a request Node refuses to build (bad header), now resolves `{ status: 0, networkError: true, error }` instead of rejecting the IPC call; recorded as `error` / `network`.
7. A connection dropped mid-stream replies `{ status: 0, networkError: true, error: 'The connection closed before the response ended' }` (the renderer already retries network errors); recorded `error` / `network` with the HTTP status it had.
8. Every cancel reaches the renderer as today's `{ cancelled: true }` reply whatever the reason; only the record differs.
9. The purge's "requests in flight" counts every in-flight request, including those without a `requestId`.
10. 8 KB = 8192 UTF-16 code units (JavaScript string length).
11. p95 in the top bucket comes back as `p95LatencyMs: 120000, p95Overflow: true`; C renders "≥120000".
12. `error_code` comes only from the provider body (`error.code || error.type`); network failures leave it NULL.
13. Source `pricing` = a provider module's own `pricingUrl` / `plansUrl` pages (Nara, Experiential); everything else a module's `fetchModels` sends is `discovery`. Capability probes are `benchmark` without a run id. `trigger` is set on Route Test only.
14. `history.read()` also returns each run's `runUid` (the live check compares it with the log rows; the renderer ignores the field).
15. CSV cells that start with `=`, `+`, `-`, `@`, tab or CR get a leading apostrophe (provider error text opened in a spreadsheet).
16. `logs-list` rows are the raw `request_logs` rows (snake_case columns; `meta_json` and `price_json` as stored JSON text); `logs-get` adds `body` (or `null`). The cursor is `{ createdAt, id }`.
17. `dropped_rows` is cumulative across sessions: the writer starts from the value in `meta`.
18. A stored `logLevel` that is not `off` / `errors` / `all` reads as `errors` in main and is not written back.
19. Export is async and yields between 1 000-row chunks.
20. `logs-stats` with `groupBy = error_class` returns series entries `{ bucket, group: <class>, count }` for the nine classes (`timeout` and `blocked` from their own counters).
21. A release note goes into `CHANGELOG.md` under `[Unreleased]` (Task 18), for the release that ships B with C.

## File map

| File | Responsibility |
|---|---|
| `src/logs/migrations.js` | Schema v1 of `venom-logs.db` |
| `src/logs/settings.js` | `readLogSettings(row)`: body setting and retention limits with defaults |
| `src/logs/classify.js` | Pure: endpoint, model, stream flag, usage, cost, status/class, error text, latency buckets, p95 |
| `src/logs/scrub.js` | Pure: substituted secrets → placeholders in stored text |
| `src/logs/writer.js` | Batched writer, roll-up upserts, dropped counter |
| `src/logs/retention.js` | Chunked purge, stepped incremental vacuum, purge scheduler |
| `src/logs/query.js` | `createMeta`, list/get/stats/facets/runSummary/exportTo/info/clear |
| `src/logs/index.js` | `open`, `tryOpen`, pragmas, migrate, close |
| `src/logs/ipc.js` | The eight `logs-*` IPC channels |
| `src/logs/lookups.js` | Price book and provider lookup on `venom.db` |
| `src/logs/recorder.js` | `buildRecord(done)` → row + body; `createRecorder` |
| `src/api-request.js` | Finish-once requester (`request`, `cancel`, `inFlight`) |
| `src/db/keys.js` | `resolve()` also returns `refs` and `substitutions` |
| `src/db/repos/history.js`, `src/db/index.js` | Provided `runUid`; `read()` returns `runUid` |
| `src/db/ipc.js` | `hooks.onSettingsSaved`, `hooks.onCatalogWritten` |
| `src/main.js`, `src/preload.js` | Wiring: requester, `startLogs`/`stopLogs`, logs IPC, smoke test, cancel reasons |
| `src/renderer/ulid.js`, `index.html`, `app.js`, `benchmark.js`, `catalog.js`, `key-usage.js` | Run ids, tags, cancel reasons, Settings copy, logging-off warning |
| `scripts/live/mock-provider.mjs`, `fixture.mjs`, `verify-db.mjs` | Live check of the request log |
| `test/helpers.js`, `test/logs/*.test.js`, `test/api-request.test.js`, `test/main-wiring.test.js`, `test/renderer-ulid.test.js`, `test/db/*.test.js` | Tests |

---

# Phase 1 — The log database layer (`src/logs`)

### Task 1: Schema v1, log settings and test helpers

**Files:**
- Create: `src/logs/migrations.js`
- Create: `src/logs/settings.js`
- Modify: `test/helpers.js` (add `migratedLogsDb`, `logRow`, `countRows`)
- Test: `test/logs/schema.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `require('./migrations')` → `[{ version: 1, up(db) }]`; tables `meta`, `request_logs`, `request_bodies`, `usage_hourly` exactly as the spec's Schema v1; indexes `request_logs_by_time`, `request_logs_by_provider`, `request_logs_by_model`, `request_logs_by_source`, `request_logs_by_run`, `request_bodies_by_time`.
  - `readLogSettings(row) → { logLevel: 'off'|'errors'|'all', logRetentionDays: int, bodyRetentionDays: int, statsRetentionMonths: int }`; `LOG_DEFAULTS`.
  - test helpers: `migratedLogsDb(t)` → a better-sqlite3 `:memory:` db with schema v1 (closed after the test); `logRow(overrides)` → a complete row object as the recorder builds it; `countRows(db, table)` → number.

- [ ] **Step 1: Commit this plan on the branch**

```bash
git add docs/superpowers/plans/2026-09-26-logging-system.md && git commit -m "docs: logging system implementation plan"
```
Expected: one file committed; `git status --short` prints nothing.

- [ ] **Step 2: Add the shared log helpers to `test/helpers.js`**

In `test/helpers.js` replace:
```js
module.exports = { quietLog, fakeSafeStorage, fakeCipher, encFake, LOCKED_BLOB, tempDir, memoryStore };
```
with:
```js
// A bare in-memory request log database with schema v1 applied, for the
// modules that take a db handle (writer, retention, query). Closed after the
// test.
function migratedLogsDb(t) {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  require('../src/logs/migrations').forEach((m) => m.up(db));
  t.after(() => {
    if (db.open) db.close();
  });
  return db;
}

// A complete request_logs row as src/logs/recorder.js builds it (no has_body:
// the writer sets that). Override what a test needs.
let logRowSeq = 0;
function logRow(overrides = {}) {
  logRowSeq += 1;
  return {
    request_uid: `ROW${String(logRowSeq).padStart(23, '0')}`,
    created_at: 1790000000000,
    source: 'route_test',
    run_id: null,
    attempt: 1,
    is_hedge: 0,
    provider_id: 'nara',
    provider_name: 'NaraRouter',
    key_id: 'key_1',
    method: 'POST',
    endpoint: 'https://router.bynara.id/v1/chat/completions',
    model_requested: 'm1',
    model_returned: 'm1',
    is_stream: 0,
    status: 'ok',
    http_status: 200,
    error_class: null,
    error_code: null,
    error_message: null,
    latency_ms: 800,
    ttft_ms: null,
    first_byte_ms: 700,
    input_tokens: 10,
    output_tokens: 2,
    cached_tokens: null,
    cache_write_tokens: null,
    reasoning_tokens: null,
    usage_source: 'reported',
    cost_micros: 40,
    price_json: '{"input":2,"output":10}',
    meta_json: null,
    user_id: null,
    token_id: null,
    subscription_id: null,
    client_ip: null,
    ...overrides,
  };
}

const countRows = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

module.exports = {
  quietLog, fakeSafeStorage, fakeCipher, encFake, LOCKED_BLOB, tempDir, memoryStore,
  migratedLogsDb, logRow, countRows,
};
```

- [ ] **Step 3: Write the failing test `test/logs/schema.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert');
const { migratedLogsDb } = require('../helpers');
const { readLogSettings } = require('../../src/logs/settings');

test('schema v1 creates the four tables and six indexes', (t) => {
  const db = migratedLogsDb(t);
  const names = (type) => db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite%' ORDER BY name")
    .all(type).map((r) => r.name);
  assert.deepStrictEqual(names('table'), ['meta', 'request_bodies', 'request_logs', 'usage_hourly']);
  assert.deepStrictEqual(names('index'), [
    'request_bodies_by_time', 'request_logs_by_model', 'request_logs_by_provider',
    'request_logs_by_run', 'request_logs_by_source', 'request_logs_by_time',
  ]);
});

test('a row with only the required columns gets the defaults', (t) => {
  const db = migratedLogsDb(t);
  db.prepare("INSERT INTO request_logs (request_uid, created_at, source, method, endpoint, status) VALUES ('u1', 1, 'other', 'GET', 'https://x.test/y', 'ok')").run();
  const row = db.prepare('SELECT attempt, is_hedge, is_stream, has_body, user_id FROM request_logs').get();
  assert.deepStrictEqual({ ...row }, { attempt: 1, is_hedge: 0, is_stream: 0, has_body: 0, user_id: null });
});

test('request_uid is unique', (t) => {
  const db = migratedLogsDb(t);
  const insert = db.prepare("INSERT INTO request_logs (request_uid, created_at, source, method, endpoint, status) VALUES ('same', 1, 'other', 'GET', 'e', 'ok')");
  insert.run();
  assert.throws(() => insert.run(), /UNIQUE constraint failed/);
});

test('usage_hourly has one row per hour, provider, model and source', (t) => {
  const db = migratedLogsDb(t);
  const cols = db.prepare('PRAGMA table_info(usage_hourly)').all().map((c) => c.name);
  const insert = db.prepare(`INSERT INTO usage_hourly (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  const values = cols.map((c) => ({ hour_start: 3600000, provider_id: 'p', model_id: 'm', source: 'other' }[c] ?? 0));
  insert.run(values);
  assert.throws(() => insert.run(values), /UNIQUE constraint failed/);
});

test('readLogSettings: a new install gets Failed only and the default retention', () => {
  const defaults = { logLevel: 'errors', logRetentionDays: 90, bodyRetentionDays: 7, statsRetentionMonths: 12 };
  assert.deepStrictEqual(readLogSettings(null), defaults);
  assert.deepStrictEqual(readLogSettings({ theme: 'vercel' }), defaults);
});

test('readLogSettings: stored values are used as they are', () => {
  assert.deepStrictEqual(
    readLogSettings({ logLevel: 'off', logRetentionDays: 30, bodyRetentionDays: 1, statsRetentionMonths: 6 }),
    { logLevel: 'off', logRetentionDays: 30, bodyRetentionDays: 1, statsRetentionMonths: 6 },
  );
  assert.strictEqual(readLogSettings({ logLevel: 'all' }).logLevel, 'all');
});

test('readLogSettings: unknown or out-of-range values fall back to the defaults', () => {
  assert.deepStrictEqual(
    readLogSettings({ logLevel: 'verbose', logRetentionDays: 0, bodyRetentionDays: -2, statsRetentionMonths: 1.5 }),
    { logLevel: 'errors', logRetentionDays: 90, bodyRetentionDays: 7, statsRetentionMonths: 12 },
  );
  assert.strictEqual(readLogSettings({ logRetentionDays: '30' }).logRetentionDays, 90);
  assert.strictEqual(readLogSettings({ statsRetentionMonths: 999 }).statsRetentionMonths, 12);
});
```

- [ ] **Step 4: Run it to see it fail**

Run: `npm test -- test/logs/schema.test.js`
Expected: FAIL — `Cannot find module '../src/logs/migrations'` (and `../../src/logs/settings`), `# fail 7`.

- [ ] **Step 5: Write `src/logs/migrations.js`**

```js
// ============================================
// Request log schema migrations (venom-logs.db)
// ============================================
// Ordered and forward only, like src/db/migrations.js, with its own
// user_version. SQL lives in a JS module so electron-builder's
// `files: ["src/**/*"]` ships it. An entry that has shipped is never edited.
//
// No foreign keys: a row outlives the provider and the key it names.
module.exports = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        -- One row per request, inserted when it finishes; created_at is its start.
        CREATE TABLE request_logs (
          id INTEGER PRIMARY KEY,
          request_uid TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          source TEXT NOT NULL,
          run_id TEXT,
          attempt INTEGER NOT NULL DEFAULT 1,
          is_hedge INTEGER NOT NULL DEFAULT 0,
          provider_id TEXT,
          provider_name TEXT,
          key_id TEXT,
          method TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          model_requested TEXT,
          model_returned TEXT,
          is_stream INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          http_status INTEGER,
          error_class TEXT,
          error_code TEXT,
          error_message TEXT,
          latency_ms INTEGER,
          ttft_ms INTEGER,
          first_byte_ms INTEGER,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cached_tokens INTEGER,
          cache_write_tokens INTEGER,
          reasoning_tokens INTEGER,
          usage_source TEXT,
          cost_micros INTEGER,
          price_json TEXT,
          has_body INTEGER NOT NULL DEFAULT 0,
          meta_json TEXT,
          user_id TEXT,
          token_id TEXT,
          subscription_id TEXT,
          client_ip TEXT
        );
        CREATE INDEX request_logs_by_time ON request_logs(created_at);
        CREATE INDEX request_logs_by_provider ON request_logs(provider_id, created_at);
        CREATE INDEX request_logs_by_model ON request_logs(model_requested, created_at);
        CREATE INDEX request_logs_by_source ON request_logs(source, created_at);
        CREATE INDEX request_logs_by_run ON request_logs(run_id);

        CREATE TABLE request_bodies (
          log_id INTEGER PRIMARY KEY,
          created_at INTEGER NOT NULL,
          request_headers_json TEXT,
          request_body TEXT,
          response_body TEXT,
          truncated INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX request_bodies_by_time ON request_bodies(created_at);

        -- Hourly roll-ups the charts read. Every counter is added to on upsert.
        CREATE TABLE usage_hourly (
          hour_start INTEGER NOT NULL,
          provider_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          source TEXT NOT NULL,
          requests INTEGER NOT NULL,
          ok INTEGER NOT NULL,
          cancelled INTEGER NOT NULL,
          blocked INTEGER NOT NULL,
          timeouts INTEGER NOT NULL,
          e_auth INTEGER NOT NULL,
          e_rate_limit INTEGER NOT NULL,
          e_quota INTEGER NOT NULL,
          e_bad_request INTEGER NOT NULL,
          e_server INTEGER NOT NULL,
          e_network INTEGER NOT NULL,
          e_other INTEGER NOT NULL,
          latency_sum_ms INTEGER NOT NULL,
          latency_count INTEGER NOT NULL,
          lb0 INTEGER NOT NULL, lb1 INTEGER NOT NULL, lb2 INTEGER NOT NULL, lb3 INTEGER NOT NULL,
          lb4 INTEGER NOT NULL, lb5 INTEGER NOT NULL, lb6 INTEGER NOT NULL, lb7 INTEGER NOT NULL,
          lb8 INTEGER NOT NULL, lb9 INTEGER NOT NULL, lb10 INTEGER NOT NULL, lb11 INTEGER NOT NULL,
          lb12 INTEGER NOT NULL, lb13 INTEGER NOT NULL,
          ttft_sum_ms INTEGER NOT NULL,
          ttft_count INTEGER NOT NULL,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          cached_tokens INTEGER NOT NULL,
          cost_micros INTEGER NOT NULL,
          PRIMARY KEY (hour_start, provider_id, model_id, source)
        );
      `);
    },
  },
];
```

- [ ] **Step 6: Write `src/logs/settings.js`**

```js
// ============================================
// Request log settings, read by main from the settings row
// ============================================
// The renderer saves them with every other setting (save-settings). Main
// reads the row at startup and again after each save, so a request never
// carries them. A value that is missing or out of range reads as the default
// and is never written back.
const LOG_LEVELS = new Set(['off', 'errors', 'all']);
const LOG_DEFAULTS = Object.freeze({ logLevel: 'errors', logRetentionDays: 90, bodyRetentionDays: 7, statsRetentionMonths: 12 });

function wholeIn(value, max, fallback) {
  return Number.isInteger(value) && value >= 1 && value <= max ? value : fallback;
}

function readLogSettings(row) {
  const s = row && typeof row === 'object' ? row : {};
  return {
    // No logLevel in the row means a new install: Failed only.
    logLevel: LOG_LEVELS.has(s.logLevel) ? s.logLevel : LOG_DEFAULTS.logLevel,
    logRetentionDays: wholeIn(s.logRetentionDays, 3650, LOG_DEFAULTS.logRetentionDays),
    bodyRetentionDays: wholeIn(s.bodyRetentionDays, 3650, LOG_DEFAULTS.bodyRetentionDays),
    statsRetentionMonths: wholeIn(s.statsRetentionMonths, 120, LOG_DEFAULTS.statsRetentionMonths),
  };
}

module.exports = { readLogSettings, LOG_DEFAULTS };
```

- [ ] **Step 7: Run it to see it pass**

Run: `npm test -- test/logs/schema.test.js`
Expected: `# pass 7`, `# fail 0`.

- [ ] **Step 8: Run the whole suite**

Run: `npm test`
Expected: `# pass 140`, `# fail 0`.

- [ ] **Step 9: Commit**

```bash
git add src/logs/migrations.js src/logs/settings.js test/helpers.js test/logs/schema.test.js
git commit -m "feat(logs): request log schema v1 and log settings"
```

---

### Task 2: `classify.js` — endpoint, model, usage, cost, status

**Files:**
- Create: `src/logs/classify.js`
- Test: `test/logs/classify.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces (all pure):
  - `endpointOf(url) → string` (origin + path, no query; for a non-URL the text before `?`/`#`, max 500).
  - `bodyText(body) → string|null` (objects JSON-stringified; `''`/null/undefined → null).
  - `modelRequested(requestText) → string|null` (JSON `model`, max 200).
  - `isStreamRequest(requestText, contentType) → boolean`.
  - `normalizeUsage(u) → { input, output, cached, cacheWrite, reasoning } | null` (ints or null).
  - `readResponse(text, contentType) → { usage: normalized|null, model: string|null }`.
  - `computeCost(usage, price) → { costMicros: int|null, priceJson: string|null }` (`price = { input, output }` USD per 1M).
  - `classifyStatus({ outcome, httpStatus, cancelReason, errorCode }) → { status, errorClass }`; `outcome` ∈ `end | cancelled | timeout | error | aborted | blocked`.
  - `extractError(text) → { code: string|null, message: string|null }`.
  - `latencyBucket(ms) → 0..13`; `approxP95(buckets[14], total) → { ms, overflow } | null`.
  - `LATENCY_EDGES`, `JSON_PARSE_LIMIT`, `QUOTA_CODES`.

- [ ] **Step 1: Write the failing test `test/logs/classify.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert');
const C = require('../../src/logs/classify');

const usage = (input, output, cached = null, cacheWrite = null, reasoning = null) => ({ input, output, cached, cacheWrite, reasoning });

test('endpointOf keeps origin and path, drops the query', () => {
  assert.strictEqual(C.endpointOf('https://api.miraiapi.com/v1/usage?key=venomkey:key_m'), 'https://api.miraiapi.com/v1/usage');
  assert.strictEqual(C.endpointOf('http://127.0.0.1:47831/darkapi/v1/models#x'), 'http://127.0.0.1:47831/darkapi/v1/models');
  assert.strictEqual(C.endpointOf('not a url?key=secret'), 'not a url');
  assert.strictEqual(C.endpointOf(undefined), '');
});

test('bodyText and modelRequested read the model from a JSON body', () => {
  assert.strictEqual(C.bodyText({ model: 'm1' }), '{"model":"m1"}');
  assert.strictEqual(C.bodyText(''), null);
  assert.strictEqual(C.modelRequested('{"model":"gpt-x","messages":[]}'), 'gpt-x');
  assert.strictEqual(C.modelRequested('token=abc'), null);
  assert.strictEqual(C.modelRequested(null), null);
  assert.strictEqual(C.modelRequested(JSON.stringify({ model: 'm'.repeat(300) })).length, 200);
});

test('isStreamRequest: stream true in the body, or an event-stream reply', () => {
  assert.strictEqual(C.isStreamRequest('{"stream":true}', 'application/json'), true);
  assert.strictEqual(C.isStreamRequest('{"stream":false}', 'text/event-stream; charset=utf-8'), true);
  assert.strictEqual(C.isStreamRequest('{"stream":false}', 'application/json'), false);
  assert.strictEqual(C.isStreamRequest(null, null), false);
});

test('OpenAI JSON: usage with cached and reasoning tokens, and the returned model', () => {
  const body = JSON.stringify({
    model: 'gpt-x-2026', choices: [{ message: { content: 'hi' } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 64 }, completion_tokens_details: { reasoning_tokens: 12 } },
  });
  assert.deepStrictEqual(C.readResponse(body, 'application/json'), { usage: usage(100, 20, 64, null, 12), model: 'gpt-x-2026' });
});

test('Anthropic JSON: input counts cache reads and writes', () => {
  const body = JSON.stringify({ model: 'claude-x', usage: { input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 2, output_tokens: 7 } });
  assert.deepStrictEqual(C.readResponse(body, 'application/json'), { usage: usage(16, 7, 4, 2, null), model: 'claude-x' });
});

test('OpenAI SSE: usage from the final chunk, model from the chunks', () => {
  const sse = [
    'data: {"id":"c","model":"gpt-s","choices":[{"delta":{"content":"4"}}]}',
    '',
    'data: {"id":"c","model":"gpt-s","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  assert.deepStrictEqual(C.readResponse(sse, 'text/event-stream'), { usage: usage(5, 1), model: 'gpt-s' });
});

test('Anthropic SSE: message_start and message_delta usage are merged', () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"m","model":"claude-s","usage":{"input_tokens":10,"cache_read_input_tokens":4,"cache_creation_input_tokens":2,"output_tokens":1}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":15}}',
    '',
  ].join('\n');
  assert.deepStrictEqual(C.readResponse(sse, 'text/event-stream'), { usage: usage(16, 15, 4, 2, null), model: 'claude-s' });
});

test('a stream that did not ask for usage has none', () => {
  const sse = 'data: {"model":"m1","choices":[{"delta":{"content":"4"}}]}\n\ndata: [DONE]\n\n';
  assert.deepStrictEqual(C.readResponse(sse, 'text/event-stream'), { usage: null, model: 'm1' });
});

test('a JSON body over 1 MB is read from its ends', () => {
  const body = JSON.stringify({
    id: 'x', model: 'big-model', choices: [{ message: { content: 'a'.repeat(1200000) } }],
    usage: { prompt_tokens: 7, completion_tokens: 3 },
  });
  assert.ok(body.length > C.JSON_PARSE_LIMIT);
  assert.deepStrictEqual(C.readResponse(body, 'application/json'), { usage: usage(7, 3), model: 'big-model' });
});

test('a 5 MB stream is read from its ends in under 250 ms', () => {
  const chunk = `data: ${JSON.stringify({ id: 'c', model: 'stream-model', choices: [{ delta: { content: 'word ' } }] })}\n\n`;
  const last = `data: ${JSON.stringify({ id: 'c', model: 'stream-model', choices: [], usage: { prompt_tokens: 11, completion_tokens: 900 } })}\n\ndata: [DONE]\n\n`;
  const body = chunk.repeat(Math.ceil(5e6 / chunk.length)) + last;
  const started = process.hrtime.bigint();
  const out = C.readResponse(body, 'text/event-stream');
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.deepStrictEqual(out, { usage: usage(11, 900), model: 'stream-model' });
  assert.ok(ms < 250, `took ${ms.toFixed(1)} ms`);
});

test('garbage and empty replies give nothing', () => {
  const none = { usage: null, model: null };
  assert.deepStrictEqual(C.readResponse('', 'application/json'), none);
  assert.deepStrictEqual(C.readResponse('<html>502 Bad Gateway</html>', 'text/html'), none);
  assert.deepStrictEqual(C.readResponse('[1,2,3]', 'application/json'), none);
  assert.deepStrictEqual(C.readResponse('{"usage":"lots"}', 'application/json'), none);
  assert.strictEqual(C.normalizeUsage({ total_tokens: 9 }), null);
});

test('computeCost: tokens × price per 1M in micro-USD; free is 0; unknown is NULL', () => {
  assert.deepStrictEqual(C.computeCost(usage(5, 1), { input: 2, output: 10 }), { costMicros: 20, priceJson: '{"input":2,"output":10}' });
  assert.deepStrictEqual(C.computeCost(usage(1000, 500), { input: 0.15, output: 0.6 }), { costMicros: 450, priceJson: '{"input":0.15,"output":0.6}' });
  assert.deepStrictEqual(C.computeCost(usage(5, 1), { input: 0, output: 0 }), { costMicros: 0, priceJson: '{"input":0,"output":0}' });
  assert.deepStrictEqual(C.computeCost(usage(5, 1), null), { costMicros: null, priceJson: null });
  assert.deepStrictEqual(C.computeCost(null, { input: 2, output: 10 }), { costMicros: null, priceJson: null });
  assert.deepStrictEqual(C.computeCost(usage(null, null), { input: 2, output: 10 }), { costMicros: null, priceJson: null });
});

test('classifyStatus: the status and error-class table', () => {
  const cases = [
    [{ outcome: 'end', httpStatus: 200 }, 'ok', null],
    [{ outcome: 'end', httpStatus: 204 }, 'ok', null],
    [{ outcome: 'cancelled', cancelReason: 'hedge_lost' }, 'cancelled', null],
    [{ outcome: 'cancelled', cancelReason: 'stop' }, 'cancelled', null],
    [{ outcome: 'cancelled', cancelReason: 'deadline' }, 'timeout', 'timeout'],
    [{ outcome: 'blocked' }, 'blocked', 'blocked'],
    [{ outcome: 'timeout' }, 'timeout', 'timeout'],
    [{ outcome: 'error' }, 'error', 'network'],
    [{ outcome: 'aborted', httpStatus: 200 }, 'error', 'network'],
    [{ outcome: 'end', httpStatus: 401 }, 'error', 'auth'],
    [{ outcome: 'end', httpStatus: 403 }, 'error', 'auth'],
    [{ outcome: 'end', httpStatus: 402 }, 'error', 'quota'],
    [{ outcome: 'end', httpStatus: 429 }, 'error', 'rate_limit'],
    [{ outcome: 'end', httpStatus: 429, errorCode: 'insufficient_quota' }, 'error', 'quota'],
    [{ outcome: 'end', httpStatus: 400, errorCode: 'quota_exceeded' }, 'error', 'quota'],
    [{ outcome: 'end', httpStatus: 401, errorCode: 'billing_hard_limit_reached' }, 'error', 'quota'],
    [{ outcome: 'end', httpStatus: 404 }, 'error', 'bad_request'],
    [{ outcome: 'end', httpStatus: 500 }, 'error', 'server'],
    [{ outcome: 'end', httpStatus: 503 }, 'error', 'server'],
    [{ outcome: 'end', httpStatus: 302 }, 'error', 'other'],
    [{ outcome: 'something' }, 'error', 'other'],
  ];
  cases.forEach(([input, status, errorClass]) => {
    assert.deepStrictEqual(C.classifyStatus(input), { status, errorClass }, JSON.stringify(input));
  });
});

test('extractError: error.message, a string error, message, detail, or the first 200 characters; code clipped', () => {
  assert.deepStrictEqual(C.extractError(JSON.stringify({ error: { message: 'Bad key', code: 'invalid_api_key' } })), { code: 'invalid_api_key', message: 'Bad key' });
  assert.deepStrictEqual(C.extractError(JSON.stringify({ error: { type: 'overloaded_error', message: 'Overloaded' } })), { code: 'overloaded_error', message: 'Overloaded' });
  assert.deepStrictEqual(C.extractError(JSON.stringify({ error: 'plain string' })), { code: null, message: 'plain string' });
  assert.deepStrictEqual(C.extractError(JSON.stringify({ message: 'top-level' })), { code: null, message: 'top-level' });
  assert.deepStrictEqual(C.extractError(JSON.stringify({ detail: 'Not Found' })), { code: null, message: 'Not Found' });
  assert.strictEqual(C.extractError(`<html>${'x'.repeat(500)}`).message.length, 200);
  const long = C.extractError(JSON.stringify({ error: { code: 'c'.repeat(250) } }));
  assert.strictEqual(long.code.length, 100);
  assert.strictEqual(long.message.length, 200);
  assert.deepStrictEqual(C.extractError(''), { code: null, message: null });
});

test('latency buckets and the approximate p95', () => {
  assert.deepStrictEqual([0, 100, 101, 1000, 1001, 120000, 120001].map(C.latencyBucket), [0, 0, 1, 3, 4, 12, 13]);
  const b = new Array(14).fill(0);
  b[0] = 94;
  b[3] = 6;
  assert.deepStrictEqual(C.approxP95(b, 100), { ms: 1000, overflow: false });
  const top = new Array(14).fill(0);
  top[13] = 3;
  assert.deepStrictEqual(C.approxP95(top, 3), { ms: 120000, overflow: true });
  assert.strictEqual(C.approxP95(new Array(14).fill(0), 0), null);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- test/logs/classify.test.js`
Expected: FAIL — `Cannot find module '../../src/logs/classify'`.

- [ ] **Step 3: Write `src/logs/classify.js`**

```js
// ============================================
// Request classification — pure, no I/O
// ============================================
// Turns what api-request saw (the request as the renderer sent it, the reply,
// how it ended) into the logged fields: endpoint, model, stream flag, usage,
// cost, status and error class. It runs after the reply went out but still on
// the main thread, so a big body is never parsed whole: JSON only up to
// 1 MB, streams and bigger bodies only at their two ends.
const QUOTA_CODES = new Set(['insufficient_quota', 'quota_exceeded', 'billing_hard_limit_reached']);
const JSON_PARSE_LIMIT = 1024 * 1024;
const SCAN_WINDOW = 64 * 1024;
const MODEL_MAX = 200;
// Inclusive upper edges (ms) of lb0..lb12; lb13 holds everything above.
const LATENCY_EDGES = [100, 250, 500, 1000, 2000, 3000, 5000, 8000, 12000, 20000, 30000, 60000, 120000];

const clipped = (s, max) => (typeof s === 'string' && s !== '' ? s.slice(0, max) : null);
const tokens = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

// URL origin + path. The query string is dropped: it can hold a key.
function endpointOf(url) {
  const text = String(url ?? '');
  try {
    const u = new URL(text);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin + u.pathname;
  } catch (_) {
    // Not a URL: stored as given, minus anything after ? or #.
  }
  return text.split(/[?#]/)[0].slice(0, 500);
}

function bodyText(body) {
  if (body === undefined || body === null || body === '') return null;
  return typeof body === 'string' ? body : JSON.stringify(body);
}

function parseObject(text) {
  if (typeof text !== 'string' || text.length > JSON_PARSE_LIMIT) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (_) {
    return null;
  }
}

function modelRequested(requestText) {
  const o = parseObject(requestText);
  return o ? clipped(typeof o.model === 'string' ? o.model : null, MODEL_MAX) : null;
}

function isStreamRequest(requestText, contentType) {
  const o = parseObject(requestText);
  return (!!o && o.stream === true) || /text\/event-stream/i.test(contentType || '');
}

// OpenAI's prompt_tokens already includes cached tokens. Anthropic reports
// cache reads and writes beside input_tokens, so they are added to it.
function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  if ('prompt_tokens' in u || 'completion_tokens' in u) {
    return {
      input: tokens(u.prompt_tokens),
      output: tokens(u.completion_tokens),
      cached: tokens(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens),
      cacheWrite: null,
      reasoning: tokens(u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens),
    };
  }
  if ('input_tokens' in u || 'output_tokens' in u || 'cache_read_input_tokens' in u) {
    const base = tokens(u.input_tokens);
    const read = tokens(u.cache_read_input_tokens);
    const write = tokens(u.cache_creation_input_tokens);
    const input = base === null && read === null && write === null ? null : (base || 0) + (read || 0) + (write || 0);
    return { input, output: tokens(u.output_tokens), cached: read, cacheWrite: write, reasoning: null };
  }
  return null;
}

// The data: lines of an event stream, as objects. A long stream is read only
// at its two ends: the first window (Anthropic's message_start, the model)
// and the last (the final usage chunk). The line each window cuts is dropped.
function sseEvents(text) {
  const windows = text.length <= 4 * SCAN_WINDOW ? [text] : [text.slice(0, SCAN_WINDOW), text.slice(-SCAN_WINDOW)];
  const events = [];
  windows.forEach((part, i) => {
    const lines = part.split('\n');
    if (windows.length > 1) {
      if (i === 0) lines.pop();
      else lines.shift();
    }
    lines.forEach((line) => {
      const t = line.trim();
      if (!t.startsWith('data:')) return;
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      try {
        const ev = JSON.parse(payload);
        if (ev && typeof ev === 'object') events.push(ev);
      } catch (_) {
        // A keep-alive or a line that isn't JSON.
      }
    });
  });
  return events;
}

function readStream(text) {
  let model = null;
  let usage = null; // OpenAI: the last chunk that carried usage
  let started = null; // Anthropic: message_start.message.usage (input side)
  let delta = null; // Anthropic: message_delta.usage (output so far)
  sseEvents(text).forEach((ev) => {
    if (ev.type === 'message_start' && ev.message && typeof ev.message === 'object') {
      if (typeof ev.message.model === 'string') model = ev.message.model;
      if (ev.message.usage && typeof ev.message.usage === 'object') started = ev.message.usage;
      return;
    }
    if (typeof ev.model === 'string' && ev.model) model = ev.model;
    if (ev.usage && typeof ev.usage === 'object') {
      if (ev.type === 'message_delta') delta = ev.usage;
      else usage = ev.usage;
    }
  });
  const raw = started || delta ? { ...(started || {}), ...(delta || {}) } : usage;
  return { usage: normalizeUsage(raw), model: clipped(model, MODEL_MAX) };
}

// The object literal that starts at text[start] (a '{'), parsed, or null.
function objectAt(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '{') {
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch (_) {
          return null;
        }
      }
    }
  }
  return null;
}

const MODEL_FIELD = /"model"\s*:\s*"((?:[^"\\]|\\.){1,200})"/;

// A JSON reply too big to parse whole: usage from the last "usage" object in
// the tail, the model from the head (where OpenAI and Anthropic put it).
function readLargeJson(text) {
  const tail = text.slice(-SCAN_WINDOW);
  const at = tail.lastIndexOf('"usage"');
  const brace = at >= 0 ? tail.indexOf('{', at) : -1;
  const usage = brace >= 0 ? normalizeUsage(objectAt(tail, brace)) : null;
  const m = MODEL_FIELD.exec(text.slice(0, SCAN_WINDOW));
  let model = null;
  if (m) {
    try {
      model = JSON.parse(`"${m[1]}"`);
    } catch (_) {
      model = null;
    }
  }
  return { usage, model: clipped(model, MODEL_MAX) };
}

function readResponse(text, contentType) {
  if (typeof text !== 'string' || text === '') return { usage: null, model: null };
  if (/text\/event-stream/i.test(contentType || '') || /^\s*(?:data|event):/.test(text.slice(0, 64))) return readStream(text);
  if (text.length > JSON_PARSE_LIMIT) return readLargeJson(text);
  const o = parseObject(text);
  if (!o) return { usage: null, model: null };
  return { usage: normalizeUsage(o.usage), model: clipped(typeof o.model === 'string' ? o.model : null, MODEL_MAX) };
}

// Prices are USD per 1M tokens, so tokens × price is already micro-USD.
function computeCost(usage, price) {
  if (!usage || !price || (usage.input === null && usage.output === null)) return { costMicros: null, priceJson: null };
  return {
    costMicros: Math.round((usage.input || 0) * price.input + (usage.output || 0) * price.output),
    priceJson: JSON.stringify({ input: price.input, output: price.output }),
  };
}

// outcome comes from src/api-request.js: end | cancelled | timeout | error | aborted | blocked.
function classifyStatus({ outcome, httpStatus = null, cancelReason = null, errorCode = null } = {}) {
  if (outcome === 'blocked') return { status: 'blocked', errorClass: 'blocked' };
  if (outcome === 'cancelled') {
    // The adaptive per-kind deadline gave up on it: a timeout, not a choice.
    return cancelReason === 'deadline' ? { status: 'timeout', errorClass: 'timeout' } : { status: 'cancelled', errorClass: null };
  }
  if (outcome === 'timeout') return { status: 'timeout', errorClass: 'timeout' };
  if (outcome === 'error' || outcome === 'aborted') return { status: 'error', errorClass: 'network' };
  if (outcome !== 'end' || !Number.isInteger(httpStatus)) return { status: 'error', errorClass: 'other' };
  if (httpStatus >= 200 && httpStatus < 300) return { status: 'ok', errorClass: null };
  // A spent quota is named in the body, whatever the status line says.
  if (errorCode !== null && QUOTA_CODES.has(String(errorCode))) return { status: 'error', errorClass: 'quota' };
  if (httpStatus === 401 || httpStatus === 403) return { status: 'error', errorClass: 'auth' };
  if (httpStatus === 402) return { status: 'error', errorClass: 'quota' };
  if (httpStatus === 429) return { status: 'error', errorClass: 'rate_limit' };
  if (httpStatus >= 400 && httpStatus < 500) return { status: 'error', errorClass: 'bad_request' };
  if (httpStatus >= 500 && httpStatus < 600) return { status: 'error', errorClass: 'server' };
  return { status: 'error', errorClass: 'other' };
}

// The message the renderer's failFromResponse shows: error.message (or a
// string error), else message, else detail, else the body's first 200
// characters. code is error.code or error.type.
function extractError(text) {
  const src = typeof text === 'string' ? text : '';
  const d = parseObject(src);
  let message = null;
  let code = null;
  if (d) {
    const e = d.error;
    if (typeof e === 'string') message = e;
    else if (e && typeof e === 'object' && typeof e.message === 'string') message = e.message;
    if (!message && typeof d.message === 'string') message = d.message;
    if (!message && typeof d.detail === 'string') message = d.detail;
    if (e && typeof e === 'object') {
      const c = e.code ?? e.type;
      if (typeof c === 'string' || typeof c === 'number') code = String(c).slice(0, 100);
    }
  }
  return { code, message: message || src.slice(0, 200) || null };
}

function latencyBucket(ms) {
  const i = LATENCY_EDGES.findIndex((edge) => ms <= edge);
  return i === -1 ? LATENCY_EDGES.length : i;
}

// Approximate p95: the upper edge of the first bucket whose running count
// reaches ceil(0.95 × total). Past the last edge it can only say "≥ 120 s".
function approxP95(buckets, total) {
  if (!Number.isFinite(total) || total <= 0) return null;
  const target = Math.ceil(0.95 * total);
  const top = { ms: LATENCY_EDGES[LATENCY_EDGES.length - 1], overflow: true };
  let seen = 0;
  for (let i = 0; i < buckets.length; i += 1) {
    seen += buckets[i] || 0;
    if (seen >= target) return i < LATENCY_EDGES.length ? { ms: LATENCY_EDGES[i], overflow: false } : top;
  }
  return top;
}

module.exports = {
  endpointOf, bodyText, modelRequested, isStreamRequest, normalizeUsage, readResponse,
  computeCost, classifyStatus, extractError, latencyBucket, approxP95,
  LATENCY_EDGES, JSON_PARSE_LIMIT, QUOTA_CODES,
};
```

- [ ] **Step 4: Run it to see it pass**

Run: `npm test -- test/logs/classify.test.js`
Expected: `# pass 15`, `# fail 0`.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: `# pass 155`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/logs/classify.js test/logs/classify.test.js
git commit -m "feat(logs): classify requests - usage, cost, status, error class"
```

---

### Task 3: `scrub.js` — substituted secrets out of stored text

**Files:**
- Create: `src/logs/scrub.js`
- Test: `test/logs/scrub.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `scrub(text, substitutions) → text` where `substitutions = [{ placeholder, secret }]`; non-strings and empty input come back as given.

- [ ] **Step 1: Write the failing test `test/logs/scrub.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert');
const { scrub } = require('../../src/logs/scrub');

// sk-"quote\slash/7: needs escaping in JSON and in a URL.
const TRICKY = 'sk-"quote\\slash/7';
const SUBS = [{ placeholder: 'venomkey:key_t', secret: TRICKY }];

test('replaces the raw secret with its placeholder', () => {
  assert.strictEqual(scrub(`bad key ${TRICKY}!`, SUBS), 'bad key venomkey:key_t!');
});

test('replaces the JSON-escaped, \\/-escaped and URL-encoded forms', () => {
  const json = JSON.stringify({ echo: TRICKY });
  const php = json.replace(/\//g, '\\/');
  const url = `https://x.test/?key=${encodeURIComponent(TRICKY)}`;
  assert.strictEqual(scrub(json, SUBS), '{"echo":"venomkey:key_t"}');
  assert.strictEqual(scrub(php, SUBS), '{"echo":"venomkey:key_t"}');
  assert.strictEqual(scrub(url, SUBS), 'https://x.test/?key=venomkey:key_t');
});

test('the longest form goes first, so a secret inside another is replaced whole', () => {
  const subs = [
    { placeholder: 'venomkey:short', secret: 'sk-abc' },
    { placeholder: 'venomkey:long', secret: 'sk-abcdef' },
  ];
  assert.strictEqual(scrub('a sk-abcdef b sk-abc c', subs), 'a venomkey:long b venomkey:short c');
});

test('nothing to scrub: the text comes back as it was', () => {
  assert.strictEqual(scrub('plain', []), 'plain');
  assert.strictEqual(scrub('plain', undefined), 'plain');
  assert.strictEqual(scrub(null, SUBS), null);
  assert.strictEqual(scrub('', SUBS), '');
  assert.strictEqual(scrub('venomkey:key_t stays', SUBS), 'venomkey:key_t stays');
  assert.strictEqual(scrub('x', [{ placeholder: 'p', secret: '' }]), 'x');
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- test/logs/scrub.test.js`
Expected: FAIL — `Cannot find module '../../src/logs/scrub'`.

- [ ] **Step 3: Write `src/logs/scrub.js`**

```js
// ============================================
// Scrub substituted secrets out of stored log text
// ============================================
// A provider can echo the key it was sent ("invalid key sk-…"). The request
// log stores error messages and captured replies, so every secret main swapped
// in for this request is replaced by its placeholder before storing — in each
// form it can come back in: raw, JSON-escaped, JSON-escaped with / written as
// \/ (PHP's json_encode), and URL-encoded. Longest first, so a secret that
// contains another is replaced whole. Only stored text is touched, never the
// reply the renderer gets.
function formsOf(secret) {
  const json = JSON.stringify(secret).slice(1, -1);
  return [secret, json, json.replace(/\//g, '\\/'), encodeURIComponent(secret)];
}

function scrub(text, substitutions) {
  if (typeof text !== 'string' || text === '' || !Array.isArray(substitutions) || substitutions.length === 0) return text;
  const pairs = [];
  const seen = new Set();
  substitutions.forEach((s) => {
    if (!s || typeof s.secret !== 'string' || s.secret === '' || typeof s.placeholder !== 'string') return;
    formsOf(s.secret).forEach((form) => {
      if (seen.has(form)) return;
      seen.add(form);
      pairs.push([form, s.placeholder]);
    });
  });
  pairs.sort((a, b) => b[0].length - a[0].length);
  return pairs.reduce((out, [form, placeholder]) => out.split(form).join(placeholder), text);
}

module.exports = { scrub };
```

- [ ] **Step 4: Run it to see it pass**

Run: `npm test -- test/logs/scrub.test.js`
Expected: `# pass 4`, `# fail 0`.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: `# pass 159`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/logs/scrub.js test/logs/scrub.test.js
git commit -m "feat(logs): scrub substituted secrets from stored text"
```

---

### Task 4: `writer.js` — batched writes, roll-ups, dropped counter

**Files:**
- Create: `src/logs/writer.js`
- Modify: `test/helpers.js` (add `fakeTimers`)
- Test: `test/logs/writer.test.js`

**Interfaces:**
- Consumes: `latencyBucket` (Task 2); `migratedLogsDb`, `logRow`, `countRows` (Task 1).
- Produces:
  - `createWriter(db, { log, now, flushMs = 250, batchMax = 500, queueCap = 10000, setTimer, clearTimer, initialDropped = 0 }) → { add(row, body = null), flush() → rowsWritten, stop(), noteDropped(n, err), droppedRows() → int, queued() → int }`. `body = { request_headers_json, request_body, response_body, truncated }`.
  - `rollupDelta(row) → { hour_start, provider_id, model_id, source, ...counters }`.
  - `ROW_COLUMNS` (the 36 `request_logs` columns after `id`, in schema order), `ROLLUP_KEYS`, `ROLLUP_COUNTERS`.
  - test helper `fakeTimers() → { setTimer, clearTimer, delays() → [ms], fire() }`.

- [ ] **Step 1: Add `fakeTimers` to `test/helpers.js`**

In `test/helpers.js` replace:
```js
const countRows = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

module.exports = {
  quietLog, fakeSafeStorage, fakeCipher, encFake, LOCKED_BLOB, tempDir, memoryStore,
  migratedLogsDb, logRow, countRows,
};
```
with:
```js
const countRows = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

// Stands in for setTimeout/clearTimeout: nothing fires until fire() is called.
function fakeTimers() {
  const pending = new Set();
  return {
    setTimer: (fn, ms) => {
      const handle = { fn, ms };
      pending.add(handle);
      return handle;
    },
    clearTimer: (handle) => {
      pending.delete(handle);
    },
    delays: () => [...pending].map((h) => h.ms),
    fire: () => {
      const due = [...pending];
      pending.clear();
      due.forEach((h) => h.fn());
    },
  };
}

module.exports = {
  quietLog, fakeSafeStorage, fakeCipher, encFake, LOCKED_BLOB, tempDir, memoryStore,
  migratedLogsDb, logRow, countRows, fakeTimers,
};
```

- [ ] **Step 2: Write the failing test `test/logs/writer.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert');
const { createWriter } = require('../../src/logs/writer');
const { migratedLogsDb, logRow, countRows, fakeTimers, quietLog } = require('../helpers');

const HOUR = 3600000;
const T = 1790000000000;

test('rows wait for the 250 ms timer, then land in one flush', (t) => {
  const db = migratedLogsDb(t);
  const timers = fakeTimers();
  const writer = createWriter(db, { ...timers, log: quietLog });
  writer.add(logRow());
  writer.add(logRow());
  writer.add(logRow());
  assert.strictEqual(countRows(db, 'request_logs'), 0);
  assert.deepStrictEqual(timers.delays(), [250]);
  timers.fire();
  assert.strictEqual(countRows(db, 'request_logs'), 3);
  assert.strictEqual(writer.queued(), 0);
});

test('the 500th record flushes at once', (t) => {
  const db = migratedLogsDb(t);
  const timers = fakeTimers();
  const writer = createWriter(db, { ...timers, log: quietLog });
  for (let i = 0; i < 499; i += 1) writer.add(logRow());
  assert.strictEqual(countRows(db, 'request_logs'), 0);
  writer.add(logRow());
  assert.strictEqual(countRows(db, 'request_logs'), 500);
  assert.deepStrictEqual(timers.delays(), []);
});

test('a body is stored under its row id and has_body is set', (t) => {
  const db = migratedLogsDb(t);
  const writer = createWriter(db, { ...fakeTimers(), log: quietLog });
  writer.add(logRow({ request_uid: 'WITHBODY', created_at: T + 5 }), {
    request_headers_json: '{"Authorization":"[redacted]"}', request_body: '{"model":"m1"}', response_body: '{"error":"x"}', truncated: 1,
  });
  writer.add(logRow({ request_uid: 'NOBODY' }));
  writer.flush();
  const withBody = db.prepare('SELECT id, has_body FROM request_logs WHERE request_uid = ?').get('WITHBODY');
  const noBody = db.prepare('SELECT has_body FROM request_logs WHERE request_uid = ?').get('NOBODY');
  assert.strictEqual(withBody.has_body, 1);
  assert.strictEqual(noBody.has_body, 0);
  const bodies = db.prepare('SELECT * FROM request_bodies').all();
  assert.strictEqual(bodies.length, 1);
  assert.deepStrictEqual({ ...bodies[0] }, {
    log_id: withBody.id, created_at: T + 5, request_headers_json: '{"Authorization":"[redacted]"}',
    request_body: '{"model":"m1"}', response_body: '{"error":"x"}', truncated: 1,
  });
});

test('beyond the queue cap the oldest records are dropped and counted', (t) => {
  const db = migratedLogsDb(t);
  const writer = createWriter(db, { ...fakeTimers(), log: quietLog, queueCap: 10, batchMax: 1000 });
  for (let i = 1; i <= 15; i += 1) writer.add(logRow({ request_uid: `Q${i}` }));
  assert.strictEqual(writer.queued(), 10);
  assert.strictEqual(writer.droppedRows(), 5);
  writer.flush();
  const uids = db.prepare('SELECT request_uid FROM request_logs ORDER BY id').all().map((r) => r.request_uid);
  assert.deepStrictEqual(uids, Array.from({ length: 10 }, (_, i) => `Q${i + 6}`));
});

test('a failing database drops batches, warns once a minute, and the count reaches meta once writes recover', (t) => {
  const db = migratedLogsDb(t);
  const errors = [];
  let clock = 1000;
  const writer = createWriter(db, {
    ...fakeTimers(), now: () => clock, log: { ...quietLog, error: (...a) => errors.push(a.join(' ')) },
  });
  db.exec("CREATE TRIGGER disk_full BEFORE INSERT ON request_logs BEGIN SELECT RAISE(ABORT, 'disk full (simulated)'); END");
  assert.doesNotThrow(() => {
    writer.add(logRow());
    writer.add(logRow());
    writer.flush();
  });
  assert.strictEqual(writer.droppedRows(), 2);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /disk full \(simulated\)/);

  clock += 1000;
  writer.add(logRow());
  writer.flush();
  assert.strictEqual(writer.droppedRows(), 3);
  assert.strictEqual(errors.length, 1, 'a second warning inside the minute');

  clock += 60000;
  writer.add(logRow());
  writer.flush();
  assert.strictEqual(errors.length, 2);

  db.exec('DROP TRIGGER disk_full');
  writer.add(logRow());
  writer.flush();
  assert.strictEqual(countRows(db, 'request_logs'), 1);
  assert.strictEqual(db.prepare('SELECT SUM(requests) AS n FROM usage_hourly').get().n, 1, 'a dropped batch left no roll-up behind');
  assert.strictEqual(db.prepare("SELECT value FROM meta WHERE key = 'dropped_rows'").get().value, '4');
});

test('add() never throws, even after the database closed', (t) => {
  const db = migratedLogsDb(t);
  const writer = createWriter(db, { ...fakeTimers(), log: quietLog });
  db.close();
  assert.doesNotThrow(() => {
    writer.add(logRow());
    writer.flush();
  });
  assert.strictEqual(writer.droppedRows(), 1);
});

test('roll-ups: counters by status and class, latency buckets, TTFT for streams, tokens and cost', (t) => {
  const db = migratedLogsDb(t);
  const writer = createWriter(db, { ...fakeTimers(), log: quietLog });
  const same = { created_at: T, provider_id: 'nara', model_requested: 'm1', source: 'route_test' };
  const none = { input_tokens: null, output_tokens: null, cost_micros: null };
  [
    logRow({ ...same, status: 'ok', http_status: 200, latency_ms: 800, input_tokens: 10, output_tokens: 2, cached_tokens: 4, cost_micros: 40 }),
    logRow({ ...same, ...none, status: 'error', error_class: 'server', http_status: 500, latency_ms: 150 }),
    logRow({ ...same, ...none, status: 'error', error_class: 'network', http_status: null, latency_ms: 5000 }),
    logRow({ ...same, ...none, status: 'timeout', error_class: 'timeout', http_status: null, latency_ms: 60000 }),
    logRow({ ...same, ...none, status: 'cancelled', error_class: null, http_status: null, latency_ms: 300 }),
    logRow({ ...same, ...none, status: 'blocked', error_class: 'blocked', http_status: null, latency_ms: 0 }),
    logRow({ ...same, status: 'ok', http_status: 200, latency_ms: 130000, is_stream: 1, ttft_ms: 300, input_tokens: 5, output_tokens: 1, cost_micros: 20 }),
    logRow({ ...same, status: 'ok', http_status: 200, latency_ms: 90, is_stream: 0, ttft_ms: 50, input_tokens: 0, output_tokens: 0, cost_micros: 0 }),
  ].forEach((r) => writer.add(r));
  writer.flush();
  const rows = db.prepare('SELECT * FROM usage_hourly').all();
  assert.strictEqual(rows.length, 1);
  const r = rows[0];
  assert.strictEqual(r.hour_start, Math.floor(T / HOUR) * HOUR);
  assert.deepStrictEqual(
    { requests: r.requests, ok: r.ok, cancelled: r.cancelled, blocked: r.blocked, timeouts: r.timeouts, e_server: r.e_server, e_network: r.e_network, e_other: r.e_other },
    { requests: 8, ok: 3, cancelled: 1, blocked: 1, timeouts: 1, e_server: 1, e_network: 1, e_other: 0 },
  );
  // Latency: the three ok answers and the 500. Not the network error, the timeout, the cancel or the block.
  assert.strictEqual(r.latency_count, 4);
  assert.strictEqual(r.latency_sum_ms, 800 + 150 + 130000 + 90);
  assert.deepStrictEqual([r.lb0, r.lb1, r.lb3, r.lb13], [1, 1, 1, 1]);
  // TTFT from the stream only.
  assert.deepStrictEqual([r.ttft_count, r.ttft_sum_ms], [1, 300]);
  assert.deepStrictEqual([r.input_tokens, r.output_tokens, r.cached_tokens, r.cost_micros], [15, 3, 4, 60]);
});

test("separate roll-ups per hour, provider, model and source; unknown ones are ''", (t) => {
  const db = migratedLogsDb(t);
  const writer = createWriter(db, { ...fakeTimers(), log: quietLog });
  [
    logRow({ created_at: T }),
    logRow({ created_at: T + HOUR }),
    logRow({ created_at: T, provider_id: 'mirai' }),
    logRow({ created_at: T, model_requested: 'm2' }),
    logRow({ created_at: T, source: 'health' }),
    logRow({ created_at: T, provider_id: null, model_requested: null }),
  ].forEach((r) => writer.add(r));
  writer.flush();
  assert.strictEqual(countRows(db, 'usage_hourly'), 6);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM usage_hourly WHERE provider_id = '' AND model_id = ''").get().n, 1);
});

test('the count continues from the value in meta', (t) => {
  const db = migratedLogsDb(t);
  const writer = createWriter(db, { ...fakeTimers(), log: quietLog, initialDropped: 7 });
  assert.strictEqual(writer.droppedRows(), 7);
  writer.noteDropped(2, new Error('simulated'));
  writer.add(logRow());
  writer.flush();
  assert.strictEqual(db.prepare("SELECT value FROM meta WHERE key = 'dropped_rows'").get().value, '9');
});

test('stop() cancels the pending timer; flush() still writes', (t) => {
  const db = migratedLogsDb(t);
  const timers = fakeTimers();
  const writer = createWriter(db, { ...timers, log: quietLog });
  writer.add(logRow());
  assert.deepStrictEqual(timers.delays(), [250]);
  writer.stop();
  assert.deepStrictEqual(timers.delays(), []);
  assert.strictEqual(writer.flush(), 1);
  assert.strictEqual(countRows(db, 'request_logs'), 1);
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npm test -- test/logs/writer.test.js`
Expected: FAIL — `Cannot find module '../../src/logs/writer'`.

- [ ] **Step 4: Write `src/logs/writer.js`**

```js
// ============================================
// Batched writer — request_logs, request_bodies, usage_hourly
// ============================================
// Each finished request reaches add() through the recorder, after the reply
// already went back to the renderer. Rows wait in memory and go to disk every
// 250 ms, or at once when 500 are waiting, in one transaction together with
// their bodies and the hourly roll-ups — so a roll-up never counts a row that
// isn't there, and one fsync covers the batch.
//
// Nothing here throws to the caller. A batch that can't be written is
// dropped and counted (logs-info shows the count), and electron-log hears
// about it at most once a minute.
const { latencyBucket } = require('./classify');

const HOUR = 3600000;
const WARN_EVERY_MS = 60000;

const ROW_COLUMNS = [
  'request_uid', 'created_at', 'source', 'run_id', 'attempt', 'is_hedge',
  'provider_id', 'provider_name', 'key_id', 'method', 'endpoint',
  'model_requested', 'model_returned', 'is_stream', 'status', 'http_status',
  'error_class', 'error_code', 'error_message', 'latency_ms', 'ttft_ms', 'first_byte_ms',
  'input_tokens', 'output_tokens', 'cached_tokens', 'cache_write_tokens', 'reasoning_tokens',
  'usage_source', 'cost_micros', 'price_json', 'has_body', 'meta_json',
  'user_id', 'token_id', 'subscription_id', 'client_ip',
];

const ROLLUP_KEYS = ['hour_start', 'provider_id', 'model_id', 'source'];
const ROLLUP_COUNTERS = [
  'requests', 'ok', 'cancelled', 'blocked', 'timeouts',
  'e_auth', 'e_rate_limit', 'e_quota', 'e_bad_request', 'e_server', 'e_network', 'e_other',
  'latency_sum_ms', 'latency_count',
  ...Array.from({ length: 14 }, (_, i) => `lb${i}`),
  'ttft_sum_ms', 'ttft_count',
  'input_tokens', 'output_tokens', 'cached_tokens', 'cost_micros',
];
const ERROR_CLASSES = new Set(['auth', 'rate_limit', 'quota', 'bad_request', 'server', 'network', 'other']);

// Plain addition on conflict: every counter is a sum.
const ROLLUP_SQL = `INSERT INTO usage_hourly (${[...ROLLUP_KEYS, ...ROLLUP_COUNTERS].join(', ')})
  VALUES (${[...ROLLUP_KEYS, ...ROLLUP_COUNTERS].map(() => '?').join(', ')})
  ON CONFLICT (hour_start, provider_id, model_id, source) DO UPDATE SET
  ${ROLLUP_COUNTERS.map((c) => `${c} = ${c} + excluded.${c}`).join(', ')}`;

// What one row adds to its hour's roll-up.
function rollupDelta(row) {
  const d = {
    hour_start: Math.floor(row.created_at / HOUR) * HOUR,
    provider_id: row.provider_id || '',
    model_id: row.model_requested || '',
    source: row.source || 'other',
  };
  ROLLUP_COUNTERS.forEach((c) => {
    d[c] = 0;
  });
  d.requests = 1;
  if (row.status === 'ok') d.ok = 1;
  else if (row.status === 'cancelled') d.cancelled = 1;
  else if (row.status === 'blocked') d.blocked = 1;
  else if (row.status === 'timeout') d.timeouts = 1;
  else d[`e_${ERROR_CLASSES.has(row.error_class) ? row.error_class : 'other'}`] = 1;
  // Latency only for an answer that came back: ok or error with an HTTP
  // status. A timeout, a network failure, a cancel or a block says nothing
  // about how fast the model answers.
  const answered = (row.status === 'ok' || row.status === 'error')
    && Number.isInteger(row.http_status) && row.error_class !== 'network' && Number.isFinite(row.latency_ms);
  if (answered) {
    d.latency_sum_ms = row.latency_ms;
    d.latency_count = 1;
    d[`lb${latencyBucket(row.latency_ms)}`] = 1;
  }
  if (row.is_stream && Number.isFinite(row.ttft_ms)) {
    d.ttft_sum_ms = row.ttft_ms;
    d.ttft_count = 1;
  }
  d.input_tokens = row.input_tokens || 0;
  d.output_tokens = row.output_tokens || 0;
  d.cached_tokens = row.cached_tokens || 0;
  d.cost_micros = row.cost_micros || 0;
  return d;
}

// Positional values for ROW_COLUMNS. better-sqlite3 binds no booleans and an
// explicit NULL skips a column's DEFAULT, so the flag columns are set here.
function rowValues(row, hasBody) {
  return ROW_COLUMNS.map((c) => {
    if (c === 'has_body') return hasBody ? 1 : 0;
    if (c === 'is_hedge' || c === 'is_stream') return row[c] ? 1 : 0;
    if (c === 'attempt') return Number.isInteger(row.attempt) && row.attempt > 0 ? row.attempt : 1;
    return row[c] === undefined ? null : row[c];
  });
}

function createWriter(db, {
  log = console, now = Date.now, flushMs = 250, batchMax = 500, queueCap = 10000,
  setTimer = setTimeout, clearTimer = clearTimeout, initialDropped = 0,
} = {}) {
  const insertRow = db.prepare(`INSERT INTO request_logs (${ROW_COLUMNS.join(', ')}) VALUES (${ROW_COLUMNS.map(() => '?').join(', ')})`);
  const insertBody = db.prepare(`INSERT INTO request_bodies
    (log_id, created_at, request_headers_json, request_body, response_body, truncated) VALUES (?, ?, ?, ?, ?, ?)`);
  const upsertRollup = db.prepare(ROLLUP_SQL);
  const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

  let queue = [];
  let timer = null;
  let stopped = false;
  let dropped = Number.isInteger(initialDropped) && initialDropped > 0 ? initialDropped : 0;
  // The count as last written to meta: mirrored with the next batch that commits.
  let mirrored = dropped;
  let lastWarnAt = -Infinity;

  const writeBatch = db.transaction((batch) => {
    batch.forEach(({ row, body }) => {
      const id = Number(insertRow.run(rowValues(row, !!body)).lastInsertRowid);
      if (body) {
        insertBody.run(id, row.created_at, body.request_headers_json ?? null, body.request_body ?? null,
          body.response_body ?? null, body.truncated ? 1 : 0);
      }
      const delta = rollupDelta(row);
      upsertRollup.run([...ROLLUP_KEYS, ...ROLLUP_COUNTERS].map((c) => delta[c]));
    });
    if (dropped !== mirrored) setMeta.run('dropped_rows', String(dropped));
  });

  function noteDropped(n, err) {
    dropped += n;
    const t = now();
    if (t - lastWarnAt < WARN_EVERY_MS) return;
    lastWarnAt = t;
    try {
      log.error(`Request log: dropped ${n} record(s)${err && err.message ? ` (${err.message})` : ''}; ${dropped} dropped so far`);
    } catch (_) {
      // A failing logger must not reach api-request either.
    }
  }

  function flush() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (queue.length === 0) return 0;
    const batch = queue;
    queue = [];
    try {
      writeBatch(batch);
      mirrored = dropped;
      return batch.length;
    } catch (err) {
      noteDropped(batch.length, err);
      return 0;
    }
  }

  function add(row, body = null) {
    try {
      queue.push({ row, body });
      if (queue.length > queueCap) {
        const over = queue.length - queueCap;
        queue.splice(0, over);
        noteDropped(over, new Error('the queue is full'));
      }
      if (queue.length >= batchMax) flush();
      else if (timer === null && !stopped) timer = setTimer(flush, flushMs);
    } catch (err) {
      noteDropped(1, err);
    }
  }

  function stop() {
    stopped = true;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  return { add, flush, stop, noteDropped, droppedRows: () => dropped, queued: () => queue.length };
}

module.exports = { createWriter, rollupDelta, ROW_COLUMNS, ROLLUP_KEYS, ROLLUP_COUNTERS };
```

- [ ] **Step 5: Run it to see it pass**

Run: `npm test -- test/logs/writer.test.js`
Expected: `# pass 10`, `# fail 0`.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: `# pass 169`, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/logs/writer.js test/helpers.js test/logs/writer.test.js
git commit -m "feat(logs): batched writer with hourly roll-ups and a dropped counter"
```

---

### Task 5: `retention.js` — chunked purge, stepped vacuum, scheduler

**Files:**
- Create: `src/logs/retention.js`
- Test: `test/logs/retention.test.js`

**Interfaces:**
- Consumes: `migratedLogsDb`, `countRows`, `fakeTimers`, `tempDir` (Tasks 1, 4); `ROLLUP_COUNTERS` (Task 4); `require('../src/logs/migrations')`.
- Produces:
  - `purge(db, { now, logRetentionDays, bodyRetentionDays, statsRetentionMonths, meta, chunk = 1000, yieldFn, vacuumPages = 2000 }) → Promise<{ rows, bodies, rollups } | null>` (null when the db closed under it). `meta` needs `set(key, value)`.
  - `purgeLogsBefore(db, cutoff, { chunk, yieldFn }) → Promise<{ rows, bodies }>`; `purgeBodiesBefore(db, cutoff, opts) → Promise<{ bodies }>`; `purgeRollupsBefore(db, hourCutoff, opts) → Promise<{ rollups }>` (deletes `hour_start < hourCutoff`); `stepVacuum(db, { pages, yieldFn })`.
  - `monthsAgo(now, months) → ms` (calendar months, UTC).
  - `createPurgeScheduler({ run, isBusy, log, firstDelayMs = 30000, everyMs = 86400000, retryMs = 60000, setTimer, clearTimer }) → { start(), stop(), isRunning() }`.

- [ ] **Step 1: Write the failing test `test/logs/retention.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Database = require('better-sqlite3');
const MIGRATIONS = require('../../src/logs/migrations');
const { ROLLUP_COUNTERS } = require('../../src/logs/writer');
const { purge, monthsAgo, createPurgeScheduler } = require('../../src/logs/retention');
const { migratedLogsDb, countRows, fakeTimers, tempDir, quietLog } = require('../helpers');

const DAY = 86400000;
const HOUR = 3600000;
const NOW = Date.UTC(2026, 8, 26);
const LIMITS = { logRetentionDays: 90, bodyRetentionDays: 7, statsRetentionMonths: 12 };
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fakeMeta() {
  return { values: {}, set(key, value) { this.values[key] = value; } };
}

function seed(db, n, createdAt, { body = false, prefix = 'S' } = {}) {
  const row = db.prepare("INSERT INTO request_logs (request_uid, created_at, source, method, endpoint, status, has_body) VALUES (?, ?, 'other', 'GET', 'https://x.test/y', 'ok', ?)");
  const b = db.prepare('INSERT INTO request_bodies (log_id, created_at, response_body) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (let i = 0; i < n; i += 1) {
      const id = Number(row.run(`${prefix}-${createdAt}-${i}`, createdAt, body ? 1 : 0).lastInsertRowid);
      if (body) b.run(id, createdAt, 'x');
    }
  })();
}

function rollup(db, hourStart) {
  const cols = ['hour_start', 'provider_id', 'model_id', 'source', ...ROLLUP_COUNTERS];
  db.prepare(`INSERT INTO usage_hourly (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(hourStart, 'p', 'm', 'other', ...ROLLUP_COUNTERS.map(() => 1));
}

test('rows older than the limit go with their bodies, a chunk at a time', async (t) => {
  const db = migratedLogsDb(t);
  seed(db, 2500, NOW - 91 * DAY, { body: true, prefix: 'old' });
  seed(db, 10, NOW - 1 * DAY, { body: true, prefix: 'new' });
  let yields = 0;
  const out = await purge(db, { now: NOW, ...LIMITS, meta: fakeMeta(), yieldFn: async () => { yields += 1; } });
  assert.deepStrictEqual(out, { rows: 2500, bodies: 2500, rollups: 0 });
  assert.strictEqual(countRows(db, 'request_logs'), 10);
  assert.strictEqual(countRows(db, 'request_bodies'), 10);
  assert.ok(yields >= 2, `yielded ${yields} times`);
});

test('bodies older than their limit go and has_body is cleared; the rows stay', async (t) => {
  const db = migratedLogsDb(t);
  seed(db, 5, NOW - 10 * DAY, { body: true });
  const out = await purge(db, { now: NOW, ...LIMITS, meta: fakeMeta() });
  assert.deepStrictEqual(out, { rows: 0, bodies: 5, rollups: 0 });
  assert.strictEqual(countRows(db, 'request_logs'), 5);
  assert.strictEqual(countRows(db, 'request_bodies'), 0);
  assert.strictEqual(db.prepare('SELECT SUM(has_body) AS n FROM request_logs').get().n, 0);
});

test('roll-ups older than the stats limit go', async (t) => {
  const db = migratedLogsDb(t);
  const limit = monthsAgo(NOW, 12);
  rollup(db, limit - HOUR);
  rollup(db, limit);
  const out = await purge(db, { now: NOW, ...LIMITS, meta: fakeMeta() });
  assert.strictEqual(out.rollups, 1);
  assert.deepStrictEqual(db.prepare('SELECT hour_start FROM usage_hourly').all().map((r) => r.hour_start), [limit]);
});

test('last_purge_at is recorded and the freed pages are handed back', async (t) => {
  const dir = tempDir(t);
  const db = new Database(path.join(dir, 'purge.db'));
  t.after(() => { if (db.open) db.close(); });
  db.pragma('auto_vacuum = INCREMENTAL');
  db.pragma('journal_mode = WAL');
  MIGRATIONS.forEach((m) => m.up(db));
  seed(db, 3000, NOW - 100 * DAY, { body: true });
  const meta = fakeMeta();
  await purge(db, { now: NOW, ...LIMITS, meta });
  assert.strictEqual(db.pragma('freelist_count', { simple: true }), 0);
  assert.strictEqual(meta.values.last_purge_at, NOW);
});

test('purge lets other work run between chunks', async (t) => {
  const db = migratedLogsDb(t);
  seed(db, 5000, NOW - 100 * DAY);
  const seen = [];
  let done = false;
  const watch = () => {
    if (done) return;
    seen.push(countRows(db, 'request_logs'));
    setImmediate(watch);
  };
  setImmediate(watch);
  await purge(db, { now: NOW, ...LIMITS, meta: fakeMeta() });
  done = true;
  assert.ok(seen.some((n) => n > 0 && n < 5000), `the watcher saw ${[...new Set(seen)].join(', ')}`);
});

test('closing the database mid-purge ends it without throwing', async (t) => {
  const db = migratedLogsDb(t);
  seed(db, 5000, NOW - 100 * DAY);
  let calls = 0;
  const out = await purge(db, {
    now: NOW, ...LIMITS, meta: fakeMeta(),
    yieldFn: async () => {
      calls += 1;
      if (calls === 1) db.close();
    },
  });
  assert.strictEqual(out, null);
  assert.strictEqual(db.open, false);
});

test('monthsAgo counts calendar months in UTC', () => {
  assert.strictEqual(monthsAgo(Date.UTC(2026, 8, 26, 12), 12), Date.UTC(2025, 8, 26, 12));
  assert.strictEqual(monthsAgo(Date.UTC(2026, 1, 15), 3), Date.UTC(2025, 10, 15));
});

test('scheduler: first run 30 s after start, then every 24 h', async () => {
  const timers = fakeTimers();
  let runs = 0;
  const s = createPurgeScheduler({ run: async () => { runs += 1; }, ...timers, log: quietLog });
  s.start();
  assert.deepStrictEqual(timers.delays(), [30000]);
  timers.fire();
  await settle();
  assert.strictEqual(runs, 1);
  assert.deepStrictEqual(timers.delays(), [86400000]);
});

test('scheduler: defers while requests are in flight', async () => {
  const timers = fakeTimers();
  let runs = 0;
  let busy = true;
  const s = createPurgeScheduler({ run: async () => { runs += 1; }, isBusy: () => busy, ...timers, log: quietLog });
  s.start();
  timers.fire();
  await settle();
  assert.strictEqual(runs, 0);
  assert.deepStrictEqual(timers.delays(), [60000]);
  busy = false;
  timers.fire();
  await settle();
  assert.strictEqual(runs, 1);
});

test('scheduler: a failing run is logged and the schedule goes on; stop() cancels the next run', async () => {
  const timers = fakeTimers();
  const warnings = [];
  const s = createPurgeScheduler({
    run: async () => { throw new Error('boom'); },
    ...timers,
    log: { ...quietLog, warn: (...a) => warnings.push(a.join(' ')) },
  });
  s.start();
  timers.fire();
  await settle();
  assert.match(warnings[0], /boom/);
  assert.deepStrictEqual(timers.delays(), [86400000]);
  s.stop();
  assert.deepStrictEqual(timers.delays(), []);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- test/logs/retention.test.js`
Expected: FAIL — `Cannot find module '../../src/logs/retention'`.

- [ ] **Step 3: Write `src/logs/retention.js`**

```js
// ============================================
// Request log retention — chunked purge, stepped vacuum
// ============================================
// better-sqlite3 runs on the main thread, so one DELETE of a month of rows
// would freeze the window. Every delete here takes at most `chunk` rows,
// picked by a fresh short query each time (no iterator is held across a
// yield), and the event loop runs between chunks. A database closed
// mid-purge (the app quitting) ends the purge quietly.
const DAY = 86400000;
const CHUNK = 1000;
const VACUUM_PAGES = 2000;
const defaultYield = () => new Promise((resolve) => setImmediate(resolve));

// Runs step() (one chunk, one transaction, returns the rows it took) until a
// chunk comes back short or the database is gone.
async function inChunks(db, step, chunk, yieldFn) {
  let total = 0;
  while (db.open) {
    const n = step();
    total += n;
    if (n < chunk) break;
    await yieldFn();
  }
  return total;
}

async function purgeLogsBefore(db, cutoff, { chunk = CHUNK, yieldFn = defaultYield } = {}) {
  const pick = 'SELECT id FROM request_logs WHERE created_at < ? ORDER BY created_at, id LIMIT ?';
  const deleteBodies = db.prepare(`DELETE FROM request_bodies WHERE log_id IN (${pick})`);
  const deleteRows = db.prepare(`DELETE FROM request_logs WHERE id IN (${pick})`);
  let bodies = 0;
  const step = db.transaction(() => {
    bodies += deleteBodies.run(cutoff, chunk).changes;
    return deleteRows.run(cutoff, chunk).changes;
  });
  const rows = await inChunks(db, step, chunk, yieldFn);
  return { rows, bodies };
}

async function purgeBodiesBefore(db, cutoff, { chunk = CHUNK, yieldFn = defaultYield } = {}) {
  const pick = 'SELECT log_id FROM request_bodies WHERE created_at < ? ORDER BY created_at, log_id LIMIT ?';
  const clearFlag = db.prepare(`UPDATE request_logs SET has_body = 0 WHERE id IN (${pick})`);
  const deleteBodies = db.prepare(`DELETE FROM request_bodies WHERE log_id IN (${pick})`);
  const step = db.transaction(() => {
    clearFlag.run(cutoff, chunk);
    return deleteBodies.run(cutoff, chunk).changes;
  });
  return { bodies: await inChunks(db, step, chunk, yieldFn) };
}

async function purgeRollupsBefore(db, hourCutoff, { chunk = CHUNK, yieldFn = defaultYield } = {}) {
  const del = db.prepare(`DELETE FROM usage_hourly WHERE rowid IN
    (SELECT rowid FROM usage_hourly WHERE hour_start < ? ORDER BY hour_start LIMIT ?)`);
  return { rollups: await inChunks(db, () => del.run(hourCutoff, chunk).changes, chunk, yieldFn) };
}

// Hands freed pages back to the file system a few thousand at a time. Only
// an INCREMENTAL database can (auto_vacuum is set when the file is created).
async function stepVacuum(db, { pages = VACUUM_PAGES, yieldFn = defaultYield, maxSteps = 10000 } = {}) {
  if (!db.open || db.pragma('auto_vacuum', { simple: true }) !== 2) return;
  const n = Math.max(1, Math.floor(pages));
  for (let i = 0; i < maxSteps && db.open; i += 1) {
    if (db.pragma('freelist_count', { simple: true }) === 0) return;
    db.pragma(`incremental_vacuum(${n})`);
    await yieldFn();
  }
}

function monthsAgo(now, months) {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.getTime();
}

// One retention pass (spec §3): old rows with their bodies, old bodies, old
// roll-ups, then the freed pages and the WAL.
async function purge(db, {
  now = Date.now(), logRetentionDays, bodyRetentionDays, statsRetentionMonths, meta,
  chunk = CHUNK, yieldFn = defaultYield, vacuumPages = VACUUM_PAGES,
}) {
  if (!db.open) return null;
  const opts = { chunk, yieldFn };
  const logs = await purgeLogsBefore(db, now - logRetentionDays * DAY, opts);
  if (!db.open) return null;
  const bodies = await purgeBodiesBefore(db, now - bodyRetentionDays * DAY, opts);
  if (!db.open) return null;
  const rollups = await purgeRollupsBefore(db, monthsAgo(now, statsRetentionMonths), opts);
  if (!db.open) return null;
  await stepVacuum(db, { pages: vacuumPages, yieldFn });
  if (!db.open) return null;
  db.pragma('wal_checkpoint(TRUNCATE)');
  meta.set('last_purge_at', now);
  return { rows: logs.rows, bodies: logs.bodies + bodies.bodies, rollups: rollups.rollups };
}

// 30 s after startup, then every 24 h. While requests are in flight the run
// waits another minute: a purge chunk would sit between them and the log.
function createPurgeScheduler({
  run, isBusy = () => false, log = console,
  firstDelayMs = 30000, everyMs = DAY, retryMs = 60000,
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let timer = null;
  let stopped = false;
  let running = false;

  function schedule(ms) {
    if (stopped) return;
    timer = setTimer(tick, ms);
  }

  async function tick() {
    timer = null;
    if (stopped) return;
    if (isBusy()) {
      schedule(retryMs);
      return;
    }
    running = true;
    try {
      await run();
    } catch (err) {
      log.warn('Request log purge failed:', err && err.message);
    } finally {
      running = false;
    }
    schedule(everyMs);
  }

  return {
    start: () => schedule(firstDelayMs),
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    isRunning: () => running,
  };
}

module.exports = {
  purge, purgeLogsBefore, purgeBodiesBefore, purgeRollupsBefore, stepVacuum, monthsAgo, createPurgeScheduler,
};
```

- [ ] **Step 4: Run it to see it pass**

Run: `npm test -- test/logs/retention.test.js`
Expected: `# pass 10`, `# fail 0`.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: `# pass 179`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/logs/retention.js test/logs/retention.test.js
git commit -m "feat(logs): chunked retention purge, stepped vacuum and purge scheduler"
```

---

### Task 6: `query.js` — list, get, stats, facets, run summary, export, info, clear

**Files:**
- Create: `src/logs/query.js`
- Test: `test/logs/query.test.js`

**Interfaces:**
- Consumes: `approxP95` (Task 2); `createWriter`, `ROW_COLUMNS`, `ROLLUP_COUNTERS` (Task 4); `purgeLogsBefore`, `purgeRollupsBefore`, `stepVacuum` (Task 5); `migratedLogsDb`, `logRow`, `countRows`, `tempDir` (Task 1).
- Produces:
  - `createMeta(db) → { get(key) → string|null, set(key, value) }`.
  - `createQuery(db, { file, meta, droppedRows }) →`
    - `list(filters, cursor, limit) → { rows, nextCursor: { createdAt, id } | null }` — newest first, keyset on `(created_at, id)`, `limit` default 50, max 200. Filters: `from`, `to`, `source[]`, `providerId[]`, `model`, `status[]`, `runId`, `text`, `afterId`.
    - `get(id) → row & { body: { request_headers_json, request_body, response_body, truncated } | null } | null`.
    - `stats(filters, bucket = 'hour', groupBy = 'none') → { totals: Summary, series: [{ bucket, group, ...Summary }] | [{ bucket, group, count }] }`. `bucket` ∈ `hour|day` (day = local `YYYY-MM-DD`), `groupBy` ∈ `none|source|provider|model|error_class`. `Summary = { requests, ok, okPct, errors, errorRate, errorsByClass: { auth, rate_limit, quota, bad_request, server, network, other, timeout }, cancelled, blocked, timeouts, avgLatencyMs, p95LatencyMs, p95Overflow, avgTtftMs, inputTokens, outputTokens, cachedTokens, costMicros }`.
    - `facets({ from, to }) → { providers: [{ id, name }], models: [string], sources: [string] }`.
    - `runSummary(runId) → { runId, count, ok, cancelled, errorsByClass (9 classes), models, providers, costMicros, firstAt, lastAt, medianLatencyMs }`.
    - `exportTo(file, filters, format) → Promise<rowsWritten>`; `format` ∈ `csv|json`.
    - `info() → { enabled: true, error: null, path, sizeBytes, rows, oldestAt, droppedRows, lastPurgeAt }`.
    - `clear({ before } = {}) → Promise<{ rows, bodies, rollups }>`.
  - `emptyStats()`, `emptyRunSummary(runId)` (the answers when logging is off), `EXPORT_COLUMNS`.

- [ ] **Step 1: Write the failing test `test/logs/query.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createWriter } = require('../../src/logs/writer');
const { createQuery, createMeta } = require('../../src/logs/query');
const { migratedLogsDb, logRow, countRows, tempDir, quietLog } = require('../helpers');

const HOUR = 3600000;
const T0 = Date.UTC(2026, 8, 20, 12);
const hourOf = (ms) => Math.floor(ms / HOUR) * HOUR;

// entries: a row, or { row, body }.
function setup(t, entries) {
  const db = migratedLogsDb(t);
  const writer = createWriter(db, { log: quietLog, setTimer: () => null, clearTimer: () => {} });
  entries.forEach((e) => (e.row ? writer.add(e.row, e.body || null) : writer.add(e)));
  writer.flush();
  const meta = createMeta(db);
  const query = createQuery(db, { file: ':memory:', meta, droppedRows: () => 3 });
  return { db, query, meta };
}

test('list: newest first; the cursor neither skips nor repeats rows that share a time', (t) => {
  const times = [T0, T0 + 5, T0 + 5, T0 + 5, T0 + 9, T0 + 1, T0 + 5];
  const { query } = setup(t, times.map((created_at) => logRow({ created_at })));
  const all = query.list({}, null, 200).rows.map((r) => [r.created_at, r.id]);
  const expected = [...all].sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  assert.deepStrictEqual(all, expected);
  assert.strictEqual(all.length, 7);
  const paged = [];
  let cursor = null;
  do {
    const page = query.list({}, cursor, 2);
    paged.push(...page.rows.map((r) => [r.created_at, r.id]));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepStrictEqual(paged, expected);
});

test('list: limit defaults to 50 and is capped at 200', (t) => {
  const { query } = setup(t, Array.from({ length: 250 }, () => logRow()));
  assert.strictEqual(query.list({}, null, 1000).rows.length, 200);
  assert.strictEqual(query.list({}).rows.length, 50);
  assert.strictEqual(query.list({}, null, 0).rows.length, 50);
  assert.strictEqual(query.list(null, null, 'x').rows.length, 50);
});

test('list filters: time range, source, provider, model, status, run id', (t) => {
  const { query } = setup(t, [
    logRow({ created_at: T0, source: 'route_test', provider_id: 'nara', model_requested: 'm1', status: 'ok', run_id: 'RUN1' }),
    logRow({ created_at: T0 + 1000, source: 'health', provider_id: 'mirai', model_requested: null, status: 'error', error_class: 'auth' }),
    logRow({ created_at: T0 + 2000, source: 'benchmark', provider_id: 'nara', model_requested: 'm2', status: 'timeout', error_class: 'timeout', run_id: 'RUN2' }),
  ]);
  const at = (filters) => query.list(filters).rows.map((r) => r.created_at - T0).sort((a, b) => a - b);
  assert.deepStrictEqual(at({ from: T0 + 1000 }), [1000, 2000]);
  assert.deepStrictEqual(at({ to: T0 + 1000 }), [0]);
  assert.deepStrictEqual(at({ source: ['health', 'benchmark'] }), [1000, 2000]);
  assert.deepStrictEqual(at({ providerId: ['nara'] }), [0, 2000]);
  assert.deepStrictEqual(at({ model: 'm2' }), [2000]);
  assert.deepStrictEqual(at({ status: ['error', 'timeout'] }), [1000, 2000]);
  assert.deepStrictEqual(at({ runId: 'RUN1' }), [0]);
  assert.deepStrictEqual(at({ source: ['route_test'], providerId: ['mirai'] }), []);
});

test('list text search: uid, run id and error message; % and _ are literal', (t) => {
  const { query } = setup(t, [
    logRow({ request_uid: 'UIDALPHA', error_message: '100% done' }),
    logRow({ request_uid: 'UIDBETA', error_message: 'a_b' }),
    logRow({ request_uid: 'UIDGAMMA', error_message: 'axb', run_id: 'RUN-XYZ' }),
  ]);
  const msgs = (text) => query.list({ text }).rows.map((r) => r.error_message).sort();
  assert.deepStrictEqual(msgs('%'), ['100% done']);
  assert.deepStrictEqual(msgs('_'), ['a_b']);
  assert.deepStrictEqual(msgs('a_b'), ['a_b']);
  assert.deepStrictEqual(msgs('beta'), ['a_b']);
  assert.deepStrictEqual(msgs('xyz'), ['axb']);
  assert.deepStrictEqual(msgs('   '), ['100% done', 'a_b', 'axb']);
});

test('filter arrays are capped at 50 items', (t) => {
  const { query } = setup(t, [logRow({ source: 'health' })]);
  const many = Array.from({ length: 60 }, (_, i) => `s${i}`);
  many[55] = 'health';
  assert.strictEqual(query.list({ source: many }).rows.length, 0);
  many[10] = 'health';
  assert.strictEqual(query.list({ source: many }).rows.length, 1);
});

test('afterId returns only newer rows (live tail)', (t) => {
  const { query } = setup(t, [logRow(), logRow(), logRow()]);
  const ids = query.list({}).rows.map((r) => r.id);
  assert.deepStrictEqual(query.list({ afterId: ids[2] }).rows.map((r) => r.id), [ids[0], ids[1]]);
});

test('get: the row with its body, or null', (t) => {
  const { query } = setup(t, [
    { row: logRow({ request_uid: 'WITHBODY' }), body: { request_headers_json: '{}', request_body: 'req', response_body: 'res', truncated: 0 } },
    logRow({ request_uid: 'NOBODY' }),
  ]);
  const [withBody] = query.list({ text: 'WITHBODY' }).rows;
  const full = query.get(withBody.id);
  assert.strictEqual(full.request_uid, 'WITHBODY');
  assert.deepStrictEqual({ ...full.body }, { request_headers_json: '{}', request_body: 'req', response_body: 'res', truncated: 0 });
  const [plain] = query.list({ text: 'NOBODY' }).rows;
  assert.strictEqual(query.get(plain.id).body, null);
  assert.strictEqual(query.get(99999), null);
  assert.strictEqual(query.get('1'), null);
});

test('stats totals: ok %, errors by class, average and p95 latency, TTFT, tokens and cost', (t) => {
  const same = { created_at: T0, provider_id: 'nara', model_requested: 'm1', source: 'route_test' };
  const none = { input_tokens: null, output_tokens: null, cost_micros: null };
  const { query } = setup(t, [
    ...Array.from({ length: 18 }, () => logRow({ ...same, latency_ms: 800 })),
    logRow({ ...same, latency_ms: 4000, is_stream: 1, ttft_ms: 1200 }),
    logRow({ ...same, ...none, status: 'error', error_class: 'server', http_status: 500, latency_ms: 200 }),
    logRow({ ...same, ...none, status: 'error', error_class: 'auth', http_status: 401, latency_ms: 100 }),
    logRow({ ...same, ...none, status: 'timeout', error_class: 'timeout', http_status: null }),
    logRow({ ...same, ...none, status: 'cancelled', error_class: null, http_status: null }),
    logRow({ ...same, ...none, status: 'blocked', error_class: 'blocked', http_status: null }),
  ]);
  const { totals } = query.stats({}, 'hour', 'none');
  assert.deepStrictEqual(
    [totals.requests, totals.ok, totals.cancelled, totals.blocked, totals.timeouts, totals.errors],
    [24, 19, 1, 1, 1, 3],
  );
  assert.ok(Math.abs(totals.okPct - (19 * 100) / 22) < 1e-9);
  assert.ok(Math.abs(totals.errorRate - 3 / 22) < 1e-9);
  assert.deepStrictEqual(totals.errorsByClass, { auth: 1, rate_limit: 0, quota: 0, bad_request: 0, server: 1, network: 0, other: 0, timeout: 1 });
  // 21 answered: 18 × 800, 4000, 200, 100.
  assert.strictEqual(totals.avgLatencyMs, Math.round((18 * 800 + 4000 + 200 + 100) / 21));
  assert.deepStrictEqual([totals.p95LatencyMs, totals.p95Overflow], [1000, false]);
  assert.strictEqual(totals.avgTtftMs, 1200);
  assert.deepStrictEqual([totals.inputTokens, totals.outputTokens, totals.costMicros], [190, 38, 760]);

  const slow = setup(t, [logRow({ created_at: T0, latency_ms: 200000 })]).query.stats({}).totals;
  assert.deepStrictEqual([slow.p95LatencyMs, slow.p95Overflow], [120000, true]);
});

test('stats by hour and by local day, grouped by source, provider or model', (t) => {
  const noon = new Date(2026, 8, 20, 12).getTime();
  const { query } = setup(t, [
    logRow({ created_at: noon, source: 'route_test', provider_id: 'nara', model_requested: 'm1' }),
    logRow({ created_at: noon + HOUR, source: 'health', provider_id: 'nara', model_requested: 'm1' }),
    logRow({ created_at: noon + 24 * HOUR, source: 'health', provider_id: 'mirai', model_requested: 'm2' }),
  ]);
  const view = (series) => series.map((s) => [s.bucket, s.group, s.requests]);
  assert.deepStrictEqual(view(query.stats({}, 'hour', 'none').series), [
    [hourOf(noon), null, 1], [hourOf(noon + HOUR), null, 1], [hourOf(noon + 24 * HOUR), null, 1],
  ]);
  assert.deepStrictEqual(view(query.stats({}, 'day', 'source').series), [
    ['2026-09-20', 'route_test', 1], ['2026-09-20', 'health', 1], ['2026-09-21', 'health', 1],
  ]);
  assert.deepStrictEqual(view(query.stats({}, 'day', 'provider').series), [['2026-09-20', 'nara', 2], ['2026-09-21', 'mirai', 1]]);
  assert.deepStrictEqual(view(query.stats({ providerId: ['nara'] }, 'hour', 'model').series), [
    [hourOf(noon), 'm1', 1], [hourOf(noon + HOUR), 'm1', 1],
  ]);
  assert.strictEqual(query.stats({ source: ['health'] }).totals.requests, 2);
  assert.strictEqual(query.stats({ model: 'm2' }).totals.requests, 1);
  assert.strictEqual(query.stats({ from: hourOf(noon + HOUR) }).totals.requests, 2);
  assert.strictEqual(query.stats({ to: hourOf(noon + HOUR) }).totals.requests, 1);
});

test('stats grouped by error_class counts each class per bucket', (t) => {
  const { query } = setup(t, [
    logRow({ created_at: T0, status: 'error', error_class: 'auth', http_status: 401 }),
    logRow({ created_at: T0, status: 'error', error_class: 'auth', http_status: 403 }),
    logRow({ created_at: T0, status: 'error', error_class: 'server', http_status: 502 }),
    logRow({ created_at: T0, status: 'timeout', error_class: 'timeout', http_status: null }),
    logRow({ created_at: T0, status: 'blocked', error_class: 'blocked', http_status: null }),
    logRow({ created_at: T0 }),
  ]);
  const series = query.stats({}, 'hour', 'error_class').series;
  assert.deepStrictEqual(series.map((s) => [s.bucket, s.group, s.count]), [
    [T0, 'auth', 2], [T0, 'server', 1], [T0, 'timeout', 1], [T0, 'blocked', 1],
  ]);
});

test('stats refuses an unknown bucket or groupBy', (t) => {
  const { query } = setup(t, []);
  assert.throws(() => query.stats({}, 'week'), /Unknown bucket/);
  assert.throws(() => query.stats({}, 'hour', 'key'), /Unknown groupBy/);
});

test('facets: providers with their latest name, models and sources in the range', (t) => {
  const { query } = setup(t, [
    logRow({ created_at: T0, provider_id: 'nara', provider_name: 'Nara (old)', model_requested: 'm1', source: 'route_test' }),
    logRow({ created_at: T0 + 10, provider_id: 'nara', provider_name: 'NaraRouter', model_requested: 'm2', source: 'health' }),
    logRow({ created_at: T0 + 20, provider_id: null, provider_name: null, model_requested: null, source: 'leaderboard' }),
    logRow({ created_at: T0 + 100000, provider_id: 'mirai', provider_name: 'Mirai', model_requested: 'm3', source: 'benchmark' }),
  ]);
  assert.deepStrictEqual(query.facets({ from: T0, to: T0 + 1000 }), {
    providers: [{ id: 'nara', name: 'NaraRouter' }],
    models: ['m1', 'm2'],
    sources: ['health', 'leaderboard', 'route_test'],
  });
  assert.deepStrictEqual(query.facets({}).providers.map((p) => p.id), ['mirai', 'nara']);
});

test('runSummary: counts, classes, models, providers, cost, first/last and median latency', (t) => {
  const run = (o) => logRow({ run_id: 'RUNA', ...o });
  const { query } = setup(t, [
    run({ created_at: T0, latency_ms: 300, model_requested: 'm1', cost_micros: 20 }),
    run({ created_at: T0 + 10, latency_ms: 500, model_requested: 'm2', cost_micros: 30 }),
    run({ created_at: T0 + 20, status: 'error', error_class: 'server', http_status: 502, latency_ms: 100, model_requested: 'm2', cost_micros: null }),
    run({ created_at: T0 + 30, status: 'error', error_class: 'network', http_status: null, latency_ms: 9000, cost_micros: null }),
    run({ created_at: T0 + 40, status: 'cancelled', http_status: null, latency_ms: 50, cost_micros: null }),
    logRow({ run_id: 'OTHER', created_at: T0 }),
  ]);
  assert.deepStrictEqual(query.runSummary('RUNA'), {
    runId: 'RUNA', count: 5, ok: 2, cancelled: 1,
    errorsByClass: { auth: 0, rate_limit: 0, quota: 0, bad_request: 0, server: 1, network: 1, other: 0, timeout: 0, blocked: 0 },
    models: ['m1', 'm2'], providers: ['nara'], costMicros: 50, firstAt: T0, lastAt: T0 + 40, medianLatencyMs: 300,
  });
  const empty = query.runSummary('NONE');
  assert.deepStrictEqual([empty.count, empty.costMicros, empty.medianLatencyMs, empty.firstAt], [0, null, null, null]);
  assert.throws(() => query.runSummary(''), /run id/);
});

test('exportTo writes CSV and JSON of the filtered rows in chunks; formula-like cells are defused', async (t) => {
  const dir = tempDir(t);
  const { query } = setup(t, [
    logRow({ created_at: T0, source: 'health', error_message: '=HYPERLINK("x")' }),
    logRow({ created_at: T0 + 1, source: 'health', error_message: 'plain, with "quotes"' }),
    logRow({ created_at: T0 + 2, source: 'route_test' }),
  ]);
  const csv = path.join(dir, 'out.csv');
  assert.strictEqual(await query.exportTo(csv, { source: ['health'] }, 'csv'), 2);
  const lines = fs.readFileSync(csv, 'utf8').trimEnd().split('\r\n');
  assert.strictEqual(lines.length, 3);
  assert.ok(lines[0].startsWith('id,request_uid,created_at,source,'));
  assert.ok(lines[1].includes('"plain, with ""quotes"""'));
  assert.ok(lines[2].includes(`"'=HYPERLINK(""x"")"`));

  const json = path.join(dir, 'out.json');
  assert.strictEqual(await query.exportTo(json, { source: ['health'] }, 'json'), 2);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(json, 'utf8')).map((r) => r.error_message), ['plain, with "quotes"', '=HYPERLINK("x")']);

  const empty = path.join(dir, 'empty.json');
  assert.strictEqual(await query.exportTo(empty, { source: ['nothing'] }, 'json'), 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(empty, 'utf8')), []);
  await assert.rejects(query.exportTo(path.join(dir, 'x.xml'), {}, 'xml'), /Unknown export format/);

  const big = setup(t, Array.from({ length: 2100 }, (_, i) => logRow({ created_at: T0 + i })));
  const bigFile = path.join(dir, 'big.json');
  assert.strictEqual(await big.query.exportTo(bigFile, {}, 'json'), 2100);
  assert.strictEqual(new Set(JSON.parse(fs.readFileSync(bigFile, 'utf8')).map((r) => r.id)).size, 2100);
});

test('info: rows, oldest, dropped, last purge', (t) => {
  const { query, meta } = setup(t, [logRow({ created_at: T0 + 5 }), logRow({ created_at: T0 })]);
  assert.strictEqual(query.info().lastPurgeAt, null);
  meta.set('last_purge_at', 1234);
  assert.deepStrictEqual(query.info(), {
    enabled: true, error: null, path: ':memory:', sizeBytes: 0, rows: 2, oldestAt: T0, droppedRows: 3, lastPurgeAt: 1234,
  });
});

test('clear with before deletes older rows, bodies and fully covered roll-ups; without it, everything', async (t) => {
  const body = { request_headers_json: '{}', request_body: 'q', response_body: 'r', truncated: 0 };
  const { db, query } = setup(t, [
    { row: logRow({ created_at: T0 - 2 * HOUR }), body },
    { row: logRow({ created_at: T0 - 10 }), body },
    { row: logRow({ created_at: T0 + 10 }), body },
  ]);
  assert.deepStrictEqual(await query.clear({ before: T0 }), { rows: 2, bodies: 2, rollups: 2 });
  assert.deepStrictEqual([countRows(db, 'request_logs'), countRows(db, 'request_bodies'), countRows(db, 'usage_hourly')], [1, 1, 1]);
  assert.deepStrictEqual(await query.clear(), { rows: 1, bodies: 1, rollups: 1 });
  assert.deepStrictEqual([countRows(db, 'request_logs'), countRows(db, 'request_bodies'), countRows(db, 'usage_hourly')], [0, 0, 0]);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- test/logs/query.test.js`
Expected: FAIL — `Cannot find module '../../src/logs/query'`.

- [ ] **Step 3: Write `src/logs/query.js`**

```js
// ============================================
// Request log queries — what the log pages (sub-project C) read
// ============================================
// Read-only except exportTo and clear. Lists page with a keyset on
// (created_at, id), never OFFSET, so the fortieth page costs what the first
// does. Charts read usage_hourly, never the raw rows. Failures throw: an
// empty result always means there was nothing to find.
const fs = require('fs');
const { approxP95 } = require('./classify');
const { ROW_COLUMNS, ROLLUP_COUNTERS } = require('./writer');
const { purgeLogsBefore, purgeRollupsBefore, stepVacuum } = require('./retention');

const HOUR = 3600000;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const MAX_FILTER_ITEMS = 50;
const EXPORT_CHUNK = 1000;
const EVERYTHING = Number.MAX_SAFE_INTEGER;
const EXPORT_COLUMNS = ['id', ...ROW_COLUMNS];
const LIKE = "LIKE ? ESCAPE '\\'";
// Each error class and the roll-up counter that holds it.
const CLASS_COUNTERS = {
  auth: 'e_auth', rate_limit: 'e_rate_limit', quota: 'e_quota', bad_request: 'e_bad_request',
  server: 'e_server', network: 'e_network', other: 'e_other', timeout: 'timeouts', blocked: 'blocked',
};
const GROUP_COLUMNS = { none: null, source: 'source', provider: 'provider_id', model: 'model_id' };
const defaultYield = () => new Promise((resolve) => setImmediate(resolve));

const finite = (v) => (Number.isFinite(v) ? v : null);
const nonEmpty = (v) => (typeof v === 'string' && v !== '' ? v : null);
const items = (list) => (Array.isArray(list) ? list.filter((v) => typeof v === 'string' && v !== '').slice(0, MAX_FILTER_ITEMS) : []);
const escapeLike = (text) => text.replace(/[\\%_]/g, (c) => `\\${c}`);
const whereSql = (parts) => (parts.length ? `WHERE ${parts.join(' AND ')}` : '');
const pad = (n) => String(n).padStart(2, '0');

// The local calendar date of an hour: grouping hours by it is DST-safe (a
// 23- or 25-hour day is still one day).
function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function clampLimit(limit) {
  const n = Number(limit);
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;
}

function createMeta(db) {
  const get = db.prepare('SELECT value FROM meta WHERE key = ?');
  const set = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  return {
    get: (key) => {
      const row = get.get(key);
      return row ? row.value : null;
    },
    set: (key, value) => {
      set.run(key, String(value));
    },
  };
}

function conditions() {
  const where = [];
  const params = [];
  return {
    where,
    params,
    add(sql, ...values) {
      where.push(sql);
      params.push(...values);
    },
    inList(column, values) {
      if (values.length) this.add(`${column} IN (${values.map(() => '?').join(', ')})`, ...values);
    },
  };
}

function rowFilters(filters) {
  const f = filters && typeof filters === 'object' ? filters : {};
  const c = conditions();
  if (finite(f.from) !== null) c.add('created_at >= ?', f.from);
  if (finite(f.to) !== null) c.add('created_at < ?', f.to);
  c.inList('source', items(f.source));
  c.inList('provider_id', items(f.providerId));
  c.inList('status', items(f.status));
  if (nonEmpty(f.model)) c.add('model_requested = ?', f.model);
  if (nonEmpty(f.runId)) c.add('run_id = ?', f.runId);
  const text = nonEmpty(f.text) ? f.text.trim().slice(0, 200) : '';
  if (text) {
    const p = `%${escapeLike(text)}%`;
    c.add(`(request_uid ${LIKE} OR run_id ${LIKE} OR error_message ${LIKE})`, p, p, p);
  }
  if (Number.isInteger(f.afterId)) c.add('id > ?', f.afterId);
  return c;
}

function emptyCounters() {
  const acc = {};
  ROLLUP_COUNTERS.forEach((col) => {
    acc[col] = 0;
  });
  return acc;
}

function addCounters(acc, row) {
  ROLLUP_COUNTERS.forEach((col) => {
    acc[col] += row[col];
  });
}

function summarize(a) {
  const attempted = a.requests - a.cancelled - a.blocked;
  const errors = attempted - a.ok;
  const p95 = approxP95(Array.from({ length: 14 }, (_, i) => a[`lb${i}`]), a.latency_count);
  const errorsByClass = {};
  Object.entries(CLASS_COUNTERS).forEach(([cls, col]) => {
    if (cls !== 'blocked') errorsByClass[cls] = a[col];
  });
  return {
    requests: a.requests,
    ok: a.ok,
    okPct: attempted > 0 ? (a.ok * 100) / attempted : null,
    errors,
    errorRate: attempted > 0 ? errors / attempted : null,
    errorsByClass,
    cancelled: a.cancelled,
    blocked: a.blocked,
    timeouts: a.timeouts,
    avgLatencyMs: a.latency_count ? Math.round(a.latency_sum_ms / a.latency_count) : null,
    p95LatencyMs: p95 ? p95.ms : null,
    p95Overflow: p95 ? p95.overflow : false,
    avgTtftMs: a.ttft_count ? Math.round(a.ttft_sum_ms / a.ttft_count) : null,
    inputTokens: a.input_tokens,
    outputTokens: a.output_tokens,
    cachedTokens: a.cached_tokens,
    costMicros: a.cost_micros,
  };
}

function emptyStats() {
  return { totals: summarize(emptyCounters()), series: [] };
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function summarizeRun(runId, rows) {
  const errorsByClass = {};
  Object.keys(CLASS_COUNTERS).forEach((cls) => {
    errorsByClass[cls] = 0;
  });
  let ok = 0;
  let cancelled = 0;
  let cost = null;
  const models = new Set();
  const providers = new Set();
  const latencies = [];
  rows.forEach((r) => {
    if (r.status === 'ok') ok += 1;
    else if (r.status === 'cancelled') cancelled += 1;
    else if (r.error_class in errorsByClass) errorsByClass[r.error_class] += 1;
    if (r.model_requested) models.add(r.model_requested);
    if (r.provider_id) providers.add(r.provider_id);
    if (Number.isFinite(r.cost_micros)) cost = (cost || 0) + r.cost_micros;
    const answered = (r.status === 'ok' || r.status === 'error') && Number.isInteger(r.http_status) && r.error_class !== 'network';
    if (answered && Number.isFinite(r.latency_ms)) latencies.push(r.latency_ms);
  });
  return {
    runId,
    count: rows.length,
    ok,
    cancelled,
    errorsByClass,
    models: [...models].sort(),
    providers: [...providers].sort(),
    costMicros: cost,
    firstAt: rows.length ? rows[0].created_at : null,
    lastAt: rows.length ? rows[rows.length - 1].created_at : null,
    medianLatencyMs: median(latencies),
  };
}

function emptyRunSummary(runId) {
  return summarizeRun(runId, []);
}

// A spreadsheet opens a cell that starts like a formula as one, and error
// text comes from providers.
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function fileSize(file) {
  if (!file || file === ':memory:') return 0;
  return ['', '-wal'].reduce((sum, suffix) => {
    try {
      return sum + fs.statSync(file + suffix).size;
    } catch (_) {
      return sum;
    }
  }, 0);
}

function createQuery(db, { file = null, meta, droppedRows = () => 0 } = {}) {
  // Filters make the SQL vary; each distinct statement is prepared once.
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };

  function page(filters, cursor, limit) {
    const c = rowFilters(filters);
    if (cursor && Number.isFinite(cursor.createdAt) && Number.isInteger(cursor.id)) {
      c.add('(created_at < ? OR (created_at = ? AND id < ?))', cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const rows = stmt(`SELECT * FROM request_logs ${whereSql(c.where)} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...c.params, limit);
    const last = rows[rows.length - 1];
    return { rows, nextCursor: rows.length === limit ? { createdAt: last.created_at, id: last.id } : null };
  }

  function list(filters, cursor, limit) {
    return page(filters, cursor, clampLimit(limit));
  }

  function get(id) {
    if (!Number.isInteger(id)) return null;
    const row = stmt('SELECT * FROM request_logs WHERE id = ?').get(id);
    if (!row) return null;
    const body = stmt('SELECT request_headers_json, request_body, response_body, truncated FROM request_bodies WHERE log_id = ?').get(id);
    return { ...row, body: body || null };
  }

  function stats(filters, bucket = 'hour', groupBy = 'none') {
    if (bucket !== 'hour' && bucket !== 'day') throw new TypeError(`Unknown bucket "${bucket}"`);
    if (groupBy !== 'error_class' && !Object.prototype.hasOwnProperty.call(GROUP_COLUMNS, groupBy)) {
      throw new TypeError(`Unknown groupBy "${groupBy}"`);
    }
    const f = filters && typeof filters === 'object' ? filters : {};
    const c = conditions();
    if (finite(f.from) !== null) c.add('hour_start >= ?', Math.floor(f.from / HOUR) * HOUR);
    if (finite(f.to) !== null) c.add('hour_start < ?', f.to);
    c.inList('source', items(f.source));
    c.inList('provider_id', items(f.providerId));
    if (nonEmpty(f.model)) c.add('model_id = ?', f.model);
    const rows = stmt(`SELECT * FROM usage_hourly ${whereSql(c.where)} ORDER BY hour_start`).all(...c.params);

    const totals = emptyCounters();
    const series = new Map();
    rows.forEach((r) => {
      addCounters(totals, r);
      const b = bucket === 'day' ? localDay(r.hour_start) : r.hour_start;
      if (groupBy === 'error_class') {
        Object.entries(CLASS_COUNTERS).forEach(([cls, col]) => {
          if (!r[col]) return;
          const key = `${b}|${cls}`;
          const e = series.get(key) || { bucket: b, group: cls, count: 0 };
          e.count += r[col];
          series.set(key, e);
        });
        return;
      }
      const g = GROUP_COLUMNS[groupBy] ? r[GROUP_COLUMNS[groupBy]] : null;
      const key = `${b}|${g}`;
      if (!series.has(key)) series.set(key, { bucket: b, group: g, acc: emptyCounters() });
      addCounters(series.get(key).acc, r);
    });
    return {
      totals: summarize(totals),
      series: [...series.values()].map((e) => (e.acc ? { bucket: e.bucket, group: e.group, ...summarize(e.acc) } : e)),
    };
  }

  function facets(range) {
    const r = range && typeof range === 'object' ? range : {};
    const c = conditions();
    if (finite(r.from) !== null) c.add('created_at >= ?', r.from);
    if (finite(r.to) !== null) c.add('created_at < ?', r.to);
    const also = (extra) => whereSql([...c.where, extra]);
    // SQLite takes the bare provider_name from the row holding MAX(created_at):
    // the latest name a provider had in the range.
    const providers = stmt(`SELECT provider_id AS id, provider_name AS name, MAX(created_at) AS last_at FROM request_logs
      ${also('provider_id IS NOT NULL')} GROUP BY provider_id ORDER BY provider_id`).all(...c.params)
      .map(({ id, name }) => ({ id, name }));
    const models = stmt(`SELECT DISTINCT model_requested AS id FROM request_logs ${also('model_requested IS NOT NULL')} ORDER BY model_requested`)
      .all(...c.params).map((x) => x.id);
    const sources = stmt(`SELECT DISTINCT source FROM request_logs ${whereSql(c.where)} ORDER BY source`)
      .all(...c.params).map((x) => x.source);
    return { providers, models, sources };
  }

  function runSummary(runId) {
    if (!nonEmpty(runId)) throw new TypeError('A run id is needed');
    const rows = stmt(`SELECT created_at, status, error_class, model_requested, provider_id, cost_micros, latency_ms, http_status
      FROM request_logs WHERE run_id = ? ORDER BY created_at, id`).all(runId);
    return summarizeRun(runId, rows);
  }

  // Written a keyset page at a time, yielding between pages, so a large
  // export never holds the main thread for long.
  async function exportTo(target, filters, format, { yieldFn = defaultYield } = {}) {
    if (format !== 'csv' && format !== 'json') throw new TypeError(`Unknown export format "${format}"`);
    const fd = fs.openSync(target, 'w');
    let written = 0;
    try {
      fs.writeSync(fd, format === 'csv' ? `${EXPORT_COLUMNS.join(',')}\r\n` : '[');
      let cursor = null;
      do {
        const p = page(filters, cursor, EXPORT_CHUNK);
        if (p.rows.length) {
          const text = format === 'csv'
            ? `${p.rows.map((r) => EXPORT_COLUMNS.map((col) => csvCell(r[col])).join(',')).join('\r\n')}\r\n`
            : `${written === 0 ? '\n' : ',\n'}${p.rows.map((r) => JSON.stringify(r)).join(',\n')}`;
          fs.writeSync(fd, text);
          written += p.rows.length;
        }
        cursor = p.nextCursor;
        if (cursor) await yieldFn();
      } while (cursor);
      if (format === 'json') fs.writeSync(fd, '\n]\n');
    } finally {
      fs.closeSync(fd);
    }
    return written;
  }

  function info() {
    const { rows, oldest } = stmt('SELECT COUNT(*) AS rows, MIN(created_at) AS oldest FROM request_logs').get();
    const last = Number(meta.get('last_purge_at'));
    return {
      enabled: true,
      error: null,
      path: file,
      sizeBytes: fileSize(file),
      rows,
      oldestAt: oldest,
      droppedRows: droppedRows(),
      lastPurgeAt: Number.isFinite(last) && last > 0 ? last : null,
    };
  }

  // Rows (and their bodies) older than `before`, and the roll-ups whose whole
  // hour lies before it (hour_start + 1 h <= before); everything when omitted.
  async function clear(opts, { yieldFn = defaultYield } = {}) {
    const before = opts && Number.isFinite(opts.before) ? opts.before : null;
    const logs = await purgeLogsBefore(db, before === null ? EVERYTHING : before, { yieldFn });
    const rollups = await purgeRollupsBefore(db, before === null ? EVERYTHING : before - HOUR + 1, { yieldFn });
    await stepVacuum(db, { yieldFn });
    return { rows: logs.rows, bodies: logs.bodies, rollups: rollups.rollups };
  }

  return { list, get, stats, facets, runSummary, exportTo, info, clear };
}

module.exports = { createQuery, createMeta, emptyStats, emptyRunSummary, EXPORT_COLUMNS };
```

- [ ] **Step 4: Run it to see it pass**

Run: `npm test -- test/logs/query.test.js`
Expected: `# pass 16`, `# fail 0`.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: `# pass 195`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/logs/query.js test/logs/query.test.js
git commit -m "feat(logs): query API - keyset list, stats from roll-ups, facets, runs, export, clear"
```

---

### Task 7: `index.js` — open, pragmas, migrate, tryOpen, close

**Files:**
- Create: `src/logs/index.js`
- Modify: `test/helpers.js` (add `logsStore`)
- Test: `test/logs/open.test.js`

**Interfaces:**
- Consumes: `MIGRATIONS` (Task 1), `createWriter` (Task 4), `createQuery`, `createMeta` (Task 6).
- Produces:
  - `open(dir, { log, migrations, writerOptions }) → { db, file, migration: { from, to }, writer, repos: { meta, query }, close() }` (throws on failure; `dir === ':memory:'` for tests). `close()` = writer.stop → writer.flush → `wal_checkpoint(TRUNCATE)` → db.close; idempotent.
  - `tryOpen(dir, opts) → { logs, error: null } | { logs: null, error }` (never throws).
  - `LOGS_FILE = 'venom-logs.db'`, `LogsTooNewError` (`code: 'LOGS_DB_TOO_NEW'`), `migrate`, `MIGRATIONS`.
  - test helper `logsStore(t, opts)` → opened `:memory:` logs, closed after the test.

- [ ] **Step 1: Add `logsStore` to `test/helpers.js`**

In `test/helpers.js` replace:
```js
module.exports = {
  quietLog, fakeSafeStorage, fakeCipher, encFake, LOCKED_BLOB, tempDir, memoryStore,
  migratedLogsDb, logRow, countRows, fakeTimers,
};
```
with:
```js
// An opened in-memory request log (src/logs), closed after the test.
function logsStore(t, opts = {}) {
  const logs = require('../src/logs').open(':memory:', { log: quietLog, ...opts });
  t.after(() => logs.close());
  return logs;
}

module.exports = {
  quietLog, fakeSafeStorage, fakeCipher, encFake, LOCKED_BLOB, tempDir, memoryStore,
  migratedLogsDb, logRow, countRows, fakeTimers, logsStore,
};
```

- [ ] **Step 2: Write the failing test `test/logs/open.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const logsDb = require('../../src/logs');
const { quietLog, tempDir, logsStore, logRow } = require('../helpers');

const opts = { log: quietLog };

test('open(":memory:") wires the writer, meta and the query API on schema v1', (t) => {
  const logs = logsStore(t);
  assert.strictEqual(logs.db.pragma('user_version', { simple: true }), 1);
  assert.deepStrictEqual(logs.migration, { from: 0, to: 1 });
  logs.writer.add(logRow({ request_uid: 'WIRED' }));
  logs.writer.flush();
  assert.strictEqual(logs.repos.query.list({}).rows[0].request_uid, 'WIRED');
  logs.repos.meta.set('k', 5);
  assert.strictEqual(logs.repos.meta.get('k'), '5');
});

test('pragmas on a new file: WAL, NORMAL, busy timeout, temp store, incremental auto-vacuum', (t) => {
  const dir = tempDir(t);
  const logs = logsDb.open(dir, opts);
  try {
    assert.strictEqual(logs.file, path.join(dir, 'venom-logs.db'));
    assert.strictEqual(logs.db.pragma('journal_mode', { simple: true }), 'wal');
    assert.strictEqual(logs.db.pragma('synchronous', { simple: true }), 1);
    assert.strictEqual(logs.db.pragma('busy_timeout', { simple: true }), 5000);
    assert.strictEqual(logs.db.pragma('temp_store', { simple: true }), 2);
    assert.strictEqual(logs.db.pragma('auto_vacuum', { simple: true }), 2);
    assert.ok(logs.repos.query.info().sizeBytes > 0);
  } finally {
    logs.close();
  }
});

test('reopening an up-to-date file runs no migration', (t) => {
  const dir = tempDir(t);
  logsDb.open(dir, opts).close();
  const logs = logsDb.open(dir, opts);
  try {
    assert.deepStrictEqual(logs.migration, { from: 1, to: 1 });
  } finally {
    logs.close();
  }
});

test('a migration that throws rolls back and leaves the version', (t) => {
  const dir = tempDir(t);
  logsDb.open(dir, opts).close();
  const broken = [...logsDb.MIGRATIONS, {
    version: 2,
    up(db) { db.exec('CREATE TABLE half_done (x INTEGER)'); throw new Error('migration bug'); },
  }];
  assert.throws(() => logsDb.open(dir, { ...opts, migrations: broken }), /migration bug/);
  const logs = logsDb.open(dir, opts);
  try {
    assert.strictEqual(logs.db.pragma('user_version', { simple: true }), 1);
    assert.strictEqual(logs.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'half_done'").get().n, 0);
  } finally {
    logs.close();
  }
});

test('downgrade guard: a newer schema is refused and the file is not written', (t) => {
  const dir = tempDir(t);
  const first = logsDb.open(dir, opts);
  first.db.pragma('user_version = 9');
  first.close();
  const file = path.join(dir, 'venom-logs.db');
  const before = fs.readFileSync(file);
  assert.throws(() => logsDb.open(dir, opts), (err) => err.code === 'LOGS_DB_TOO_NEW');
  assert.strictEqual(Buffer.compare(before, fs.readFileSync(file)), 0);
});

test('tryOpen: a corrupt file turns logging off and is left as it was', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'venom-logs.db');
  const garbage = Buffer.alloc(4096, 0x41);
  fs.writeFileSync(file, garbage);
  const out = logsDb.tryOpen(dir, opts);
  assert.strictEqual(out.logs, null);
  assert.match(out.error.message, /not a database/);
  assert.strictEqual(Buffer.compare(garbage, fs.readFileSync(file)), 0);
});

test('tryOpen: a newer schema turns logging off with the reason', (t) => {
  const dir = tempDir(t);
  const first = logsDb.open(dir, opts);
  first.db.pragma('user_version = 9');
  first.close();
  const out = logsDb.tryOpen(dir, opts);
  assert.strictEqual(out.logs, null);
  assert.strictEqual(out.error.code, 'LOGS_DB_TOO_NEW');
  assert.match(out.error.message, /schema version 9/);
});

test('close() flushes queued rows before closing', (t) => {
  const dir = tempDir(t);
  const logs = logsDb.open(dir, opts);
  logs.writer.add(logRow({ request_uid: 'QUEUED' }));
  assert.strictEqual(logs.writer.queued(), 1);
  logs.close();
  logs.close();
  const db = new Database(path.join(dir, 'venom-logs.db'), { readonly: true });
  try {
    assert.deepStrictEqual(db.prepare('SELECT request_uid FROM request_logs').all().map((r) => r.request_uid), ['QUEUED']);
  } finally {
    db.close();
  }
});

test('the dropped count survives a reopen', (t) => {
  const dir = tempDir(t);
  const first = logsDb.open(dir, opts);
  first.writer.noteDropped(4, new Error('simulated'));
  first.writer.add(logRow());
  first.close();
  const second = logsDb.open(dir, opts);
  try {
    assert.strictEqual(second.writer.droppedRows(), 4);
    assert.strictEqual(second.repos.query.info().droppedRows, 4);
  } finally {
    second.close();
  }
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npm test -- test/logs/open.test.js`
Expected: FAIL — `Cannot find module '../../src/logs'`.

- [ ] **Step 4: Write `src/logs/index.js`**

```js
// ============================================
// Request log — venom-logs.db
// ============================================
// Every outbound request the app makes, one row each, in its own file next to
// venom.db and on its own connection. Not critical data: nothing is backed up
// before a migration, and a file that can't be opened turns logging off for
// the session (tryOpen) instead of stopping the app.
//
// Nothing here loads electron, so the layer runs under plain Node in tests.
const path = require('path');
const Database = require('better-sqlite3');
const MIGRATIONS = require('./migrations');
const { createWriter } = require('./writer');
const { createQuery, createMeta } = require('./query');

const LOGS_FILE = 'venom-logs.db';

class LogsTooNewError extends Error {
  constructor(found, known) {
    super(`venom-logs.db is at schema version ${found}; this build knows up to ${known}`);
    this.name = 'LogsTooNewError';
    this.code = 'LOGS_DB_TOO_NEW';
  }
}

function latestVersion(migrations) {
  return migrations.reduce((max, m) => Math.max(max, m.version), 0);
}

// Each pending migration runs in its own transaction with its version bump,
// so a failure leaves the file at the last version that fully applied.
function migrate(db, migrations = MIGRATIONS) {
  const from = db.pragma('user_version', { simple: true });
  const to = latestVersion(migrations);
  if (from > to) throw new LogsTooNewError(from, to);
  migrations
    .filter((m) => m.version > from)
    .sort((a, b) => a.version - b.version)
    .forEach((m) => {
      db.transaction(() => {
        m.up(db);
        db.pragma(`user_version = ${m.version}`);
      })();
    });
  return { from, to };
}

// dir is the app data folder, or ':memory:' in tests. Throws on any failure.
function open(dir, { log = console, migrations = MIGRATIONS, writerOptions = {} } = {}) {
  const file = dir === ':memory:' ? ':memory:' : path.join(dir, LOGS_FILE);
  const db = new Database(file);
  try {
    // The version is read before any pragma that writes (journal_mode=WAL
    // rewrites the header at once), so a newer schema is refused untouched.
    db.pragma('busy_timeout = 5000');
    const found = db.pragma('user_version', { simple: true });
    const known = latestVersion(migrations);
    if (found > known) throw new LogsTooNewError(found, known);
    // auto_vacuum can only be chosen before the first table exists.
    // INCREMENTAL lets the purge hand pages back a few thousand at a time.
    if (db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get().n === 0) db.pragma('auto_vacuum = INCREMENTAL');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('temp_store = MEMORY');
    const migration = migrate(db, migrations);
    const meta = createMeta(db);
    const writer = createWriter(db, { log, initialDropped: Number(meta.get('dropped_rows')) || 0, ...writerOptions });
    const query = createQuery(db, { file, meta, droppedRows: () => writer.droppedRows() });
    let closed = false;
    // Flush timer, synchronous flush, then the file (the spec's will-quit order).
    function close() {
      if (closed) return;
      closed = true;
      writer.stop();
      writer.flush();
      if (!db.open) return;
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
      } catch (_) {
        // Already failing: close anyway.
      }
      db.close();
    }
    return { db, file, migration, writer, repos: { meta, query }, close };
  } catch (err) {
    try {
      db.close();
    } catch (_) {
      // Already unusable.
    }
    throw err;
  }
}

// open() that never throws: the caller turns logging off with the error.
function tryOpen(dir, options = {}) {
  try {
    return { logs: open(dir, options), error: null };
  } catch (err) {
    return { logs: null, error: err };
  }
}

module.exports = { open, tryOpen, migrate, LOGS_FILE, MIGRATIONS, LogsTooNewError };
```

- [ ] **Step 5: Run it to see it pass**

Run: `npm test -- test/logs/open.test.js`
Expected: `# pass 9`, `# fail 0`.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: `# pass 204`, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/logs/index.js test/helpers.js test/logs/open.test.js
git commit -m "feat(logs): open venom-logs.db with its own pragmas and migrations; tryOpen never throws"
```

---

### Task 8: `logs/ipc.js` — the eight `logs-*` channels

**Files:**
- Create: `src/logs/ipc.js`
- Test: `test/logs/ipc.test.js`

**Interfaces:**
- Consumes: `logs.repos.query` (Task 6/7), `emptyStats`, `emptyRunSummary` (Task 6), `logsStore`, `logRow`, `tempDir` (Tasks 1, 7).
- Produces: `registerLogsIpc({ ipcMain, getState: () => ({ logs, error }), dialog, getWindow = () => null, log })` registering `logs-list(filters, cursor, limit)`, `logs-get(id)`, `logs-stats(filters, bucket, groupBy)`, `logs-facets(range)`, `logs-run-summary(runId)`, `logs-export(filters, format) → { saved, path, rows }`, `logs-info()`, `logs-clear(opts) → { rows, bodies, rollups }`. With `logs` null: `logs-info` → `{ enabled: false, error, path: null, sizeBytes: 0, rows: 0, oldestAt: null, droppedRows: 0, lastPurgeAt: null }`, other reads empty, export/clear do nothing. `LOGS_CHANNELS`.

- [ ] **Step 1: Write the failing test `test/logs/ipc.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { registerLogsIpc } = require('../../src/logs/ipc');
const { logsStore, logRow, tempDir, quietLog } = require('../helpers');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle(channel, fn) {
      if (handlers.has(channel)) throw new Error(`Registered twice: ${channel}`);
      handlers.set(channel, fn);
    },
    invoke: async (channel, ...args) => handlers.get(channel)({}, ...args),
    channels: () => [...handlers.keys()].sort(),
  };
}

function setup({ logs = null, error = null, pick = { canceled: true, filePath: '' } } = {}) {
  const ipc = fakeIpcMain();
  const errors = [];
  const dialog = {
    next: pick,
    calls: [],
    showSaveDialog(...args) {
      this.calls.push(args[args.length - 1]);
      return Promise.resolve(this.next);
    },
  };
  registerLogsIpc({
    ipcMain: ipc, getState: () => ({ logs, error }), dialog, getWindow: () => null,
    log: { ...quietLog, error: (...a) => errors.push(a.join(' ')) },
  });
  return { ipc, dialog, errors };
}

test('registers exactly the log channels', () => {
  assert.deepStrictEqual(setup().ipc.channels(), [
    'logs-clear', 'logs-export', 'logs-facets', 'logs-get', 'logs-info', 'logs-list', 'logs-run-summary', 'logs-stats',
  ]);
});

test('with logging on, the reads answer from the database', async (t) => {
  const logs = logsStore(t);
  logs.writer.add(logRow({ request_uid: 'IPC1', run_id: 'RUN1' }));
  logs.writer.flush();
  const { ipc } = setup({ logs });
  const page = await ipc.invoke('logs-list', {}, null, 10);
  assert.strictEqual(page.rows.length, 1);
  assert.strictEqual((await ipc.invoke('logs-get', page.rows[0].id)).request_uid, 'IPC1');
  const info = await ipc.invoke('logs-info');
  assert.deepStrictEqual([info.enabled, info.rows], [true, 1]);
  assert.strictEqual((await ipc.invoke('logs-stats', {}, 'hour', 'none')).totals.requests, 1);
  assert.deepStrictEqual((await ipc.invoke('logs-facets', {})).sources, ['route_test']);
  assert.strictEqual((await ipc.invoke('logs-run-summary', 'RUN1')).count, 1);
  assert.deepStrictEqual(await ipc.invoke('logs-clear', {}), { rows: 1, bodies: 0, rollups: 1 });
});

test('with logging off: info says why, reads are empty, export and clear do nothing', async () => {
  const { ipc, dialog } = setup({ logs: null, error: 'file is not a database' });
  assert.deepStrictEqual(await ipc.invoke('logs-info'), {
    enabled: false, error: 'file is not a database', path: null, sizeBytes: 0, rows: 0, oldestAt: null, droppedRows: 0, lastPurgeAt: null,
  });
  assert.deepStrictEqual(await ipc.invoke('logs-list', {}, null, 10), { rows: [], nextCursor: null });
  assert.strictEqual(await ipc.invoke('logs-get', 1), null);
  const stats = await ipc.invoke('logs-stats', {}, 'hour', 'none');
  assert.deepStrictEqual([stats.totals.requests, stats.series], [0, []]);
  assert.deepStrictEqual(await ipc.invoke('logs-facets', {}), { providers: [], models: [], sources: [] });
  const run = await ipc.invoke('logs-run-summary', 'RUN1');
  assert.deepStrictEqual([run.runId, run.count], ['RUN1', 0]);
  assert.deepStrictEqual(await ipc.invoke('logs-export', {}, 'csv'), { saved: false, path: null, rows: 0 });
  assert.deepStrictEqual(await ipc.invoke('logs-clear', {}), { rows: 0, bodies: 0, rollups: 0 });
  assert.strictEqual(dialog.calls.length, 0);
});

test('export: CSV to the chosen file; a cancelled dialog saves nothing; an unknown format is refused before any dialog', async (t) => {
  const dir = tempDir(t);
  const logs = logsStore(t);
  logs.writer.add(logRow());
  logs.writer.add(logRow());
  logs.writer.flush();
  const file = path.join(dir, 'export.csv');
  const { ipc, dialog } = setup({ logs, pick: { canceled: false, filePath: file } });
  assert.deepStrictEqual(await ipc.invoke('logs-export', {}, 'csv'), { saved: true, path: file, rows: 2 });
  assert.ok(fs.readFileSync(file, 'utf8').startsWith('id,request_uid,'));
  assert.match(dialog.calls[0].defaultPath, /^venom-requests-\d{4}-\d{2}-\d{2}\.csv$/);
  dialog.next = { canceled: true, filePath: '' };
  assert.deepStrictEqual(await ipc.invoke('logs-export', {}, 'json'), { saved: false, path: null, rows: 0 });
  await assert.rejects(ipc.invoke('logs-export', {}, 'xml'), /Unknown export format/);
  assert.strictEqual(dialog.calls.length, 2);
});

test('a failing query rejects the call and is logged', async (t) => {
  const logs = logsStore(t);
  const { ipc, errors } = setup({ logs });
  await assert.rejects(ipc.invoke('logs-stats', {}, 'week', 'none'), /Unknown bucket/);
  assert.match(errors[0], /logs-stats failed/);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- test/logs/ipc.test.js`
Expected: FAIL — `Cannot find module '../../src/logs/ipc'`.

- [ ] **Step 3: Write `src/logs/ipc.js`**

```js
// ============================================
// Request log IPC — what the log pages (sub-project C) call
// ============================================
// Registered whether or not logging is on. When the log database couldn't be
// opened, logs-info says why and every other read answers empty. A query
// that fails throws: the renderer's promise rejects and it says so.
const { emptyStats, emptyRunSummary } = require('./query');

const LOGS_CHANNELS = ['logs-list', 'logs-get', 'logs-stats', 'logs-facets', 'logs-run-summary', 'logs-export', 'logs-info', 'logs-clear'];
const NOT_SAVED = Object.freeze({ saved: false, path: null, rows: 0 });

function offInfo(error) {
  return {
    enabled: false,
    error: error ? String(error.message || error) : 'Request logging is off',
    path: null,
    sizeBytes: 0,
    rows: 0,
    oldestAt: null,
    droppedRows: 0,
    lastPurgeAt: null,
  };
}

function registerLogsIpc({ ipcMain, getState, dialog, getWindow = () => null, log = console }) {
  // on(query, ...args) when logging is on; off(error, ...args) when it isn't.
  const handle = (channel, on, off) => {
    ipcMain.handle(channel, async (_event, ...args) => {
      const { logs, error } = getState() || {};
      try {
        if (!logs) return off(error, ...args);
        return await on(logs.repos.query, ...args);
      } catch (err) {
        log.error(`${channel} failed:`, err.message);
        throw err;
      }
    });
  };

  handle('logs-list', (q, filters, cursor, limit) => q.list(filters, cursor, limit), () => ({ rows: [], nextCursor: null }));
  handle('logs-get', (q, id) => q.get(id), () => null);
  handle('logs-stats', (q, filters, bucket, groupBy) => q.stats(filters, bucket, groupBy), () => emptyStats());
  handle('logs-facets', (q, range) => q.facets(range), () => ({ providers: [], models: [], sources: [] }));
  handle('logs-run-summary', (q, runId) => q.runSummary(runId), (_error, runId) => emptyRunSummary(runId));
  handle('logs-export', async (q, filters, format) => {
    if (format !== 'csv' && format !== 'json') throw new TypeError(`Unknown export format "${format}"`);
    const options = {
      title: 'Export request log',
      defaultPath: `venom-requests-${new Date().toISOString().slice(0, 10)}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    };
    const win = getWindow();
    const pick = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (!pick || pick.canceled || !pick.filePath) return { ...NOT_SAVED };
    const rows = await q.exportTo(pick.filePath, filters, format);
    return { saved: true, path: pick.filePath, rows };
  }, () => ({ ...NOT_SAVED }));
  handle('logs-info', (q) => q.info(), (error) => offInfo(error));
  handle('logs-clear', (q, opts) => q.clear(opts), () => ({ rows: 0, bodies: 0, rollups: 0 }));
}

module.exports = { registerLogsIpc, LOGS_CHANNELS };
```

- [ ] **Step 4: Run it to see it pass**

Run: `npm test -- test/logs/ipc.test.js`
Expected: `# pass 5`, `# fail 0`.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: `# pass 209`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/logs/ipc.js test/logs/ipc.test.js
git commit -m "feat(logs): logs-* IPC channels, empty answers when logging is off"
```

---

# Phase 2 — Capturing every request in main

### Task 9: `resolve()` reports refs and substitutions

**Files:**
- Modify: `src/db/keys.js` (`createKeyResolver`)
- Test: `test/db/keys.test.js` (three existing assertions updated, five tests added)

**Interfaces:**
- Consumes: nothing new.
- Produces: `resolver.resolve({ url, headers, body })` →
  - success: `{ url, headers, body, refs: [{ kind: 'key' | 'secret', id, providerId }], substitutions: [{ placeholder, secret }] }` (both `[]` when nothing was substituted);
  - refusal: `{ blocked: true, error, refs: [refusedRef] }` — `providerId` is the key's own provider, or `null` for secrets and unknown keys (`id` = the token run as written).
  - `substitutions` carries real secrets; only the request log's scrubber may use it.

- [ ] **Step 1: Update the three existing assertions in `test/db/keys.test.js`**

Replace:
```js
  assert.deepStrictEqual(out, {
    url: `${NARA}/models`,
    headers: { Authorization: 'Bearer sk-nara-1', 'Content-Type': 'application/json' },
    body: undefined,
  });
```
with:
```js
  assert.deepStrictEqual(out, {
    url: `${NARA}/models`,
    headers: { Authorization: 'Bearer sk-nara-1', 'Content-Type': 'application/json' },
    body: undefined,
    refs: [{ kind: 'key', id: 'key_1', providerId: 'nara' }],
    substitutions: [{ placeholder: 'venomkey:key_1', secret: 'sk-nara-1' }],
  });
```

Replace:
```js
  assert.deepStrictEqual(resolver.resolve({ url: `${MIRAI}/models`, headers: auth }),
    { blocked: true, error: "Key blocked: api.miraiapi.com is not this key's provider" });
```
with:
```js
  assert.deepStrictEqual(resolver.resolve({ url: `${MIRAI}/models`, headers: auth }), {
    blocked: true,
    error: "Key blocked: api.miraiapi.com is not this key's provider",
    refs: [{ kind: 'key', id: 'key_1', providerId: 'nara' }],
  });
```

Replace:
```js
  assert.deepStrictEqual(resolver.resolve({ url: `${NARA}/models`, headers: { 'x-api-key': 'venomsecret:aaApiKey' } }),
    { blocked: true, error: "Key blocked: router.bynara.id is not this key's provider" });
```
with:
```js
  assert.deepStrictEqual(resolver.resolve({ url: `${NARA}/models`, headers: { 'x-api-key': 'venomsecret:aaApiKey' } }), {
    blocked: true,
    error: "Key blocked: router.bynara.id is not this key's provider",
    refs: [{ kind: 'secret', id: 'aaApiKey', providerId: null }],
  });
```

- [ ] **Step 2: Append the new tests to `test/db/keys.test.js`**

```js
test('resolve reports the key it used and its placeholder/secret pair, once', async (t) => {
  const { resolver } = await setup(t);
  const out = resolver.resolve({
    url: `${MIRAI}/usage?key=venomkey:key_m`,
    headers: { Authorization: 'Bearer venomkey:key_m' },
    body: JSON.stringify({ api_key: 'venomkey:key_m' }),
  });
  assert.deepStrictEqual(out.refs, [{ kind: 'key', id: 'key_m', providerId: 'mirai' }]);
  assert.deepStrictEqual(out.substitutions, [{ placeholder: 'venomkey:key_m', secret: TRICKY }]);
});

test('the Artificial Analysis key is reported as a secret ref', async (t) => {
  const { resolver } = await setup(t);
  const out = resolver.resolve({ url: 'https://artificialanalysis.ai/api/v2/data/llms/models', headers: { 'x-api-key': 'venomsecret:aaApiKey' } });
  assert.deepStrictEqual(out.refs, [{ kind: 'secret', id: 'aaApiKey', providerId: null }]);
  assert.deepStrictEqual(out.substitutions, [{ placeholder: 'venomsecret:aaApiKey', secret: 'aa-secret' }]);
});

test('two keys in one request are both reported, by their longest ids', async (t) => {
  const { resolver } = await setup(t);
  const out = resolver.resolve({ url: `${NARA}/m`, headers: { A: 'venomkey:key_1', B: 'venomkey:key_12' } });
  assert.deepStrictEqual(out.refs, [
    { kind: 'key', id: 'key_1', providerId: 'nara' },
    { kind: 'key', id: 'key_12', providerId: 'nara' },
  ]);
  assert.deepStrictEqual(out.substitutions, [
    { placeholder: 'venomkey:key_1', secret: 'sk-nara-1' },
    { placeholder: 'venomkey:key_12', secret: 'sk-nara-12' },
  ]);
});

test('a refusal names only the refused key or secret, with its provider when known', async (t) => {
  const { resolver } = await setup(t);
  assert.deepStrictEqual(resolver.resolve({ url: `${NARA}/m`, headers: { A: 'venomkey:nope' } }).refs,
    [{ kind: 'key', id: 'nope', providerId: null }]);
  assert.deepStrictEqual(resolver.resolve({ url: `${NARA}/m`, headers: { A: 'venomsecret:githubToken' } }).refs,
    [{ kind: 'secret', id: 'githubToken', providerId: null }]);
  assert.deepStrictEqual(resolver.resolve({ url: 'https://darkapi.dev/v1/m', headers: { A: 'venomkey:key_locked' } }).refs,
    [{ kind: 'key', id: 'key_locked', providerId: 'darkapi' }]);
  // key_1 was substituted before key_m was refused; only the refused one is named.
  const mixed = resolver.resolve({ url: `${NARA}/m`, headers: { A: 'venomkey:key_1', B: 'venomkey:key_m' } });
  assert.deepStrictEqual(mixed.refs, [{ kind: 'key', id: 'key_m', providerId: 'mirai' }]);
  assert.strictEqual(mixed.substitutions, undefined);
});

test('no placeholders: no refs and no substitutions', async (t) => {
  const { resolver } = await setup(t);
  const out = resolver.resolve({ url: `${NARA}/m`, headers: { A: 'plain' } });
  assert.deepStrictEqual([out.refs, out.substitutions], [[], []]);
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npm test -- test/db/keys.test.js`
Expected: FAIL — the three updated assertions and the five new tests fail (`refs`/`substitutions` missing), `# fail 8`.

- [ ] **Step 4: Rewrite `createKeyResolver` in `src/db/keys.js`**

Replace everything from the line `function createKeyResolver({ providers, secrets }) {` through the closing `}` right after `  return { resolve };` with:

```js
// What resolve() substituted: each ref once (kind + id), each placeholder
// once with its secret. The request log scrubs stored text with the pairs.
function collector() {
  const refs = [];
  const substitutions = [];
  const seenRefs = new Set();
  const seenPlaceholders = new Set();
  return {
    refs,
    substitutions,
    add(ref, placeholder, secret) {
      const key = `${ref.kind}:${ref.id}`;
      if (!seenRefs.has(key)) {
        seenRefs.add(key);
        refs.push(ref);
      }
      if (!seenPlaceholders.has(placeholder)) {
        seenPlaceholders.add(placeholder);
        substitutions.push({ placeholder, secret });
      }
    },
  };
}

function createKeyResolver({ providers, secrets }) {
  // A token's secret, resolved only after its one allowed origin is confirmed
  // to match the request's target — so a wrong-host request never reaches the
  // cipher. For keys the longest key id that starts the token wins, so
  // venomkey:key_12 is key_12, never key_1 followed by a "2". Every answer
  // names what it is about (ref), so the request log can say which key a
  // request used, or which one was refused.
  function lookup(kind, run, target) {
    if (kind === 'secret') {
      const ref = { kind: 'secret', id: run, providerId: null };
      if (!Object.prototype.hasOwnProperty.call(SECRET_ORIGINS, run)) return { error: `Key blocked: unknown secret "${run}"`, ref };
      if (!target || SECRET_ORIGINS[run] !== target) return { mismatch: true, ref };
      const secret = secrets.reveal(run);
      if (secret === null) return { error: `Key blocked: the ${run} secret is not set or can't be read on this machine`, ref };
      return { secret, used: run.length, ref };
    }
    for (let len = run.length; len > 0; len -= 1) {
      const record = providers.keyRecord(run.slice(0, len));
      if (!record) continue;
      const ref = { kind: 'key', id: record.id, providerId: record.providerId };
      if (!target || originOf(record.baseUrl) !== target) return { mismatch: true, ref };
      const secret = providers.revealKey(record.id);
      if (secret === null) return { error: `Key blocked: "${record.name}" can't be read on this machine`, ref };
      return { secret, used: len, ref };
    }
    return { error: `Key blocked: unknown key "${run}"`, ref: { kind: 'key', id: run, providerId: null } };
  }

  function substitute(text, target, host, encode, found) {
    let error = null;
    let refused = null;
    const out = text.replace(TOKEN, (match, kind, run) => {
      if (error) return match;
      const hit = lookup(kind, run, target);
      if (hit.mismatch || hit.error) {
        error = hit.mismatch ? `Key blocked: ${host} is not this key's provider` : hit.error;
        refused = hit.ref;
        return match;
      }
      found.add(hit.ref, `venom${kind}:${run.slice(0, hit.used)}`, hit.secret);
      return encode(hit.secret) + run.slice(hit.used);
    });
    return { text: out, error, refused };
  }

  const raw = (s) => s;
  const inJson = (s) => JSON.stringify(s).slice(1, -1);

  // { url, headers, body, refs, substitutions } ready to send, or
  // { blocked: true, error, refs: [the refused ref] }. substitutions holds the
  // secrets themselves: main hands it to the request log's scrubber and
  // nowhere else — never to a reply, a log line or a stored record.
  function resolve({ url, headers, body }) {
    const bodyText = body === undefined || body === null || body === '' || typeof body === 'string' ? body : JSON.stringify(body);
    const needed = HAS_TOKEN.test(String(url))
      || Object.values(headers || {}).some((v) => typeof v === 'string' && HAS_TOKEN.test(v))
      || (typeof bodyText === 'string' && HAS_TOKEN.test(bodyText));
    if (!needed) return { url, headers, body, refs: [], substitutions: [] };

    const target = originOf(url);
    let host = String(url);
    try {
      host = new URL(url).host;
    } catch (_) {
      // Unparsable: named as given.
    }
    const found = collector();
    const blocked = (hit) => ({ blocked: true, error: hit.error, refs: hit.refused ? [hit.refused] : [] });

    const u = substitute(String(url), target, host, encodeURIComponent, found);
    if (u.error) return blocked(u);
    const outHeaders = {};
    for (const [name, value] of Object.entries(headers || {})) {
      if (typeof value !== 'string') {
        outHeaders[name] = value;
        continue;
      }
      const h = substitute(value, target, host, raw, found);
      if (h.error) return blocked(h);
      outHeaders[name] = h.text;
    }
    let outBody = bodyText;
    if (typeof bodyText === 'string' && HAS_TOKEN.test(bodyText)) {
      let isJson = true;
      try {
        JSON.parse(bodyText);
      } catch (_) {
        isJson = false;
      }
      const b = substitute(bodyText, target, host, isJson ? inJson : raw, found);
      if (b.error) return blocked(b);
      outBody = b.text;
    }
    return { url: u.text, headers: outHeaders, body: outBody, refs: found.refs, substitutions: found.substitutions };
  }

  return { resolve };
}
```

- [ ] **Step 5: Run it to see it pass**

Run: `npm test -- test/db/keys.test.js`
Expected: `# pass 20`, `# fail 0`.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: `# pass 214`, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/db/keys.js test/db/keys.test.js
git commit -m "feat(db): resolve() reports the keys it substituted and the placeholder/secret pairs"
```

---

### Task 10: History accepts the renderer's `runUid`

**Files:**
- Modify: `src/db/repos/history.js`
- Modify: `src/db/index.js` (pass `log` to the history repo)
- Test: `test/db/history.test.js` (one assertion updated, three tests added)

**Interfaces:**
- Consumes: nothing new.
- Produces: `createHistoryRepo(db, { newUid, log })`; `append(run, maxRuns)` / `insert(run)` use `run.runUid` when it matches `^[0-9A-HJKMNP-TV-Z]{26}$` and is not taken, otherwise a fresh ULID (a taken one is logged with `log.warn`); both return `{ id, runUid }`. `read().runs[]` gains `runUid`.

- [ ] **Step 1: Update the round-trip assertion in `test/db/history.test.js`**

Replace:
```js
    runs: [{
      id, at: 1727000000000, provider: 'nara', providerName: 'NaraRouter', prompt: 'What is 2+2?',
```
with:
```js
    runs: [{
      id, runUid, at: 1727000000000, provider: 'nara', providerName: 'NaraRouter', prompt: 'What is 2+2?',
```

- [ ] **Step 2: Append the new tests to `test/db/history.test.js`**

```js
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

test('append keeps a valid runUid the renderer provides', async (t) => {
  const { repos } = await memoryStore(t);
  const runUid = ulid(1790000000000);
  assert.strictEqual(repos.history.append(run(1, [pass('m1')], { runUid }), 300).runUid, runUid);
  assert.strictEqual(repos.history.read().runs[0].runUid, runUid);
});

test('an invalid runUid is replaced by a fresh one', async (t) => {
  const { repos } = await memoryStore(t);
  ['not-a-ulid', 'x'.repeat(26), ulid().toLowerCase(), 42, null].forEach((bad, i) => {
    const out = repos.history.append(run(i, [], { runUid: bad }), 300);
    assert.match(out.runUid, ULID);
    assert.notStrictEqual(out.runUid, bad);
  });
});

test('a runUid already used is replaced, logged, and the run is still saved', async (t) => {
  const warnings = [];
  const store = await memoryStore(t, { log: { ...quietLog, warn: (...a) => warnings.push(a.join(' ')) } });
  const runUid = ulid();
  store.repos.history.append(run(1, [pass('m1')], { runUid }), 300);
  const second = store.repos.history.append(run(2, [pass('m2')], { runUid }), 300);
  assert.notStrictEqual(second.runUid, runUid);
  assert.match(second.runUid, ULID);
  assert.strictEqual(store.repos.history.read().runs.length, 2);
  assert.strictEqual(warnings.length, 1);
  assert.ok(warnings[0].includes(runUid));
});
```

And at the top of the file replace:
```js
const { memoryStore } = require('../helpers');
```
with:
```js
const { memoryStore, quietLog } = require('../helpers');
```

- [ ] **Step 3: Run it to see it fail**

Run: `npm test -- test/db/history.test.js`
Expected: FAIL — the round trip (`runUid` missing from `read()`), `append keeps a valid runUid…` and `a runUid already used…` fail.

- [ ] **Step 4: Change `src/db/repos/history.js`**

Replace:
```js
const { ulid } = require('../ulid');
```
with:
```js
const { ulid } = require('../ulid');

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
```

Replace:
```js
function createHistoryRepo(db, { newUid = ulid } = {}) {
```
with:
```js
function createHistoryRepo(db, { newUid = ulid, log = console } = {}) {
```

Replace:
```js
    runs: db.prepare('SELECT id, at, provider_id, provider_name, prompt FROM test_runs ORDER BY id'),
```
with:
```js
    runs: db.prepare('SELECT id, run_uid, at, provider_id, provider_name, prompt FROM test_runs ORDER BY id'),
    uidTaken: db.prepare('SELECT 1 FROM test_runs WHERE run_uid = ?'),
```

Replace:
```js
    const runUid = newUid();
```
with:
```js
    // The renderer names its Route Test run: the same ULID tags the run's
    // requests in the request log. Anything that isn't a ULID gets a fresh
    // id, and so does one already taken; the run is kept either way.
    let runUid = null;
    if (typeof run.runUid === 'string' && ULID.test(run.runUid)) {
      if (q.uidTaken.get(run.runUid)) log.warn(`append-run: run id ${run.runUid} is already used; the run is saved under a new id`);
      else runUid = run.runUid;
    }
    if (runUid === null) runUid = newUid();
```

Replace:
```js
    const runs = q.runs.all().map((r) => ({
      id: r.id,
      at: r.at,
```
with:
```js
    const runs = q.runs.all().map((r) => ({
      id: r.id,
      runUid: r.run_uid,
      at: r.at,
```

- [ ] **Step 5: Pass the log in `src/db/index.js`**

Replace:
```js
    history: createHistoryRepo(db),
```
with:
```js
    history: createHistoryRepo(db, { log }),
```

- [ ] **Step 6: Run it to see it pass**

Run: `npm test -- test/db/history.test.js`
Expected: `# pass 11`, `# fail 0`.

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: `# pass 217`, `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/db/repos/history.js src/db/index.js test/db/history.test.js
git commit -m "feat(db): history keeps a valid runUid from the renderer and reads it back"
```

---

### Task 11: `lookups.js` and `recorder.js` — building the record

**Files:**
- Create: `src/logs/lookups.js`
- Create: `src/logs/recorder.js`
- Test: `test/logs/lookups.test.js`, `test/logs/recorder.test.js`

**Interfaces:**
- Consumes: `classify.*` (Task 2), `scrub` (Task 3), `ulid` (`src/db/ulid.js`), `memoryStore` (existing helper).
- Produces:
  - `createPriceBook(db) → { get(providerId, modelId) → { input, output } | null, invalidate() }` (reads `models.summary_json.pricing` from `venom.db`, cached).
  - `createProviderLookup(db) → { list() → [{ id, name, baseUrl }] }`.
  - `buildRecord(done, { prices, providers, logLevel, newUid }) → { row, body | null }` — `row` has every `ROW_COLUMNS` key except `has_body`; `body = { request_headers_json, request_body, response_body, truncated }`.
  - `createRecorder({ writer, prices, providers, getLogLevel }) → { record(done) }` (never throws; an unbuildable record → `writer.noteDropped(1, err)`).
  - `done` (produced by Task 12): `{ args: { url, method, headers, body, requestId, timeoutMs, source, runId, attempt, hedgeIndex, testGroup, trigger, paramSwap }, startedAt, refs, substitutions, outcome, cancelReason, httpStatus, contentType, responseText, error, elapsed, firstByteMs, firstTokenMs }`.

- [ ] **Step 1: Write the failing test `test/logs/lookups.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert');
const { createPriceBook, createProviderLookup } = require('../../src/logs/lookups');
const { memoryStore } = require('../helpers');

const entry = (id, pricing) => ({
  key: `nara::${id}`, providerId: 'nara', id, name: id, removedAt: null, isNew: false, keyIds: [], pricing,
});

test('the price book reads the pool price, caches it, and reads again after invalidate', async (t) => {
  const store = await memoryStore(t);
  store.repos.catalog.write({ models: { 'nara::m1': entry('m1', { input: 2, output: 10, source: 'provider' }) } });
  const prices = createPriceBook(store.db);
  assert.deepStrictEqual(prices.get('nara', 'm1'), { input: 2, output: 10 });
  store.repos.catalog.write({ models: { 'nara::m1': entry('m1', { input: 3, output: 12, source: 'provider' }) } });
  assert.deepStrictEqual(prices.get('nara', 'm1'), { input: 2, output: 10 }, 'cached until invalidated');
  prices.invalidate();
  assert.deepStrictEqual(prices.get('nara', 'm1'), { input: 3, output: 12 });
});

test('a missing or malformed price is null', async (t) => {
  const store = await memoryStore(t);
  store.repos.catalog.write({ models: {
    'nara::none': entry('none', null),
    'nara::half': entry('half', { input: 2 }),
    'nara::neg': entry('neg', { input: -1, output: 1 }),
    'nara::free': entry('free', { input: 0, output: 0, source: 'free tier' }),
  } });
  const prices = createPriceBook(store.db);
  assert.strictEqual(prices.get('nara', 'none'), null);
  assert.strictEqual(prices.get('nara', 'half'), null);
  assert.strictEqual(prices.get('nara', 'neg'), null);
  assert.strictEqual(prices.get('nara', 'unknown'), null);
  assert.deepStrictEqual(prices.get('nara', 'free'), { input: 0, output: 0 });
});

test('the provider lookup lists id, name and base URL', async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.save({ id: 'nara', name: 'NaraRouter', baseUrl: 'https://router.bynara.id/v1', rpm: null, keys: [] });
  assert.deepStrictEqual(createProviderLookup(store.db).list().map((p) => ({ ...p })), [
    { id: 'nara', name: 'NaraRouter', baseUrl: 'https://router.bynara.id/v1' },
  ]);
});
```

- [ ] **Step 2: Write the failing test `test/logs/recorder.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert');
const { buildRecord, createRecorder } = require('../../src/logs/recorder');

const NARA = 'https://router.bynara.id/v1';
const RUN = '01J00000000000000000000000';
const GROUP = '01J00000000000000000000001';
const PROVIDERS = [
  { id: 'nara', name: 'NaraRouter', baseUrl: NARA },
  { id: 'mirai', name: 'Mirai', baseUrl: 'https://api.miraiapi.com/v1' },
  { id: 'twin_a', name: 'A', baseUrl: 'https://shared.example/v1' },
  { id: 'twin_b', name: 'B', baseUrl: 'https://shared.example/v2' },
];
const prices = {
  get: (p, m) => {
    if (p === 'nara' && m === 'm1') return { input: 2, output: 10 };
    if (p === 'nara' && m === 'free-m') return { input: 0, output: 0 };
    return null;
  },
};
const opts = { prices, providers: PROVIDERS, logLevel: 'errors', newUid: () => 'UID0' };

const BASE_ARGS = {
  url: `${NARA}/chat/completions`,
  method: 'POST',
  headers: { Authorization: 'Bearer venomkey:key_1', 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'm1', messages: [] }),
  requestId: 'req_1',
  timeoutMs: 60000,
  source: 'route_test',
  runId: RUN,
  attempt: 2,
  hedgeIndex: 1,
  testGroup: GROUP,
  trigger: 'manual',
};

function done(over = {}) {
  const { args, ...rest } = over;
  return {
    args: { ...BASE_ARGS, ...(args || {}) },
    startedAt: 1790000000000,
    refs: [{ kind: 'key', id: 'key_1', providerId: 'nara' }],
    substitutions: [{ placeholder: 'venomkey:key_1', secret: 'sk-nara-1' }],
    outcome: 'end',
    cancelReason: null,
    httpStatus: 200,
    contentType: 'application/json',
    responseText: JSON.stringify({ model: 'm1-0925', choices: [{ message: { content: '4' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }),
    error: null,
    elapsed: 812,
    firstByteMs: 700,
    firstTokenMs: 790,
    ...rest,
  };
}

test('a successful chat: identity, tags, model, usage, cost and meta', () => {
  const { row, body } = buildRecord(done(), opts);
  assert.strictEqual(body, null);
  assert.deepStrictEqual(row, {
    request_uid: 'UID0', created_at: 1790000000000, source: 'route_test', run_id: RUN, attempt: 2, is_hedge: 1,
    provider_id: 'nara', provider_name: 'NaraRouter', key_id: 'key_1', method: 'POST',
    endpoint: 'https://router.bynara.id/v1/chat/completions', model_requested: 'm1', model_returned: 'm1-0925',
    is_stream: 0, status: 'ok', http_status: 200, error_class: null, error_code: null, error_message: null,
    latency_ms: 812, ttft_ms: null, first_byte_ms: 700,
    input_tokens: 5, output_tokens: 1, cached_tokens: null, cache_write_tokens: null, reasoning_tokens: null,
    usage_source: 'reported', cost_micros: 20, price_json: '{"input":2,"output":10}',
    meta_json: JSON.stringify({ requestId: 'req_1', timeoutMs: 60000, trigger: 'manual', hedgeIndex: 1, testGroup: GROUP }),
    user_id: null, token_id: null, subscription_id: null, client_ip: null,
  });
});

test('an unknown source is other; missing or malformed tags fall back to the defaults', () => {
  const { row } = buildRecord(done({ args: {
    source: 'telemetry', runId: 42, attempt: 0, hedgeIndex: -1, trigger: 'cron', testGroup: 'x'.repeat(65),
    requestId: undefined, timeoutMs: undefined, paramSwap: 'yes',
  } }), opts);
  assert.deepStrictEqual([row.source, row.run_id, row.attempt, row.is_hedge, row.meta_json], ['other', null, 1, 0, null]);
  const swapped = buildRecord(done({ args: {
    requestId: undefined, timeoutMs: undefined, trigger: undefined, hedgeIndex: undefined, testGroup: undefined, paramSwap: true,
  } }), opts).row;
  assert.strictEqual(swapped.meta_json, '{"paramSwap":true}');
});

test('a secret ref is key_id secret:<name>; without a key, the one provider at that origin, none when two share it', () => {
  const secret = buildRecord(done({
    args: { url: 'https://artificialanalysis.ai/api/v2/data/llms/models', method: 'GET', headers: { 'x-api-key': 'venomsecret:aaApiKey' }, body: undefined },
    refs: [{ kind: 'secret', id: 'aaApiKey', providerId: null }],
  }), opts).row;
  assert.deepStrictEqual([secret.provider_id, secret.provider_name, secret.key_id, secret.model_requested], [null, null, 'secret:aaApiKey', null]);
  const byOrigin = buildRecord(done({ args: { url: 'https://api.miraiapi.com/api/usage/check' }, refs: [] }), opts).row;
  assert.deepStrictEqual([byOrigin.provider_id, byOrigin.provider_name, byOrigin.key_id], ['mirai', 'Mirai', null]);
  const shared = buildRecord(done({ args: { url: 'https://shared.example/v1/models' }, refs: [] }), opts).row;
  assert.deepStrictEqual([shared.provider_id, shared.provider_name], [null, null]);
});

test('a blocked request names the refused key, parses nothing and keeps its body', () => {
  const { row, body } = buildRecord(done({
    outcome: 'blocked', httpStatus: null, contentType: null, responseText: '', elapsed: 0, firstByteMs: null, firstTokenMs: null,
    error: "Key blocked: evil.test is not this key's provider",
    args: { url: 'https://evil.test/v1/models' },
  }), opts);
  assert.deepStrictEqual(
    [row.status, row.error_class, row.http_status, row.key_id, row.provider_id, row.endpoint, row.error_message, row.usage_source, row.cost_micros],
    ['blocked', 'blocked', null, 'key_1', 'nara', 'https://evil.test/v1/models', "Key blocked: evil.test is not this key's provider", 'none', null],
  );
  assert.ok(body, 'a blocked request counts as failed, so its body is kept');
});

test('cost: a free model costs 0; an unknown price or no usage is NULL', () => {
  const free = buildRecord(done({ args: { body: JSON.stringify({ model: 'free-m' }) } }), opts).row;
  assert.deepStrictEqual([free.cost_micros, free.price_json], [0, '{"input":0,"output":0}']);
  const unknown = buildRecord(done({ args: { body: JSON.stringify({ model: 'mystery' }) } }), opts).row;
  assert.deepStrictEqual([unknown.cost_micros, unknown.price_json, unknown.input_tokens], [null, null, 5]);
  const noUsage = buildRecord(done({ responseText: JSON.stringify({ model: 'm1', choices: [] }) }), opts).row;
  assert.deepStrictEqual([noUsage.cost_micros, noUsage.usage_source, noUsage.input_tokens], [null, 'none', null]);
});

test('TTFT is kept for streams only', () => {
  const sse = 'data: {"model":"m1","choices":[{"delta":{"content":"4"}}]}\n\ndata: [DONE]\n\n';
  const streamed = buildRecord(done({
    args: { body: JSON.stringify({ model: 'm1', stream: true }) }, contentType: 'text/event-stream', responseText: sse,
  }), opts).row;
  assert.deepStrictEqual([streamed.is_stream, streamed.ttft_ms, streamed.usage_source, streamed.model_returned], [1, 790, 'none', 'm1']);
  const plain = buildRecord(done(), opts).row;
  assert.deepStrictEqual([plain.is_stream, plain.ttft_ms], [0, null]);
});

test('bodies: Off, Failed only and All, and what counts as failed', () => {
  const kept = (logLevel, over) => buildRecord(done(over), { ...opts, logLevel }).body !== null;
  const fail500 = { httpStatus: 500, responseText: '{"error":{"message":"down"}}' };
  const hedgeLost = { outcome: 'cancelled', cancelReason: 'hedge_lost', httpStatus: null, responseText: '' };
  const deadline = { outcome: 'cancelled', cancelReason: 'deadline', httpStatus: null, responseText: '' };
  const timeout = { outcome: 'timeout', httpStatus: null, responseText: '', error: 'No response for 60s' };
  const network = { outcome: 'error', httpStatus: null, responseText: '', error: 'socket hang up' };
  assert.deepStrictEqual(
    [kept('errors', {}), kept('errors', fail500), kept('errors', hedgeLost), kept('errors', deadline), kept('errors', timeout), kept('errors', network)],
    [false, true, false, true, true, true],
  );
  assert.deepStrictEqual([kept('all', {}), kept('all', hedgeLost)], [true, true]);
  assert.deepStrictEqual([kept('off', fail500), kept('off', network)], [false, false]);
  assert.strictEqual(kept('something-else', fail500), true);
});

test('a captured body: the unresolved request, redacted headers, a scrubbed reply clipped at 8 KB', () => {
  const { row, body } = buildRecord(done({
    httpStatus: 400,
    responseText: JSON.stringify({ error: { message: 'bad key sk-nara-1' }, pad: 'x'.repeat(9000) }),
    args: { headers: { Authorization: 'Bearer venomkey:key_1', 'X-Api-Key': 'venomkey:key_1', Cookie: 'mirai_usage_session=abc', 'Content-Type': 'application/json' } },
  }), opts);
  assert.deepStrictEqual(JSON.parse(body.request_headers_json), {
    Authorization: '[redacted]', 'X-Api-Key': '[redacted]', Cookie: '[redacted]', 'Content-Type': 'application/json',
  });
  assert.strictEqual(body.request_body, JSON.stringify({ model: 'm1', messages: [] }));
  assert.strictEqual(body.response_body.length, 8192);
  assert.ok(body.response_body.includes('bad key venomkey:key_1'));
  assert.ok(!body.response_body.includes('sk-nara-1'));
  assert.strictEqual(body.truncated, 1);
  assert.strictEqual(row.error_message, 'bad key venomkey:key_1');
});

test('no form of a substituted secret reaches a queued record', () => {
  const A = 'sk-"live\\key/0001';
  const B = `${A}-extended`;
  const formsOf = (s) => {
    const json = JSON.stringify(s).slice(1, -1);
    return [s, json, json.replace(/\//g, '\\/'), encodeURIComponent(s)];
  };
  const echo = `bad keys ${A} | ${JSON.stringify({ k: B })} | ${JSON.stringify(A).replace(/\//g, '\\/')} | ?key=${encodeURIComponent(B)}`;
  const added = [];
  const writer = { add: (row, body) => added.push({ row, body }), noteDropped: () => assert.fail('nothing may be dropped') };
  const recorder = createRecorder({ writer, prices: null, providers: { list: () => PROVIDERS }, getLogLevel: () => 'all' });
  const substitutions = [{ placeholder: 'venomkey:key_a', secret: A }, { placeholder: 'venomsecret:aaApiKey', secret: B }];
  recorder.record(done({ substitutions, httpStatus: 401, responseText: JSON.stringify({ error: { message: echo, code: A }, model: B }) }));
  recorder.record(done({ substitutions, outcome: 'error', httpStatus: null, responseText: '', error: `connect failed for ${A}` }));
  recorder.record(done({ substitutions, outcome: 'aborted', contentType: 'text/event-stream', responseText: `data: {"echo":"${encodeURIComponent(B)}"}\n\n` }));
  // A plain-text reply whose first 200 characters would cut the key in half.
  recorder.record(done({ substitutions, httpStatus: 401, contentType: 'text/plain', responseText: `${'x'.repeat(192)}${A} trailing` }));
  assert.strictEqual(added.length, 4);
  const stored = added.flatMap(({ row, body }) => [...Object.values(row), ...Object.values(body || {})]).filter((v) => typeof v === 'string');
  [A, B].forEach((secret) => formsOf(secret).forEach((form) => {
    stored.forEach((value) => assert.ok(!value.includes(form), `stored: ${value}`));
  }));
  stored.forEach((v) => assert.ok(!v.includes(A.slice(0, 8)), `partial: ${v}`));
  assert.ok(stored.some((v) => v.includes('venomkey:key_a')));
  assert.ok(!JSON.stringify(added).includes('substitutions'));
});

test('a record that cannot be built is counted as dropped, never thrown', () => {
  const dropped = [];
  const writer = { add: () => assert.fail('nothing should be queued'), noteDropped: (n, err) => dropped.push([n, err.message]) };
  const recorder = createRecorder({ writer, providers: { list: () => { throw new Error('venom.db is busy'); } } });
  assert.doesNotThrow(() => recorder.record(done()));
  assert.deepStrictEqual(dropped, [[1, 'venom.db is busy']]);
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npm test -- test/logs/lookups.test.js test/logs/recorder.test.js`
Expected: FAIL — `Cannot find module '../../src/logs/lookups'` and `'../../src/logs/recorder'`.

- [ ] **Step 4: Write `src/logs/lookups.js`**

```js
// ============================================
// venom.db lookups for the request log
// ============================================
// The recorder names each request's provider and prices it. Both come from
// venom.db, on main's own connection and thread: the providers table is a
// handful of rows, read per record; prices are cached per (provider, model),
// and main drops the cache whenever write-catalog saves the model pool.
function createProviderLookup(db) {
  const all = db.prepare('SELECT id, name, base_url AS baseUrl FROM providers');
  return { list: () => all.all() };
}

// summary_json.pricing is { input, output, source } in USD per 1M tokens
// (src/renderer/catalog.js readPricing). Anything else is "unknown".
function readPrice(summaryJson) {
  let pricing;
  try {
    pricing = JSON.parse(summaryJson || '{}').pricing;
  } catch (_) {
    return null;
  }
  if (!pricing || typeof pricing !== 'object') return null;
  const { input, output } = pricing;
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return null;
  return { input, output };
}

function createPriceBook(db) {
  const one = db.prepare('SELECT summary_json FROM models WHERE provider_id = ? AND model_id = ?');
  const cache = new Map();
  return {
    get(providerId, modelId) {
      const key = `${providerId}\u0000${modelId}`;
      if (!cache.has(key)) {
        const row = one.get(providerId, modelId);
        cache.set(key, row ? readPrice(row.summary_json) : null);
      }
      return cache.get(key);
    },
    invalidate() {
      cache.clear();
    },
  };
}

module.exports = { createPriceBook, createProviderLookup };
```

- [ ] **Step 5: Write `src/logs/recorder.js`**

```js
// ============================================
// Request record — what one finished request becomes in the log
// ============================================
// src/api-request.js calls record(done) in setImmediate, after the renderer
// already has its reply, so none of this sits on the reply path.
// buildRecord is pure apart from the two lookups it is handed.
//
// done.substitutions holds the real secrets main swapped in. They are used
// here to scrub the stored text and nowhere else: never copied into the row,
// the body or meta_json.
const { ulid } = require('../db/ulid');
const C = require('./classify');
const { scrub } = require('./scrub');

const SOURCES = new Set(['route_test', 'benchmark', 'health', 'key_check', 'key_usage', 'discovery', 'pricing', 'leaderboard', 'other']);
const CANCEL_REASONS = new Set(['hedge_lost', 'stop', 'deadline']);
const TRIGGERS = new Set(['manual', 'scheduled']);
const BODY_MAX = 8192;
const REDACTED_HEADERS = /^(authorization|x-api-key|api-key|cookie)$/i;

const shortString = (v, max) => (typeof v === 'string' && v !== '' && v.length <= max ? v : null);
const whole = (v) => (Number.isFinite(v) ? Math.round(v) : null);

function clip(text) {
  if (typeof text !== 'string') return { text: null, clipped: false };
  return text.length > BODY_MAX ? { text: text.slice(0, BODY_MAX), clipped: true } : { text, clipped: false };
}

function redactHeaders(headers) {
  const out = {};
  Object.entries(headers && typeof headers === 'object' ? headers : {}).forEach(([name, value]) => {
    out[name] = REDACTED_HEADERS.test(name) ? '[redacted]' : value;
  });
  return out;
}

// Only these keys ever reach meta_json, each checked for type and size.
function metaOf(args, cancelReason) {
  const m = {};
  const requestId = shortString(args.requestId, 100);
  if (requestId) m.requestId = requestId;
  if (Number.isFinite(args.timeoutMs) && args.timeoutMs > 0) m.timeoutMs = Math.round(args.timeoutMs);
  if (CANCEL_REASONS.has(cancelReason)) m.cancelReason = cancelReason;
  if (TRIGGERS.has(args.trigger)) m.trigger = args.trigger;
  if (Number.isInteger(args.hedgeIndex) && args.hedgeIndex >= 0) m.hedgeIndex = args.hedgeIndex;
  const testGroup = shortString(args.testGroup, 64);
  if (testGroup) m.testGroup = testGroup;
  if (args.paramSwap === true) m.paramSwap = true;
  return Object.keys(m).length ? JSON.stringify(m) : null;
}

function originOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch (_) {
    return null;
  }
}

// The key's own provider when a key was substituted (or refused); otherwise
// the one provider whose base URL has this origin (several → unknown).
function whoFor(refs, url, providers) {
  const list = Array.isArray(providers) ? providers : [];
  const all = Array.isArray(refs) ? refs : [];
  const key = all.find((r) => r && r.kind === 'key');
  const secret = all.find((r) => r && r.kind === 'secret');
  let providerId = key && key.providerId ? key.providerId : null;
  if (!providerId) {
    const origin = originOf(url);
    const matches = origin ? list.filter((p) => originOf(p.baseUrl) === origin) : [];
    providerId = matches.length === 1 ? matches[0].id : null;
  }
  const named = providerId ? list.find((p) => p.id === providerId) : null;
  let keyId = null;
  if (key) keyId = String(key.id).slice(0, 100);
  else if (secret) keyId = `secret:${String(secret.id).slice(0, 64)}`;
  return { providerId, providerName: named ? named.name : null, keyId };
}

// Failed = anything but ok and cancelled. An unknown setting reads as Failed only.
function keepsBody(logLevel, status) {
  if (logLevel === 'all') return true;
  if (logLevel === 'off') return false;
  return status !== 'ok' && status !== 'cancelled';
}

function buildRecord(done, { prices = null, providers = [], logLevel = 'errors', newUid = ulid } = {}) {
  const args = done.args && typeof done.args === 'object' ? done.args : {};
  const subs = Array.isArray(done.substitutions) ? done.substitutions : [];
  const clean = (text) => (typeof text === 'string' ? scrub(text, subs) : null);
  const requestText = C.bodyText(args.body);
  const responseText = typeof done.responseText === 'string' ? done.responseText : '';
  const answered = done.outcome === 'end';
  const ok2xx = answered && done.httpStatus >= 200 && done.httpStatus < 300;
  const parsed = C.readResponse(responseText, done.contentType);
  // Scrubbed before extractError clips it to 200 characters, so a secret cut
  // in half at the clip can't slip past the scrubber.
  const err = answered && !ok2xx ? C.extractError(clean(responseText) || '') : { code: null, message: done.error || null };
  const { status, errorClass } = C.classifyStatus({
    outcome: done.outcome, httpStatus: done.httpStatus, cancelReason: done.cancelReason, errorCode: err.code,
  });
  const isStream = C.isStreamRequest(requestText, done.contentType);
  const who = whoFor(done.refs, args.url, providers);
  const modelRequested = C.modelRequested(requestText);
  const price = prices && who.providerId && modelRequested ? prices.get(who.providerId, modelRequested) : null;
  const usage = parsed.usage;
  const cost = C.computeCost(usage, price);
  const failed = status !== 'ok' && status !== 'cancelled';
  const message = failed ? clean(err.message) : null;
  const code = failed ? clean(err.code) : null;
  const modelReturned = clean(parsed.model);

  const row = {
    request_uid: newUid(),
    created_at: Number.isFinite(done.startedAt) ? done.startedAt : Date.now(),
    source: SOURCES.has(args.source) ? args.source : 'other',
    run_id: shortString(args.runId, 64),
    attempt: Number.isInteger(args.attempt) && args.attempt > 0 ? args.attempt : 1,
    is_hedge: Number.isInteger(args.hedgeIndex) && args.hedgeIndex > 0 ? 1 : 0,
    provider_id: who.providerId,
    provider_name: who.providerName,
    key_id: who.keyId,
    method: String(args.method || 'GET').toUpperCase().slice(0, 16),
    endpoint: C.endpointOf(args.url),
    model_requested: modelRequested,
    model_returned: modelReturned ? modelReturned.slice(0, 200) : null,
    is_stream: isStream ? 1 : 0,
    status,
    http_status: Number.isInteger(done.httpStatus) ? done.httpStatus : null,
    error_class: errorClass,
    error_code: code ? code.slice(0, 100) : null,
    error_message: message ? message.slice(0, 500) : null,
    latency_ms: whole(done.elapsed),
    ttft_ms: isStream ? whole(done.firstTokenMs) : null,
    first_byte_ms: whole(done.firstByteMs),
    input_tokens: usage ? usage.input : null,
    output_tokens: usage ? usage.output : null,
    cached_tokens: usage ? usage.cached : null,
    cache_write_tokens: usage ? usage.cacheWrite : null,
    reasoning_tokens: usage ? usage.reasoning : null,
    usage_source: usage ? 'reported' : 'none',
    cost_micros: cost.costMicros,
    price_json: cost.priceJson,
    meta_json: metaOf(args, done.cancelReason),
    user_id: null,
    token_id: null,
    subscription_id: null,
    client_ip: null,
  };
  if (!keepsBody(logLevel, status)) return { row, body: null };

  const request = clip(requestText);
  const response = clip(responseText ? clean(responseText) : null);
  return {
    row,
    body: {
      request_headers_json: JSON.stringify(redactHeaders(args.headers)),
      request_body: request.text,
      response_body: response.text,
      truncated: request.clipped || response.clipped ? 1 : 0,
    },
  };
}

function createRecorder({ writer, prices = null, providers = { list: () => [] }, getLogLevel = () => 'errors' }) {
  return {
    record(done) {
      let built;
      try {
        built = buildRecord(done, { prices, providers: providers.list(), logLevel: getLogLevel() });
      } catch (err) {
        // Lost like a batch that can't be written: counted, never thrown.
        writer.noteDropped(1, err);
        return;
      }
      writer.add(built.row, built.body);
    },
  };
}

module.exports = { buildRecord, createRecorder, redactHeaders };
```

- [ ] **Step 6: Run them to see them pass**

Run: `npm test -- test/logs/lookups.test.js test/logs/recorder.test.js`
Expected: `# pass 13`, `# fail 0`.

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: `# pass 230`, `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/logs/lookups.js src/logs/recorder.js test/logs/lookups.test.js test/logs/recorder.test.js
git commit -m "feat(logs): build each request's record - provider, key, cost, scrubbed body"
```

---

### Task 12: `src/api-request.js` — the finish-once requester

**Files:**
- Create: `src/api-request.js`
- Test: `test/api-request.test.js`

**Interfaces:**
- Consumes: a resolver shaped like Task 9's (`resolve({ url, headers, body })`).
- Produces: `createApiRequester({ getResolver, onFinish, log, now }) → { request(args) → Promise<reply>, cancel(requestId, reason) → boolean, inFlight() → int }`.
  - `args = { url, method, headers, body, requestId, timeoutMs, ...tags }` (tags pass through untouched to `done.args`).
  - Replies (unchanged shapes for the renderer): end `{ status, body, elapsed, firstByteMs, firstTokenMs, headers }`; cancelled `{ status: 0, body: '', elapsed, headers: {}, cancelled: true }`; network `{ status: 0, body: '', elapsed, headers: {}, networkError: true, error }`; timeout adds `timedOut: true`; blocked `{ status: 0, body: '', elapsed: 0, headers: {}, blocked: true, error }`.
  - `onFinish(done)` runs exactly once per request, in `setImmediate` after the reply resolved; `done` as listed in Task 11, `outcome` ∈ `end | cancelled | timeout | error | aborted | blocked`.
  - `cancel` reasons `hedge_lost | stop | deadline`; anything else is `stop`. Returns `false` for an unknown or finished id.
  - `CONTENT_TOKEN` (moved from `main.js`).

- [ ] **Step 1: Write the failing test `test/api-request.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createApiRequester } = require('../src/api-request');
const { quietLog } = require('./helpers');

const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

function startServer(t, handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }));
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function setup({ resolver = null, onFinish = null } = {}) {
  const finished = [];
  const warnings = [];
  const requester = createApiRequester({
    getResolver: () => resolver,
    onFinish: onFinish || ((d) => finished.push(d)),
    log: { ...quietLog, warn: (...a) => warnings.push(a.join(' ')) },
  });
  return { requester, finished, warnings };
}

// Sends headers and one SSE chunk, then holds the response open.
function holdingStream(onWrote = () => {}) {
  return (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n', () => onWrote(res));
  };
}

test('a normal end resolves the reply and reports one record after it', async (t) => {
  const origin = await startServer(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: 'm1', choices: [{ message: { content: 'four' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
  });
  let replied = false;
  const seen = [];
  const { requester } = setup({ onFinish: (d) => seen.push({ ...d, replied }) });
  const r = await requester.request({
    url: `${origin}/v1/chat/completions`, method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: '{"model":"m1"}', requestId: 'r0', source: 'route_test',
  });
  replied = true;
  assert.strictEqual(r.status, 200);
  assert.strictEqual(JSON.parse(r.body).choices[0].message.content, 'four');
  assert.strictEqual(r.headers['content-type'], 'application/json');
  assert.strictEqual(typeof r.elapsed, 'number');
  assert.strictEqual(typeof r.firstTokenMs, 'number');
  await settle();
  assert.strictEqual(seen.length, 1);
  const d = seen[0];
  assert.deepStrictEqual([d.replied, d.outcome, d.httpStatus, d.contentType, d.args.source], [true, 'end', 200, 'application/json', 'route_test']);
  assert.ok(d.responseText.includes('four'));
});

test('a mid-stream cancel resolves as cancelled and reports once with the reason', async (t) => {
  let wrote;
  const wroteChunk = new Promise((resolve) => { wrote = resolve; });
  const origin = await startServer(t, holdingStream(() => wrote()));
  const { requester, finished } = setup();
  const reply = requester.request({ url: `${origin}/v1/chat/completions`, method: 'POST', body: '{"stream":true}', requestId: 'r1' });
  await wroteChunk;
  await settle(100);
  assert.strictEqual(requester.cancel('r1', 'hedge_lost'), true);
  assert.strictEqual(requester.cancel('r1', 'stop'), false);
  const r = await reply;
  assert.deepStrictEqual([r.status, r.cancelled, r.body], [0, true, '']);
  await settle();
  assert.strictEqual(finished.length, 1);
  const d = finished[0];
  assert.deepStrictEqual([d.outcome, d.cancelReason, d.httpStatus], ['cancelled', 'hedge_lost', 200]);
  assert.match(d.responseText, /"Hi"/);
  assert.strictEqual(typeof d.firstTokenMs, 'number');
});

test('a cancel before any response is cancelled too, and deadline is kept as the reason', async (t) => {
  const origin = await startServer(t, () => {});
  const { requester, finished } = setup();
  const reply = requester.request({ url: `${origin}/slow`, requestId: 'r2' });
  await settle();
  assert.strictEqual(requester.cancel('r2', 'deadline'), true);
  const r = await reply;
  assert.strictEqual(r.cancelled, true);
  await settle();
  assert.strictEqual(finished.length, 1);
  assert.deepStrictEqual([finished[0].outcome, finished[0].cancelReason, finished[0].httpStatus], ['cancelled', 'deadline', null]);
});

test('a socket timeout reports exactly one record', async (t) => {
  const origin = await startServer(t, () => {});
  const { requester, finished } = setup();
  const r = await requester.request({ url: `${origin}/slow`, timeoutMs: 100 });
  assert.deepStrictEqual([r.status, r.networkError, r.timedOut], [0, true, true]);
  assert.match(r.error, /No response/);
  await settle(200);
  assert.strictEqual(finished.length, 1);
  assert.strictEqual(finished[0].outcome, 'timeout');
});

test('a connection dropped mid-stream resolves as a network error and reports once', async (t) => {
  const origin = await startServer(t, holdingStream((res) => setTimeout(() => res.socket.destroy(), 50)));
  const { requester, finished } = setup();
  const r = await requester.request({ url: `${origin}/v1/chat/completions`, method: 'POST', body: '{"stream":true}' });
  assert.deepStrictEqual([r.status, r.networkError], [0, true]);
  assert.match(r.error, /closed before the response ended/);
  await settle();
  assert.strictEqual(finished.length, 1);
  assert.deepStrictEqual([finished[0].outcome, finished[0].httpStatus], ['aborted', 200]);
  assert.match(finished[0].responseText, /"Hi"/);
});

test('a blocked request never leaves and reports once', async (t) => {
  let hits = 0;
  const origin = await startServer(t, (req, res) => { hits += 1; res.end('x'); });
  const refused = { kind: 'key', id: 'key_1', providerId: 'nara' };
  const resolver = { resolve: () => ({ blocked: true, error: "Key blocked: 127.0.0.1 is not this key's provider", refs: [refused] }) };
  const { requester, finished, warnings } = setup({ resolver });
  const r = await requester.request({ url: `${origin}/v1/models`, headers: { Authorization: 'Bearer venomkey:key_1' } });
  assert.deepStrictEqual(r, { status: 0, body: '', elapsed: 0, headers: {}, blocked: true, error: "Key blocked: 127.0.0.1 is not this key's provider" });
  await settle();
  assert.strictEqual(hits, 0);
  assert.strictEqual(finished.length, 1);
  assert.deepStrictEqual([finished[0].outcome, finished[0].refs], ['blocked', [refused]]);
  assert.strictEqual(warnings.length, 1);
});

test("the resolved request goes out; the record keeps the renderer's placeholders; the reply carries no substitutions", async (t) => {
  let seenAuth = null;
  const origin = await startServer(t, (req, res) => {
    seenAuth = req.headers.authorization;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"bad key"}}');
  });
  const resolver = {
    resolve: ({ url, headers, body }) => ({
      url, headers: { ...headers, Authorization: 'Bearer sk-real-0001' }, body,
      refs: [{ kind: 'key', id: 'key_1', providerId: 'nara' }],
      substitutions: [{ placeholder: 'venomkey:key_1', secret: 'sk-real-0001' }],
    }),
  };
  const { requester, finished } = setup({ resolver });
  const r = await requester.request({ url: `${origin}/v1/models`, headers: { Authorization: 'Bearer venomkey:key_1' } });
  assert.strictEqual(seenAuth, 'Bearer sk-real-0001');
  assert.deepStrictEqual(Object.keys(r).sort(), ['body', 'elapsed', 'firstByteMs', 'firstTokenMs', 'headers', 'status']);
  assert.ok(!JSON.stringify(r).includes('sk-real-0001'));
  await settle();
  assert.strictEqual(finished[0].args.headers.Authorization, 'Bearer venomkey:key_1');
  assert.deepStrictEqual(finished[0].substitutions, [{ placeholder: 'venomkey:key_1', secret: 'sk-real-0001' }]);
});

test('a cancel after the end, a second cancel and an unknown id change nothing', async (t) => {
  const origin = await startServer(t, (req, res) => res.end('ok'));
  const { requester, finished } = setup();
  const r = await requester.request({ url: `${origin}/x`, requestId: 'r3' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(requester.cancel('r3', 'stop'), false);
  assert.strictEqual(requester.cancel('r3', 'stop'), false);
  assert.strictEqual(requester.cancel('never-sent', 'stop'), false);
  await settle();
  assert.strictEqual(finished.length, 1);
  assert.deepStrictEqual([finished[0].outcome, finished[0].cancelReason], ['end', null]);
});

test('a recorder that throws never touches the reply, and runs only after it', async (t) => {
  const origin = await startServer(t, (req, res) => res.end('fine'));
  let replied = false;
  let sawReply = null;
  let calls = 0;
  const { requester, warnings } = setup({
    onFinish: () => {
      calls += 1;
      if (sawReply === null) sawReply = replied;
      throw new Error('recorder bug');
    },
  });
  const first = await requester.request({ url: `${origin}/a` });
  replied = true;
  assert.strictEqual(first.body, 'fine');
  await settle();
  assert.strictEqual(sawReply, true);
  const second = await requester.request({ url: `${origin}/b` });
  assert.strictEqual(second.body, 'fine');
  await settle();
  assert.strictEqual(calls, 2);
  assert.strictEqual(warnings.length, 2);
  assert.match(warnings[0], /recorder bug/);
});

test('an unparsable URL resolves as a network error instead of rejecting', async () => {
  const { requester, finished } = setup();
  const r = await requester.request({ url: 'not a url' });
  assert.deepStrictEqual([r.status, r.networkError], [0, true]);
  assert.match(r.error, /Invalid URL/);
  await settle();
  assert.deepStrictEqual([finished.length, finished[0].outcome], [1, 'error']);
  assert.strictEqual(requester.inFlight(), 0);
});

test('inFlight counts requests until they finish', async (t) => {
  const origin = await startServer(t, () => {});
  const { requester } = setup();
  const reply = requester.request({ url: `${origin}/slow`, requestId: 'r4' });
  await settle();
  assert.strictEqual(requester.inFlight(), 1);
  requester.cancel('r4', 'stop');
  await reply;
  assert.strictEqual(requester.inFlight(), 0);
});

test('an unknown cancel reason is recorded as stop', async (t) => {
  const origin = await startServer(t, () => {});
  const { requester, finished } = setup();
  const reply = requester.request({ url: `${origin}/slow`, requestId: 'r5' });
  await settle();
  requester.cancel('r5', 'whatever');
  await reply;
  await settle();
  assert.strictEqual(finished[0].cancelReason, 'stop');
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- test/api-request.test.js`
Expected: FAIL — `Cannot find module '../src/api-request'`.

- [ ] **Step 3: Write `src/api-request.js`**

```js
// ============================================
// api-request — every outbound request the renderer asks for
// ============================================
// Main sends it (the page has connect-src 'none'), so key placeholders are
// swapped for secrets here and nowhere else (src/db/keys.js).
//
// Each request ends exactly once, through finish(): the response ending, the
// body being cut off (a cancel, or the server dropping the connection), the
// socket timing out, a transport error, or the resolver refusing a key.
// finish() resolves the renderer's promise first and only then, in
// setImmediate, hands the request to the log (onFinish), so logging adds
// nothing to the reply path and a logging fault can never reach the reply.
//
// Failures resolve rather than reject. A rejected ipcMain.handle reaches the
// renderer as "Error invoking remote method 'api-request': ..." with the real
// message buried and every other field — notably the elapsed time — gone.
const https = require('https');
const http = require('http');

// A chunk that carries model text: a non-empty content/text/reasoning field.
// Matches both a streamed delta and a whole non-streamed body.
const CONTENT_TOKEN = /"(?:content|text|reasoning_content|reasoning)"\s*:\s*"[^"\\]/;
const CANCEL_REASONS = new Set(['hedge_lost', 'stop', 'deadline']);
const CUT_OFF = 'The connection closed before the response ended';

function createApiRequester({ getResolver = () => null, onFinish = () => {}, log = console, now = Date.now } = {}) {
  // In flight by the renderer's requestId, so it can cancel hedge losers,
  // Stop a run, or give up at a deadline.
  const active = new Map();
  let inFlight = 0;

  function request(args) {
    const a = args && typeof args === 'object' ? args : {};
    const { url, method, headers, body, requestId, timeoutMs } = a;
    const startedAt = now();
    const resolver = getResolver();
    const outgoing = resolver ? resolver.resolve({ url, headers, body }) : { url, headers, body };
    // substitutions holds secrets: it goes to onFinish (the log scrubs with
    // it) and never into a reply.
    const refs = Array.isArray(outgoing.refs) ? outgoing.refs : [];
    const substitutions = Array.isArray(outgoing.substitutions) ? outgoing.substitutions : [];

    const report = (fields) => {
      const done = {
        args: a, startedAt, refs, substitutions,
        cancelReason: null, httpStatus: null, contentType: null, responseText: '',
        error: null, elapsed: now() - startedAt, firstByteMs: null, firstTokenMs: null,
        ...fields,
      };
      setImmediate(() => {
        try {
          onFinish(done);
        } catch (err) {
          log.warn('Request log: could not record a request:', err && err.message);
        }
      });
    };

    if (outgoing.blocked) {
      log.warn(outgoing.error);
      report({ outcome: 'blocked', error: outgoing.error, elapsed: 0 });
      return Promise.resolve({ status: 0, body: '', elapsed: 0, headers: {}, blocked: true, error: outgoing.error });
    }

    return new Promise((resolve) => {
      inFlight += 1;
      const entry = { req: null, cancelReason: null };
      let settled = false;
      // The response once its headers arrived: what it delivered so far.
      let response = null;
      const elapsed = () => now() - startedAt;

      const finish = (reply, fields) => {
        if (settled) return;
        settled = true;
        inFlight -= 1;
        if (requestId && active.get(requestId) === entry) active.delete(requestId);
        resolve(reply);
        report(fields);
      };

      const seen = () => (response ? {
        httpStatus: response.res.statusCode,
        contentType: String(response.res.headers['content-type'] || '') || null,
        responseText: Buffer.concat(response.chunks).toString('utf8'),
        firstByteMs: response.firstByteMs,
        firstTokenMs: response.firstTokenMs,
      } : {});

      const failNetwork = (error, outcome = 'error') => {
        const e = elapsed();
        finish({ status: 0, body: '', elapsed: e, headers: {}, networkError: true, error }, { outcome, error, elapsed: e, ...seen() });
      };
      const finishCancelled = () => {
        const e = elapsed();
        finish({ status: 0, body: '', elapsed: e, headers: {}, cancelled: true },
          { outcome: 'cancelled', cancelReason: entry.cancelReason, elapsed: e, ...seen() });
      };

      let urlObj;
      try {
        urlObj = new URL(outgoing.url);
      } catch (err) {
        failNetwork(err.message);
        return;
      }
      const isHttps = urlObj.protocol === 'https:';
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: method || 'GET',
        headers: outgoing.headers || {},
        // Socket inactivity timeout. A video generator sends nothing for minutes
        // while it works, so a fixed 60s here would kill it regardless of the
        // deadline the caller set for that kind of model.
        timeout: Number(timeoutMs) > 0 ? Number(timeoutMs) : 60000,
      };

      const onResponse = (res) => {
        // Collected as Buffers and decoded once at the end. `data += chunk`
        // decodes each chunk on its own, so a UTF-8 character split across a
        // chunk boundary comes out mangled — "Bốn" renders as "Bón".
        // firstByteMs: time to the first byte of the body (for a stream, the
        // first token as far as the wire can tell). firstTokenMs: time to the
        // first chunk carrying model text; a proxy can answer with headers, a
        // keep-alive comment or an empty role delta long before the model does.
        response = { res, chunks: [], firstByteMs: null, firstTokenMs: null };
        res.on('data', (chunk) => {
          const t = elapsed();
          if (response.firstByteMs === null) response.firstByteMs = t;
          if (response.firstTokenMs === null && CONTENT_TOKEN.test(chunk.toString('utf8'))) response.firstTokenMs = t;
          response.chunks.push(chunk);
        });
        res.on('end', () => {
          const s = seen();
          const e = elapsed();
          finish(
            { status: res.statusCode, body: s.responseText, elapsed: e, firstByteMs: s.firstByteMs, firstTokenMs: s.firstTokenMs, headers: res.headers },
            { outcome: 'end', elapsed: e, ...s },
          );
        });
        // The body stopped before 'end'. Node emits 'aborted', then 'error'
        // (ECONNRESET), then 'close'. Either a cancel (hedge loser, Stop,
        // deadline) or the server dropping the connection mid-stream; before
        // finish-once, neither ever resolved the renderer's promise.
        const cut = () => (entry.cancelReason ? finishCancelled() : failNetwork(CUT_OFF, 'aborted'));
        res.on('aborted', cut);
        res.on('error', cut);
        res.on('close', () => {
          if (!res.complete) cut();
        });
      };

      let req;
      try {
        req = (isHttps ? https : http).request(options, onResponse);
      } catch (err) {
        // Node refuses to build it (a header value with a newline, say).
        failNetwork(err.message);
        return;
      }
      entry.req = req;
      if (requestId) active.set(requestId, entry);

      req.on('error', (err) => {
        if (entry.cancelReason) finishCancelled();
        // A reset after the headers arrived is the body being cut off, the
        // same as res 'aborted', whichever event Node delivers first.
        else if (response) failNetwork(CUT_OFF, 'aborted');
        else failNetwork(err.message);
      });
      req.on('timeout', () => {
        const error = `No response for ${Math.round(options.timeout / 1000)}s`;
        const e = elapsed();
        finish({ status: 0, body: '', elapsed: e, headers: {}, networkError: true, timedOut: true, error },
          { outcome: 'timeout', error, elapsed: e, ...seen() });
        // Destroying fires 'error' (and 'aborted' mid-body); finish() ignores both.
        req.destroy();
      });

      try {
        if (outgoing.body) req.write(typeof outgoing.body === 'string' ? outgoing.body : JSON.stringify(outgoing.body));
        req.end();
      } catch (err) {
        req.destroy();
        failNetwork(err.message);
      }
    });
  }

  // reason: hedge_lost | stop | deadline; anything else is recorded as stop.
  // An id that already finished (or never existed) is a no-op.
  function cancel(requestId, reason) {
    const entry = active.get(requestId);
    if (!entry) return false;
    active.delete(requestId);
    entry.cancelReason = CANCEL_REASONS.has(reason) ? reason : 'stop';
    entry.req.destroy();
    return true;
  }

  return { request, cancel, inFlight: () => inFlight };
}

module.exports = { createApiRequester, CONTENT_TOKEN };
```

- [ ] **Step 4: Run it to see it pass**

Run: `npm test -- test/api-request.test.js`
Expected: `# pass 12`, `# fail 0`.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: `# pass 242`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/api-request.js test/api-request.test.js
git commit -m "feat: finish-once api requester - one ending per request, logged after the reply"
```

---

### Task 13: Data IPC hooks for main-side caches

**Files:**
- Modify: `src/db/ipc.js` (`registerDataIpc`)
- Test: `test/db/ipc.test.js` (two tests added)

**Interfaces:**
- Consumes: nothing new.
- Produces: `registerDataIpc({ ipcMain, repos, clipboard, log, hooks = {} })`; `hooks.onSettingsSaved(mergedSettings)` after `save-settings` succeeds, `hooks.onCatalogWritten()` after `write-catalog` succeeds. A hook that throws is logged with `log.warn` and the save still answers as before. The channel list is unchanged.

- [ ] **Step 1: Append the failing tests to `test/db/ipc.test.js`**

```js
test('save-settings hands main the merged settings; write-catalog says the pool changed', async (t) => {
  const store = await memoryStore(t);
  const ipc = fakeIpcMain();
  const seen = [];
  registerDataIpc({
    ipcMain: ipc, repos: store.repos, clipboard: { writeText() {} }, log: quietLog,
    hooks: { onSettingsSaved: (s) => seen.push(['settings', s]), onCatalogWritten: () => seen.push(['catalog']) },
  });
  await ipc.invoke('save-settings', { theme: 'daylight' });
  await ipc.invoke('save-settings', { logLevel: 'all', aaApiKey: 'aa-typed' });
  await ipc.invoke('write-catalog', { models: {} });
  assert.deepStrictEqual(seen, [
    ['settings', { theme: 'daylight' }],
    ['settings', { theme: 'daylight', logLevel: 'all' }],
    ['catalog'],
  ]);
});

test('a hook that throws does not fail the save', async (t) => {
  const store = await memoryStore(t);
  const ipc = fakeIpcMain();
  const warnings = [];
  registerDataIpc({
    ipcMain: ipc, repos: store.repos, clipboard: { writeText() {} },
    log: { ...quietLog, warn: (...a) => warnings.push(a.join(' ')) },
    hooks: { onSettingsSaved: () => { throw new Error('cache bug'); }, onCatalogWritten: () => { throw new Error('cache bug'); } },
  });
  assert.deepStrictEqual(await ipc.invoke('save-settings', { theme: 'daylight' }), { success: true });
  assert.deepStrictEqual(await ipc.invoke('write-catalog', { models: {} }), { written: 0, deleted: 0 });
  assert.strictEqual(store.repos.settings.get('settings').theme, 'daylight');
  assert.strictEqual(warnings.length, 2);
  assert.match(warnings[0], /onSettingsSaved failed/);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- test/db/ipc.test.js`
Expected: FAIL — the first new test sees `[]` (no hooks called); the second sees no warnings. `# fail 2`.

- [ ] **Step 3: Add the hooks in `src/db/ipc.js`**

Replace:
```js
function registerDataIpc({ ipcMain, repos, clipboard, log = console }) {
```
with:
```js
function registerDataIpc({ ipcMain, repos, clipboard, log = console, hooks = {} }) {
  // Main-side caches that follow the saved data (the request log's body
  // setting and retention limits, its price cache). The save itself already
  // succeeded, so a hook that fails is logged, not thrown.
  const notify = (name, ...args) => {
    if (typeof hooks[name] !== 'function') return;
    try {
      hooks[name](...args);
    } catch (err) {
      log.warn(`${name} failed:`, err.message);
    }
  };
```

Replace:
```js
  handle('save-settings', (settings) => {
    repos.settings.saveSettings(settings);
    return { success: true };
  });
```
with:
```js
  handle('save-settings', (settings) => {
    const merged = repos.settings.saveSettings(settings);
    notify('onSettingsSaved', merged);
    return { success: true };
  });
```

Replace:
```js
  handle('write-catalog', (catalog, writeOpts) => repos.catalog.write(catalog, { reset: !!writeOpts && writeOpts.reset === true }));
```
with:
```js
  handle('write-catalog', (catalog, writeOpts) => {
    const out = repos.catalog.write(catalog, { reset: !!writeOpts && writeOpts.reset === true });
    notify('onCatalogWritten');
    return out;
  });
```

- [ ] **Step 4: Run it to see it pass**

Run: `npm test -- test/db/ipc.test.js`
Expected: `# pass 13`, `# fail 0`.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: `# pass 244`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/db/ipc.js test/db/ipc.test.js
git commit -m "feat(db): save-settings and write-catalog notify main-side caches"
```

---

### Task 14: Main wiring — requester, `startLogs`, logs IPC, quit order, smoke test, preload

**Files:**
- Modify: `src/main.js`
- Modify: `src/preload.js`
- Test: `test/main-wiring.test.js`

**Interfaces:**
- Consumes: `createApiRequester` (Task 12), `readLogSettings` (Task 1), `tryOpen`/`open` (Task 7), `createRecorder` (Task 11), `createPriceBook`/`createProviderLookup` (Task 11), `purge`/`createPurgeScheduler` (Task 5), `registerLogsIpc` (Task 8), `registerDataIpc` hooks (Task 13).
- Produces (renderer-facing, used by Tasks 16-19):
  - `window.electronAPI.apiRequest(opts)` — `opts.logLevel` is gone; tags `source`, `runId`, `attempt`, `hedgeIndex`, `testGroup`, `trigger`, `paramSwap` are accepted.
  - `window.electronAPI.cancelApiRequest(requestId, reason)`.
  - `window.electronAPI.logsList(filters, cursor, limit)`, `logsGet(id)`, `logsStats(filters, bucket, groupBy)`, `logsFacets(range)`, `logsRunSummary(runId)`, `logsExport(filters, format)`, `logsInfo()`, `logsClear(opts)`.
  - main: `startLogs()` (never throws), `stopLogs()` (purge timer → `logs.close()`), `will-quit` = `stopUpdateChecks()` → `stopLogs()` → `store.close()`.

- [ ] **Step 1: Write the failing test `test/main-wiring.test.js`**

```js
// main.js needs Electron and can't be loaded under the test runner, so its
// startup and quit order (spec §1) is pinned by reading the source. The
// modules it wires are tested on their own.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// CRLF checkouts would hide the '\n}\n' and '\n});' block markers.
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8').replace(/\r\n/g, '\n');

function block(start, end = '\n});') {
  const at = src.indexOf(start);
  assert.ok(at >= 0, `${start} not found in main.js`);
  return src.slice(at, src.indexOf(end, at));
}

test('startLogs runs after the database opened and before the IPC and the window', () => {
  const ready = block('app.whenReady().then(async () => {');
  const steps = ['startDatabase()', 'startLogs()', 'registerDataIpc(', 'registerLogsIpc(', 'createWindow()'];
  const at = steps.map((s) => ready.indexOf(s));
  at.forEach((i, n) => assert.ok(i >= 0, `${steps[n]} missing from whenReady`));
  assert.deepStrictEqual([...at].sort((x, y) => x - y), at);
});

test('will-quit stops logging (purge timer, then the log DB) before closing venom.db', () => {
  const quit = block("app.on('will-quit', () => {");
  assert.ok(quit.indexOf('stopLogs()') >= 0 && quit.indexOf('stopLogs()') < quit.indexOf('store.close()'));
  const stop = block('function stopLogs() {', '\n}\n');
  assert.ok(stop.indexOf('purgeScheduler.stop()') >= 0 && stop.indexOf('purgeScheduler.stop()') < stop.indexOf('logs.close()'));
});

test('the startup-failure path closes the log database too', () => {
  const ready = block('app.whenReady().then(async () => {');
  const caught = ready.indexOf('} catch (err) {');
  assert.ok(caught >= 0 && ready.indexOf('stopLogs()', caught) > caught);
});

test('requests.log is no longer written; showing and clearing it still work', () => {
  assert.ok(!/appendRequestLog|appendFileSync/.test(src));
  ['read-log-info', 'open-request-log', 'clear-request-log'].forEach((channel) => assert.ok(src.includes(`'${channel}'`), channel));
});

test('api-request goes through the requester and takes no logLevel', () => {
  assert.ok(src.includes("ipcMain.handle('api-request', (_event, args) => requester.request(args || {}));"));
  assert.ok(!/logLevel\s*[,}]/.test(block("ipcMain.handle('api-request'", '\n')));
  assert.ok(src.includes('requester.cancel(requestId, reason)'));
});

test('src/logs and src/api-request never load electron', () => {
  ['settings', 'classify', 'scrub', 'writer', 'retention', 'query', 'lookups', 'recorder', 'ipc', 'index']
    .forEach((m) => require(`../src/logs/${m === 'index' ? '' : m}`));
  require('../src/api-request');
  const electronDir = `${path.sep}node_modules${path.sep}electron${path.sep}`;
  assert.deepStrictEqual(Object.keys(require.cache).filter((f) => f.includes(electronDir)), []);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- test/main-wiring.test.js`
Expected: FAIL — the first five tests fail (`startLogs()` missing, `appendRequestLog` present, no requester); the last passes. `# fail 5`.

- [ ] **Step 3: Imports in `src/main.js`**

Replace:
```js
const https = require('https');
const http = require('http');
const fs = require('fs');
```
with:
```js
const https = require('https');
const fs = require('fs');
```

Replace:
```js
const { createKeyResolver } = require('./db/keys');
const { requestFlush } = require('./flush');
```
with:
```js
const { createKeyResolver } = require('./db/keys');
const { requestFlush } = require('./flush');
const { createApiRequester } = require('./api-request');
const { readLogSettings } = require('./logs/settings');
const { createRecorder } = require('./logs/recorder');
const { createPriceBook, createProviderLookup } = require('./logs/lookups');
const { purge, createPurgeScheduler } = require('./logs/retention');
const { registerLogsIpc } = require('./logs/ipc');
```

- [ ] **Step 4: `startLogs` / `stopLogs` in `src/main.js`**

Replace:
```js
// Swaps key placeholders for secrets in api-request (src/db/keys.js).
let keyResolver = null;
```
with:
```js
// Swaps key placeholders for secrets in api-request (src/db/keys.js).
let keyResolver = null;

// ============================================
// Request log — venom-logs.db (src/logs)
// ============================================
// Not critical data. If it can't be opened, logging is off for the session:
// the reason goes to electron-log and to logs-info, the window shows one
// warning, and the app carries on.
let logs = null;
let logsError = null;
let recorder = null;
let priceBook = null;
let purgeScheduler = null;
// The body setting and the retention limits, read from the saved settings
// row at startup and again on every save-settings; a request no longer
// carries logLevel.
let logSettings = readLogSettings(null);

function startLogs() {
  try {
    logSettings = readLogSettings(store.repos.settings.get('settings'));
    // Required here, like ./db: a native-module fault turns logging off
    // instead of stopping the app at module load.
    const logsDb = require('./logs');
    const opened = logsDb.tryOpen(app.getPath('userData'), { log });
    if (!opened.logs) throw opened.error;
    logs = opened.logs;
    priceBook = createPriceBook(store.db);
    recorder = createRecorder({
      writer: logs.writer,
      prices: priceBook,
      providers: createProviderLookup(store.db),
      getLogLevel: () => logSettings.logLevel,
    });
    purgeScheduler = createPurgeScheduler({
      run: () => purge(logs.db, { now: Date.now(), ...logSettings, meta: logs.repos.meta }),
      isBusy: () => requester.inFlight() > 0,
      log,
    });
    purgeScheduler.start();
  } catch (err) {
    log.error('Request logging is off for this session:', err);
    logsError = (err && err.message) || String(err);
    stopLogs();
  }
}

// The spec's will-quit order: the purge timer first, then the log DB's own
// close (flush timer, synchronous flush, close). venom.db closes after this.
function stopLogs() {
  if (purgeScheduler) {
    purgeScheduler.stop();
    purgeScheduler = null;
  }
  recorder = null;
  priceBook = null;
  if (logs) {
    try {
      logs.close();
    } catch (err) {
      log.warn('Could not close venom-logs.db:', err.message);
    }
    logs = null;
  }
}
```

- [ ] **Step 5: The smoke test also checks the request log**

Replace:
```js
// Release check (scripts/release.mjs): the packaged app is started with
// --smoke-test --user-data-dir=<temp>. It opens the database, writes and reads
// back a row, and exits 0 — proof that the native SQLite module loads from
// app.asar.unpacked. No window, no import, no network. (A run without
// --user-data-dir was already refused at the top of this file.)
```
with:
```js
// Release check (scripts/release.mjs): the packaged app is started with
// --smoke-test --user-data-dir=<temp>. It opens the database and the request
// log, writes and reads back a row in each, and exits 0 — proof that the
// native SQLite module loads from app.asar.unpacked. No window, no import, no
// network. (A run without --user-data-dir was already refused at the top of
// this file.)
```

Replace:
```js
    const back = smoke.repos.settings.get('smoke');
    smoke.close();
    code = back && back.stamp === stamp ? 0 : 1;
    console.log(code === 0 ? 'SMOKE OK' : 'SMOKE FAILED: the row read back differs');
```
with:
```js
    const back = smoke.repos.settings.get('smoke');
    smoke.close();
    // The request log opens in the same scratch folder, so a packaging fault
    // in src/logs shows up here, before release, and not as "logging is off"
    // on the owner's machine later.
    const logsDb = require('./logs');
    const smokeLogs = logsDb.open(app.getPath('userData'), { log });
    const uid = `SMOKE${Date.now()}`;
    smokeLogs.writer.add({ request_uid: uid, created_at: Date.now(), source: 'other', method: 'GET', endpoint: 'smoke://local', status: 'ok' });
    smokeLogs.writer.flush();
    const logged = smokeLogs.repos.query.list({ text: uid }, null, 1).rows[0];
    smokeLogs.close();
    const dbOk = !!back && back.stamp === stamp;
    const logsOk = !!logged && logged.request_uid === uid;
    code = dbOk && logsOk ? 0 : 1;
    console.log(code === 0 ? 'SMOKE OK' : `SMOKE FAILED: ${dbOk ? 'the log row' : 'the row'} read back differs`);
```

- [ ] **Step 6: Startup and quit order in `src/main.js`**

Replace:
```js
  if (!(await startDatabase())) {
    app.quit();
    return;
  }
  try {
    registerDataIpc({ ipcMain, repos: store.repos, clipboard, log });
    keyResolver = createKeyResolver({ providers: store.repos.providers, secrets: store.repos.secrets });
    initAutoUpdater();
    createWindow();
    startUpdateChecks();
  } catch (err) {
    // No windowless process may stay alive holding venom.db open.
    log.error('Startup failed after opening venom.db:', err);
    showStartupError('VENOM Router could not start, so it will close. Nothing was changed.', err.message);
    if (store) {
```
with:
```js
  if (!(await startDatabase())) {
    app.quit();
    return;
  }
  // Never throws: a log database that won't open turns logging off.
  startLogs();
  try {
    registerDataIpc({
      ipcMain,
      repos: store.repos,
      clipboard,
      log,
      hooks: {
        onSettingsSaved: (saved) => {
          logSettings = readLogSettings(saved);
        },
        onCatalogWritten: () => {
          if (priceBook) priceBook.invalidate();
        },
      },
    });
    registerLogsIpc({ ipcMain, getState: () => ({ logs, error: logsError }), dialog, getWindow: () => mainWindow, log });
    keyResolver = createKeyResolver({ providers: store.repos.providers, secrets: store.repos.secrets });
    initAutoUpdater();
    createWindow();
    startUpdateChecks();
  } catch (err) {
    // No windowless process may stay alive holding venom.db open.
    log.error('Startup failed after opening venom.db:', err);
    showStartupError('VENOM Router could not start, so it will close. Nothing was changed.', err.message);
    stopLogs();
    if (store) {
```

Replace:
```js
app.on('will-quit', () => {
  stopUpdateChecks();
  if (store) {
```
with:
```js
app.on('will-quit', () => {
  stopUpdateChecks();
  // The request log first, so its queue is flushed before venom.db closes.
  stopLogs();
  if (store) {
```

- [ ] **Step 7: Replace the `api-request` and `cancel-api-request` handlers**

In `src/main.js`, replace everything from the line
```js
// In-flight API requests by id, so the renderer can cancel hedged losers.
```
through the end of the cancel handler, whose last lines are
```js
ipcMain.on('cancel-api-request', (event, requestId) => {
  const req = activeApiRequests.get(requestId);
  if (req) {
    activeApiRequests.delete(requestId);
    req.__cancelled = true;
    req.destroy();
  }
});
```
(this span holds `activeApiRequests`, `CONTENT_TOKEN`, the whole `ipcMain.handle('api-request', …)` and the cancel handler) with:
```js
// ============================================
// API requests (src/api-request.js)
// ============================================
// Every request the renderer asks for goes out here, key placeholders
// swapped for secrets by keyResolver. Each one is handed to the request log
// once it has finished and its reply is on its way back.
const requester = createApiRequester({
  getResolver: () => keyResolver,
  onFinish: (done) => {
    if (recorder) recorder.record(done);
  },
  log,
});

ipcMain.handle('api-request', (_event, args) => requester.request(args || {}));

// Cancel an in-flight request by id. reason: hedge_lost (a faster attempt
// won), stop (the user), deadline (the adaptive per-kind limit).
ipcMain.on('cancel-api-request', (_event, requestId, reason) => {
  requester.cancel(requestId, reason);
});
```

- [ ] **Step 8: Stop writing `requests.log`**

Replace:
```js
// ============================================
// Request log
// ============================================
// Written so a failed test can be explained after the fact: what was sent, what
// came back. Off by default, because it is a file on disk containing the
// traffic of an authenticated API.
//
// The Authorization header is never written. A log that captures the request
// faithfully would capture the key with it, which turns a debugging aid into the
// exact thing the keystore work was meant to prevent.
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const REDACTED = '[redacted]';

let requestLogPath;
function getRequestLogPath() {
  if (!requestLogPath) requestLogPath = path.join(app.getPath('userData'), 'requests.log');
  return requestLogPath;
}

function redactHeaders(headers) {
  const out = {};
  Object.entries(headers || {}).forEach(([k, v]) => {
    out[k] = /^(authorization|x-api-key|api-key|cookie)$/i.test(k) ? REDACTED : v;
  });
  return out;
}

function clip(text, max = 4000) {
  const str = String(text ?? '');
  return str.length > max ? `${str.slice(0, max)}… [${str.length - max} more chars]` : str;
}

function appendRequestLog(entry) {
  try {
    const lp = getRequestLogPath();
    // Rotate rather than grow without bound; one previous file is kept.
    try {
      if (fs.existsSync(lp) && fs.statSync(lp).size > LOG_MAX_BYTES) {
        fs.renameSync(lp, `${lp}.1`);
      }
    } catch (_) {}
    fs.appendFileSync(lp, JSON.stringify(entry) + String.fromCharCode(10), 'utf-8');
  } catch (err) {
    log.warn('Could not write request log:', err.message);
  }
}
```
with:
```js
// ============================================
// Old request log file (requests.log)
// ============================================
// Requests are recorded in venom-logs.db now (src/logs) and this file is no
// longer written. It stays where it is until the owner clears it, so Settings
// can still show it and delete it.
let requestLogPath;
function getRequestLogPath() {
  if (!requestLogPath) requestLogPath = path.join(app.getPath('userData'), 'requests.log');
  return requestLogPath;
}
```

- [ ] **Step 9: Preload — cancel reasons and the log API**

In `src/preload.js` replace:
```js
  cancelApiRequest: (requestId) => ipcRenderer.send('cancel-api-request', requestId),
```
with:
```js
  // reason: hedge_lost | stop | deadline, recorded in the request log.
  cancelApiRequest: (requestId, reason) => ipcRenderer.send('cancel-api-request', requestId, reason),
```

Replace:
```js
  clearRequestLog: () => ipcRenderer.invoke('clear-request-log'),
```
with:
```js
  clearRequestLog: () => ipcRenderer.invoke('clear-request-log'),

  // Request log (venom-logs.db, owned by main). Read-only except export and clear.
  logsList: (filters, cursor, limit) => ipcRenderer.invoke('logs-list', filters, cursor, limit),
  logsGet: (id) => ipcRenderer.invoke('logs-get', id),
  logsStats: (filters, bucket, groupBy) => ipcRenderer.invoke('logs-stats', filters, bucket, groupBy),
  logsFacets: (range) => ipcRenderer.invoke('logs-facets', range),
  logsRunSummary: (runId) => ipcRenderer.invoke('logs-run-summary', runId),
  logsExport: (filters, format) => ipcRenderer.invoke('logs-export', filters, format),
  logsInfo: () => ipcRenderer.invoke('logs-info'),
  logsClear: (opts) => ipcRenderer.invoke('logs-clear', opts),
```

- [ ] **Step 10: Run the wiring test and the whole suite**

Run: `npm test -- test/main-wiring.test.js`
Expected: `# pass 6`, `# fail 0`.

Run: `npm test`
Expected: `# pass 250`, `# fail 0`.

- [ ] **Step 11: Nothing else in main still mentions the removed pieces**

Run: `grep -n "activeApiRequests\|appendRequestLog\|redactHeaders\|LOG_MAX_BYTES\|require('http')" src/main.js`
Expected: no output.

- [ ] **Step 12: Smoke test on a scratch folder under %TEMP%**

```bash
D="$TEMP/venom-smoke-logs-$$" && mkdir -p "$D" && env -u ELECTRON_RUN_AS_NODE NODE_ENV=development npx electron . --smoke-test --user-data-dir="$D"; echo "exit $?"; ls "$D"; rm -rf "$D"
```
Expected: `SMOKE OK`, `exit 0`, and the listing includes `venom.db` and `venom-logs.db`. No window opens.

- [ ] **Step 13: Commit**

```bash
git add src/main.js src/preload.js test/main-wiring.test.js
git commit -m "feat: wire the request log into main - finish-once api-request, startLogs, quit order, smoke test"
```

---

# Phase 3 — Renderer: run ids, tags, cancel reasons, Settings

Renderer files are plain browser scripts with no unit harness; each task is checked with `node --check`, a tag audit, the full suite, and in the end the live check (Task 19).

### Task 15: Renderer ULID helper

**Files:**
- Create: `src/renderer/ulid.js`
- Modify: `src/renderer/index.html` (load it before `app.js`)
- Test: `test/renderer-ulid.test.js`

**Interfaces:**
- Consumes: `src/db/ulid.js` (format reference), history `runUid` (Task 10).
- Produces: global `newUlid(now = Date.now()) → string` (26 Crockford base32 characters), available to `app.js`, `benchmark.js`, `catalog.js`, `key-usage.js`.

- [ ] **Step 1: Write the failing test `test/renderer-ulid.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ulid } = require('../src/db/ulid');
const { memoryStore } = require('./helpers');

// ulid.js is a plain browser script that declares a global function; it is
// evaluated here the same way and the function taken out.
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'ulid.js'), 'utf8');
const newUlid = new Function(`${source}\nreturn newUlid;`)();

test('newUlid: 26 Crockford characters, the same time prefix as src/db/ulid.js, unique', () => {
  const now = 1790000000000;
  const a = newUlid(now);
  const b = newUlid(now);
  assert.match(a, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.strictEqual(a.slice(0, 10), ulid(now).slice(0, 10));
  assert.notStrictEqual(a, b);
  assert.ok(newUlid(now + 1).slice(0, 10) > a.slice(0, 10));
});

test('the history repository keeps a run id the renderer made', async (t) => {
  const { repos } = await memoryStore(t);
  const runUid = newUlid();
  assert.strictEqual(repos.history.append({ at: 1, provider: 'nara', runUid, results: [] }, 300).runUid, runUid);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- test/renderer-ulid.test.js`
Expected: FAIL — `ENOENT: no such file or directory, open '...src\renderer\ulid.js'`.

- [ ] **Step 3: Write `src/renderer/ulid.js`**

```js
// ============================================
// Run ids — ULID, the same format as src/db/ulid.js
// ============================================
// A Route Test run and a benchmark model run get their id here, in the page,
// so every request they send can carry it and the history row (append-run)
// is saved under the same one. 48-bit millisecond time + 80 random bits in
// Crockford base32: sorts by time and needs no coordination.
function newUlid(now = Date.now()) {
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i += 1) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let rand = '';
  // 256 is a multiple of 32, so the modulo keeps every character equally likely.
  for (let i = 0; i < 16; i += 1) rand += ALPHABET[bytes[i] % 32];
  return time + rand;
}
```

- [ ] **Step 4: Load it before `app.js` in `src/renderer/index.html`**

Replace:
```html
  <script src="ui-select.js"></script>
  <script src="app.js"></script>
```
with:
```html
  <script src="ui-select.js"></script>
  <script src="ulid.js"></script>
  <script src="app.js"></script>
```

- [ ] **Step 5: Run it to see it pass**

Run: `npm test -- test/renderer-ulid.test.js`
Expected: `# pass 2`, `# fail 0`.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: `# pass 252`, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/ulid.js src/renderer/index.html test/renderer-ulid.test.js
git commit -m "feat(renderer): ULID helper for run ids"
```

---

### Task 16: Route Test — run id, attempt, hedge, test group, trigger, cancel reasons

**Files:**
- Modify: `src/renderer/app.js`

**Interfaces:**
- Consumes: `newUlid` (Task 15); `cancelApiRequest(requestId, reason)` and the `apiRequest` tags (Task 14); history `runUid` (Task 10).
- Produces (renderer globals): `requestTags` (Map), `routeRun` (`{ runId, trigger } | null`), `nextRequestId(tags = null)`, `routeTestTags(requestId) → { source: 'route_test', runId, trigger, attempt, hedgeIndex, testGroup, paramSwap }`; `raceAttempts(model, provider, stream, count, tags = {})`; `adaptiveNonStream(model, provider, tags = {})`; `verifyAsset(url, kind, headers = {}, requestId = null)`; `assetResult(url, kind, headers, requestId = null)`; `recordRun(providerId, providerName, results, runUid)`.

The Route Test call sites tagged here (current code quoted in each step): `verifyAsset` (HEAD / ranged GET), `attemptImage`, `attemptVideo` (create and each poll), `attemptDecision`, `attemptChat`. Cancel sites: `cancelAllInflight` (Stop → `stop`), `raceAttempts` (`hedge_lost`), `adaptiveNonStream` (winner → `hedge_lost`, Stop → `stop`, the per-kind deadline → `deadline`).

- [ ] **Step 1: Request ids carry tags; Stop cancels with `stop`**

Replace:
```js
let requestSeq = 0;
// Every id handed out during a run, so Stop can kill sockets that are already in
// flight. Without this, hitting Stop still leaves the hedged requests
// running (and billing) until the 60s request timeout fires.
const inflightIds = new Set();

function nextRequestId() {
  requestSeq += 1;
  const id = `req_${Date.now()}_${requestSeq}`;
  inflightIds.add(id);
  return id;
}

// Cancelling an already-finished id is a no-op in the main process, so this can
// safely fire at every id from the current run.
function cancelAllInflight() {
  inflightIds.forEach((id) => window.electronAPI.cancelApiRequest(id));
  inflightIds.clear();
}
```
with:
```js
let requestSeq = 0;
// Every id handed out during a run, so Stop can kill sockets that are already in
// flight. Without this, hitting Stop still leaves the hedged requests
// running (and billing) until the 60s request timeout fires.
const inflightIds = new Set();
// Request-log tags by request id ({ attempt, hedgeIndex, testGroup, paramSwap }),
// set when the id is handed out and read when its request goes out, so the
// round and the hedge index travel with the id instead of through every
// tester's signature. Cleared at the start of each run.
const requestTags = new Map();
// { runId, trigger } of the Route Test run in progress; null between runs.
let routeRun = null;

function nextRequestId(tags = null) {
  requestSeq += 1;
  const id = `req_${Date.now()}_${requestSeq}`;
  inflightIds.add(id);
  if (tags) requestTags.set(id, tags);
  return id;
}

// What a Route Test request carries into the request log.
function routeTestTags(requestId) {
  const t = (requestId && requestTags.get(requestId)) || {};
  return {
    source: 'route_test',
    runId: routeRun ? routeRun.runId : undefined,
    trigger: routeRun ? routeRun.trigger : undefined,
    attempt: t.attempt,
    hedgeIndex: t.hedgeIndex,
    testGroup: t.testGroup,
    paramSwap: t.paramSwap || undefined,
  };
}

// Cancelling an already-finished id is a no-op in the main process, so this can
// safely fire at every id from the current run. Only Stop calls it.
function cancelAllInflight() {
  inflightIds.forEach((id) => window.electronAPI.cancelApiRequest(id, 'stop'));
  inflightIds.clear();
}
```

- [ ] **Step 2: `verifyAsset` and `assetResult` carry the attempt's tags**

Replace:
```js
async function verifyAsset(url, kind, headers = {}) {
```
with:
```js
async function verifyAsset(url, kind, headers = {}, requestId = null) {
```

Replace:
```js
      res = await window.electronAPI.apiRequest({ url, method, headers: { ...headers, ...extra }, timeoutMs: 20000, logLevel: settings.logLevel });
```
with:
```js
      // Logged under the attempt that produced the link (requestId's tags).
      res = await window.electronAPI.apiRequest({ url, method, headers: { ...headers, ...extra }, timeoutMs: 20000, ...routeTestTags(requestId) });
```

Replace:
```js
async function assetResult(url, kind, headers) {
  const verified = await verifyAsset(url, kind, headers);
```
with:
```js
async function assetResult(url, kind, headers, requestId = null) {
  const verified = await verifyAsset(url, kind, headers, requestId);
```

- [ ] **Step 3: `attemptImage`**

Replace:
```js
    body: JSON.stringify({ model: model.id, prompt: settings.imagePrompt, n: 1 }),
    requestId,
    timeoutMs: deadline,
    logLevel: settings.logLevel,
```
with:
```js
    body: JSON.stringify({ model: model.id, prompt: settings.imagePrompt, n: 1 }),
    requestId,
    timeoutMs: deadline,
    ...routeTestTags(requestId),
```

Replace:
```js
  return { ...base, ...(await assetResult(url, 'image')) };
```
with:
```js
  return { ...base, ...(await assetResult(url, 'image', undefined, requestId)) };
```

- [ ] **Step 4: `attemptVideo` — the create call, the asset checks and every poll**

Replace:
```js
    body: JSON.stringify({ model: model.id, prompt: settings.videoPrompt }),
    requestId,
    timeoutMs: deadline,
    logLevel: settings.logLevel,
```
with:
```js
    body: JSON.stringify({ model: model.id, prompt: settings.videoPrompt }),
    requestId,
    timeoutMs: deadline,
    ...routeTestTags(requestId),
```

Replace:
```js
      if (url) return { ...pass, ...(await assetResult(url, 'video')) };
```
with:
```js
      if (url) return { ...pass, ...(await assetResult(url, 'video', undefined, requestId)) };
```

Replace:
```js
      const verified = await verifyAsset(contentUrl, 'video', { Authorization: `Bearer ${key.key}` });
```
with:
```js
      const verified = await verifyAsset(contentUrl, 'video', { Authorization: `Bearer ${key.key}` }, requestId);
```

Replace:
```js
    const poll = await window.electronAPI.apiRequest({
      url: `${endpoint}/${encodeURIComponent(job.id)}`,
      method: 'GET',
      headers: authHeaders(key.key),
      requestId: nextRequestId(),
      timeoutMs: 30000,
      logLevel: settings.logLevel,
    });
```
with:
```js
    // A poll belongs to the same attempt: it carries the create call's tags.
    const pollId = nextRequestId(requestTags.get(requestId) || null);
    const poll = await window.electronAPI.apiRequest({
      url: `${endpoint}/${encodeURIComponent(job.id)}`,
      method: 'GET',
      headers: authHeaders(key.key),
      requestId: pollId,
      timeoutMs: 30000,
      ...routeTestTags(pollId),
    });
```

- [ ] **Step 5: `attemptDecision`**

Replace:
```js
      questions: { probe: { type: 'noul', instructions: settings.decisionQuestion } },
    }),
    requestId,
    timeoutMs: deadline,
    logLevel: settings.logLevel,
```
with:
```js
      questions: { probe: { type: 'noul', instructions: settings.decisionQuestion } },
    }),
    requestId,
    timeoutMs: deadline,
    ...routeTestTags(requestId),
```

- [ ] **Step 6: `attemptChat` — the request, the asset check, and the parameter-swap re-sends**

Replace:
```js
      body: JSON.stringify(payload),
      requestId,
      timeoutMs: deadline,
      logLevel: settings.logLevel,
```
with:
```js
      body: JSON.stringify(payload),
      requestId,
      timeoutMs: deadline,
      ...routeTestTags(requestId),
```

Replace:
```js
        const verified = await verifyAsset(extractMediaUrl(parsed.content), model.kind);
```
with:
```js
        const verified = await verifyAsset(extractMediaUrl(parsed.content), model.kind, {}, requestId);
```

Replace:
```js
    if (result.status === 400 && /max_tokens|max_completion_tokens/i.test(errMsg)) {
      const swapped = swapTokenLimitField(provider.id);
      if (swapped) return attemptOnce(model, provider, stream, nextRequestId());
    }
    if (result.status === 400 && payload.reasoning_effort && REASONING_REJECTED.test(errMsg)) {
      noReasoningEffort.add(reasoningKey(provider.id, model.id));
      return attemptOnce(model, provider, stream, nextRequestId());
    }
```
with:
```js
    // A re-send after a rejected parameter is the same attempt, marked as one.
    const swapId = () => nextRequestId({ ...requestTags.get(requestId), paramSwap: true });
    if (result.status === 400 && /max_tokens|max_completion_tokens/i.test(errMsg)) {
      const swapped = swapTokenLimitField(provider.id);
      if (swapped) return attemptOnce(model, provider, stream, swapId());
    }
    if (result.status === 400 && payload.reasoning_effort && REASONING_REJECTED.test(errMsg)) {
      noReasoningEffort.add(reasoningKey(provider.id, model.id));
      return attemptOnce(model, provider, stream, swapId());
    }
```

- [ ] **Step 7: `raceAttempts` — hedge index per attempt, losers cancelled as `hedge_lost`**

Replace:
```js
function raceAttempts(model, provider, stream, count) {
```
with:
```js
function raceAttempts(model, provider, stream, count, tags = {}) {
```

Replace:
```js
    const cancelRest = () => ids.forEach((id) => window.electronAPI.cancelApiRequest(id));
```
with:
```js
    const cancelRest = () => ids.forEach((id) => window.electronAPI.cancelApiRequest(id, 'hedge_lost'));
```

Replace:
```js
    for (let i = 0; i < count; i++) {
      const id = nextRequestId();
```
with:
```js
    for (let i = 0; i < count; i++) {
      const id = nextRequestId({ ...tags, hedgeIndex: i });
```

- [ ] **Step 8: `adaptiveNonStream` — hedge index, and why the others are cut**

Replace:
```js
function adaptiveNonStream(model, provider) {
```
with:
```js
function adaptiveNonStream(model, provider, tags = {}) {
```

Replace:
```js
    const cancelAll = () => ids.forEach((id) => window.electronAPI.cancelApiRequest(id));
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(stepTimer);
      clearTimeout(deadlineTimer);
      cancelAll();
      resolve(r);
    };
```
with:
```js
    // Why the attempts still running are cut, for the request log: a winner
    // makes them hedge losers, Stop is the user's, and the per-kind deadline
    // is recorded as a timeout.
    const cancelAll = (reason) => ids.forEach((id) => window.electronAPI.cancelApiRequest(id, reason));
    const finish = (r, reason = 'hedge_lost') => {
      if (settled) return;
      settled = true;
      clearTimeout(stepTimer);
      clearTimeout(deadlineTimer);
      cancelAll(reason);
      resolve(r);
    };
```

Replace:
```js
      launched += 1;
      inflight += 1;
      const id = nextRequestId();
```
with:
```js
      launched += 1;
      inflight += 1;
      const id = nextRequestId({ ...tags, hedgeIndex: launched - 1 });
```

Replace:
```js
        if (abortTesting) return finish(best || { status: 'fail', response: 'Aborted', time: 0, tokens: 0 });
```
with:
```js
        if (abortTesting) return finish(best || { status: 'fail', response: 'Aborted', time: 0, tokens: 0 }, 'stop');
```

Replace:
```js
    deadlineTimer = setTimeout(
      () => finish(best || { status: 'fail', response: 'Timed out', time: deadline, tokens: 0, statusCode: 0, timedOut: true }),
      deadline
    );
```
with:
```js
    deadlineTimer = setTimeout(
      () => finish(best || { status: 'fail', response: 'Timed out', time: deadline, tokens: 0, statusCode: 0, timedOut: true }, 'deadline'),
      deadline
    );
```

- [ ] **Step 9: `testModel` — one test group per call, the round as `attempt`**

Replace:
```js
async function testModel(model, provider) {
  let transientRetries = 0;
```
with:
```js
async function testModel(model, provider) {
  // One id per testModel call, so the log pages can draw its retry chain.
  const testGroup = newUlid();
  let transientRetries = 0;
```

Replace:
```js
    rounds += 1;

    const r = await adaptiveNonStream(model, provider);
```
with:
```js
    rounds += 1;

    const r = await adaptiveNonStream(model, provider, { testGroup, attempt: rounds });
```

Replace:
```js
      const streamed = await raceAttempts(model, provider, true, STREAM_HEDGE);
```
with:
```js
      const streamed = await raceAttempts(model, provider, true, STREAM_HEDGE, { testGroup, attempt: rounds });
```

- [ ] **Step 10: `runTests` — the run's id and trigger; `recordRun` saves the run under it**

Replace:
```js
  isTesting = true;
  abortTesting = false;
  inflightIds.clear();
```
with:
```js
  isTesting = true;
  abortTesting = false;
  inflightIds.clear();
  requestTags.clear();
  // The run's id tags every request it sends and names its history run, so
  // the request log and the history agree on which run a request was part of.
  routeRun = { runId: newUlid(), trigger: scheduled ? 'scheduled' : 'manual' };
```

Replace:
```js
  const saved = await recordRun(p.id, p.name, testResults);
```
with:
```js
  // isTesting is already false here, so a new run may start while this one
  // is saved; it must keep its own routeRun.
  const finishedRun = routeRun;
  const saved = await recordRun(p.id, p.name, testResults, finishedRun.runId);
  if (routeRun === finishedRun) routeRun = null;
```

Replace:
```js
async function recordRun(providerId, providerName, results) {
  if (results.length === 0) return true;
  const run = {
    at: Date.now(),
```
with:
```js
async function recordRun(providerId, providerName, results, runUid) {
  if (results.length === 0) return true;
  const run = {
    runUid,
    at: Date.now(),
```

- [ ] **Step 11: Check the file parses and every Route Test call is tagged**

Run: `node --check src/renderer/app.js && echo OK`
Expected: `OK`.

Run: `grep -c "routeTestTags(" src/renderer/app.js`
Expected: `7` (the definition, `verifyAsset`, image, video create, video poll, decision, chat).

Run: `grep -n "cancelApiRequest(id)\|nextRequestId()" src/renderer/app.js`
Expected: no output.

Run: `grep -n "recordRun(" src/renderer/app.js`
Expected: exactly two lines — the definition and the call in `runTests` with `finishedRun.runId`.

- [ ] **Step 12: Run the whole suite**

Run: `npm test`
Expected: `# pass 252`, `# fail 0`.

- [ ] **Step 13: Commit**

```bash
git add src/renderer/app.js
git commit -m "feat(renderer): tag Route Test requests with run, attempt, hedge and test group; cancel reasons"
```

---

### Task 17: Tag every other `apiRequest` call; benchmark run ids and cancel reasons

**Files:**
- Modify: `src/renderer/app.js` (health, discovery, key check, `taggedApiRequest`)
- Modify: `src/renderer/catalog.js` (leaderboard)
- Modify: `src/renderer/key-usage.js` (key usage, key history)
- Modify: `src/renderer/benchmark.js` (benchmark and capability probes)

**Interfaces:**
- Consumes: `newUlid` (Task 15), the `apiRequest` tags and `cancelApiRequest(id, reason)` (Task 14).
- Produces: global `taggedApiRequest(source, provider) → (opts) => Promise<reply>` — the `apiRequest` handed to provider modules; a module's own `pricingUrl` / `plansUrl` pages are tagged `pricing`, everything else `source`. After this task no renderer call omits `source` and none passes `logLevel`.

The complete list of renderer `apiRequest` call sites and their source:

| # | File / function | Current code (to find it) | Source |
|---|---|---|---|
| 1 | `app.js` `checkProviderHealth` | `res = await window.electronAPI.apiRequest({` … `timeoutMs: HEALTH_TIMEOUT_MS,` | `health` |
| 2 | `app.js` `discoverModels` (module) | `apiRequest: window.electronAPI.apiRequest,` → Nara, Experiential, Token Harbor `fetchModels` | `discovery` / `pricing` |
| 3 | `app.js` `discoverModels` (plain) | `const modelsResult = await window.electronAPI.apiRequest({` | `discovery` |
| 4-9 | `app.js` Route Test | `verifyAsset`, `attemptImage`, `attemptVideo` (create, poll), `attemptDecision`, `attemptChat` | `route_test` (Task 16) |
| 10 | `app.js` `probeKey` | `return await window.electronAPI.apiRequest({` … `timeoutMs: HEALTH_TIMEOUT_MS,` | `key_check` |
| 11 | `benchmark.js` `ask` | `result = await window.electronAPI.apiRequest({` | `benchmark` + `runId`, `attempt`, `paramSwap` |
| 12 | `benchmark.js` `rawChat` | `return await window.electronAPI.apiRequest({` (capability probes) | `benchmark` |
| 13 | `catalog.js` `refreshLeaderboard` | `const r = await window.electronAPI.apiRequest({` (artificialanalysis.ai) | `leaderboard` |
| 14 | `key-usage.js` `refresh` job | `fetchKeyUsage({ apiKey: k.key, baseUrl: p.baseUrl, apiRequest: window.electronAPI.apiRequest })` → Mirai, Token Harbor | `key_usage` |
| 15 | `key-usage.js` `loadHistory` | `apiKey: k.key, baseUrl: p.baseUrl, apiRequest: window.electronAPI.apiRequest, page, pageSize: HISTORY_PAGE_SIZE,` → Mirai | `key_usage` |

Cancel sites here: `benchmark.js` `ask` and `rawChat` (`const onAbort = () => window.electronAPI.cancelApiRequest(requestId);`, the benchmark's Stop/dequeue) → `stop`.

- [ ] **Step 1: Health probes (`app.js`)**

Replace:
```js
        res = await window.electronAPI.apiRequest({
          url: `${p.baseUrl}${p.modelsEndpoint || '/models'}`,
          method: 'GET',
          headers: { Authorization: `Bearer ${k.key}`, 'Content-Type': 'application/json' },
          timeoutMs: HEALTH_TIMEOUT_MS,
        });
```
with:
```js
        res = await window.electronAPI.apiRequest({
          url: `${p.baseUrl}${p.modelsEndpoint || '/models'}`,
          method: 'GET',
          headers: { Authorization: `Bearer ${k.key}`, 'Content-Type': 'application/json' },
          timeoutMs: HEALTH_TIMEOUT_MS,
          source: 'health',
        });
```

- [ ] **Step 2: `taggedApiRequest` and discovery (`app.js`)**

Replace:
```js
// Discovery for one key. A provider can hand out catalogues that differ per key —
```
with:
```js
// The apiRequest handed to a provider module, tagged for the request log with
// what its caller is doing. A module's own pricing and plans pages (Nara,
// Experiential) are tagged 'pricing', whoever asked for them.
function taggedApiRequest(source, p) {
  const pricingPages = [p && p.pricingUrl, p && p.plansUrl].filter(Boolean);
  return (opts) => window.electronAPI.apiRequest({
    ...opts,
    source: pricingPages.some((u) => String(opts.url || '').startsWith(u)) ? 'pricing' : source,
  });
}

// Discovery for one key. A provider can hand out catalogues that differ per key —
```

Replace:
```js
      apiRequest: window.electronAPI.apiRequest,
      formatContext,
```
with:
```js
      apiRequest: taggedApiRequest('discovery', p),
      formatContext,
```

Replace:
```js
  const modelsResult = await window.electronAPI.apiRequest({
    url: `${p.baseUrl}/models`,
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  });
```
with:
```js
  const modelsResult = await window.electronAPI.apiRequest({
    url: `${p.baseUrl}/models`,
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    source: 'discovery',
  });
```

- [ ] **Step 3: Key check (`app.js` `probeKey`)**

Replace:
```js
      body: check.body ? JSON.stringify(check.body) : undefined,
      timeoutMs: HEALTH_TIMEOUT_MS,
    });
```
with:
```js
      body: check.body ? JSON.stringify(check.body) : undefined,
      timeoutMs: HEALTH_TIMEOUT_MS,
      source: 'key_check',
    });
```

- [ ] **Step 4: Leaderboard (`catalog.js` `refreshLeaderboard`)**

Replace:
```js
      headers: { 'x-api-key': settings.aaApiKey.trim(), Accept: 'application/json' },
      timeoutMs: 30000,
    });
```
with:
```js
      headers: { 'x-api-key': settings.aaApiKey.trim(), Accept: 'application/json' },
      timeoutMs: 30000,
      source: 'leaderboard',
    });
```

- [ ] **Step 5: Key usage and history (`key-usage.js`)**

Replace:
```js
        const usage = await adapterOf(p).fetchKeyUsage({ apiKey: k.key, baseUrl: p.baseUrl, apiRequest: window.electronAPI.apiRequest });
```
with:
```js
        const usage = await adapterOf(p).fetchKeyUsage({ apiKey: k.key, baseUrl: p.baseUrl, apiRequest: taggedApiRequest('key_usage', p) });
```

Replace:
```js
        apiKey: k.key, baseUrl: p.baseUrl, apiRequest: window.electronAPI.apiRequest, page, pageSize: HISTORY_PAGE_SIZE,
```
with:
```js
        apiKey: k.key, baseUrl: p.baseUrl, apiRequest: taggedApiRequest('key_usage', p), page, pageSize: HISTORY_PAGE_SIZE,
```

- [ ] **Step 6: Benchmark (`benchmark.js`) — cancel reason, run id, attempt, parameter swap**

Replace every occurrence (two: in `ask` and in `rawChat`; use the Edit tool's replace-all):
```js
    const onAbort = () => window.electronAPI.cancelApiRequest(requestId);
```
with:
```js
    const onAbort = () => window.electronAPI.cancelApiRequest(requestId, 'stop');
```

Replace:
```js
  async function ask(provider, model, key, prompt, { stream = false, maxTokens = 400, signal } = {}) {
```
with:
```js
  async function ask(provider, model, key, prompt, { stream = false, maxTokens = 400, signal, runId, attempt, paramSwap } = {}) {
```

Replace:
```js
        timeoutMs: Math.min(Number(settings.deadlineChatMs) || BENCH_DEADLINE_MS, BENCH_DEADLINE_MS),
        logLevel: settings.logLevel,
      });
```
with:
```js
        timeoutMs: Math.min(Number(settings.deadlineChatMs) || BENCH_DEADLINE_MS, BENCH_DEADLINE_MS),
        source: 'benchmark',
        runId,
        attempt,
        paramSwap: paramSwap || undefined,
      });
```

Replace:
```js
        timeoutMs: timeoutMs || BENCH_DEADLINE_MS,
        logLevel: settings.logLevel,
      });
```
with:
```js
        timeoutMs: timeoutMs || BENCH_DEADLINE_MS,
        source: 'benchmark',
      });
```

Replace:
```js
    let keyIx = 0;
    let waits = 0;
    let retries = 0;
    for (;;) {
      if (opts.signal && opts.signal.aborted) return { status: 'cancelled', time: 0 };
      const key = keys[keyIx % keys.length];
      const r = await ask(provider, model, key, prompt, opts);
```
with:
```js
    let keyIx = 0;
    let waits = 0;
    let retries = 0;
    // For the request log: which try this is (1-based), and whether it
    // re-sends after a parameter the provider rejected.
    let attempt = 0;
    let paramSwap = false;
    for (;;) {
      if (opts.signal && opts.signal.aborted) return { status: 'cancelled', time: 0 };
      const key = keys[keyIx % keys.length];
      attempt += 1;
      const r = await ask(provider, model, key, prompt, { ...opts, attempt, paramSwap });
      paramSwap = false;
```

Replace:
```js
          if (swapTokenLimitField(provider.id)) { retries += 1; continue; }
        }
        if (/thinking|reasoning[_ ]effort|reasoning\.effort/.test(msg) && typeof noReasoningEffort !== 'undefined') {
          noReasoningEffort.add(reasoningKey(provider.id, model.id));
          retries += 1;
          continue;
        }
```
with:
```js
          if (swapTokenLimitField(provider.id)) { retries += 1; paramSwap = true; continue; }
        }
        if (/thinking|reasoning[_ ]effort|reasoning\.effort/.test(msg) && typeof noReasoningEffort !== 'undefined') {
          noReasoningEffort.add(reasoningKey(provider.id, model.id));
          retries += 1;
          paramSwap = true;
          continue;
        }
```

Replace:
```js
    const keys = keysFor(provider, model);
    if (!keys.length) throw new Error('No active key for this provider');
    const total = TASKS.length + 2;
```
with:
```js
    const keys = keysFor(provider, model);
    if (!keys.length) throw new Error('No active key for this provider');
    // One id per model run: every request of this benchmark carries it.
    const runId = newUlid();
    const total = TASKS.length + 2;
```

Replace:
```js
{ stream: true, maxTokens: LATENCY_PROBE.maxTokens, signal }, tick);
```
with:
```js
{ stream: true, maxTokens: LATENCY_PROBE.maxTokens, signal, runId }, tick);
```

Replace:
```js
{ stream: true, maxTokens: THROUGHPUT_PROBE.maxTokens, signal }, tick);
```
with:
```js
{ stream: true, maxTokens: THROUGHPUT_PROBE.maxTokens, signal, runId }, tick);
```

Replace:
```js
        const r = await askWithRetry(provider, model, keys, task.prompt, { maxTokens: 400, signal }, tick);
```
with:
```js
        const r = await askWithRetry(provider, model, keys, task.prompt, { maxTokens: 400, signal, runId }, tick);
```

- [ ] **Step 7: Audit — every call tagged, no `logLevel` left, nothing untagged handed to a module**

Run: `node --check src/renderer/app.js && node --check src/renderer/benchmark.js && node --check src/renderer/catalog.js && node --check src/renderer/key-usage.js && echo OK`
Expected: `OK`.

Run:
```bash
node -e "const fs=require('fs');for(const f of ['app.js','benchmark.js','catalog.js','key-usage.js']){const s=fs.readFileSync('src/renderer/'+f,'utf8');const re=/electronAPI\.apiRequest\(\{([\s\S]*?)\}\);/g;let m;while((m=re.exec(s))){const line=s.slice(0,m.index).split('\n').length;console.log(f+':'+line,/source:|routeTestTags\(/.test(m[1])?'tagged':'UNTAGGED');}}"
```
Expected: 13 lines, every one ending in `tagged` (app.js × 10 including `taggedApiRequest`, benchmark.js × 2, catalog.js × 1), none `UNTAGGED`.

Run: `grep -rn "logLevel" src/renderer/*.js`
Expected: exactly two lines, both in `app.js`: the `logLevel:` default in `DEFAULT_SETTINGS` and `['#set-log-level', 'logLevel', 'text'],`.

Run: `grep -rn "apiRequest: window.electronAPI.apiRequest\|cancelApiRequest(requestId)" src/renderer`
Expected: no output.

- [ ] **Step 8: Run the whole suite**

Run: `npm test`
Expected: `# pass 252`, `# fail 0`.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/app.js src/renderer/catalog.js src/renderer/key-usage.js src/renderer/benchmark.js
git commit -m "feat(renderer): tag every request with its source; benchmark run ids and cancel reasons"
```

---

### Task 18: Settings copy, the new-install default, the logging-off warning, release note

**Files:**
- Modify: `src/renderer/index.html` (Diagnostics & Logs section)
- Modify: `src/renderer/app.js` (`DEFAULT_SETTINGS.logLevel`, `init()`)
- Modify: `CHANGELOG.md` (`[Unreleased]`)

**Interfaces:**
- Consumes: `window.electronAPI.logsInfo()` (Task 14), `setStatus`, `storeReadError` (existing).
- Produces: `DEFAULT_SETTINGS.logLevel === 'errors'`; the `#set-log-level` select labelled "Request bodies" with options Off / Failed only / All (values unchanged: `off` / `errors` / `all`); element ids unchanged (`set-log-level`, `log-path`, `btn-open-log`, `btn-clear-log`).

- [ ] **Step 1: Rewrite the Diagnostics & Logs copy in `src/renderer/index.html`**

Replace:
```html
<p>Records what was sent and what came back, so a failed test can be explained after the fact.</p>
```
with:
```html
<p>Every request VENOM Router sends is recorded in a log database on this machine: when it ran, how long it took, the tokens it used and what it cost.</p>
```

Replace:
```html
<label class="settings-row-title" for="set-log-level">Log requests</label>
```
with:
```html
<label class="settings-row-title" for="set-log-level">Request bodies</label>
```

Replace:
```html
<div class="settings-row-desc">API keys are never written: the Authorization header is replaced before anything reaches disk. Bodies are clipped at 4,000 characters and the file rotates at 5 MB.</div>
```
with:
```html
<div class="settings-row-desc">Also keep what was sent and what came back, for 7 days, so a failed request can be explained after the fact. Keys are never stored: key headers are removed, and a key quoted back in a reply is replaced by its placeholder. Each body is clipped at 8 KB.</div>
```

Replace:
```html
<option value="errors">Failures only</option>
```
with:
```html
<option value="errors">Failed only</option>
```

Replace:
```html
<option value="all">Every request</option>
```
with:
```html
<option value="all">All</option>
```

Replace:
```html
<div class="settings-row-title">Log file</div>
```
with:
```html
<div class="settings-row-title">Old log file</div>
```

Replace:
```html
<div class="settings-row-desc">Where the log is written on this machine.</div>
```
with:
```html
<div class="settings-row-desc">requests.log from earlier versions. It is no longer written; clear it once you don't need it.</div>
```

Replace:
```html
</svg>Clear log</div>
```
with:
```html
</svg>Clear old log</div>
```

Replace:
```html
<div class="settings-zone-desc">The log file is emptied.</div>
```
with:
```html
<div class="settings-zone-desc">The old requests.log is deleted. The request log database is not touched.</div>
```

Replace:
```html
id="btn-clear-log">Clear log</button>
```
with:
```html
id="btn-clear-log">Clear old log</button>
```

- [ ] **Step 2: New installs start on Failed only (`src/renderer/app.js`)**

Replace:
```js
  // off | errors | all. Off by default: the log is a file on disk holding the
  // traffic of an authenticated API, even with the key stripped out of it.
  logLevel: 'off',
```
with:
```js
  // Request bodies in the request log: off | errors (Failed only) | all. The
  // metadata of every request is recorded whatever this says. Main reads it
  // from the saved settings row: a row without it (a new install) means
  // Failed only, and a value already saved is never changed.
  logLevel: 'errors',
```

- [ ] **Step 3: One status warning when logging is off (`src/renderer/app.js` `init()`)**

Replace:
```js
  if (!storeReadError && !writeFailed) setStatus('idle', 'Ready — add an API key to begin');
```
with:
```js
  if (!storeReadError && !writeFailed) setStatus('idle', 'Ready — add an API key to begin');
  // Request logging isn't critical: when its database couldn't be opened the
  // app runs on, and says so once.
  window.electronAPI.logsInfo()
    .then((info) => {
      if (info && info.enabled === false && !storeReadError) setStatus('error', `Request logging is off: ${info.error}`);
    })
    .catch((err) => console.error('Could not read the request log status:', err));
```

- [ ] **Step 4: Release note in `CHANGELOG.md`**

Replace:
```markdown
## [Unreleased]

### Changed
```
with:
```markdown
## [Unreleased]

### Added
- Request log. Every request the app sends is recorded in `venom-logs.db`
  next to `venom.db`: when it ran, how long it took (with time to first
  token), the tokens it used and what it cost, plus hourly summaries. Rows
  are kept 90 days and summaries 12 months. Model discovery, key checks,
  model pool and Artificial Analysis calls are recorded too; they never were
  before.

### Changed
- Settings → Diagnostics & Logs: "Log requests" is now "Request bodies"
  (Off / Failed only / All), kept 7 days. New installs start on Failed only;
  an existing choice is kept. `requests.log` is no longer written; the old
  file stays until you clear it.
```

- [ ] **Step 5: Check**

Run: `node --check src/renderer/app.js && echo OK`
Expected: `OK`.

Run: `grep -n "Request bodies\|Failed only\|Old log file\|Clear old log" src/renderer/index.html`
Expected: five lines — the label, the `Failed only` option, the `Old log file` row title, the `Clear old log` zone title and the `Clear old log` button.

Run: `npm test`
Expected: `# pass 252`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/index.html src/renderer/app.js CHANGELOG.md
git commit -m "feat(renderer): Request bodies setting, Failed only for new installs, logging-off warning"
```

---

# Phase 4 — Live check

### Task 19: Live check of the request log on the synthetic fixture

**Files:**
- Modify: `scripts/live/mock-provider.mjs` (pricing on `/models`, an `/echo-key` route)
- Modify: `scripts/live/fixture.mjs` (a pool price for `fixture-alpha`)
- Modify: `scripts/live/verify-db.mjs` (log checks; the `requests.log` check replaced)

**Interfaces:**
- Consumes: everything above; `launch` (`scripts/live/cdp.mjs`, refuses `%APPDATA%`), renderer globals `PROVIDERS`, `settings`, `models`, `switchProvider`, `runTests`.
- Produces: `npm run verify:live` (existing script) also checks: Route Test rows share the history run's id, tokens 5/1 and cost 20 µ$ from the mock's usage and the pool price, a failed request's stored body holds placeholders only, a row answered right before quitting survives the quit, health rows, logging on, "Request bodies" / Failed only, and no `requests.log`.

- [ ] **Step 1: The mock prices `fixture-alpha` and can quote a key back (`scripts/live/mock-provider.mjs`)**

Replace:
```js
// A local stand-in for the fixture's providers: OpenAI-shaped /models and
// /chat/completions on 127.0.0.1, answering only fixture keys. It records
// every request, so the live check can see which key actually went out.
```
with:
```js
// A local stand-in for the fixture's providers: OpenAI-shaped /models and
// /chat/completions on 127.0.0.1, answering only fixture keys. It records
// every request, so the live check can see which key actually went out.
// Completions report usage and fixture-alpha carries a price, so the request
// log's tokens and cost can be checked; /echo-key quotes the key it was sent
// back in an error, as some gateways do, so the log's scrubbing can be too.
```

Replace:
```js
        return send(200, { object: 'list', data: [
          { id: 'fixture-alpha', object: 'model', owned_by: 'fixture' },
          { id: 'fixture-beta', object: 'model', owned_by: 'fixture' },
        ] });
      }
      if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
```
with:
```js
        return send(200, { object: 'list', data: [
          { id: 'fixture-alpha', object: 'model', owned_by: 'fixture', pricing: { input_usd_per_1m: 2, output_usd_per_1m: 10 } },
          { id: 'fixture-beta', object: 'model', owned_by: 'fixture' },
        ] });
      }
      if (req.method === 'POST' && req.url.endsWith('/echo-key')) {
        return send(400, { error: { message: `fixture: rejected ${authorization}`, code: 'fixture_echo' } });
      }
      if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
```

- [ ] **Step 2: The imported pool already knows the price (`scripts/live/fixture.mjs`)**

Replace:
```js
      'darkapi::fixture-alpha': entry('fixture-alpha', {}),
```
with:
```js
      'darkapi::fixture-alpha': entry('fixture-alpha', { pricing: { input: 2, output: 10, source: 'provider' } }),
```

- [ ] **Step 3: Replace the `requests.log` check in `checkKeysStayInMain` (`scripts/live/verify-db.mjs`)**

Replace:
```js
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
```
with:
```js
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
```

Replace:
```js
      url: PROVIDERS.darkapi.baseUrl + '/chat/completions', method: 'POST', logLevel: 'all',
```
with:
```js
      url: PROVIDERS.darkapi.baseUrl + '/chat/completions', method: 'POST',
```

Replace:
```js
  const log = existsSync(join(dir, 'requests.log')) ? readFileSync(join(dir, 'requests.log'), 'utf-8') : '';
  check('requests.log keeps the placeholder, never the key', log.includes('venomkey:k_dark_1') && !log.includes(FIXTURE.keys.dark1));
```
with:
```js
  // The log writer flushes every 250 ms.
  await sleep(600);
  const logged = await app.evaluate("window.electronAPI.logsList({ model: 'fixture-alpha', source: ['other'] }, null, 10)");
  const row = logged.rows.find((r) => r.endpoint.endsWith('/darkapi/v1/chat/completions'));
  check('the request was logged under its key id, never the key',
    !!row && row.key_id === 'k_dark_1' && row.provider_id === 'darkapi' && row.status === 'ok' && !JSON.stringify(logged).includes(FIXTURE.keys.dark1),
    JSON.stringify(row && { key: row.key_id, provider: row.provider_id, status: row.status }));
```

- [ ] **Step 4: Add the request-log steps (`scripts/live/verify-db.mjs`)**

Replace:
```js
const RUN1 = [checkImport, checkKeysStayInMain];
const RUN1_END = [saveForNextRun, queueSaveThenClose];
const RUN2 = [checkPersistence, checkFlushOnClose, checkSingleInstance];
const RUN2_END = [checkWriteGate];
```
with:
```js
// ---- request log ---------------------------------------------------------------

// Answered right before closing: its row can only reach disk through the
// writer's queue — the 250 ms timer or the flush on quit.
const FLUSH_MARKER = `flush-probe-${Date.now()}`;

async function logRightBeforeClose({ app }) {
  await app.evaluate(`window.electronAPI.apiRequest({
    url: PROVIDERS.darkapi.baseUrl + '/${FLUSH_MARKER}', method: 'GET',
    headers: { Authorization: 'Bearer venomkey:k_dark_1' },
  }).then(() => true)`);
}

async function checkQueuedRowSurvivedQuit({ app }) {
  const { rows } = await app.evaluate("window.electronAPI.logsList({ source: ['other'], providerId: ['darkapi'] }, null, 200)");
  check('a request answered right before quitting was written on quit', rows.some((r) => r.endpoint.endsWith(`/${FLUSH_MARKER}`)), FLUSH_MARKER);
}

async function checkLoggingOn({ app, dir }) {
  const s = await app.evaluate(`(async () => ({
    info: await window.electronAPI.logsInfo(),
    health: (await window.electronAPI.logsList({ source: ['health'], providerId: ['darkapi'] }, null, 5)).rows,
    label: document.querySelector('label[for="set-log-level"]').textContent.trim(),
    level: settings.logLevel,
  }))()`);
  check('logging is on and venom-logs.db exists', s.info.enabled === true && s.info.rows > 0 && existsSync(join(dir, 'venom-logs.db')),
    JSON.stringify({ enabled: s.info.enabled, rows: s.info.rows, error: s.info.error }));
  check('health probes are logged with source health and a key id', s.health.length > 0 && /^k_dark_/.test(s.health[0].key_id), String(s.health.length));
  check('the body setting reads "Request bodies" and a new install is on Failed only', s.label === 'Request bodies' && s.level === 'errors', `${s.label} / ${s.level}`);
}

async function checkRouteTestLogged({ app }) {
  const s = await app.evaluate(`(async () => {
    const wait = async (fn, ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (fn()) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    };
    switchProvider('darkapi');
    document.querySelector('#btn-fetch-models').click();
    await wait(() => models.some((m) => m.id === 'fixture-alpha'), 15000);
    await runTests(models.filter((m) => m.id === 'fixture-alpha'));
    await new Promise((r) => setTimeout(r, 800));
    const hist = await window.electronAPI.readHistory();
    const last = hist.runs[hist.runs.length - 1];
    const rows = (await window.electronAPI.logsList({ source: ['route_test'] }, null, 50)).rows;
    return { runUid: last && last.runUid, result: last && last.results[0] && last.results[0].status, rows };
  })()`, 60000);
  const chat = s.rows.find((r) => r.endpoint.endsWith('/darkapi/v1/chat/completions'));
  check('the Route Test passed', s.result === 'pass', String(s.result));
  check('the Route Test wrote route_test rows', s.rows.length > 0, String(s.rows.length));
  check("every route_test row carries the history run's id", s.rows.length > 0 && s.rows.every((r) => r.run_id === s.runUid),
    `${s.runUid} vs ${[...new Set(s.rows.map((r) => r.run_id))].join(',')}`);
  check('tokens come from the mock usage', !!chat && chat.input_tokens === 5 && chat.output_tokens === 1 && chat.usage_source === 'reported',
    JSON.stringify(chat && { in: chat.input_tokens, out: chat.output_tokens }));
  check('cost comes from the pool price (5 × $2 + 1 × $10 per 1M = 20 micro-USD)', !!chat && chat.cost_micros === 20, String(chat && chat.cost_micros));
  check('the row names provider and key, attempt 1, not a hedge',
    !!chat && chat.provider_id === 'darkapi' && /^k_dark_/.test(chat.key_id) && chat.attempt === 1 && chat.is_hedge === 0);
  const meta = chat && chat.meta_json ? JSON.parse(chat.meta_json) : {};
  check('meta_json has the manual trigger and a testGroup', meta.trigger === 'manual' && typeof meta.testGroup === 'string', chat && chat.meta_json);
}

async function checkFailedBodyScrubbed({ app }) {
  const s = await app.evaluate(`(async () => {
    const res = await window.electronAPI.apiRequest({
      url: PROVIDERS.darkapi.baseUrl + '/echo-key', method: 'POST',
      headers: { Authorization: 'Bearer venomkey:k_dark_1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'fixture-alpha', api_key: 'venomkey:k_dark_1' }),
    });
    await new Promise((r) => setTimeout(r, 800));
    const { rows } = await window.electronAPI.logsList({ status: ['error'], providerId: ['darkapi'] }, null, 50);
    const row = rows.find((r) => r.endpoint.endsWith('/echo-key'));
    return { status: res.status, full: row ? await window.electronAPI.logsGet(row.id) : null };
  })()`);
  const full = s.full;
  const body = full && full.body;
  check('the echo route answered 400', s.status === 400, String(s.status));
  check('a failed request stored its body (Failed only)', !!body && full.has_body === 1);
  check('the stored reply holds the placeholder, never the key',
    !!body && body.response_body.includes('venomkey:k_dark_1') && !body.response_body.includes(FIXTURE.keys.dark1), body && body.response_body);
  check('the stored request is the unresolved one and the auth header is redacted',
    !!body && body.request_body.includes('venomkey:k_dark_1') && JSON.parse(body.request_headers_json).Authorization === '[redacted]');
  check('the stored error message is scrubbed too', !!full && full.error_message.includes('venomkey:k_dark_1'), full && full.error_message);
  check('nothing stored for that request holds the key', !!full && !JSON.stringify(full).includes(FIXTURE.keys.dark1));
}

async function checkNoRequestsLog({ dir }) {
  check('requests.log was not written', !existsSync(join(dir, 'requests.log')) && !existsSync(join(dir, 'requests.log.1')));
}

const RUN1 = [checkImport, checkKeysStayInMain];
const RUN1_END = [saveForNextRun, logRightBeforeClose, queueSaveThenClose];
const RUN2 = [
  checkPersistence, checkFlushOnClose, checkQueuedRowSurvivedQuit, checkSingleInstance,
  checkLoggingOn, checkRouteTestLogged, checkFailedBodyScrubbed, checkNoRequestsLog,
];
const RUN2_END = [checkWriteGate];
```

And in the header comment replace:
```js
// URLs on a local mock), launches a separate VENOM Router on it over CDP,
// checks the import and what survives a restart, then deletes the folder.
```
with:
```js
// URLs on a local mock), launches a separate VENOM Router on it over CDP,
// checks the import, the request log and what survives a restart, then
// deletes the folder.
```

- [ ] **Step 5: Run the live check (separate instance, scratch folder under %TEMP%)**

Run: `npm run verify:live`
Expected: every line `PASS`, ending with `ALL LIVE CHECKS PASSED`, exit code 0. It prints `Fixture data folder: <%TEMP%>\venom-live-…` and deletes that folder at the end. If port 47831 or 9333 is busy, stop only the process you started earlier; never touch the owner's running app.

- [ ] **Step 6: Run the whole suite once more**

Run: `npm test`
Expected: `# pass 252`, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add scripts/live/mock-provider.mjs scripts/live/fixture.mjs scripts/live/verify-db.mjs
git commit -m "test(live): request log checks - run ids, tokens and cost, scrubbed bodies, flush on quit"
```

---

## Spec coverage

| Spec section | Tasks |
|---|---|
| §1 File, pragmas, own `user_version`, no backup | 1, 7 |
| §1 Failure isolation, `logs-info {enabled:false}`, one warning, smoke test, will-quit order, dropped counter in meta | 4, 7, 8, 14, 18 |
| §1 Schema v1, roll-up rules, latency buckets, p95, `meta_json` whitelist | 1, 2, 4, 11 |
| §2 Finish-once `api-request`, blocked finishes at once | 12, 14 |
| §2 Sources and tags, run ids, history `runUid`, cancel reasons | 10, 15, 16, 17 |
| §2 Derived fields: provider/key refs, model, parsing limits, usage, cost + cache invalidation, status/class, error message | 2, 9, 11, 13, 14 |
| §2 Scrubbing substituted secrets, in memory only | 3, 9, 11, 12 |
| §2 Bodies: setting read by main, new-install default, failed rule, redaction, 8 KB | 1, 11, 13, 14, 18 |
| §2 Batched writer; `requests.log` not written, old file handlers kept | 4, 14, 18 |
| §3 Retention settings, schedule, deferral, chunks, vacuum, checkpoint, `last_purge_at` | 1, 5, 14 |
| §4 Query API (8 channels), off-mode empties, caps, LIKE escaping | 6, 8, 14 |
| §5 Unit, integration and live verification | 1-19 |
| Release rule (worktree, merge with C, Settings copy) | Execution notes, 18 |

