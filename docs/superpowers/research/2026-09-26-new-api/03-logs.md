# new-api study, part 03: the logging system (backend + frontend)

Source studied: `C:\Users\venom\Desktop\new-api-research` at commit `c2b7a9a` (2026-09-25).
new-api is AGPL-3.0. This document describes behaviour, data and UI in our own words, with
`file:line` references into that tree. It copies no code and quotes only short labels. Treat
it as a functional spec for a clean-room rebuild in VENOM Router.

Paths are relative to the repo root. `web/src/...` is the React frontend.

---

## 0. Big picture in one screen

- There is one wide, append-only table, `logs`, that holds usage (consume), error, top-up,
  refund and system events (`model/log.go:59-93`). Every row is a flat record (user, token,
  model, channel, group, tokens in/out, quota, latency, stream flag, request ids) plus one
  free-form JSON string column, `other`, that carries everything else: pricing ratios, cache
  tokens, first-token time, stream status, routing diagnostics, and so on.
- `other` is split into audience scopes (public / `admin_info` / `root_info` / `audit_info`),
  and the API strips scopes depending on who is asking (`model/log_other.go:34-263`).
- Admin and security events (logins, setting changes, channel edits) have moved to a separate
  `audit_logs` table that never gets cleaned up (`model/audit_log.go:24-46`).
- Dashboard charts do not read `logs`. They read a pre-aggregated hourly roll-up table,
  `quota_data`, that is filled from an in-memory buffer every N minutes
  (`model/usedata.go:12-139`). A second roll-up, `perf_metrics`, holds per-model latency and
  success buckets for the public model/performance pages (`model/perf_metric.go:10-23`).
- Every log write is one synchronous `INSERT` at the end of the relay handler. There is no
  queue, no batching and no retry. A failed insert is written to the server log and then
  dropped (`model/log.go:101-104`, `382-385`).
- The logs DB can live on its own server (`LOG_SQL_DSN`), and that includes ClickHouse, which
  gets a partitioned MergeTree table with an optional TTL (`model/main.go:230-268`, `397-487`).
- The UI has a "Usage Logs" area with three tabs (Common, Drawing/Midjourney, Task), a
  separate Audit Logs page, and a Dashboard (overview, model charts, user charts, flow
  diagram). The frontend picks admin endpoints or self endpoints based on the user's role.

---

## 1. Log types and what creates them

Type codes are fixed integers, with a comment warning against renumbering
(`model/log.go:83-93`):

| Code | Name | Created by (today) | Notes |
|---|---|---|---|
| 0 | Unknown | never written. In queries it means "all types" | `model/log.go:466`, `562` |
| 1 | Top-up | online payment success (Epay, Stripe, Creem, Waffo, Waffo Pancake), admin manual order completion, redemption code use, subscription purchase/activation, admin quota adjustment | `model/topup.go:231,286,521,591,650,710`; `model/redemption.go:185`; `model/subscription.go:644,843`; `controller/user_quota.go:81` |
| 2 | Consume | every billable relay request (text, Claude, Gemini, Responses, embeddings, rerank, image, audio, realtime/WSS), Midjourney submits, async task submits and later positive settlement, violation fees, **and channel tests** | `service/text_quota.go:536`; `service/quota.go:243,376`; `relay/mjproxy_handler.go:281,655`; `service/task_billing.go:81,354-376`; `service/violation_fee.go:150`; `controller/channel-test.go:505` |
| 3 | Manage | still a valid type, but `RecordLogWithAdminInfo` now sends type-3 events to the audit table, not `logs` | `model/log.go:182-193` |
| 4 | System | new-user signup bonus, invitee and inviter bonus, daily check-in reward | `model/user.go:728-793`; `controller/checkin.go:64` |
| 5 | Error | a failed relay attempt on a channel, and **only** when the env var `ERROR_LOG_ENABLED=true` (default false) | `service/relay_error.go:76-98`; `common/init.go:199` |
| 6 | Refund | Midjourney task failure refund, async task failure refund, negative settlement delta after a task finishes | `service/midjourney.go:122-124`; `service/task_billing.go:284-296`, `352-376` |
| 7 | Login | legacy only. Logins now go to `audit_logs` with category `login` | `model/log.go:210-221` |

Global switches:

- `LogConsumeEnabled` (DB option, default true) turns off type-2 rows completely. It also
  turns off the dashboard roll-up, because that roll-up is fed from inside the consume-log
  function (`common/constants.go:94`, `model/log.go:340-342`, `386-399`).
- `ERROR_LOG_ENABLED` env var gates type-5 rows (`common/init.go:199`).
- A per-user setting, `record_ip_log`, decides whether the client IP is stored on consume
  and error rows (`relaykit/dto/user_settings.go:15`, `model/log.go:286-313`, `349-377`).
  It is off by default, so most rows have an empty IP. Top-up rows always store the payment
  callback IP (`model/log.go:252-276`).

### 1.1 The `logs` row: every column

From `model/log.go:59-81`:

| Column | Meaning | Filled for |
|---|---|---|
| `id` | auto-increment primary key. Under ClickHouse the stored id is 0 and the API returns a display index instead (`model/log.go:110-114`, `511-513`) | all |
| `user_id` | owner of the event | all |
| `created_at` | unix seconds | all |
| `type` | code from the table above | all |
| `content` | human text. For consume rows it lists extra charges (tool calls, audio input, "upstream returned no usage"). For top-up rows it is the amount sentence. For error rows it is the masked upstream error, prefixed with the status code (`service/text_quota.go:440-470`, `relaykit/types/error.go:148-174`) | all |
| `username` | denormalised copy of the username at write time | all |
| `token_name` | API key display name, denormalised. The literal "model test" label for channel tests | consume, error, refund |
| `model_name` | the model the client asked for (origin model). The `gpt-4-gizmo-*` family is collapsed to one wildcard name (`service/text_quota.go:464-472`) | consume, error, refund |
| `quota` | internal credit units charged (500,000 units = 1 USD by default). Always positive, even on refund rows | consume, refund, and top-up where used |
| `prompt_tokens` / `completion_tokens` | input / output tokens as billed | consume |
| `use_time` | **whole seconds** from request start to settlement | consume, error |
| `is_stream` | whether the client asked for SSE | consume, error |
| `channel_id` (JSON key `channel`) | upstream channel that served the request | consume, error, refund |
| `channel_name` | not stored. Joined at read time for admins from the channel cache or DB (`model/log.go:515-553`) | admin reads |
| `token_id` | API key id | consume, error, refund |
| `group` | the billing group actually used (`relayInfo.UsingGroup`) | consume, error, refund |
| `ip` | client IP when the user opted in | see above |
| `request_id` | new-api's own request id, varchar(64). Also sent back to the client in the `X-Oneapi-Request-Id` response header. Filled in automatically if missing (`model/log.go:95-99`, `common/constants.go:188`) | all |
| `upstream_request_id` | the provider's request id, varchar(128) (`common/constants.go:189`) | consume, error |
| `other` | JSON string. See 1.2 | most |

Indexes (GORM tags, `model/log.go:60-79`): `(created_at, id)`, `(user_id, id)`,
`(created_at, type)`, `(model_name, username)`, plus single-column indexes on `user_id`,
`username`, `token_name`, `model_name`, `channel_id`, `token_id`, `group`, `ip`,
`request_id` and `upstream_request_id`. That is 14 indexes on a write-heavy table.

### 1.2 The `other` JSON: what goes in it

The writer is `LogOther` (`model/log_other.go:37-126`). It has four private maps:

- **public**: visible to the log owner. `SetPublic` refuses the reserved keys `admin_info`,
  `root_info` and `audit_info`, and also the legacy leak keys `channel_id`, `channel_name`,
  `channel_type` and `reject_reason` (`model/log_other.go:17-24`, `57-69`).
- **admin_info**: operator diagnostics. Admins and root can see it.
- **root_info**: root only (for example the upstream task id and node name, and task-plugin
  details: `service/task_billing.go:232-235`, `service/task_plugin_audit.go:71`).
- **audit_info**: request metadata used by the audit middleware.

Public keys written on a text/chat consume row (`service/log_info_generate.go:100-134`, and
`service/text_quota.go:476-534`):

- Pricing: `model_ratio`, `group_ratio`, `completion_ratio`, `model_price` (per-call price
  when the model is priced per request), `user_group_ratio`, `cache_ratio`,
  `cache_creation_ratio` (plus `_5m` / `_1h` variants), `image_ratio`, `audio_ratio`,
  `audio_completion_ratio`.
- Token detail: `cache_tokens` (cache read), `cache_creation_tokens` (plus `_5m` / `_1h`),
  `cache_write_tokens` (normalised total written), `input_tokens_total` (normalised total
  input, only when the upstream gave a reliable figure), `image_output`, `audio_input`,
  `audio_output`, `text_input`, `text_output`.
- Timing: `frt`, the first response time in **milliseconds** (`log_info_generate.go:111`).
  This is the only sub-second latency field in the whole system.
- Request shape: `request_path`, `reasoning_effort`, `is_model_mapped` +
  `upstream_model_name`, `response_model` (requested vs returned vs upstream model, only when
  they differ: `log_info_generate.go:136-147`), `request_conversion` (for example the chain
  "Claude Messages → OpenAI Compatible"), `claude` (the final format was Claude),
  `usage_semantic` (`anthropic`), `ws`/`audio`/`image` flags, `is_system_prompt_overwritten`,
  `po` (parameter-override audit).
- Stream health: `stream_status` holding status ok/error, end reason, response status, end
  error, error count and messages (`log_info_generate.go:156-184`).
- Billing source: `billing_source` (wallet or subscription), `billing_preference`, and for
  subscriptions the plan id/title, pre-consumed amount, post delta, total/used/remain, and
  `wallet_quota_deducted: 0` (`log_info_generate.go:186-235`).
- Tiered billing: `billing_mode = tiered_expr`, the pricing expression base64-encoded
  (`expr_b64`), `matched_tier`, `billing_unit`, `billing_tokens` (a compact breakdown map),
  `image_count`, `fixed_price`, `request_rules` (`log_info_generate.go:335-378`).
- Tool surcharges (web search and similar), separate audio input price, violation-fee
  markers (`service/violation_fee.go:137-147`).

Admin-scope keys (`log_info_generate.go:68-98`, `26-31`): `use_channel` (the ordered list of
channel ids tried, which is the retry path), `billing_model` (when it differs from the
requested model), `conversion_diagnostics` (+ a truncation flag), `is_multi_key` +
`multi_key_index`, `local_count_tokens` (usage was estimated locally, not reported by the
upstream), `channel_affinity` (sticky-session info, with the raw key hint removed:
`service/channel_affinity.go:709-725`), `request_policy` (the retry decision events),
`quota_saturation` (overflow clamps), and `reject_reason`.

Error rows add public `request_path`, `error_type`, `error_code` and `status_code`, the same
admin routing info, and the response-model observation (`service/relay_error.go:82-91`).

Task rows (async video/music etc.) add `task_id`, `reason`, `pre_consumed_quota`,
`actual_quota`, `usage_facts` and `image_count` (`service/task_billing.go:55-80`,
`308-311`, `365-371`).

Top-up rows put `server_ip`, `node_name`, `caller_ip`, `payment_method`,
`callback_payment_method` and `version` into `admin_info` (`model/log.go:252-262`).

**What is never stored: prompt or response bodies.** No log path writes request or response
content to the DB. The server's text log may contain a *truncated preview* of error text and
of the consume params (`model/log.go:280`, `343`, `common/str.go:20-25`). The one exception
is the channel test, which prints the full test response body to the system log
(`controller/channel-test.go:518`). The audit writer documents that bodies and raw query
strings must never be recorded (`model/audit_log.go:72-73`).

---

## 2. Where logs are written in the relay pipeline

Request flow (`controller/relay.go:148-220`):

1. Middleware gives the request an id (`middleware/request-id.go:13-16`).
2. The retry loop picks a channel, appends its id to `use_channel`, and calls the
   format-specific helper.
3. **On a successful attempt**, the handler finishes streaming to the client and then calls
   `PostTextConsumeQuota` (`relay/*_handler.go`, e.g. `compatible_handler.go:93,184`). That
   function settles billing, builds the `other` map, and calls `RecordConsumeLog`
   **inline** (`service/text_quota.go:393-548`). WSS/realtime, audio and Midjourney have
   their own equivalents (`service/quota.go:243,376`; `relay/mjproxy_handler.go:281,655`).
4. **On a failed attempt**, `processChannelError` runs once per failed attempt. It may
   auto-disable the channel (asynchronously), and if error logging is enabled it writes a
   type-5 row (`service/relay_error.go:64-99`). A request that fails over three channels and
   then succeeds therefore produces three error rows plus one consume row, all sharing the
   same `request_id`.
5. Errors created with the "do not record" option (insufficient quota, pre-consume failures,
   some websocket errors) never produce error rows (`service/billing_session.go:213-402`,
   `relaykit/types/error.go:387-410`).

Async tasks (video, Suno, Midjourney) write a consume row at submit time. Later, when the
poller sees the final state, it writes a second consume or refund row for the difference
(`service/task_billing.go:300-376`). Those follow-up rows have no token counts and no
latency.

Write mechanics:

- One synchronous `LOG_DB.Create` per event (`model/log.go:101-104`). No goroutine, no
  buffer, no batch insert. The relay goroutine waits for the insert, but after the response
  bytes have already gone to the client.
- Each consume/error write also does a user-settings lookup to decide on IP recording
  (usually served from cache) (`model/log.go:350-355`).
- On failure the row is lost and only a server-log line remains (`model/log.go:382-385`).
  There is no outbox, dead-letter file or metric.
- The dashboard roll-up is updated in memory right after the insert (`model/log.go:386-399`).
  It is flushed to `quota_data` every `DataExportInterval` minutes (default 5) by a
  background loop started in `main.go:122` (`model/usedata.go:41-139`). A crash loses up to
  one interval of dashboard data, although the `logs` rows survive.

---

## 3. Storage, retention, export

### 3.1 Tables

| Table | DB | Purpose | Key file |
|---|---|---|---|
| `logs` | `LOG_DB` | all usage, error, top-up, refund and system events | `model/log.go:59-81` |
| `audit_logs` | `LOG_DB` | login, security, admin operations, access-token use. Never cleaned | `model/audit_log.go:24-46` |
| `quota_data` | main `DB` | hourly roll-up by user × username × model × hour × group × token × channel × node, holding count, quota and token_used | `model/usedata.go:12-26` |
| `perf_metrics` | main `DB` | per model × group × time bucket: request count, success count, total latency, TTFT sum and count, output tokens, generation ms | `model/perf_metric.go:10-23` |
| `midjourneys`, `tasks` | main `DB` | async job state, shown in the Drawing and Task log tabs | see 5.3 |
| `system_tasks` | main `DB` | background jobs, including the log-cleanup job and its progress | `model/system_task.go` |

### 3.2 Separate log database

- If `LOG_SQL_DSN` is empty, `LOG_DB` is the main DB (`model/main.go:230-238`).
- If it is set, logs go to a separate SQLite, MySQL, PostgreSQL or **ClickHouse** server,
  with its own connection pool (`model/main.go:239-268`). ClickHouse is allowed only as the
  log DB, not the main DB (`model/main.go:145`).
- ClickHouse schema: a MergeTree partitioned by month, ordered by `(created_at, request_id)`,
  with an optional `TTL created_at + N DAY DELETE` taken from
  `LOG_SQL_CLICKHOUSE_TTL_DAYS`. The TTL is added or removed on each start
  (`model/main.go:405-487`). Under ClickHouse, list ordering uses
  `created_at desc, request_id desc` (`model/log.go:106-108`).
- The `group` column is a reserved word, so the column name is quoted per dialect
  (`model/main.go:56-62`).

### 3.3 Retention and cleanup

- **Automatic retention exists only on ClickHouse (TTL).** SQL backends have no scheduled
  purge. The system-task scheduler registers channel tests, model updates and task polling,
  but no log retention job (`controller/system_task_handlers.go:21-24`).
- **Manual purge (root only):** `POST /api/system-task/log-cleanup?target_timestamp=…`
  (`router/api-router.go:322-329`, `controller/system_task.go:14-35`). This creates a
  singleton background task (if one is already running, the running one is returned). The
  runner deletes rows older than the target in batches of 100 and records total, processed,
  remaining and progress % after each batch (`service/system_task.go:168-196`, `338-426`).
  On ClickHouse it runs one synchronous `ALTER TABLE DELETE` mutation instead
  (`model/log.go:713-732`). If a whole pass deletes nothing while rows remain, the task fails
  rather than looping forever.
- UI for this: System Settings → Maintenance → Log Maintenance
  (`web/src/features/system-settings/maintenance/log-settings-section.tsx`). It has a
  "Record quota usage" switch (LogConsumeEnabled), a date-time picker defaulting to 30 days
  ago, quick buttons (24 hours / 7 days / 30 days ago), a destructive "Clean logs" button
  with a confirmation dialog, and a progress card with a bar and a "processed of total"
  count that polls the task (`log-settings-section.tsx:128-141`, `186-240`, `376-434`,
  `590-615`).
- The same page manages the **server's text log files**: directory, file count, total size
  and date range, with cleanup that keeps the last N files or the last N days
  (`GET/DELETE /api/performance/logs`, `controller/performance.go:232-300`,
  `log-settings-section.tsx:440-580`).
- `quota_data` and `audit_logs` have no cleanup at all. `perf_metrics` has a retention-days
  setting applied by its flush loop (`pkg/perf_metrics/flush.go:13-24`, `70-78`).

### 3.4 Export

- There is no CSV/Excel export endpoint for usage logs. The only machine-readable feed is
  the read-only token endpoint `GET /api/log/token`, which returns up to 1,000 recent rows for
  the API key presenting it (`router/api-router.go:346-349`, `controller/log.go:79-101`,
  `model/log.go:140-148`, `common/constants.go:60`).
- "Data export" in option names (`DataExportEnabled`, `DataExportInterval`,
  `DataExportDefaultTime`) means the dashboard roll-up, not a file export
  (`common/constants.go:28-30`). Its settings UI is "Data Dashboard": an enable switch, a
  refresh interval of 1-1440 minutes, and a default granularity of hour/day/week
  (`web/src/features/system-settings/content/dashboard-section.tsx:55-190`).
- `GET /api/usage/token/` returns balance-style usage for an API key (granted, used,
  available, expiry), not log rows (`controller/token.go:229-276`).

---

## 4. Query APIs

Every list endpoint uses the shared pagination helper: `p` (page, 1-based) and `page_size`
(also accepted as `ps` or `size`). The default is 10 and the maximum is 100
(`common/page_info.go:41-82`, `common/constants.go:59`). Responses look like
`{success, data: {page, page_size, total, items}}`.

### 4.1 Usage logs

| Endpoint | Auth | Filters | Notes |
|---|---|---|---|
| `GET /api/log/` | admin | `type`, `start_timestamp`, `end_timestamp`, `username`, `token_name`, `model_name`, `channel`, `group`, `request_id`, `upstream_request_id` | `router/api-router.go:314`, `controller/log.go:13-39`, `model/log.go:464-556`. Sorted newest first, with an exact `COUNT(*)`. Channel names are joined in. Admins get `other` minus `root_info`; root gets everything (`controller/log.go:30-34`) |
| `GET /api/log/self` | user | same, minus `username` and `channel` | `controller/log.go:41-61`, `model/log.go:560-606`. Forced to the caller's `user_id`. The count carries a 10,000 limit (see weaknesses). `formatUserLogs` blanks `channel_name` and strips the privileged `other` scopes (`model/log.go:116-122`) |
| `GET /api/log/stat` | admin | `start/end`, `username`, `token_name`, `model_name`, `channel`, `group` (the `type` parameter is accepted but ignored) | returns `{quota, rpm, tpm}` (`controller/log.go:103-128`) |
| `GET /api/log/self/stat` | user | same, username taken from the session | `controller/log.go:130-156` |
| `GET /api/log/token` | API key (read-only) | none | last 1,000 rows for the key, user-formatted |
| `GET /api/log/channel_affinity_usage_cache` | admin | rule/group/key fingerprint | cache stats for the sticky-session dialog opened from a log row |
| `GET /api/log/search`, `GET /api/log/self/search` | – | – | deprecated. Always returns `success:false` (`controller/log.go:63-77`) |

Filter semantics:

- `model_name` and `username` match exactly unless the value contains `%`. Then they become
  a `LIKE`: `_` is escaped, at most two `%` are allowed, no `%%`, and at least 2 real
  characters are required (`model/log.go:19-57`, `model/token.go:120-155`). `token_name`,
  `request_id`, `upstream_request_id`, `channel` and `group` always match exactly.
- Times are unix seconds and both bounds are inclusive.
- **Stats:** `quota` is `SUM(quota)` over consume rows in the filtered window. `rpm` is the
  count of consume rows and `tpm` the sum of prompt + completion tokens, both over **the last
  60 seconds only**, whatever the chosen window, though they still honour the other filters
  (`model/log.go:614-674`). Refund rows are not subtracted from `quota`.

### 4.2 Dashboard data (from `quota_data`, main DB)

| Endpoint | Auth | Returns |
|---|---|---|
| `GET /api/data/?start_timestamp&end_timestamp[&username]` | admin | rows of model × hour with count, quota and token_used. With `username` the rows are per that user (`controller/usedata.go:31-46`, `model/usedata.go:141-183`) |
| `GET /api/data/users` | admin | username × hour sums (`model/usedata.go:163-171`) |
| `GET /api/data/self` | user | own model × hour rows. The span may be at most 30 days (`controller/usedata.go:63-86`) |
| `GET /api/data/flow` | admin/root | grouped rows for the flow (Sankey) view. Admin grouping: user, group, model, channel. Root grouping adds node and token (`model/usedata_flow.go:25-92`) |
| `GET /api/data/flow/self` | user | token × group × model for self, 30-day cap (`controller/usedata.go:107-131`) |
| `GET /api/rankings?period=` | nav-module gated | model token totals and buckets from `quota_data` (`model/usedata_rankings.go:21-63`) |
| `GET /api/perf-metrics`, `/summary` | public or user, depending on nav setting | latency, TTFT, success rate and TPS per model from `perf_metrics` plus hot in-memory buckets (`pkg/perf_metrics/metrics.go:137-260`) |

### 4.3 Audit logs

`GET /api/audit` requires admin plus the `AuditRead` permission. `GET /api/audit/self` is
for any user (`router/api-router.go:311-312`). Filters: `username`, `category`
(login / security / operation / access_token), `token_ref` (a 64-hex fingerprint),
`exclude_token_ref`, `request_id`, `start_timestamp`, `end_timestamp` and
`success=true|false`, all validated (`controller/access_token.go:66-111`). Non-root viewers
never see events whose actor role is unknown or root (`model/audit_log.go:149-151`). Self
view strips `admin_info` and `audit_info`. Sort order is newest first
(`model/audit_log.go:139-203`).

### 4.4 Async job lists

`GET /api/mj/self`, `GET /api/mj/` (admin), `GET /api/task/self`, `GET /api/task` (admin),
and `GET /api/task/:task_id/artifacts` (`router/api-router.go:365-374`). Details are in 5.3.

### 4.5 Permission differences (summary)

| Capability | User | Admin | Root |
|---|---|---|---|
| See own logs | yes | yes ("Only mine" tab) | yes |
| See all users' logs | no | yes | yes |
| Filter by username / channel | no | yes | yes |
| `channel_name` in rows | blanked | yes | yes |
| `other.admin_info` (retry path, affinity, billing model, reject reason, diagnostics) | stripped | yes | yes |
| `other.root_info` (upstream task id, node, plugin) | stripped | stripped | yes |
| Audit events by root actors | – | hidden | yes |
| Purge logs, server log files | no | no | yes |

---

## 5. Frontend: log pages, screen by screen

Stack: React 19, TanStack Router (file routes), TanStack Query and TanStack Table, shadcn-style
UI, i18n. Unless a path is given, files are under `web/src/features/usage-logs/`.

### 5.0 Route map

| Route | Screen | Who |
|---|---|---|
| `/usage-logs/` | redirects to `/usage-logs/common` (`routes/_authenticated/usage-logs/index.tsx:23-30`) | all |
| `/usage-logs/common` | Common Logs (usage/billing events) | all |
| `/usage-logs/drawing` | Drawing Logs (Midjourney jobs) | all, if the sidebar module is enabled |
| `/usage-logs/task` | Task Logs (async video/music jobs) | all, if the module is enabled |
| `/usage-logs/audit` | Audit Logs | all. The "All" scope needs the admin role plus the `audit.read` permission |
| `/dashboard/overview`, `/models`, `/flow`, `/users` | analytics | `users` is admin only |
| System Settings → Maintenance → Log Maintenance | purge logs, server log files | root |
| System Settings → Content → Data Dashboard | roll-up switch and interval | root |

An unknown section redirects to the default. On the Drawing and Task sections, a `type` param
in the URL is removed (`routes/_authenticated/usage-logs/$section.tsx:52-71`).

**Admin vs user switch.** The provider reads the user's role. Admins get an **All / Only
Mine** segmented control in the page header. On "Only Mine", an admin gets exactly the user
experience: self endpoints and no admin columns. The scope lives in React state (default
"All") and is not persisted. The resolved view is `self`, `admin` or `root`, and every
admin-only element checks that view, not the raw role
(`components/usage-logs-provider.tsx:30-36`, `64`, `104-120`; `index.tsx:131-140`).

### 5.1 Common Logs, desktop wireframe

```
+------------------------------------------------------------------+
| Common Logs                                   [ All | Only Mine ] |
+------------------------------------------------------------------+
| [📅 2026-09-26 00:00 ~ 2026-09-26 15:00 ] [Model] [Group v] [Type v] [More (2) v] |
|  (expanded) [Token name] [Username*] [Channel ID*] [Request ID] [Upstream req ID] |
| (Usage $1.23) (RPM 4) (TPM 9.1k)         [👁] [Reset] [Search] [View v] |
+------------------------------------------------------------------+
| Time | Channel* | User* | Token | Model | Stream | Tokens | Cost | Timing | Details |
| ...rows, 13px text, tinted by type...                             |
+------------------------------------------------------------------+
| rows per page [100 v]           < 1 2 3 ... >        total N      |
+------------------------------------------------------------------+
  * admin/root view only
```

**Filter bar** (`components/common-logs-filter-bar.tsx`, `components/logs-filter-toolbar.tsx`):

- Filters are edited as a local draft and only applied on **Search** or Enter. Applying
  writes them all to the URL with page reset to 1, then invalidates the list and stats
  queries (`common-logs-filter-bar.tsx:148-229`, `257-262`). The URL is the source of truth:
  `page`, `pageSize`, `type[]`, `model`, `token`, `channel`, `group`, `username`,
  `requestId`, `upstreamRequestId`, and `startTime`/`endTime` in milliseconds
  (`$section.tsx:36-50`). Pages can be bookmarked and shared.
- Primary row: date range (2 columns wide), Model Name (text, `%` wildcard supported by the
  backend), Group (a combobox that allows custom values; options come from all groups for
  admins or the user's own groups otherwise, with `auto` removed), Type (a select with All,
  Top-up, Consume, Manage, System, Error, Refund, Login; Manage and Login carry a small
  "Deprecated" tag pointing to Audit Logs) (`constants.ts:108-119`,
  `common-logs-filter-bar.tsx:129-146`, `362-434`).
- An **advanced** expander with a count badge holds: Token Name, Username (admin), Channel
  ID (admin), Request ID, Upstream Request ID (`common-logs-filter-bar.tsx:435-484`).
- **Date range picker** (`components/compact-date-time-range-picker.tsx`): the trigger
  shows the range. The popover has two datetime-local inputs, a Confirm button, and presets
  that apply straight away: Today, 7 Days, This week, 30 Days, Current month. The default
  range is today 00:00 to now + 1 hour (`lib/utils.ts:80-87`).
- **Reset** returns type to All, the time to the default and page to 1. It is disabled when
  nothing but the date is set (`common-logs-filter-bar.tsx:231-273`).
- **Privacy eye toggle**: masks channel names, usernames and avatars, token names, groups
  and the Usage stat as dots, and switches the matching inputs to masked text. It is meant
  for screen-sharing. It is not persisted (`common-logs-filter-bar.tsx:300-319`).
- **View** menu: checkbox list of columns (every column except Time). Choices are saved to
  localStorage per scope, under `usage-logs:common:{self|admin|root}:column-visibility`. All
  columns are visible by default (`components/usage-logs-table.tsx:66-71`).

**Stats pills** (`components/common-logs-stats.tsx`): three pills with coloured accent bars.
**Usage** is the summed quota converted to money. **RPM** and **TPM** are raw numbers (note
the backend's 60-second window, section 4.1). They refetch whenever the URL changes, keep the
old values while loading, and show skeleton pills on first load. The page requests them with
`p=1&page_size=1` because the stats and list share a query builder (`common-logs-stats.tsx:57-87`).

**Table columns** (`components/columns/common-logs-columns.tsx`):

| # | Column | Rendering | Scope |
|---|---|---|---|
| 1 | Time | monospace date-time, with the coloured log-type badge underneath. Cannot be hidden (`349-380`) | all |
| 2 | Channel | `#id` chip in an id-derived colour, click to copy. Multi-key index bubble. An amber "retry chain" button when more than one channel was tried, opening a popover with `a → b → c`. An amber sparkle button when sticky-session affinity applied, opening the affinity cache-stats dialog. Channel name in muted text below (`383-544`) | admin |
| 3 | User | hashed-colour avatar and truncated name. Click opens the user info dialog: balance, used quota, request count, group, invite stats, remark (`545-603`; `components/dialogs/user-info-dialog.tsx`) | admin |
| 4 | Token | key-icon chip (copy), then a group badge and the effective group ratio (e.g. `0.8x`) (`607-668`) | all |
| 5 | Model | provider logo (or a hashed dot) and the name, click to copy. Becomes a popover when the model was mapped (route icon) or the upstream returned a different model (warning chip) (`670-690`; `components/model-badge.tsx`; `lib/response-model.ts:34-51`) | all |
| 6 | Stream | Stream / Non-stream label, tokens-per-second underneath, and a red alert icon when stream status is not ok (the tooltip gives the end reason) (`691-716`; `components/timing-metrics-cell.tsx:171-230`) | consume and error rows |
| 7 | Tokens | `input / output`, then a small line with cache read ↓ and cache write ↑. A dash when both are zero (`717-763`) | all |
| 8 | Cost | money badge. A crown icon means billed from a subscription (it then shows the subscription amount). A wallet icon shows only when subscriptions exist. A wrench badge marks a tool-call surcharge (`764-781`; `components/log-cost-display.tsx:81-101`; `lib/billing-source.ts:37-44`) | all |
| 9 | Timing | two stacked mini-metrics: **First token** (from `frt` ms, streams only) and **Duration** (`use_time`), with a thin two-colour bar. First token is green under 5s, amber under 10s, red above. Duration uses throughput when output is 100 tokens or more (green at 30 t/s or better, amber at 15 or better, red below), otherwise elapsed time (green under 10s, amber under 30s, red above) (`783-802`; `timing-metrics-cell.tsx:69-157`; `lib/format.ts:194-233`) | consume and error rows |
| 10 | Details | a one-line summary built from "segments", e.g. `Standard · $2.50 / $10.00 per M`, `Tier …`, `Per-call · $0.04`, cache prices, a red "Violation fee", a red "System prompt override", and for admins a red "Quota clamped" first. A `+N` counter shows extra segments. Click opens the details dialog (`804-889`, segments `111-339`) | all |

- Type-dependent cells: channel, token, model, tokens and cost appear only for types
  0/2/5/6. Stream and Timing appear only for 2/5. Top-up, system, manage and login rows show
  just the time and the details text (`constants.ts:354-359`).
- Row tints: errors rose, refunds blue. In admin view, quota-clamped rows are amber and that
  overrides the type tint (`usage-logs-table.tsx:57-64`, `260-284`).
- Log-type badge colours: 0 Unknown default, 1 Top-up cyan, 2 Consume green, 3 Manage
  orange, 4 System purple, 5 Error red, 6 Refund blue, 7 Login teal (`constants.ts:54-101`).
- No sorting, reordering or resizing. Filtering and pagination happen on the server
  (`usage-logs-table.tsx:222-223`).
- Pagination: page sizes 10/20/30/40/50/100. The default is **100 on desktop** and 20 on
  mobile, and a stored global page size or the URL overrides it
  (`usage-logs-table.tsx:134`; `components/data-table/core/pagination.tsx:44`).
- Loading: a skeleton on first load. On refetch the old rows stay and fade to 60% opacity.
  Empty: a database icon with "No Logs Found". Errors show a toast from the global query
  handler, and the table falls back to the empty state; there is no inline error panel
  (`usage-logs-table.tsx:184-198`).
- **No auto-refresh.** The data is considered fresh for 10s, refetch on window focus is off,
  and Search is the refresh button.
- **No export, no delete, no bulk actions** on this page.

**Log details dialog** (`components/dialogs/details-dialog.tsx`). A centred modal with the
title "Log Details" and the type badge. It is narrow by default and wide when tiered pricing
applies, scrolls internally, and is capped at about 72% of the viewport height (`623-649`).
Sections appear only when relevant, in this order:

1. **Overview**: request id, upstream request id, channel id+name (admin), retry chain
   (admin), token, group, IP (consume/error rows, or top-up rows for admins), response time
   plus first-token time for streams (`652-750`).
2. **Request conversion** (admin): path and format chain, or "native" (`753-790`).
3. **Request policy decisions** (admin): the retry/stop decisions per attempt (`793-800`).
4. **Quota clamped** (admin, red): kind, original value, clamped value, operation (`801-833`).
5. **Reject reason** (admin, red) (`836-844`).
6. **Violation fee** (red): code, marker, amount (`847-872`).
7. **Refund details** (refund rows): task id, reason (`875-884`).
8. **Task plugin** (admin), **Root diagnostics** (root): API version, generation, upstream
   task id, node (`886-946`).
9. **Top-up audit info** (admin, top-up rows): payment method, callback method, caller IP,
   server IP, node, version. Legacy rows get a notice instead (`949-974`).
10. **Quota adjustment details**: target user, mode, requested amount, before → after
    (`976-980`; `lib/quota-audit-operation.ts:82-126`).
11. **Operation audit info** and **Login info**: only for legacy manage/login rows
    (`983-1061`).
12. **Audio tokens** (realtime/audio): audio and text in/out (`1064-1099`).
13. **Reasoning effort** chip (colour by level), **System prompt overwritten** chip
    (`1102-1114`; `lib/format.ts:172-189`).
14. **Response model** (requested / upstream / returned, with a mismatch warning) or
    **Model mapping** (requested → actual) (`1131-1152`).
15. **Token breakdown**: input, output, cache read, image cache, cache write (5m/1h), image
    tokens, and the billable breakdown map (`373-467`).
16. **Billing details** (consume rows): mode (per-token, per-call or dynamic), prices per 1M,
    group ratio or user-exclusive ratio, cache prices, audio/image prices, tool calls with
    counts, the **billing path** (admin: local estimate vs upstream-reported usage), usage
    facts, total cost (`165-371`).
17. **Dynamic pricing** breakdown (tiered models) (`1169-1189`).
18. **Stream status** (when not ok): status, end reason, soft-error count, end error, and an
    error list in a code block (`1214-1252`).
19. **Subscription billing**: plan, instance, pre-consumed, post delta, final amount,
    remaining of total (`1255-1300`).
20. **Param override (N)**: each override action (set, delete, regex replace, and so on) with
    its content (`1303-1330`).
21. **Content**: raw text with a copy button (`1333-1356`).

Channel affinity details are not in the dialog. They appear only in the channel cell's
tooltip and in the sparkle → cache-stats dialog (`index.tsx:167-183`).

### 5.2 Common Logs, mobile (≤ 640px)

- The toolbar collapses to the stats pills, a pinned date picker (which applies
  immediately), and a row with the eye toggle, **Filter (N)**, Search and View. Filter opens
  a **bottom drawer** (up to 85% of the viewport height) with every other field, and Reset
  and Search in its footer (`components/logs-filter-toolbar.tsx:141-240`).
- Rows become **cards** (`components/common-log-mobile-card.tsx`):

```
+------------------------------------------+
| [logo] gpt-4o-mini              $0.0012   |
| ● Consume  09-26 14:03:11   Stream 42t/s ●● |
| user: alice      channel: #12 openai-a   |
| token: prod-key  group: default  0.8x    |
| In 1,204  Out 356  Cache ↓800 ↑0         |
| Standard · $0.15 / $0.60 per M        >   |
+------------------------------------------+
```

  Error and refund cards get tinted borders. Tapping a field opens a bottom sheet with the
  full value and a big Copy button. Masked fields cannot be tapped. The cards respect column
  visibility. Pagination switches to a compact variant, and the first load shows three
  skeleton cards.

### 5.3 Drawing Logs (Midjourney) and Task Logs

These share the Usage Logs page. The title reads "Task Logs", and a Drawing | Task tab strip
appears when both modules are enabled (`index.tsx:87-153`).

**Filter bar** (`components/task-logs-filter-bar.tsx:118-219`): date range, a Task ID input,
Channel ID (admin), Reset and Search. The same mobile drawer pattern applies. Timestamps are
sent in **milliseconds for Midjourney** and in seconds for tasks, because the two tables
store different units (`lib/utils.ts:128-152`, `260-288`; `relay/mjproxy_handler.go:246`;
`model/task.go:272`).

**Drawing columns** (`components/columns/drawing-logs-columns.tsx`): Submit time (with the
status badge underneath), Channel (admin), Type (action badge: Draw, Upscale, Vary, Pan,
Describe, Blend, Zoom, Inpaint, Swap face, and so on, each colour-coded:
`constants.ts:233-250`), Task ID (copy), Duration (a pill that turns red over 60s), Submit
result (admin: submitted / waiting / duplicate / not submitted), Progress (the raw "45%"
text, not a bar), Image (opens a preview dialog with the URL), Prompt (opens a dialog with
the prompt and its English version, each copyable), Fail reason (red, opens a dialog).
Statuses: success green, queued yellow, in progress blue, failure red, waiting (modal) amber
(`constants.ts:256-284`).

**Task columns** (`components/columns/task-logs-columns.tsx`): Submit time (with the finish
time underneath), Channel / User / Plugin (admin), Task ID with "platform · action" beneath
(Generate music, Text to video, Image to video, and so on), Duration (red over 300s),
Status, Progress, **Artifacts**, and Details (with the fail reason in red beneath).

**Artifacts** (`components/task-artifacts.tsx`, `lib/task-artifacts.ts`): these are loaded
only when the dialog opens and only for successful tasks
(`GET /api/task/:id/artifacts`, `private, no-store`). The dialog is a grid of cards with an
image, a video player, an audio player or a file icon, plus Download and a Retry on media
error. Legacy Suno clips get an audio dialog with cover art and duration. The client
strictly checks artifact URLs (http(s) only, a fixed content path, a 43-character access
token) (`lib/task-artifacts.ts:29-228`; `controller/task.go:93-131`, `252-286`).

**Task details dialog** (`components/dialogs/task-details-dialog.tsx`): basic info (id,
platform, action, progress, submit/start/finish, original vs actual model, fail reason). An
admin section adds user, channel, group, quota, request id and path, and the plugin. A root
section adds plugin API version, generation, upstream task id and node (`95-262`).

**Stored rows.** `midjourneys` has code, action, mj_id, prompt, prompt_en, state, submit,
start and finish times in ms, image/video URLs, status, progress, fail reason, channel,
quota, buttons, properties, and hidden token/billing-channel ids
(`model/midjourney.go:3-29`). `tasks` has task_id, platform, user, group, channel, quota,
action, status, fail reason, times in seconds, progress, a `properties` JSON (input and
models), a raw upstream `data` snapshot, and a never-serialised `private_data` JSON (key,
upstream id, result URL, billing context, plugin snapshot, node)
(`model/task.go:50-172`). Billing for these jobs lives in the Common Logs as consume and
refund rows linked by `task_id`, not in these tables.

### 5.4 Audit Logs (`audit/`)

- Page title "Audit Logs". Admins with `audit.read` get All / Only Mine. If the admin
  endpoint returns 403, the page drops to self scope, refreshes the profile and shows a note
  (`audit/index.tsx:42-114`).
- Filters (local state, not stored in the URL): date range, Result (All / Success /
  Failed), Category (All, Login, Account security, Operation audit, Access token), and
  advanced Token identifier, Request ID and Username (All scope only)
  (`audit/components/audit-log-filter-bar.tsx:68-226`).
- Columns: Time, Username, Event (localized headline, target id, two-line description), IP,
  Client (user agent, hidden on mobile), Method, Route, HTTP status, Result badge, Details
  (`audit/components/audit-log-columns.tsx:37-181`).
- The details dialog has: summary header, token or quota operation details, operator (name,
  id, role, auth method), target, changed fields, request block (method, status, IP, client,
  route, request id, token ref, all copyable), and leftover metadata rendered recursively
  (`audit/components/audit-log-details-dialog.tsx:35-181`).
- Localization: the backend stores a stable `action` key and `params`, plus an English
  fallback sentence. The frontend has around 85 i18n templates keyed by action and fills in
  the params, falling back to the English content (`controller/audit.go:20-73`,
  `lib/format.ts:450-606`, `audit/lib/audit-details.ts:323-476`). Adopt this pattern.
- The same viewer is reused in an "access-token only" mode on the Security page, showing the
  history of the personal access token (`features/security/components/access-token-card.tsx:210`).
- Load errors get an inline Retry alert, and an inverted date range shows an inline error
  (`audit/components/audit-log-viewer.tsx:56-167`). This is better error handling than the
  Common Logs page has.

---

## 6. Dashboard and analytics derived from logs

### 6.1 Aggregation model

- **Pre-aggregated, hourly, in the main DB.** Each consume write adds one to an in-memory
  map keyed by user, username, model, hour, group, token, channel and node, adding count,
  quota and tokens. Every `DataExportInterval` minutes (default 5) the map is written to
  `quota_data`: for each key, a SELECT, then either an increment UPDATE or an INSERT, all
  inside one global mutex (`model/usedata.go:41-139`).
- Refunds are **not** subtracted, and a task's later settlement adds another +1 to count
  (`model/log.go:445-461`). Channel tests go through `RecordConsumeLog`, so they also land in
  `quota_data` under the admin who ran the test (`controller/channel-test.go:505-517`).
- `perf_metrics` is a separate roll-up of latency, TTFT, success and throughput per model ×
  group × time bucket. It is kept in hot in-memory buckets and flushed with an upsert, and
  has a retention-days setting (`model/perf_metric.go`, `pkg/perf_metrics/*`).
- The backend always returns hourly rows. **All day/week bucketing happens in the browser**
  (`web/src/features/dashboard/lib/charts.ts:228-296`). "Week" builds its label from each
  row's own date, so it appears to group by day under a 7-day label. If there are fewer than
  7 time points, the axis is padded to 7 synthetic points.

### 6.2 Dashboard screens (`web/src/features/dashboard/`)

Charts use VisActor VChart. Sparklines are hand-drawn SVG. Nothing auto-refreshes (data is
considered fresh for 60s).

- **Overview** (`components/overview/overview-dashboard.tsx`): a setup guide (API key
  created → has balance → first request; the collapse state is stored), a first-request
  curl snippet, quick actions, and summary cards (`components/overview/summary-cards.tsx`):
  "Last 24h usage" from `/api/data/self` (12-bucket sparkline), historical usage and request
  count from the user profile, and a credit panel with a **runway estimate** (balance ÷ last
  24h spend, flagged caution under 3 days). Admins also get a performance health panel
  (success %, average latency, throughput, top 6 models from `perf_metrics`), plus optional
  API info, announcements, FAQ and uptime panels.
- **Models ("model call analytics")**: five stat cards (total calls, total quota, total
  tokens, average RPM = calls ÷ minutes in range, average TPM) from `/api/data[/self]`
  (`components/models/log-stat-cards.tsx`; `hooks/use-dashboard-config.tsx:44-91`). An admin
  performance strip. A **Quota distribution** card that switches between stacked bars and
  area (per model, top 15 + Other). A **Model analytics** card with tabs: call trend (area,
  top 20 + Other), call share (donut), call ranking (bars). The filter dialog has quick
  ranges (1/7/14/29 days), custom start/end, granularity (hour/day/week) and, for admins, a
  username. The preferences dialog stores default range, granularity and chart types in
  localStorage (`components/models/*`; `lib/filters.ts:94-136`; `constants.ts:21-69`).
- **Users** (admin): top-N (5/10/20/50) user consumption ranking (horizontal bars) and a
  per-user trend area chart from `/api/data/users` (`components/users/user-charts.tsx`).
  Users outside the top N are dropped, not merged into "Other".
- **Flow** (Sankey): columns are token → group → model for users; user → group → model →
  channel for admins; and root adds node and token. Controls: width by quota, tokens or
  requests; top N per column (10/20/50/100) with overflow merged or hidden; per-column node
  filters; column toggles (at least 2); an admin user multi-select; click to highlight a
  path; and a privacy eye toggle (`components/flow/flow-charts.tsx`; `lib/flow.ts:246-258`,
  `1118-1335`; `model/usedata_flow.go:25-92`).

---

## 7. Privacy and security

- **No prompt or response content is stored** in `logs`, `audit_logs` or the roll-ups.
  The consume row records metadata, token counts and pricing only. Error rows store the
  masked upstream error message (URLs and keys scrubbed by `MaskSensitiveInfo`)
  (`relaykit/types/error.go:148-174`). Midjourney rows do store the user's **prompt**, and
  task rows store the task input in `properties` (`model/midjourney.go`, `model/task.go:83-87`),
  so for image and video jobs the prompts are retained.
- **Scoped metadata.** `other` is written through an API that makes it hard to put
  privileged data in the public scope. Reads project by viewer: user (public only), admin
  (minus root), root (everything). Legacy rows that stored channel info at the top level are
  cleaned up when read (`model/log_other.go:17-24`, `187-263`; `model/log.go:116-138`).
- **Hidden from users:** channel name, retry path, affinity, billing model, diagnostics,
  reject reason, quota clamps, payment callback details, node, and upstream task ids.
  User-facing row ids are replaced with page-relative display numbers
  (`model/log.go:110-122`).
- **Still visible to users:** the numeric `channel` id (a test asserts that it is kept,
  `model/log_format_test.go:117`), `upstream_request_id`, pricing ratios, and the upstream
  model name when mapping applied. If channel ids or upstream models are commercially
  sensitive, this leaks topology.
- **IP logging is opt-in per user** for relay rows. Top-up rows always store the payment
  callback IP.
- **Audit table:** stores route templates rather than raw URLs, never stores bodies, and
  identifies personal access tokens by a SHA-256 fingerprint. Events by unknown or root
  actors are hidden from non-root viewers (`model/audit_log.go:61-151`).
- **UI masking toggle** on Common Logs and Flow, for screen sharing.
- **Possible issue to verify:** the self-stat endpoint passes the session username through
  the wildcard-aware filter (`controller/log.go:131`, `model/log.go:620`). If a username
  can contain `%`, the query becomes a `LIKE` and sums other users' usage. I did not find
  a character whitelist for usernames (`model/user.go:81` only limits length).

---

## 8. Weaknesses, and what a new implementation should do better

1. **Synchronous single-row inserts, silent loss.** One INSERT per event on the request
   goroutine, with no batching, no retry and no outbox. Under DB pressure, relay latency
   rises and billing records disappear with only a text-log line
   (`model/log.go:101-104`, `382-385`). *Better:* append to a local write-ahead queue or
   buffered channel, batch insert every 250 ms or 500 rows, retry, and count drops as a
   metric.
2. **Latency has poor resolution.** `use_time` is whole seconds. Only `frt` (ms) exists, and
   it is buried in JSON. There is no upstream connect time, no generation time, no per-attempt
   timing, and error rows have no tokens. *Better:* first-class integer ms columns
   `latency_ms`, `ttft_ms`, `upstream_ms`, `queue_ms`, plus `output_tps`.
3. **Key facts are hidden inside an unindexed JSON string.** Cache tokens, stream status,
   billing source, HTTP status, error code and the retry path cannot be filtered or
   aggregated without parsing (`model/log.go:80`). *Better:* promote anything you filter or
   chart on to real columns (status_code, error_code, cache_read_tokens, cache_write_tokens,
   attempt_count, final_channel_id, billing_source) and keep JSON only for the long tail.
4. **Retries are not modelled.** Each failed attempt is a separate error row, and they are
   tied together only by `request_id`. Error rows are off by default
   (`ERROR_LOG_ENABLED=false`). *Better:* one `request` row plus child `attempt` rows (channel,
   status, latency, error), always recorded.
5. **Stats are misleading.** RPM/TPM always cover the last 60 seconds, whatever window the
   user picked. The `type` filter is ignored. Refunds are never netted out of quota or
   dashboard totals. Channel tests count as real consumption (`model/log.go:614-674`,
   `controller/channel-test.go:505`). *Better:* compute rates over the selected window, show
   net spend (consume − refund), and tag test/benchmark traffic with a `source` column that
   is excluded by default.
6. **Pagination cost.** The admin list does an exact `COUNT(*)` plus OFFSET on every page.
   The user list adds a `LIMIT` to the count query, which likely does not bound the scan
   (`model/log.go:499-507`, `589`). *Better:* keyset (cursor) pagination on
   `(created_at, id)`, with an approximate or capped count.
7. **No retention on SQL backends.** Purging is manual and root-only. `quota_data` and
   `audit_logs` grow forever. *Better:* per-table retention settings enforced by a daily job,
   with roll-ups kept longer than raw rows.
8. **No export.** No CSV/JSON download of filtered logs. *Better:* stream an export of the
   current filter.
9. **Denormalised names drift.** `username` and `token_name` are copied at write time, but
   channel names are joined live, so a renamed channel rewrites history while a renamed
   token does not. *Better:* store ids plus a name snapshot for both, and show "renamed"
   hints.
10. **Roll-up fragility.** The in-memory buffer is lost on crash. The flush does a SELECT
    then UPDATE/INSERT per key under a global lock (`model/usedata.go:100-139`). Browser-side
    week bucketing looks wrong. *Better:* a DB upsert (`ON CONFLICT DO UPDATE`), or derive
    roll-ups from the durable log table with an idempotent job, and bucket on the server.
11. **Frontend gaps.** No auto-refresh or "live tail". No inline error state on Common Logs.
    No sorting (for example by cost or latency). No saved filter presets. The Timing column
    colours by seconds, but only whole seconds exist. The desktop default page size is 100.
12. **Too many indexes** (14) on the hottest table, including `ip` and `username`, while
    `type` has no single index and `(user_id, created_at)` is missing (lists order by id).
    *Better:* design the indexes around the actual query shapes.

---

## Recommendations for VENOM

**Scope (per the owner):** phase 1 is the local Electron desktop admin app, used by the
owner alone. It already has disabled **Test History** and **Monitoring** nav items, a Route
Test page, provider health probes, benchmarks, scheduled runs, and Settings sections for
history ("Keep the last N runs", export history) and "Diagnostics & Logs" (log level, log
file path). Logs in phase 1 come from admin-side requests only: model tests, benchmarks,
health checks, key-usage fetches and model discovery. A future hosted relay will add
per-subscriber request logs, so the schema must accept those later.

### What to borrow and what to skip from new-api

- Borrow: the flat request row plus a scoped JSON tail, the request-id correlation, the
  per-row pricing breakdown, the detail dialog laid out as ordered sections that appear only
  when relevant, column visibility per view, URL/state-persisted filters with a draft-then-
  apply pattern, date presets, the privacy mask toggle (useful for screenshots), the retry
  chain popover, response-model mismatch badges, first-token vs duration timing cells with
  colour thresholds, audit "action + params" localization, and the background purge job with
  a progress bar.
- Skip or fix: synchronous single inserts, whole-second latency, the 60-second-only RPM,
  un-netted refunds, test traffic mixed into consumption, OFFSET + COUNT pagination, and
  missing retention and export.

### Fields that matter for a router that also benchmarks models

Store as real columns (not JSON), in SQLite locally (for example `better-sqlite3`, WAL mode,
batched inserts in a transaction every ~250 ms):

- Identity and correlation: `id`, `request_id`, `run_id` (benchmark or scheduled-run
  batch), `source` (`route_test` | `benchmark` | `health_probe` | `key_usage` |
  `model_discovery` | `scheduled` | later `relay`), `created_at_ms`.
- Target: `provider_id`, `provider_name_snapshot`, `key_id` (never the key), `endpoint`
  (base URL host only), `api_format` (openai / anthropic / gemini / responses),
  `model_requested`, `model_returned`, `route_profile_id`, `attempt_index`, `is_final_attempt`.
- Outcome: `status` (ok / error / timeout / cancelled), `http_status`, `error_class`
  (auth, rate_limit, quota, network, timeout, bad_response, content_filter), and
  `error_message` truncated and masked.
- Timing, all integer ms: `latency_ms`, `ttft_ms`, `connect_ms` if available,
  `generation_ms`, plus the derived `output_tps`.
- Usage: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`,
  `reasoning_tokens`, and `usage_source` (reported vs estimated).
- Cost: `cost_usd_micros` (an integer, avoiding float drift) plus `price_snapshot` JSON (the
  per-M prices used).
- Request shape: `is_stream`, `stream_end_reason`, `max_tokens`, `reasoning_effort`, and a
  prompt **fingerprint** (a hash of the benchmark prompt id/version), so results stay
  comparable across runs without storing content.
- Future relay (nullable now): `user_id`, `token_id`, `subscription_id`, `group`,
  `client_ip` (opt-in), `billing_source`, `quota_charged`. Add these columns in phase 1 so
  there is no migration later.
- `meta` JSON for the long tail (conversion chain, param overrides, raw usage object).
- Optionally, keep request/response bodies **only for failed tests**, behind a setting, in
  a separate table with its own short retention. That is useful for debugging a provider,
  and it is safe in a single-owner desktop app. Never enable it for future subscriber traffic
  by default.
- Children: `request_attempts` (one row per provider/key tried), so fallbacks in Route Test
  show a retry chain.
- Roll-ups: `metrics_hourly` keyed by provider × model × source × hour (count, ok count,
  latency sum and p50/p95 sketch, TTFT sum, tokens, cost), maintained with an upsert in the
  same transaction as the batch insert. Charts read this, never the raw table.
- Retention settings: raw rows N days, failed-body captures M days, hourly roll-ups
  12 months. Run the purge on startup and daily. Reuse the existing "Keep the last N runs"
  setting for benchmark runs.

### Proposed page list (desktop app)

1. **Request Log** (fills the "Test History" nav slot, build first). This is the
   Common-Logs equivalent for every admin-side call. A toolbar with date presets (Last hour,
   Today, 7 days, 30 days, Custom), Source, Provider, Model, Status, a request/run id search,
   and the privacy mask toggle. Columns: Time, Source badge, Provider/key, Model (with a
   mismatch badge), Status/HTTP, TTFT, Latency, Tokens (in/out/cache), Cost, and Details. The
   default sort is newest first, and you can sort by latency, TTFT or cost. Cursor
   pagination. A details **side drawer** (better than a modal on desktop for comparing rows):
   overview, timing bar, usage and cost breakdown, attempts chain, error block, meta, and
   optionally the captured failure body. Row actions: re-run this test, copy as curl without
   the key, open the provider. Export of the current filter as CSV/JSON.
2. **Runs** (a sub-tab of Test History). One row per benchmark or scheduled run: when,
   profile, models × providers, pass rate, median TTFT and latency, total cost. Clicking a
   run opens its requests filtered by `run_id`, plus a comparison table (model × metric
   leaderboard for that run).
3. **Monitoring** (fills the "Monitoring" nav slot, second). Health over time from the hourly
   roll-up: per-provider uptime bars (reusing the existing sparkline setting), success rate,
   p50/p95 latency and TTFT trends, error class breakdown, and a "degraded now" list. KPI
   cards: requests, success %, p95 latency, spend over the window. Rates must be computed over
   the selected window. Optional auto-refresh (off / 30s / 1m), because the owner watches
   scheduled probes.
4. **Model Performance** (it can start as a Monitoring tab). A per-model × provider matrix
   of TTFT, TPS, success % and cost per 1M, with a time range. This is the benchmark
   leaderboard that new-api only offers as a public perf page.
5. **Usage & Spend** (later in phase 1): spend by provider, key and model per day. Key-usage
   fetch results show here as balance snapshots over time, with a runway estimate like
   new-api's credit panel.
6. **Activity / Audit** (small). Local app events: settings changed, provider added or
   removed, key added or rotated (fingerprint only), schedules edited, purge run. Use the
   action + params pattern with English templates.
7. **Settings → Diagnostics & Logs** (extend what exists): retention per table, the
   failed-body capture toggle, a purge-before-date job with progress, a DB size readout, and
   an export-all option.
8. **Future hosted relay (phase 2)**: the same Request Log with a **scope switch** (All /
   per subscriber). It gains User, Token and Subscription columns and filters, net spend
   (consume − refund), subscriber-safe projections (hide provider/key/channel, as new-api
   strips `admin_info`), and a per-subscriber usage page built on the same hourly roll-up
   keyed additionally by user and token.

Build order: the storage layer (schema, batched writer, roll-up, retention), then Request
Log with the details drawer, then Runs, then Monitoring, then Model Performance, and Usage
& Spend and Activity last.

### Open questions for the owner

- Should failed-test bodies be captured at all (and with what retention), or metadata only?
- Should benchmark traffic count toward spend totals, or be reported separately?
- Is p95 latency needed, or are averages enough (p95 needs a sketch or a raw-row query)?
- Which currency is shown, USD only or also the configured display currency?
