# Handoff — VENOM Router catalog engine (Plan A done, Plan B not started)

Written 2026-10-01 02:00 for the agent continuing this work. Read this file, then
[AGENTS.md](../AGENTS.md), [CLAUDE.md](../../CLAUDE.md), and the two documents the plan rests on:

- Spec (the authority the plan argues from): [2026-09-30-catalog-rebuild-design.md](2026-09-30-catalog-rebuild-design.md)
- Plan (12 tasks, this file follows its numbering): [2026-09-30-catalog-engine-in-main.md](2026-09-30-catalog-engine-in-main.md)
- Behaviour being reproduced: `E:\01-Projects\ven-catalog\docs\catalog-models.md`, cited `ref §N`.
  The reference app's source (`lib/`, `providers/index.js`) is the port's source of truth.
- Recovery ledger with every review finding, ruling and deferred minor:
  `.superpowers/sdd/2026-09-30-catalog-engine-in-main/progress.md` (git-ignored; read it before ruling
  on anything yourself).

## 0. Where the tree is

| | |
| --- | --- |
| Branch | `feat/catalog-engine`, 18 commits ahead of `main`. `main` is untouched. |
| HEAD | `8b8e80b` — `fix(catalog): make the engine's answers survive the IPC boundary` |
| Tests | `npm run check` → **559 pass / 0 fail** (was 299 at branch start). `npm run verify:live` → `ALL LIVE CHECKS PASSED` (mock provider). `npm run verify:catalog` → `ALL CATALOG BOOT CHECKS PASSED` (new gate, see §2). |
| Pushed | **Nothing.** No push, no release, no tag. |
| Owner's data folder | `%APPDATA%\venom-router\venom.db` did **not exist** as of the last check, so migration v2 has never run against it. |

### STOP AND LOOK BEFORE YOU DO ANYTHING: there is an unexplained diff in the working tree

```
 M docs/CODE_MAP.md
 M src/renderer/app.js       (+11 -3)
 M src/renderer/catalog.js   (+27 -1)
 M src/renderer/styles.css   (+12 -5)
```

Provenance is **not established**. The fixer that produced `8b8e80b` reported that "another agent is
editing `app.js`/`catalog.js`/`styles.css` in this same checkout; I staged only my hunks, so
`catalog.js` work is excluded and left uncommitted." No Plan-B dispatch was ever made from this
session, so those hunks are either a stray worker's partial edit or the owner's own. **Inspect
`git diff` on all three, decide deliberately, and do not sweep them into a commit and do not discard
them without reading them.** If they turn out to be the owner's, ask before touching that area again.

## 1. What the owner actually asked for (the origin of this work)

From the first message, still the definition of done:

1. Reproduce the old app's catalog style **1:1** — same sources, merge, identity keys, score, rank,
   snapshot rules.
2. **Delete the benchmark system entirely.**
3. The model testing page should **fetch information and update the catalog in the same step as
   testing** — so the catalog starts empty and is rebuilt by fetch + test.
4. Three buttons on each model row: **health** (status + latency), **fetch information** (re-read from
   the sources even if data exists, and answer *identical* or *here is what changed*), **chat**.

Items 1 and (partly) 3 are done underneath. **Items 2, 3 and 4 are not visible in the app at all
yet.** The owner stopped the previous run precisely because 3.5 hours produced nothing they could
see; sequencing is a deliverable, not a detail. See §4.

## 2. What is done — plan Tasks 1-11

Everything below is committed, reviewed by a separate reviewer agent, and covered by tests.

**The engine, `src/catalog/`, main-process CommonJS.** Verbatim ports of the reference (byte-identical,
verified with `git diff --no-index` and raw blob hashes): `util.js`, `keys.js`, `scoring.js`,
`build.js` (= reference `lib/catalog.js`), `atomic.js`. Rewritten because the reference was entangled
with that app's `env.js`/`reachability.js`/`verdict.js`: `fetch.js` (injectable transport, one retry
after 400 ms, 60 s URL dedup), `sources.js` (`createSources({cacheDir, fetcher, readKey})`),
`engine.js` (`createEngine`, `SOURCE_SYNC_MIN_AGE_MS = 15 min`), `snapshot.js` (windows, `moved`,
tombstones, quarantine — storage behind a `store` seam), `row.js` (adapter model → the 17-field
ref §8.1 row), `ipc.js` (five channels).

**Storage.** Migration `version: 2`, **additive only**: `snapshot_meta` (provider-level: `created_at`,
`fetched_at`, `last_sync_json`, `pending_drop_json`) and `roster_snapshot` (per provider+model:
`name`, `first_seen`, `last_seen`, `removed_at`, `summary_json`, `health_json`). `src/db/repos/snapshots.js`
assembles the reference's whole-snapshot object across the two tables in one transaction.
`SECRET_ORIGINS` gained `openRouterApiKey` (without it `secrets.save` throws `Unknown secret`).

**Wiring.** `startCatalog({repos, log})` in `src/main.js`, called strictly after `registerDataIpc` /
`registerLogsIpc` and before the window. Five `preload.js` entries. Boot is unchanged otherwise — a
reviewer diffed it. `npm run verify:catalog` + `scripts/live/boot-guard.cjs` prove no network at boot
(0 blocked attempts; 8 on an explicit forced sync as positive control) and that `catalog-cache/` is
created only on the click.

**Owner-visible today:** Settings › Catalog has a **Sources** row and a **Sync sources** button. A real
keyless fetch on this machine produced: models.dev **8 337**, OpenRouter models **464**, LMArena
**544**, merged reference **3 360**, OpenRouter benchmarks reporting its own missing key. Measured
visible in both themes (`vercel` / `daylight`).

**Three real bugs the port fixed rather than inherited** (each pinned by a test):
- `ref §16.4` OpenRouter's `-1` price sentinel became `-1 000 000` and could be *borrowed* by a thin
  provider row; and the first fix destroyed a *good* fallback price — now the fallback survives.
- `ref §16.6` `output_modalities` was neither collapsed across listings nor fillable — both fixed, so
  nexum-style rows with byte-identical metadata can learn their output modality.
- `engine.js`'s error-stub cache branch declared four of the six source fields, so a source cached in
  an error state never reported itself stale. All six now always present.
Plus: `unscorable` was being wiped on every scored sync (would have re-downloaded ~5 MB after every
5-minute background pass); and `row.js` read the renderer's coerced `hasReasoning:false` as a published
refusal, which `fillFromCatalog` then could never repair.

## 3. IPC contract the next batch must be written against

Established in `8b8e80b`, and the reason it matters is that **`err.code` does not survive Electron's
`ipcMain.handle` boundary** (only the message crosses, prefixed with
`Error invoking remote method '…': `).

- Every catalog channel **resolves**. Actionable outcomes are `{ ok: false, code, message }` —
  `NOT_FOUND`, `INVALID_PROVIDER_PAYLOAD`, `SUSPICIOUS_PROVIDER_DROP`, `SYNC_IN_PROGRESS`,
  `NO_SNAPSHOT`. Test `reply.ok === false`; do not `catch`. Only programmer errors reject.
- `catalog:read({ providerIds })` — the renderer passes the connected set (it owns `PROVIDERS` /
  `isConnected`; the reference filtered `readConnected` by `connections.connectedIds`). Absent/empty is
  **not** "everything". Answers `providers: [{ providerId, ok, code, total, fetchedAt, stale,
  lastSyncAt, warning }]`, and `rows` ranked **densely over the merged view** (one `scoreRows` call
  after merging, not per provider).
- `catalog:fetch-info` diffs **only provider-published fields**, computed on the freshly-mapped row
  *before* scoring/filling, so a catalog borrow can never read as an "update"; the reference
  provenance is reported separately as `borrowed`. Outcomes: `matched` / `updated` / `no-match` /
  `no-longer-listed`.
- `catalog:sources({ force })` — non-forced returns `engine.summary()` (no download); forced runs
  `syncAll`. This matches `ref §9`'s split of `GET /api/sources` from `POST /api/sync`.
- `catalog:health` appends one latency sample to a 20-deep ring, writes only `health_json` +
  `updated_at`, answers `{ p50, samples }`.
- `catalog:ingest(providerId, rows)` — per-provider single-flight door; merges adapter `match_ids`
  with generated ones (adapter first) and sets `quality_proxy_ids` when the adapter declared none.
  Those fields must survive into `summary_json` or a fallback row loses its only match.

## 4. What remains — and in what order

**Do Plan B as one coherent unit.** The clearing migration and the page switch cannot ship apart: a
clearing with no reader leaves the page permanently empty, and a reader without the clearing leaves
two writers on the `models` table. That is also why Plan A's sequencing drew the owner's complaint —
do not repeat it: finish §4.1-§4.3 in one pass and let the owner run `npm start` on it.

### 4.1 Migration v3 + retire the legacy store (spec §2, §5, §12)
- Clear `models`, `model_keys`, `catalog_meta`; drop `bench_json`, `history_json`, `bench_error`,
  `caps_json`, `caps_error`. Keep `providers`, `provider_keys`, `secrets`, `settings`, and the logs DB.
- Delete `read-catalog` / `write-catalog` (`src/db/ipc.js:77-82`), their two `preload` entries, and
  `src/db/repos/catalog.js` entirely.
- Tests to update, not delete: `test/db/catalog.test.js`, `test/db/import-json.test.js`,
  `test/db/ipc.test.js` (channel list), `scripts/check-import-counts.js`, `scripts/live/fixture.mjs`,
  `scripts/live/verify-db.mjs`.

### 4.2 The Models page reads the engine (spec §7)
- Columns `# · Model / Provider · Score · Context · Output · In / Out $/M · Caps · Latency p50 ·
  Health · actions`; score tooltip says `measured (AA)` / `estimated from <basis>` / `proxy of <id>`,
  `Unrated` when nothing matched; a borrowed field is marked and its tooltip says so; `NEW` badge with
  `title="First seen <time>"`.
- Discovery → `catalog:ingest` replaces the old `writeCatalog` path; `catalog:read({providerIds})`
  replaces `state.data.models`.
- **The three buttons**, ordered health · fetch information · chat (the owner's order; today's code
  renders chat · health · refresh in `catalog.js` `actionButtons`). The refresh button becomes Fetch
  information and must show the `matched` / `Updated: field old → new` answer, and must fail loudly
  like the Settings button does.
- Route Test: `Fetch models` and `Test Selected` ingest first, then run — item 3 of §1.
- Non-chat kinds keep only Fetch information; the gate changes from `benchmarkable(e)` to
  `e.kind === 'chat'`.

### 4.3 The removal pass (spec §2 — the full table there is the inventory, with line numbers)
`src/renderer/benchmark.js`, `src/renderer/profiles.js`, `src/renderer/data/leaderboard-snapshot.js`,
the auto-bench queue and `catalogAutoBench`, `aaApiKey` end to end, `window.PROFILES`'s four consumers
(`app.js:1005/4372/5917`, `catalog.js:975/1178` — verified nothing routes at request time through it),
`logs/recorder.js:15`'s `'benchmark'` and `'leaderboard'` sources, `--profile-*` tokens and the
benchmark-only CSS, `test/db/settings-secrets.test.js` repointed to `openRouterApiKey`,
`test/logs/{query,recorder}.test.js`.

### 4.4 Plan Task 12 — the map and the entry-point docs
`npm run repo:map`, then: `docs/ARCHITECTURE.md` says 38 channels (it is 43+, and §6 needs a
`catalog:*` row and §2 a step for `startCatalog`), §3 needs the two new tables and `catalog-cache/`,
§7's renderer load order changes when `benchmark.js`/`profiles.js` go; `AGENTS.md:49` says preload has
48 entries (53), and its 295-test figure is long stale. `CHANGELOG.md` under Unreleased — and say there
that the Models page still ran the legacy path until §4.2 landed, so nobody reads the engine as shipped
routing.

### 4.5 Final whole-branch review, then integration
Range to review: `git merge-base main HEAD`..HEAD. Point it at the ledger's parked/minor lines. Then
`finishing-a-development-branch` — and a **merge and any push need the owner's explicit word**, as does
`npm run release`, which cannot be undone.

## 5. Known-unclosed items (do not rediscover these)

- **Unverified:** the `keyedAuthConfigured: true` path (no OpenRouter key has ever been saved through
  this code), and ingest / health / fetch-info driven from the UI — nothing consumes them yet.
- `verify-catalog-boot.mjs`'s first `app.evaluate` has no retry and can fail spuriously (the dev
  live-reload watcher reloads the window). The gate flakes red, not green.
- `scripts/live/cdp.mjs:28` sets `NODE_ENV=development`, which suppresses the updater's 5 s check — so
  "0 blocked attempts at boot" proves the catalog plane is silent, not the whole app.
- Dead surface, triage or delete: `withAliases`, `appendLatency`, `LATENCY_SAMPLES_KEPT` exports;
  `catalogEngine` assigned and never read in `main.js:152`; `repos.settings.get('settings')?.fetchTimeoutMs`
  reads a setting that exists nowhere.
- `catalog.js`'s legacy page still counts its own pool while Settings says "3 360 models in the
  reference". Two numbers, no explanation — fixed by §4.2, do not "fix" it with copy first.
- Reference's age-based re-check of `unscorable` (`poller.js:136-140`) is deliberately **not** ported.
- `sources.hasPayload()` checks only the data file while `readCache` needs both — never use it as
  "cache usable".
- The notifications bell and the Venom Lite/Pro/Max profiles are **out of scope for this phase** and
  will be rebuilt from scratch later (spec §1, §10).

## 6. Non-negotiables for whoever continues

- **One checkout. Never `git worktree add`.** Work on a branch in this folder.
- **Never launch the app against `%APPDATA%\venom-router` to test.** Scratch `--user-data-dir` only;
  `scripts/live/cdp.mjs` enforces it. A scratch run starts with no providers and an empty database —
  that is expected, and worth saying out loud so it does not read as damage.
- **Never change `npm start`, the resolved data folder, or launch behaviour** without asking in the
  same message.
- Never decrypt, print, copy or move stored keys. Every outbound request originates in main; the
  renderer holds `venomkey:` / `venomsecret:` placeholders only.
- `npm run check` before claiming anything is done. `textContent` proves text exists, not that a person
  can see it — **measure geometry**, and check light and dark.
- Migrations are append-only; a shipped entry is never edited.
- Show the owner something clickable early. It is a project rule in `CLAUDE.md` and it is the reason
  the last run was stopped.
- Ask before pushing. `npm run release` only on the owner's explicit word in that message.
