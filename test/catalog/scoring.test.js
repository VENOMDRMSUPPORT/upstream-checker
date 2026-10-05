"use strict";

// lib/scoring.js turns catalog rows into score + rank. Fits run on synthetic
// data built from an exact linear formula (never noisy/random) so R² is
// deterministic and the test never flakes.

const test = require("node:test");
const assert = require("node:assert/strict");
const { monthsSince } = require("../../src/catalog/util");
const {
  fitLinear,
  assignScores,
  assignDenseRank,
  attachScores,
} = require("../../src/catalog/scoring");

test("fitLinear recovers a perfect line and predicts along it", () => {
  const points = Array.from({ length: 30 }, (_, i) => [i, 2 * i + 3]);
  const fit = fitLinear(points);
  assert.ok(fit);
  assert.equal(fit.n, 30);
  assert.equal(Math.round(fit.r2 * 1000) / 1000, 1);
  assert.equal(fit.predict(10), 23);
});

test("fitLinear refuses fewer than 30 distinct points", () => {
  const points = Array.from({ length: 10 }, (_, i) => [i, 2 * i]);
  assert.equal(fitLinear(points), null);
});

test("fitLinear refuses a flat y (no variance to explain)", () => {
  const points = Array.from({ length: 30 }, (_, i) => [i, 42]);
  assert.equal(fitLinear(points), null);
});

test("fitLinear dedupes identical (x, y) pairs before counting n", () => {
  const points = Array.from({ length: 30 }, (_, i) => [i, 2 * i + 3]);
  const withDupes = points.concat([[5, 13], [5, 13], [5, 13]]);
  const fit = fitLinear(withDupes);
  assert.equal(fit.n, 30);
});

// A synthetic catalog whose aa_intelligence is an exact linear function of the
// same features fitSpec uses (cost, context, reasoning, tools, age, host
// count), so the regression it fits internally should recover r2 ~= 1.
const SPEC_WEIGHTS = [10, 5, 3, 2, 1, -0.1, 0.5];
function specTrueValue(cost, context, reasoning, tools, age, providerCount) {
  const f = [1, Math.log10(cost + 0.05), Math.log10(context), reasoning ? 1 : 0, tools ? 1 : 0, age, Math.log10(providerCount)];
  return f.reduce((sum, v, i) => sum + v * SPEC_WEIGHTS[i], 0);
}
function makeMeasuredRow(i) {
  const cost = i * 0.1 + 0.5;
  const context = 1000 * (i + 1);
  const reasoning = i % 2 === 0;
  const tools = i % 3 === 0;
  const providerCount = (i % 5) + 1;
  const releaseDate = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
  const age = Math.min(monthsSince(releaseDate), 36);
  return {
    id: `m${i}`,
    name: `M${i}`,
    aa_intelligence: specTrueValue(cost, context, reasoning, tools, age, providerCount),
    cost_in_per_m: cost,
    context_tokens: context,
    reasoning,
    tools,
    release_date: releaseDate,
    provider_count: providerCount,
  };
}

test("assignScores: fitSpec needs at least 90 measured rows (MIN_FIT_SAMPLES * 3)", () => {
  const rows = Array.from({ length: 50 }, (_, i) => makeMeasuredRow(i));
  const fits = assignScores(rows);
  assert.equal(fits.spec, null);
});

test("assignScores: measured rows keep score_source 'aa' even once a spec fit exists", () => {
  const rows = Array.from({ length: 95 }, (_, i) => makeMeasuredRow(i));
  const fits = assignScores(rows);
  assert.ok(fits.spec, "expected a spec fit from 95 measured rows");
  assert.equal(fits.spec.r2, 1);
  assert.equal(rows[10].score, rows[10].aa_intelligence);
  assert.equal(rows[10].score_source, "aa");
});

test("assignScores: an unmeasured row is estimated from the spec fit", () => {
  const measured = Array.from({ length: 95 }, (_, i) => makeMeasuredRow(i));
  const cost = 4.5;
  const context = 41000;
  const reasoning = false;
  const tools = true;
  const providerCount = 2;
  const releaseDate = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
  const age = Math.min(monthsSince(releaseDate), 36);
  const trueValue = specTrueValue(cost, context, reasoning, tools, age, providerCount);
  const unmeasured = {
    id: "u1",
    name: "Unmeasured",
    cost_in_per_m: cost,
    context_tokens: context,
    reasoning,
    tools,
    release_date: releaseDate,
    provider_count: providerCount,
  };

  assignScores(measured.concat([unmeasured]));

  assert.equal(unmeasured.score_source, "est");
  assert.deepEqual(unmeasured.score_basis, ["spec"]);
  assert.ok(Math.abs(unmeasured.score - trueValue) < 0.1, `expected ~${trueValue}, got ${unmeasured.score}`);
});

test("assignDenseRank: equal scores share a rank, unscored rows stay null", () => {
  const rows = [
    { id: "c", score: 50, score_source: "est" },
    { id: "a", score: 50, score_source: "aa" },
    { id: "b", score: 50, score_source: "aa" },
    { id: "d", score: null, score_source: null },
    { id: "e", score: 70, score_source: "aa" },
    { id: "f", score: 40, score_source: "est" },
  ];
  assignDenseRank(rows);
  const ranks = Object.fromEntries(rows.map((r) => [r.id, r.rank]));
  assert.deepEqual(ranks, { e: 1, a: 2, b: 2, c: 2, d: null, f: 3 });
});

test("attachScores: a verbatim match_ids alias finds a renamed row and fills its blank fields", () => {
  const catalogRows = [
    {
      id: "qwen3.8-max",
      name: "Qwen3.8 Max",
      score: 61.4,
      score_source: "aa",
      score_basis: ["aa"],
      aa_intelligence: 61.4,
      aa_coding: 58,
      lmarena_elo: null,
      lmarena_rank: 12,
      lmarena_code_rank: null,
      rank: 3,
      context_tokens: 1000000,
      output_tokens: 65536,
      input_modalities: "text,image",
      tools: true,
      reasoning: true,
      structured: true,
      attachment: false,
      release_date: "2026-06-01",
    },
  ];
  // A router renames the model; only match_ids finds it, and the row is thin
  // (ids only) the way a provider module that just lists ids would produce it.
  const providerRows = [
    {
      id: "qwen-3.8-max",
      name: "Qwen 3.8 Max",
      match_ids: ["qwen3.8-max"],
      context_tokens: null,
      output_tokens: null,
      input_modalities: "",
      tools: null,
      reasoning: null,
      structured: null,
      attachment: null,
      release_date: "",
    },
  ];

  attachScores(providerRows, catalogRows);
  const row = providerRows[0];

  assert.equal(row.matched_id, "qwen3.8-max");
  assert.equal(row.score, 61.4);
  assert.equal(row.rank, 1);
  assert.equal(row.aa_intelligence, 61.4);
  assert.equal(row.context_tokens, 1000000);
  assert.equal(row.tools, true);
  assert.deepEqual(
    row.filled_from_catalog,
    ["context_tokens", "output_tokens", "input_modalities", "tools", "reasoning", "structured", "attachment", "release_date"],
  );
});

test("attachScores: no match leaves score/rank null instead of guessing", () => {
  const providerRows = [{ id: "unknown-model-9000", name: "Unknown Model 9000" }];
  attachScores(providerRows, []);
  assert.equal(providerRows[0].score, null);
  assert.equal(providerRows[0].rank, null);
  assert.equal(providerRows[0].matched_id, null);
});

test("attachScores keeps low/high/thinking/max model identities distinct", () => {
  const catalogRows = [
    { id: "openai/gpt-5-low", name: "GPT-5 Low", score: 40, score_source: "aa", score_basis: ["aa"], rank: 4 },
    { id: "openai/gpt-5-high", name: "GPT-5 High", score: 70, score_source: "aa", score_basis: ["aa"], rank: 1 },
    { id: "qwen/qwen3-max", name: "Qwen3 Max", score: 60, score_source: "aa", score_basis: ["aa"], rank: 2 },
    { id: "qwen/qwen3-thinking", name: "Qwen3 Thinking", score: 50, score_source: "aa", score_basis: ["aa"], rank: 3 },
  ];
  const rows = catalogRows.map((row) => ({ id: row.id, name: row.name, context_tokens: 1234 }));
  attachScores(rows, catalogRows);
  assert.deepEqual(rows.map((row) => [row.id, row.score, row.matched_id]), [
    ["openai/gpt-5-low", 40, "openai/gpt-5-low"],
    ["openai/gpt-5-high", 70, "openai/gpt-5-high"],
    ["qwen/qwen3-max", 60, "qwen/qwen3-max"],
    ["qwen/qwen3-thinking", 50, "qwen/qwen3-thinking"],
  ]);
  // Provider-supplied metadata is never overwritten by the match.
  assert.deepEqual(rows.map((row) => row.context_tokens), [1234, 1234, 1234, 1234]);
});

test("attachScores uses explicit aliases but does not guess a stripped variant", () => {
  const catalogRows = [
    { id: "moonshotai/kimi-k2-thinking", name: "Kimi K2 Thinking", score: 55, score_source: "aa", score_basis: ["aa"], rank: 1 },
  ];
  const rows = [
    { id: "kimi-k2", name: "Kimi K2" },
    { id: "router-kimi", name: "Router Kimi", match_ids: ["moonshotai/kimi-k2-thinking"] },
  ];
  attachScores(rows, catalogRows);
  assert.equal(rows[0].matched_id, null);
  assert.equal(rows[0].score, null);
  assert.equal(rows[1].matched_id, "moonshotai/kimi-k2-thinking");
  assert.equal(rows[1].score, 55);
});

test("attachScores refuses an ambiguous display-name fallback, even when one side is measured", () => {
  const catalogRows = [
    { id: "lab-a/model-one", name: "Shared Name", score: 50, score_source: "aa", score_basis: ["aa"], rank: 1 },
    { id: "lab-b/model-two", name: "Shared Name", score: 40, score_source: "est", score_basis: ["spec"], rank: 2 },
  ];
  const rows = [{ id: "router/unknown", name: "Shared Name" }];

  attachScores(rows, catalogRows);

  assert.equal(rows[0].matched_id, null);
  assert.equal(rows[0].score, null);
});

test("attachScores resolves a verbatim alias by exact catalog id before any normalized key", () => {
  const catalogRows = [
    { id: "minimax/minimax-m3", name: "MiniMax M3", score: 29.6, score_source: "aa", score_basis: ["aa"], rank: 2 },
    { id: "opper/minimax/m3", name: "MiniMax-M3", score: 29.6, score_source: "aa", score_basis: ["aa"], rank: 2 },
  ];
  const rows = [{ id: "minimax-m3", name: "MiniMax-M3", match_ids: ["opper/minimax/m3"] }];

  attachScores(rows, catalogRows);

  assert.equal(rows[0].matched_id, "opper/minimax/m3");
  assert.equal(rows[0].score, 29.6);
});

test("attachScores marks an explicit quality proxy without claiming a direct benchmark", () => {
  const catalogRows = [
    {
      id: "qwen/qwen3.8-max", name: "Qwen3.8 Max", score: 60, score_source: "aa", score_basis: ["aa"], rank: 1,
      context_tokens: 262144, cost_in_per_m: 2.5, cost_out_per_m: 7.5,
    },
  ];
  const rows = [
    {
      id: "qwen-3.8-max-thinking",
      name: "Qwen 3.8 Max Thinking",
      quality_proxy_ids: ["qwen3.8-max"],
      context_tokens: null,
      cost_in_per_m: null,
      cost_out_per_m: null,
    },
  ];

  attachScores(rows, catalogRows);

  assert.equal(rows[0].score, 60);
  assert.equal(rows[0].score_source, "proxy");
  assert.deepEqual(rows[0].score_basis, ["proxy", "aa"]);
  assert.equal(rows[0].matched_id, "qwen/qwen3.8-max");
  assert.equal(rows[0].score_proxy_for, "qwen-3.8-max-thinking");
  // The proxy route shares the base route's limits and reference prices.
  assert.equal(rows[0].context_tokens, 262144);
  assert.equal(rows[0].cost_in_per_m, 2.5);
});

test("attachScores resolves same-identity host listings to the measured one, not the first one", () => {
  // Two hosts list the same model. The keys agree on the identity (minimax-m3),
  // so this is a choice of listing, not a guess about which model it is.
  const catalogRows = [
    { id: "opper/minimax/m3", name: "MiniMax-M3", score: 31.4, score_source: "est", score_basis: ["spec"], rank: 2 },
    { id: "minimax/minimax-m3", name: "MiniMax M3", score: 29.6, score_source: "aa", score_basis: ["aa"], rank: 3, aa_intelligence: 29.6 },
  ];
  const rows = [{ id: "cline-pass/minimax-m3", name: "MiniMax-M3" }];

  attachScores(rows, catalogRows);

  assert.equal(rows[0].matched_id, "minimax/minimax-m3");
  assert.equal(rows[0].score, 29.6);
  assert.equal(rows[0].score_source, "aa");
  assert.equal(rows[0].aa_intelligence, 29.6);
});

test("attachScores prefers a measured alias candidate over an estimated own-id listing", () => {
  // A router spells the id "qwen-3.7-plus"; a host listing with that exact
  // spelling only has an estimate, while the adapter alias points at the lab's
  // measured row. Same identity either way, so the measurement wins.
  const catalogRows = [
    { id: "venice/qwen-3-7-plus", name: "Qwen 3.7 Plus", score: 31.9, score_source: "est", score_basis: ["spec"], rank: 1 },
    { id: "qwen/qwen3.7-plus", name: "Qwen3.7 Plus", score: 25.8, score_source: "aa", score_basis: ["aa"], rank: 2 },
  ];
  const rows = [{ id: "qwen-3.7-plus", name: "Qwen 3.7 Plus", match_ids: ["qwen3.7-plus"] }];

  attachScores(rows, catalogRows);

  assert.equal(rows[0].matched_id, "qwen/qwen3.7-plus");
  assert.equal(rows[0].score, 25.8);
});

test("attachScores gives equal provider scores the same rank", () => {
  const catalogRows = [
    { id: "lab/a", name: "A", score: 50, score_source: "aa", score_basis: ["aa"], rank: 1 },
    { id: "lab/b", name: "B", score: 50, score_source: "est", score_basis: ["spec"], rank: 1 },
    { id: "lab/c", name: "C", score: 40, score_source: "aa", score_basis: ["aa"], rank: 2 },
  ];
  const rows = catalogRows.map((row) => ({ id: row.id, name: row.name }));
  attachScores(rows, catalogRows);
  assert.deepEqual(rows.map((row) => row.rank), [1, 1, 2]);
});

test("attachScores does not fall back to a display name that drops what the id says", () => {
  // "devstral-latest" is a moving alias; the dated build's display name is the
  // same string, and matching on it would hand the alias a measurement.
  const catalogRows = [
    { id: "mistralai/devstral-2512", name: "Devstral 2", score: 9.4, score_source: "aa", score_basis: ["aa"], rank: 1 },
  ];
  const rows = [{ id: "router/devstral-latest", name: "Devstral 2" }];

  attachScores(rows, catalogRows);

  assert.equal(rows[0].matched_id, null);
  assert.equal(rows[0].score, null);
});

test("a moving-alias catalog row is not reachable through a display name that hides the alias", () => {
  const catalogRows = [
    { id: "mistral/devstral-latest", name: "Devstral 2", score: 15.6, score_source: "est", score_basis: ["spec"], rank: 1 },
  ];
  const rows = [{ id: "host/devstral-2", name: "Devstral 2" }];

  attachScores(rows, catalogRows);

  assert.equal(rows[0].matched_id, null);
});

test("attachScores still matches by display name when the name keeps the id's identity", () => {
  const catalogRows = [
    { id: "lab/renamed-slug", name: "Shared Display Name", score: 42, score_source: "aa", score_basis: ["aa"], rank: 1 },
  ];
  const rows = [{ id: "host/other-spelling", name: "Shared Display Name" }];

  attachScores(rows, catalogRows);

  assert.equal(rows[0].matched_id, "lab/renamed-slug");
  assert.equal(rows[0].score, 42);
});

test("attachScores carries the build a measurement came from onto the provider row", () => {
  const catalogRows = [
    {
      id: "qwen/qwen3.8-max", name: "Qwen3.8 Max", score: 45, score_source: "aa", score_basis: ["aa"], rank: 1,
      aa_intelligence: 45, bench_id: "qwen/qwen3.8-max-20260902",
    },
  ];
  const rows = [{ id: "qwen3.8-max", name: "Qwen3.8 Max" }];

  attachScores(rows, catalogRows);

  assert.equal(rows[0].bench_id, "qwen/qwen3.8-max-20260902");
});

// ---------------------------------------------------------------------------
// A routing prefix is not identity — on the PROVIDER side too.
//
// The rule is in CLAUDE.md and `bareModelKey` implements it, but it was only
// wired into buildCatalog's benchmark lookup. `attachScores` indexed catalog
// rows by `qualityModelKey`, which cuts at the FIRST slash only — so a row
// hosted two segments deep kept the middle one inside its key
// (`nano-gpt/qwen/qwen3.5-omni-plus` → `qwen-qwen3-5-omni-plus`) and no
// provider alias could ever spell it. `qwen-3.5-omni-plus` sat unscored while
// its catalog row already held 27.4.

test("a catalog row hosted two segments deep is still reachable by its bare id", () => {
  const catalog = [
    { id: "nano-gpt/qwen/qwen3.5-omni-plus", name: "Qwen3.5 Omni Plus", score: 27.4, score_source: "est" },
  ];
  const rows = [{ id: "qwen-3.5-omni-plus", name: "Qwen 3.5 Omni Plus", match_ids: ["qwen3.5-omni-plus"] }];

  attachScores(rows, catalog);
  assert.equal(rows[0].matched_id, "nano-gpt/qwen/qwen3.5-omni-plus");
  assert.equal(rows[0].score, 27.4);
});

test("the bare key never outranks a key that kept its routing segments", () => {
  // Two catalog rows: one reachable by the precise key, one only by the loose
  // one. The precise match must win, or a looser spelling silently decides
  // which model's number a provider row carries.
  const catalog = [
    { id: "alibaba/qwen3.8-max", name: "Qwen3.8 Max", score: 40, score_source: "aa" },
    { id: "some-host/alibaba/qwen3.8-max", name: "Qwen3.8 Max", score: 10, score_source: "est" },
  ];
  const rows = [{ id: "qwen-3.8-max", name: "Qwen 3.8 Max", match_ids: ["qwen3.8-max"] }];

  attachScores(rows, catalog);
  assert.equal(rows[0].matched_id, "alibaba/qwen3.8-max", "the precise key wins");
  assert.equal(rows[0].score, 40);
});

test("two different models behind one bare key stay unmatched, never guessed", () => {
  // bareModelKey drops the routing segments, so two genuinely different hosts
  // of DIFFERENT models can collide. putMatch marks that ambiguous and the
  // lookup must refuse rather than pick one.
  const catalog = [
    { id: "host-a/lab/shared-name-v2", name: "A", score: 40, score_source: "aa" },
    { id: "host-b/other/shared-name-v2", name: "B", score: 10, score_source: "est" },
  ];
  const rows = [{ id: "shared-name-v2", name: "Shared", match_ids: ["shared-name-v2"] }];

  attachScores(rows, catalog);
  assert.equal(rows[0].matched_id, null, "an ambiguous bare key attaches nothing");
  assert.equal(rows[0].score, null);
});

test("a last segment too generic to own does not become a claim", () => {
  // bareModelKey returns "" for a one-token last segment, so `opper/minimax/m3`
  // never turns into a claim on every "m3" in the catalog.
  const catalog = [{ id: "opper/minimax/m3", name: "M3", score: 33, score_source: "aa" }];
  const rows = [{ id: "totally-unrelated", name: "Unrelated", match_ids: ["m3"] }];

  attachScores(rows, catalog);
  assert.equal(rows[0].matched_id, null);
});

// ---------------------------------------------------------------------------
// Pinned here because nothing above pins it.
//
// The first case is the alias-only lookup the plan states outright. The three
// after it are the spec §9 promises this repo's checklist names and the
// reference's own file never actually asserted: the R² floor (its fitLinear
// cases only ever hit the sample floor and the zero-variance guard), the row
// with no signal at all, and fitSpec's median default for a missing value.

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

test("fitLinear refuses a fit under R² 0.3, not just one under 30 points", () => {
  // 30 distinct points — the sample floor is met — carrying a real trend buried
  // in a ±18 zigzag, which leaves R² at 0.23. Below MIN_FIT_R2 the estimate is
  // worse than no estimate, so the fit is dropped rather than trusted.
  const points = Array.from({ length: 30 }, (_, i) => [i, i + (i % 2 ? 18 : -18)]);
  assert.equal(fitLinear(points), null);
});

test("a row with no usable signal is unrated, not scored at zero", () => {
  const rows = [{ id: "silent", name: "Silent" }];
  const fits = assignScores(rows);
  assert.equal(fits.spec, null, "one unmeasured row cannot train a spec fit");
  assert.equal(rows[0].score, null);
  assert.equal(rows[0].score_source, null);
  assert.deepEqual(rows[0].score_basis, []);
});

test("fitSpec fills a missing training value with the training median, never 0", () => {
  // The 95 measured rows above price from 0.5 to 9.9 per million, so their
  // median is 5.2. A row that publishes no price is estimated as if it sat at
  // that median; read as 0 it would be scored as the cheapest model in the pool.
  //
  // A published 0 is the same case, not a different one. A $0.00 cover price is a
  // promotional or free listing, not evidence about quality, and the fit learned
  // "pricier means smarter" from list prices — so a zero must read as unknown
  // rather than as the bottom of the market. Measured on the real catalog:
  // opencode/big-pickle (price 0, one host, eleven months old) scored 0.2, and the
  // same row at the training median scores 11.2.
  const rows = Array.from({ length: 95 }, (_, i) => makeMeasuredRow(i));
  const base = { name: "Thin", context_tokens: null, release_date: "", reasoning: null, tools: null, provider_count: null };
  const blank = { id: "blank", ...base, cost_in_per_m: null };
  const atMedian = { id: "at-median", ...base, cost_in_per_m: 5.2 };
  const atZero = { id: "at-zero", ...base, cost_in_per_m: 0 };
  const atNegative = { id: "at-negative", ...base, cost_in_per_m: -1 };

  assignScores(rows.concat([blank, atMedian, atZero, atNegative]));

  assert.equal(blank.score_source, "est");
  assert.equal(blank.score, atMedian.score, "a null price reads as the pool's median price");
  assert.equal(atZero.score, blank.score, "a published 0 is unknown too, not the cheapest seat in the pool");
  assert.equal(atNegative.score, blank.score, "and neither is a negative cover price");
  // The point of the fallback: the estimate does not collapse to the floor.
  assert.ok(blank.score > 3, `${blank.score}: the default is not 0`);
});

test("attachScores: a thin provider row borrows the reference's output modality", () => {
  // §16.6's damage is closed by the *fillable* half, not by the collapse union:
  // nexum-router publishes byte-identical metadata for all eighteen listings, so
  // by the time a provider row is scored the reference row is the only place an
  // output modality exists. Without "output_modalities" in FILLABLE_FIELDS every
  // one of those listings reaches the tier gate as modality_unknown.
  const catalogRows = [
    {
      id: "nexum/claude-fable-5.1",
      name: "Claude Fable 5.1",
      score: 53,
      score_source: "aa",
      score_basis: ["aa"],
      rank: 1,
      aa_intelligence: 53,
      aa_coding: null,
      lmarena_elo: null,
      lmarena_rank: null,
      lmarena_code_rank: null,
      context_tokens: 200000,
      output_tokens: 8192,
      input_modalities: "text,image",
      output_modalities: "text",
      tools: true,
      reasoning: true,
      structured: null,
      attachment: null,
      release_date: "2026-08-31",
      cost_in_per_m: 2,
      cost_out_per_m: 10,
    },
  ];
  // Nothing but the id — a router that publishes no metadata at all.
  const providerRows = [{ id: "nexum/claude-fable-5.1", name: "Claude Fable 5.1" }];

  attachScores(providerRows, catalogRows);
  const [row] = providerRows;

  assert.equal(row.output_modalities, "text");
  assert.ok(
    row.filled_from_catalog.includes("output_modalities"),
    `output_modalities absent from filled_from_catalog: ${JSON.stringify(row.filled_from_catalog)}`,
  );
});
