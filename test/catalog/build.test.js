"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCatalog, indexBenchmarks } = require("../../src/catalog/build");

function fixture() {
  return {
    spec: null,
    openrouter: {
      data: [
        { id: "anthropic/claude-fable-5.1", name: "Anthropic: Claude Fable 5.1", pricing: {}, supported_parameters: [] },
        { id: "~anthropic/claude-fable-latest", name: "Anthropic: Claude Fable Latest", pricing: {}, supported_parameters: [] },
        { id: "qwen/qwen3-max", name: "Qwen3 Max", pricing: {}, supported_parameters: [] },
        { id: "qwen/qwen3-thinking", name: "Qwen3 Thinking", pricing: {}, supported_parameters: [] },
        { id: "~qwen/qwen3-max:free", name: "Qwen3 Max (free)", pricing: {}, supported_parameters: [] },
      ],
    },
    benchmarks: {
      data: [
        {
          model_permaslug: "anthropic/claude-fable-5.1",
          display_name: "Claude Fable 5.1",
          source: "artificial-analysis",
          intelligence_index: 53.4,
          coding_index: 81.6,
        },
        { model_permaslug: "qwen/qwen3-max", display_name: "Qwen3 Max", source: "artificial-analysis", intelligence_index: 60 },
        { model_permaslug: "qwen/qwen3-thinking", display_name: "Qwen3 Thinking", source: "artificial-analysis", intelligence_index: 45 },
      ],
    },
    lmarena: null,
  };
}

test("buildCatalog never labels a latest alias or an effort variant with a sibling's measurement", () => {
  const { byId } = buildCatalog(fixture());
  assert.equal(byId.get("anthropic/claude-fable-5.1").score, 53.4);
  assert.equal(byId.get("anthropic/claude-fable-5.1").score_source, "aa");
  const latest = byId.get("~anthropic/claude-fable-latest");
  assert.notEqual(latest.score_source, "aa");
  assert.equal(latest.aa_intelligence, null);
  assert.equal(byId.get("qwen/qwen3-max").score, 60);
  assert.equal(byId.get("qwen/qwen3-thinking").score, 45);
});

test("buildCatalog collapses a ':free' listing into its paid twin and keeps the listing ids", () => {
  const { byId, rows } = buildCatalog(fixture());
  assert.equal(byId.get("~qwen/qwen3-max:free"), undefined);
  const max = byId.get("qwen/qwen3-max");
  assert.deepEqual(max.listings.sort(), ["qwen/qwen3-max", "~qwen/qwen3-max:free"].sort());
  assert.equal(rows.filter((row) => row.id.includes("qwen3-max")).length, 1);
});

test("buildCatalog gives equal scores the same catalog rank", () => {
  const payloads = fixture();
  payloads.openrouter.data.push({ id: "lab/twin", name: "Twin", pricing: {}, supported_parameters: [] });
  payloads.benchmarks.data.push({ model_permaslug: "lab/twin", display_name: "Twin", source: "artificial-analysis", intelligence_index: 60 });
  const { byId } = buildCatalog(payloads);
  assert.equal(byId.get("lab/twin").rank, byId.get("qwen/qwen3-max").rank);
  assert.equal(byId.get("anthropic/claude-fable-5.1").rank, byId.get("qwen/qwen3-max").rank + 1);
});

// ---------------------------------------------------------------------------
// One slug, one answer (O1)

function duplicateFeed(first, second) {
  return {
    data: [
      { model_permaslug: "openai/gpt-5", display_name: "GPT-5", source: "artificial-analysis", intelligence_index: first },
      { model_permaslug: "openai/gpt-5", display_name: "GPT-5", source: "artificial-analysis", intelligence_index: second },
    ],
  };
}

test("indexBenchmarks: every key a slug registers answers with the same numbers", () => {
  const index = indexBenchmarks(duplicateFeed(70, 30));
  const exact = index.get("openai/gpt-5");
  const alias = index.get("gpt-5");
  assert.ok(exact && alias, "expected both the exact key and its alias to be registered");
  assert.equal(
    exact.aa_intelligence,
    alias.aa_intelligence,
    "the exact key and its alias must not disagree about the same model",
  );
});

test("indexBenchmarks: the feed's row order does not change the result", () => {
  const forward = indexBenchmarks(duplicateFeed(70, 30));
  const reversed = indexBenchmarks(duplicateFeed(30, 70));
  for (const key of ["openai/gpt-5", "gpt-5"]) {
    assert.equal(forward.get(key).aa_intelligence, reversed.get(key).aa_intelligence, `key ${key} is order-dependent`);
  }
});

test("indexBenchmarks: a design-arena row still merges into the same model's record", () => {
  const index = indexBenchmarks({
    data: [
      { model_permaslug: "openai/gpt-5", display_name: "GPT-5", source: "artificial-analysis", intelligence_index: 70 },
      { model_permaslug: "openai/gpt-5", display_name: "GPT-5", source: "design-arena", elo: 1400 },
    ],
  });
  const hit = index.get("openai/gpt-5");
  assert.equal(hit.aa_intelligence, 70);
  assert.equal(hit.da_elo, 1400);
});

// ---------------------------------------------------------------------------
// A build date is part of the identity (N1)

function datedBuildPayloads() {
  return {
    spec: null,
    openrouter: {
      data: [
        { id: "qwen/qwen3.8-max", name: "Qwen3.8 Max", pricing: {}, supported_parameters: [] },
      ],
    },
    benchmarks: {
      data: [
        {
          model_permaslug: "qwen/qwen3.8-max-20260803",
          display_name: "Qwen3.8 Max",
          source: "artificial-analysis",
          intelligence_index: 60,
        },
        {
          model_permaslug: "qwen/qwen3.8-max-20260902",
          display_name: "Qwen3.8 Max",
          source: "artificial-analysis",
          intelligence_index: 45,
        },
      ],
    },
    lmarena: null,
  };
}

test("an undated alias takes the newest build, not the flattering one", () => {
  const { byId } = buildCatalog(datedBuildPayloads());
  const row = byId.get("qwen/qwen3.8-max");
  assert.equal(row.score, 45, "expected the 20260902 build, not the older 20260803 one");
  assert.equal(row.score_source, "aa");
  assert.equal(row.bench_id, "qwen/qwen3.8-max-20260902", "the row must name the build its number came from");
});

test("the newest build wins regardless of the order the feed lists builds in", () => {
  const payloads = datedBuildPayloads();
  payloads.benchmarks.data.reverse();
  assert.equal(buildCatalog(payloads).byId.get("qwen/qwen3.8-max").score, 45);
});

test("each dated build keeps its own measurement", () => {
  const payloads = datedBuildPayloads();
  payloads.openrouter.data.push(
    { id: "qwen/qwen3.8-max-20260803", name: "Qwen3.8 Max (0803)", pricing: {}, supported_parameters: [] },
  );
  const { byId } = buildCatalog(payloads);
  assert.equal(byId.get("qwen/qwen3.8-max-20260803").score, 60);
  assert.equal(byId.get("qwen/qwen3.8-max").score, 45);
});

// ---------------------------------------------------------------------------
// A display name may not erase what the id says (N2)

test("a -latest alias does not inherit a dated build's measurement through the display name", () => {
  const { byId } = buildCatalog({
    spec: null,
    openrouter: {
      data: [
        { id: "mistralai/devstral-2512", name: "Devstral 2", pricing: {}, supported_parameters: [] },
        { id: "mistral/devstral-latest", name: "Devstral 2", pricing: {}, supported_parameters: [] },
      ],
    },
    benchmarks: {
      data: [
        {
          model_permaslug: "mistralai/devstral-2512",
          display_name: "Devstral 2",
          source: "artificial-analysis",
          intelligence_index: 9.4,
        },
      ],
    },
    lmarena: null,
  });
  assert.equal(byId.get("mistralai/devstral-2512").score, 9.4);
  assert.equal(byId.get("mistralai/devstral-2512").score_source, "aa");
  const latest = byId.get("mistral/devstral-latest");
  assert.notEqual(latest.score_source, "aa", "a moving alias must not claim a dated build's measurement");
  assert.equal(latest.aa_intelligence, null);
});

test("a benchmark whose slug names an effort tier is not registered under the bare display name", () => {
  const index = indexBenchmarks({
    data: [
      {
        model_permaslug: "qwen/qwen3-max-thinking",
        display_name: "Qwen3 Max",
        source: "artificial-analysis",
        intelligence_index: 70,
      },
    ],
  });
  assert.equal(index.get("qwen3-max-thinking").aa_intelligence, 70);
  assert.equal(index.get("qwen3-max"), undefined, "the thinking build must not answer for the plain model");
});

test("a display name is still the last-resort key when it keeps what the id says", () => {
  const { byId } = buildCatalog({
    spec: null,
    openrouter: { data: [{ id: "host/renamed-slug", name: "Shared Display Name", pricing: {}, supported_parameters: [] }] },
    benchmarks: {
      data: [
        {
          model_permaslug: "lab/other-slug",
          display_name: "Shared Display Name",
          source: "artificial-analysis",
          intelligence_index: 42,
        },
      ],
    },
    lmarena: null,
  });
  assert.equal(byId.get("host/renamed-slug").score, 42);
});

test("indexBenchmarks: no feed order can change what a key answers", () => {
  // Three builds of one model claiming the same date-stripped alias, two of them
  // written in different conventions. Whatever the feed's order, one answer.
  const entry = (slug, aa) => ({
    model_permaslug: slug, display_name: "Model X", source: "artificial-analysis", intelligence_index: aa,
  });
  const items = [entry("lab/model-x-2512", 10), entry("lab/model-x-20260803", 60), entry("lab/model-x-20260902", 45)];
  const permutations = (list) => (list.length <= 1 ? [list] : list.flatMap((item, i) =>
    permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [item, ...rest])));

  const answers = new Set(permutations(items).map((data) => {
    const hit = indexBenchmarks({ data }).get("model-x");
    return JSON.stringify([hit.aa_intelligence, hit.from]);
  }));

  assert.equal(answers.size, 1, `a key answered differently per feed order: ${[...answers].join(" | ")}`);
  assert.equal(JSON.parse([...answers][0])[0], 45, "the newest build should answer");
});

test("a host that re-exports under host/lab/model is the same model as the lab's listing", () => {
  const payloads = {
    spec: null,
    openrouter: {
      data: [
        { id: "qwen/qwen3.8-27b", name: "Qwen3.8 27B", pricing: {}, supported_parameters: [] },
        { id: "edenai/qwen/qwen3.8-27b", name: "Qwen3.8 27B", pricing: {}, supported_parameters: [] },
        { id: "llmgateway-providers/consensusprotocol/Qwen3.8-27B", name: "Qwen3.8-27B", pricing: {}, supported_parameters: [] },
      ],
    },
    benchmarks: {
      data: [
        {
          model_permaslug: "qwen/qwen3.8-27b",
          display_name: "Qwen3.8 27B",
          source: "artificial-analysis",
          intelligence_index: 33.9,
        },
      ],
    },
    lmarena: null,
  };

  const { rows } = buildCatalog(payloads);
  const scored = rows.filter((row) => /qwen3\.?8-?27b/i.test(row.id));
  assert.ok(scored.length >= 1);
  for (const row of scored) {
    assert.equal(row.score, 33.9, `${row.id} did not find the measurement`);
    assert.equal(row.score_source, "aa");
  }
});

test("a generic last segment does not let one model claim another's measurement", () => {
  const { byId } = buildCatalog({
    spec: null,
    openrouter: {
      data: [
        { id: "minimax/minimax-m3", name: "MiniMax M3", pricing: {}, supported_parameters: [] },
        { id: "otherlab/series/m3", name: "Series M3", pricing: {}, supported_parameters: [] },
      ],
    },
    benchmarks: {
      data: [
        { model_permaslug: "minimax/minimax-m3", display_name: "MiniMax M3", source: "artificial-analysis", intelligence_index: 29.6 },
      ],
    },
    lmarena: null,
  });
  assert.equal(byId.get("minimax/minimax-m3").score, 29.6);
  assert.notEqual(byId.get("otherlab/series/m3").score_source, "aa");
});

// The two data quirks ref §4 says to settle rather than inherit. Both fail
// against the verbatim copy: `perMillion("-1")` is -1000000, and
// `collapseListings` unions input_modalities only.

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

test('a sentinel price loses to the other source, not to nothing (§16.4)', () => {
  // The guard used to be applied AFTER the sources became one value
  // (`usableNumber(orIn != null ? orIn : mdIn)`): OpenRouter's -1 won the
  // preference, then got discarded, and models.dev's real 2/M was never
  // consulted. Two listings of one identity sit here because listingRank
  // awards +10 for a priced row, so recovering the price also decides which
  // listing represents the collapsed identity.
  const { rows } = buildCatalog({
    spec: { venomlab: { name: 'Venom Lab', models: { 'x-one': {
      id: 'x-one', name: 'X One', cost: { input: 2, output: 3 },
    } } } },
    openrouter: { data: [
      { id: 'venomlab/x-one', name: 'X One', pricing: { prompt: '-1', completion: '-1' } },
      { id: 'host/x-one', name: 'X One' },
    ] },
    benchmarks: null, lmarena: null,
  });
  const merged = rows.filter((r) => r.id.replace(/^[^/]+\//, '') === 'x-one');
  assert.equal(merged.length, 1, 'two listings of one identity collapse to one row');
  const [row] = merged;
  assert.equal(row.cost_in_per_m, 2, "the fallback source's price survives the sentinel");
  assert.equal(row.cost_out_per_m, 3);
  assert.equal(row.cost_kind, 'token', 'a real price reads as priced, not as free or unknown');
  assert.equal(row.id, 'venomlab/x-one', 'the recovered price, not id order, decides the winner');
});

test('output_modalities is unioned across listings of one identity (§16.6)', () => {
  // Both listings stay text-capable on purpose: a row whose published output
  // list holds no `text` is dropped as proven non-text BEFORE collapseListings
  // runs (ref §15 step 4), so an image-only sibling never reaches the union.
  // The priced listing wins the collapse and it is the one that says `text`
  // alone, so without the union the merged row never learns `image`.
  const { rows } = buildCatalog({
    spec: null,
    openrouter: { data: [
      { id: 'lab/model-a', name: 'Model A', architecture: { output_modalities: ['text'] },
        pricing: { prompt: '0.000001', completion: '0.000002' } },
      { id: 'host/model-a', name: 'Model A', architecture: { output_modalities: ['image', 'text'] } },
    ] },
    benchmarks: null, lmarena: null,
  });
  const merged = rows.filter((r) => r.id.replace(/^[^/]+\//, '') === 'model-a');
  assert.equal(merged.length, 1, 'two listings of one identity collapse to one row');
  assert.equal(merged[0].id, 'lab/model-a', 'the text-only listing is the one that survives collapsed');
  assert.match(merged[0].output_modalities, /text/);
  assert.match(merged[0].output_modalities, /image/);
});
