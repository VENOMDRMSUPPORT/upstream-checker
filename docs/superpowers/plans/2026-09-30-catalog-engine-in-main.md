# Catalog engine in the main process Implementation Plan (Plan A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the reference-matched catalog engine in Electron's main process — four upstream
sources, one merge, score and rank per model — with SQLite storage and five IPC channels, without
touching the existing Models page and without removing the benchmark yet.

**Architecture:** A port of `E:\01-Projects\ven-catalog\lib` (`fetch`, `sources`, `keys`,
`catalog`→`build`, `scoring`, `engine`) plus the snapshot logic from that app's
`providers/index.js`, into `src/catalog/`, under this repo's three-layer rule: all I/O in main,
the renderer holds only placeholders. The merged reference is never persisted; it is rebuilt in
memory from four cached payloads at boot. Provider rows are stored as the old app's `lastGoodRows`
— provider facts only, derived fields stripped on write, recomputed on every read.

**Tech Stack:** Electron 33 (Node 20 — global `fetch` available), `better-sqlite3`, CommonJS,
`node:test` + `node:assert` run through `scripts/run-tests.js`.

**Spec:** [docs/superpowers/specs/2026-09-30-catalog-rebuild-design.md](../specs/2026-09-30-catalog-rebuild-design.md)
(cited `§N`). The behaviour being reproduced is documented in
`E:\01-Projects\ven-catalog\docs\catalog-models.md` (cited `ref §N`); that file is the authority on
every constant and ordering rule below.

## Deviation from spec §12, settled before Task 1

Spec §12 promises Plan A ends with "the old page still works untouched", but spec §5 puts the
destructive migration (clear `models`, drop five columns) inside Plan A. Both cannot be true:
`src/db/repos/catalog.js:13-15` reads `bench_json`, so dropping it breaks the page Plan A promised
to leave alone. The migration is therefore split:

- **This plan, `version: 2`** — additive only: `ALTER TABLE models ADD COLUMN health_json TEXT`
  and `CREATE TABLE snapshot_meta`. Nothing dropped, nothing cleared.
- **Plan B, `version: 3`** — clears `models` / `model_keys` / `catalog_meta`, drops
  `bench_json` / `history_json` / `bench_error` / `caps_json` / `caps_error`, switches the page.

Migrations are append-only (docs/ARCHITECTURE.md §9), so splitting them is the only way to keep
both halves honest. Task 7 Step 6 asserts `bench_json` still exists, so the split is enforced by a
test rather than by this paragraph.

**Second deviation, from spec §5, found while writing Task 7.** Spec §5 says a `models` row *is*
the snapshot entry. That shape presumes the legacy writer is already gone: `src/db/repos/catalog.js`
owns the `models` table through `write-catalog`, and the Models page keeps using it until Plan B.
Two writers on one table is exactly the hazard the "one thing per channel" rule exists to prevent
(`src/db/ipc.js:3-6`), and CLAUDE.md does not allow a compatibility shim to paper over it. So in
this plan the new engine keeps its own two tables and touches `models` not at all:

| table | holds | Plan B |
|---|---|---|
| `snapshot_meta` | one row per provider: `created_at`, `fetched_at`, `last_sync_json`, `pending_drop_json` | stays |
| `roster_snapshot` | one row per provider+model: `name`, `first_seen`, `last_seen`, `removed_at`, `summary_json`, `health_json` | becomes the catalog when `models` is dropped |

The cost is a second model table for one phase, with a named deletion point. The alternative —
writing into `models` beside `repos.catalog` — is silent data loss the first time both save the
same provider. Spec §5's own §10 intent (a stored row is provider facts only, derived fields
stripped) is honoured in `roster_snapshot.summary_json`.

## Global constraints

- Never `git worktree add`. One checkout: `C:\Users\venom\Desktop\UPSTREAM CHECKER` (CLAUDE.md).
- Never launch the app against `%APPDATA%\venom-router`. Every verification run uses a scratch
  `--user-data-dir`; `scripts/live/cdp.mjs` refuses anything else. A scratch folder starts with no
  providers and an empty database — expected, not damage.
- Never change how the app starts (`npm start`, the resolved data folder, launch behaviour).
- Every outbound request originates in main. The renderer never holds a key: where a key goes it
  writes `venomkey:<keyId>`, and for a named secret `venomsecret:<name>` (`src/db/keys.js`).
- Never decrypt, print, copy or move stored keys.
- **No test may reach the network.** Every fetch goes through an injected `fetchImpl`.
- `npm test` is the whole suite under Electron's Node. Measured baseline on this tree at the start
  of the plan: **299 pass, 0 fail, 1.78 s** (`AGENTS.md` still says 295 — the four extra come from
  the uncommitted Database Explorer work, and they pass). One file:
  `npm test -- test/catalog/keys.test.js`. `npm run check` (`repo:map --check` then the suite) is
  the gate before claiming anything is done.
- Unknown stays `null`. A value nobody published is never read as `false`, `0`, or `"unknown"`
  (ref §8.1). `""` for modality and date strings.
- Do not run `npm run release`, and do not push, unless the owner said so in that message.
- Commit messages: `type(scope): imperative summary`, body explaining the *why*.
- Working tree note: this branch starts from `main` at `e263ecc`. The Database Explorer work
  described in spec §12 must be committed or set aside by the owner before Task 1, because Tasks 10
  and 12 touch `src/main.js`, `src/preload.js` and `src/renderer/index.html`.

## File structure

New main-process CommonJS modules, one responsibility each.

| file | ~lines | responsibility | where it comes from |
|---|---|---|---|
| `src/catalog/util.js` | 100 | `asNumber` `perMillion` `uniqueJoin` `unixToDate` `boolOrNull` `hasParam` `listHas` `providerOf` `median` `clamp` `monthsSince` | `lib/util.js` verbatim |
| `src/catalog/keys.js` | 236 | identity keys, PRICING/QUALITY modifiers, `buildTag`, `compareBuilds`, `bareModelKey`, `nameKeyIsSafe`, `looseArenaKey` | `lib/keys.js` verbatim |
| `src/catalog/scoring.js` | 437 | `fitLinear` `fitSpec` `assignScores` `assignDenseRank` `buildMatchIndex` `lookupCatalogRow` `attachScores` `fillFromCatalog` | `lib/scoring.js` verbatim |
| `src/catalog/build.js` | 611 | `buildCatalog` — the seven-step merge, in order | `lib/catalog.js` verbatim |
| `src/catalog/atomic.js` | 31 | `writeJsonAtomic` | `lib/atomic.js` verbatim |
| `src/catalog/fetch.js` | 80 | one retry after 400 ms, 60 s URL dedup, injectable transport | `lib/fetch.js`, minus reachability |
| `src/catalog/sources.js` | 190 | the four sources: fetch, disk cache, failure-marks-stale | `lib/sources.js`, `env`→factory |
| `src/catalog/engine.js` | 260 | in-memory reference, `loadCache`, `syncAll`, `scoreRows`, `summary`, `unscorable` | `lib/engine.js` + §6 |
| `src/catalog/snapshot.js` | 230 | `syncSnapshot`: quarantine, windows, `moved`, tombstones, `providerRowSnapshot`, `dropNonText` | `providers/index.js` 130-428, storage behind a seam |
| `src/catalog/row.js` | 150 | one adapter model object → the shared provider row shape | **new**; readers move from `src/renderer/catalog.js` 151-194 |
| `src/db/repos/snapshots.js` | 60 | the SQLite side of the snapshot seam | **new** |
| `src/catalog/ipc.js` | 170 | the five `catalog:*` channels | **new** |

Modified: `src/db/migrations.js` (append `version: 2`), `src/db/index.js` (`createRepos` gains
`snapshots`), `src/main.js` (build and start the engine, register the IPC), `src/preload.js` (five
entries), `src/renderer/index.html` + `styles.css` + `app.js` (Settings › Catalog status block).

New tests: `test/catalog/{util,keys,scoring,build,atomic,fetch,sources,engine,snapshot,non-text,row,ipc}.test.js`,
`test/db/snapshots.test.js`, plus a version-2 case in `test/db/open.test.js`. No runner change is
needed: `scripts/run-tests.js:16-24` walks `test/` recursively for `*.test.js`.

The four **verbatim** ports (`util`, `keys`, `scoring`, `build`, `atomic`) are copied with `cp`,
not retyped, and verified with `git diff --no-index`. That is the plan's position on a port:
retyping 1 300 lines of arithmetic into this document would produce a worse copy of code that
already exists, and would rot the moment the reference moved. What the plan argues instead is the
three places the reference was wrong (ref §16.4, §16.6, and the four-field error-stub in
`engine.js`), each with the test that proves the fix.

---

### Task 1: Pure identity layer — `util.js` and `keys.js`

**Files:**
- Create: `src/catalog/util.js`, `src/catalog/keys.js`
- Create: `test/catalog/util.test.js`, `test/catalog/keys.test.js`
- Copy from: `E:\01-Projects\ven-catalog\lib\util.js`, `E:\01-Projects\ven-catalog\lib\keys.js`,
  `E:\01-Projects\ven-catalog\test\keys.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `src/catalog/util.js` → `{ asNumber, perMillion, uniqueJoin, unixToDate, boolOrNull,
  hasParam, listHas, providerOf, median, clamp, monthsSince }`; `src/catalog/keys.js` →
  `{ MATCH_AMBIGUOUS, LAB_PROVIDERS, PRICING_MODIFIERS, QUALITY_MODIFIERS, cleanModelId, modelSlug,
  identityKey, normalizeName, slugTokens, stripBuildSuffix, buildTag, compareBuilds, qualityModelKey,
  qualityNameKey, bareModelKey, nameKeyIsSafe, pricingTokenCount, benchKeysFromSlug, looseArenaKey }`.
  Both exactly the old export lists, same names.

- [ ] **Step 1: Copy the two files with no edits**

Neither file requires anything, so the port is byte-for-byte.

```bash
mkdir -p src/catalog test/catalog
cp "E:/01-Projects/ven-catalog/lib/util.js" src/catalog/util.js
cp "E:/01-Projects/ven-catalog/lib/keys.js" src/catalog/keys.js
```

Do not reformat and do not convert the double quotes to this repo's single quotes. Changing them
here buys a diff against the reference for no reason, and the reference is what §11's constants
are checked against.

- [ ] **Step 2: Port the identity tests**

```bash
cp "E:/01-Projects/ven-catalog/test/keys.test.js" test/catalog/keys.test.js
```

Change only the requires:

```js
const {
  cleanModelId, identityKey, qualityModelKey, qualityNameKey, bareModelKey,
  nameKeyIsSafe, benchKeysFromSlug, compareBuilds, buildTag, stripBuildSuffix,
  PRICING_MODIFIERS, QUALITY_MODIFIERS, MATCH_AMBIGUOUS, looseArenaKey,
} = require('../../src/catalog/keys');
```

If the original also requires `../lib/util`, point it at `../../src/catalog/util`. Keep every
assertion — in particular the two the spec leans on: `:free` collapses onto its twin, and
`max/high/low/thinking/preview/latest` never do.

- [ ] **Step 3: Run the ported tests**

```bash
npm test -- test/catalog/keys.test.js
```

Expected: PASS on the first try. A failure here means Step 1 was edited; diff against
`lib/keys.js` before touching a test.

- [ ] **Step 4: Write the util tests upstream never had**

`lib/util.js` ships untested. It carries the two rules the whole port rests on — unknown stays
`null`, and 30.4-day months — so it gets a file here.

```js
// test/catalog/util.test.js
const test = require('node:test');
const assert = require('node:assert');
const U = require('../../src/catalog/util');

test('asNumber: absent, empty and unparsable all stay null, never 0', () => {
  assert.equal(U.asNumber(null), null);
  assert.equal(U.asNumber(''), null);
  assert.equal(U.asNumber('abc'), null);
  assert.equal(U.asNumber(undefined), null);
  assert.equal(U.asNumber('12'), 12);
  assert.equal(U.asNumber(0), 0, 'a published zero is a zero, not a gap');
});

test('perMillion: null in, null out — a missing price is not free', () => {
  assert.equal(U.perMillion(null), null);
  assert.equal(U.perMillion('0.000002'), 2);
});

test('boolOrNull: only a real true or false is an answer', () => {
  assert.equal(U.boolOrNull(true), true);
  assert.equal(U.boolOrNull(false), false);
  assert.equal(U.boolOrNull(undefined), null);
  assert.equal(U.boolOrNull('yes'), null, 'a string is not a boolean');
});

test('uniqueJoin: dedupes case-insensitively, drops empties, keeps the first spelling', () => {
  assert.equal(U.uniqueJoin(['Text', 'image', 'text']), 'Text, image');
  assert.equal(U.uniqueJoin([['text'], 'image, audio']), 'text, image, audio');
  assert.equal(U.uniqueJoin([]), '');
});

test('unixToDate: seconds and milliseconds both become YYYY-MM-DD, junk becomes empty', () => {
  const day = new Date(1727000000000).toISOString().slice(0, 10);
  assert.equal(U.unixToDate(1727000000), day);
  assert.equal(U.unixToDate(1727000000000), day);
  assert.equal(U.unixToDate(null), '');
  assert.equal(U.unixToDate('nonsense'), '');
});

test('providerOf: the routing prefix, or empty string', () => {
  assert.equal(U.providerOf('openai/gpt-5'), 'openai');
  assert.equal(U.providerOf('gpt-5'), '');
});

test('listHas: compares trimmed case-insensitively across arrays and comma strings', () => {
  assert.equal(U.listHas(['Text'], 'text'), true);
  assert.equal(U.listHas('text, image', 'image'), true);
  assert.equal(U.listHas('text', 'audio'), false);
  assert.equal(U.listHas(null, 'text'), false);
});

test('median: empty and non-finite collapse to null; even counts average the middle pair', () => {
  assert.equal(U.median([]), null);
  assert.equal(U.median([null, 2, 4]), 3);
  assert.equal(U.median([1, 2, 3]), 2);
});

test('clamp: min then max', () => {
  assert.equal(U.clamp(5, 0, 10), 5);
  assert.equal(U.clamp(-5, 0, 10), 0);
  assert.equal(U.clamp(50, 0, 10), 10);
});

test('monthsSince: 30.4-day months, unparseable is null, the future is clamped to 0', () => {
  assert.equal(U.monthsSince('not a date'), null);
  assert.equal(U.monthsSince(new Date(Date.now() + 86400000).toISOString()), 0);
  const sixMonthsAgo = new Date(Date.now() - 6 * 30.4 * 86400000).toISOString();
  assert.ok(Math.abs(U.monthsSince(sixMonthsAgo) - 6) < 0.02, 'the spec fit caps age at 36 months using this');
});
```

- [ ] **Step 5: Run the new tests**

```bash
npm test -- test/catalog/util.test.js
```

Expected: PASS.

- [ ] **Step 6: Run the whole suite, then commit**

```bash
npm test
git add src/catalog/util.js src/catalog/keys.js test/catalog/util.test.js test/catalog/keys.test.js
git commit -m "feat(catalog): port the identity layer that decides what one model is

The reference's lib/keys.js encodes one rule: a key names exactly one model
identity. Pricing modifiers (:free, :batch, :hosted) are dropped so a free twin
shares its measurement; quality modifiers (max, high, thinking, preview, latest)
are kept because they change what actually runs, so gpt-5-low and gpt-5-high
never collapse. Copied verbatim rather than retyped so a future diff against
ven-catalog stays readable. lib/util.js shipped untested upstream; the
unknown-stays-null rule it carries is what the rest of the port rests on, so it
has a test file now."
```

---

### Task 2: `scoring.js` — two-tier score, dense rank, four-step lookup

**Files:**
- Create: `src/catalog/scoring.js`
- Create: `test/catalog/scoring.test.js`
- Copy from: `E:\01-Projects\ven-catalog\lib\scoring.js`, `E:\01-Projects\ven-catalog\test\scoring.test.js`

**Interfaces:**
- Consumes: `./util` (`median`, `clamp`, `monthsSince`) and `./keys` (`MATCH_AMBIGUOUS`,
  `cleanModelId`, `qualityModelKey`, `qualityNameKey`, `bareModelKey`, `nameKeyIsSafe`,
  `pricingTokenCount`) — both from Task 1.
- Produces: `{ scoreQuality, fitLinear, assignScores, assignDenseRank, buildMatchIndex,
  lookupCatalogRow, attachScores }`. `assignScores(rows) → fits` where
  `fits = { aa_coding, arena_code, arena_text, spec }`, each `{ n, r2 } | null`.
  `attachScores(rows, catalogRows) → rows`, setting on each row: `score`, `score_source`
  (`'aa' | 'est' | 'proxy' | null`), `score_basis` (array), `rank`, `catalog_rank`, `matched_id`,
  `bench_id`, `aa_intelligence`, `aa_coding`, `lmarena_elo`, `lmarena_rank`, `lmarena_code_rank`,
  `filled_from_catalog` (absent when nothing was borrowed), `score_proxy_for` (absent unless
  proxied).

- [ ] **Step 1: Copy and verify it is byte-identical**

```bash
cp "E:/01-Projects/ven-catalog/lib/scoring.js" src/catalog/scoring.js
git diff --no-index "E:/01-Projects/ven-catalog/lib/scoring.js" src/catalog/scoring.js
```

Expected: the second command prints nothing. Its requires (lines 15-24) already name `./util` and
`./keys`, which exist after Task 1. `MIN_FIT_SAMPLES = 30`, `MIN_FIT_R2 = 0.3`,
`SPEC_AGE_CAP_MONTHS = 36`, the `MIN_FIT_SAMPLES * 3` = 90 floor for the spec fit, ridge λ `1e-6`
and the `1.1 × highest measured` ceiling are spec §11 values and are not re-tuned here.

- [ ] **Step 2: Port the scoring tests**

```bash
cp "E:/01-Projects/ven-catalog/test/scoring.test.js" test/catalog/scoring.test.js
```

Point its requires at `../../src/catalog/scoring` (and `../../src/catalog/keys` where it uses the
key functions). If it reaches for `../lib/catalog` to build merged rows, comment those cases out
with a `// restored in Task 3` marker and a `test.skip`, and restore them in Task 3 Step 2 — a
skipped test with a reason is honest, a deleted one is not.

- [ ] **Step 3: Run them**

```bash
npm test -- test/catalog/scoring.test.js
```

Expected: PASS. These are the cases spec §9 promises, so confirm each is present in the ported
file rather than trusting the count:

- a fit over fewer than 30 distinct points is `null`; a fit under R² 0.3 is `null`;
- a row with no usable signal keeps `score = null`, `score_source = null`, `score_basis = []`;
- equal scores share one dense rank, and measured ranks before estimated on a tie;
- `match_ids` equal to a catalog id verbatim returns immediately, above every loose key;
- the route-stripped bare key sits *below* the id key, deliberately;
- the display name is used only when `nameKeyIsSafe` passes and nothing above matched;
- a `quality_proxy_ids` hit reads `score_source === 'proxy'` with `score_proxy_for` set;
- missing training values fall back to the training set's median, not to zero.

- [ ] **Step 4: Add the alias-only lookup case, stated here because nothing else pins it**

```js
test('a provider row reaches a measured catalog row through its alias alone', () => {
  const catalog = [{
    id: 'anthropic/claude-fable-5.1-20260831', name: 'Claude Fable 5.1',
    aa_intelligence: 53, aa_coding: null, lmarena_elo: null, lmarena_code_elo: null,
    cost_in_per_m: null, context_tokens: null, release_date: '',
    reasoning: null, tools: null, provider_count: 1, sources: [], conflicts: [],
  }];
  assignScores(catalog);
  assignDenseRank(catalog);
  const [row] = attachScores([{
    id: 'nexum/claude-fable-5.1', name: 'Claude Fable 5.1 (Nexum)',
    match_ids: ['anthropic/claude-fable-5.1-20260831'],
  }], catalog);
  assert.equal(row.score, 53);
  assert.equal(row.score_source, 'aa');
  assert.equal(row.matched_id, 'anthropic/claude-fable-5.1-20260831');
  assert.equal(row.rank, 1);
});
```

- [ ] **Step 5: Run the layer, then the suite, then commit**

```bash
npm test -- test/catalog/util.test.js test/catalog/keys.test.js test/catalog/scoring.test.js
npm test
git add src/catalog/scoring.js test/catalog/scoring.test.js
git commit -m "feat(catalog): port the two-tier score, never a guessed one

Measured Artificial Analysis indices pass through untouched. Everything else is
estimated by a least-squares fit recomputed from the catalog on every rebuild
and blended weighted by each fit's R-squared, so the mapping recalibrates as the
data moves. A row with no usable signal stays null — the difference between an
unrated model and an invented one."
```

---

### Task 3: `build.js` — the seven-step merge, with the two quirks fixed

**Files:**
- Create: `src/catalog/build.js`
- Create: `test/catalog/build.test.js`
- Copy from: `E:\01-Projects\ven-catalog\lib\catalog.js`, `E:\01-Projects\ven-catalog\test\catalog.test.js`
- Modify: `src/catalog/scoring.js` (`FILLABLE_FIELDS`)

**Interfaces:**
- Consumes: `./util`, `./keys`, `./scoring` (`assignScores`, `assignDenseRank`).
- Produces: `{ buildCatalog, indexModelsDev, indexOpenRouterModels, indexBenchmarks }`.
  `buildCatalog({ spec, openrouter, benchmarks, lmarena }) → { rows, byId, fits, nonText }`.
  Task 5 depends on the return types staying exact: `indexModelsDev(payload)` is a **Map** (used as
  `.size`) and `indexOpenRouterModels(payload)` is an **Array** (used as `.length`).

- [ ] **Step 1: Copy and verify**

```bash
cp "E:/01-Projects/ven-catalog/lib/catalog.js" src/catalog/build.js
git diff --no-index "E:/01-Projects/ven-catalog/lib/catalog.js" src/catalog/build.js
```

Expected: no output. Only the module's *file name* changes — inside `src/`, "catalog" is the page's
name, so the merge lives in `build.js`. Its requires (lines 17-41) resolve after Tasks 1-2.

- [ ] **Step 2: Port the build tests, and restore whatever Task 2 skipped**

```bash
cp "E:/01-Projects/ven-catalog/test/catalog.test.js" test/catalog/build.test.js
```

Requires → `../../src/catalog/build` (and `../../src/catalog/scoring` for the `assignScores`
cases). Also un-skip the `test.skip` markers Task 2 left in `test/catalog/scoring.test.js` and
re-point them at `../../src/catalog/build`. Do not rename the test titles; they are the
reference's own invariant names.

- [ ] **Step 3: Run them**

```bash
npm test -- test/catalog/build.test.js test/catalog/scoring.test.js
```

Expected: PASS. The order inside `buildCatalog` is load-bearing and these tests protect it
(ref §3): benchmarks fold **before** any key is registered, so nothing depends on feed row order;
the proven non-text drop happens **before** `collapseListings` and before the fits, so an image
model's price and context never enter the regression that scores chat models; and silence is not
proof — a row drops only when it *publishes* an output list without `text`.

- [ ] **Step 4: Write the failing tests for the two quirks spec §4 says to settle, not inherit**

Add to `test/catalog/build.test.js`:

```js
test('a negative published price reads as null, never as -1000000 (§16.4)', () => {
  // OpenRouter's -1 sentinel survives into six catalog rows today, and because
  // cost_in_per_m is fillable a thin provider row can BORROW the negative.
  const { rows } = buildCatalog({
    spec: null,
    openrouter: { data: [{ id: 'openrouter/auto', name: 'Auto',
      pricing: { prompt: '-1', completion: '-1' } }] },
    benchmarks: null, lmarena: null,
  });
  const auto = rows.find((r) => r.id === 'openrouter/auto');
  assert.ok(auto, 'the row still exists — only the price is refused');
  assert.equal(auto.cost_in_per_m, null);
  assert.equal(auto.cost_out_per_m, null);
  assert.equal(auto.cost_kind, 'unknown');
});

test('output_modalities is unioned across listings of one identity (§16.6)', () => {
  const { rows } = buildCatalog({
    spec: null,
    openrouter: { data: [
      { id: 'lab/model-a', name: 'Model A', architecture: { output_modalities: ['text'] } },
      { id: 'host/model-a', name: 'Model A', architecture: { output_modalities: ['image'] } },
    ] },
    benchmarks: null, lmarena: null,
  });
  const merged = rows.filter((r) => r.id.replace(/^[^/]+\//, '') === 'model-a');
  assert.equal(merged.length, 1, 'two listings of one identity collapse to one row');
  assert.match(merged[0].output_modalities, /text/);
  assert.match(merged[0].output_modalities, /image/);
});
```

- [ ] **Step 5: Run them and confirm they fail**

```bash
npm test -- test/catalog/build.test.js
```

Expected: FAIL on both new cases — today `perMillion('-1')` produces `-1000000` and
`collapseListings` unions `input_modalities` only.

- [ ] **Step 6: Make the two fixes**

In `src/catalog/build.js`, the helper that decides which source wins for a numeric field is
`pickNumber(preferred, fallback, conflicts, field)` (lines 76-84 of the original). A published
negative is not a number the app should carry, so it is treated as absent — at the one place both
sources pass through, not at each call site:

```js
function pickNumber(preferred, fallback, conflicts, field) {
  // A negative published price is OpenRouter's -1 sentinel, not a price: it read
  // as -1000000 per million and a thin provider row could borrow it (ref §16.4).
  const usable = (v) => (v == null || v < 0 ? null : v);
  const a = usable(preferred);
  const b = usable(fallback);
  if (a == null && b == null) return null;
  if (a == null) return b;
  if (b == null) return a;
  if (a !== b) (conflicts || []).push(field);
  return a;
}
```

Keep the conflict-push semantics exactly as they were (`conflicts` collects disagreements); read
the original body first and preserve anything else it does, such as which side is preferred when
both answer.

In `collapseListings` (the original's lines 251-300), the field that unions modalities is
`input_modalities`; add its sibling beside it:

```js
output_modalities: uniqueJoin(group.map((r) => r.output_modalities)),
```

In `src/catalog/scoring.js`, add `"output_modalities"` to `FILLABLE_FIELDS` (lines 350-363),
immediately after `"input_modalities"`, with the reference's comment kept intact. Without this a
provider that publishes no modality at all — nexum-router, eighteen listings, byte-identical
metadata — can never learn its output modality from the reference, and the tier gate reads all
eighteen as `modality_unknown`.

- [ ] **Step 7: Run the whole catalog layer, then the suite**

```bash
npm test -- test/catalog/util.test.js test/catalog/keys.test.js test/catalog/scoring.test.js test/catalog/build.test.js
npm test
```

Expected: the four files PASS, and the pre-existing 295 still PASS. Nothing in `src/db` or
`src/logs` was touched, so any failure there is a real regression introduced here.

- [ ] **Step 8: Commit**

```bash
git add src/catalog/build.js test/catalog/build.test.js src/catalog/scoring.js
git commit -m "fix(catalog): port the merge and settle two known data quirks

The reference records both against its own build rather than fixing them:
OpenRouter's -1 price sentinel became -1000000 per million on six rows and could
be borrowed by a thin provider row, and output_modalities was neither collapsed
across listings nor filled from the reference, which is why a provider publishing
byte-identical metadata for all eighteen of its listings reads as modality_unknown
at the tier gate. Negative published prices now read as null and output modality
behaves like input modality."
```

---

### Task 4: `atomic.js` and `fetch.js` — the transport seam

**Files:**
- Create: `src/catalog/atomic.js`, `src/catalog/fetch.js`
- Create: `test/catalog/atomic.test.js`, `test/catalog/fetch.test.js`
- Copy from: `E:\01-Projects\ven-catalog\lib\atomic.js`, `E:\01-Projects\ven-catalog\test\atomic.test.js`

**Interfaces:**
- Consumes: `node:fs` only.
- Produces: `src/catalog/atomic.js` → `{ writeJsonAtomic(filePath, value, { space }) }`.
  `src/catalog/fetch.js` → `createFetcher({ fetchImpl, timeoutMs, retryDelayMs, cacheTtlMs, sleep })`
  returning `{ fetchJson(url, headers?, timeoutMs?), fetchJsonCached(url, headers?, ttlMs?) }`, plus
  the constants `DEFAULT_TIMEOUT_MS = 20000`, `RETRY_DELAY_MS = 400`,
  `DEFAULT_CACHE_TTL_MS = 60000`.

- [ ] **Step 1: Copy atomic.js and its test, re-point the require**

```bash
cp "E:/01-Projects/ven-catalog/lib/atomic.js" src/catalog/atomic.js
cp "E:/01-Projects/ven-catalog/test/atomic.test.js" test/catalog/atomic.test.js
```

In the copied test change `require("../lib/atomic")` to
`require("../../src/catalog/atomic")`. Nothing else: `writeJsonAtomic` takes no configuration, and
the temp-file-plus-rename scheme it proves is the reason a crash cannot leave a truncated payload
that the next boot reads as a source with zero rows.

- [ ] **Step 2: Run the atomic test**

```bash
npm test -- test/catalog/atomic.test.js
```

Expected: PASS.

- [ ] **Step 3: Write the failing fetch tests**

The old `fetch.js` cannot be copied, so its tests are written here rather than ported.

```js
// test/catalog/fetch.test.js
const test = require('node:test');
const assert = require('node:assert');
const { createFetcher, RETRY_DELAY_MS, DEFAULT_CACHE_TTL_MS, DEFAULT_TIMEOUT_MS } = require('../../src/catalog/fetch');

const json = (body, ok = true, status = 200) => ({ ok, status, text: async () => JSON.stringify(body) });

function stub(responses) {
  const calls = [];
  let i = 0;
  return {
    calls,
    fetchImpl: async (url) => {
      calls.push(url);
      const next = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return next();
    },
  };
}

const fast = (over = {}) => createFetcher({ retryDelayMs: 1, sleep: async () => {}, ...over });

test('an answer comes back parsed with accept: application/json added', async () => {
  let seenHeaders;
  const f = fast({ fetchImpl: async (url, opts) => { seenHeaders = opts.headers; return json({ data: [1] }); } });
  assert.deepEqual(await f.fetchJson('https://x/y'), { data: [1] });
  assert.equal(seenHeaders.accept, 'application/json');
});

test('a caller header survives, and a caller-set accept wins', async () => {
  let seen;
  const f = fast({ fetchImpl: async (url, opts) => { seen = opts.headers; return json({}); } });
  await f.fetchJson('https://x/y', { Authorization: 'Bearer k', accept: 'application/json+mine' });
  assert.equal(seen.Authorization, 'Bearer k');
  assert.equal(seen.accept, 'application/json+mine');
});

test('exactly one retry on any failure, and the answer still arrives', async () => {
  const s = stub([() => { throw new Error('ECONNRESET'); }, () => json({ ok: true })]);
  const f = fast({ fetchImpl: s.fetchImpl });
  assert.deepEqual(await f.fetchJson('https://x/y'), { ok: true });
  assert.equal(s.calls.length, 2, 'a transient blip must not surface as a failure');
});

test('two failures throw the second cause suffixed (retried once) — never a third attempt', async () => {
  const s = stub([() => json({}, false, 500), () => json({}, false, 503)]);
  const f = fast({ fetchImpl: s.fetchImpl });
  await assert.rejects(() => f.fetchJson('https://x/y'), /HTTP 503 \(retried once\)$/);
  assert.equal(s.calls.length, 2);
});

test('a non-2xx is a failure even though the transport worked', async () => {
  const s = stub([() => json({ error: 'no' }, false, 429), () => json({ error: 'no' }, false, 429)]);
  const f = fast({ fetchImpl: s.fetchImpl });
  await assert.rejects(() => f.fetchJson('https://x/y'), /HTTP 429/);
});

test('unparsable JSON fails and retries: a truncated payload is not a source', async () => {
  let n = 0;
  const f = fast({ fetchImpl: async () => { n += 1; return { ok: true, status: 200, text: async () => '{"data":[' }; } });
  await assert.rejects(() => f.fetchJson('https://x/y'), /retried once/);
  assert.equal(n, 2);
});

test('an abort is reported as a timeout, in seconds', async () => {
  const f = createFetcher({
    retryDelayMs: 1, sleep: async () => {}, timeoutMs: 20000,
    fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); },
  });
  await assert.rejects(() => f.fetchJson('https://x/y'), /timed out after 20s \(retried once\)/);
});

test('the deadline really is armed and cleared: a slow answer still arrives', async () => {
  const f = createFetcher({ retryDelayMs: 1, sleep: async () => {}, timeoutMs: 5000,
    fetchImpl: async (url, opts) => { assert.ok(opts.signal, 'the abort signal is passed through'); return json({}); } });
  assert.deepEqual(await f.fetchJson('https://x/y'), {});
});

test('fetchJsonCached shares one in-flight download between concurrent callers', async () => {
  const s = stub([() => json({ big: true })]);
  const f = fast({ fetchImpl: s.fetchImpl });
  const [a, b] = await Promise.all([f.fetchJsonCached('https://x/big'), f.fetchJsonCached('https://x/big')]);
  assert.equal(a, b, 'the same object, one download');
  assert.equal(s.calls.length, 1);
});

test('a failed cached fetch is evicted so the next caller retries', async () => {
  const s = stub([() => { throw new Error('down'); }, () => { throw new Error('down'); }, () => json({ up: true })]);
  const f = fast({ fetchImpl: s.fetchImpl });
  await assert.rejects(() => f.fetchJsonCached('https://x/y'));
  assert.deepEqual(await f.fetchJsonCached('https://x/y'), { up: true });
});

test('the dedup is keyed by url, so two documents never share a payload', async () => {
  const seen = [];
  const f = fast({ fetchImpl: async (url) => { seen.push(url); return json({ url }); } });
  await Promise.all([f.fetchJsonCached('https://x/a'), f.fetchJsonCached('https://x/b')]);
  assert.deepEqual(seen.sort(), ['https://x/a', 'https://x/b']);
});

test('the constants are the ones spec §11 names', () => {
  assert.equal(RETRY_DELAY_MS, 400);
  assert.equal(DEFAULT_CACHE_TTL_MS, 60000);
  assert.equal(DEFAULT_TIMEOUT_MS, 20000);
});
```

- [ ] **Step 4: Run them and confirm they fail**

```bash
npm test -- test/catalog/fetch.test.js
```

Expected: FAIL — `Cannot find module '../../src/catalog/fetch'`.

- [ ] **Step 5: Write `src/catalog/fetch.js`**

The old module calls `reachability.observe(url, classifyTransportError(error))` on both the throw
and the response, and reads its timeout from `env.FETCH_TIMEOUT_MS`. Neither module exists here,
there is no env layer, and reachability feeds a screen this app does not have yet — so that arm is
dropped, the timeout becomes a factory argument, and `fetchImpl` is injected because no test in
this repo may reach the network. Everything else is the same behaviour, including the reason the
retry wrapper is what reports the final cause.

```js
// src/catalog/fetch.js
'use strict';

// The one JSON fetch helper for every upstream call the catalog makes. Sends
// `accept: application/json`, aborts after the timeout, throws on a non-2xx, and
// retries exactly once on any failure — timeout, network, non-2xx, bad JSON —
// after a short delay. A transient blip on a public API must not read as "the
// source is gone" when trying again a moment later would have worked.

const DEFAULT_TIMEOUT_MS = 20000;
const RETRY_DELAY_MS = 400;
const DEFAULT_CACHE_TTL_MS = 60000;

function friendlyMessage(error, timeoutMs) {
  if (error.name === 'AbortError') return `timed out after ${Math.round(timeoutMs / 1000)}s`;
  return error.message;
}

function createFetcher({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryDelayMs = RETRY_DELAY_MS,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref && t.unref(); }),
} = {}) {
  async function fetchOnce(url, headers, limitMs) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), limitMs);
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/json', ...headers },
        signal: ac.signal,
      });
      const text = await response.text();
      // Read the body before the status check: an answer of any status proves
      // the host is up, which is what the reachability layer needed, and the
      // error text a 4xx carries is the only useful thing to report.
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  }

  // The default is read per call, not once at definition, so a timeout the owner
  // changes in Settings takes effect without a restart.
  async function fetchJson(url, headers = {}, limitMs = timeoutMs) {
    try {
      return await fetchOnce(url, headers, limitMs);
    } catch (firstError) {
      await sleep(retryDelayMs);
      try {
        return await fetchOnce(url, headers, limitMs);
      } catch (secondError) {
        throw new Error(`${friendlyMessage(secondError, limitMs)} (retried once)`);
      }
    }
  }

  const cache = new Map(); // url -> { at, promise }

  // Deduplicated by URL only. Sound for these documents: three are unauthenticated
  // and the fourth always carries the same single key. A failed fetch is evicted
  // immediately so the next caller retries instead of inheriting the rejection.
  function fetchJsonCached(url, headers = {}, ttlMs = cacheTtlMs) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
    const promise = fetchJson(url, headers);
    promise.catch(() => cache.delete(url));
    cache.set(url, { at: Date.now(), promise });
    return promise;
  }

  return { fetchJson, fetchJsonCached };
}

module.exports = {
  createFetcher,
  DEFAULT_TIMEOUT_MS, RETRY_DELAY_MS, DEFAULT_CACHE_TTL_MS,
};
```

- [ ] **Step 6: Run the tests**

```bash
npm test -- test/catalog/fetch.test.js
```

Expected: PASS. If the abort case fails on wording, fix `friendlyMessage` — the `(retried once)`
suffix is what the reference's own status lines carry and the sources test asserts.

- [ ] **Step 7: Commit**

```bash
git add src/catalog/atomic.js src/catalog/fetch.js test/catalog/atomic.test.js test/catalog/fetch.test.js
git commit -m "feat(catalog): one-retry fetch and atomic cache writes

A transient blip costs one extra attempt after 400 ms rather than a red source
row, and a half-written cache file can never come back as a document with zero
rows. The transport is a factory argument because no test in this repo may reach
the network; the reachability arm of the original is left behind with the screen
it served."
```

---

### Task 5: `sources.js` — four upstream documents and their disk cache

**Files:**
- Create: `src/catalog/sources.js`
- Create: `test/catalog/sources.test.js`
- Reference: `E:\01-Projects\ven-catalog\lib\sources.js`

**Interfaces:**
- Consumes: `./atomic` (`writeJsonAtomic`), `./build` (`indexModelsDev`, `indexOpenRouterModels`),
  and a `fetcher` from `./fetch`.
- Produces: `SOURCES` — four descriptors with ids `models-dev-spec`, `openrouter-public`,
  `openrouter-keyed`, `lmarena`, each `{ id, name, url, auth, description }` — and
  `createSources({ cacheDir, fetcher, readKey })` returning
  `{ SOURCES, fetchOne(source), fetchAll(), readCache(id), writeCache(id, payload, meta),
  writeCacheFailure(id, message, at), rowCount(id, payload), newestFetchedAt(), hasPayload(id),
  cacheDir }`.
  `fetchOne(source)` resolves `{ id, payload, at }` or rejects. `fetchAll()` never rejects: it
  resolves `{ id, source, payload, at, error }[]`. `readKey()` is called at request time, so a key
  saved in Settings needs no restart.

- [ ] **Step 1: Write the failing tests**

```js
// test/catalog/sources.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSources, SOURCES } = require('../../src/catalog/sources');
const { createFetcher } = require('../../src/catalog/fetch');
const { tempDir } = require('../helpers');

const IDS = ['models-dev-spec', 'openrouter-public', 'openrouter-keyed', 'lmarena'];

function responder(bodies) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, headers: opts.headers });
    const hit = Object.entries(bodies).find(([needle]) => url.includes(needle));
    if (!hit) return { ok: false, status: 404, text: async () => '{}' };
    return { ok: true, status: 200, text: async () => JSON.stringify(hit[1]) };
  };
  return { calls, fetcher: createFetcher({ retryDelayMs: 1, sleep: async () => {}, fetchImpl }) };
}

test('exactly four sources, in the reference order, with the reference urls', () => {
  assert.deepEqual(SOURCES.map((s) => s.id), IDS);
  assert.equal(SOURCES[0].url, 'https://models.dev/api.json');
  assert.equal(SOURCES[1].url, 'https://openrouter.ai/api/v1/models');
  assert.equal(SOURCES[2].url, 'https://openrouter.ai/api/v1/benchmarks');
  assert.equal(SOURCES[2].auth, true, 'only the benchmark feed is keyed');
  assert.equal(SOURCES[0].auth, false);
});

test('the keyed source sends the bearer, and refuses before any request with no key', async (t) => {
  const { calls, fetcher } = responder({ '/benchmarks': { data: [] } });
  const sources = createSources({ cacheDir: tempDir(t), fetcher, readKey: () => 'rk' });
  await sources.fetchOne(SOURCES[2]);
  assert.equal(calls[0].headers.Authorization, 'Bearer rk');

  let touched = 0;
  const noKey = createSources({
    cacheDir: tempDir(t), readKey: () => '',
    fetcher: createFetcher({ retryDelayMs: 1, sleep: async () => {},
      fetchImpl: () => { touched += 1; throw new Error('must not be called'); } }),
  });
  await assert.rejects(() => noKey.fetchOne(SOURCES[2]), /not set|needs an.*key/i);
  assert.equal(touched, 0, 'the throw comes before the request');
});

test('LMArena pages 100 rows a time and stops at a short page, not at the 800 cap', async (t) => {
  let seen = 0;
  const page = (n, offset) => ({ rows: Array.from({ length: n }, (_, i) => ({
    row: { model_name: `m${offset + i}`, category: 'overall', rating: 1200, rank: offset + i + 1, vote_count: 5 },
  })) });
  const fetcher = createFetcher({ retryDelayMs: 1, sleep: async () => {}, fetchImpl: async (url) => {
    const u = new URL(url);
    const offset = Number(u.searchParams.get('offset'));
    seen += 1;
    const n = u.searchParams.get('config') === 'text' ? (offset < 200 ? 100 : offset === 200 ? 5 : 0) : 5;
    return { ok: true, status: 200, text: async () => JSON.stringify(page(n, offset)) };
  } });
  const sources = createSources({ cacheDir: tempDir(t), fetcher, readKey: () => '' });
  const { payload } = await sources.fetchOne(SOURCES[3]);
  assert.equal(payload.data.length, 205);
  assert.equal(payload.webdev.length, 5);
  assert.equal(seen, 4, 'two text pages plus the short one, plus one webdev page');
});

test('a row whose category is not overall ends that board and is not kept', async (t) => {
  const fetcher = createFetcher({ retryDelayMs: 1, sleep: async () => {}, fetchImpl: async () => ({
    ok: true, status: 200, text: async () => JSON.stringify({ rows: [
      { row: { model_name: 'keep', category: 'overall', rating: 1, rank: 1, vote_count: 1 } },
      { row: { model_name: 'drop', category: 'coding', rating: 2, rank: 2, vote_count: 2 } },
      { row: { model_name: 'never', category: 'overall', rating: 3, rank: 3, vote_count: 3 } },
    ] }),
  }) });
  const sources = createSources({ cacheDir: tempDir(t), fetcher, readKey: () => '' });
  const { payload } = await sources.fetchOne(SOURCES[3]);
  assert.deepEqual(payload.data.map((r) => r.model_name), ['keep']);
});

test('a failure after a success keeps the payload and marks the source stale', async (t) => {
  const dir = tempDir(t);
  const good = { data: [{ id: 'a/b', name: 'A' }] };
  const ok = createFetcher({ retryDelayMs: 1, sleep: async () => {},
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(good) }) });
  const sources = createSources({ cacheDir: dir, fetcher: ok, readKey: () => '' });
  const source = SOURCES[1];
  const { at } = await sources.fetchOne(source);
  sources.writeCache(source.id, good,
    { fetchedAt: at, lastAttemptAt: at, error: null, stale: false, rowCount: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'openrouter-public.json'), 'utf8')), good);

  const dead = createFetcher({ retryDelayMs: 1, sleep: async () => {},
    fetchImpl: async () => { throw new Error('socket hang up'); } });
  const s2 = createSources({ cacheDir: dir, fetcher: dead, readKey: () => '' });
  await assert.rejects(() => s2.fetchOne(source));
  assert.equal(s2.writeCacheFailure(source.id, 'socket hang up', '2026-09-30T00:00:00.000Z'), true);

  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'openrouter-public.meta.json'), 'utf8'));
  assert.equal(meta.error, 'socket hang up');
  assert.equal(meta.stale, true);
  assert.equal(meta.fetchedAt, at, 'a failure does not overwrite when the rows were fetched');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'openrouter-public.json'), 'utf8')), good,
    'a failed refresh never replaces the payload');
});

test('writeCacheFailure says false when nothing was ever cached, so a first-run failure is not stale', (t) => {
  const sources = createSources({ cacheDir: tempDir(t), fetcher: createFetcher({}), readKey: () => '' });
  assert.equal(sources.writeCacheFailure('lmarena', 'boom', '2026-09-30T00:00:00.000Z'), false);
});

test('readCache is null until both files exist', (t) => {
  const dir = tempDir(t);
  const sources = createSources({ cacheDir: dir, fetcher: createFetcher({}), readKey: () => '' });
  assert.equal(sources.readCache('lmarena'), null);
  fs.writeFileSync(path.join(dir, 'lmarena.json'), '{}');
  assert.equal(sources.readCache('lmarena'), null, 'the payload alone is not a cache');
});

test('rowCount counts usable rows after indexing, not document size', (t) => {
  const sources = createSources({ cacheDir: tempDir(t), fetcher: createFetcher({}), readKey: () => '' });
  assert.equal(sources.rowCount('openrouter-public', { data: [{ id: 'a/b' }, { name: 'no id' }] }), 1);
  assert.equal(sources.rowCount('openrouter-keyed', { data: [{ model_permaslug: 'a' }] }), 1);
  assert.equal(sources.rowCount('lmarena', { data: [1, 2], webdev: [3] }), 3);
  assert.equal(sources.rowCount('lmarena', null), 0);
  assert.equal(sources.rowCount('unknown-source', { data: [1] }), 0);
});

test('newestFetchedAt is the newest meta timestamp across the four, or null', (t) => {
  const dir = tempDir(t);
  const sources = createSources({ cacheDir: dir, fetcher: createFetcher({}), readKey: () => '' });
  assert.equal(sources.newestFetchedAt(), null);
  sources.writeCache('lmarena', { data: [], webdev: [] },
    { fetchedAt: '2026-09-30T10:00:00.000Z', lastAttemptAt: '2026-09-30T10:00:00.000Z', error: null, stale: false, rowCount: 0 });
  sources.writeCache('openrouter-public', { data: [] },
    { fetchedAt: '2026-09-30T11:00:00.000Z', lastAttemptAt: '2026-09-30T11:00:00.000Z', error: null, stale: false, rowCount: 0 });
  assert.equal(sources.newestFetchedAt(), '2026-09-30T11:00:00.000Z');
});

test('models.dev shares one download with any other caller of the same url', async (t) => {
  let n = 0;
  const fetcher = createFetcher({ retryDelayMs: 1, sleep: async () => {}, fetchImpl: async () => {
    n += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ a: { models: { m: { id: 'm' } } } }) };
  } });
  const sources = createSources({ cacheDir: tempDir(t), fetcher, readKey: () => '' });
  await Promise.all([sources.fetchOne(SOURCES[0]), sources.fetchOne(SOURCES[0])]);
  assert.equal(n, 1, 'the 4.9 MB document is downloaded once per cycle, not once per caller');
});

test('fetchAll reports each source and never rejects for one failure', async (t) => {
  const fetcher = createFetcher({ retryDelayMs: 1, sleep: async () => {}, fetchImpl: async (url) => {
    if (url.includes('models.dev')) throw new Error('gone');
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [], rows: [] }) };
  } });
  const sources = createSources({ cacheDir: tempDir(t), fetcher, readKey: () => 'k' });
  const results = await sources.fetchAll();
  assert.equal(results.length, 4);
  assert.equal(results.find((r) => r.id === 'models-dev-spec').error, 'gone');
  assert.equal(results.find((r) => r.id === 'lmarena').error, null);
});
```

- [ ] **Step 2: Run them and confirm they fail**

```bash
npm test -- test/catalog/sources.test.js
```

Expected: FAIL — `Cannot find module '../../src/catalog/sources'`.

- [ ] **Step 3: Write `src/catalog/sources.js`**

```js
// src/catalog/sources.js
'use strict';

// The four upstream documents that feed the reference catalog, how each is
// fetched, and how its payload is cached on disk. No in-memory state lives here
// — src/catalog/engine.js owns that.

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic');
const { indexModelsDev, indexOpenRouterModels } = require('./build');

const SOURCES = [
  {
    id: 'models-dev-spec',
    name: 'models.dev (spec)',
    url: 'https://models.dev/api.json',
    auth: false,
    description: 'Limits, modalities, capabilities, catalog prices, release dates',
  },
  {
    id: 'openrouter-public',
    name: 'OpenRouter (models)',
    url: 'https://openrouter.ai/api/v1/models',
    auth: false,
    description: 'Live pricing, parameters, architecture, hosted limits',
  },
  {
    id: 'openrouter-keyed',
    name: 'OpenRouter (benchmarks)',
    url: 'https://openrouter.ai/api/v1/benchmarks',
    auth: true,
    description: 'Independent AA indices and Design Arena Elo',
  },
  {
    id: 'lmarena',
    name: 'LMArena (text)',
    url: 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset',
    auth: false,
    description: 'Human Arena Elo from text overall + Code Arena (webdev)',
  },
];

const ARENA_ROWS = 'https://datasets-server.huggingface.co/rows';
const ARENA_PAGE = 100;
const ARENA_MAX_OFFSET = 800;

function arenaUrl(config, offset) {
  return `${ARENA_ROWS}?dataset=lmarena-ai/leaderboard-dataset&config=${config}`
    + `&split=latest&offset=${offset}&length=${ARENA_PAGE}`;
}

const dataPath = (dir, id) => path.join(dir, `${id}.json`);
const metaPath = (dir, id) => path.join(dir, `${id}.meta.json`);

function createSources({ cacheDir, fetcher, readKey = () => '' }) {
  async function fetchBoard(config) {
    const data = [];
    for (let offset = 0; offset < ARENA_MAX_OFFSET; offset += ARENA_PAGE) {
      const payload = await fetcher.fetchJson(arenaUrl(config, offset));
      const rows = (payload && payload.rows) || [];
      if (!rows.length) break;
      let done = false;
      for (const entry of rows) {
        const row = (entry && entry.row) || {};
        // The board interleaves categories; "overall" names each model once.
        // Anything else means the overall section has ended.
        if (row.category && row.category !== 'overall') { done = true; break; }
        if (!row.model_name) continue;
        data.push({
          model_name: row.model_name,
          organization: row.organization || '',
          rating: row.rating,
          rank: row.rank,
          vote_count: row.vote_count,
          board: config,
        });
      }
      if (done || rows.length < ARENA_PAGE) break;
    }
    return data;
  }

  async function fetchOne(source) {
    const at = new Date().toISOString();
    if (source.id === 'lmarena') {
      const [data, webdev] = await Promise.all([fetchBoard('text'), fetchBoard('webdev')]);
      return { id: source.id, payload: { data, webdev }, at };
    }
    if (source.id === 'models-dev-spec') {
      // Cached by url, so a source sync and a provider load that want the same
      // 4.9 MB document pay for it once between them.
      return { id: source.id, payload: await fetcher.fetchJsonCached(source.url), at };
    }
    const headers = {};
    if (source.auth) {
      const key = readKey();
      if (!key) throw new Error(`${source.name} is not set: no OpenRouter key. Add it in Settings › Catalog.`);
      headers.Authorization = `Bearer ${key}`;
      headers['HTTP-Referer'] = 'https://venom-router.local';
      headers['X-OpenRouter-Title'] = 'Venom Router';
    }
    return { id: source.id, payload: await fetcher.fetchJson(source.url, headers), at };
  }

  // Never rejects for a source failure — deciding what a dead source means is
  // the engine's job, and one dead board must not cost the other three.
  async function fetchAll() {
    return Promise.all(SOURCES.map(async (source) => {
      try {
        const { payload, at } = await fetchOne(source);
        return { id: source.id, source, payload, at, error: null };
      } catch (error) {
        return {
          id: source.id, source, payload: null,
          at: new Date().toISOString(), error: error.message || 'fetch failed',
        };
      }
    }));
  }

  function writeCache(id, payload, meta) {
    fs.mkdirSync(cacheDir, { recursive: true });
    writeJsonAtomic(dataPath(cacheDir, id), payload);
    writeJsonAtomic(metaPath(cacheDir, id), meta);
  }

  /** Records an unsuccessful attempt without touching the last-good payload. */
  function writeCacheFailure(id, message, attemptedAt) {
    if (!fs.existsSync(dataPath(cacheDir, id)) || !fs.existsSync(metaPath(cacheDir, id))) return false;
    let previous;
    try {
      previous = JSON.parse(fs.readFileSync(metaPath(cacheDir, id), 'utf8'));
    } catch (_) {
      return false;
    }
    writeJsonAtomic(metaPath(cacheDir, id),
      { ...previous, lastAttemptAt: attemptedAt, error: message, stale: true });
    return true;
  }

  function readCache(id) {
    if (!fs.existsSync(dataPath(cacheDir, id)) || !fs.existsSync(metaPath(cacheDir, id))) return null;
    return {
      payload: JSON.parse(fs.readFileSync(dataPath(cacheDir, id), 'utf8')),
      meta: JSON.parse(fs.readFileSync(metaPath(cacheDir, id), 'utf8')),
    };
  }

  /** Usable rows after indexing, not document size — the number the UI shows. */
  function rowCount(id, payload) {
    if (id === 'models-dev-spec') return indexModelsDev(payload).size;
    if (id === 'openrouter-public') return indexOpenRouterModels(payload).length;
    if (id === 'openrouter-keyed') return payload && Array.isArray(payload.data) ? payload.data.length : 0;
    if (id === 'lmarena') {
      const data = payload && Array.isArray(payload.data) ? payload.data.length : 0;
      const web = payload && Array.isArray(payload.webdev) ? payload.webdev.length : 0;
      return data + web;
    }
    return 0;
  }

  function newestFetchedAt() {
    let newest = null;
    for (const source of SOURCES) {
      let meta;
      try { meta = readCache(source.id); } catch (_) { continue; }
      const at = meta && meta.meta && meta.meta.fetchedAt;
      if (at && (!newest || at > newest)) newest = at;
    }
    return newest;
  }

  function hasPayload(id) {
    return fs.existsSync(dataPath(cacheDir, id));
  }

  return {
    SOURCES, fetchOne, fetchAll, readCache, writeCache, writeCacheFailure,
    rowCount, newestFetchedAt, hasPayload, cacheDir,
  };
}

module.exports = { SOURCES, createSources };
```

Two differences from the original, each pinned by a test above: `HTTP-Referer` is a fixed host
because this app listens on no port (the old value was `http://127.0.0.1:<PORT>`), and the
`not set` throw for the keyed source happens before any request so a keyless machine reports a
prerequisite rather than a network it never attempted.

- [ ] **Step 4: Run the tests**

```bash
npm test -- test/catalog/sources.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/catalog/sources.js test/catalog/sources.test.js
git commit -m "feat(catalog): fetch and cache the four upstream documents

A failed refresh updates only the meta file and marks the source stale, so the
last-good payload survives both the outage and the restart and the reference is
rebuilt from what answered last time rather than from nothing. LMArena pages 100
rows at a time and stops at the first non-overall row on each board; models.dev
is deduplicated by url so its 4.9 MB is downloaded once per cycle."
```

---

### Task 6: `engine.js` — the reference that is rebuilt, not stored

**Files:**
- Create: `src/catalog/engine.js`
- Create: `test/catalog/engine.test.js`
- Reference: `E:\01-Projects\ven-catalog\lib\engine.js` (lines 1-215 are the shape)

**Interfaces:**
- Consumes: `./build` (`buildCatalog`), `./scoring` (`attachScores`, `buildMatchIndex`,
  `lookupCatalogRow`), and a `sources` object from Task 5.
- Produces: `createEngine({ sources, minAgeMs, log })` returning
  `{ state, loadCache(), syncAll({ force }), rebuild(), scoreRows(rows), isNonTextModel(row),
  unscoredIds(rows), syncIfUnscored(rows), unscorableSize(), summary(), health(), minAgeMs }`.
  `state = { sourceStore, catalog: { fetchedAt, rows, byId, fits, nonTextIndex }, lastSyncAt, syncing }`.
  `state.sourceStore[id]` always carries **six** fields: `fetchedAt, lastAttemptAt, error, stale,
  rowCount, payload`. `summary()` returns `{ lastSyncAt, syncing, keyedAuthConfigured, catalogCount,
  fits, sources: [{ id, name, description, fetchedAt, lastAttemptAt, error, stale, rowCount }] }`.
  Also exported: `SOURCE_SYNC_MIN_AGE_MS = 15 * 60 * 1000` (spec §11).

- [ ] **Step 1: Write the failing tests**

```js
// test/catalog/engine.test.js
const test = require('node:test');
const assert = require('node:assert');
const { createEngine, SOURCE_SYNC_MIN_AGE_MS } = require('../../src/catalog/engine');

const OR_ROWS = { data: [{
  id: 'anthropic/claude-fable-5.1', name: 'Anthropic: Claude Fable 5.1',
  context_length: 200000, pricing: { prompt: '0.000008', completion: '0.00004' },
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
  supported_parameters: ['tools', 'response_format'],
}] };
const SPEC = { anthropic: { models: { 'claude-fable-5.1': { id: 'claude-fable-5.1',
  name: 'Claude Fable 5.1', limit: { context: 200000, output: 64000 }, tool_call: true,
  reasoning: true, release_date: '2026-08-31' } } } };
const NEW = new Date().toISOString();

// A sources stand-in backed by two Maps. It keeps the disk out of the test while
// exercising the same read/write calls the engine makes against the real one.
function fakeSources({ payloads = {}, newest = NEW, fail = {} } = {}) {
  const cache = new Map(); const meta = new Map();
  const store = {
    SOURCES: [
      { id: 'models-dev-spec', name: 'models.dev (spec)', description: 'd' },
      { id: 'openrouter-public', name: 'OpenRouter (models)', description: 'd' },
      { id: 'openrouter-keyed', name: 'OpenRouter (benchmarks)', description: 'd' },
      { id: 'lmarena', name: 'LMArena (text)', description: 'd' },
    ],
    syncs: 0,
    readKey: () => 'k',
    rowCount: (id, p) => (p && p.data ? p.data.length : 0),
    writeCache: (id, payload, m) => { cache.set(id, payload); meta.set(id, m); },
    writeCacheFailure: (id, message, at) => {
      if (!cache.has(id)) return false;
      meta.set(id, { ...(meta.get(id) || {}), lastAttemptAt: at, error: message, stale: true });
      return true;
    },
    readCache: (id) => (cache.has(id) ? { payload: cache.get(id), meta: meta.get(id) } : null),
    newestFetchedAt: () => (meta.size ? newest : null),
    hasPayload: (id) => cache.has(id),
    fetchAll: async () => {
      store.syncs += 1;
      return Object.entries(payloads).map(([id, payload]) => (fail[id]
        ? { id, source: { id }, payload: null, at: newest, error: fail[id] }
        : { id, source: { id }, payload, at: newest, error: null }));
    },
    seed(id, payload, at = newest) {
      cache.set(id, payload);
      meta.set(id, { fetchedAt: at, lastAttemptAt: at, error: null, stale: false, rowCount: 0 });
    },
  };
  return store;
}

test('a fresh engine has no catalog, and scoreRows leaves a row honestly unscored', () => {
  const engine = createEngine({ sources: fakeSources() });
  engine.loadCache();
  assert.equal(engine.state.catalog.rows.length, 0);
  const [row] = engine.scoreRows([{ id: 'x/y', name: 'X Y' }]);
  assert.equal(row.score, null);
  assert.equal(row.score_source, null);
  assert.deepEqual(row.score_basis, []);
  assert.equal(row.rank, null);
  assert.equal(row.matched_id, null);
  assert.equal(row.bench_id, null);
});

test('loadCache rebuilds from what is already cached, with no fetch at all', () => {
  const sources = fakeSources();
  sources.seed('openrouter-public', OR_ROWS);
  sources.seed('models-dev-spec', SPEC);
  const engine = createEngine({ sources });
  engine.loadCache();
  assert.equal(engine.state.catalog.rows.length, 1);
  assert.equal(engine.state.lastSyncAt, NEW);
  assert.equal(sources.syncs, 0);
});

test('syncAll stores every payload that arrived and rebuilds', async () => {
  const sources = fakeSources({ payloads: { 'openrouter-public': OR_ROWS, 'models-dev-spec': SPEC } });
  const engine = createEngine({ sources });
  const summary = await engine.syncAll({ force: true });
  assert.equal(summary.catalogCount, 1);
  assert.equal(sources.syncs, 1);
  assert.equal(engine.state.sourceStore['openrouter-public'].stale, false);
  assert.equal(engine.state.sourceStore['openrouter-public'].error, null);
});

test('a source that fails has nothing cached is absent, not stale; the merge still runs', async () => {
  const sources = fakeSources({
    payloads: { 'openrouter-public': OR_ROWS, 'models-dev-spec': SPEC, lmarena: { data: [], webdev: [] } },
    fail: { lmarena: 'timed out after 20s (retried once)' },
  });
  const engine = createEngine({ sources });
  await engine.syncAll({ force: true });
  assert.equal(engine.state.sourceStore.lmarena.stale, false, 'stale requires a previous payload');
  assert.equal(engine.state.sourceStore.lmarena.error, 'timed out after 20s (retried once)');
  assert.equal(engine.state.sourceStore['openrouter-public'].stale, false);
  assert.equal(engine.state.catalog.rows.length, 1);
});

test('a source that fails after succeeding keeps its payload and reads stale', async () => {
  const sources = fakeSources({ payloads: { 'openrouter-public': OR_ROWS } });
  const engine = createEngine({ sources });
  await engine.syncAll({ force: true });
  assert.equal(sources.readCache('openrouter-public').payload.data.length, 1);

  const dead = fakeSources({});
  dead.seed('openrouter-public', OR_ROWS);
  const after = createEngine({ sources: dead });
  after.loadCache();
  const before = after.state.sourceStore['openrouter-public'];
  assert.equal(before.stale, false, 'loaded from disk, no attempt made yet');
  assert.equal(after.state.catalog.rows.length, 1, 'last-good survives the restart');
});

test('a second syncAll while one is in flight is refused with SYNC_IN_PROGRESS', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const base = fakeSources({ payloads: { 'openrouter-public': OR_ROWS } });
  const slow = { ...base, fetchAll: async () => { await gate; return base.fetchAll(); } };
  const engine = createEngine({ sources: slow });
  const first = engine.syncAll({ force: true });
  await assert.rejects(() => engine.syncAll({ force: true }), (e) => e.code === 'SYNC_IN_PROGRESS');
  release();
  await first;
  assert.equal(engine.state.syncing, false, 'the flag is cleared on the happy path too');
});

test('scoreRows reaches the reference through the merge and borrows what the row lacks', async () => {
  const sources = fakeSources({ payloads: {
    'openrouter-public': OR_ROWS,
    'models-dev-spec': SPEC,
    'openrouter-keyed': { data: [{ model_permaslug: 'anthropic/claude-fable-5.1',
      source: 'artificial-analysis', metrics: { intelligence_index: 53 } }] },
    lmarena: { data: [], webdev: [] },
  } });
  const engine = createEngine({ sources });
  await engine.syncAll({ force: true });
  const [row] = engine.scoreRows([{ id: 'nexum/claude-fable-5.1', name: 'Claude Fable 5.1' }]);
  assert.equal(row.matched_id, 'anthropic/claude-fable-5.1');
  assert.equal(row.score, 53);
  assert.equal(row.rank, 1);
  assert.equal(row.context_tokens, 200000, 'a thin row borrows the context it never published');
  assert.ok(row.filled_from_catalog.includes('context_tokens'), 'and every borrow is recorded');
});

test('syncIfUnscored syncs once for an unknown row, then gives up on it', async () => {
  const sources = fakeSources({ payloads: { 'openrouter-public': OR_ROWS, 'models-dev-spec': SPEC } });
  const engine = createEngine({ sources });
  await engine.syncAll({ force: true });
  const rows = [{ id: 'brand/new-model', name: 'Brand New' }];
  assert.deepEqual(engine.unscoredIds(rows), ['brand/new-model']);

  const first = await engine.syncIfUnscored(rows);
  assert.equal(first.synced, true, 'a model discovered this cycle is the reason to sync');
  assert.equal(first.scored, 0);
  assert.equal(sources.syncs, 2);

  const second = await engine.syncIfUnscored(rows);
  assert.equal(second.synced, false, 'an unscorable id costs no further syncs');
  assert.equal(sources.syncs, 2);
});

test('an id that later scores clears the unscorable set', async () => {
  const payloads = { 'openrouter-public': { data: [{ id: 'later/one', name: 'One',
    context_length: 1000, architecture: { output_modalities: ['text'] } }] } };
  const sources = fakeSources({ payloads });
  const engine = createEngine({ sources });
  await engine.syncAll({ force: true });
  await engine.syncIfUnscored([{ id: 'later/two', name: 'Two' }]);
  assert.equal(engine.unscorableSize(), 1);

  // The reference only scores a row it HAS a row for, and rows come from the
  // rosters — folding a benchmark entry alone does not create one. So the second
  // sync must add both the listing and its measurement.
  sources.makeScorable();
  await engine.syncAll({ force: true });
  assert.equal(engine.unscorableSize(), 0, 'the signal that made one scoreable may make the next one too');
  assert.equal(engine.unscoredIds([{ id: 'later/two', name: 'Two' }]).length, 0);
});

test('syncAll without force skips the network inside the TTL and still re-merges', async () => {
  const sources = fakeSources({ payloads: { 'openrouter-public': OR_ROWS }, newest: new Date().toISOString() });
  const engine = createEngine({ sources });
  const first = await engine.syncAll({ force: true });
  assert.equal(sources.syncs, 1);
  const second = await engine.syncAll();
  assert.equal(sources.syncs, 1, 'the download is gated, the merge is not');
  assert.equal(second.skipped, true);
  assert.equal(second.catalogCount, first.catalogCount);
});

test('syncAll without force does hit the network when the newest payload is old', async () => {
  const old = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  const sources = fakeSources({ payloads: { 'openrouter-public': OR_ROWS }, newest: old });
  const engine = createEngine({ sources });
  await engine.syncAll();
  assert.equal(sources.syncs, 1);
});

test('summary reports six fields per source, in the declared order', () => {
  const sources = fakeSources();
  sources.seed('lmarena', { data: [], webdev: [] });
  const engine = createEngine({ sources });
  engine.loadCache();
  const entry = engine.summary().sources.find((s) => s.id === 'lmarena');
  assert.deepEqual(Object.keys(entry).sort(),
    ['description', 'error', 'fetchedAt', 'id', 'lastAttemptAt', 'name', 'rowCount', 'stale']);
});

test('an error stub cached on disk still reports itself stale', () => {
  const sources = fakeSources();
  sources.seed('openrouter-keyed', { error: 'HTTP 401' });
  const engine = createEngine({ sources });
  engine.loadCache();
  const entry = engine.state.sourceStore['openrouter-keyed'];
  assert.equal(entry.stale, true, 'the six-field bug: this used to read as silence');
  assert.ok(Object.prototype.hasOwnProperty.call(entry, 'lastAttemptAt'));
  assert.equal(entry.payload, null);
});

test('the TTL constant is the one spec §11 names', () => {
  assert.equal(SOURCE_SYNC_MIN_AGE_MS, 15 * 60 * 1000);
});

test('isNonTextModel knows a generator the reference dropped, and never guesses', async () => {
  const sources = fakeSources({ payloads: { 'openrouter-public': { data: [
    { id: 'lab/painter', name: 'Painter', architecture: { output_modalities: ['image'] } },
  ] } } });
  const engine = createEngine({ sources });
  await engine.syncAll({ force: true });
  assert.equal(engine.isNonTextModel({ id: 'lab/painter', name: 'Painter' }), true);
  assert.equal(engine.isNonTextModel({ id: 'host/silent', name: 'Silent' }), false,
    'unknown is not non-text — otherwise every listing of a provider that publishes nothing is deleted');
});
```

The `sources.makeScorable()` call above is a method the fake needs, added to `fakeSources()` in
Step 1 before running. It rewrites the payloads so a previously unknown id becomes both a listing
and a measured row, which is the only way the reference can score it:

```js
    makeScorable() {
      payloads['openrouter-public'] = { data: [
        ...payloads['openrouter-public'].data,
        { id: 'later/two', name: 'Two', context_length: 1000,
          architecture: { output_modalities: ['text'] } },
      ] };
      payloads['openrouter-keyed'] = { data: [{ model_permaslug: 'later/two',
        source: 'artificial-analysis', metrics: { intelligence_index: 30 } }] };
    },
```

- [ ] **Step 2: Run them and confirm they fail**

```bash
npm test -- test/catalog/engine.test.js
```

Expected: FAIL — `Cannot find module '../../src/catalog/engine'`.

- [ ] **Step 3: Write `src/catalog/engine.js`**

```js
// src/catalog/engine.js
'use strict';

// Owns the in-memory copy of the four sources and the reference built from them,
// and hands out exactly what the rest of the app needs:
//   loadCache / syncAll   keep the sources fresh
//   scoreRows(rows)       give provider rows their score and rank
//   summary / health      status for Settings
//   isNonTextModel        the third proof that a listing is a generator
//
// Providers never depend on this for their model list — only for score, rank,
// and whatever blank metadata a thin row borrows. With nothing synced, scoreRows
// leaves both null and the page reads "Unrated".

const { buildCatalog } = require('./build');
const { attachScores, buildMatchIndex, lookupCatalogRow } = require('./scoring');

// Gates the per-row Fetch information button's network pass (spec §6): the merge
// costs ~210 ms and always runs; re-downloading ~5 MB across four endpoints only
// runs when the newest payload is older than this.
const SOURCE_SYNC_MIN_AGE_MS = 15 * 60 * 1000;

function emptySource() {
  return { fetchedAt: null, lastAttemptAt: null, error: null, stale: false, rowCount: 0, payload: null };
}

function createEngine({ sources, minAgeMs = SOURCE_SYNC_MIN_AGE_MS, log = () => {} }) {
  const state = {
    sourceStore: {},
    catalog: { fetchedAt: null, rows: [], byId: new Map(), fits: {}, nonTextIndex: null },
    lastSyncAt: null,
    syncing: false,
  };

  for (const source of sources.SOURCES) state.sourceStore[source.id] = emptySource();

  // An id the current reference cannot score. Without this, every pass re-fetches
  // four sources hoping one model shows up, forever.
  const unscorable = new Set();

  const payloadOf = (id) => {
    const entry = state.sourceStore[id];
    return entry && entry.payload ? entry.payload : null;
  };

  function rebuild() {
    const merged = buildCatalog({
      spec: payloadOf('models-dev-spec'),
      openrouter: payloadOf('openrouter-public'),
      benchmarks: payloadOf('openrouter-keyed'),
      lmarena: payloadOf('lmarena'),
    });
    state.catalog = {
      fetchedAt: state.lastSyncAt,
      rows: merged.rows,
      byId: merged.byId,
      fits: merged.fits,
      // Not part of the reference — the opposite of it. Kept so a provider that
      // publishes no modality can still be told one of its listings is a
      // generator (ref §3 step 4).
      nonTextIndex: buildMatchIndex(merged.nonText || []),
    };
    const measured = merged.rows.filter((r) => r.score_source === 'aa').length;
    const estimated = merged.rows.filter((r) => r.score_source === 'est').length;
    log(`catalog rows=${merged.rows.length} measured=${measured} estimated=${estimated}`
      + ` unrated=${merged.rows.length - measured - estimated}`);
  }

  /** Read every cached source from disk and build the reference. Safe when empty. */
  function loadCache() {
    let newest = null;
    for (const source of sources.SOURCES) {
      let cached;
      try {
        cached = sources.readCache(source.id);
      } catch (error) {
        state.sourceStore[source.id] = { ...emptySource(), error: `cache read failed: ${error.message}` };
        continue;
      }
      if (!cached) continue;
      const { payload, meta } = cached;
      const errorStub = meta.error && payload && typeof payload === 'object'
        && Object.keys(payload).length === 1 && typeof payload.error === 'string';
      // Both branches spread emptySource so all six fields always exist. The
      // original declared four here, and the error-stub branch matched that —
      // which is how a source cached in an error state became the one kind that
      // never reported itself stale (ref §13, test/engine.test.js).
      state.sourceStore[source.id] = errorStub
        ? {
          ...emptySource(),
          fetchedAt: meta.fetchedAt || null,
          lastAttemptAt: meta.lastAttemptAt || meta.fetchedAt || null,
          error: meta.error,
          stale: true,
        }
        : {
          fetchedAt: meta.fetchedAt || null,
          lastAttemptAt: meta.lastAttemptAt || meta.fetchedAt || null,
          error: meta.error || null,
          stale: Boolean(meta.stale || meta.error),
          rowCount: sources.rowCount(source.id, payload),
          payload,
        };
      if (meta.fetchedAt && (!newest || meta.fetchedAt > newest)) newest = meta.fetchedAt;
    }
    state.lastSyncAt = newest;
    rebuild();
  }

  function storeFetched(source, payload, at) {
    const rowCount = sources.rowCount(source.id, payload);
    state.sourceStore[source.id] = { fetchedAt: at, lastAttemptAt: at, error: null, stale: false, rowCount, payload };
    sources.writeCache(source.id, payload,
      { fetchedAt: at, lastAttemptAt: at, error: null, stale: false, rowCount });
  }

  function storeFailed(source, message, at) {
    const previous = state.sourceStore[source.id] || emptySource();
    state.sourceStore[source.id] = {
      ...previous, lastAttemptAt: at, error: message, stale: Boolean(previous.payload),
    };
    sources.writeCacheFailure(source.id, message, at);
  }

  function ageOfNewest() {
    const at = sources.newestFetchedAt();
    if (!at) return Infinity;
    const t = Date.parse(at);
    return Number.isFinite(t) ? Date.now() - t : Infinity;
  }

  /**
   * @param {{ force?: boolean }} opts  force ignores the TTL. The toolbar button,
   *   the background timer and the unscored trigger pass force; the per-row Fetch
   *   information button does not, so a click seconds after a sync re-merges in
   *   210 ms instead of paying five megabytes.
   */
  async function syncAll({ force = false } = {}) {
    if (state.syncing) {
      const error = new Error('sync already in progress');
      error.code = 'SYNC_IN_PROGRESS';
      throw error;
    }
    if (!force && ageOfNewest() < minAgeMs) {
      rebuild();
      return { ...summary(), skipped: true };
    }
    state.syncing = true;
    try {
      const results = await sources.fetchAll();
      const started = new Date().toISOString();
      for (const result of results) {
        const source = { id: result.id };
        if (result.error) storeFailed(source, result.error, started);
        else storeFetched(source, result.payload, started);
      }
      state.lastSyncAt = started;
      rebuild();
      // Whatever the reference can now score it could not score before, which is
      // the signal that the ids we gave up on deserve a second look.
      if (state.catalog.rows.some((r) => r.score != null)) unscorable.clear();
      return summary();
    } finally {
      state.syncing = false;
    }
  }

  function scoreRows(rows) {
    return attachScores(rows, state.catalog.rows);
  }

  function isNonTextModel(row) {
    if (!state.catalog.nonTextIndex) return false;
    return Boolean(lookupCatalogRow(row, state.catalog.nonTextIndex));
  }

  function unscoredIds(rows) {
    return rows.filter((r) => r.score == null && !unscorable.has(String(r.id)))
      .map((r) => String(r.id));
  }

  /**
   * The demand trigger the reference uses instead of a manual source-sync button
   * (ref §11 step 7): a row the reference cannot score is a reason to re-fetch,
   * once. Ids that stay unscored are remembered so a permanently unknown model
   * costs four downloads and then nothing.
   */
  async function syncIfUnscored(rows) {
    const pending = unscoredIds(rows);
    if (!pending.length) return { synced: false, scored: 0, unscored: [] };
    await syncAll({ force: true });
    const after = attachScores(rows.map((r) => ({ ...r })), state.catalog.rows);
    const scored = after.filter((r) => r.score != null).length;
    if (scored) unscorable.clear();
    else pending.forEach((id) => unscorable.add(id));
    return { synced: true, scored, unscored: pending };
  }

  function summary() {
    return {
      lastSyncAt: state.lastSyncAt,
      syncing: state.syncing,
      keyedAuthConfigured: Boolean(sources.readKey && sources.readKey()),
      catalogCount: state.catalog.rows.length,
      fits: state.catalog.fits,
      sources: sources.SOURCES.map((source) => {
        const entry = state.sourceStore[source.id] || emptySource();
        return { id: source.id, name: source.name, description: source.description,
          fetchedAt: entry.fetchedAt, lastAttemptAt: entry.lastAttemptAt,
          error: entry.error, stale: entry.stale, rowCount: entry.rowCount };
      }),
    };
  }

  function health() {
    const age = ageOfNewest();
    return { ...summary(),
      newestPayloadAgeMs: age === Infinity ? null : age,
      minSyncAgeMs: minAgeMs,
      unscorableCount: unscorable.size };
  }

  function unscorableSize() { return unscorable.size; }

  return { state, log, loadCache, syncAll, rebuild, scoreRows, isNonTextModel,
    unscoredIds, syncIfUnscored, unscorableSize, summary, health, minAgeMs };
}

module.exports = { createEngine, SOURCE_SYNC_MIN_AGE_MS };
```

- [ ] **Step 4: Run the tests**

```bash
npm test -- test/catalog/engine.test.js
```

Expected: PASS. If the `SYNC_IN_PROGRESS` case hangs, the fake's gate is the suspect, not the
engine — the flag must be released in a `finally`.

One deliberate simplification: the original used `Promise.allSettled` over per-source fetches;
this one takes the already-settled results from `sources.fetchAll()`. Same semantics, and it keeps
the decision "a source failed" in exactly one file.

- [ ] **Step 5: Commit**

```bash
git add src/catalog/engine.js test/catalog/engine.test.js
git commit -m "feat(catalog): the in-memory reference, rebuilt rather than stored

The merged catalog is never written to the database: it comes back from the four
cached payloads at boot in about 210 ms, so a provider row is always scored
against today's reference instead of whatever the reference said on the day the
provider last answered. The per-row Fetch information pass carries a 15-minute
TTL on the download while the merge always runs, and an id that cannot be scored
is remembered so it costs one extra sync and then nothing."
```

---

### Task 7: Migration v2 and the snapshot repository

**Files:**
- Modify: `src/db/migrations.js` (append a `version: 2` object after the `version: 1` one, before
  the closing `];` on line 132)
- Modify: `src/db/repos/secrets.js:8` (`SECRET_ORIGINS` gains `openRouterApiKey`)
- Create: `src/db/repos/snapshots.js`
- Modify: `src/db/index.js` (`createRepos` gains `snapshots`)
- Create: `test/db/snapshots.test.js`
- Modify: `test/db/open.test.js` (one version-2 case)
- Modify: `test/db/settings-secrets.test.js` (one `openRouterApiKey` case)

**Interfaces:**
- Consumes: the opened `better-sqlite3` handle, the way every other repo in `createRepos` does.
- Produces: `createSnapshotRepo(db)` → `{ read(providerId), write(providerId, snapshot),
  setLastSync(providerId, { at, ok, warning }), setHealth(providerId, modelId, health),
  getHealth(providerId, modelId), listProviderIds() }`. `read` returns `null` when there has never
  been a snapshot, otherwise the reference's exact object: `{ createdAt, fetchedAt, models:
  { id → entry }, lastGoodRows, lastSync, pendingDrop? }`. This is the `store` seam Task 8's
  `syncSnapshot` is written against. `write` is one `db.transaction`.

- [ ] **Step 1: Append migration version 2, additive only**

```js
  {
    version: 2,
    up(db) {
      db.exec(`
        -- The roster-level fields the reference kept at file level beside the
        -- per-model history (ref §10): when the history started, when the rows
        -- were fetched, how the last attempt ended, and a quarantined mass drop.
        CREATE TABLE snapshot_meta (
          provider_id       TEXT PRIMARY KEY,
          created_at        INTEGER NOT NULL,
          fetched_at        INTEGER,
          last_sync_json    TEXT,
          pending_drop_json TEXT
        );

        -- One row per provider+model: the snapshot's `models` entry and that
        -- model's provider-published facts together, so a sync writes history and
        -- rows in one transaction. Separate from `models` on purpose — see the
        -- two-writers deviation at the top of this plan. summary_json carries the
        -- provider's own facts with every derived field stripped (ref §10
        -- providerRowSnapshot); health_json holds one minimal request's verdict
        -- and its latency samples: { status, note, httpStatus, at,
        -- latencies: [{ at, ms }] }, newest sample last.
        CREATE TABLE roster_snapshot (
          provider_id  TEXT NOT NULL,
          model_id     TEXT NOT NULL,
          name         TEXT,
          first_seen   INTEGER NOT NULL,
          last_seen    INTEGER NOT NULL,
          removed_at   INTEGER,
          summary_json TEXT,
          health_json  TEXT,
          updated_at   INTEGER NOT NULL,
          PRIMARY KEY (provider_id, model_id)
        );
        CREATE INDEX roster_by_provider ON roster_snapshot(provider_id, removed_at);
      `);
    },
  },
```

Do **not** edit the `version: 1` entry, and do not `ALTER TABLE models` — the legacy page owns that
table until Plan B. `backupBeforeMigrate` in `src/db/index.js` already takes the `bak-v2` copy
before this runs.

- [ ] **Step 2: Write the failing repo tests**

```js
// test/db/snapshots.test.js
const test = require('node:test');
const assert = require('node:assert');
const { memoryStore, countRows } = require('../helpers');

const base = (over = {}) => ({
  createdAt: 1727000000000, fetchedAt: 1727100000000,
  models: {}, lastGoodRows: [], lastSync: null, ...over,
});

test('a provider with no snapshot reads null, not an empty object', async (t) => {
  const store = await memoryStore(t);
  assert.equal(store.repos.snapshots.read('nara'), null);
});

test('every file-level field the reference kept survives the round trip', async (t) => {
  const store = await memoryStore(t);
  const snapshot = base({
    models: {
      'a/model': { name: 'Model A', first_seen: 1727000000000, last_seen: 1727100000000 },
      'b/gone': { name: 'Gone', first_seen: 1726000000000, last_seen: 1726500000000, removed_at: 1726600000000 },
    },
    lastGoodRows: [{ id: 'a/model', name: 'Model A', context_tokens: 8192 }],
    lastSync: { at: 1727100000000, ok: true, warning: null },
  });
  store.repos.snapshots.write('nara', snapshot);
  assert.deepEqual(store.repos.snapshots.read('nara'), snapshot);
});

test('pendingDrop is present only while a mass drop is quarantined', async (t) => {
  const store = await memoryStore(t);
  store.repos.snapshots.write('nara', base({
    pendingDrop: { count: 3, sha256: 'x'.repeat(64), attempts: 2, firstSeenAt: 5 },
  }));
  assert.equal(store.repos.snapshots.read('nara').pendingDrop.attempts, 2);
  store.repos.snapshots.write('nara', base());
  assert.equal(store.repos.snapshots.read('nara').pendingDrop, undefined,
    'a cleared quarantine must not read back as a live claim');
});

test('two providers never read each other, and a second write replaces the first', async (t) => {
  const store = await memoryStore(t);
  store.repos.snapshots.write('nara', base({ createdAt: 1 }));
  store.repos.snapshots.write('mirai', base({ createdAt: 9 }));
  assert.equal(countRows(store.db, 'snapshot_meta'), 2);
  store.repos.snapshots.write('nara', base({ createdAt: 3 }));
  assert.equal(countRows(store.db, 'snapshot_meta'), 2, 'replaced, not appended');
  assert.equal(store.repos.snapshots.read('nara').createdAt, 3);
  assert.equal(store.repos.snapshots.read('mirai').createdAt, 9);
});

test('setLastSync records a failed attempt without touching the rows it failed to replace', async (t) => {
  const store = await memoryStore(t);
  store.repos.snapshots.write('nara', base({
    fetchedAt: 2, lastGoodRows: [{ id: 'm' }], lastSync: { at: 2, ok: true, warning: null },
  }));
  store.repos.snapshots.setLastSync('nara', { at: 3, ok: false, warning: 'HTTP 503' });
  const read = store.repos.snapshots.read('nara');
  assert.deepEqual(read.lastSync, { at: 3, ok: false, warning: 'HTTP 503' });
  assert.deepEqual(read.lastGoodRows, [{ id: 'm' }]);
  assert.equal(read.fetchedAt, 2, 'fetchedAt answers "how old are these rows"; lastSync answers "did the last attempt work"');
});

test('setLastSync for an unknown provider creates the row so the very first failure is not lost', async (t) => {
  const store = await memoryStore(t);
  store.repos.snapshots.setLastSync('darkapi', { at: 3, ok: false, warning: 'no route' });
  assert.deepEqual(store.repos.snapshots.read('darkapi').lastSync,
    { at: 3, ok: false, warning: 'no route' });
});

test('a warning longer than 200 characters is clipped, as the reference clips it', async (t) => {
  const store = await memoryStore(t);
  store.repos.snapshots.setLastSync('nara', { at: 1, ok: false, warning: 'x'.repeat(500) });
  assert.equal(store.repos.snapshots.read('nara').lastSync.warning.length, 200);
});

test('listProviderIds is the set that has ever produced a snapshot', async (t) => {
  const store = await memoryStore(t);
  store.repos.snapshots.write('nara', base());
  store.repos.snapshots.write('mirai', base());
  assert.deepEqual(store.repos.snapshots.listProviderIds(), ['mirai', 'nara']);
});
```

- [ ] **Step 3: Run them and confirm they fail**

```bash
npm test -- test/db/snapshots.test.js
```

Expected: FAIL — `Cannot read properties of undefined (reading 'read')`.

- [ ] **Step 4: Write the repo**

```js
// src/db/repos/snapshots.js
'use strict';

// One provider's roster, split across the two tables the reference kept in one
// JSON file: snapshot_meta holds the file-level fields, roster_snapshot holds
// each model's history entry and the provider's own facts for it. Assembled here
// so src/catalog/snapshot.js sees the same object shape the reference did, and
// so one sync is one transaction — a half-written roster can never become the
// baseline the next sync is diffed against.

const WARNING_MAX = 200;

function clip(text) {
  if (typeof text !== 'string') return text == null ? null : String(text);
  return text.length > WARNING_MAX ? text.slice(0, WARNING_MAX) : text;
}

function createSnapshotRepo(db) {
  const readMeta = db.prepare('SELECT * FROM snapshot_meta WHERE provider_id = ?');
  const readRows = db.prepare('SELECT * FROM roster_snapshot WHERE provider_id = ?');
  const writeMeta = db.prepare(`
    INSERT INTO snapshot_meta (provider_id, created_at, fetched_at, last_sync_json, pending_drop_json)
    VALUES (@provider_id, @created_at, @fetched_at, @last_sync_json, @pending_drop_json)
    ON CONFLICT(provider_id) DO UPDATE SET
      created_at = @created_at, fetched_at = @fetched_at,
      last_sync_json = @last_sync_json, pending_drop_json = @pending_drop_json
  `);
  const writeRow = db.prepare(`
    INSERT INTO roster_snapshot
      (provider_id, model_id, name, first_seen, last_seen, removed_at, summary_json, health_json, updated_at)
    VALUES (@provider_id, @model_id, @name, @first_seen, @last_seen, @removed_at, @summary_json, @health_json, @updated_at)
    ON CONFLICT(provider_id, model_id) DO UPDATE SET
      name = @name, first_seen = @first_seen, last_seen = @last_seen, removed_at = @removed_at,
      summary_json = @summary_json, updated_at = @updated_at
  `);
  // Health is written on its own: a health check must never rewrite the row's
  // history or its summary as a side effect of recording one probe.
  const writeHealth = db.prepare('UPDATE roster_snapshot SET health_json = ?, updated_at = ? WHERE provider_id = ? AND model_id = ?');
  const deleteRow = db.prepare('DELETE FROM roster_snapshot WHERE provider_id = ? AND model_id = ?');
  const listStmt = db.prepare('SELECT provider_id FROM snapshot_meta ORDER BY provider_id');

  const entryOf = (row) => {
    const entry = { name: row.name, first_seen: row.first_seen, last_seen: row.last_seen };
    if (row.removed_at != null) entry.removed_at = row.removed_at;
    return entry;
  };

  function read(providerId) {
    const meta = readMeta.get(providerId);
    if (!meta) return null;
    const rows = readRows.all(providerId);
    const models = {};
    const lastGoodRows = [];
    for (const row of rows) {
      models[row.model_id] = entryOf(row);
      // A tombstoned model is history, not a row the read path should serve.
      if (row.removed_at == null && row.summary_json) {
        lastGoodRows.push(JSON.parse(row.summary_json));
      }
    }
    const snapshot = {
      createdAt: meta.created_at,
      fetchedAt: meta.fetched_at,
      models,
      lastGoodRows,
      lastSync: meta.last_sync_json ? JSON.parse(meta.last_sync_json) : null,
    };
    // pendingDrop stays absent rather than null: syncSnapshot deletes the key when
    // a quarantine is confirmed, and `in` is how the diff asks whether one is live.
    // `is_new` is deliberately not a column. The reference never stored it either:
    // it is `first_seen !== createdAt` within the 7-day window, so it is computed
    // at read time by restoreLastGoodRows (Task 8) — storing it would freeze a
    // verdict that changes on its own as the clock moves.
    if (meta.pending_drop_json) snapshot.pendingDrop = JSON.parse(meta.pending_drop_json);
    return snapshot;
  }

  function write(providerId, snapshot) {
    const now = Date.now();
    const run = db.transaction(() => {
      writeMeta.run({
        provider_id: providerId,
        created_at: snapshot.createdAt,
        fetched_at: snapshot.fetchedAt == null ? null : snapshot.fetchedAt,
        last_sync_json: snapshot.lastSync ? JSON.stringify(snapshot.lastSync) : null,
        pending_drop_json: snapshot.pendingDrop ? JSON.stringify(snapshot.pendingDrop) : null,
      });

      // The summary travels with the history entry that names the same model, so
      // one row answers both "when have we seen this" and "what does the provider
      // say about it". A model in lastGoodRows but not in models is a provider
      // fact with no history — impossible after a sync, and refused here rather
      // than stored under a first_seen nobody observed.
      const summaries = new Map((snapshot.lastGoodRows || []).map((r) => [String(r.id), r]));
      const keep = new Set();
      for (const [id, entry] of Object.entries(snapshot.models || {})) {
        keep.add(id);
        const summary = summaries.get(id);
        writeRow.run({
          provider_id: providerId,
          model_id: id,
          name: entry.name ?? null,
          first_seen: entry.first_seen,
          last_seen: entry.last_seen,
          removed_at: entry.removed_at == null ? null : entry.removed_at,
          summary_json: summary ? JSON.stringify(summary) : null,
          health_json: null,
          updated_at: now,
        });
      }
      // `forget` in syncSnapshot deletes from snapshot.models before writing, so a
      // row that is gone from the object is gone from the table too.
      for (const row of readRows.all(providerId)) {
        if (!keep.has(row.model_id)) deleteRow.run(providerId, row.model_id);
      }
    });
    run();
  }

  // How an attempt ended, without touching the rows it failed to replace.
  function setLastSync(providerId, { at, ok, warning }) {
    const current = read(providerId) || { createdAt: at, fetchedAt: null, models: {}, lastGoodRows: [] };
    write(providerId, { ...current, lastSync: { at, ok: Boolean(ok), warning: clip(warning) } });
  }

  function setHealth(providerId, modelId, health) {
    const changed = writeHealth.run(health ? JSON.stringify(health) : null, Date.now(), providerId, modelId).changes;
    if (!changed) throw new Error(`unknown model ${providerId}/${modelId}`);
    return health;
  }

  function getHealth(providerId, modelId) {
    const row = readRows.all(providerId).find((r) => r.model_id === String(modelId));
    return row && row.health_json ? JSON.parse(row.health_json) : null;
  }

  return {
    read,
    write,
    setLastSync,
    setHealth,
    getHealth,
    listProviderIds: () => listStmt.all().map((r) => r.provider_id),
  };
}

module.exports = { createSnapshotRepo, WARNING_MAX };
```

- [ ] **Step 4b: Add the four cases that only exist because the snapshot is two tables**

Append to `test/db/snapshots.test.js`:

```js
test('a model that leaves the roster but keeps its history stays a tombstone and loses its summary', async (t) => {
  const store = await memoryStore(t);
  const repo = store.repos.snapshots;
  repo.write('nara', base({
    models: { m: { name: 'M', first_seen: 5, last_seen: 6 } },
    lastGoodRows: [{ id: 'm', name: 'M', context_tokens: 128 }],
  }));
  repo.write('nara', base({
    models: { m: { name: 'M', first_seen: 5, last_seen: 6, removed_at: 9 } },
    lastGoodRows: [],
  }));
  const read = repo.read('nara');
  assert.deepEqual(read.models.m, { name: 'M', first_seen: 5, last_seen: 6, removed_at: 9 });
  assert.deepEqual(read.lastGoodRows, [], 'a tombstone is history, not a row to serve');
  assert.equal(read.models.m.first_seen, 5, 'and the tombstone did not rewrite when it was first seen');
});

test('forgetting a model deletes its row, so it is not read as a removal', async (t) => {
  const store = await memoryStore(t);
  const repo = store.repos.snapshots;
  repo.write('nara', base({ models: { keep: { name: 'K', first_seen: 1, last_seen: 2 },
    drop: { name: 'D', first_seen: 1, last_seen: 2 } }, lastGoodRows: [{ id: 'keep' }, { id: 'drop' }] }));
  repo.write('nara', base({ models: { keep: { name: 'K', first_seen: 1, last_seen: 3 } },
    lastGoodRows: [{ id: 'keep' }] }));
  assert.deepEqual(Object.keys(repo.read('nara').models), ['keep']);
  assert.equal(countRows(store.db, 'roster_snapshot'), 1);
});

test('setHealth records a probe without rewriting the summary or the history', async (t) => {
  const store = await memoryStore(t);
  const repo = store.repos.snapshots;
  repo.write('nara', base({ models: { m: { name: 'M', first_seen: 5, last_seen: 6 } },
    lastGoodRows: [{ id: 'm', name: 'M', context_tokens: 128 }] }));
  const health = { status: 'healthy', note: 'Responded normally', httpStatus: 200, at: 99,
    latencies: [{ at: 99, ms: 812 }] };
  repo.setHealth('nara', 'm', health);
  assert.deepEqual(repo.getHealth('nara', 'm'), health);
  const read = repo.read('nara');
  assert.deepEqual(read.lastGoodRows, [{ id: 'm', name: 'M', context_tokens: 128 }],
    'the provider facts survived a health check');
  assert.equal(read.models.m.first_seen, 5);
});

test('setHealth for a model that is not in the roster throws instead of inventing a row', async (t) => {
  const store = await memoryStore(t);
  assert.throws(() => store.repos.snapshots.setHealth('nara', 'ghost', { status: 'ok' }), /unknown model/);
});
```


- [ ] **Step 5: Register it in `createRepos`**

In `src/db/index.js`, add the require beside the other repo requires and the entry in the object
`createRepos` returns (next to `catalog`, `history`, `providers`, `secrets`, `settings`):

```js
const { createSnapshotRepo } = require('./repos/snapshots');
// …in the returned object:
  snapshots: createSnapshotRepo(db),
```

- [ ] **Step 6: Run the repo tests, then add the schema case**

```bash
npm test -- test/db/snapshots.test.js
```

Expected: PASS. Then in `test/db/open.test.js`, beside the existing "schema v1: user_version, every
table…" case:

```js
test('schema v2 adds the two snapshot tables and touches models not at all', async (t) => {
  const store = await memoryStore(t);
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all().map((r) => r.name);
  assert.ok(tables.includes('snapshot_meta'));
  assert.ok(tables.includes('roster_snapshot'));
  const cols = store.db.prepare('PRAGMA table_info(models)').all().map((c) => c.name);
  assert.ok(cols.includes('bench_json'),
    'Plan A drops nothing: the current Models page still reads this column');
  assert.notOk(cols.includes('health_json'),
    'and adds nothing there either — the legacy page owns that table until Plan B');
  assert.equal(store.db.pragma('user_version', { simple: true }), 2);
});
```

That `bench_json` assertion is the deviation at the top of this plan turned into a test: it fails
the moment someone folds Plan B's destructive migration into this one. The `health_json` line
fails if anyone tries to shortcut the two-writer problem by writing into `models`.

- [ ] **Step 6b: Register the OpenRouter secret name so a key can be saved at all**

`src/db/repos/secrets.js:8` is `SECRET_ORIGINS = { aaApiKey: 'https://artificialanalysis.ai' }`, and
`save()` calls `known(name)` at line 35, which throws `Unknown secret "…"` for anything not in that
map. Without this step the engine reads a key that no one can store, and Task 11's status line is
permanently "no OpenRouter key". Add the entry — do not remove `aaApiKey`, the current Settings
page still saves it until Plan B:

```js
const SECRET_ORIGINS = {
  aaApiKey: 'https://artificialanalysis.ai',
  openRouterApiKey: 'https://openrouter.ai',
};
```

Then in `test/db/settings-secrets.test.js`, beside the existing `aaApiKey` cases:

```js
test('openRouterApiKey is a known secret bound to openrouter.ai', async (t) => {
  const store = await memoryStore(t);
  // save() answers whether one is stored — the placeholder is built in db/ipc.js:62.
  assert.equal(store.repos.secrets.save('openRouterApiKey', 'sk-or-v1-test'), true);
  assert.equal(store.repos.secrets.has('openRouterApiKey'), true);
  assert.equal(store.repos.secrets.reveal('openRouterApiKey'), 'sk-or-v1-test');
  assert.equal(SECRET_ORIGINS.openRouterApiKey, 'https://openrouter.ai');
  assert.throws(() => store.repos.secrets.save('someOtherKey', 'x'), /Unknown secret/);
});
```

Note the origin's purpose: it is what lets `createKeyResolver` substitute the real secret at all,
and only for a request whose origin matches (`src/db/keys.js`). In Plan A the key is read directly
in main by `startCatalog`, so no placeholder travels and the origin is registered for Plan B's
request path.

- [ ] **Step 7: Run the suite and commit**

```bash
npm test
git add src/db/migrations.js src/db/repos/secrets.js src/db/repos/snapshots.js src/db/index.js test/db/snapshots.test.js test/db/open.test.js test/db/settings-secrets.test.js
git commit -m "feat(db): the snapshot tables and the OpenRouter secret name

Two tables hold the roster the reference kept in cache/providers/<id>.json: one
row of provider-level facts, one row per model carrying its history and the
provider's own facts with every derived field stripped, so a sync writes both in
one transaction and a half-written roster can never become the baseline the next
diff is measured against. Deliberately additive and deliberately not the models
table — the legacy write-catalog path still owns that one, and two writers on a
table is the bug CLAUDE.md was written about. is_new is not a column because the
reference never stored it either: it is a window over first_seen, computed on
read."
```

---

### Task 8: `snapshot.js` — windows, `moved`, tombstones and quarantine

**Files:**
- Create: `src/catalog/snapshot.js`
- Create: `test/catalog/snapshot.test.js`, `test/catalog/non-text.test.js`
- Copy from: `E:\01-Projects\ven-catalog\test\snapshot.test.js` (385 lines),
  `E:\01-Projects\ven-catalog\test\non-text.test.js` (234 lines)
- Reference: `E:\01-Projects\ven-catalog\providers\index.js` lines 130-428

**Interfaces:**
- Consumes: a `store` seam `{ read(providerId), write(providerId, snapshot) }` — satisfied by
  `repos.snapshots` from Task 7 and by a `Map` in tests.
- Produces:
  `syncSnapshot(store, providerId, rows, now, forget = []) → { baseline, since, added, removed, moved }`;
  `validateProviderRows(providerId, rows)`; `providerRowSnapshot(row)`; `cloneRows(rows)`;
  `restoreLastGoodRows(snapshot, now)`; `declaresNonTextOutput(row)`;
  `dropNonText({ provider, rows, isNonTextModel }) → { kept, dropped }`;
  `providerIdContract(rows) → { count, sha256 }`;
  constants `NEW_WINDOW_DAYS = 7`, `REMOVED_WINDOW_DAYS = 30`, `DROP_CONFIRMATION_MS` = 6 h,
  `DROP_MIN_PREVIOUS = 5`, `DROP_MIN_LOSS = 3`, and `DERIVED_FIELDS`, `BLANK_STRING_FIELDS`.

- [ ] **Step 1: Read both upstream test files before writing anything**

They are the specification for this task: filtering-is-not-removal, the 7/30-day windows,
tombstones preserving `first_seen`, `moved` as the only edge, the baseline never flagging new, and
quarantine persisting before mutation. Do not port them mechanically — the assertions are the
requirements.

- [ ] **Step 2: Copy the tests and convert every directory to a store**

```bash
cp "E:/01-Projects/ven-catalog/test/snapshot.test.js" test/catalog/snapshot.test.js
cp "E:/01-Projects/ven-catalog/test/non-text.test.js" test/catalog/non-text.test.js
```

Three mechanical changes across both files. Requires:

```js
const { syncSnapshot, dropNonText, validateProviderRows, providerRowSnapshot,
  restoreLastGoodRows, declaresNonTextOutput, providerIdContract,
  DERIVED_FIELDS, NEW_WINDOW_DAYS, REMOVED_WINDOW_DAYS, DROP_CONFIRMATION_MS } =
  require('../../src/catalog/snapshot');
```

The store, replacing every temp-directory fixture (the upstream `dir` argument disappears):

```js
function memStore() {
  const files = new Map();
  return {
    read: (id) => (files.has(id) ? structuredClone(files.get(id)) : null),
    write: (id, snapshot) => { files.set(id, structuredClone(snapshot)); },
    dump: (id) => files.get(id),
  };
}
```

Every file read-back becomes a store read, and the signature drops `dir`:

```js
// old: syncSnapshot('provider', rows, now, dir)
// old: JSON.parse(fs.readFileSync(path.join(dir, "provider.json"), "utf8"))
// new: syncSnapshot(store, 'provider', rows, now)
// new: store.dump('provider')
```

`engine.isNonTextModel(row)` in `non-text.test.js` becomes the injected
`isNonTextModel` argument — that is the seam this app needs anyway, because the engine lives in
main and the filter runs in ingest:

```js
// old: dropNonText(provider, rows)
// new: dropNonText({ provider, rows, isNonTextModel })
```

Timestamps: the upstream files use ISO strings and compare them with `daysBetween(a, b)` on parsed
values. This repo stores epoch integers everywhere (`first_seen INTEGER`), so replace every ISO
literal in the two test files with an integer millisecond value and use the same anchor:

```js
const DAY = 86400000;
const T0 = 1727000000000;   // a fixed anchor; tests must not depend on the clock
```

- [ ] **Step 3: Run them and confirm they fail**

```bash
npm test -- test/catalog/snapshot.test.js test/catalog/non-text.test.js
```

Expected: FAIL — `Cannot find module '../../src/catalog/snapshot'`.

- [ ] **Step 4: Write `src/catalog/snapshot.js`**

```js
// src/catalog/snapshot.js
'use strict';

// Change detection for one provider's roster, keeping three questions apart:
//   added / removed  WINDOWS — "what is new lately", still populated for days
//   moved            the EDGE — "did the roster change just now"
//   baseline         the first snapshot, where nothing is new by definition
// Only `moved` may gate a notice: gating on a window would make the read path
// refetch itself without bound (ref §12).

const crypto = require('crypto');

const NEW_WINDOW_DAYS = 7;
const REMOVED_WINDOW_DAYS = 30;
const DROP_CONFIRMATION_MS = 6 * 60 * 60 * 1000;
const DROP_MIN_PREVIOUS = 5;
const DROP_MIN_LOSS = 3;

function invalidPayload(providerId, detail) {
  const error = new Error(`${providerId} returned an invalid model list: ${detail}`);
  error.code = 'INVALID_PROVIDER_PAYLOAD';
  return error;
}

function suspiciousDrop(providerId, from, to) {
  const error = new Error(`${providerId} model count dropped from ${from} to ${to}; awaiting confirmation`);
  error.code = 'SUSPICIOUS_PROVIDER_DROP';
  return error;
}

const daysBetween = (from, to) => (to - from) / 86400000;

function validateProviderRows(providerId, rows) {
  if (!Array.isArray(rows)) throw invalidPayload(providerId, 'expected an array');
  if (!rows.length) throw invalidPayload(providerId, 'empty model list');
  const ids = new Set();
  for (const row of rows) {
    const id = row && String(row.id || '').trim();
    if (!id) throw invalidPayload(providerId, 'model is missing id');
    if (ids.has(id)) throw invalidPayload(providerId, `duplicate model id: ${id}`);
    ids.add(id);
  }
  return rows;
}

function cloneRows(rows) {
  return rows.map((row) => ({
    ...row,
    match_ids: Array.isArray(row.match_ids) ? [...row.match_ids] : row.match_ids,
    quality_proxy_ids: Array.isArray(row.quality_proxy_ids) ? [...row.quality_proxy_ids] : row.quality_proxy_ids,
    score_basis: Array.isArray(row.score_basis) ? [...row.score_basis] : row.score_basis,
    filled_from_catalog: Array.isArray(row.filled_from_catalog) ? [...row.filled_from_catalog] : row.filled_from_catalog,
  }));
}

// Everything the engine derives on each pass. None of it is stored with the
// last-good rows: a fallback row must be re-scored against today's reference,
// not replay what it said on the day the provider last answered.
const DERIVED_FIELDS = [
  'score', 'score_source', 'score_basis', 'rank', 'catalog_rank', 'matched_id', 'bench_id',
  'aa_intelligence', 'aa_coding', 'lmarena_elo', 'lmarena_rank', 'lmarena_code_rank',
  'score_proxy_for', 'is_new', 'first_seen', 'filled_from_catalog',
];
const BLANK_STRING_FIELDS = new Set(['input_modalities', 'output_modalities', 'release_date']);

/** The provider's own row: derived fields dropped, borrowed metadata blanked again. */
function providerRowSnapshot(row) {
  const stored = cloneRows([row])[0];
  const borrowed = stored.filled_from_catalog || [];
  for (const field of DERIVED_FIELDS) delete stored[field];
  for (const field of borrowed) {
    stored[field] = BLANK_STRING_FIELDS.has(field) ? '' : null;
  }
  return stored;
}

function restoreLastGoodRows(snapshot, now) {
  const rows = (snapshot.lastGoodRows || []).map(providerRowSnapshot);
  for (const row of rows) {
    const entry = snapshot.models && snapshot.models[String(row.id)];
    if (!entry) continue;
    row.first_seen = entry.first_seen;
    row.is_new = entry.first_seen !== snapshot.createdAt
      && daysBetween(entry.first_seen, now) <= NEW_WINDOW_DAYS;
  }
  return rows;
}

/** Does this row PROVE it cannot answer in text? Silence is not proof. */
function declaresNonTextOutput(row) {
  const out = String((row && row.output_modalities) || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
  return out.length > 0 && !out.includes('text');
}

/**
 * Three ways to know a listing is a generator, and one is enough: it published
 * the modality, this app enumerates it, or the reference recognises the model it
 * matches. Filtered ids travel as `forget` — the provider removed nothing, so a
 * tombstone and a removal notice would both say something untrue.
 */
function dropNonText({ provider, rows, isNonTextModel }) {
  const declared = (provider && provider.NON_TEXT_MODELS) || {};
  if (!Array.isArray(rows)) return { kept: rows, dropped: [] };
  const kept = rows.filter((row) => {
    if (declaresNonTextOutput(row)) return false;
    if (declared[String(row.id)]) return false;
    return !(isNonTextModel && isNonTextModel(row));
  });
  const dropped = rows.filter((row) => !kept.includes(row)).map((row) => String(row.id));
  return { kept, dropped };
}

/** Fingerprint of a candidate drop: the same set twice is one attempt counting, a different set restarts it. */
function providerIdContract(rows) {
  const ids = rows.map((r) => String(r.id)).sort();
  return { count: ids.length, sha256: crypto.createHash('sha256').update(ids.join('\n')).digest('hex') };
}

const activeCount = (snapshot) => Object.values(snapshot.models).filter((e) => !e.removed_at).length;

/**
 * @param {{ read: Function, write: Function }} store
 * @param {number} now  epoch ms — integers everywhere, as venom.db stores them
 * @param {string[]} forget  ids this app filtered out, not ids the provider removed
 */
function syncSnapshot(store, providerId, rows, now, forget = []) {
  validateProviderRows(providerId, rows);
  const previous = store.read(providerId);
  const snapshot = previous || { createdAt: now, fetchedAt: null, models: {} };

  if (previous) {
    const before = activeCount(previous);
    const largeDrop = before >= DROP_MIN_PREVIOUS
      && before - rows.length >= DROP_MIN_LOSS
      && rows.length < before / 2;
    if (largeDrop) {
      const contract = providerIdContract(rows);
      const same = previous.pendingDrop && previous.pendingDrop.sha256 === contract.sha256;
      const attempts = same ? previous.pendingDrop.attempts + 1 : 1;
      const firstSeenAt = same ? previous.pendingDrop.firstSeenAt : now;
      if (attempts < 3 || now - firstSeenAt < DROP_CONFIRMATION_MS) {
        // Written before anything else mutates, so a crash cannot reset the count
        // and a half-applied drop can never be the new baseline.
        store.write(providerId, { ...previous, pendingDrop: { ...contract, attempts, firstSeenAt } });
        throw suspiciousDrop(providerId, before, rows.length);
      }
    }
    delete snapshot.pendingDrop;
  }

  for (const id of forget) delete snapshot.models[String(id)];

  const currentIds = new Set(rows.map((row) => String(row.id)));
  const moved = { appeared: 0, disappeared: 0 };

  for (const row of rows) {
    const id = String(row.id);
    const entry = snapshot.models[id];
    if (entry) {
      // Back after being marked gone is a move exactly as a first sighting is.
      if (entry.removed_at) moved.appeared += 1;
      entry.name = row.name;
      entry.last_seen = now;
      delete entry.removed_at;
    } else {
      if (previous) moved.appeared += 1;
      snapshot.models[id] = { name: row.name, first_seen: now, last_seen: now };
    }
  }

  const added = [];
  const removed = [];
  for (const [id, entry] of Object.entries(snapshot.models)) {
    if (currentIds.has(id)) {
      const isNew = entry.first_seen !== snapshot.createdAt
        && daysBetween(entry.first_seen, now) <= NEW_WINDOW_DAYS;
      if (isNew) added.push({ id, name: entry.name, first_seen: entry.first_seen });
      continue;
    }
    if (!entry.removed_at) {
      entry.removed_at = now;
      moved.disappeared += 1;
    }
    if (daysBetween(entry.last_seen, now) <= REMOVED_WINDOW_DAYS) {
      removed.push({ id, name: entry.name, last_seen: entry.last_seen });
    }
  }

  const addedIds = new Set(added.map((a) => a.id));
  for (const row of rows) {
    const entry = snapshot.models[String(row.id)];
    row.first_seen = entry.first_seen;
    row.is_new = addedIds.has(String(row.id));
  }

  const since = snapshot.fetchedAt;
  snapshot.fetchedAt = now;
  snapshot.lastGoodRows = rows.map(providerRowSnapshot);
  snapshot.lastSync = { at: now, ok: true, warning: null };
  store.write(providerId, snapshot);
  return { baseline: !previous, since, added, removed, moved };
}

module.exports = {
  NEW_WINDOW_DAYS, REMOVED_WINDOW_DAYS, DROP_CONFIRMATION_MS, DROP_MIN_PREVIOUS, DROP_MIN_LOSS,
  DERIVED_FIELDS, BLANK_STRING_FIELDS, daysBetween,
  syncSnapshot, validateProviderRows, providerRowSnapshot, cloneRows, restoreLastGoodRows,
  declaresNonTextOutput, dropNonText, providerIdContract,
};
```

Two intentional differences from the original, both visible in the tests that came through: `now`
is epoch milliseconds, and `models` / `lastGoodRows` / `pendingDrop` are columns of one row rather
than keys of one JSON file. `filled_from_catalog` joins `DERIVED_FIELDS` because this app must not
store what it re-blanks on read.

- [ ] **Step 5: Run the ported tests**

```bash
npm test -- test/catalog/snapshot.test.js test/catalog/non-text.test.js
```

Expected: PASS. A quarantine failure here is almost always the timestamp type — fix the test
fixture's `now` values to integers, never the arithmetic.

- [ ] **Step 6: Add the three cases that exist only because the storage changed**

Append to `test/catalog/snapshot.test.js`:

```js
const DAY2 = 86400000;

function sixModels() {
  const models = {};
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
    models[id] = { name: id.toUpperCase(), first_seen: 1, last_seen: 2 };
  }
  return { createdAt: 1, fetchedAt: 2, models, lastGoodRows: [], lastSync: null };
}

test('quarantine freezes history: the counter persists and nothing is tombstoned', () => {
  const store = memStore();
  store.write('p', sixModels());
  assert.throws(() => syncSnapshot(store, 'p', [{ id: 'a', name: 'A' }], 3000),
    (e) => e.code === 'SUSPICIOUS_PROVIDER_DROP');
  const held = store.read('p');
  assert.equal(held.pendingDrop.attempts, 1);
  assert.equal(Object.keys(held.models).length, 6, 'no tombstone — the drop was not accepted');
  assert.equal(held.fetchedAt, 2, 'and the rows kept their age');
});

test('the same set three times over six hours is allowed through, and the claim clears', () => {
  const store = memStore();
  store.write('p', sixModels());
  const rows = [{ id: 'a', name: 'A' }];
  assert.throws(() => syncSnapshot(store, 'p', rows, 3000), (e) => e.code === 'SUSPICIOUS_PROVIDER_DROP');
  assert.throws(() => syncSnapshot(store, 'p', rows, 3000), (e) => e.code === 'SUSPICIOUS_PROVIDER_DROP');
  const out = syncSnapshot(store, 'p', rows, 3000 + DROP_CONFIRMATION_MS);
  assert.equal(out.removed.length, 5);
  assert.equal(store.read('p').pendingDrop, undefined);
});

test('a different candidate set restarts the attempt count rather than adding to it', () => {
  const store = memStore();
  store.write('p', sixModels());
  assert.throws(() => syncSnapshot(store, 'p', [{ id: 'a', name: 'A' }], 3000),
    (e) => e.code === 'SUSPICIOUS_PROVIDER_DROP');
  assert.throws(() => syncSnapshot(store, 'p', [{ id: 'b', name: 'B' }], 4000),
    (e) => e.code === 'SUSPICIOUS_PROVIDER_DROP');
  assert.equal(store.read('p').pendingDrop.attempts, 1, 'a new fingerprint is a new candidate');
});

test('a tombstone is kept forever, so a returning model keeps its first_seen and is not re-announced', () => {
  const store = memStore();
  syncSnapshot(store, 'p', [{ id: 'a', name: 'A' }], 1000);
  syncSnapshot(store, 'p', [{ id: 'b', name: 'B' }], 400 * DAY2);
  const held = store.read('p');
  assert.equal(held.models.a.removed_at, 400 * DAY2);
  assert.equal(held.models.a.first_seen, 1000);

  syncSnapshot(store, 'p', [{ id: 'a', name: 'A' }], 401 * DAY2);
  const back = store.read('p');
  assert.equal(back.models.a.first_seen, 1000, 'the original first_seen survives the return');
  assert.equal(back.models.a.removed_at, undefined);
  assert.equal(back.lastGoodRows[0].is_new, undefined, 'and it is not flagged new again');
});
```

- [ ] **Step 7: Run, then commit**

```bash
npm test
git add src/catalog/snapshot.js test/catalog/snapshot.test.js test/catalog/non-text.test.js
git commit -m "feat(catalog): roster change detection with quarantine

Added and removed are windows that stay populated for days after the single
change behind them, so only moved can gate a notice. A mass drop is fingerprinted
and quarantined until the same set is seen three times over six hours, and the
candidate is written before anything mutates so a crash cannot restart the count.
Listings this app filters out are forgotten, not tombstoned: the provider removed
nothing and a removal notice would claim otherwise."
```

---

### Task 9: `row.js` — an adapter model becomes the shared provider row

**Files:**
- Create: `src/catalog/row.js`
- Create: `test/catalog/row.test.js`

**Interfaces:**
- Consumes: `./util` (`asNumber`, `perMillion`, `uniqueJoin`, `unixToDate`, `boolOrNull`,
  `hasParam`, `providerOf`, `listHas`).
- Produces: `providerRow(model, providerId) →` the ref §8.1 shape and nothing else:
  `id, name, description, family, context_tokens, output_tokens, input_modalities,
  output_modalities, tools, reasoning, structured, attachment, cost_in_per_m, cost_out_per_m,
  cost_kind, release_date, status`. Also `costKind({ inCost, outCost })`, `readPricing(m)`,
  `readsTools(m)`, `readsReasoning(m)`, `readsStructured(m)`, `readsAttachment(m)`,
  `matchIds(id)`, `qualityProxyIds(id)`, `FILLED_EMPTY`.

- [ ] **Step 1: Write the failing tests**

This file's whole purpose is that the eight price shapes the app already accepts keep working, and
that an absent fact never reads as `false`. Both are asserted, not described.

```js
// test/catalog/row.test.js
const test = require('node:test');
const assert = require('node:assert');
const { providerRow, costKind, matchIds, qualityProxyIds, ROW_FIELDS } = require('../../src/catalog/row');

const base = (over = {}) => ({ id: 'lab/model', name: 'Model', ...over });
const day = new Date(1727000000000).toISOString().slice(0, 10);

test('the row is exactly the reference shape, with nothing invented', () => {
  assert.deepEqual(Object.keys(providerRow(base(), 'nara')).sort(), [...ROW_FIELDS].sort());
});

test('an absent capability is null, never false — the rule the port rests on', () => {
  const row = providerRow(base(), 'nara');
  for (const field of ['tools', 'reasoning', 'structured', 'attachment',
    'context_tokens', 'output_tokens', 'cost_in_per_m', 'cost_out_per_m']) {
    assert.equal(row[field], null, `${field} must stay null when nobody published it`);
  }
  assert.equal(row.release_date, '', 'dates read as empty string');
  assert.equal(row.input_modalities, '');
  assert.equal(row.output_modalities, '');
  assert.equal(row.description, '');
  assert.equal(row.status, 'active');
});

test('today\'s !!m.hasVision is gone: vision unknown is not vision refused', () => {
  assert.equal(providerRow(base(), 'nara').attachment, null);
  assert.equal(providerRow(base({ modalities: { input: ['image'] } }), 'nara').attachment, null,
    'image input is an attachment claim only for file/pdf/document');
  assert.equal(providerRow(base({ modalities: { input: ['file', 'text'] } }), 'nara').attachment, true);
});

test('eight price spellings all land on cost per million', () => {
  const shapes = [
    { pricing: { input_usd_per_1m: 2, output_usd_per_1m: 10 } },
    { pricing: { input_per_1m: 2, output_per_1m: 10 } },
    { input_price_per_1m: 2, output_price_per_1m: 10 },
    { price_input: 2, price_output: 10 },
    { pricing: { prompt: '0.000002', completion: '0.00001' } },
    { input_cost_per_token: 0.000002, output_cost_per_token: 0.00001 },
    { pricing: { input: 2, output: 10 } },
    { isFree: true },
  ];
  shapes.forEach((shape, i) => {
    const row = providerRow(base(shape), 'nara');
    assert.equal(row.cost_in_per_m, i === 7 ? 0 : 2, `shape ${i} input`);
    assert.equal(row.cost_out_per_m, i === 7 ? 0 : 10, `shape ${i} output`);
  });
  assert.equal(costKind({ inCost: 0, outCost: 0 }), 'free');
  assert.equal(costKind({ inCost: 2, outCost: 10 }), 'token');
});

test('a negative published price reads as null, and the kind says unknown', () => {
  const row = providerRow(base({ pricing: { prompt: '-1', completion: '-1' } }), 'nara');
  assert.equal(row.cost_in_per_m, null);
  assert.equal(row.cost_out_per_m, null);
  assert.equal(row.cost_kind, 'unknown');
});

test('one free leg with no priced other leg is free, per the reference rule', () => {
  assert.equal(costKind({ inCost: 0, outCost: null }), 'free');
  assert.equal(costKind({ inCost: null, outCost: null }), 'unknown');
});

test('tools is read from every place a provider puts it, and stays null when none answer', () => {
  for (const shape of [{ supports_tools: true }, { supports_function_calling: true },
    { tool_call: true }, { capabilities: ['tools'] }, { capabilities: ['function_calling'] },
    { supported_parameters: ['tools'] }]) {
    assert.equal(providerRow(base(shape), 'nara').tools, true, JSON.stringify(shape));
  }
  assert.equal(providerRow(base({ supported_parameters: ['temperature'] }), 'nara').tools, null);
  assert.equal(providerRow(base({ supports_tools: false }), 'nara').tools, false,
    'a published false is an answer');
});

test('reasoning comes from the flag, the parameters, then the route name', () => {
  assert.equal(providerRow(base({ hasReasoning: true }), 'nara').reasoning, true);
  assert.equal(providerRow(base({ reasoning: true }), 'nara').reasoning, true);
  assert.equal(providerRow(base({ supported_parameters: ['include_reasoning'] }), 'nara').reasoning, true);
  assert.equal(providerRow(base({ id: 'lab/model-thinking' }), 'nara').reasoning, true,
    'a thinking route thinks; silence must not outrank the provider naming it');
  assert.equal(providerRow(base({ reasoning: false }), 'nara').reasoning, false);
});

test('modalities join both source spellings and dedupe case-insensitively', () => {
  const row = providerRow(base({
    modalities: { input: ['text', 'image'], output: ['text'] },
    architecture: { input_modalities: ['image', 'audio'], output_modalities: ['text', 'image'] },
  }), 'nara');
  assert.equal(row.input_modalities, 'text, image, audio');
  assert.equal(row.output_modalities, 'text, image');
});

test('output limit comes from four places, first real answer wins', () => {
  assert.equal(providerRow(base({ max_output_tokens: 4096 }), 'nara').output_tokens, 4096);
  assert.equal(providerRow(base({ max_completion_tokens: 2048 }), 'nara').output_tokens, 2048);
  assert.equal(providerRow(base({ top_provider: { max_completion_tokens: 1024 } }), 'nara').output_tokens, 1024);
  assert.equal(providerRow(base({ limit: { output: 512 } }), 'nara').output_tokens, 512);
});

test('context comes from limit, context_length or context_window', () => {
  assert.equal(providerRow(base({ limit: { context: 200000 } }), 'nara').context_tokens, 200000);
  assert.equal(providerRow(base({ context_length: 100000 }), 'nara').context_tokens, 100000);
  assert.equal(providerRow(base({ context_window: 32768 }), 'nara').context_tokens, 32768);
});

test('a created stamp becomes a release date, and a published date wins', () => {
  assert.equal(providerRow(base({ created: 1727000000 }), 'nara').release_date, day);
  assert.equal(providerRow(base({ created: 1727000000, release_date: '2026-01-02' }), 'nara').release_date, '2026-01-02');
});

test('name falls back to the id and a leading lab prefix is stripped', () => {
  assert.equal(providerRow({ id: 'lab/only-id' }, 'nara').name, 'lab/only-id');
  assert.equal(providerRow(base({ name: 'Anthropic: Claude Fable' }), 'nara').name, 'Claude Fable');
});

test('family is owned_by, then the id prefix, then empty', () => {
  assert.equal(providerRow(base({ owned_by: 'anthropic' }), 'nara').family, 'anthropic');
  assert.equal(providerRow({ id: 'google/gemini-4' }, 'nara').family, 'google');
  assert.equal(providerRow(base(), 'nara').family, '');
});

test('status is kept when published and active otherwise', () => {
  assert.equal(providerRow(base({ status: 'deprecated' }), 'nara').status, 'deprecated');
  assert.equal(providerRow(base(), 'nara').status, 'active');
});

test('a nexum-style thin row publishes nothing and therefore claims nothing', () => {
  const row = providerRow({ id: 'nexum/kimi-k3-thinking' }, 'nexum');
  assert.equal(row.tools, null);
  assert.equal(row.context_tokens, null);
  assert.equal(row.output_modalities, '');
  assert.equal(row.reasoning, true);
  assert.equal(row.cost_kind, 'unknown');
  assert.deepEqual(matchIds('nexum/kimi-k3-thinking').length > 0, true);
});

test('matchIds emits the variants the reference matched on, quality tokens kept', () => {
  const ids = matchIds('nexum/deepseek-v4-thinking');
  assert.ok(ids.some((k) => k.includes('deepseek')));
  assert.ok(ids.some((k) => k.includes('v4')));
  assert.ok(!ids.some((k) => k.includes('nexum')), 'the routing prefix is not identity');
});

test('qualityProxyIds points a thinking route at its base route', () => {
  assert.deepEqual(qualityProxyIds('nexum/deepseek-v4-thinking'), ['deepseek/deepseek-v4']);
  assert.deepEqual(qualityProxyIds('nexum/deepseek-v4'), []);
});
```

- [ ] **Step 2: Run and confirm they fail**

```bash
npm test -- test/catalog/row.test.js
```

Expected: FAIL — `Cannot find module '../../src/catalog/row'`.

- [ ] **Step 3: Write `src/catalog/row.js`**

```js
// src/catalog/row.js
'use strict';

// One adapter's model object → the shared provider row the reference merge
// expects (ref §8.1). The readers move here from src/renderer/catalog.js
// (readPricing 151-167, readsTools 169-176, summarizeModel 178-194) and change in
// one respect: an absent fact stays null. Today's `!!m.hasVision` turns "nobody
// said" into "it cannot", and that then gets stored, sorted and routed on.
//
// This runs in main over whatever the renderer's adapter produced, so it assumes
// a set of field names rather than a shape — the same names the last several
// years of OpenAI-compatible gateways have put prices under.

const {
  asNumber, perMillion, uniqueJoin, unixToDate, boolOrNull, hasParam, listHas, providerOf,
} = require('./util');

const ROW_FIELDS = ['id', 'name', 'description', 'family', 'context_tokens', 'output_tokens',
  'input_modalities', 'output_modalities', 'tools', 'reasoning', 'structured', 'attachment',
  'cost_in_per_m', 'cost_out_per_m', 'cost_kind', 'release_date', 'status'];

const firstNumber = (...values) => {
  for (const value of values) {
    const n = asNumber(value);
    if (n !== null) return n;
  }
  return null;
};

// A published negative is OpenRouter's -1 sentinel, not a price (ref §16.4).
const positive = (value) => {
  const n = asNumber(value);
  return n == null || n < 0 ? null : n;
};

const pick = (obj, name) => (obj && obj[name] != null ? obj[name] : null);

function costKind({ inCost, outCost }) {
  if (inCost == null && outCost == null) return 'unknown';
  if (inCost === 0 && (outCost === 0 || outCost == null)) return 'free';
  return 'token';
}

/** The eight shapes src/renderer/catalog.js readPricing already accepted. */
function readPricing(m) {
  const pr = m.pricing || {};
  let input = firstNumber(m.input_price_per_1m, m.price_input,
    pick(pr, 'input_usd_per_1m'), pick(pr, 'input_per_1m'));
  let output = firstNumber(m.output_price_per_1m, m.price_output,
    pick(pr, 'output_usd_per_1m'), pick(pr, 'output_per_1m'));
  const perTokenIn = firstNumber(pick(pr, 'prompt'), m.input_cost_per_token);
  const perTokenOut = firstNumber(pick(pr, 'completion'), m.output_cost_per_token);
  if (input === null && perTokenIn !== null) input = perMillion(perTokenIn);
  if (output === null && perTokenOut !== null) output = perMillion(perTokenOut);
  if (input === null) input = asNumber(pick(pr, 'input'));
  if (output === null) output = asNumber(pick(pr, 'output'));
  if (input === null && output === null) {
    if (m.isFree) return { input: 0, output: 0 };
    return { input: null, output: null };
  }
  return { input: positive(input), output: positive(output) };
}

function readsTools(m) {
  const direct = boolOrNull(m.supports_tools != null ? m.supports_tools
    : m.supports_function_calling != null ? m.supports_function_calling : m.tool_call);
  if (direct !== null) return direct;
  if (Array.isArray(m.capabilities)
    && (m.capabilities.includes('tools') || m.capabilities.includes('function_calling'))) return true;
  if (hasParam(m.supported_parameters, 'tools')) return true;
  return null;
}

function readsReasoning(m) {
  const direct = boolOrNull(m.hasReasoning != null ? m.hasReasoning : m.reasoning);
  if (direct !== null) return direct;
  if (hasParam(m.supported_parameters, 'include_reasoning')
    || hasParam(m.supported_parameters, 'reasoning')) return true;
  // A route that calls itself a thinking route thinks. Reading it as unknown
  // would rank the provider's own claim below its silence.
  return /(?:^|-)thinking$|reasoner/i.test(String(m.id || '')) ? true : null;
}

function readsStructured(m) {
  const direct = boolOrNull(m.structured_output);
  if (direct !== null) return direct;
  if (hasParam(m.supported_parameters, 'response_format')
    || hasParam(m.supported_parameters, 'structured_outputs')) return true;
  return null;
}

function readsAttachment(m) {
  const direct = boolOrNull(m.attachment);
  if (direct !== null) return direct;
  const input = uniqueJoin([m.modalities && m.modalities.input,
    m.architecture && m.architecture.input_modalities]);
  if (listHas(input, 'file') || listHas(input, 'pdf') || listHas(input, 'document')) return true;
  return null;
}

/**
 * The aliases a thin, route-prefixed id needs to reach the reference: the last
 * segment, and the lab-name-plus-number form some hosts use. Ported from
 * providers/nexum-router.js matchIds (ref §8.2) because the provider that needs
 * it most publishes nothing else about itself.
 */
function matchIds(id) {
  const cleaned = String(id || '').toLowerCase().replace(/^~/, '').split(':')[0];
  const segments = cleaned.split('/').filter(Boolean);
  if (!segments.length) return [];
  const out = new Set();
  const rest = segments.slice(1).join('-');
  const lab = segments[0];
  if (rest) {
    out.add(rest);
    out.add(`${lab}${rest}`);
    out.add(`${lab}/${rest}`);
    const repaired = rest.replace(/-v-/g, '-v').replace(/v(\d)/g, '-v$1');
    if (repaired !== rest) out.add(repaired);
  }
  out.add(segments[segments.length - 1]);
  return [...out].filter((k) => k && k !== lab);
}

/** For a `-thinking` route, the base route's first match id — its quality proxy. */
function qualityProxyIds(id) {
  const cleaned = String(id || '').toLowerCase();
  if (!/-thinking$/.test(cleaned)) return [];
  const base = cleaned.replace(/-thinking$/, '');
  const first = matchIds(base)[0];
  return first ? [first] : [];
}

function providerRow(model, providerId) {
  const m = model || {};
  const id = String(m.id || '');
  const pricing = readPricing(m);
  const modalities = m.modalities || {};
  const architecture = m.architecture || {};
  const row = {
    id,
    name: String(m.name || id).replace(/^[^:]+:\s*/, '') || id,
    description: m.description || '',
    family: m.owned_by || m.ownedBy || providerOf(id) || '',
    context_tokens: firstNumber(m.limit && m.limit.context, m.context_length, m.context_window),
    output_tokens: firstNumber(m.limit && m.limit.output, m.max_output_tokens, m.max_completion_tokens,
      m.top_provider && m.top_provider.max_completion_tokens),
    input_modalities: uniqueJoin([modalities.input, architecture.input_modalities]),
    output_modalities: uniqueJoin([modalities.output, architecture.output_modalities]),
    tools: readsTools(m),
    reasoning: readsReasoning(m),
    structured: readsStructured(m),
    attachment: readsAttachment(m),
    cost_in_per_m: pricing.input,
    cost_out_per_m: pricing.output,
    cost_kind: m.cost_kind || costKind({ inCost: pricing.input, outCost: pricing.output }),
    release_date: m.release_date || unixToDate(m.created),
    status: m.status || 'active',
  };
  // The reference drops every entry with no id; saying it here means a malformed
  // adapter row is refused at the door rather than becoming a catalog entry keyed
  // by the empty string.
  if (!row.id) throw new Error(`${providerId} listed a model with no id`);
  return row;
}

module.exports = {
  ROW_FIELDS, providerRow, readPricing, costKind,
  readsTools, readsReasoning, readsStructured, readsAttachment, matchIds, qualityProxyIds,
};
```

- [ ] **Step 4: Run the tests**

```bash
npm test -- test/catalog/row.test.js
```

Expected: PASS. If `matchIds('nexum/deepseek-v4-thinking')` keeps `nexum` in a variant, the
`filter` on the last line of `matchIds` is what removes it — fix there, not in the test.

- [ ] **Step 5: Commit**

```bash
git add src/catalog/row.js test/catalog/row.test.js
git commit -m "feat(catalog): map any adapter model to the shared provider row

The eight price spellings the renderer already accepted move here unchanged in
what they take, with one rule added: unknown stays null. A published negative is
OpenRouter's -1 sentinel rather than a price, and an absent hasVision is not a
vision capability that was refused — the difference between a gap in the data and
a claim about the model."
```

---

### Task 10: `ipc.js` — the five channels, the single-flight door, main wiring

**Files:**
- Create: `src/catalog/ipc.js`
- Modify: `src/main.js` (build the engine beside `startLogs()`, register after `registerDataIpc`)
- Modify: `src/preload.js` (five entries)
- Create: `test/catalog/ipc.test.js`

**Interfaces:**
- Consumes: `createEngine` (Task 6), `createSources` (Task 5), `createFetcher` (Task 4),
  `providerRow` (Task 9), `syncSnapshot` / `dropNonText` / `validateProviderRows` (Task 8),
  `repos.snapshots` (Task 7), `repos.secrets` (existing, for the OpenRouter key).
- Produces, as the IPC surface spec §6 names:
  - `catalog:ingest(providerId, rows)` → `{ ok, rows, changes, stale, warning }`
  - `catalog:read()` → `{ rows, readAt, oldestFetch, stale, lastSyncAt, catalogCount }`
  - `catalog:health(providerId, modelId, result)` → `{ p50, samples }`
  - `catalog:sources({ force })` → the engine's `summary()`
  - `catalog:fetch-info(providerId, modelId, rows)` → `{ outcome, before, after, changes }` where
    `outcome` is one of `'matched' | 'updated' | 'no-match' | 'no-longer-listed'`
  - `createCatalogIpc({ ipcMain, repos, engine, log })` — registers the five channels.
    `src/main.js` builds the pieces (`createFetcher` → `createSources` → `createEngine` →
    `createCatalogIpc`) in a `startCatalog({ repos, log })` helper, Step 5.

Why `fetch-info` receives rows rather than fetching them: the provider adapters live in the
renderer because they own discovery and auth (spec §3), and the renderer holds only key
placeholders. Main therefore never learns a URL-to-key relationship it did not already have.

- [ ] **Step 1: Write the failing IPC tests**

```js
// test/catalog/ipc.test.js
const test = require('node:test');
const assert = require('node:assert');
const { createCatalogIpc, COMPARE_FIELDS, diffRow } = require('../../src/catalog/ipc');
const { providerRow } = require('../../src/catalog/row');

// A fake ipcMain that records handlers, plus a fake repos with the seam the real
// one has. No electron, no database: the channel contract is what is under test.
function harness({ snapshots, engine } = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn) };
  const calls = [];
  const log = { info: (...a) => calls.push(a), warn: () => {}, error: () => {} };
  createCatalogIpc({
    ipcMain, log,
    engine: engine || fakeEngine(),
    repos: { snapshots: snapshots || fakeSnapshots() },
  });
  const send = (name, ...args) => handlers.get(name)({}, ...args);
  return { handlers, send, calls };
}

// The seam the real repos.snapshots offers. listProviderIds is required: read()
// iterates providers and must not be handed a whole-database scan.
function fakeSnapshots(over = {}) {
  return { listProviderIds: () => [], read: () => null, write: () => {},
    getHealth: () => null, setHealth: () => {}, ...over };
}

const fakeEngine = (overrides = {}) => ({
  loadCache() {}, syncAll: async (o = {}) => ({ catalogCount: 1, skipped: !o.force }),
  scoreRows: (rows) => rows.map((r) => ({ ...r, score: 50, score_source: 'aa', rank: 1,
    matched_id: r.id, score_basis: ['aa'] })),
  isNonTextModel: () => false,
  summary: () => ({ catalogCount: 1, sources: [] }),
  syncIfUnscored: async () => ({ synced: false, scored: 0, unscored: [] }),
  state: { lastSyncAt: 1000, catalog: { rows: [] } },
  ...overrides,
});

test('registers exactly the five channels spec §6 names', () => {
  const { handlers } = harness();
  assert.deepEqual([...handlers.keys()].sort(),
    ['catalog:fetch-info', 'catalog:health', 'catalog:ingest', 'catalog:read', 'catalog:sources']);
});

test('catalog:read re-scores stored rows and fetches nothing, writes nothing, publishes nothing', async () => {
  let wrote = 0; let readCount = 0; let fetched = 0;
  const snapshots = fakeSnapshots({
    listProviderIds: () => ['nara'],
    read: (id) => { readCount += 1; return { createdAt: 1, fetchedAt: 1000, models: {
      m: { name: 'M', first_seen: 1, last_seen: 1000 } },
      lastGoodRows: [{ id: 'm', name: 'M', context_tokens: 10 }], lastSync: null }; },
    write: () => { wrote += 1; },
  });
  const engine = fakeEngine({ syncAll: async () => { fetched += 1; return engine_summary(); } });
  const { send } = harness({ snapshots, engine });
  const out = await send('catalog:read');
  assert.equal(wrote, 0);
  assert.equal(fetched, 0, 'a read never touches the network');
  assert.equal(readCount, 1);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].score, 50, 'scored against today\'s reference, not the day it was fetched');
  assert.equal(out.rows[0].is_new, false, 'recomputed from first_seen, never read from a column');
  assert.equal(out.oldestFetch, 1000);
  assert.equal(out.stale, false, 'stale here means "the last attempt failed", not "the rows are old"');
});

test('catalog:read reports the last failed attempt as stale while serving the rows it did get', async () => {
  const snapshots = fakeSnapshots({ listProviderIds: () => ['nara'], read: () => ({ createdAt: 1,
    fetchedAt: 1000, models: { m: { name: 'M', first_seen: 1, last_seen: 1000 } },
    lastGoodRows: [{ id: 'm' }], lastSync: { at: 2000, ok: false, warning: 'HTTP 503' } }) });
  const out = await harness({ snapshots }).send('catalog:read');
  assert.equal(out.stale, true);
  assert.equal(out.warning, 'HTTP 503');
  assert.equal(out.rows.length, 1);
});

test('catalog:ingest maps the adapter rows, scores them and returns the changes', async () => {
  const snapshots = { read: () => null, write: () => {} };
  const { send } = harness({ snapshots });
  const out = await send('catalog:ingest', 'nara', [{ id: 'a/b', name: 'A B', context_window: 1000 }]);
  assert.equal(out.ok, true);
  assert.equal(out.rows[0].id, 'a/b');
  assert.equal(out.rows[0].score, 50);
  assert.equal(out.changes.baseline, true, 'the first snapshot flags nothing new');
});

test('catalog:ingest refuses an empty or malformed roster with INVALID_PROVIDER_PAYLOAD', async () => {
  const { send } = harness();
  await assert.rejects(() => send('catalog:ingest', 'nara', []),
    (e) => e.code === 'INVALID_PROVIDER_PAYLOAD');
  await assert.rejects(() => send('catalog:ingest', 'nara', [{ name: 'no id' }]),
    (e) => e.code === 'INVALID_PROVIDER_PAYLOAD');
  await assert.rejects(() => send('catalog:ingest', 'nara', [{ id: 'a' }, { id: 'a' }]),
    (e) => e.code === 'INVALID_PROVIDER_PAYLOAD', 'a duplicate id is as unusable as a missing one');
});

test('an empty roster with rows already stored is served as stale, not as a removal', async () => {
  const snapshots = fakeSnapshots({ read: () => ({ createdAt: 1, fetchedAt: 500,
    models: { m: { name: 'M', first_seen: 1, last_seen: 500 } },
    lastGoodRows: [{ id: 'm', name: 'M' }], lastSync: { at: 500, ok: true, warning: null } }) });
  const out = await harness({ snapshots }).send('catalog:ingest', 'nara', []);
  assert.equal(out.ok, true);
  assert.equal(out.stale, true, 'a provider that answered nothing is not a provider that removed everything');
  assert.equal(out.rows.length, 1);
  assert.equal(out.changes, null, 'and no diff is claimed for a sync that never happened');
});

test('catalog:ingest falls back to last-good rows and marks stale when the snapshot rejects the drop', async () => {
  const many = {}; for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) many[id] =
    { name: id.toUpperCase(), first_seen: 1, last_seen: 2 };
  const snapshots = { read: () => ({ createdAt: 1, fetchedAt: 2, models: many,
    lastGoodRows: Object.keys(many).map((id) => ({ id, name: id.toUpperCase() })),
    lastSync: { at: 2, ok: true, warning: null } }), write: () => {} };
  const out = await harness({ snapshots }).send('catalog:ingest', 'nara', [{ id: 'a', name: 'A' }]);
  assert.equal(out.stale, true, 'a quarantined drop is served as stale, not as a removal');
  assert.equal(out.rows.length, 6, 'the last-good roster is what the page shows');
  assert.match(out.warning, /awaiting confirmation/);
});

test('two overlapping ingests for one provider cost one snapshot write', async () => {
  let writes = 0;
  const snapshots = { read: () => null, write: () => { writes += 1; } };
  const { send } = harness({ snapshots });
  const rows = [{ id: 'a/b', name: 'A B' }];
  await Promise.all([send('catalog:ingest', 'nara', rows), send('catalog:ingest', 'nara', rows)]);
  assert.equal(writes, 1, 'the door: one fetch, one write, one diff per overlap');
});

test('catalog:health stores the verdict with the latency sample and answers p50', async () => {
  const health = [];
  const snapshots = fakeSnapshots({
    getHealth: () => ({ status: 'healthy', at: 1, latencies: [{ at: 1, ms: 100 }, { at: 2, ms: 300 }, { at: 3, ms: 200 }] }),
    setHealth: (p, m, h) => health.push(h),
  });
  const out = await harness({ snapshots }).send('catalog:health', 'nara', 'a/b',
    { status: 'healthy', note: 'Responded normally', httpStatus: 200, at: 4, timeMs: 250 });
  assert.deepEqual(out, { p50: 225, samples: 4 }, 'median of 100, 200, 250, 300 → the middle pair averaged');
  assert.equal(health.length, 1);
  assert.equal(health[0].latencies.length, 4, 'the new sample joined the ring');
  assert.equal(health[0].latencies[3].ms, 250, 'newest last');
  assert.equal(health[0].status, 'healthy');
});

test('a health result with no usable latency records the verdict without a sample', async () => {
  let stored;
  const snapshots = fakeSnapshots({ setHealth: (p, m, h) => { stored = h; } });
  const out = await harness({ snapshots }).send('catalog:health', 'nara', 'a/b',
    { status: 'unreachable', note: 'No response', httpStatus: 0, at: 5 });
  assert.deepEqual(out, { p50: null, samples: 0 });
  assert.deepEqual(stored.latencies, []);
  assert.equal(stored.status, 'unreachable');
});

test('catalog:health keeps only the last 20 samples', async () => {
  const long = Array.from({ length: 20 }, (_, i) => ({ at: i, ms: i }));
  let stored;
  const snapshots = fakeSnapshots({
    getHealth: () => ({ status: 'healthy', at: 1, latencies: long }),
    setHealth: (p, m, h) => { stored = h; },
  });
  await harness({ snapshots }).send('catalog:health', 'nara', 'a/b',
    { status: 'healthy', at: 99, timeMs: 500 });
  assert.equal(stored.latencies.length, 20);
  assert.equal(stored.latencies[0].ms, 1, 'the oldest sample fell off');
  assert.equal(stored.latencies[19].ms, 500);
});

test('catalog:sources syncs when forced and reports without the TTL otherwise', async () => {
  const seen = [];
  const engine = fakeEngine({ syncAll: async ({ force } = {}) => { seen.push(Boolean(force)); return engine_summary(); } });
  const { send } = harness({ engine, snapshots: { read: () => null, write: () => {} } });
  await send('catalog:sources', { force: true });
  await send('catalog:sources', {});
  assert.deepEqual(seen, [true, false]);
});

function engine_summary() { return { catalogCount: 3, syncing: false, sources: [], fits: {} }; }

// The stored row is built by providerRow itself, so the two tests below diff a
// real shape against a real shape rather than a hand-written fixture that happens
// to match on the fields the author remembered.
const storedRow = (over = {}) => ({ ...providerRow({ id: 'a/b', name: 'A B',
  context_window: 1000, pricing: { input: 2 } }, 'nara'), ...over });

test('catalog:fetch-info says matched when nothing the provider publishes moved', async () => {
  const snapshots = fakeSnapshots({ read: () => ({ createdAt: 1, fetchedAt: 2,
    models: { 'a/b': { name: 'A B', first_seen: 1, last_seen: 2 } },
    lastGoodRows: [storedRow()], lastSync: null }) });
  const rows = [{ id: 'a/b', name: 'A B', context_window: 1000, pricing: { input: 2 } }];
  const out = await harness({ snapshots }).send('catalog:fetch-info', 'nara', 'a/b', rows);
  assert.equal(out.outcome, 'matched');
  assert.equal(out.changes, null, 'the merge changed nothing to report');
});

test('catalog:fetch-info lists each field that moved, old to new', async () => {
  const snapshots = fakeSnapshots({ read: () => ({ createdAt: 1, fetchedAt: 2,
    models: { 'a/b': { name: 'A B', first_seen: 1, last_seen: 2 } },
    lastGoodRows: [storedRow({ context_tokens: 1000 })], lastSync: null }) });
  const out = await harness({ snapshots }).send('catalog:fetch-info', 'nara', 'a/b',
    [{ id: 'a/b', name: 'A B', context_window: 2000 }]);
  assert.equal(out.outcome, 'updated');
  assert.deepEqual(out.changes, [{ field: 'context_tokens', from: 1000, to: 2000 }]);
});

test('catalog:fetch-info on a model with no stored row reports what it just learned', async () => {
  const snapshots = fakeSnapshots({ read: () => null });
  const out = await harness({ snapshots }).send('catalog:fetch-info', 'nara', 'a/b',
    [{ id: 'a/b', name: 'A B', context_window: 2000 }]);
  assert.equal(out.outcome, 'updated', 'a first read is a change worth naming');
  assert.ok(out.changes.some((c) => c.field === 'context_tokens' && c.from === null && c.to === 2000));
});

test('catalog:fetch-info says no-match when the reference knows nothing of it', async () => {
  const engine = fakeEngine({ scoreRows: (rows) => rows.map((r) => ({ ...r, matched_id: null, score: null })) });
  const snapshots = { read: () => null, write: () => {} };
  const out = await harness({ snapshots, engine }).send('catalog:fetch-info', 'nara', 'x/y',
    [{ id: 'x/y', name: 'X Y' }]);
  assert.equal(out.outcome, 'no-match');
});

test('catalog:fetch-info says no-longer-listed when the provider dropped it', async () => {
  const snapshots = { read: () => null, write: () => {} };
  const out = await harness({ snapshots }).send('catalog:fetch-info', 'nara', 'a/b',
    [{ id: 'other', name: 'Other' }]);
  assert.equal(out.outcome, 'no-longer-listed');
});

test('only the fields the provider publishes are compared — never a derived score', () => {
  for (const derived of ['score', 'score_source', 'rank', 'matched_id', 'filled_from_catalog']) {
    assert.ok(!COMPARE_FIELDS.includes(derived), `${derived} must not appear in a diff`);
  }
  assert.ok(COMPARE_FIELDS.includes('context_tokens'));
});

test('diffRow reads changed fields with the exact old and new values', () => {
  assert.deepEqual(diffRow({ context_tokens: 1, tools: null }, { context_tokens: 2, tools: true }),
    [{ field: 'context_tokens', from: 1, to: 2 }, { field: 'tools', from: null, to: true }]);
  assert.deepEqual(diffRow({ a: 1 }, { a: 1 }), []);
});
```

- [ ] **Step 2: Run and confirm they fail**

```bash
npm test -- test/catalog/ipc.test.js
```

Expected: FAIL — `Cannot find module '../../src/catalog/ipc'`.

- [ ] **Step 3: Write `src/catalog/ipc.js`**

```js
// src/catalog/ipc.js
'use strict';

// The renderer's only way to the catalog. Five channels, one thing each, the
// same rule src/db/ipc.js follows so two writers cannot overwrite each other.
//
// The provider adapters stay in the renderer — they own discovery and auth, and
// the page holds only venomkey: placeholders. So ingest and fetch-info receive
// the rows the adapter read and do the merge, the scoring and the writing here.

const { providerRow } = require('./row');
const { syncSnapshot, dropNonText, validateProviderRows, providerRowSnapshot,
  restoreLastGoodRows } = require('./snapshot');

const LATENCY_SAMPLES_KEPT = 20;

// The fields a Fetch information click may report as moved. Exactly the provider's
// own facts (ref §8.1); a derived value changing would say the provider published
// something when only the reference moved.
const COMPARE_FIELDS = ['name', 'description', 'family', 'context_tokens', 'output_tokens',
  'input_modalities', 'output_modalities', 'tools', 'reasoning', 'structured', 'attachment',
  'cost_in_per_m', 'cost_out_per_m', 'cost_kind', 'release_date', 'status'];

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function diffRow(before, after) {
  const out = [];
  for (const field of COMPARE_FIELDS) {
    if (!same(before[field], after[field])) out.push({ field, from: before[field] ?? null, to: after[field] ?? null });
  }
  return out;
}

/** The newest sample is the last; p50 over the kept ring, null when empty. */
function readHealth(health) {
  const samples = ((health && health.latencies) || []).map((s) => s.ms).filter((n) => Number.isFinite(n));
  if (!samples.length) return { p50: null, samples: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const p50 = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  return { p50, samples: sorted.length };
}

function appendLatency(previous, at, ms) {
  const ring = ((previous && previous.latencies) || []).slice();
  if (Number.isFinite(ms)) ring.push({ at, ms: Math.round(ms) });
  return ring.slice(-LATENCY_SAMPLES_KEPT);
}

function createCatalogIpc({ ipcMain, repos, engine, log = console }) {
  // The door (ref §9 refresh): one in-flight ingest per provider, shared by the
  // timer, a Fetch models click and a Fetch information click, so an overlap
  // costs one upstream fetch, one snapshot write, one diff.
  const inFlight = new Map();

  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        log.error(`${channel} failed:`, err.message);
        throw err;
      }
    });
  };

  function mapRows(providerId, models) {
    return models.map((m) => providerRow(m, providerId));
  }

  // The write path for one provider, always behind the door.
  function ingest(providerId, models) {
    const existing = inFlight.get(providerId);
    if (existing) return existing;
    const job = (async () => {
      const rows = mapRows(providerId, Array.isArray(models) ? models : []);
      const { kept, dropped } = dropNonText({ provider: { id: providerId }, rows,
        isNonTextModel: (r) => engine.isNonTextModel(r) });
      let stored;
      try {
        stored = validateProviderRows(providerId, kept);
      } catch (err) {
        // A malformed roster is not a removal: keep what we have and say so.
        const previous = repos.snapshots.read(providerId);
        if (!previous || !previous.lastGoodRows.length) throw err;
        return { ok: true, stale: true, warning: err.message,
          rows: engine.scoreRows(restoreLastGoodRows(previous, Date.now())), changes: null };
      }
      const now = Date.now();
      let changes;
      try {
        changes = syncSnapshot(repos.snapshots, providerId, stored, now, dropped);
      } catch (err) {
        if (err.code !== 'SUSPICIOUS_PROVIDER_DROP') throw err;
        const previous = repos.snapshots.read(providerId);
        return { ok: true, stale: true, warning: err.message,
          rows: engine.scoreRows(restoreLastGoodRows(previous, now)), changes: null };
      }
      const scored = engine.scoreRows(stored.map(providerRowSnapshot));
      engine.syncIfUnscored(scored).catch(() => {});
      return { ok: true, stale: false, warning: null, rows: scored, changes };
    })();
    inFlight.set(providerId, job);
    job.finally(() => inFlight.delete(providerId)).catch(() => {});
    return job;
  }

  // The read path (ref §9 readConnected): snapshots re-scored against today's
  // reference. No fetch, no write, no event.
  function read() {
    const providerIds = repos.snapshots.listProviderIds();
    const rows = [];
    let oldest = null;
    let anyStale = false;
    let warning = null;
    for (const providerId of providerIds) {
      const snapshot = repos.snapshots.read(providerId);
      if (!snapshot) continue;
      if (snapshot.fetchedAt != null && (oldest === null || snapshot.fetchedAt < oldest)) {
        oldest = snapshot.fetchedAt;
      }
      if (snapshot.lastSync && snapshot.lastSync.ok === false) {
        anyStale = true;
        warning = snapshot.lastSync.warning;
      }
      // Re-stamped, not replayed: first_seen and the newness verdict come from the
      // history as it stands today, because is_new is never stored (Task 7).
      rows.push(...engine.scoreRows(restoreLastGoodRows(snapshot, Date.now())));
    }
    return { rows, readAt: Date.now(), oldestFetch: oldest, stale: anyStale, warning,
      lastSyncAt: engine.state.lastSyncAt, catalogCount: engine.state.catalog.rows.length };
  }

  function health(providerId, modelId, result) {
    const previous = repos.snapshots.getHealth(providerId, modelId);
    const stored = {
      status: result.status, note: result.note || null, httpStatus: result.httpStatus ?? null,
      at: result.at || Date.now(),
      latencies: appendLatency(previous, result.at || Date.now(), result.timeMs),
    };
    repos.snapshots.setHealth(providerId, modelId, stored);
    return readHealth(stored);
  }

  // Fetch information (spec §6): the network pass is TTL-gated, the merge and the
  // report never are.
  async function fetchInfo(providerId, modelId, models) {
    await engine.syncAll();
    const before = repos.snapshots.read(providerId);
    const beforeRow = before && (before.lastGoodRows || []).find((r) => String(r.id) === String(modelId));
    const { rows } = await ingest(providerId, models);
    const after = rows.find((r) => String(r.id) === String(modelId));
    if (!after) return { outcome: 'no-longer-listed', before: beforeRow || null, after: null, changes: null };
    if (after.matched_id == null) {
      return { outcome: 'no-match', before: beforeRow || null, after, changes: null };
    }
    const changes = beforeRow ? diffRow(beforeRow, after) : COMPARE_FIELDS
      .filter((f) => after[f] != null && after[f] !== '')
      .map((f) => ({ field: f, from: null, to: after[f] }));
    return { outcome: changes.length ? 'updated' : 'matched', before: beforeRow || null, after,
      changes: changes.length ? changes : null };
  }

  handle('catalog:ingest', (providerId, models) => ingest(providerId, models));
  handle('catalog:read', () => read());
  handle('catalog:health', (providerId, modelId, result) => health(providerId, modelId, result));
  handle('catalog:sources', (query = {}) => engine.syncAll({ force: query.force === true }));
  handle('catalog:fetch-info', (providerId, modelId, models) => fetchInfo(providerId, modelId, models));
}

module.exports = { createCatalogIpc, COMPARE_FIELDS, diffRow, readHealth, appendLatency, LATENCY_SAMPLES_KEPT };
```

- [ ] **Step 4: Run the tests**

```bash
npm test -- test/catalog/ipc.test.js
```

Expected: PASS. The `catalog:read` case asserting `wrote === 0` is the one to protect — it is the
read/write split (ref §9 `readConnected`, ref §15 step 11), and a future "just refresh it while
we're reading" change is how this app would start refetching itself without bound.

- [ ] **Step 5: Build one engine in `src/main.js` and register the channels**

`src/main.js` already resolves the data folder at boot step 2 (`src/user-data.js`), so the cache
directory belongs beside it. Add after `startLogs()` and before the IPC block, keeping that order:
the catalog must not open before the databases it writes through.

```js
const path = require('path');
const { createFetcher } = require('./catalog/fetch');
const { createSources } = require('./catalog/sources');
const { createEngine } = require('./catalog/engine');
const { createCatalogIpc } = require('./catalog/ipc');

// One catalog engine per instance, on the same data folder the databases use.
function startCatalog({ repos, log }) {
  const cacheDir = path.join(app.getPath('userData'), 'catalog-cache');
  const fetcher = createFetcher({ timeoutMs: Number(repos.settings.get('settings')?.fetchTimeoutMs) || 20000 });
  const sources = createSources({
    cacheDir, fetcher,
    // Read at the point of use, so a key saved in Settings needs no restart.
    readKey: () => repos.secrets.reveal('openRouterApiKey') || '',
  });
  const engine = createEngine({ sources, log: (line) => log.info(line) });
  try {
    engine.loadCache();
  } catch (err) {
    // A cache that will not read is not a reason to stop the app: the sources
    // re-fetch and rebuild. Unlike the database, which must stop it.
    log.warn('catalog cache load failed, starting empty:', err.message);
  }
  createCatalogIpc({ ipcMain, repos, engine, log });
  return engine;
}
```

Then in the boot sequence, after `registerDataIpc(…)`:

```js
  catalogEngine = startCatalog({ repos: store.repos, log });
```

`repos.secrets.reveal(name)` is the method (exported at `src/db/repos/secrets.js:61`); the secret
name is `openRouterApiKey` and `SECRET_ORIGINS` in that same file must gain
`openRouterApiKey: 'https://openrouter.ai'` in Plan B's removal pass, since that is what lets main
hand the placeholder to a request at all. In Plan A the key is read directly in main, so no
placeholder travels.

- [ ] **Step 6: Add the five preload entries**

In `src/preload.js`, in the saved-data block, next to `readCatalog` and `writeCatalog`:

```js
  // Catalog engine (main owns the sources, the merge and the score).
  catalogIngest: (providerId, rows) => ipcRenderer.invoke('catalog:ingest', providerId, rows),
  catalogRead: () => ipcRenderer.invoke('catalog:read'),
  catalogHealth: (providerId, modelId, result) => ipcRenderer.invoke('catalog:health', providerId, modelId, result),
  catalogSources: (query) => ipcRenderer.invoke('catalog:sources', query),
  catalogFetchInfo: (providerId, modelId, rows) => ipcRenderer.invoke('catalog:fetch-info', providerId, modelId, rows),
```

- [ ] **Step 7: Prove the app still boots on a scratch folder**

```bash
node scripts/live/cdp.mjs --scratch   # or: npm run verify:live
```

Expected: the app opens with `catalog-cache/` created inside the scratch data folder and no new
error line. **This is a mock-provider run:** it proves wiring, not a real provider. The folder
starts empty — no providers, empty database — which is correct, not damage.

- [ ] **Step 8: Run the suite and commit**

```bash
npm test
git add src/catalog/ipc.js src/main.js src/preload.js test/catalog/ipc.test.js
git commit -m "feat(catalog): five IPC channels between the adapters and the engine

Read re-scores stored rows against today's reference and neither fetches nor
writes nor publishes — the split that keeps the page from refetching itself. One
in-flight ingest per provider, so the timer and two clicks cost one fetch. A
malformed roster or a quarantined drop serves the last-good rows marked stale:
a provider that failed to answer is not a provider that removed everything."
```

---

### Task 11: Something the owner can click — Settings › Catalog sources status

**Files:**
- Modify: `src/renderer/index.html` (`sec-catalog`, after the `#set-catalog-sync` row)
- Modify: `src/renderer/app.js` (render the block; call it from the catalog settings section)
- Modify: `src/renderer/styles.css` (reuse `.mc-*` and the settings grid; add at most one rule)

**Interfaces:**
- Consumes: `window.electronAPI.catalogSources({ force })` (Task 10).
- Produces: a read-only status block and one **Sync sources** button. No page behaviour changes.

This exists because CLAUDE.md says the owner must be able to see progress in their own app, and
Plan A's engine is otherwise invisible until Plan B switches the page over. It is also spec §7's
"sources status block", landed early.

- [ ] **Step 1: Add the markup inside `settings: sec-catalog`**

Follow the existing two-column settings pattern (`styles.css` 5962 onward); do not invent a layout.

```html
        <div class="set-row">
          <div class="set-label">
            <span>Sources</span>
            <small>The four upstream documents the model facts are merged from.</small>
          </div>
          <div class="set-control">
            <button class="btn btn-ghost btn-mini" type="button" id="btn-catalog-sync-sources">
              Sync sources
            </button>
            <div id="catalog-sources-status" class="mc-sources" role="status" aria-live="polite"></div>
          </div>
        </div>
```

- [ ] **Step 2: Render it from the settings section**

In `src/renderer/app.js`, where `sec-catalog` is filled on entry, add:

```js
const CATALOG_SOURCES_LABELS = {
  'models-dev-spec': 'models.dev', 'openrouter-public': 'OpenRouter models',
  'openrouter-keyed': 'OpenRouter benchmarks', lmarena: 'LMArena',
};

async function renderCatalogSources() {
  const el = document.getElementById('catalog-sources-status');
  if (!el) return;
  try {
    const s = await window.electronAPI.catalogSources({});
    el.innerHTML = `<div class="mc-sources-head">${s.catalogCount} models in the reference · `
      + `${s.keyedAuthConfigured ? 'key set' : 'no OpenRouter key'}</div>`
      + s.sources.map((row) => {
        const tone = row.error ? (row.stale ? 'warn' : 'fail') : 'ok';
        const when = row.fetchedAt ? new Date(row.fetchedAt).toLocaleString() : 'never';
        return `<div class="mc-source mc-source-${tone}" title="${escapeHtml(row.description || '')}">`
          + `<span>${escapeHtml(CATALOG_SOURCES_LABELS[row.id] || row.id)}</span>`
          + `<b>${row.rowCount}</b><span>${escapeHtml(when)}</span>`
          + (row.error ? `<span class="mc-source-error">${escapeHtml(row.error)}</span>` : '')
          + '</div>';
      }).join('');
  } catch (err) {
    el.textContent = `Sources unavailable: ${err.message}`;
  }
}
```

and wire the button:

```js
const syncSources = document.getElementById('btn-catalog-sync-sources');
if (syncSources) syncSources.addEventListener('click', async () => {
  syncSources.disabled = true;
  try { await window.electronAPI.catalogSources({ force: true }); } finally {
    syncSources.disabled = false;
    renderCatalogSources();
  }
});
```

Call `renderCatalogSources()` when the Catalog settings section is entered.

- [ ] **Step 3: Style it from what already exists**

Reuse `.mc-health`'s tone vocabulary (`styles.css` 7415 onward) so the block reads as the same
system in light and dark. Add only the grid rule, at the end of the Models Catalog block:

```css
/* Sources status: the same four facts per upstream document, one line each. */
.mc-sources { display: grid; gap: 4px; margin-top: 8px; }
.mc-source { display: grid; grid-template-columns: 1fr auto auto; gap: 10px; align-items: baseline; }
.mc-source b { font-variant-numeric: tabular-nums; }
.mc-source-ok > b { color: var(--pass); }
.mc-source-warn > b { color: var(--warn); }
.mc-source-fail > b { color: var(--fail); }
.mc-source-error { grid-column: 1 / -1; color: var(--text-3); font-size: 11px; }
```

- [ ] **Step 4: Look at it, in both themes**

Run the app on a scratch folder, open Settings › Catalog, and press **Sync sources**. Expect four
lines filling in — `models.dev` with a five-figure row count, OpenRouter benchmarks reporting "no
OpenRouter key" until one is saved. Then switch the theme to light and check the same block, per
the standing rule that a style change is verified in both.

`textContent` proving the lines exist is not proof they are visible: confirm the four rows have
non-zero height (`getBoundingClientRect`) before calling this done.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/index.html src/renderer/app.js src/renderer/styles.css
git commit -m "feat(catalog): show the four sources and let the owner sync them

The engine exists but the Models page does not read it yet, so its state is
surfaced where it is honest: Settings › Catalog, four lines, one button. A keyless
machine sees the OpenRouter benchmark feed report itself missing rather than
quietly scoring fewer models."
```

---

### Task 12: Regenerate the map, correct the docs, run the gate

**Files:**
- Modify: `docs/CODE_MAP.md` (generated)
- Modify: `docs/ARCHITECTURE.md` (§6 IPC table, §7 renderer load order note, §3 tables list)
- Modify: `docs/COOKBOOK.md` (a "read a model's facts from the sources" recipe, if one fits)
- Modify: `CHANGELOG.md` (Unreleased)

- [ ] **Step 1: Regenerate the code map**

```bash
npm run repo:map
```

`docs/CODE_MAP.md` is generated; the channel count goes from 39 to 44 and twelve new files appear
under a `src/catalog/` section. Never hand-edit it.

- [ ] **Step 2: Correct ARCHITECTURE.md where the new layer changes the map**

Three edits, each a fact rather than a narrative:

- §3 "Data at rest" — `venom.db` contents gain `snapshot_meta` and `roster_snapshot`, and the
  `catalog-cache/` folder appears in the file table as the four source payloads plus their meta.
- §6 "IPC surface" — 44 channels, new `Catalog` group: `catalog:ingest`, `catalog:read`,
  `catalog:health`, `catalog:sources`, `catalog:fetch-info`.
- §1 "Three layers, one rule" — the line "the renderer has no Node and no network" gains that the
  catalog's four upstream fetches are made from main through `src/catalog/fetch.js`, and that the
  provider adapters still discover from the renderer and hand their rows over.

- [ ] **Step 3: Confirm the spec carries the two deviations**

Spec §5 and §12 were rewritten during planning to say what this plan actually does — the snapshot
in `snapshot_meta` + `roster_snapshot` with the two-writer reason, and v2 additive / v3 clearing.
Read both sections against Tasks 7 and 10 here and correct anything that drifted; the spec is what
the next reader trusts.

- [ ] **Step 4: CHANGELOG**

Under `## [Unreleased]`, add the engine as an addition and say plainly that the Models page still
runs on the old path — a reader must not conclude the benchmark is gone because it is not yet.

- [ ] **Step 5: The gate**

```bash
npm run check
```

Expected: `repo:map --check` passes, then the whole suite. Report the new test count against the
**299** baseline measured before Task 1; every task in this plan adds cases, so the number must have
grown. Correct the 295 in `AGENTS.md` and `docs/ARCHITECTURE.md` §8 while the map is being touched.

- [ ] **Step 6: Commit**

```bash
git add docs/CODE_MAP.md docs/ARCHITECTURE.md docs/superpowers/specs/2026-09-30-catalog-rebuild-design.md CHANGELOG.md
git commit -m "docs(catalog): map the new engine layer and record where the plan deviated

The snapshot lives in two new tables rather than in models, because the legacy
write-catalog path still owns that table and two writers on one table is the bug
CLAUDE.md was written about. Documented where a reader will hit it, not only where
it was decided."
```

---

## What this plan leaves for Plan B

So the next reader is not guessing: this plan ends with the engine reachable and the Models page
unchanged. Still to do, in Plan B's own words:

1. Migration `version: 3` — clear `models` / `model_keys` / `catalog_meta`; drop `bench_json`,
   `history_json`, `bench_error`, `caps_json`, `caps_error`; delete `read-catalog` /
   `write-catalog` and `src/db/repos/catalog.js`.
2. The whole of spec §2's removal table: `benchmark.js`, `profiles.js`, `leaderboard-snapshot.js`,
   the auto-bench setting, the AA secret, `window.PROFILES`'s four consumers, `recorder.js:15`'s
   two sources, the profile colour tokens, the benchmark-only CSS, and the nine test files named
   there.
3. Spec §7's Models page columns and the three buttons re-ordered to health · fetch information ·
   chat, fed from `catalog:read` and calling `catalog:fetch-info` / `catalog:health`.
4. Fetch models and Test Selected on the Route Test page calling `catalog:ingest` (§6).
5. `docs/CODE_MAP.md` regenerated again, and `npm run verify:live` with the mock provider.

## Self-review notes (fixed inline before this plan was handed over)

- Spec §5's `models`-is-the-snapshot shape collided with `repos.catalog`'s existing ownership;
  resolved as the second deviation rather than as a shim.
- `is_new` left the schema. The reference never stored it — it is a window over `first_seen` — so
  `catalog:read` recomputes it through `restoreLastGoodRows`, and a column would have frozen a
  verdict that changes as the clock moves.
- `openRouterApiKey` was unreachable: `secrets.save()` throws on any name missing from
  `SECRET_ORIGINS` (`src/db/repos/secrets.js:20,35`), so Task 7 Step 6b registers it. Without that
  step Task 11's status line reads "no OpenRouter key" forever.
- Two `catalog:fetch-info` fixtures hand-wrote a stored row and would have diffed on `family` and
  `status`, which `providerRow` always fills. They now build the stored row with `providerRow`.
- The `p50` assertion said 250 for samples 100/200/250/300; the median of an even set is the middle
  pair averaged, 225.
- Task 6's "later scores" case seeded only a benchmark entry, which cannot create a catalog row —
  rows come from the rosters. `makeScorable()` now adds the listing and its measurement together.
- Task 4's `sources.js` and `fetch.js` harnesses need `sleep: async () => {}` injected; without it
  every retry case really waits 400 ms. Passed in every fake.
- Dead exports removed: `friendlyMessage`, `BLANK_IS_EMPTY`, `emptySource`, `arenaUrl`,
  `ARENA_PAGE`, `ARENA_MAX_OFFSET`, the `{ inFlight, COMPARE_FIELDS }` return of
  `createCatalogIpc`, and `syncSnapshot`/`readHealth` from the ipc test's requires.
- Task 4 Step 4 originally named the wrong missing module in its expected output; corrected to
  `../../src/catalog/fetch`.
- `engine.js`'s `syncAll` no longer needs `Promise.allSettled` because `sources.fetchAll()` settles
  per source; the note is in Task 6 Step 4 rather than left as an unexplained difference.
- Every constant in Task 11's CSS and Task 10's `LATENCY_SAMPLES_KEPT = 20` matches spec §11.
- No task touches `npm start`, the resolved data folder, or launch behaviour.

---

**Verification, in the order that means something:** `npm test` after every task; `npm run check`
at Task 12; `npm run verify:live` at Task 10 Step 7 and again in Plan B. The live run uses a
**mock** provider only — it proves the app boots and the channels answer, never a real key, a real
429 or a real upstream document. The only check that sees the real sources is Task 11 Step 4, run
by the owner, on their own machine.

