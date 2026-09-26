# Logging system (sub-project B) — design

Date: 2026-09-26
Status: rev 2 — design approved in chat; delegated reviewer's required changes applied
Depends on: sub-project A (`docs/superpowers/specs/2026-09-26-local-database-design.md`), merged
Research: `docs/superpowers/research/2026-09-26-new-api/03-logs.md` (recommendations), `02-data-model.md` §13

## Goal

Record every outbound request the desktop admin app makes, in a local log database that
the log pages (sub-project C) will read: per-request rows with benchmark-grade timings,
tokens and cost, hourly roll-ups with an approximate p95, captured bodies for debugging,
retention, and a query API. The schema leaves room for the future hosted relay.

## Release rule (owner decision)

B is built and reviewed on branch `feat/logging-system` in a **separate git worktree**
(`C:\Users\venom\Desktop\venom-router-logging`), and is **merged to `main` together with
C**, never alone. The owner's own checkout (`C:\Users\venom\Desktop\UPSTREAM CHECKER`)
stays on `main`, so their `npm start` keeps writing `requests.log` and showing today's
Settings text until the merge. B also rewrites the
"Diagnostics & Logs" Settings copy that describes `requests.log` (`index.html:1094-1108`)
so that the branch is self-consistent, and relabels the log-level select as
"Request bodies".

## Decisions (made with the owner)

| Topic | Decision |
|---|---|
| What is logged | Metadata of **every** request, always |
| Bodies | Setting "Request bodies": Off / Failed only / All; kept 7 days; default **Failed only** for new installs; an existing stored value is kept |
| `requests.log` | No longer written (on this branch); the old file stays until the owner clears it |
| Spend | Every request is costed; reports split by source |
| Latency | Average plus approximate p95 from hourly histogram buckets |
| Retention | Raw rows 90 days, bodies 7 days, hourly roll-ups 12 months |
| Merge | Together with C only |

## 1. Storage

### File and connection

- `venom-logs.db` next to `venom.db` in the app data folder, opened in main by the same
  `better-sqlite3` dependency, on its own connection.
- Pragmas: `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`,
  `temp_store=MEMORY`; `auto_vacuum=INCREMENTAL` set when the file is created, before
  the first table.
- Its own `PRAGMA user_version` and migration list, run like A's (one transaction per
  migration; the version is read before any other pragma, so a newer schema is never
  written). No backup before log migrations (disposable data).

### Failure isolation and lifecycle

- Logs are not critical data. `startLogs()` runs in **its own try/catch**, after
  `startDatabase()` succeeds and before `registerDataIpc` / `createWindow`. If the log
  DB cannot be opened or migrated, or its schema is newer than the app knows, logging is
  off for the session: the error goes to electron-log, `logs-info` returns
  `{ enabled: false, error }`, and the renderer shows one status warning ("Request
  logging is off: …"). The app never quits because of the log DB.
- `--smoke-test` also opens the log DB in its scratch folder and writes and reads one row
  (so a packaging fault in logs shows up before release).
- `will-quit` order: stop the purge timer → stop the flush timer → flush the queue
  synchronously → close the log DB → close `venom.db`. The startup-failure path closes
  the log DB too.
- The dropped-rows counter is kept in memory and mirrored to `meta` when a write
  succeeds, so it survives a failing DB for the session.

### Code layout

```
src/logs/index.js        open(dir, { log }), pragmas, migrate(), close(); returns { db, writer, repos }
src/logs/migrations.js   ordered { version, up(db) }; schema v1
src/logs/classify.js     pure: status, error class, model, usage, cost, stream detection
src/logs/scrub.js        pure: replace substituted secrets (raw, JSON-escaped, URL-encoded) with their placeholders
src/logs/writer.js       batched writer: queue, flush timer, roll-up upserts, dropped counter
src/logs/retention.js    chunked purge + stepped incremental vacuum
src/logs/query.js        list (keyset), get, stats, facets, run summary, export chunks, info, clear
src/logs/ipc.js          registers the log IPC channels
src/db/keys.js           (changed) resolve() also reports what it substituted
src/db/repos/history.js  (changed) accepts a provided runUid
src/main.js              (changed) api-request finish-once + record; startLogs; will-quit order
src/renderer/*           (changed) source/runId/attempt/hedge tags; cancel reasons; ULID helper; Settings copy
```

Nothing under `src/logs/` requires electron at load time; it is unit-tested under
Electron's Node like `src/db/`.

### Schema v1

Conventions from A: integer epoch-ms timestamps, 0/1 booleans, `*_json` TEXT columns,
money as integer micro-USD. No foreign keys (rows outlive providers and keys).

```
meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)
  -- dropped_rows, last_purge_at

request_logs(
  id INTEGER PRIMARY KEY,
  request_uid TEXT NOT NULL UNIQUE,            -- ULID
  created_at INTEGER NOT NULL,                 -- request start (rows are inserted at finish)
  source TEXT NOT NULL,                        -- see "Sources"
  run_id TEXT,                                 -- Route Test run_uid or benchmark run ULID
  attempt INTEGER NOT NULL DEFAULT 1,          -- the testModel round (1-based)
  is_hedge INTEGER NOT NULL DEFAULT 0,         -- hedge index > 0 (incl. raceAttempts i > 0)
  provider_id TEXT, provider_name TEXT,        -- snapshot
  key_id TEXT,                                 -- key id, or 'secret:<name>'; never key material
  method TEXT NOT NULL,
  endpoint TEXT NOT NULL,                      -- URL origin + path, no query string
  model_requested TEXT, model_returned TEXT,
  is_stream INTEGER NOT NULL DEFAULT 0,        -- request body stream === true, or response text/event-stream
  status TEXT NOT NULL,                        -- ok | error | timeout | cancelled | blocked
  http_status INTEGER,
  error_class TEXT,                            -- auth | rate_limit | quota | bad_request | server | network | timeout | blocked | other
  error_code TEXT,                             -- provider error.code || error.type, clipped to 100
  error_message TEXT,                          -- scrubbed, clipped to 500
  latency_ms INTEGER, ttft_ms INTEGER, first_byte_ms INTEGER,
  input_tokens INTEGER,                        -- total prompt tokens (see Usage)
  output_tokens INTEGER, cached_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
  usage_source TEXT,                           -- reported | none
  cost_micros INTEGER, price_json TEXT,
  has_body INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT,                              -- whitelisted keys only (see below)
  user_id TEXT, token_id TEXT, subscription_id TEXT, client_ip TEXT   -- future relay; NULL now
)
  INDEX (created_at), (provider_id, created_at), (model_requested, created_at),
        (source, created_at), (run_id)

request_bodies(
  log_id INTEGER PRIMARY KEY,                  -- request_logs.id
  created_at INTEGER NOT NULL,
  request_headers_json TEXT,                   -- redacted (authorization, x-api-key, api-key, cookie)
  request_body TEXT,                           -- the UNRESOLVED body (placeholders), clipped to 8 KB
  response_body TEXT,                          -- scrubbed, clipped to 8 KB
  truncated INTEGER NOT NULL DEFAULT 0)
  INDEX (created_at)

usage_hourly(
  hour_start INTEGER NOT NULL,                 -- UTC hour of created_at
  provider_id TEXT NOT NULL,                   -- '' when unknown
  model_id TEXT NOT NULL,                      -- model_requested; '' when unknown
  source TEXT NOT NULL,
  requests INTEGER NOT NULL, ok INTEGER NOT NULL,
  cancelled INTEGER NOT NULL, blocked INTEGER NOT NULL, timeouts INTEGER NOT NULL,
  e_auth INTEGER NOT NULL, e_rate_limit INTEGER NOT NULL, e_quota INTEGER NOT NULL,
  e_bad_request INTEGER NOT NULL, e_server INTEGER NOT NULL, e_network INTEGER NOT NULL,
  e_other INTEGER NOT NULL,
  latency_sum_ms INTEGER NOT NULL, latency_count INTEGER NOT NULL,
  lb0 INTEGER NOT NULL, lb1 INTEGER NOT NULL, lb2 INTEGER NOT NULL, lb3 INTEGER NOT NULL,
  lb4 INTEGER NOT NULL, lb5 INTEGER NOT NULL, lb6 INTEGER NOT NULL, lb7 INTEGER NOT NULL,
  lb8 INTEGER NOT NULL, lb9 INTEGER NOT NULL, lb10 INTEGER NOT NULL, lb11 INTEGER NOT NULL,
  lb12 INTEGER NOT NULL, lb13 INTEGER NOT NULL,
  ttft_sum_ms INTEGER NOT NULL, ttft_count INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cached_tokens INTEGER NOT NULL,
  cost_micros INTEGER NOT NULL,
  PRIMARY KEY (hour_start, provider_id, model_id, source))
```

- `errors = requests − ok − cancelled − blocked`; error rate = errors / (requests −
  cancelled − blocked).
- **Latency** feeds from rows with status `ok` or `error` that received an HTTP response
  (not timeouts, network errors, cancelled or blocked).
- **TTFT** is stored and rolled up only when `is_stream = 1` (for a non-streamed body the
  first content chunk is effectively the whole latency).
- Latency bucket upper edges, inclusive (ms): lb0 ≤100, lb1 ≤250, lb2 ≤500, lb3 ≤1000,
  lb4 ≤2000, lb5 ≤3000, lb6 ≤5000, lb7 ≤8000, lb8 ≤12000, lb9 ≤20000, lb10 ≤30000,
  lb11 ≤60000, lb12 ≤120000, lb13 >120000. Approx p95 = the upper edge of the first bucket
  whose cumulative count ≥ ceil(0.95 × latency_count); in lb13 it reports "≥120000".
- The roll-up upsert is plain addition: `col = col + excluded.col` for every counter.
- `meta_json` keys allowed: `requestId`, `timeoutMs`, `cancelReason`, `trigger`
  (`manual` | `scheduled`), `hedgeIndex`, `testGroup` (one id per `testModel` call, so C
  can draw the retry chain), `paramSwap` (a re-attempt after a parameter rejection).
  Nothing else; never headers.

## 2. What is recorded, and how

### One record per request (finish-once)

`api-request` gets a single settle-once `finish(outcome)` per request that both resolves
the IPC promise and hands the record to the writer. It is reached from exactly one of:
`res 'end'`; `res 'aborted'` / `'close'` before `'end'` (mid-stream cancel or a server
dropping the connection); `req 'error'`; `req 'timeout'` (which destroys the request;
the following `'error'` is ignored). A blocked request (resolver refusal) finishes
immediately without sending. The same guarantees apply whether or not logging is on.

### Sources and tags

The renderer adds `source`, and where relevant `runId`, `attempt`, `hedgeIndex`,
`testGroup`, `trigger`, `paramSwap` to every `apiRequest` call. Allowed sources:
`route_test`, `benchmark`, `health`, `key_check`, `key_usage`, `discovery`, `pricing`,
`leaderboard`, `other`; unknown or missing → `other`. The plan lists every call site.

- **Run ids**: a small renderer helper generates ULIDs (same format as `src/db/ulid.js`).
  Route Test generates its run's ULID at start, tags every request with it, and passes
  it to `append-run`; `history.js` uses a provided `runUid` only when it is a valid
  ULID, otherwise generates one; a duplicate uid is rejected without losing the run (a
  fresh one is generated and logged). Benchmark generates one ULID per model run.
- **Cancel reasons**: `cancelApiRequest(id, reason)` with `hedge_lost` | `stop` |
  `deadline`. `deadline` (the adaptive per-kind limit) is recorded as `status =
  timeout`, `error_class = timeout`; `stop` and `hedge_lost` as `cancelled`. The reason
  goes into `meta_json.cancelReason`.

### Derived fields

Built and classified in `setImmediate` after the IPC reply is sent, so logging adds no
work to the reply path.

- **Provider and key**: `resolve()` in `src/db/keys.js` returns the refs it substituted,
  `[{ kind: 'key' | 'secret', id, providerId }]`, on success and on refusal (naming the
  refused id). `key_id` = the key id, or `secret:<name>`. Without a key, the provider is
  the one whose `base_url` origin equals the URL origin; several matches → NULL.
- **Model**: `model` from a JSON request body; `model_returned` from the JSON response
  or the last SSE `data:` chunk carrying `model`.
- **Parsing limits**: JSON responses are parsed whole only up to 1 MB; larger bodies and
  all SSE streams are scanned from the tail for the last `usage` / `model`. For
  Anthropic SSE, `message_start.usage` (input) and `message_delta.usage` (output) are
  merged. Streams that don't request usage (Route Test doesn't send
  `stream_options.include_usage`) get `usage_source = 'none'`; payloads are not changed.
- **Usage**: `input_tokens` is total prompt tokens: OpenAI `prompt_tokens` (already
  includes cached); Anthropic `input_tokens + cache_read_input_tokens +
  cache_creation_input_tokens`. `cached_tokens` = OpenAI
  `prompt_tokens_details.cached_tokens` or Anthropic `cache_read_input_tokens`;
  `cache_write_tokens` = Anthropic `cache_creation_input_tokens`; `reasoning_tokens` =
  OpenAI `completion_tokens_details.reasoning_tokens`. Informational columns only.
- **Cost**: prices from the model pool (`models.summary_json.pricing`, `{input, output}`
  USD per 1M) looked up by `(provider_id, model_requested)` through a main-side cache
  invalidated whenever `write-catalog` saves. `cost_micros = round(input_tokens × input +
  output_tokens × output)`; free-tier prices (0) give 0; unknown price or no usage → NULL.
  `price_json` stores the prices used.
- **Status and error class**: 2xx → `ok`; cancel reason `hedge_lost`/`stop` →
  `cancelled`; resolver refusal → `blocked`; socket timeout or `deadline` → `timeout`;
  network error → `error`/`network`; 401/403 → `auth`; `error.code` or `error.type` in
  (`insufficient_quota`, `quota_exceeded`, `billing_hard_limit_reached`) → `quota` at any
  status; 402 → `quota`; 429 → `rate_limit`; other 4xx → `bad_request`; 5xx → `server`;
  anything else → `error`/`other`. Adapter-specific quota detection (`readQuotaError`)
  runs in the renderer and is not reflected in logs.
- **Error message**: extracted like the renderer's `failFromResponse` (`error.message`,
  else `message`, else `detail`, else the first 200 characters of the body), scrubbed,
  clipped to 500.

### Scrubbing substituted secrets

`resolve()` also returns `substitutions: [{ placeholder, secret }]` for this request. That
list stays in memory only: it goes straight to `scrub.js` and is never put in the
record, `meta_json`, electron-log or any IPC reply (a unit test asserts that no secret
value appears in any queued record). Before queueing,
`scrub.js` replaces every occurrence of each — raw, JSON-escaped
(`JSON.stringify(s).slice(1, -1)`), `\/`-escaped and `encodeURIComponent` forms, longest
first — with its placeholder in `error_message` and `response_body`. This only touches
stored log text, never the response returned to the renderer. Broader scrubbing of
responses stays the separate follow-up task.

### Bodies

- The body setting is `settings.logLevel` (`off` = Off, `errors` = Failed only, `all` =
  All). **Main reads it from the settings row**, caches it, and refreshes the cache on
  `save-settings`; the per-request `logLevel` parameter is removed.
- "New install" = a stored `settings` row without `logLevel` (or no row): the renderer's
  `DEFAULT_SETTINGS.logLevel` becomes `'errors'`. A stored value is never changed.
- "Failed" = any status other than `ok` and `cancelled` (so blocked, timeout and network
  errors are captured).
- Request body = the unresolved one (placeholders only); request headers redacted;
  response body scrubbed; each clipped to 8 KB, `truncated = 1` when clipped.
- Newly captured with this change (release note): discovery, key-check, catalogue and
  Artificial Analysis calls, which never passed `logLevel` before.

### Batched writer

- `writer.add(record, body?)` never blocks or throws into `api-request`.
- The queue flushes every 250 ms, or at once at 500 records, in **one transaction**:
  insert rows, insert bodies with the new row ids, upsert roll-ups.
- A failed flush drops that batch, adds its size to the dropped counter, and logs to
  electron-log at most once a minute. Queue cap 10 000 records; beyond it the oldest are
  dropped and counted.
- `requests.log` is not written on this branch (`appendRequestLog` removed).
  `read-log-info`, `open-request-log` and `clear-request-log` keep working on the old file.

## 3. Retention

- Settings read by main from the `settings` row (UI in C): `logRetentionDays` (90),
  `bodyRetentionDays` (7), `statsRetentionMonths` (12).
- The purge runs 30 s after startup and then every 24 h, and is deferred while requests
  are in flight (`activeApiRequests.size > 0`). It deletes in chunks of 1 000 rows using
  a fresh short keyset query per chunk (never an iterator held across a yield), yielding
  to the event loop between chunks: `request_logs` older than the limit (and their
  bodies), `request_bodies` older than theirs (setting `has_body = 0`), `usage_hourly`
  older than the stats limit; then `PRAGMA incremental_vacuum(2000)` in steps and
  `wal_checkpoint(TRUNCATE)`. `meta.last_purge_at` records the run.

## 4. Query API for sub-project C

All channels are read-only except export and clear. Errors propagate (no empty results on
failure). When logging is off, `logs-info` returns `{ enabled: false, error }` and the
other reads return empty results. IPC filter arrays are capped at 50 items; `text`
escapes `%` and `_` for LIKE.

| Channel | Returns |
|---|---|
| `logs-list(filters, cursor, limit)` | `{ rows, nextCursor }`, newest first, keyset on `(created_at, id)`, `limit` ≤ 200. Filters: `from`, `to`, `source[]`, `providerId[]`, `model`, `status[]`, `runId`, `text` (matches `request_uid`, `run_id`, `error_message`), `afterId` (for a live tail polled by id) |
| `logs-get(id)` | the row plus its body, or `null` |
| `logs-stats(filters, bucket, groupBy)` | from `usage_hourly` at hour granularity. Filters: `from`, `to`, `source[]`, `providerId[]`, `model`. `bucket` = `hour` or `day` (day = local date of each `hour_start`, grouped in JS, DST-safe). `groupBy` = `none` / `source` / `provider` / `model` / `error_class`. Returns totals and series: requests, ok %, errors by class, cancelled, blocked, average latency, approx p95, average TTFT (streams), tokens, cost |
| `logs-facets({ from, to })` | distinct providers (id + latest name snapshot), models and sources in the range, for filter dropdowns |
| `logs-run-summary(runId)` | computed from raw rows: count, ok, errors by class, models, providers, total cost, first/last time, median latency |
| `logs-export(filters, format)` | save dialog, then CSV or JSON of the filtered rows (no bodies), written in keyset chunks; returns `{ saved, path, rows }` |
| `logs-info()` | `{ enabled, error, path, sizeBytes, rows, oldestAt, droppedRows, lastPurgeAt }` |
| `logs-clear({ before })` | deletes rows (and their bodies) older than `before`, and roll-ups with `hour_start + 1 h ≤ before`; everything when omitted; then stepped incremental vacuum (no full VACUUM); returns counts |

## 5. Verification

- Unit tests (temp-dir DBs): migrations and downgrade guard; `classify` on OpenAI,
  Anthropic, SSE, large-body tail scan and error shapes; usage normalisation; cost math
  and missing prices; scrub of raw / JSON / `\/` / URL forms, longest first; status and
  error-class table; writer batching, the 500-record flush, the queue cap, a failed flush
  counted as dropped, roll-up counters and buckets; p95 from buckets; retention chunks
  for all three tables; keyset pagination with ties; filters and escaping; stats by
  bucket and groupBy; facets; run summary; clear; open failure (logging off, app
  unaffected); history `runUid` acceptance and duplicate handling; `resolve()` refs.
- `api-request` finish-once: integration tests against a local HTTP server for normal
  end, mid-stream cancel, timeout (exactly one record), connection dropped mid-stream,
  and a blocked request.
- Live check on the synthetic fixture: a Route Test run writes rows with
  `source = route_test` and the same `run_id` as its history run; tokens and cost come
  from the mock provider's usage; a failing request stores a scrubbed body with
  placeholders only; quitting flushes queued rows; `requests.log` is not written.
- A dedicated reviewer after each task and a whole-branch review.

## Future relay (not built)

`user_id`, `token_id`, `subscription_id`, `client_ip` stay NULL; the same row shape
serves subscriber traffic later, with per-user roll-ups added then.

## Out of scope

Log pages and the retention Settings UI (C), broader response scrubbing (follow-up task),
normalising benchmark results into tables, and anything on the future website.
