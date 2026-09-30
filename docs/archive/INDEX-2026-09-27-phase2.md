# Phase 2 index — historical

> **This tracker was written on 2026-09-27 and is kept only as a record of how
> the work was planned.** It is no longer current: phases B and C (the logging
> system and the log pages) were merged, and the app shipped as **2.0.0**.
>
> For the live state use, in this order:
> 1. [CHANGELOG.md](../../CHANGELOG.md) — what shipped, per version
> 2. `git log --oneline` — what actually happened
> 3. [ARCHITECTURE.md](../ARCHITECTURE.md) — how it works today
> 4. [COOKBOOK.md](../COOKBOOK.md) — how to change it
>
> Nothing here is edited again. `docs/index.html` is the browsable copy of this
> same stale page.

---

# VENOM Router — Phase 2 Index

Status date: 2026-09-27 · Tracks the open work only: what is built but not merged,
and what has not started. Finished-and-merged work is summarised in one line and
lives in `CHANGELOG.md`.

Legend: `[x]` done · `[ ]` open · `[~]` done but blocked on a gate

```
0% ░░░░░░░░░░░░░░░░░░░░ 100%
```

---

## Roll-up

| Phase | State | Progress |
|---|---|---|
| A — Local database | merged to `main` | `████████████████████` 100% |
| B — Logging system | built, waiting at the merge gate | `████████████████████` 100% |
| C — Log pages | not started | `░░░░░░░░░░░░░░░░░░░░` 0% |
| M — Merge gate (B+C) | blocked by C | `░░░░░░░░░░░░░░░░░░░░` 0% |
| R — Release | not started | `░░░░░░░░░░░░░░░░░░░░` 0% |

26 of 64 steps done overall (41%). A is merged (`16b9f89`), 133 tests green on `main`.
A browsable version of this page: `docs/index.html`.

---

## Phase B — Logging system · `████████████████████` 100% (held at the gate)

Branch `feat/logging-system`, worktree `C:\Users\venom\Desktop\venom-router-logging`.
37 commits ahead of `main`, tree clean, 268/268 tests green.
Plan: `docs/superpowers/plans/2026-09-26-logging-system.md` (on the branch).
Owner decision: **B merges to `main` only together with C.**

### B.1 — Log database layer (`src/logs`) · `████████████████████` 100%
- [x] Task 1 — schema v1, log settings, test helpers
- [x] Task 2 — `classify.js`: endpoint, model, usage, cost, status
- [x] Task 3 — `scrub.js`: substituted secrets out of stored text
- [x] Task 4 — `writer.js`: batched writes, roll-ups, dropped counter
- [x] Task 5 — `retention.js`: chunked purge, stepped vacuum, scheduler
- [x] Task 6 — `query.js`: list, get, stats, facets, run summary, export, info, clear
- [x] Task 7 — `index.js`: open, pragmas, migrate, tryOpen, close
- [x] Task 8 — `logs/ipc.js`: the eight `logs-*` channels

### B.2 — Capturing every request in main · `████████████████████` 100%
- [x] Task 9 — `resolve()` reports refs and substitutions
- [x] Task 10 — history accepts the renderer's `runUid`
- [x] Task 11 — `lookups.js` and `recorder.js`: building the record
- [x] Task 12 — `src/api-request.js`: the finish-once requester
- [x] Task 13 — data IPC hooks for main-side caches
- [x] Task 14 — main wiring: requester, `startLogs`, logs IPC, quit order, smoke test, preload

### B.3 — Renderer: run ids, tags, cancel reasons, Settings · `████████████████████` 100%
- [x] Task 15 — renderer ULID helper
- [x] Task 16 — Route Test: run id, attempt, hedge, test group, trigger, cancel reasons
- [x] Task 17 — tag every other `apiRequest` call; benchmark run ids and cancel reasons
- [x] Task 18 — Settings copy, new-install default, logging-off warning, release note

### B.4 — Live check and review round · `████████████████████` 100%
- [x] Task 19 — live check of the request log on the synthetic fixture
- [x] Review fixes — SQL-side facets/sums, purge scheduler, run-id capture at mint time,
      `extractError` double-clip, bounded `requestTags`

---

## Phase C — Log pages · `░░░░░░░░░░░░░░░░░░░░` 0%

**Nothing exists yet: no spec, no plan, no branch.** Scope from
`docs/superpowers/specs/2026-09-26-local-database-design.md` §Context:
Request Log (in the "Test History" slot), Runs, Monitoring.

### C.0 — Spec and plan · `░░░░░░░░░░░░░░░░░░░░` 0%
- [ ] Brainstorm the three pages with the owner (scope, layout, defaults)
- [ ] Write `docs/superpowers/specs/2026-09-27-log-pages-design.md`
- [ ] Delegated spec review, apply required changes
- [ ] Write `docs/superpowers/plans/2026-09-27-log-pages.md` (task-per-commit)
- [ ] Branch `feat/log-pages` in its own worktree

### C.1 — Request Log page · `░░░░░░░░░░░░░░░░░░░░` 0%
- [ ] Replace the "Test History" slot with the request list (`logs-list`, keyset paging)
- [ ] Filter bar from `logs-facets`: provider, model, source, status, date range, text
- [ ] Row detail drawer from `logs-get`: timings, tokens, cost, scrubbed body
- [ ] Live tail — poll `logs-list` with `afterId`, ordered by id, **not** `nextCursor`
- [ ] Sort by latency / TTFT / cost — **needs a B-side `logs-list` addition**
- [ ] Retry-chain view keyed on `is_stream` + endpoint (non-stream and SSE-recovery
      copies share `testGroup`/`attempt`/`hedgeIndex 0`)
- [ ] Export from the current filter (`logs-export`)

### C.2 — Runs page · `░░░░░░░░░░░░░░░░░░░░` 0%
- [ ] Runs listing — **`logs-runs` does not exist yet, B-side channel needed**
- [ ] Run summary cards from `logs-run-summary`
- [ ] Add p50, median TTFT and pass rate to the summary — **B-side addition**
- [ ] Link benchmark results to their log rows through the `runId` stored in `bench_json`
- [ ] Drill from a run into its filtered Request Log view

### C.3 — Monitoring page · `░░░░░░░░░░░░░░░░░░░░` 0%
- [ ] Charts from `logs-stats` (bucket hour/day, groupBy none/source/provider/model/error_class)
- [ ] Short default ranges, or a guard — `groupBy: model` over 12 months with ~50
      combos/hour costs ~1.4 s on the main thread
- [ ] Facets beyond raw-log retention (90 d) return a null provider name — render a fallback
- [ ] Map the unknown provider consistently (`''` in roll-ups vs `NULL` in rows)

### C.4 — Settings and maintenance UI · `░░░░░░░░░░░░░░░░░░░░` 0%
- [ ] Retention settings: `logRetentionDays` 90, `bodyRetentionDays` 7, `statsRetentionMonths` 12
- [ ] `logs-clear` with a visible progress state
- [ ] `logs-info` panel: path, size, rows, oldest row, dropped rows, last purge

### C.5 — Verification · `░░░░░░░░░░░░░░░░░░░░` 0%
- [ ] Unit tests per page module
- [ ] Live check driving the real app (CDP) against the synthetic fixture
- [ ] Reviewer after each task + whole-branch review

---

## Phase M — Merge gate (B + C) · `░░░░░░░░░░░░░░░░░░░░` 0%

Owner's rule: logging and the log pages land in one merge, never separately.

- [ ] Log pages implemented and reviewed on their own branch
- [ ] Rebase `feat/logging-system` onto current `main`
- [ ] Full suite and `npm run verify:live` green on the merged tree
- [ ] Single merge of B + C into `main`
- [ ] Remove the `venom-router-logging` worktree

---

## Phase R — Release · `░░░░░░░░░░░░░░░░░░░░` 0%

`main` is 60 commits past tag `v1.4.1`; the rebrand and the database work still sit
under `[Unreleased]` in `CHANGELOG.md`. Version now comes from `package.json` only —
no hardcoded string left in `src/`.

- [ ] Fold B and C release notes into `CHANGELOG.md`
- [ ] Move `[Unreleased]` to the new version heading, dated
- [ ] Bump `version` in `package.json`, commit
- [ ] `npm test` and `npm run verify:live` green
- [ ] `npm run release` (smoke-tests the packaged build, tags, publishes, uploads)
- [ ] Confirm auto-update picks the release up

---

## Follow-ups (not blocking)

- [ ] Scrub provider-echoed keys in responses shown to the renderer (stored log text is
      already scrubbed; the reverted commit `f35d20d` is the starting point)
- [ ] Stale worktree `.kilo/worktrees/animated-barnyard` — its commit is an ancestor of
      `main`, safe to remove