# Logging system (sub-project B) — design

Date: 2026-09-26
Status: design approved in chat; spec pending the delegated reviewer
Depends on: sub-project A (`docs/superpowers/specs/2026-09-26-local-database-design.md`), merged
Research: `docs/superpowers/research/2026-09-26-new-api/03-logs.md` (recommendations), `02-data-model.md` §13

## Goal

Record every outbound request the desktop admin app makes, in a local log database that
the log pages (sub-project C) will read: per-request rows with benchmark-grade timings,
tokens and cost, hourly roll-ups with an approximate p95, captured bodies for debugging,
retention, and a query API. The schema leaves room for the future hosted relay.

## Decisions (made with the owner)

| Topic | Decision |
|---|---|
| What is logged | Metadata of **every** request, always |
| Bodies | Setting "Request bodies": Off / Failed only / All; kept 7 days; default **Failed only** for new installs; an existing stored value is kept as is |
| `requests.log` | No longer written; the old file stays until the owner clears it |
| Spend | Every request is costed; reports split by source |
| Latency | Average plus approximate p95 from hourly histogram buckets |
| Retention | Raw rows 90 days, bodies 7 days, hourly roll-ups 12 months |

## 1. Storage

### File and connection

- `venom-logs.db` next to `venom.db` in the app data folder, opened in main by the same
  `better-sqlite3` dependency, on its own connection.
- Pragmas: `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`,
  `temp_store=MEMORY`; `auto_vacuum=INCREMENTAL` set when the file is created (before
  the first table).
- Its own schema version in `PRAGMA user_version` and its own migration list, run the
  same way as A's (one transaction per migration, downgrade guard).
- **Logs are not critical data.** If `venom-logs.db` cannot be opened or migrated, the
  app starts normally without logging, logs the error with electron-log, and the
  renderer shows one status warning ("Request logging is off: …"). A newer log schema
  than the app knows is treated the same way (logging off, file untouched). The app never
  quits because of the log DB.
- No backup before log migrations (disposable data).

### Code layout

```
src/logs/index.js        open(dir, { log }), pragmas, migrate(), close(); returns { db, writer, repos }
src/logs/migrations.js   ordered { version, up(db) }; schema v1
src/logs/classify.js     pure: status, error class, model, usage and cost from a request/response
src/logs/writer.js       batched writer: queue, flush timer, roll-up upserts, dropped counter
src/logs/retention.js    chunked purge + incremental vacuum
src/logs/query.js        list (keyset), get, stats, export rows, info
src/logs/ipc.js          registers the log IPC channels
```

Nothing under `src/logs/` requires electron at load time, so everything is unit-tested
under Electron's Node like `src/db/`.

### Schema v1

Conventions from A: integer epoch-ms timestamps, 0/1 booleans, `*_json` TEXT columns,
money as integer micro-USD. No foreign keys (rows outlive providers and keys).

```
meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)
  -- dropped_rows (count of rows lost to write failures), last_purge_at

request_logs(
  id INTEGER PRIMARY KEY,
  request_uid TEXT NOT NULL UNIQUE,            -- ULID
  created_at INTEGER NOT NULL,                 -- request start
  source TEXT NOT NULL,                        -- see "Sources"
  run_id TEXT,                                 -- Route Test run_uid or benchmark run ULID
  attempt INTEGER NOT NULL DEFAULT 1,
  is_hedge INTEGER NOT NULL DEFAULT 0,
  provider_id TEXT,                            -- from the substituted key, else base_url origin match
  provider_name TEXT,                          -- snapshot
  key_id TEXT,                                 -- id only, never the key
  method TEXT NOT NULL,
  endpoint TEXT NOT NULL,                      -- URL origin + path, no query string
  model_requested TEXT,                        -- request JSON body "model"
  model_returned TEXT,                         -- response JSON "model"
  is_stream INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,                        -- ok | error | timeout | cancelled | blocked
  http_status INTEGER,
  error_class TEXT,                            -- auth | rate_limit | quota | bad_request | server | network | timeout | blocked | cancelled
  error_message TEXT,                          -- clipped to 500 chars
  latency_ms INTEGER,
  ttft_ms INTEGER,                             -- first content token (api-request firstTokenMs)
  first_byte_ms INTEGER,
  input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
  usage_source TEXT,                           -- reported | none
  cost_micros INTEGER,                         -- null when the model has no known price
  price_json TEXT,                             -- the per-1M prices used
  has_body INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT,
  user_id TEXT, token_id TEXT, subscription_id TEXT, client_ip TEXT   -- future relay; NULL now
)
  INDEX (created_at), (provider_id, created_at), (model_requested, created_at),
        (source, created_at), (run_id)

request_bodies(
  log_id INTEGER PRIMARY KEY,                  -- request_logs.id
  created_at INTEGER NOT NULL,
  request_headers_json TEXT,                   -- redacted like today (authorization, x-api-key, api-key, cookie)
  request_body TEXT,                           -- the UNRESOLVED body (placeholders), clipped to 8 KB
  response_body TEXT,                          -- clipped to 8 KB
  truncated INTEGER NOT NULL DEFAULT 0)
  INDEX (created_at)

usage_hourly(
  hour_start INTEGER NOT NULL,                 -- floor(created_at / 3 600 000) * 3 600 000, UTC
  provider_id TEXT NOT NULL,                   -- '' when unknown
  model_id TEXT NOT NULL,                      -- '' when unknown
  source TEXT NOT NULL,
  requests INTEGER NOT NULL, ok INTEGER NOT NULL, errors INTEGER NOT NULL,
  latency_sum_ms INTEGER NOT NULL, latency_count INTEGER NOT NULL,
  latency_buckets_json TEXT NOT NULL,          -- counts per fixed edge, see below
  ttft_sum_ms INTEGER NOT NULL, ttft_count INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cached_tokens INTEGER NOT NULL,
  cost_micros INTEGER NOT NULL,
  PRIMARY KEY (hour_start, provider_id, model_id, source))
```

Latency bucket upper edges (ms): 100, 250, 500, 1000, 2000, 3000, 5000, 8000, 12000,
20000, 30000, 60000, 120000, +∞ (14 counters). The approximate p95 is the upper edge of
the first bucket whose cumulative count reaches 95 %; the +∞ bucket reports the largest
finite edge with a "≥" flag. Cancelled and blocked requests are counted in `requests`
but not in latency or error rates.

## 2. What is recorded, and how

All provider traffic already goes through main's `api-request`, so logging lives there.

### Sources

The renderer adds `source` and optional `runId`, `attempt`, `isHedge` to every
`apiRequest` call. Allowed sources: `route_test`, `benchmark`, `health`, `key_check`,
`key_usage`, `discovery`, `pricing`, `leaderboard`, `other`. An unknown or missing value
is stored as `other`. Every renderer call site is tagged; the plan lists them.

- **Route Test** generates its run's ULID when the run starts, passes it as `runId` to
  every request, and passes the same value to `append-run` so `test_runs.run_uid`
  matches (A's history repo accepts a provided `runUid`).
- **Benchmark** generates one ULID per model benchmark run.

### Derived fields (pure functions in `classify.js`)

- **Provider and key**: from the placeholder the resolver substituted (the resolver
  reports which key ids it used); if none, from matching the URL origin to a provider's
  `base_url` origin; else NULL.
- **Model**: `model` from a JSON request body; `model_returned` from the JSON response
  or the last SSE `data:` chunk that carries `model`.
- **Usage**: `usage.prompt_tokens` / `completion_tokens` / `prompt_tokens_details.
  cached_tokens` (OpenAI shape) and `usage.input_tokens` / `output_tokens` /
  `cache_read_input_tokens` (Anthropic shape), from the JSON response or the last SSE
  chunk carrying `usage`. `usage_source = 'reported'` when found, else `'none'` with
  NULL tokens.
- **Cost**: from the model's pricing in the model pool (`summary_json.pricing`, USD per
  1M tokens): `cost_micros = round(input_tokens × input + output_tokens × output)`;
  cached tokens are priced as input; free-tier pricing (0) gives 0; unknown price or no
  usage gives NULL. `price_json` stores the prices used.
- **Status and error class**: 2xx → `ok`; `cancelled` flag → `cancelled`; resolver
  refusal → `blocked`; timeout → `timeout`; network error → `error`/`network`;
  401/403 → `auth`; 429 → `rate_limit`; 402 → `quota`; other 4xx → `bad_request`;
  5xx → `server`.

### Bodies

Captured according to the setting (`settings.logLevel`, relabelled in the UI as
"Request bodies": `off` = Off, `errors` = Failed only, `all` = All). "Failed" means any
status other than `ok` and `cancelled`. The request body is the unresolved one
(placeholders only — the same value `requests.log` used to receive); request headers are
redacted as today; both bodies clipped to 8 KB with `truncated = 1` when clipped.
`DEFAULT_SETTINGS.logLevel` becomes `'errors'`; stored values are untouched.

A provider that echoes a key in its error response would put it in `response_body`;
scrubbing that is the separate follow-up task, not part of B.

### Batched writer

- `api-request` hands a finished record to `writer.add(record, body?)` and never awaits
  it; logging can never slow or fail a request.
- The queue flushes every 250 ms, or at once when it reaches 500 records, in **one
  transaction**: insert the log rows, insert bodies with the new row ids, upsert the
  hourly roll-ups.
- On a failed flush the batch is dropped (not retried forever), `meta.dropped_rows`
  grows by its size, and the error goes to electron-log once per minute at most.
- Queue cap 10 000 records; beyond it the oldest queued records are dropped and
  counted, so memory stays bounded if the DB stalls.
- `will-quit` flushes the queue synchronously before closing the log DB.

`requests.log` is no longer written (`appendRequestLog` is removed). `read-log-info`,
`open-request-log` and `clear-request-log` keep working on the old file until
sub-project C replaces that part of Settings.

## 3. Retention

- Settings (main reads them from the `settings` row; UI in C): `logRetentionDays`
  (default 90), `bodyRetentionDays` (default 7), `statsRetentionMonths` (default 12).
- The purge runs 30 s after startup and then every 24 h: delete `request_logs` older
  than the limit in chunks of 5 000 rows by id (yielding between chunks), set
  `has_body = 0` and delete `request_bodies` older than their limit, delete
  `usage_hourly` rows older than the stats limit, then `PRAGMA incremental_vacuum` and
  `wal_checkpoint(TRUNCATE)`. `meta.last_purge_at` records the run.
- A purge never blocks a flush for more than one chunk.

## 4. Query API for sub-project C

Channels (all read-only except clear and export):

| Channel | Returns |
|---|---|
| `logs-list(filters, cursor, limit)` | `{ rows, nextCursor }`, newest first, keyset on `(created_at, id)`; `limit` ≤ 200; filters: `from`, `to`, `source[]`, `providerId[]`, `model` (exact), `status[]`, `runId`, `text` (matches `request_uid`, `run_id`, `error_message`) |
| `logs-get(id)` | the row plus its body, or `null` |
| `logs-stats(filters, bucket)` | totals and a series (`bucket` = `hour` or `day`, local time for `day`) from `usage_hourly`: requests, ok %, errors by class, average latency, approx p95, average TTFT, tokens, cost — overall and per source |
| `logs-export(filters, format)` | main shows a save dialog and writes CSV or JSON of the filtered rows (no bodies), streaming in chunks; returns `{ saved, path, rows }` |
| `logs-info()` | `{ path, sizeBytes, rows, oldestAt, droppedRows, lastPurgeAt, enabled }` |
| `logs-clear({ before })` | deletes rows, bodies and roll-ups older than `before` (or everything when omitted), then vacuums; returns counts |

Errors from these channels propagate (no empty results on failure). When logging is
off, `logs-info` returns `enabled: false` and the other reads return empty results.

## 5. Verification

- Unit tests (temp-dir DBs): migrations and downgrade guard; `classify` on OpenAI,
  Anthropic, SSE and error shapes; cost math and missing prices; writer batching, the
  500-record flush, the queue cap, a failed flush counted as dropped, roll-up upserts
  and bucket counts; p95 from buckets; retention chunks for all three tables; keyset
  pagination with ties on `created_at`; filters; stats per source; clear; open-failure
  path (logging off, app unaffected).
- Live check on the synthetic fixture: a Route Test run writes rows with
  `source = route_test` and the same `run_id` as the history run; tokens and cost come
  from the mock provider's usage; a failing request stores a body with placeholders
  only; quitting flushes queued rows; `requests.log` is not written.
- Review by a dedicated agent after each task and a whole-branch review.

## Future relay (not built)

`user_id`, `token_id`, `subscription_id`, `client_ip` stay NULL in phase 1; the same row
shape serves subscriber traffic later, with per-user roll-ups added then.

## Out of scope

Log pages and the Settings UI for retention (C), scrubbing echoed secrets (follow-up
task), normalising benchmark results into tables, and anything on the future website.
