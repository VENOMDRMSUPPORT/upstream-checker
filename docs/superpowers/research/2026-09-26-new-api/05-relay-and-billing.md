# new-api study 05 - Relay, routing and billing

Date: 2026-09-26
Source studied: `C:\Users\venom\Desktop\new-api-research` (read-only, not run)
Compared with: `C:\Users\venom\Desktop\UPSTREAM CHECKER\src` (VENOM Router, Electron)

new-api is AGPL-3.0. This is a clean-room description. It covers behaviour and design in our own words,
with `file:line` references. No code was copied. Paths are relative to the new-api root unless
prefixed with `VENOM:`.

---

## 0. Key findings

1. **The router is a static table, not a decision engine.** A request picks a channel by
   `group -> model -> [channel ids]`. The table is sorted by admin-set `priority`, and a weighted
   random draw picks inside the top priority tier. Nothing about measured quality, latency or cost
   feeds that choice. Latency and TTFT are recorded (`model/perf_metric.go`), but only for
   dashboards.
2. **Retries walk down the priority tiers without excluding the channel that just failed.** Retry
   `n` uses the `n`-th highest priority tier (clamped to the lowest tier). If there is only one
   tier, every retry re-rolls the same dice. The default retry count is 0
   (`common/constants.go:137`).
3. **Health is reactive and binary.** A channel is auto-disabled when an upstream error matches a
   status-code range (default: only 401) or a keyword list. Recovery happens only when the scheduled
   channel test succeeds again. There is no circuit breaker, no half-open state, no gradual weight
   decay and no per-channel outbound rate limit.
4. **Billing is ratio-based and careful.** Every request reserves an estimated charge, runs,
   settles the difference against real usage, and refunds on final failure. Two funding sources
   (wallet and subscription) sit behind one `BillingSession`. Quota is an integer unit
   (500,000 = $1).
5. **Multi-node means "every node polls the database".** Channels and options reload in full every
   `SYNC_FREQUENCY` seconds (default 60). Redis, when present, carries token and user caches, atomic
   quota reservation, rate limits and session affinity. Channel health changes spread between nodes
   only on the next poll.
6. **The Electron build is a thin shell.** It spawns the Go server on port 3000 with SQLite in the
   user-data folder and loads it in a window. No gateway logic lives in Electron.
7. **VENOM already has what new-api lacks**: measured quality, speed, reliability, stability,
   capability probes and policy-driven virtual models. VENOM lacks what new-api has: a request
   path, persistent entities with IDs, a log table, and quota and money handling.

---

## 1. Request lifecycle

### 1.1 Route and middleware chain

The `/v1` relay group is set up in `router/relay-router.go:71-173`. Global middleware runs first:
CORS, request decompression, body-storage cleanup and stats (`router/relay-router.go:16-19`). Then,
in order:

| Stage | Function | Where | What it decides |
|---|---|---|---|
| 1 | `SystemPerformanceCheck` | `router/relay-router.go:73` | Sheds load when the host is saturated |
| 2 | `TokenAuth` | `middleware/auth.go:361-480` | Who is calling, which group they use |
| 3 | `ModelRequestRateLimit` | `middleware/model-rate-limit.go:175-208` | Per-user request budget |
| 4 | `Distribute` | `middleware/distributor.go:34-131` | Model allowlist check, first channel choice |
| 5 | `controller.Relay` | `controller/relay.go:68-224` | Billing reservation, retry loop, final error format |
| 6 | Format helper (`TextHelper`, `ClaudeHelper`, ...) | `relay/compatible_handler.go:25-187` | Mapping, conversion, upstream call, settlement |

Each endpoint only sets a `RelayFormat` (OpenAI, Claude, Gemini, Responses, embeddings, audio,
rerank, realtime WS). All of them go through the same `controller.Relay`
(`router/relay-router.go:97-158`). Gemini-native paths have their own group with the same chain
(`router/relay-router.go:186-206`).

### 1.2 TokenAuth

- **Finding the key.** The key is accepted from `Authorization: Bearer`, from Anthropic's
  `x-api-key` on `/v1/messages`, from Gemini's `?key=` or `x-goog-api-key`, from a WebSocket
  subprotocol, or from the Midjourney header (`middleware/auth.go:364-404`). The `sk-` prefix is
  stripped. Anything after a `-` is split off: `sk-KEY-42` means "pin channel 42", which only
  admins may do (`middleware/auth.go:536-554`).
- **Validation.** `model.ValidateUserToken` (`model/token.go:220-258`) checks status, expiry and
  remaining quota. It reads through Redis first (`model/token.go:280-301`). The cache key is an
  HMAC of the token (`model/token_cache.go:12-18`), but the database stores the raw key
  (`model/token.go:17`, `model/token.go:76-78`).
- **Per-token IP allowlist.** CIDR list (`middleware/auth.go:424-438`).
- **User status.** Loaded from the user cache (`middleware/auth.go:440-452`).
- **Group resolution.** The *using group* is the token's group if it has one. Otherwise it is the
  user's group. The token's group must be in the user's usable groups and must have a group ratio,
  unless it is the special value `auto` (`middleware/auth.go:454-472`).
- **`SetupContextForToken`** (`middleware/auth.go:506-556`) copies onto the request context:
  token id, name, remaining quota, the unlimited flag, the model allowlist map, the group, the
  cross-group-retry flag and the auto-group list.

### 1.3 Distribute: the first channel choice

`Distribute` (`middleware/distributor.go:34-131`) does four things:

1. Reads `model` (and an optional `group`) from the body without a full decode
   (`middleware/distributor.go:231-289`). It rejects duplicate `model` keys.
2. Applies the token model allowlist. The match is exact, then normalised, then by routing-alias
   name (`middleware/distributor.go:57-74`, `middleware/distributor.go:517-525`).
3. Calls `service.SelectChannelForRequest` (`service/channel_select.go:283-377`), which works in
   this order:
   1. A pinned channel wins (admin token suffix, or an origin task).
   2. On the first attempt only, a *session-affinity* channel from the affinity cache is used
      (`service/channel_select.go:312-347`).
   3. Otherwise, a weighted random channel is drawn (section 3).
4. Calls `SetupContextForSelectedChannel` (`middleware/distributor.go:548-656`). It stores
   everything the helper will need: channel id/type/base URL, model mapping, status-code mapping,
   param and header overrides, the auto-ban flag, provider-specific `Other` fields, and the upstream
   key picked by `GetNextEnabledKey` for multi-key channels.

After the handler returns successfully, the channel is recorded as the affinity target for that
session key (`middleware/distributor.go:127-129`).

### 1.4 controller.Relay: reserve, loop, refund

`controller/relay.go:68-224`:

1. **Validate the request** into a typed DTO for the format (`controller/relay.go:109-118`).
   **Build `RelayInfo`**, the per-request state bag (`relay/common/relay_info.go:669`).
2. **`PrepareRequestBilling`** (`relay/request_billing.go:24-67`) runs:
   - an optional sensitive-word check;
   - a prompt-token estimate;
   - `ModelPriceHelper` to price the request;
   - `PreConsumeBilling` to reserve funds (section 5).

   A deferred **`RefundFailedRequestBilling`** (`relay/request_billing.go:71-81`) refunds the
   reservation if the request ends in error, and may charge a violation fee.
3. **Retry loop** (`controller/relay.go:158-216`), up to `RetryTimes`. Each attempt:
   - `getChannel` (`controller/relay.go:262-294`). The first attempt reuses the channel `Distribute`
     chose. Later attempts call `CacheGetRandomSatisfiedChannel` with the retry index, recompute the
     group ratio, and re-run `SetupContextForSelectedChannel`.
   - Re-prices tiered billing for the selected group (`controller/relay.go:170`).
   - Rewinds the stored body and dispatches to the format helper.
   - On success, marks the request-policy trail and returns.
   - On failure:
     - `DecideRelayRetry` (`service/relay_error.go:21-58`) decides whether to try again.
     - `RecordPolicyFailure` records the attempt.
     - `ProcessChannelError` (`service/relay_error.go:64-99`) may auto-disable the channel
       asynchronously and writes an error log row.
4. The tried channels are logged as a trail like `12->7->31` (`controller/relay.go:218-223`).
5. **Errors are rendered in the caller's format.** OpenAI clients get the OpenAI shape, Claude
   clients the Claude shape, WebSocket clients a WS error (`controller/relay.go:88-107`).

**When a retry happens** (`service/relay_error.go:21-58`):
- **Never** on: strict session binding, a pinned channel, errors flagged skip-retry (bad request,
  quota, sensitive words), 2xx, and 504/524 or a bad response body
  (`setting/operation_setting/status_code_ranges.go:31-38`).
- **Always** on errors flagged as channel errors.
- **Otherwise** by the configured status ranges. The default retries 1xx, 3xx, 401-407, 409-499,
  500-503, 505-523 and 525-599 (`setting/operation_setting/status_code_ranges.go:21-29`).

### 1.5 Format helper: TextHelper

`relay/compatible_handler.go:25-187`, the OpenAI chat path. Other formats follow the same shape.

1. `InitChannelMeta` copies the channel context into `RelayInfo` (`relay/compatible_handler.go:26`).
2. The request is deep-copied, so retries start from the client's original body
   (`relay/compatible_handler.go:33`).
3. **`ModelMappedHelper`** (`relay/helper/model_mapped.go:14-69`) applies the channel's JSON
   `model_mapping`. Mappings can chain (`a->b->c`) and cycles are detected. The result becomes
   `UpstreamModelName`. The client-facing `OriginModelName` stays the billing key.
4. Stream options are normalised (`relay/compatible_handler.go:50-68`).
5. **`GetAdaptor(apiType)`** (`relay/relay_adaptor.go:50`) picks the provider adaptor. The adaptor
   interface (`relay/channel/adapter.go:17-34`) has:
   - `GetRequestURL`;
   - `SetupRequestHeader`;
   - one `Convert*Request` per inbound format;
   - `DoRequest`;
   - `DoResponse`;
   - `GetModelList`.

   About 60 channel-type constants (`constant/channel.go:5-64`) map onto roughly 45 adaptor
   packages under `relay/channel/`.
6. Some chat requests are sent upstream as Responses API calls. This is a global switch per channel
   and model (`relay/compatible_handler.go:77-96`).
7. Otherwise, one of two paths:
   - **Pass-through:** the raw body is forwarded.
   - **Normal:** the adaptor converts the request, disabled fields are removed, and channel
     **param overrides** are applied as JSON patches (`relay/compatible_handler.go:98-150`).
8. `DoRequest` sends the call. A non-200 status becomes a `NewAPIError`, optionally with the status
   code rewritten by the channel's `status_code_mapping` (`relay/compatible_handler.go:153-168`).
9. `DoResponse` converts the upstream reply (or stream) back to the client's format and returns
   usage (`relay/compatible_handler.go:171`).
10. **`PostTextConsumeQuota`** settles and logs (`relay/compatible_handler.go:178-185`).

### 1.6 Streaming

`StreamScannerHandler` (`relay/helper/stream_scanner.go:83` onward) handles SSE with three
goroutines:

- a line scanner on the upstream body;
- a data handler that converts each event and writes it to the client under a mutex;
- an optional keep-alive ping ticker.

An idle timeout (`STREAMING_TIMEOUT`, default 300s, `common/init.go:179`) cancels a stalled
upstream.

The OpenAI stream handler (`relay/channel/openai/relay-openai.go:103-197`) keeps the last two events,
because some gateways put usage on the second-to-last one. If no usage arrived, it **counts tokens
locally** from the accumulated text (`relay/channel/openai/relay-openai.go:183-186`).

Once the first byte is written, there is no failover. Mid-stream problems are recorded in
`StreamStatus` and are not returned as errors, so the loop never retries a half-sent stream. The
partial output is billed.

### 1.7 Settlement and logging

`PostTextConsumeQuota` (`service/text_quota.go:393-551`):

1. Computes the final quota (section 5). A tiered-expression price applies if configured.
2. Bumps user used-quota, request count and channel used-quota (`service/text_quota.go:452-458`).
3. Calls `SettleBilling` (`service/text_quota.go:460`, `service/billing.go:51`). This applies `actual - reserved` to the funding
   source and then to the token (`service/billing_session.go:45-83`).
4. Writes one **consume log** row (`model/log.go:59-81`, `model/log.go:339`) with user, token,
   channel, model, group, prompt and completion tokens, quota, duration, stream flag, request id,
   upstream request id, and an `other` JSON blob. The blob holds the ratios used, cache token
   counts, first-response time `frt` (`service/log_info_generate.go:111`), the channel trail and
   the policy events.

Logs can go to a separate database (`LOG_SQL_DSN`, `model/main.go` `InitLogDB`), including
ClickHouse.

---

## 2. Channels

### 2.1 Entity

`model/channel.go:23-60`. One row is one upstream account/endpoint. Fields:

| Field | Meaning |
|---|---|
| `type` | Adaptor selector |
| `key` | Upstream secret(s), plaintext, newline- or JSON-array-separated |
| `base_url` | Upstream endpoint |
| `models` | Comma list the channel serves |
| `group` | Comma list of user groups allowed to use it |
| `priority` | Higher tier is tried first |
| `weight` | Relative share inside a tier |
| `model_mapping` | JSON: client model -> upstream model |
| `status_code_mapping` | Status rewrite rules |
| `auto_ban` | Per-channel opt-in to auto-disable |
| `test_model` | Model used by the health check |
| `response_time`, `test_time` | Last health-check result |
| `balance`, `balance_updated_time` | Upstream credit, USD |
| `used_quota` | Lifetime spend through this channel |
| `tag` | Batch-edit handle (`model/channel.go:819-904`) |
| `setting` | Force format, thinking-to-content, proxy, pass-through, system prompt, HTTP/2 shards (`relaykit/dto/channel_settings.go:14-34`) |
| `param_override`, `header_override` | JSON patches applied to outbound calls |
| `other` | Per-type extra: Azure API version, Vertex region, Coze bot id (`middleware/distributor.go` near the end of `SetupContextForSelectedChannel`) |
| `channel_info` | Multi-key state (below) |

Status values are 1 enabled, 2 manually disabled and 3 auto-disabled
(`common/constants.go:258-261`).

### 2.2 Multi-key channels

- **State.** `ChannelInfo` (`model/channel.go:64-72`) marks a channel as multi-key and stores:
  - a mode: random or polling;
  - a per-index status map;
  - per-index disable reason and time;
  - a polling cursor.
- **Key choice.** `GetNextEnabledKey` (`model/channel.go:206-290`) takes a per-channel mutex and
  picks an enabled index, randomly or round-robin.
- **Disable.** On error, only the failing key index is disabled (`model/channel.go:673-723`). When
  every key is disabled, the whole channel becomes auto-disabled with the reason "All keys are
  disabled".
- **Cursor persistence.** The polling cursor survives cache reloads (`model/channel_cache.go:84-96`).
  It lives in each node's memory, so nodes rotate on their own.

### 2.3 Status and auto-disable

- **When to disable.** `ShouldDisableChannel` (`service/channel.go:57-77`) returns true when all of
  these hold:
  - auto-disable is enabled globally;
  - the error is not skip-retry;
  - the error is a channel error, **or** its status is in the disable ranges (default only `401`,
    `setting/operation_setting/status_code_ranges.go:17`), **or** its message contains one of the
    configured keywords, matched with Aho-Corasick. The defaults include "credit balance is too
    low", "exceeded your current quota" and "organization has been disabled"
    (`setting/operation_setting/operation_setting.go:8-16`).
- **How it is applied.** `DisableChannel` (`service/channel.go:28-46`) runs in a goroutine and only
  if the channel's `auto_ban` is on. `UpdateChannelStatus` (`model/channel.go:738-817`) updates the
  in-memory cache first, which removes the channel from the routing table
  (`model/channel_cache.go:251-274`). It then updates the DB row and the ability rows. It closes
  active WebSockets on that channel and notifies the root user.
- **Re-enable.** Happens only when a later health check succeeds on an auto-disabled channel
  (`service/channel.go:79-90`, `controller/channel-test.go:957-960`).

### 2.4 Channel testing

- **Single test.** `testChannel` (`controller/channel-test.go:72`) builds a minimal request for the
  channel's `test_model` and endpoint, runs it through the real adaptor, and bills it to a test
  user.
- **Scheduled health check.** `testChannelForHealthCheck` (`controller/channel-test.go:920-966`)
  runs as a DB-leased system task (`controller/channel-test.go:1089-1129`). It:
  - tests every channel that is not manually disabled, with bounded concurrency;
  - disables a channel when the error qualifies, or when the response time exceeds a threshold;
  - re-enables auto-disabled channels that now pass;
  - stores `response_time`.
- **Test modes.** A mode setting chooses between all channels, auto-ban channels only, or
  "passive recovery": test only disabled channels and never disable
  (`controller/channel-test.go:1111-1129`).

### 2.5 Balance checks

- `updateChannelBalance` queries a provider-specific billing endpoint. About ten upstreams are
  covered: OpenAI-SB, AIProxy, API2GPT, SiliconFlow, DeepSeek, OpenRouter, Moonshot, AIGC2D, and a
  configurable one for Advanced Custom (`controller/channel-billing.go:182-578`).
- A zero balance auto-disables the channel (`controller/channel-billing.go:620-646`).
- The check runs every `CHANNEL_UPDATE_FREQUENCY` minutes when that variable is set (`main.go:124-130`).
- Multi-key channels are skipped (`controller/channel-billing.go:629-631`).

### 2.6 Model inventory

`controller/channel_upstream_update.go` fetches each channel's `/models` list
(`controller/channel_upstream_update.go:364`). It computes models to add and remove against the
channel's configured list, and either stores them as pending for admin approval or applies them
automatically (`controller/channel_upstream_update.go:691`). This is the closest thing new-api has to
VENOM's live model pool. It knows presence only, not quality.

---

## 3. Abilities and selection

### 3.1 The table

`Ability` (`model/ability.go:18-26`) has the composite key `(group, model, channel_id)` plus
`enabled`, `priority`, `weight` and `tag`. `AddAbilities` (`model/ability.go:216-255`) expands a
channel into the cross product of its groups and models. Abilities are rebuilt when a channel
changes.

### 3.2 Two selection implementations

- **Memory mode.** This is the default whenever Redis is on (`main.go:83-86`), or with
  `MEMORY_CACHE_ENABLED`. `InitChannelCache` (`model/channel_cache.go:27-107`) loads all channels
  and builds `group2model2channels`: a map from group to model to channel ids, sorted by priority
  descending. The group→model→channel map is built from each channel's `group` and `models`
  columns. The abilities table is read only to list which groups exist
  (`model/channel_cache.go:45-69`). If the two disagree, the build can fail. That is why startup
  wraps it in a panic recovery that runs `FixAbility` (`main.go:91-104`).
- **DB mode.** `GetChannel` (`model/ability.go:108-164`) queries the abilities table directly.

### 3.3 How the pick works

`GetRandomSatisfiedChannel` (`model/channel_cache.go:117-217`), memory path:

1. Candidates are the ids for the exact `(group, model)`. If there are none, the normalised
   routing-alias name is tried. Candidates are filtered by request constraints: request path,
   task-plugin identity, Responses-WS support.
2. The distinct priorities are sorted from highest to lowest. The **retry index selects the tier**,
   clamped to the lowest tier (`model/channel_cache.go:151-168`).
3. Inside the tier, a weighted random draw runs:
   - If all weights are 0, each channel counts as 100.
   - If the average weight is below 10, all weights are scaled by 100. This changes nothing about
     the probabilities (`model/channel_cache.go:188-214`).
   - A channel with weight 0 next to non-zero siblings is never picked.

The DB path gives every ability `weight + 10` (`model/ability.go:145-158`). So the two modes give
different odds for the same configuration.

### 3.4 Auto group

When a token's group is `auto`, `CacheGetRandomSatisfiedChannel` (`service/channel_select.go:114-204`)
walks an ordered list of groups: the token's own list, or the global auto list filtered by the user's
permissions (`service/group.go:56-110`). It uses the first group that has a channel for the model.

With `cross_group_retry` on, a group's priority tiers are used up before the next group is tried.
The group actually used decides the price: `HandleGroupRatio` reads `auto_group`
(`relay/helper/price.go:43-69`). This is new-api's only form of fallback across "pools".

### 3.5 Session affinity

- Rules can extract a stickiness key from a context value, a header or a JSON path in the body
  (`service/channel_affinity.go:291-337`).
- The key maps to the last successful channel in a hybrid cache: Redis, or an in-memory LRU with TTL
  (`service/channel_affinity.go:83-111`).
- This keeps prompt caches warm on one upstream.
- A "strict" mode fails the request instead of rerouting when the sticky channel is gone
  (`service/channel_select.go:340-345`).
- Cache-hit statistics are collected per rule (`service/channel_affinity.go:795-896`).

### 3.6 Caching and refresh

The routing table is a process-local map behind an RW lock.

- **Full reload** every `SYNC_FREQUENCY` seconds (`model/channel_cache.go:109-115`, started in
  `main.go:106`).
- **Point updates** (`CacheUpdateChannel`, `CacheUpdateChannelStatus`) apply on the node where the
  change happened.

---

## 4. Tokens (user API keys) as the relay sees them

`model/token.go:14-32`:

| Field | Relay effect |
|---|---|
| `key` | 48-char secret, unique index, stored in plaintext |
| `status`, `expired_time` | Checked on every request (`model/token.go:220-258`) |
| `remain_quota`, `unlimited_quota` | Pre-consume reserves against it atomically (`model/quota_reserve.go:203`) |
| `model_limits_enabled`, `model_limits` | Allowlist enforced in `Distribute` |
| `allow_ips` | CIDR allowlist |
| `group` | Overrides the user's group, must be usable by the user and priced |
| `auto_groups`, `cross_group_retry` | Ordered fallback groups for the `auto` group |
| `used_quota` | Running spend |

A token is a **spending envelope inside the user's wallet**. Both are debited: the token's
`remain_quota` and the user's wallet or subscription (`service/billing_session.go:198-251`).

The token cache is a Redis hash. It has a write fence, so a stale reader cannot republish old data
after an edit (`model/token_cache.go:20-56`). Its TTL equals `SYNC_FREQUENCY`
(`common/redis.go:18-20`).

---

## 5. Pricing and billing

### 5.1 Units and prices

- **Units.** `QuotaPerUnit = 500,000` quota per $1 (`common/constants.go:22`). A model ratio of 1
  means $2 per 1M input tokens (`setting/ratio_setting/model_ratio.go:25-26`). At ratio 1, one token
  costs one quota unit.
- **Ratio tables**, each a hot-reloadable JSON option:

| Table | What it holds | Where |
|---|---|---|
| `ModelRatio` | Input price | `setting/ratio_setting/model_ratio.go:28` |
| `CompletionRatio` | Output price relative to input | `setting/ratio_setting/model_ratio.go:436` |
| `CacheRatio` | Cache-read price relative to input | `setting/ratio_setting/cache_ratio.go:12` |
| `CreateCacheRatio` | Cache-write price; a 1h write is a fixed multiple of the 5m price | `setting/ratio_setting/cache_ratio.go:88`, `relay/helper/price.go:118-121` |
| `ImageRatio`, `AudioRatio`, `AudioCompletionRatio` | Media token prices | `setting/ratio_setting/model_ratio.go` |
| `ModelPrice` | **Fixed $ per request**; overrides the ratios when present | `setting/ratio_setting/model_ratio.go:360-371` |
| `GroupRatio` | Multiplier per using group | `setting/ratio_setting/group_ratio.go:12-26` |
| `GroupGroupRatio` | Special multiplier for (user group, using group) | `setting/ratio_setting/group_ratio.go:88` |

- **Unpriced models.** A model with no ratio is refused, unless self-use mode is on or the user
  accepts unset ratios. In that case it is billed at ratio 37.5 (`setting/ratio_setting/model_ratio.go:385-393`).
- **Tiered expressions.** A newer optional mode (`billing_mode = tiered_expr`,
  `setting/billing_setting/tiered_billing.go:21-23`) replaces the ratios with one expression per
  model. It is written in real $/1M prices, with tier conditions on context length, cache/image/audio
  variables and fixed per-call charges (`pkg/billingexpr/expr.md`). It is snapshotted per request and
  re-evaluated for the group finally chosen (`service/tiered_settle.go:167`, `service/tiered_settle.go:205`).

### 5.2 Final charge

This is our own restatement of `service/text_quota.go:230-381`, ratio mode:

```
quota = (uncachedPrompt + cached*cacheRatio + cacheWrite*writeRatio + imageTok*imageRatio
         + completion*completionRatio) * modelRatio * groupRatio  (+ tool surcharges, extra ratios)
fixed-price model: quota = modelPrice * 500000 * groupRatio
```

Cache tokens are subtracted from the prompt only for OpenAI-style usage, because Anthropic-style
usage already excludes them. Any billable request is charged at least 1 quota unit.

### 5.3 Pre-consume, settle, refund

1. **Estimate.** `ModelPriceHelper` (`relay/helper/price.go:71-214`) reserves:
   - ratio mode: *estimated prompt tokens × PreConsumeMultiplier × modelRatio × groupRatio*;
   - fixed-price mode: the full fixed price.

   Completion tokens are not reserved in ratio mode (`relay/helper/price.go:97-129`).
2. **`NewBillingSession`** (`service/billing_session.go:379-479`) picks the funding source from the
   user's preference: `subscription_first` (default), `wallet_first`, `subscription_only` or
   `wallet_only`, with fallback between them.
3. **Trust bypass.** If both the user's wallet and the token hold more than `TrustQuotaUSD`
   (default $10, `setting/operation_setting/quota_setting.go:18-22`), nothing is reserved at all
   (`service/billing_session.go:319-352`). Subscriptions never use the bypass.
4. **Reserve** (`service/billing_session.go:198-251`). The token is reserved first, then the funding
   source. Both use atomic check-and-deduct: a Redis Lua script when Redis is on, with a fallback to
   a conditional DB update (`model/quota_reserve.go:165`, `model/quota_reserve.go:203`). If the
   funding step fails, the token step is rolled back.
5. **Settle** (`service/billing_session.go:45-83`). The funding source is adjusted by the delta
   first, then the token. This step is idempotent per session. A positive delta is debited
   **without a balance check** (`service/funding_source.go:57-65`), so a wallet can go below zero
   after a long completion.
6. **Refund** (`service/billing_session.go:86-127`). This is asynchronous and idempotent. A settled
   session never refunds. Wallet refunds are not retried because they are not idempotent.
   Subscription refunds are idempotent by request id (`service/funding_source.go:67-74`).
7. **Deferred writes.** With `BATCH_UPDATE_ENABLED`, user, token and channel quota deltas are
   buffered in memory and flushed every `BATCH_UPDATE_INTERVAL` seconds (default 5,
   `model/utils.go:35-126`, `main.go:161-165`). Redis copies are updated right away.

---

## 6. Money side (summary)

- **Wallet.** An integer `quota` on the user, with `used_quota` and `request_count`.
- **Top-up.** A `TopUp` order (`model/topup.go`) has a unique `trade_no`, money amount, credited
  amount, provider and status. Payment channels are Epay, Stripe, Creem and Waffo
  (`controller/topup*.go`). The price is *amount × unit price × per-group top-up ratio × optional
  amount discount* (`controller/topup.go:150-177`). Webhooks credit the wallet under an order lock.
- **Redemption codes.** A 32-char code worth a fixed quota, with optional expiry. It is redeemed in
  a row-locked transaction (`model/redemption.go:137-175`).
- **Subscriptions.** Three tables:
  - `SubscriptionPlan` (`model/subscription.go:146-190`): price, duration, total quota, reset period
    (daily, weekly, monthly or custom), upgrade/downgrade group, wallet-overflow flag, purchase cap,
    and Stripe/Creem product ids.
  - `SubscriptionOrder`: payment record.
  - `UserSubscription` (`model/subscription.go:253-285`): amount total and used, start/end,
    next reset, and a snapshot of the group change.

  A master-only task resets quotas on schedule (`main.go` `StartSubscriptionQuotaResetTask`).
- **Affiliate.** Each user has an `aff_code`, an inviter id and affiliate quota counters
  (`model/user.go:101-105`). On sign-up the invitee gets a fixed bonus and the inviter's affiliate
  balance is credited (`model/user.go:582-590`, `model/user.go:731-737`). The inviter can move it
  into the wallet (`model/user.go:597`). There is no percentage-of-spend commission.
- **Other.** A daily check-in bonus (`model/checkin.go`) and a new-user bonus (`common/constants.go:125`).

---

## 7. Rate limiting

| Limiter | Scope | Storage | Where |
|---|---|---|---|
| Global API | Per IP, on `/api` management routes only | Redis fixed window, or memory | `middleware/rate-limit.go:65-178`, `router/api-router.go:21`; default 360 per 180s (`common/init.go:124-125`) |
| Global Web | Per IP, static site | Same | `middleware/rate-limit.go:160-165`, `router/web-router.go:30` |
| Critical | Per IP (and per user) on login, reset and OAuth | Same | `middleware/rate-limit.go:174-190` |
| Model request | **Per user** on the relay, with per-group overrides | See below | `middleware/model-rate-limit.go:175-208`, `setting/rate_limit.go:25-55` |

The model-request limiter has two budgets per window:

- **Total requests.** A token bucket in Redis.
- **Successful requests.** A Redis list of timestamps, recorded only after a successful response
  (`middleware/model-rate-limit.go:81-133`).

Without Redis, an in-memory limiter per node is used, with a reservation that is completed on
success (`middleware/model-rate-limit.go:136-167`).

What is missing: despite the name, there is **no per-model limit** and **no per-token limit**, and
there is **no limit on outbound traffic per channel or key**. The relay `/v1` group has no per-IP
limiter either. The auth failure path is the only protection there.

---

## 8. Multi-node deployment

- **Roles.** `NODE_TYPE=slave` makes a node a follower (`common/init.go:89`). Only masters:
  - run DB migrations (`model/main.go:215`, `model/main.go:262`);
  - migrate retired options;
  - run scheduled system tasks: channel tests, upstream model updates, async task polling,
    subscription resets, credential refresh. Each task takes a **DB lease** with a heartbeat, so
    several masters do not run the same task twice (`service/system_task.go:305`, `main.go:150-159`).
- **Sync by polling.** Every node reloads channels and abilities (`main.go:106`), options
  (`model/option.go:222-228`) and authorisation policy (`main.go:119`) every `SYNC_FREQUENCY`
  seconds (default 60, `common/init.go:110`). There is no change notification.
- **What goes through Redis** (optional, but needed for correct multi-node behaviour):
  - token and user caches, with version fences;
  - atomic quota reservation;
  - model-request and IP rate limits;
  - the session-affinity cache;
  - a pub/sub topic that closes WebSockets on a disabled channel across nodes
    (`pkg/wsmanager/wsmanager.go:113-128`).
- **Shared via the database only:** channels, abilities, options, logs, orders and subscriptions.
- **Node-local and inconsistent across nodes:**
  - a channel auto-disabled on node A stays in node B's routing table until B's next reload;
  - multi-key polling cursors;
  - batch-update buffers, which are lost on crash;
  - in-memory limiters when Redis is off;
  - per-node load, which no node knows about the others.
- **Instance reporting.** Each process reports itself for the System Info page
  (`main.go` `StartSystemInstanceReporter`).

---

## 9. The electron/ folder

`electron/` wraps the finished server. It does not port it.

- **Spawning the server.** `main.js` spawns the compiled Go binary with `PORT=3000` and
  `SQLITE_PATH=<userData>/data/new-api.db` (`electron/main.js:11`, `electron/main.js:222-280`). It
  polls until the port answers, then loads `http://127.0.0.1:3000` into a `BrowserWindow`
  (`electron/main.js:388-404`).
- **Tray and errors.** A tray icon keeps it running in the background (`electron/main.js:428`).
  Startup errors such as "port busy" are analysed and shown in a dialog (`electron/main.js:15-148`).
- **Packaging.** `electron-builder` copies the Go binary and the licence files into
  `extraResources` (`electron/package.json`). `build.sh` builds the web UI, the Go binary and the
  package.
- **Bridge.** `preload.js` is 17 lines. No gateway logic crosses the bridge.

The takeaway for VENOM: new-api's "desktop app" is the hosted product run on localhost. It is not
a separate admin tool.

---

## 10. Concept mapping: new-api <-> VENOM

| VENOM concept (today) | new-api equivalent | Notes |
|---|---|---|
| **Provider**: module in `VENOM:src/renderer/providers/*.js` plus a config entry `{name, baseUrl, keys, rpm}` (`VENOM:src/main.js:359`) | **Channel type** (adaptor) plus the channel row's `base_url` | new-api has no provider entity above channels; each channel repeats the type and URL |
| **Key** (`provider.keys[]`, per-key `planModels`, DPAPI-encrypted at rest, `VENOM:src/keystore.js`) | `channels.key`: one channel per key, or a multi-key channel with per-index status | new-api stores upstream keys in plaintext; VENOM's per-key model plan has no counterpart (a multi-key channel assumes every key serves every model) |
| **Key usage** (`fetchKeyUsage` / `fetchKeyHistory`, `VENOM:src/renderer/key-usage.js`) | Channel balance check (`controller/channel-billing.go`) | VENOM is richer: quota, expiry, 24h success rate, allowance |
| **Model pool** (`catalog.json`, entries keyed `provider::model`, `VENOM:src/renderer/catalog.js:46`) | `channels.models` plus `abilities` plus the upstream model-update task | new-api tracks only presence; VENOM tracks pricing, context, capabilities and benchmark per source |
| **Model family** (`familyKey`, `VENOM:src/renderer/catalog.js:282`) | `RoutingMatchModelName` normalisation, model mapping | new-api normalises names for lookup only; VENOM shares measured intelligence across sources of a family |
| **Profile** `venom-lite/pro/max` (`VENOM:src/renderer/profiles.js:29-69`) | Closest: a client model name mapped via `model_mapping`, spread over channels with `priority`/`weight`, or the `auto` group | new-api has no virtual model: weights are hand-set and there is no eligibility policy |
| **Benchmark** (quality, TTFT, tok/s, capability probes, suite version, `VENOM:src/renderer/benchmark.js`) | **None.** `perf_metrics` records latency/TTFT per model×group for display (`model/perf_metric.go`) | This is VENOM's core advantage |
| **Reliability, stability, cooldown** (`VENOM:src/renderer/catalog.js:291-322`, `VENOM:src/renderer/profiles.js:175-201`) | Auto-disable on 401/keywords, re-enable on a passing test | new-api is binary and manual-ish; VENOM has success rate, streak cooldown and run spread |
| **Health check / Route Test** | Channel test, single or scheduled (`controller/channel-test.go:920-1129`) | Similar idea; new-api also acts on it (disable/enable) |
| **History** (`history.json` runs, per-entry bench history, `VENOM:src/main.js:116-165`) | `logs` table (consume and error rows with a JSON `other`), channel `response_time`/`test_time` | new-api logs **real traffic**; VENOM logs **probes** only |
| **Routing export** (`profiles.json`, `VENOM:src/renderer/profiles.js:311-336`) | Channels plus abilities, loaded into memory | VENOM computes shares but has **no request path**: no HTTP server in `VENOM:src/main.js`, only an IPC fetch proxy (`VENOM:src/main.js:388`) |
| **Provider `rpm`** | None | new-api has no outbound limit per channel or key |
| (none) | User, Token, Group, ratios, BillingSession, TopUp, Subscription, Redemption, Log | Everything needed to sell access |

**VENOM has, new-api lacks:**
- benchmark-driven eligibility and scoring;
- confidence levels, and inheriting intelligence across a model family;
- a per-provider share cap;
- a cooldown circuit breaker;
- capability probes (tools, JSON, long context);
- explained exclusions;
- keys encrypted at rest.

**To become a hosted multi-user router, VENOM needs:**
- a real request path (OpenAI/Anthropic-compatible ingress, adaptors, streaming);
- persistent entities with IDs (providers, keys, sources, profiles, policies);
- user and token entities;
- a request log;
- pricing and quota with pre-consume/settle;
- rate limits;
- a shared state store for health and limits.

---

## 11. Weaknesses in new-api and what a new design should do better

1. **Routing ignores evidence.** Priority and weight are typed by hand, and the recorded
   latency/TTFT never flows back. *Better:* compute weights from measured quality, latency, success
   rate and price, per virtual model, and recompute them continuously.
2. **Retries can re-hit the failing channel.** Retry *n* is "tier *n*", not "next best untried
   source". *Better:* keep a per-request exclusion set, move down a ranked list, and cap total time,
   not just attempt count.
3. **Health is binary and slow.** One 401 disables; only a scheduled test re-enables; other nodes
   learn after up to 60s. *Better:* a per-source circuit breaker (closed, open, half-open) with
   decaying weights, kept in shared state (Redis) so every node sees it at once.
4. **No outbound rate awareness.** Upstream RPM/TPM limits are discovered by getting 429s.
   *Better:* per-key token buckets fed from provider limits (VENOM already stores `rpm`) and from
   rate-limit response headers.
5. **Two selection code paths with different odds.** Memory and DB modes weight differently
   (section 3.3), and the memory table is built from channel columns, not from abilities. *Better:*
   one derived routing table, built from one source of truth, with tests.
6. **The same model on many channels is invisible.** No family concept, no dedupe, no cost-aware
   choice between two sources of the same model. *Better:* model -> family -> source, as VENOM
   already does.
7. **Secrets in plaintext.** Upstream keys and user tokens are stored raw. *Better:* envelope
   encryption for upstream keys, and hash-only storage for user tokens (show once).
8. **Reservation undershoots.** Ratio mode reserves only estimated prompt cost, the trust bypass
   reserves nothing, and settle can push a wallet negative. *Better:* reserve prompt plus a
   max-output estimate, hard-stop at zero for prepaid plans, and treat the trust bypass as an
   explicit credit limit.
9. **Mid-stream failure is billed and not recovered.** *Better:* record a "partial" outcome
   distinctly, count it against source reliability, and offer an optional first-token timeout
   failover before any byte is sent.
10. **Polling-based config sync.** Full reload every 60s on every node. *Better:* versioned config
    with a change event (pub/sub or LISTEN/NOTIFY), and incremental reloads.
11. **Billing is spread thin.** Ratios, completion ratios, cache ratios, fixed prices, group
    ratios, group-group ratios, tiered expressions and tool surcharges all interact. *Better:* one
    price record per (source, model) in real $/1M, with one retail markup per plan or virtual model.
12. **Names hide behaviour.** `ModelRequestRateLimit` is per user, not per model. The retry count
    defaults to 0. `auto_ban` is per channel while the switch is global. *Better:* explicit names
    and safe defaults.

---

## Recommendations for VENOM

The phase being built now is the **local Electron admin app**, run by the owner alone, gaining a
local database and a logging system. A hosted website comes later and will sell subscriptions to
the three virtual models only (`venom-lite`, `venom-pro`, `venom-max`). The desktop app stays
admin-only.

### Phase 1 - data the desktop admin must own now

The goal is that a future relay can read these tables as its source of truth, without
reinterpreting desktop-only JSON files. Do not copy new-api's channel row. Split what it merges.

1. **`providers`**: id, slug, display name, adaptor type (the protocol family: openai-compatible,
   anthropic, gemini, ...), base URL, status, notes, created/updated. This is one level above
   new-api's channel, so the type and URL are not repeated per key.
2. **`provider_keys`**: id, provider_id, label, **encrypted secret** (keep the DPAPI approach;
   design the column so a server can later use envelope encryption), status (enabled / disabled /
   spent / locked), disable reason and time, and known limits (rpm, tpm, daily quota). Also the
   last usage reading (`fetchKeyUsage` shape) and its timestamp. Per-key model plans (`planModels`)
   become a join table `key_models(key_id, model_id)`. new-api cannot express this.
3. **`models`** (families) and **`sources`**: a family (for example `claude-sonnet-4.x`) has many
   sources `(provider, upstream model id)`. Store on each source: context window, list price
   ($/1M in, out, cache read, cache write), capabilities (tools, json, vision, reasoning,
   long-context, with probe verdict and timestamp), kind (chat, embedding, image), first seen, last
   seen, removed_at. This replaces `catalog.json` entries and new-api's `models` string plus
   abilities.
4. **`benchmark_runs`** and **`benchmark_items`**: one run per (source, suite version) with
   composite, quality, TTFT, tok/s, latency and per-category scores. One item per prompt with
   status and timing. Keep all runs, not just the last 20: stability and trend need history, and
   the hosted relay will want the same evidence.
5. **`probe_results`**: health checks and Route Test verdicts. Store source or key, time, ok, HTTP
   status, error class, latency and TTFT. This is the reliability evidence the profile engine
   already reads from `history.json`. Keep error classes aligned with what a relay will see (auth,
   quota, rate_limit, upstream_5xx, timeout, bad_response), so live traffic can later be written to
   the same table.
6. **`profiles`** and **`profile_policies`** (versioned): the policies from
   `VENOM:src/renderer/profiles.js:29-69` as rows with a version number. Add
   **`profile_snapshots`**: the computed roster per profile, with every source's state (active,
   candidate, cooldown, excluded), score components, share and exclusion reasons, plus policy and
   suite version and a timestamp. This snapshot is the contract a relay will consume. It
   corresponds to new-api's in-memory `group2model2channels`, except it is computed from evidence
   and explainable.
7. **`request_log`** (the logging system): design it now as the new-api `logs` row that VENOM will
   eventually need, even though today it only holds admin-originated traffic (tests, benchmarks,
   Route Test). Store:
   - request id, time, origin (benchmark / probe / route-test / later: relay);
   - virtual model if any, source id, key id;
   - status, error class;
   - TTFT, total latency, prompt, completion and cache tokens;
   - computed upstream cost in real $;
   - attempt number and a retry trail.

   Keep it in its own table (or file) so it can grow without slowing the configuration database.
   new-api allows a separate log database for this reason.
8. **IDs and time everywhere.** Use stable ids, not `provider::model` string keys. Use UTC
   timestamps and soft deletes (`removed_at`). Add a `schema_version` and migrations from day one.
   new-api's value comes largely from having real entities that every subsystem joins on.
9. **Keep money out of phase 1.** Record upstream **cost** per log row in real dollars. Do not
   build quota units, ratios, wallets or top-ups in the desktop app. Those belong to the hosted
   side.

### Later - hosted relay

1. **Ingress**: an OpenAI-compatible (and optionally Anthropic-compatible) endpoint exposing only
   `venom-lite/pro/max`. Customers never see or choose real models. Most of new-api's group, model
   allowlist and mapping machinery then collapses into "which profiles does this subscription
   include".
2. **Selection**: read the latest `profile_snapshot`, then:
   - make a weighted pick among active sources (respecting the per-provider cap);
   - on a pre-first-byte failure, move to the next **untried** source;
   - stop on a total deadline.

   Fix the retry weakness from section 11, item 2.
3. **Live health**: write every relay attempt into the same evidence tables. Keep a per-source
   circuit breaker and per-key token buckets in shared state (Redis), so cooldowns take effect on
   every node at once. Do not rely on 60s polling.
4. **Adaptors**: a small set of protocol adaptors (OpenAI-compatible, Anthropic, Gemini) covers
   VENOM's providers. new-api's 45 adaptors are mostly long-tail Chinese and legacy platforms.
5. **Billing (brief)**: bill customers per virtual model at one retail price per plan. Use either
   a flat subscription with a periodic quota, or a $/1M rate per profile. Keep new-api's good idea:
   reserve, then settle, then refund on failure, with an idempotent session per request. Skip its
   ratio stack. Reserve prompt plus an output estimate. Do not let prepaid balances go negative.
6. **Users and tokens**: hash user tokens (show once), and add per-token rate limits and optional IP
   allowlists. Subscriptions map to allowed profiles plus a quota reset period, like new-api's
   `SubscriptionPlan`, minus the group juggling.
7. **Deployment**: one config database (Postgres), Redis for hot state, a separate log store. The
   desktop admin can either write to the hosted database through an admin API or publish signed
   snapshots. Choose one before the relay is built, because it decides whether phase-1 tables are
   local-only or replicated.

### Open questions for the owner

- Should the hosted relay read the desktop's data **live** (admin API into a server database), or
  receive **published snapshots** (desktop computes and uploads the roster)? This decides whether
  phase-1 ids must be globally unique (UUIDs) and whether benchmark runs are uploaded.
- Will benchmarks keep running only from the owner's machine? If so, evidence is measured from one
  network location, and hosted latency may differ. The relay's live telemetry should then take over
  speed and reliability, with the desktop keeping quality.
- Pricing unit for customers: flat subscription quota per period, or metered $/1M per profile?
  This decides whether the log needs retail cost next to upstream cost.
