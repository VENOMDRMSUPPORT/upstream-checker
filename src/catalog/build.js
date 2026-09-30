"use strict";

// The scoring catalog: merges the four upstream sources into one row per model
// and computes score / rank for each. It is never shown in the UI; provider
// rows are matched against it to inherit their score (see lib/scoring.js).
//
// Pipeline (buildCatalog):
//   1. OpenRouter models are the primary rows; models.dev spec is joined by id / alias.
//   2. Benchmarks are matched through quality keys (lib/keys.js); ambiguous keys are skipped.
//      Quality is never copied between sibling rows: an unmeasured "-latest" or
//      "-thinking" row stays estimated rather than borrowing a measurement, and
//      an undated alias claimed by several dated builds takes the newest one.
//   3. collapseListings groups duplicate listings (`:free`, `~`, host prefixes).
//   4. applyLmarena attaches Arena Elo / rank (strict keys, then loose keys).
//   5. assignScores + assignDenseRank (lib/scoring.js); equal scores share a rank.

const {
  asNumber,
  perMillion,
  uniqueJoin,
  unixToDate,
  boolOrNull,
  hasParam,
  listHas,
  providerOf,
} = require("./util");
const {
  MATCH_AMBIGUOUS,
  LAB_PROVIDERS,
  cleanModelId,
  identityKey,
  benchKeysFromSlug,
  looseArenaKey,
  qualityModelKey,
  qualityNameKey,
  bareModelKey,
  nameKeyIsSafe,
  buildTag,
  compareBuilds,
} = require("./keys");
const { assignScores, assignDenseRank } = require("./scoring");

const IMAGE_SLUG_RE =
  /dall-e|gpt-image|flux|imagen|seedream|nano-banana|ideogram|recraft|stable-diffusion|\bsdxl\b|grok-imagine|muse-image|mai-image|black-forest|lumina-image/i;

// ---------------------------------------------------------------------------
// Derived fields

function deriveCostKind({ inCost, outCost, cacheCost, imageCost, requestCost }) {
  const freeIn = inCost == null || inCost === 0;
  const freeOut = outCost == null || outCost === 0;
  const hasToken = (inCost != null && inCost > 0) || (outCost != null && outCost > 0);
  const hasCache = cacheCost != null && cacheCost > 0;
  const hasImage = imageCost != null && imageCost > 0;
  const hasRequest = requestCost != null && requestCost > 0;
  if (!hasToken && !hasCache && !hasImage && !hasRequest && freeIn && freeOut) {
    if (inCost === 0 && outCost === 0) return "free";
    return "unknown";
  }
  const kinds = [];
  if (hasToken || (inCost === 0 && outCost === 0 && !hasImage && !hasRequest)) kinds.push("token");
  if (hasCache) kinds.push("cache");
  if (hasImage) kinds.push("image");
  if (hasRequest) kinds.push("per_request");
  if (!kinds.length) return "unknown";
  if (kinds.length === 1 && kinds[0] === "token" && inCost === 0 && outCost === 0) return "free";
  return kinds.join("+");
}

function deriveCreateImages(id, outputModalities, architectureModality) {
  if (listHas(outputModalities, "image")) return true;
  if (String(architectureModality || "").toLowerCase().includes("->image")) return true;
  return IMAGE_SLUG_RE.test(String(id || ""));
}

// A negative published price is OpenRouter's -1 sentinel, not a price: it read
// as -1000000 per million and a thin provider row could borrow it (ref §16.4).
const usableNumber = (v) => (v == null || v < 0 ? null : v);

function pickNumber(preferred, fallback, conflicts, field) {
  const a = usableNumber(preferred);
  const b = usableNumber(fallback);
  if (a == null && b == null) return null;
  if (a == null) return b;
  if (b == null) return a;
  if (a !== b) (conflicts || []).push(field);
  return a;
}

// ---------------------------------------------------------------------------
// Source indexes

function indexModelsDev(payload) {
  const byId = new Map();
  if (!payload || typeof payload !== "object") return byId;
  for (const [providerId, provider] of Object.entries(payload)) {
    if (!provider || typeof provider !== "object") continue;
    const models = provider.models && typeof provider.models === "object" ? provider.models : {};
    for (const [modelId, model] of Object.entries(models)) {
      if (!model || typeof model !== "object") continue;
      const id = `${providerId}/${model.id || modelId}`;
      byId.set(id.toLowerCase(), {
        id,
        providerId,
        providerName: provider.name || providerId,
        model,
      });
    }
  }
  return byId;
}

function indexOpenRouterModels(payload) {
  const list = payload && Array.isArray(payload.data) ? payload.data : [];
  return list.filter((item) => item && typeof item === "object" && item.id);
}

/**
 * @returns {{aa_intelligence: number|null, aa_coding: number|null, aa_agentic: number|null,
 *   da_elo: number|null, build: string|null, from: string|null}} every field is filled in
 *   later — this is the empty state, not the shape's limit.
 */
function emptyBench() {
  return { aa_intelligence: null, aa_coding: null, aa_agentic: null, da_elo: null, build: null, from: null };
}

const BENCH_VALUES = ["aa_intelligence", "aa_coding", "aa_agentic", "da_elo"];

function isBetter(next, current) {
  return next != null && (current == null || next > current);
}

/**
 * Fold one slug's finished record into the entry stored under `key`.
 *
 * Every key gets its own copy, so no key can be changed by a write meant for
 * another one. When two different builds claim one key (the date-stripped alias
 * both of them register under), the more authoritative build replaces the other
 * outright rather than blending into it; `compareBuilds` is a total order, so
 * the winner never depends on the order the feed listed them in. Equal builds
 * merge field-wise by max, which is order-independent for the same reason.
 */
function rememberBench(map, key, record) {
  if (!key) return;
  const current = map.get(key);
  if (!current) {
    map.set(key, { ...record });
    return;
  }
  const order = compareBuilds(record.build, current.build);
  if (order > 0) {
    map.set(key, { ...record });
    return;
  }
  if (order < 0) return;
  for (const field of BENCH_VALUES) {
    if (!isBetter(record[field], current[field])) continue;
    current[field] = record[field];
    if (field === "aa_intelligence") current.from = record.from;
  }
}

/**
 * The feed lists one model once per source (Artificial Analysis, Design Arena,
 * OpenRouter), sometimes under different display names. One slug is one model,
 * so every entry sharing a slug folds into a single record first; only then is
 * that finished record registered under the keys it answers to. Doing it in
 * this order is what keeps a key from depending on where in the feed a row sat.
 */
function indexBenchmarks(payload) {
  const list = payload && Array.isArray(payload.data) ? payload.data : [];
  const bySlug = new Map();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const slug = cleanModelId(item.model_permaslug || "");
    if (!slug) continue;
    let entry = bySlug.get(slug);
    if (!entry) {
      const record = emptyBench();
      record.from = slug;
      record.build = buildTag(qualityModelKey(slug, item.display_name || ""));
      entry = { record, names: new Set() };
      bySlug.set(slug, entry);
    }
    entry.names.add(item.display_name || "");
    const { record } = entry;
    if (item.source === "artificial-analysis") {
      if (isBetter(asNumber(item.intelligence_index), record.aa_intelligence)) {
        record.aa_intelligence = asNumber(item.intelligence_index);
      }
      if (isBetter(asNumber(item.coding_index), record.aa_coding)) record.aa_coding = asNumber(item.coding_index);
      if (isBetter(asNumber(item.agentic_index), record.aa_agentic)) record.aa_agentic = asNumber(item.agentic_index);
    }
    if (item.source === "design-arena" && isBetter(asNumber(item.elo), record.da_elo)) {
      record.da_elo = asNumber(item.elo);
    }
  }

  const byKey = new Map();
  for (const [slug, { record, names }] of bySlug) {
    const aliases = new Set();
    for (const display of names) for (const alias of benchKeysFromSlug(slug, display)) aliases.add(alias);
    for (const alias of aliases) rememberBench(byKey, alias, record);
  }
  return byKey;
}

function lookupBench(benches, ...keys) {
  for (const key of keys) {
    if (!key) continue;
    const hit = benches.get(String(key).toLowerCase());
    if (
      hit && (
        hit.aa_intelligence != null ||
        hit.aa_coding != null ||
        hit.aa_agentic != null ||
        hit.da_elo != null
      )
    ) return hit;
  }
  return emptyBench();
}

function benchFromOpenRouterModel(model) {
  const out = emptyBench();
  const aa = model && model.benchmarks && model.benchmarks.artificial_analysis;
  if (aa) {
    out.aa_intelligence = asNumber(aa.intelligence_index);
    out.aa_coding = asNumber(aa.coding_index);
    out.aa_agentic = asNumber(aa.agentic_index);
  }
  const arena = model && model.benchmarks && Array.isArray(model.benchmarks.design_arena)
    ? model.benchmarks.design_arena
    : [];
  for (const item of arena) {
    const elo = item && asNumber(item.elo);
    if (elo != null && (out.da_elo == null || elo > out.da_elo)) out.da_elo = elo;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Row post-processing

function listingRank(row) {
  const provider = providerOf(cleanModelId(row.id)).toLowerCase();
  let rank = 0;
  const labIndex = LAB_PROVIDERS.indexOf(provider);
  if (labIndex >= 0) rank += 200 - labIndex;
  if ((row.sources || []).includes("openrouter-public")) rank += 40;
  if (row.aa_intelligence != null) rank += 30;
  if (row.cost_in_per_m != null) rank += 10;
  if (!String(row.id).startsWith("~")) rank += 5;
  if (!String(row.id).includes(":")) rank += 5;
  return rank;
}

function collapseListings(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = identityKey(row.id);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const collapsed = [];
  for (const group of groups.values()) {
    group.sort((a, b) => listingRank(b) - listingRank(a) || String(a.id).localeCompare(String(b.id)));
    const winner = { ...group[0], sources: [...(group[0].sources || [])] };
    const providers = [];
    const listings = [];
    for (const row of group) {
      listings.push(row.id);
      const provider = row.provider || providerOf(row.id);
      if (provider && !providers.includes(provider)) providers.push(provider);
      if (row.aa_intelligence != null && (winner.aa_intelligence == null || row.aa_intelligence > winner.aa_intelligence)) {
        winner.aa_intelligence = row.aa_intelligence;
        winner.bench_id = row.bench_id || null;
      }
      if (row.aa_coding != null && (winner.aa_coding == null || row.aa_coding > winner.aa_coding)) {
        winner.aa_coding = row.aa_coding;
      }
      if (row.aa_agentic != null && (winner.aa_agentic == null || row.aa_agentic > winner.aa_agentic)) {
        winner.aa_agentic = row.aa_agentic;
      }
      if (winner.da_elo == null && row.da_elo != null) winner.da_elo = row.da_elo;
      else if (row.da_elo != null && winner.da_elo != null && row.da_elo > winner.da_elo) winner.da_elo = row.da_elo;
      if (row.tools === true) winner.tools = true;
      if (row.reasoning === true) winner.reasoning = true;
      if (row.structured === true) winner.structured = true;
      if (row.attachment === true) winner.attachment = true;
      if (row.create_images === true) winner.create_images = true;
      if ((row.context_tokens || 0) > (winner.context_tokens || 0)) winner.context_tokens = row.context_tokens;
      if ((row.output_tokens || 0) > (winner.output_tokens || 0)) winner.output_tokens = row.output_tokens;
      winner.input_modalities = uniqueJoin([winner.input_modalities, row.input_modalities]);
      winner.output_modalities = uniqueJoin([winner.output_modalities, row.output_modalities]);
      if (!winner.release_date && row.release_date) winner.release_date = row.release_date;
      for (const source of row.sources || []) {
        if (!winner.sources.includes(source)) winner.sources.push(source);
      }
    }
    winner.providers = providers;
    winner.listings = listings;
    winner.provider_count = providers.length;
    collapsed.push(winner);
  }
  return collapsed;
}

// ---------------------------------------------------------------------------
// LMArena

function putLoose(map, key, rec, canonical) {
  if (!key) return;
  const current = map.get(key);
  if (!current) {
    map.set(key, { ...rec, canonical });
    return;
  }
  if (current === MATCH_AMBIGUOUS) return;
  if (current.canonical === canonical) {
    if ((rec.elo || 0) > (current.elo || 0)) map.set(key, { ...rec, canonical });
    return;
  }
  map.set(key, MATCH_AMBIGUOUS);
}

function indexLmarena(payload) {
  const strict = new Map();
  const loose = new Map();
  const list = payload && Array.isArray(payload.data) ? payload.data : [];
  for (const item of list) {
    if (!item || !item.model_name) continue;
    const rec = {
      elo: asNumber(item.rating),
      rank: asNumber(item.rank),
      votes: asNumber(item.vote_count),
    };
    for (const key of benchKeysFromSlug(item.model_name, item.model_name)) {
      if (!key) continue;
      const current = strict.get(key);
      if (!current || (rec.elo || 0) > (current.elo || 0)) strict.set(key, rec);
    }
    const canonical = qualityModelKey(item.model_name, item.model_name);
    const looseKey = looseArenaKey(item.model_name, item.organization);
    if (looseKey && looseKey !== canonical) putLoose(loose, looseKey, rec, canonical);
  }
  return { strict, loose };
}

function lookupArena(index, strictKeys, looseKeys) {
  for (const key of strictKeys) {
    const hit = index.strict.get(key);
    if (hit) return hit;
  }
  for (const key of looseKeys) {
    const hit = index.loose.get(key);
    if (hit && hit !== MATCH_AMBIGUOUS) return hit;
  }
  return null;
}

function applyLmarena(rows, payload) {
  if (!payload) return;
  const textIndex = indexLmarena(payload);
  const webIndex = indexLmarena({ data: payload.webdev || [] });
  for (const row of rows) {
    const keys = [qualityModelKey(row.id, row.name), identityKey(row.id)];
    if (nameKeyIsSafe(row.id, row.name)) keys.push(qualityNameKey(row.name));
    const looseKeys = [...new Set([...keys, looseArenaKey(row.id, "")])];
    const textHit = lookupArena(textIndex, keys, looseKeys);
    const codeHit = lookupArena(webIndex, keys, looseKeys);
    if (textHit) {
      row.lmarena_elo = textHit.elo;
      row.lmarena_rank = textHit.rank;
      row.lmarena_votes = textHit.votes;
    }
    if (codeHit) {
      row.lmarena_code_elo = codeHit.elo;
      row.lmarena_code_rank = codeHit.rank;
    }
    if ((textHit || codeHit) && !row.sources.includes("lmarena")) row.sources.push("lmarena");
  }
}

// ---------------------------------------------------------------------------
// Build

/**
 * @param {{ spec, openrouter, benchmarks, lmarena }} payloads  raw source payloads (null when missing)
 * @returns {{ rows: object[], byId: Map<string, object>, fits: object }}
 */
/**
 * Does this row PROVE it cannot answer in text?
 *
 * The one test the owner's ruling rests on, kept in one place so the catalog
 * and anything downstream cannot disagree about what "non-text" means.
 *
 * Positive proof only: a published output list that does not contain `text`.
 *   "video" / "image" / "audio"  → true, drop it
 *   "text, image"                → false, it answers in text
 *   "" or undefined              → false, nothing was published
 *
 * The last line is the important one. Reading an unpublished modality as
 * non-text would delete every row from a provider that publishes no metadata,
 * which is most of them.
 */
function declaresNonTextOutput(row) {
  const out = String(row.output_modalities || "")
    .toLowerCase()
    .split(/[,\s]+/)
    .filter(Boolean);
  return out.length > 0 && !out.includes("text");
}

function buildCatalog({ spec: specPayload, openrouter: orPayload, benchmarks: benchPayload, lmarena: lmarenaPayload }) {
  const spec = indexModelsDev(specPayload);
  const orModels = indexOpenRouterModels(orPayload);
  const benches = indexBenchmarks(benchPayload);
  const rows = [];
  const seenSpec = new Set();

  for (const model of orModels) {
    const id = String(model.id);
    const capKey = cleanModelId(id);
    const aliasKey = model.alias_target ? cleanModelId(model.alias_target) : "";
    const specHit = spec.get(capKey) || (aliasKey ? spec.get(aliasKey) : null);
    if (specHit) seenSpec.add(specHit.id.toLowerCase());
    const md = specHit ? specHit.model : null;
    const params = model.supported_parameters;
    const conflicts = [];
    const nested = benchFromOpenRouterModel(model);
    const mdContext = md && md.limit ? asNumber(md.limit.context) : null;
    const orContext = asNumber(model.context_length);
    const mdOutput = md && md.limit ? asNumber(md.limit.output) : null;
    const orOutput = model.top_provider ? asNumber(model.top_provider.max_completion_tokens) : null;
    const orIn = perMillion(model.pricing && model.pricing.prompt);
    const orOut = perMillion(model.pricing && model.pricing.completion);
    const orCache = perMillion(
      (model.pricing && (model.pricing.input_cache_read || model.pricing.cache_read)) || null,
    );
    const orImage = perMillion(model.pricing && model.pricing.image);
    const orRequest = asNumber(model.pricing && model.pricing.request);
    const mdIn = md && md.cost ? asNumber(md.cost.input) : null;
    const mdOut = md && md.cost ? asNumber(md.cost.output) : null;
    const mdCache = md && md.cost ? asNumber(md.cost.cache_read) : null;
    const inCost = usableNumber(orIn != null ? orIn : mdIn);
    const outCost = usableNumber(orOut != null ? orOut : mdOut);
    const cacheCost = usableNumber(orCache != null ? orCache : mdCache);
    const inputMods = uniqueJoin([
      md && md.modalities && md.modalities.input,
      model.architecture && model.architecture.input_modalities,
    ]);
    const outputMods = uniqueJoin([
      md && md.modalities && md.modalities.output,
      model.architecture && model.architecture.output_modalities,
    ]);
    const bench = lookupBench(
      benches,
      capKey,
      aliasKey,
      model.canonical_slug,
      qualityModelKey(capKey, model.name),
      qualityModelKey(aliasKey, ""),
      bareModelKey(capKey),
      bareModelKey(aliasKey),
      nameKeyIsSafe(id, model.name) ? qualityNameKey(model.name) : "",
    );
    const aa = bench.aa_intelligence != null ? bench.aa_intelligence : nested.aa_intelligence;
    const benchId = bench.aa_intelligence != null && bench.from && bench.from !== capKey ? bench.from : null;
    const coding = bench.aa_coding != null ? bench.aa_coding : nested.aa_coding;
    const agentic = bench.aa_agentic != null ? bench.aa_agentic : nested.aa_agentic;
    const da = bench.da_elo != null ? bench.da_elo : nested.da_elo;
    const sources = ["openrouter-public"];
    if (specHit) sources.unshift("models-dev-spec");
    if (aa != null || coding != null || da != null) sources.push("openrouter-keyed");

    rows.push({
      id,
      name: (model.name || (md && md.name) || id).replace(/^[^:]+:\s*/, ""),
      provider: specHit ? specHit.providerName : providerOf(id),
      context_tokens: pickNumber(mdContext, orContext, conflicts, "context_tokens"),
      output_tokens: pickNumber(mdOutput, orOutput, conflicts, "output_tokens"),
      input_modalities: inputMods,
      // Computed since this file was written and never carried onto the row.
      // Without it a text-to-video model is indistinguishable from a chat
      // model in the catalog, and `lib/tiers.js` reads every row as
      // `modality_unknown` because the field it gates on is always undefined.
      output_modalities: outputMods,
      cost_in_per_m: inCost,
      cost_out_per_m: outCost,
      cost_kind: deriveCostKind({
        inCost,
        outCost,
        cacheCost,
        imageCost: orImage,
        requestCost: orRequest,
      }),
      tools: md && md.tool_call != null ? Boolean(md.tool_call) : hasParam(params, "tools") || null,
      reasoning:
        md && md.reasoning != null
          ? Boolean(md.reasoning)
          : Boolean(model.reasoning) || hasParam(params, "include_reasoning") || hasParam(params, "reasoning") || null,
      structured:
        md && md.structured_output != null
          ? Boolean(md.structured_output)
          : hasParam(params, "response_format") || hasParam(params, "structured_outputs") || null,
      attachment:
        md && md.attachment != null
          ? Boolean(md.attachment)
          : listHas(inputMods, "file") || listHas(inputMods, "pdf") || listHas(inputMods, "document") || null,
      release_date: (md && md.release_date) || unixToDate(model.created) || "",
      create_images: deriveCreateImages(
        id,
        outputMods,
        model.architecture && model.architecture.modality,
      ),
      score: null,
      aa_intelligence: aa,
      aa_coding: coding,
      aa_agentic: agentic,
      da_elo: da,
      // Which benchmark entry supplied the measurement, when it was not this
      // row's own slug (an undated alias served by a dated build).
      bench_id: benchId,
      sources,
      conflicts,
    });
  }

  for (const [key, specHit] of spec) {
    if (seenSpec.has(key)) continue;
    const md = specHit.model;
    const inCost = usableNumber(md.cost ? asNumber(md.cost.input) : null);
    const outCost = usableNumber(md.cost ? asNumber(md.cost.output) : null);
    const cacheCost = usableNumber(md.cost ? asNumber(md.cost.cache_read) : null);
    const inputMods = uniqueJoin([md.modalities && md.modalities.input]);
    const outputMods = uniqueJoin([md.modalities && md.modalities.output]);
    const specName = md.name || specHit.id;
    const bench = lookupBench(
      benches,
      key,
      qualityModelKey(key, specName),
      bareModelKey(key),
      nameKeyIsSafe(specHit.id, specName) ? qualityNameKey(specName) : "",
    );
    const sources = ["models-dev-spec"];
    if (bench.aa_intelligence != null || bench.aa_coding != null || bench.da_elo != null) {
      sources.push("openrouter-keyed");
    }
    rows.push({
      id: specHit.id,
      name: md.name || specHit.id,
      provider: specHit.providerName,
      context_tokens: md.limit ? asNumber(md.limit.context) : null,
      output_tokens: md.limit ? asNumber(md.limit.output) : null,
      input_modalities: inputMods,
      // Computed since this file was written and never carried onto the row.
      // Without it a text-to-video model is indistinguishable from a chat
      // model in the catalog, and `lib/tiers.js` reads every row as
      // `modality_unknown` because the field it gates on is always undefined.
      output_modalities: outputMods,
      cost_in_per_m: inCost,
      cost_out_per_m: outCost,
      cost_kind: deriveCostKind({ inCost, outCost, cacheCost, imageCost: null, requestCost: null }),
      tools: boolOrNull(md.tool_call),
      reasoning: boolOrNull(md.reasoning),
      structured: boolOrNull(md.structured_output),
      attachment: boolOrNull(md.attachment),
      release_date: md.release_date || "",
      create_images: deriveCreateImages(specHit.id, outputMods, ""),
      score: null,
      aa_intelligence: bench.aa_intelligence,
      aa_coding: bench.aa_coding,
      aa_agentic: bench.aa_agentic,
      da_elo: bench.da_elo,
      bench_id: bench.aa_intelligence != null && bench.from && bench.from !== key ? bench.from : null,
      sources,
      conflicts: [],
    });
  }

  // A model that cannot answer in text is not this app's business (owner's
  // ruling, 2026-09-16). Dropped HERE — before collapsing, before the fits are
  // computed, before ranking — so it never influences a number either: a
  // text-to-video model's price and context would otherwise sit in the spec
  // regression that estimates every chat model's score.
  //
  // PROVEN non-text only. `output_modalities` says "video" or "image" or
  // "audio" and text is absent; a row that publishes NOTHING is left alone,
  // because absence of a modality is not evidence of one. That is the opposite
  // direction from `lib/tiers.js`'s gate, and deliberately so: refusing to
  // ROUTE to something unproven costs a request, while deleting it from the
  // catalog would silently erase every provider that publishes no metadata —
  // all eighteen of nexum-router's rows among them.
  const nonText = rows.filter((row) => declaresNonTextOutput(row));
  const text = rows.filter((row) => !declaresNonTextOutput(row));
  const collapsed = collapseListings(text);
  applyLmarena(collapsed, lmarenaPayload);
  const fits = assignScores(collapsed);
  assignDenseRank(collapsed);
  collapsed.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const byId = new Map();
  for (const row of collapsed) byId.set(row.id, row);
  // The dropped rows are returned, not merely counted. A provider that
  // publishes no modality of its own — nexum-router publishes none for any of
  // its eighteen listings — can only learn that one of its models is an image
  // generator by matching it against a model the catalog KNOWS is one. Throwing
  // that evidence away is what left `wan-2.0` and `qwen-image` sitting in the
  // table as permanently unrated rows with nothing to explain them.
  return { rows: collapsed, byId, fits, nonText };
}

module.exports = {
  buildCatalog,
  indexModelsDev,
  indexOpenRouterModels,
  indexBenchmarks,
};
