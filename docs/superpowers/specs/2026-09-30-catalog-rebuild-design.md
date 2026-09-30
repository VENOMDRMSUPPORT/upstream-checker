# Catalog rebuild — reference-matched model facts, benchmark removed

Status: design, awaiting owner review. Date: 2026-09-30 (revised same day after the owner
settled the Fetch-information cost question — §6, §10).
Reference: `E:\01-Projects\ven-catalog\docs\catalog-models.md` (the old app's catalog plane,
read at commit `a7e0bac`). "1:1" below means: same sources, same merge, same keys, same
scoring, same rank, same snapshot rules as that document, section numbers `ref §N`.

## 1. Goal

A model a provider lists appears in the app with context, output limit, modalities,
capabilities, prices, score and rank — in the same step that fetches it, spending no tokens.
Nothing on the Models page spends output tokens except the two actions that are meant to
converse with the model: the per-row Health check (one minimal request, 24-token cap) and Chat.
Fetch information, the background sync and the page itself are all free.

Out of scope for this phase (built later, from scratch): the Venom Lite / Pro / Max
profiles, the notification bell and its store.

## 2. What is removed

Every site below was read out of the working tree on 2026-09-30; the line numbers are the
current ones. The first draft of this section listed the removals by concept — the owner's
brief is "delete anything extra", so the inventory is now complete rather than indicative.

| removed | where |
|---|---|
| the benchmark suite, tiers, IQ, category scores, TTFT/TPS probes | `src/renderer/benchmark.js` (984 lines, whole file) + its `<script>` tag |
| capability probes (tools / json / long-context) | `catalog.js` `probeCaps`/`capsRunning` 441-462, `capsStale` 356-361, `capsBadges` 998-1006, `readinessPanelHTML` cap lines 1172-1186 |
| auto-bench queue and its setting | `catalog.js` `enqueue`/`dequeue`/`pump` 371-437, `state.queue`/`running`/`abort`/`progress` 30-33, `benchmarkable` 367, `settings.catalogAutoBench` 296/1475/1546; `app.js` default + comment 177-181; `db/repos/settings.js` column; `scripts/live/fixture.mjs:64` |
| benchmark-derived facts | `catalog.js` `stability` 348-354, the bench branch of `reliability` 330-336, `ranked` 882-890, `validity` 869-878 |
| Artificial Analysis key, live leaderboard, bundled snapshot, `matchGlobal` | `catalog.js` 792-878 + `globalCell` 1016-1027 + `globalPanelHTML` 1200-1227 + Settings rows 1480-1564 and `#btn-catalog-clear-bench` 1565-1572; `src/renderer/data/leaderboard-snapshot.js` (whole file, `capturedAt 2026-09-25`); `aaApiKey` in `app.js` 182/301/4276, `db/repos/secrets.js:8` `SECRET_ORIGINS` (replaced by `openRouterApiKey` → `https://openrouter.ai`), `db/repos/settings.js:26-30` (the `delete merged.aaApiKey` guard), `db/ipc.js:15-16` (the masked hint), `scripts/check-import-counts.js:67` |
| routing profiles page, chips, dots, export | `src/renderer/profiles.js` (670 lines, whole file), `index.html` `page-profiles` 334 + nav item 105, `catalog.js` `profileDots` 974-978 and the Profiles line in the readiness panel 1191, `app.js` 1005/4372/5917 |
| catalog columns Tier, IQ, Reason, Code, Instruct, Arabic, TTFT, Tok/s, Global, Run | Models table `rowHTML` 1054-1082, `renderResults` thead 1322-1331, `TOOLBAR.filters`/`sorts` 915-935 |
| model columns `bench_json`, `history_json`, `bench_error`, `caps_json`, `caps_error` | `src/db/migrations.js` 69-73 (new migration drops them), `db/repos/catalog.js` `COLUMN_FIELDS` 13, `HASH_COLUMNS` 15 |
| `catalog_meta` keys `leaderboard`, `leaderboardError`, `profiles` | `db/repos/catalog.js` `META_KEYS` 14 + the migration that clears the table |
| log sources that no longer exist | `src/logs/recorder.js:15` — `'benchmark'` and `'leaderboard'` leave the `SOURCES` set |
| benchmark-only CSS | `styles.css` `--profile-*` 77-79 and 2354-2356, the Venom Profiles block from 7043, and `.mc-tier` / `.mc-cat` / `.mc-items` / `.mc-breakdown` / `.mc-metric` / `.mc-hist` / `.mc-agree*` / `.pf-*` rules |

Tests that assert on the removed names and must be rewritten or deleted, not left failing:
`test/db/settings-secrets.test.js` (built around `aaApiKey` — repoints its whole file to the
`openRouterApiKey` secret rather than losing coverage), `test/db/catalog.test.js:120`
(`profiles` meta), `test/db/ipc.test.js` 49/103, `test/db/import-json.test.js:116`,
`test/logs/query.test.js` 53/58/252/255/260/532, `test/logs/recorder.test.js` 88-91/174,
`scripts/check-import-counts.js:67`, `scripts/live/verify-db.mjs` 48/116.

Verified safe to delete: `window.PROFILES` has exactly four consumers (`app.js` 1005/4372/5917,
`catalog.js` 975/1178) and **nothing at request time routes through it** — the profiles are a
ranking surface over the pool, so removing the page removes no routing behaviour. Route Test
(`app.js` `testModel` / `runTests`, key rotation, 429 cooldown, quota-spent, entitlement denial)
is the router plane and stays exactly as it is.

## 3. Architecture

The catalog moves to the main process, as in the old app. The renderer keeps provider
adapters (they own discovery and auth) and hands their output to main.

```
src/catalog/                 main process, ported from ven-catalog/lib
  fetch.js      fetchJson: one retry after 400 ms; fetchJsonCached: 60 s URL dedup   (ref §2.1)
  sources.js    models-dev-spec, openrouter-public, openrouter-keyed, lmarena         (ref §2)
                disk cache <userData>/catalog-cache/<id>.json + .meta.json; a failed
                refresh updates meta only, last-good payload survives restart        (ref §2.2)
  keys.js       identity keys, PRICING/QUALITY modifiers, buildTag, compareBuilds,
                bareModelKey, nameKeyIsSafe, looseArenaKey                          (ref §7)
  build.js      buildCatalog: index → OpenRouter primary rows → orphan models.dev rows
                → proven non-text drop → collapseListings → applyLmarena
                → assignScores → assignDenseRank                                    (ref §3, §4)
  scoring.js    fitLinear, fitSpec, assignScores, assignDenseRank, buildMatchIndex,
                lookupCatalogRow, attachScores, fillFromCatalog                     (ref §5, §6, §7)
  provider-row.js  one adapter model → the shared row shape                         (§4 below)
  snapshot.js   syncSnapshot: quarantine, windows, moved, tombstones               (ref §10)
  engine.js     holds the in-memory reference { rows, byId, fits, nonTextIndex };
                loadCache at boot, syncAll on demand, scoreRows(rows)
  ipc.js        the IPC surface in §6
```

The reference catalog is **never persisted**: it is rebuilt in memory from the four cached
payloads at boot (~210 ms in the old app) and after every source sync.

`OPENROUTER_API_KEY` is optional and stored through the existing `secrets` repo. Without it
`openrouter-keyed` is skipped: fewer measured scores, more estimated, nothing breaks.

## 4. The provider row

Every adapter's output is mapped by `provider-row.js` to the old `modelsDevRow` shape
(ref §8.1):

`id, name, description, family, context_tokens, output_tokens, input_modalities,
output_modalities, tools, reasoning, structured, attachment, cost_in_per_m, cost_out_per_m,
cost_kind, release_date, status`, plus optional `match_ids`, `quality_proxy_ids`.

Rules:

- Unknown stays `null` (or `""` for modality/date strings). An absent `hasVision` is not
  `false` — today's `!!m.hasVision` is replaced.
- The current readers move here unchanged in what they accept: `readPricing` (8 shapes),
  `readsTools`, `readContextWindow`, `readsVision`, `readsReasoning`, max-output fields.
- A negative published price is read as `null` (fixes ref §16.4).
- `output_modalities` is collapsed across listings and is fillable from the reference
  (fixes ref §16.6).

## 5. Storage

SQLite, not JSON files. One migration:

- clears `models`, `model_keys`, `catalog_meta` (the catalog starts empty and is rewritten
  by the next fetch); `providers`, `provider_keys`, `secrets`, `settings`, the logs database
  are untouched;
- drops the five bench/caps columns and adds `health_json TEXT`;
- adds `snapshot_meta` (`provider_id PK, created_at, fetched_at, last_sync_json,
  pending_drop_json`) for the fields ref §10 kept at file level.

A `models` row is the snapshot entry (ref §10): `first_seen` never rewritten, `last_seen`,
`removed_at` tombstone kept, `is_new`. `summary_json` holds the provider's own facts only —
derived fields (`score, score_source, score_basis, rank, catalog_rank, matched_id, bench_id,
aa_*, lmarena_*, score_proxy_for, filled_from_catalog`) are stripped on write and recomputed
on every read against today's reference (ref §10 `providerRowSnapshot`).

`health_json`: `{ status, note, httpStatus, at, latencies: [{ at, ms }] }`, the last 20
latencies, newest last. Read as `{ p50, samples }` — the shape the future profiles consume.

The migration is tested against a scratch data folder. It runs on the owner's data folder
only after the owner says so in a message.

## 6. Flows

| action | where | does |
|---|---|---|
| **Fetch models** | Route Test page | adapter roster (every key, unioned) → `catalog:ingest(providerId, rows)` → main maps rows, drops non-text, validates, `scoreRows`, `syncSnapshot`, writes, returns scored rows + `changes` |
| **Test Selected** | Route Test page | Fetch models as above, then the existing test run; each finished model's pass/fail and time feed `catalog:health` |
| background sync | timer, `catalogSyncMinutes` (existing) | same ingest per connected provider; then, if any row is unscored and not in `unscorable`, `syncAll` sources (ref §11 step 7) |
| ❤️ **Health** | Models row | existing `healthRequestBody` + `readHealth`; result and latency go to `catalog:health(key, result)` |
| 🔄 **Fetch information** | Models row | re-read this model from the sources: `syncAll` only when the newest stored source payload is older than `SOURCE_SYNC_MIN_AGE_MS` (15 min), otherwise rebuild the reference from the disk cache — then re-ingest that provider, compare the row before/after, and report one of: `Matched, no changes` · `Updated: <field> <old> → <new> …` · `No match in sources` · `No longer listed by <provider>` |
| 💬 **Chat** | Models row | unchanged; its `benchmarkable(e)` guard becomes "kind is chat" |

**Why the Fetch-information button carries a TTL.** The four source payloads cost one
4.9 MB `models.dev/api.json`, a 458-row OpenRouter `/models`, a 1 562-entry `/benchmarks`, and
two LMArena boards paged to 800 rows — roughly five MB and eight HTTP calls; the merge itself is
only ~210 ms (§3). A forced re-download on every row click buys nothing over a merge from a
payload fetched seconds ago, and clicking across ten rows would trip models.dev's own rate
limits. The owner settled this: the button always re-reads the model against the reference and
always reports the diff, but the network pass happens only when the payloads are older than
15 minutes. `SOURCE_SYNC_MIN_AGE_MS` is one named constant in `src/catalog/engine.js`, not a
Settings row. The toolbar sync button and the background timer are unaffected by the TTL: they
call `syncAll` with `force`.

IPC (`src/catalog/ipc.js`, registered in `main.js` beside the db IPC):
`catalog:read` → scored rows for connected providers; `catalog:ingest`; `catalog:health`;
`catalog:fetch-info`; `catalog:sources` → per-source `fetchedAt / lastAttemptAt / error /
stale / rowCount` + fits. The old `read-catalog` / `write-catalog` whole-document channels
are removed.

`syncSnapshot` is a single flight per provider (ref §9 `refresh`), so the timer, a Fetch
models click and a Fetch information click overlapping cost one upstream fetch, one snapshot
write, one diff, at most one toast (ref §9 step at `providers/index.js:545-556`).

## 7. Models page

Columns: `# · Model / Provider · Score · Context · Output · In / Out $/M · Caps · Latency p50
· Health · actions`.

- `#` is the dense rank over the merged, connected view (ref §6).
- Score tooltip: `measured (AA)`, `estimated from <basis>`, or `proxy of <id>`; `Unrated`
  when nothing matched — never guessed.
- A field borrowed from the reference is marked and its tooltip says so.
- `NEW` badge on `is_new` rows (7 days), `title="First seen <time>"`.
- The detail drawer shows `matched_id`, `catalog_rank`, `bench_id`, LMArena rank, sources.
- Settings: an OpenRouter key row and a sources status block (replacing the AA rows).
- The row's `Run` column is gone: no per-row benchmark button survives (§2).

### The three actions on every row

Order is health · fetch information · chat, the order the owner listed them in. (Today's code
renders chat · health · refresh — `catalog.js` `actionButtons` 1029-1045 — so this is a
re-order plus a rename, not three new buttons. If the owner's screenshot says otherwise, the
order is a one-line change in that function.) All three stay `dt-icon-btn`, and each keeps a
spinner in place of its icon while in flight.

| button | title attribute | what it does | what it writes |
|---|---|---|---|
| ❤️ Health | `Health check — one minimal request, smart about 200-OK replies that actually say there's no credit` | unchanged `healthRequestBody` + `readHealth` (§6) | `health_json`: the verdict plus one more latency sample |
| 🔄 Fetch information | `Fetch this model's facts from the sources and tell me what changed` | §6 fetch-info flow, TTL and all | the row's provider facts only when the provider re-published them; score/rank are never stored (§5) |
| 💬 Chat | `Chat with this model` | opens `#mc-chat-drawer`, unchanged | nothing — the drawer writes no catalog row, no run, no log evidence (§6 note in `catalog.js` 40-49) |

Non-chat kinds (`image`, `video`, `decision`, anything `classifyModel` marks) keep only Fetch
information, exactly as `actionButtons` restricts today; the gate moves from `benchmarkable(e)`
to `e.kind === 'chat'`.

## 8. Failure semantics (ref §10, §16 carried over)

- One source fails: others still store; its last-good payload stays, marked stale.
- A provider fetch fails: last-good rows served stale; history not mutated.
- Mass drop (`≥5 → <half`, losing `≥3`): quarantined until the same set is seen 3 times over
  6 h; last-good rows served meanwhile.
- A model filtered as non-text is forgotten, not tombstoned.
- A returning model keeps its original `first_seen` and is not flagged new again.

## 9. Testing

- Port from ven-catalog: `keys`, `scoring`, `catalog` (build), snapshot tests; fixtures are
  trimmed copies of the four cached payloads, no network.
- New: `provider-row` mapping (every reader shape, null-not-false, negative price),
  migration (clears catalog, keeps providers/keys), ingest/health IPC.
- Removed: bench/caps assertions in `test/db/catalog.test.js`, `test/db/import-json.test.js`.
- `npm test`, `npm run check`, then `npm run verify:live` (mock provider only — it proves
  wiring, not real providers).
- Owner-visible check: in their own app, Fetch models on a connected provider and see
  scores, context and prices appear on the Models page.

## 10. Open items settled

- Latency history: last 20 readings, shown as p50 with the sample count.
- Profiles: removed now, rebuilt from scratch in a later phase.
- Notifications: none this phase; `changes` is returned from ingest and surfaced as a toast
  ("3 new · 1 removed") and the `NEW` badge.
- Fetch-information cost: the sources are re-downloaded only when the newest payload is older
  than 15 minutes; otherwise the click merges from the disk cache and still reports the diff.
  Owner's choice, 2026-09-30, from three options (always force / TTL / never touch the network).

## 11. Constants

Carried from the reference (ref §14) unless marked **new**. One place each; a rebuild that
moves one of these has to explain why.

| value | where in this app |
|---|---|
| fetch timeout 20 000 ms, Settings bounds 1 000-300 000 | `src/catalog/env.js` |
| one retry after 400 ms, on any failure | `src/catalog/fetch.js` (ref `lib/fetch.js:14`) |
| `fetchJsonCached` TTL 60 000 ms | `src/catalog/fetch.js` |
| `NEW_WINDOW_DAYS = 7`, `REMOVED_WINDOW_DAYS = 30` | `src/catalog/snapshot.js` |
| mass-drop quarantine: `≥5 → <half` losing `≥3`, 3 attempts, 6 h | `src/catalog/snapshot.js` |
| `MIN_FIT_SAMPLES = 30`, `MIN_FIT_R2 = 0.3`, spec needs 90, `SPEC_AGE_CAP_MONTHS = 36` | `src/catalog/scoring.js` |
| score ceiling `1.1 × highest measured` | `src/catalog/scoring.js` |
| `MIN_BARE_KEY_TOKENS = 2` | `src/catalog/keys.js` |
| background sync cadence — the existing `catalogSyncMinutes`, default 5 min | `catalog.js` `scheduleTimer` (replaces ref's `PROVIDER_POLL_MINUTES = 30`) |
| `SOURCE_SYNC_MIN_AGE_MS = 15 min` | **new** — `src/catalog/engine.js`, gates the Fetch-information network pass (§6) |
| `LATENCY_SAMPLES_KEPT = 20` | **new** — `health_json` ring, §5 |
| `REMOVED_KEEP_MS` — today 14 days (`catalog.js:18`) | **changed to tombstone-forever**, per ref §10 ("tombstones kept forever"); the 14-day purge is what loses `first_seen` |

## 12. Working tree and sequencing

The tree is dirty with unrelated work: a Database Explorer page (`src/db/explorer.js`,
`src/renderer/database.js`, `test/db/explorer.test.js`, plus edits to `main.js`, `preload.js`,
`db/ipc.js`, `index.html`, `styles.css`, `app.js`, `scripts/live/verify-db.mjs`), and untracked
`_proxy.mjs` and `.opencode/`. It collides with this build on exactly the files that are
hardest to re-merge — `main.js` IPC registration, `index.html` nav + script order, and the tail
of `styles.css`.

So: commit or otherwise settle the explorer work first, then start this on a branch in this
folder (never a worktree — CLAUDE.md). Within the branch, the order is the reference's own
rebuild order (ref §15): fetch layer → source cache → `keys.js` → `buildCatalog` → scores and
rank → provider rows → `attachScores` → `syncSnapshot` → engine → IPC and the page → deletion
pass (§2) last, so nothing is deleted while its replacement is still untested. The §5 migration
that empties the catalog runs against a scratch data folder only until the owner says
otherwise for their own.

This is one spec but two implementation plans, split at the point where the app first runs
both ways:

- **Plan A — the engine (§3-§6, §8, §11).** `src/catalog/*` in main, the §5 migration, the
  five new IPC channels, ports of `keys`/`scoring`/`catalog`/`snapshot` tests. Green when
  `npm test` passes with the new suite and the old page still works untouched.
- **Plan B — the page and the deletion pass (§2, §7, §9).** Models page columns and the three
  buttons, Fetch models / Test Selected ingest on the Route Test page, then every removal in §2
  with its tests and CSS. Green when `npm run check` and `npm run verify:live` pass and the
  owner can point at a scored row in their own app.

Nothing in Plan A is thrown away by Plan B, and Plan A is reviewable on its own — which is the
reason for the split, not size.
