# Source Structure Improvement Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve source maintainability through evidence-based cleanup and gradual feature extraction while preserving VENOM Router behavior, startup, packaging, and the current domain boundaries.

**Architecture:** Keep the existing main, catalog, database, logs, and renderer boundaries. Treat the renderer's oversized files as the main maintainability concern and reduce them in small feature-focused extractions only after mapping globals, load order, and callers. Delete assets or modules only when repository and runtime references prove they are unused.

**Tech Stack:** Electron 33, vanilla browser JavaScript/CSS/HTML, Node.js, better-sqlite3, existing npm scripts.

**Spec:** User request (2026-10-13): assess `src/` organization and prepare an implementation plan. Project constraints are in `AGENTS.md`, `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/CODE_MAP.md`, and `docs/COOKBOOK.md`.

## Global Constraints

- Work in the existing checkout; never create a worktree or second checkout.
- Preserve all pre-existing tracked and untracked work; inspect overlapping diffs before editing.
- Never run `npm start` or change startup, launch behavior, or the owner's data folder.
- Keep all outbound requests in main and all secrets out of the renderer.
- Do not delete a file based on its name, apparent duplication, or absence from the visible UI alone.
- After adding, moving, or renaming files under `src/`, regenerate `docs/CODE_MAP.md` with `npm run repo:map`.
- Do not run `npm run release`; no release was requested.

## Review Focus

- A renderer module still depends on globals or script order after extraction — verify its existing renderer tests and a scratch live check.
- A route, asset, or provider module is loaded indirectly from HTML/CSS/build configuration — include all those reference sources in the orphan audit.
- A CSS or HTML split changes cascade, selector ordering, script load order, or `file://` paths — verify the relevant page in the scratch live check.
- A moved renderer file changes relative paths or packaging inclusion — verify `npm run check` and the scratch live check.
- The checkout already contains uncommitted changes — record and preserve them; review changes to any file before editing it.

---

### Task 1: Establish the current tree and protect pending work

**Files:**
- Read: `AGENTS.md`, `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/CODE_MAP.md`, `docs/COOKBOOK.md`
- Inspect: current `git status` and diffs before touching overlapping files

- [ ] Record the current tracked/untracked file list and inspect pending diffs for every file proposed for change. Keep unrelated pending work intact.
- [ ] Compare the actual `src/` inventory with `docs/CODE_MAP.md`; use `npm run repo:map -- --check` to determine whether the map is current.
- [ ] Run `npm run check` as the pre-change gate and save its output. Do not launch the app with `npm start`.
- [ ] Produce a short reference inventory for every candidate: imports/requires, HTML script and stylesheet links, CSS `url()` references, package/build inclusion, tests, and generated-file sources.

**Accept:** The source map matches the filesystem, the existing gate result is recorded, and each candidate has a list of static/runtime reference paths. No file has been moved or deleted.

### Task 2: Remove only proven orphans

**Files:**
- Change only candidates approved by the Task 1 reference inventory
- Update: `docs/CODE_MAP.md` via `npm run repo:map` if files change
- Update: the owning tests or asset-generation script if cleanup changes their contract

- [ ] For each candidate, verify it is not referenced by source, HTML, CSS, package/build configuration, scripts, tests, docs, or generated output.
- [ ] For generated assets, check the generator and its input pack before considering removal. Keep the required Windows icon sizes and any branding/font variants with live references.
- [ ] Remove one proven orphan at a time and run `npm run check` after each coherent cleanup batch.
- [ ] Keep intentionally future-facing assets only if there is a documented owner/use; otherwise report them separately instead of deleting speculatively.

**Accept:** Every removed path has a recorded no-reference result and the repository gate passes. If none qualify, make no cleanup change and record that result.

### Task 3: Extract one renderer feature at a time

**Files:**
- Primary: `src/renderer/app.js`
- Add only feature modules justified by the dependency inventory, initially under `src/renderer/`
- Update: `src/renderer/index.html`, relevant `test/renderer/**`, and `docs/CODE_MAP.md`

- [ ] Map the globals, initialization order, and call graph for one cohesive region in `app.js`; prefer a unit with a clear owner and minimal cross-feature state.
- [ ] Select one extraction boundary and document the exact module API and script load position before moving code. Keep existing global behavior stable during the transition.
- [ ] Add or update focused behavior tests before the extraction; run the relevant renderer tests and confirm the new test fails before implementing behavior changes.
- [ ] Move only that feature, preserve DOM IDs and event behavior, and update `index.html` in the required dependency order.
- [ ] Run the focused tests, `npm run check`, then `npm run verify:live` for affected visible UI paths. The live check uses a scratch folder and mock provider; it does not verify real-provider behavior.
- [ ] Regenerate the code map and review the diff before starting another extraction.

**Accept:** Each extraction is independently reviewable, keeps the existing behavior tests passing, and the live check confirms affected UI geometry in the scratch app.

### Task 4: Reassess CSS and HTML splitting after JavaScript boundaries settle

**Files:**
- Consider only after Task 3: `src/renderer/styles.css`, `src/renderer/index.html`, `src/renderer/fonts.css`
- Update: `docs/CODE_MAP.md` and relevant live checks if files are added

- [ ] Use CSS section boundaries and page ownership to decide whether splitting improves navigation without changing cascade order. Keep one stylesheet if section-level organization is sufficient.
- [ ] For HTML, retain the single shell unless repeated page markup or script ownership provides a concrete reason to split in this no-bundler, local-file app.
- [ ] If a split is justified, preserve CSS and script order and verify all referenced paths remain packageable by the existing `src/**/*` build rule.
- [ ] Run `npm run check` and `npm run verify:live`; inspect the affected pages at their actual viewport geometry.

**Accept:** Keep the existing files when a split gives no measurable maintainability benefit. If split, the cascade, page behavior, and packaged paths remain correct.

### Task 5: Keep the architecture references accurate

**Files:**
- Update only when the implementation changes their described structure: `docs/ARCHITECTURE.md`, `docs/COOKBOOK.md`
- Regenerate: `docs/CODE_MAP.md`

- [ ] Update architecture and cookbook descriptions for any new module ownership, load-order rule, or file-location convention.
- [ ] Run `npm run repo:map` and `npm run check`.
- [ ] Summarize files moved/deleted, evidence for every deletion, behavior checks run, and any UI paths not covered.

**Accept:** Documentation matches the final source tree, generated map check passes, and the whole test suite passes.
