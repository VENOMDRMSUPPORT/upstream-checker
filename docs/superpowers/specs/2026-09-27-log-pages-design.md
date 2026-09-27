# Log pages (sub-project C) — design

Date: 2026-09-27
Status: rev 3 — two delegated reviews applied: seven changes from the design review, six from
the spec review (descending-only sorts, an average latency the SQL can produce, runs filters
narrowed to a fixed subset, no filter in the route, a second drawer element, its own tab class)
Depends on: sub-project B (`docs/superpowers/specs/2026-09-26-logging-system-design.md`), on
branch `feat/logging-system`, unmerged
Branch: `feat/log-pages`, cut from `feat/logging-system`, worktree
`C:\Users\venom\Desktop\venom-router-logs-ui`

## Context and goal

Sub-project B records every request the app sends into `venom-logs.db` and exposes a
read-only query API. Nothing in the app reads it yet. C is the last piece of Phase 2: the
pages that make that record answerable — what did this run cost, why did that request
fail, is the error rate climbing — plus the retention controls B deliberately left out.

B merges to `main` only together with C, so C is built on top of B's branch and the two
land in one merge.

## Decisions (made with the owner)

| Topic | Decision |
|---|---|
| Nav | The two nav buttons already reserved (`Test History`, `Monitoring`) are enabled. No third button. Runs and Requests are tabs inside Test History |
| API gaps | Closed first, in one task, before any UI — C builds against a frozen API |
| Branch | `feat/log-pages` off `feat/logging-system` |
| Scope | Everything in this spec ships in v1; nothing deferred |

## 1. Task 0 — the query API additions

Three additions to `src/logs/query.js`, its IPC channels and the preload bridge, each with
tests, before any renderer work. B is unmerged, so these are changes to unshipped code.

### 1.1 `sort` on `list`

`sort` is a **separate argument**, not a key inside `filters`:

```js
list(filters, cursor, limit, sort)          // query.js
logs-list(filters, cursor, limit, sort)     // ipc.js
logsList(filters, cursor, limit, sort)      // preload.js
```

It is separate because `exportTo` passes the caller's `filters` object straight into
`page()` in its own cursor loop. A sort hidden inside `filters` would silently reorder an
export and break that loop. **`exportTo` always pages in time order** and ignores `sort`.

`sort` is one of `'time' | 'latency' | 'ttft' | 'cost'`, mapping to `created_at`,
`latency_ms`, `ttft_ms`, `cost_micros`; anything else throws, like the existing `bucket`
and `groupBy` guards. Default `'time'`, which keeps today's exact behaviour.

**Every sort is descending.** There is no ascending option and no direction argument: a log
is read worst-first — the slowest request, the most expensive one, the longest wait for a
first token. A second click on a sorted column header returns to time order rather than
reversing it. Ascending order would need its own `ORDER BY` and its own mirrored predicate,
and doubles the keyset test matrix for a view nobody asked for; if it is ever wanted, it is
a separate change, not a variation this spec leaves open.

**Changing `sort` resets the cursor.** The cursor shape differs per sort (§1.1, §1.2) and
`page()` ignores one of the wrong shape, which would silently restart the list at page one
mid-scroll. The renderer drops its cursor whenever the sort changes.

**Non-time sorts require a bounded range.** `from` and `to` must both be set, spanning at
most 31 days, or `list` throws. There is no index on `latency_ms`, `ttft_ms` or
`cost_micros`; the range bound keeps the sort inside a slice the `created_at` index has
already narrowed. The UI never sends an unbounded non-time sort (§3.2).

**The keyset must be NULL-safe.** `latency_ms`, `ttft_ms` and `cost_micros` are all
nullable — a cancelled request has no latency, a non-stream request has no TTFT, a model
with no price has no cost. Ordering is:

```sql
ORDER BY (<col> IS NULL) ASC, <col> DESC, id DESC
```

so rows with a value come first (newest/largest first), and the NULL rows form one block at
the end, ordered by `id DESC`. The cursor carries the null-ness explicitly:

```js
{ value: <number|null>, isNull: <boolean>, id: <integer> }
```

and the predicate has three branches, not one:

```sql
-- cursor.isNull === false: the rest of the valued block, then the whole NULL block
(<col> IS NULL OR <col> < :value OR (<col> = :value AND id < :id))
-- cursor.isNull === true: only further into the NULL block
(<col> IS NULL AND id < :id)
```

A plain `(col < ? OR (col = ? AND id < ?))` evaluates to NULL — never true — as soon as the
cursor lands on a NULL row, which silently truncates the page at that boundary. The time
sort keeps its existing two-branch cursor on `(created_at, id)`, unchanged: `created_at` is
`NOT NULL`.

`nextCursor` shape therefore depends on the sort. The renderer treats it as opaque and
passes it back untouched; only `query.js` reads inside it.

### 1.2 `runs` — the runs listing

```js
runs(filters, cursor, limit)      // query.js
logs-runs(filters, cursor, limit) // ipc.js, fallback { rows: [], nextCursor: null }
logsRuns(filters, cursor, limit)  // preload.js
```

One row per `run_id`, computed from `request_logs`:

```sql
SELECT run_id,
       MIN(created_at) AS started_at,
       MAX(created_at) AS ended_at,
       COUNT(*)                       AS requests,
       SUM(status = 'ok')             AS ok,
       SUM(status = 'cancelled')      AS cancelled,
       SUM(cost_micros)               AS cost_micros,
       AVG(latency_ms)                AS avg_latency_ms,
       COUNT(DISTINCT model_requested) AS models,
       MIN(source)                    AS source
FROM request_logs
WHERE run_id IS NOT NULL AND <filters>
GROUP BY run_id
ORDER BY started_at DESC, run_id DESC
LIMIT ?
```

`run_id IS NOT NULL` is not optional: proxy traffic carries no run id, and without it every
un-tagged request in the database collapses into one enormous group.

**The runs cursor is its own shape** — `{ startedAt, runId }` — because group-level paging
cannot reuse the row cursor (`{ createdAt, id }`); there is no single `id` for a group. The
predicate mirrors the row keyset:
`(started_at < :startedAt OR (started_at = :startedAt AND run_id < :runId))`, applied as a
`HAVING` clause since `started_at` is an aggregate.

`AVG(latency_ms)` is there because SQLite has no median. The Runs table shows the average;
the true median is `medianLatencyMs` from `logs-run-summary`, which computes it in JS and is
what the expanded row shows. The two are labelled differently in the UI — "avg" in the
table, "median" in the summary — so neither is mistaken for the other.

**`runs` does not reuse `rowFilters`.** It builds its own condition set from a fixed subset:
`from`, `to`, `source[]`, `providerId[]`, `model`, and `text` matching `run_id`. The keys
`rowFilters` also understands — `status`, `runId`, `afterId` — are ignored, because they
filter *rows* and would corrupt the aggregates: a `status` filter would make `ok` equal
`requests` by construction.

`from`/`to` bound `created_at`, which prunes **rows, not groups**. A run whose first request
falls before `from` still appears, with `started_at` clamped to its first in-range request
and its counters covering only the in-range part. The UI labels the range so this is
readable rather than surprising; a run is never silently dropped for straddling the edge.

**No new index.** Measured on a seeded 60 000-row database (40 000 rows carrying a run id,
2 400 runs): the planner uses `request_logs_by_time` for the range and a temp B-tree for the
grouping, and adding `(run_id, created_at)` changed neither the plan nor the time
(22.1 ms → 21.2 ms, inside noise). A range-bounded runs query at this scale costs about
20 ms, which is acceptable on the main thread. The runs list always sends a range (§3.2).
`migrations.js` keeps one entry; its rule that a shipped entry is never edited is untouched.

### 1.3 Run summary: `medianTtftMs` and `passRate`

`summarizeRun` already returns `medianLatencyMs`, so p50 latency is not missing. Two fields
are added:

- `medianTtftMs` — the median of `ttft_ms` over rows where `is_stream = 1` and `ttft_ms` is
  set. Non-stream rows have no TTFT and must not be counted as zero. **The `runSummary`
  SELECT must widen to include `ttft_ms` and `is_stream`**, which it does not read today.
- `passRate` — `ok / (count - cancelled - errorsByClass.blocked)`, or `null` when that
  denominator is zero. Cancelled and blocked requests are neither passes nor failures; the
  denominator is deliberately the same `attempted` that `summarize()` uses for `okPct`
  (`requests - cancelled - blocked`). Leaving `blocked` in would give the app two different
  pass rates — one on the Runs table, one on Monitoring — for the same traffic.

## 2. Files

| File | Change |
|---|---|
| `src/logs/query.js` | `sort` on `list`, new `runs`, two fields on `summarizeRun` |
| `src/logs/ipc.js` | `sort` passed through; new `logs-runs` channel |
| `src/preload.js` | `logsList` gains `sort`; new `logsRuns` |
| `src/renderer/logs-format.js` | **new** — pure helpers, no DOM, loadable by a node test |
| `src/renderer/logs.js` | **new** — the three views, as an IIFE exposing `window.LOGS` |
| `src/renderer/index.html` | Two `data-page` attributes, two `<section class="shell-page">` blocks, the `#log-drawer` element, the retention rows in `sec-logs`, two `<script>` tags |
| `src/renderer/app.js` | Two `PAGES` entries, two `PAGE_META` entries, two `showPage` hooks, retention settings wiring. **No route grammar change** (§3.3) |
| `src/renderer/styles.css` | Log table, filter bar, chart and drawer rules |
| `test/logs/query.test.js` | Cases for the three additions |
| `test/renderer/logs-format.test.js` | **new** — the pure helpers |
| `scripts/live/verify-db.mjs` | Extended with the log-page checks |

## 3. The renderer

### 3.1 Module shape

`logs.js` follows `catalog.js` and `profiles.js` exactly: an IIFE that closes over its own
state and assigns `window.LOGS = { render, renderMonitor }`. It is loaded after `app.js`
(which owns `showPage`) and after `logs-format.js`.

`logs-format.js` is **not** an IIFE. It is a plain browser script of top-level function
declarations, the same shape as `src/renderer/ulid.js`, so a node test can evaluate its
source and pull the functions out:

```js
const source = fs.readFileSync(.../logs-format.js, 'utf8');
const { formatDuration, ... } = new Function(`${source}\nreturn { formatDuration, ... };`)();
```

It must therefore touch neither `window` nor `document` at evaluation time. It holds:
`toQuery(filters, sort)`, `toViewModel(row)`, `formatDuration(ms)`, `formatCost(micros)`,
`formatTokens(n)`, `normalizeProvider(id)`, `statusTone(row)`, `bucketLabel(ms, bucket)`.

### 3.2 Pages and views

**Test History** (`data-page="history"`) — a tab strip in the page header, `Runs` (default)
and `Requests`. The strip gets its **own class, `log-tab`**, visually matching the settings
tabs but not reusing `settings-nav-item`: `renderCostEstimate()` selects that class
unscoped, and a Test History tab appearing earlier in the DOM would silently take over the
element it writes the settings cost estimate into.

*Runs* — a table from `logs-runs`: started, source, requests, pass rate, models, average
latency, cost. A row expands into its summary from `logs-run-summary`, which is where the
median latency and median TTFT appear. "See requests" sets the Requests tab's filter to that
`runId` and switches tab — a filter change inside the page, not a navigation.

*Requests* — a table from `logs-list`: time, source, provider, model, status, latency, TTFT,
tokens, cost. The filter bar is built from `logs-facets`: provider, model, source, status,
a date range and a text box. Column headers for latency, TTFT and cost are sort controls.

**The range filter always has a value.** It defaults to the last 24 hours and cannot be
cleared, only widened, up to 31 days. This is what makes §1.1's bounded-range rule invisible
to the user rather than an error they can trigger.

Clicking a row opens the detail **drawer**, showing timings, token breakdown, cost with its
price snapshot, the error, and the scrubbed request and response bodies when `has_body` is
set.

The drawer is a **second element**, `#log-drawer`, added to `index.html` with its own ids
and its own open/close and Escape handling inside `logs.js`. It reuses the existing
`.ku-drawer` / `.ku-scrim` / `.ku-panel` CSS, which is generic, but not `#ku-drawer` itself:
that element is a singleton whose ids and handlers belong to `key-usage.js` and are bound to
key state. Nothing in `key-usage.js` is touched.

The drawer also carries the **retry chain**: other rows sharing this row's `run_id` and
`meta_json.testGroup`, keyed on `is_stream` and `endpoint`. The non-stream attempt and the
SSE-recovery attempt both carry attempt 1 and hedge index 0, so those two fields alone
cannot tell them apart. The chain needs no API addition: the drawer fetches the run's rows
with the existing `runId` filter and groups them in the renderer, since `list` returns
`meta_json` with every row.

**Monitoring** (`data-page="monitor"`) — charts from `logs-stats`: requests over time with
ok/error split, latency and approximate p95, tokens, and cost. Bucket is hour or day; group
by none, source, provider, model or error class. The range defaults to 24 hours here too;
`day` bucketing widens it to 30. Grouping by model over a year costs about 1.4 s on the main
thread, so **the range control offers 24 h / 7 d / 30 d only when a groupBy is active**;
longer ranges are available only with `groupBy: 'none'`.

Charts are hand-drawn inline SVG, the way `key-usage.js`, `catalog.js` and `profiles.js`
already draw their series. No charting dependency is added.

### 3.3 Filter state and the route

Each view owns a plain `filters` object, held **in memory for the session**. It is not
written into the route.

The route grammar today is `#/<page>/<sub>`, `syncRoute()` writes it with
`history.replaceState`, the app listens for neither `hashchange` nor `popstate`, and
`applyRoute()` runs once at startup. Teaching it a filter segment means a new grammar, a new
parser and a new writer in `app.js` — a change to shared routing code for a feature nobody
asked for. C therefore uses the existing grammar unchanged: the hash records which page and
which tab, so a reload returns to the Requests tab, with filters back at their defaults.

Facets are fetched once per range change and cached against that range. `logs-facets` reads
`usage_hourly`, which buckets to whole hours, so a provider first used minutes ago may not
appear in the dropdown until its roll-up row exists. That is expected, not staleness: the
dropdown is a convenience, and a provider missing from it never hides rows, because the
table is filtered by what the user picked, not by the facet list.

### 3.4 Live tail

Only on the Requests tab, only when `sort === 'time'`, only while the page is visible and
the window focused. Every 2 s it calls `logsList({ ...filters, afterId }, null, limit)` —
`afterId` and no cursor, which B orders by `id DESC`. New rows are prepended and `afterId`
advances to the highest id seen. Paging a tail with `nextCursor` is explicitly wrong: the
cursor orders by `created_at`, and a request logged a millisecond out of clock order would
be skipped. Changing the sort, opening a drawer, or hiding the window stops the poll.

## 4. Settings

The existing `sec-logs` section gains:

- **Retention** — three numeric rows: `logRetentionDays` (default 90), `bodyRetentionDays`
  (7), `statsRetentionMonths` (12), saved through the existing settings path, which already
  notifies main's caches.
- **Log health** — from `logs-info`: path, size, row count, oldest row, dropped rows, last
  purge. Refreshed when the section opens.
- **Clear log…** — a confirm, then `logs-clear`. The call can take seconds on a large
  database, so the button enters a running state and the health block refreshes when it
  returns. It sits in the existing `settings-zone` danger block, beside today's "Clear old
  log", which deletes the legacy `requests.log` and is a different action.

## 5. Error handling

- **Logging off.** `logs-info()` returning `{ enabled: false, error }` is not a failure. All
  three views show one empty state naming the reason and pointing at Settings. No toast.
- **A failed read.** B's rule is that errors propagate rather than turning into empty
  results. The view keeps the rows it last rendered, marks itself stale with the error text,
  and offers a retry. It never replaces real rows with an empty table.
- **Unknown provider.** `usage_hourly` stores the unknown provider as `''`, `request_logs`
  as `NULL`. `normalizeProvider()` in `logs-format.js` maps both to the single token
  `'unknown'` before anything is rendered or compared, so a chart series and a table row for
  the same unknown traffic line up. It is a **display-side** mapping only: `facets` filters
  out `provider_id != ''`, so "unknown" never appears in the dropdown and can never be
  chosen as a filter. Every provider comparison in `logs.js` goes through it.
- **A missing body.** `has_body = 0` means the body was never kept or has aged out past
  `bodyRetentionDays`. The drawer says which, from the row's age.

## 6. Verification

- **Unit, `test/logs/query.test.js`:** each of the four sorts, descending, paged to the end
  and asserted to return every row exactly once — including the page that crosses from the
  valued block into the NULL block, and ties inside each block; a non-time sort with no
  range, or a range wider than 31 days, throwing; an unknown sort name throwing; `exportTo`
  staying in time order when the caller's filters came from a sorted view; `runs` excluding
  null run ids, its counters, its own cursor across a `started_at` tie, and a run straddling
  `from` appearing with clamped `started_at`; `runs` ignoring a `status` key;
  `medianTtftMs` ignoring non-stream rows; `passRate` excluding cancelled and blocked
  requests and returning null when nothing was attempted.
- **Unit, `test/renderer/logs-format.test.js`:** every pure helper, including
  `normalizeProvider` on `''`, `null` and a real id, and the formatters on null input.
- **Live check, `scripts/live/verify-db.mjs`:** drive the packaged app, run a Route Test,
  open Test History and assert the Runs tab shows that run with the same id its history row
  carries; switch to Requests and assert its rows; open the drawer on a failed request and
  assert the body is present and scrubbed; open Monitoring and assert the chart has points;
  change a retention setting and assert it round-trips.
- A delegated reviewer after each task, and a whole-branch review before the merge.

## Out of scope

The merge of B and C into `main`, the release, and anything on the future hosted website.
Scrubbing provider-echoed keys out of responses shown in the drawer stays the separate
follow-up it already is — the drawer renders what B stored, and B scrubs what it stores.
