"use strict";

// Score estimation, dense ranking, and the lookup that gives provider rows their
// score. Pure functions over row arrays: no IO, no globals.
//
// `score` is the Artificial Analysis intelligence index when AA measured the
// model (score_source = "aa"). Otherwise it is estimated from whatever quality
// signals the row has, each mapped onto the AA scale by a least-squares fit
// computed from the rows that carry both values, so the mapping recalibrates on
// every sync. Available estimates are blended, weighted by each fit's R², and
// flagged with score_source = "est" plus the list of inputs in score_basis.
// A provider-only route that borrows its declared base route's score is
// flagged score_source = "proxy" (see attachScores).

const { median, clamp, monthsSince } = require("./util");
const {
  MATCH_AMBIGUOUS,
  cleanModelId,
  qualityModelKey,
  qualityNameKey,
  bareModelKey,
  looseModelKey,
  nameKeyIsSafe,
  pricingTokenCount,
} = require("./keys");

const MIN_FIT_SAMPLES = 30;
const MIN_FIT_R2 = 0.3;
const SPEC_AGE_CAP_MONTHS = 36;

// Lower is better: a measured AA index beats an estimate inherited from the
// reference, which beats an estimate from the row's own declared facts, which
// beats having no score at all.
const SCORE_QUALITY = { aa: 0, est: 1, proxy: 1, local: 2 };

function scoreQuality(row) {
  if (row.score == null) return 3;
  const rank = SCORE_QUALITY[row.score_source];
  return rank == null ? 1 : rank;
}

/** Simple linear regression y = a + b*x. Returns null when too few points or too weak. */
function fitLinear(pairs) {
  const seen = new Set();
  const pts = pairs.filter(([x, y]) => {
    const key = `${x}|${y}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const n = pts.length;
  if (n < MIN_FIT_SAMPLES) return null;
  let mx = 0;
  let my = 0;
  for (const [x, y] of pts) {
    mx += x;
    my += y;
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of pts) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  if (!sxx || !syy) return null;
  const slope = sxy / sxx;
  const r2 = (sxy * sxy) / (sxx * syy);
  if (r2 < MIN_FIT_R2) return null;
  return { n, r2, predict: (x) => my + slope * (x - mx) };
}

/** Solve A·w = b by Gaussian elimination with partial pivoting. */
function solveLinear(matrix, vector) {
  const n = matrix.length;
  const m = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const factor = m[r][col] / m[col][col];
      for (let k = col; k <= n; k += 1) m[r][k] -= factor * m[col][k];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

// Spec-only signal: price, context, capabilities, age, and how many hosts list
// the model. Weak on its own, but the fit against measured AA rows tells us
// exactly how weak (its R²), and that is the weight it gets in the blend.
function specFeatures(row, defaults) {
  const rawCost = row.cost_in_per_m;
  // A promotional or free price is NOT a quality signal. The fit learned
  // "pricier means smarter" from list prices, so feeding it a $0.00 stealth
  // launch drags the estimate to the bottom of the range: big-pickle carries a
  // $0 price, one host and an eleven-month-old release date, and scored 0.2
  // while the same row at the training median price scores 11.1. A zero is
  // treated as unknown and falls back to the median instead of reading as cheap.
  const cost = typeof rawCost === 'number' && rawCost > 0 ? rawCost : defaults.cost;
  const age = monthsSince(row.release_date);
  return [
    1,
    Math.log10(cost + 0.05),
    Math.log10(row.context_tokens || defaults.context),
    row.reasoning === true ? 1 : 0,
    row.tools === true ? 1 : 0,
    Math.min(age != null ? age : defaults.age, SPEC_AGE_CAP_MONTHS),
    Math.log10(row.provider_count || 1),
  ];
}

function fitSpec(rows) {
  const train = rows.filter(
    // `cost > 0`, not merely `cost != null`: a free row is not evidence that the
    // cheap end is bad, and letting one into the training set lets the fit read a
    // $0.00 launch as the lowest price the market has and learn from it.
    (r) => r.aa_intelligence != null && r.cost_in_per_m != null && r.cost_in_per_m > 0
      && monthsSince(r.release_date) != null,
  );
  if (train.length < MIN_FIT_SAMPLES * 3) return null;
  const defaults = {
    cost: median(train.map((r) => r.cost_in_per_m)),
    context: median(train.map((r) => r.context_tokens)) || 8000,
    age: median(train.map((r) => monthsSince(r.release_date))),
  };
  const rowsX = train.map((r) => specFeatures(r, defaults));
  const y = train.map((r) => r.aa_intelligence);
  const k = rowsX[0].length;
  const xtx = Array.from({ length: k }, () => Array(k).fill(0));
  const xty = Array(k).fill(0);
  rowsX.forEach((f, idx) => {
    for (let i = 0; i < k; i += 1) {
      xty[i] += f[i] * y[idx];
      for (let j = 0; j < k; j += 1) xtx[i][j] += f[i] * f[j];
    }
  });
  for (let i = 0; i < k; i += 1) xtx[i][i] += 1e-6;
  const w = solveLinear(xtx, xty);
  if (!w) return null;
  const dot = (f) => f.reduce((sum, v, i) => sum + v * w[i], 0);
  const meanY = y.reduce((a, b) => a + b, 0) / y.length;
  let ssr = 0;
  let sst = 0;
  rowsX.forEach((f, idx) => {
    ssr += (y[idx] - dot(f)) ** 2;
    sst += (y[idx] - meanY) ** 2;
  });
  const r2 = sst ? 1 - ssr / sst : 0;
  if (r2 < MIN_FIT_R2) return null;
  return { n: train.length, r2, predict: (row) => dot(specFeatures(row, defaults)) };
}

// Only a row that declared something is estimated. With no cost, no context, no
// release date and no capabilities, the fit would answer from the training
// medians alone — a number describing the market, not the model.
// An empty string is not a declaration. The adapters hand back `release_date: ""`
// for a model they know nothing about, and `"" != null` is true — so every thin
// row used to pass this test and take the training mean as its score.
function hasSpecSignal(row) {
  if (typeof row.cost_in_per_m === "number" && row.cost_in_per_m > 0) return true;
  if (typeof row.context_tokens === "number" && row.context_tokens > 0) return true;
  if (typeof row.release_date === "string" && row.release_date.trim() !== "") return true;
  return row.reasoning === true || row.tools === true;
}

// The spec fit lives in a WeakMap keyed by the catalog row array, because
// attachScores is handed the same array on every render: one sync pays for one
// fit and every render after it is free.
const specModelCache = new WeakMap();

/**
 * The local estimator, fitted on the catalog and cached against it.
 *
 * This is what scores a row the reference does not carry. A provider that adds a
 * model tomorrow cannot be matched against a catalog that has never heard of it,
 * but it can still declare a price, a context window and its capabilities — and
 * those are exactly the features the fit regressed onto the AA scale. So the
 * score comes out of arithmetic over metadata already on hand: no request, no
 * key, no quota, and nothing to wait for.
 *
 * Returns null when the catalog is too thin to fit.
 */
function specModelFor(catalogRows) {
  if (!catalogRows || !catalogRows.length) return null;
  const cached = specModelCache.get(catalogRows);
  if (cached !== undefined) return cached;
  const fit = fitSpec(catalogRows);
  let model = null;
  if (fit) {
    const measured = catalogRows.filter((r) => r.aa_intelligence != null);
    const lowest = measured.reduce((min, r) => Math.min(min, r.aa_intelligence), Infinity);
    const highest = measured.reduce((max, r) => Math.max(max, r.aa_intelligence), 0);
    model = {
      predict: fit.predict,
      r2: fit.r2,
      n: fit.n,
      floor: Number.isFinite(lowest) ? lowest * 0.9 : 0,
      ceiling: highest * 1.1 || 100,
    };
  }
  specModelCache.set(catalogRows, model);
  return model;
}

/**
 * Set score / score_source / score_basis on every row.
 * Returns a summary of the fits ({ n, r2 } per estimator, or null) for /api/health.
 */
function assignScores(rows) {
  const measured = rows.filter((r) => r.aa_intelligence != null);
  const fits = {
    aa_coding: fitLinear(measured.filter((r) => r.aa_coding != null).map((r) => [r.aa_coding, r.aa_intelligence])),
    arena_code: fitLinear(
      measured.filter((r) => r.lmarena_code_elo != null).map((r) => [r.lmarena_code_elo, r.aa_intelligence]),
    ),
    arena_text: fitLinear(measured.filter((r) => r.lmarena_elo != null).map((r) => [r.lmarena_elo, r.aa_intelligence])),
    spec: fitSpec(rows),
  };
  // The estimate is clamped to the range the reference actually measured, on both
  // ends. The ceiling has always been here; the floor was 0, and 0 is not a score
  // anything in the reference has ever had — the lowest measured index is well
  // above it. Without a floor the fit extrapolates below everything it learned
  // from and 558 of 3283 estimates (17%) come out pinned at exactly 0, which
  // reads as "this model is worthless" rather than "this model is the weakest
  // thing anyone has measured".
  //
  // 0.9x the lowest measured, symmetric with the 1.1x ceiling above.
  const lowestMeasured = measured.reduce((min, r) => Math.min(min, r.aa_intelligence), Infinity);
  const ceiling = measured.reduce((max, r) => Math.max(max, r.aa_intelligence), 0) * 1.1 || 100;
  const floor = Number.isFinite(lowestMeasured) ? lowestMeasured * 0.9 : 0;
  for (const row of rows) {
    if (row.aa_intelligence != null) {
      row.score = row.aa_intelligence;
      row.score_source = "aa";
      row.score_basis = ["aa"];
      continue;
    }
    const parts = [];
    if (fits.aa_coding && row.aa_coding != null) {
      parts.push(["aa_coding", fits.aa_coding.predict(row.aa_coding), fits.aa_coding.r2]);
    }
    if (fits.arena_code && row.lmarena_code_elo != null) {
      parts.push(["arena_code", fits.arena_code.predict(row.lmarena_code_elo), fits.arena_code.r2]);
    }
    if (fits.arena_text && row.lmarena_elo != null) {
      parts.push(["arena_text", fits.arena_text.predict(row.lmarena_elo), fits.arena_text.r2]);
    }
    if (fits.spec) parts.push(["spec", fits.spec.predict(row), fits.spec.r2]);
    if (!parts.length) {
      row.score = null;
      row.score_source = null;
      row.score_basis = [];
      continue;
    }
    let sum = 0;
    let weight = 0;
    for (const [, value, r2] of parts) {
      sum += value * r2;
      weight += r2;
    }
    row.score = Math.round(clamp(sum / weight, floor, ceiling) * 10) / 10;
    row.score_source = "est";
    row.score_basis = parts.map((p) => p[0]);
  }
  return Object.fromEntries(
    Object.entries(fits).map(([key, fit]) => [key, fit ? { n: fit.n, r2: Math.round(fit.r2 * 100) / 100 } : null]),
  );
}

/**
 * Dense 1..N rank by score within the given list: equal scores share a rank and
 * the next distinct score takes the next integer. Rows without a score keep
 * rank = null. The sort order (measured before estimated, then id) only decides
 * display order among equals, never the rank number.
 */
function assignDenseRank(rows) {
  const ordered = rows
    .filter((row) => row.score != null)
    .sort(
      (a, b) =>
        b.score - a.score ||
        scoreQuality(a) - scoreQuality(b) ||
        String(a.id).localeCompare(String(b.id)),
    );
  for (const row of rows) row.rank = null;
  let denseRank = 0;
  /** @type {number|null} */
  let previousScore = null;
  for (const row of ordered) {
    if (previousScore == null || row.score !== previousScore) denseRank += 1;
    row.rank = denseRank;
    previousScore = row.score;
  }
}

// ---------------------------------------------------------------------------
// Matching provider rows to catalog rows
//
// A quality key names one model identity — family, version, effort — so two
// catalog rows that share a key are the same weights listed by different
// hosts. Choosing between them is a choice of listing, not a guess about the
// model: measured beats estimated, then the plain listing (fewest pricing
// tokens), then id. Two *different* identities behind one key (possible only
// in the display-name index) stay ambiguous and are never used.

function preferredListing(a, b) {
  const order =
    scoreQuality(a) - scoreQuality(b) ||
    pricingTokenCount(a.id) - pricingTokenCount(b.id) ||
    String(a.id).localeCompare(String(b.id));
  return order <= 0 ? a : b;
}

/** The model's own segment, with every routing segment in front of it dropped. */
function lastSegmentOf(id) {
  const segments = cleanModelId(id).split("/").filter(Boolean);
  return segments.length ? segments[segments.length - 1] : "";
}

/**
 * Whether two catalogue listings are the same model under different routing.
 *
 * A routing prefix is not identity, and a listing hosted two segments deep keeps
 * the middle one: `kilo/stealth/space-bunny-alpha` and `stealth/space-bunny-alpha`
 * are one model, because the shorter route is a SUFFIX of the longer one. Two
 * paths that disagree anywhere else are two models — `host-a/lab/x` and
 * `host-b/other/x` share a last segment and nothing else, and merging those would
 * be the guess the bare-key rule already refuses.
 */
function sameModelPath(a, b) {
  const left = cleanModelId(a).split("/").filter(Boolean);
  const right = cleanModelId(b).split("/").filter(Boolean);
  if (!left.length || !right.length) return false;
  const [longer, shorter] = left.length >= right.length ? [left, right] : [right, left];
  const tail = longer.slice(longer.length - shorter.length);
  return tail.every((segment, i) => segment === shorter[i]);
}

function putMatch(map, key, row, sameIdentity) {
  if (!key) return;
  const current = map.get(key);
  if (!current) {
    map.set(key, row);
    return;
  }
  if (current === MATCH_AMBIGUOUS || current === row) return;
  // The default identity is the precise key: two listings of one model agree on
  // it, and two different models do not. An index built on a looser key supplies
  // its own test, because under that key the two ARE being declared one model.
  const same = sameIdentity
    ? sameIdentity(current, row)
    : qualityModelKey(current.id, current.name) === qualityModelKey(row.id, row.name);
  if (!same) {
    map.set(key, MATCH_AMBIGUOUS);
    return;
  }
  map.set(key, preferredListing(current, row));
}

function buildMatchIndex(catalogRows) {
  const byExactId = new Map();
  const byId = new Map();
  const byBare = new Map();
  const byLoose = new Map();
  const byName = new Map();
  for (const row of catalogRows) {
    putMatch(byExactId, cleanModelId(row.id), row);
    putMatch(byId, qualityModelKey(row.id, row.name), row);
    // A ROUTING PREFIX IS NOT IDENTITY, and `qualityModelKey` only cuts at the
    // first slash — so a catalog row hosted two segments deep keeps the middle
    // one inside its key: `nano-gpt/qwen/qwen3.5-omni-plus` becomes
    // `qwen-qwen3-5-omni-plus`, which no provider alias will ever spell.
    // `bareModelKey` drops every routing segment, and buildCatalog has used it
    // as a benchmark lookup key from the start; not registering it HERE too is
    // why `qwen-3.5-omni-plus` sat unscored while its catalog row held 27.4.
    //
    // It returns "" for a last segment too generic to own, and `putMatch`
    // marks a collision ambiguous rather than picking — so a loose key can
    // never quietly attach one model's number to another.
    putMatch(byBare, bareModelKey(row.id), row);
    // The last resort, for a host that decorated the name with an edition tag or
    // spelled the version another way. Its identity test asks whether one listing's
    // route is a SUFFIX of the other's, because `qualityModelKey` cuts at the first
    // slash: a listing two segments deep keeps the routing segment inside its key,
    // so the same model at two hosts reads as two identities and would be refused
    // as ambiguous. `kilo/stealth/space-bunny-alpha` and `stealth/space-bunny-alpha`
    // are one model, and this is the index that has to say so.
    //
    // Two paths that disagree anywhere but their tail are still refused: this
    // widens what counts as one host's listing, never what counts as one model.
    putMatch(byLoose, looseModelKey(row.id), row,
      (a, b) => sameModelPath(lastSegmentOf(a.id), lastSegmentOf(b.id)) && sameModelPath(a.id, b.id));
    // A row whose name hides what its id says is reachable by id only.
    if (nameKeyIsSafe(row.id, row.name)) putMatch(byName, qualityNameKey(row.name), row);
  }
  return { byExactId, byId, byBare, byLoose, byName };
}

function hitOf(map, key) {
  const hit = key ? map.get(key) : null;
  return hit && hit !== MATCH_AMBIGUOUS ? hit : null;
}

/** Among candidates the keys allow, the measured one; ties keep the earliest. */
function bestCandidate(candidates) {
  /** @type {any} */
  let best = null;
  for (const hit of candidates) {
    if (hit && (!best || scoreQuality(hit) < scoreQuality(best))) best = hit;
  }
  return best;
}

/**
 * Catalog row for a provider row, in order:
 *   1. an adapter alias (match_ids) equal to a catalog id verbatim — authoritative;
 *   2. the best of the id-based candidates: each alias's quality key, then the
 *      row's own id (adapter order breaks ties);
 *   3. the same candidates against the ROUTE-STRIPPED key, which reaches a
 *      catalog row hosted two segments deep (`nano-gpt/qwen/qwen3.5-omni-plus`);
 *   4. the display name, only when nothing id-based matched *and* the name
 *      keeps every effort/lifecycle token the id asserts (nameKeyIsSafe).
 * Returns null when nothing matches; the caller then tries quality_proxy_ids.
 *
 * Step 3 sits BELOW step 2 on purpose. The bare key is deliberately looser —
 * it throws away every routing segment — so it must never outrank a key that
 * kept them. It is a last resort before falling back to a display name, not a
 * shortcut past the precise keys.
 */
function lookupCatalogRow(row, index) {
  const aliases = row.match_ids || [];
  for (const alt of aliases) {
    const exact = hitOf(index.byExactId, cleanModelId(alt));
    if (exact) return exact;
  }
  const byId = aliases.map((alt) => hitOf(index.byId, qualityModelKey(alt, "")));
  byId.push(hitOf(index.byId, qualityModelKey(row.id, row.name)));
  const best = bestCandidate(byId);
  if (best) return best;

  // `bareModelKey` STRIPS routing segments, so it returns "" for an id that
  // has none — and a provider alias usually has none: `qwen3.5-omni-plus` is
  // already the bare form. So take the stripped key when there is a route to
  // strip, and the plain quality key when there is not. Both sides then speak
  // the same spelling, which is the whole point of the index.
  const bareKey = (id) => bareModelKey(id) || qualityModelKey(id, "");
  const bare = aliases.map((alt) => hitOf(index.byBare, bareKey(alt)));
  bare.push(hitOf(index.byBare, bareKey(row.id)));
  const bareBest = bestCandidate(bare);
  if (bareBest) return bareBest;

  if (nameKeyIsSafe(row.id, row.name)) {
    const named = hitOf(index.byName, qualityNameKey(row.name));
    if (named) return named;
  }

  // Last resort, and the only place a decorated name is tolerated: the loose key
  // drops the edition tags a host appends and settles the two spellings of a
  // version. Both the id and the display name are tried, because either can be
  // the one that carries the model — `xiaomi` names nothing, while the name on
  // the same row names the model.
  //
  // It answers only when one catalogue model owns the key: `putMatch` marks a
  // shared key ambiguous, and `hitOf` treats ambiguous as a miss.
  return hitOf(index.byLoose, looseModelKey(row.id))
    || hitOf(index.byLoose, looseModelKey(row.name));
}

/** The adapter-declared base route of a provider-only variant, if the catalog has it. */
function lookupQualityProxy(row, index) {
  for (const proxyId of row.quality_proxy_ids || []) {
    const hit = hitOf(index.byExactId, cleanModelId(proxyId)) ||
      hitOf(index.byId, qualityModelKey(proxyId, ""));
    if (hit) return hit;
  }
  return null;
}

// Metadata a thin provider row (ids only) may borrow from its catalog match.
// Provider-supplied values always win; only null / empty fields are filled.
const FILLABLE_FIELDS = [
  "context_tokens",
  "output_tokens",
  "input_modalities",
  "output_modalities",
  "tools",
  "reasoning",
  "structured",
  "attachment",
  "release_date",
  // Reference per-token prices for subscription/router views that ship
  // null costs (e.g. nexum-router). Shown as IN/OUT under Plan: $X/M.
  "cost_in_per_m",
  "cost_out_per_m",
];

function fillFromCatalog(row, hit) {
  const filled = [];
  for (const field of FILLABLE_FIELDS) {
    const empty = row[field] == null || row[field] === "";
    if (empty && hit[field] != null && hit[field] !== "") {
      row[field] = hit[field];
      filled.push(field);
    }
  }
  if (filled.length) row.filled_from_catalog = filled;
}

function copyQualityFields(row, hit) {
  row.aa_intelligence = hit.aa_intelligence;
  row.aa_coding = hit.aa_coding;
  row.bench_id = hit.bench_id != null ? hit.bench_id : null;
  row.lmarena_elo = hit.lmarena_elo;
  row.lmarena_rank = hit.lmarena_rank;
  row.lmarena_code_rank = hit.lmarena_code_rank;
  row.catalog_rank = hit.rank;
  row.matched_id = hit.id;
  fillFromCatalog(row, hit);
}

/**
 * Give provider rows their score and a dense rank local to the list.
 * `catalog_rank` keeps the catalog-wide rank for reference; `matched_id` says
 * which catalog row the values (and any borrowed metadata) came from, null when
 * nothing matched. A row served only through an adapter-declared
 * `quality_proxy_ids` route gets score_source "proxy" and `score_proxy_for`.
 */
function attachScores(rows, catalogRows) {
  const index = buildMatchIndex(catalogRows);
  for (const row of rows) {
    const hit = lookupCatalogRow(row, index);
    if (hit) {
      row.score = hit.score;
      row.score_source = hit.score_source;
      row.score_basis = hit.score_basis || [];
      copyQualityFields(row, hit);
      delete row.score_proxy_for;
      continue;
    }
    const proxy = lookupQualityProxy(row, index);
    if (proxy) {
      row.score = proxy.score;
      row.score_source = "proxy";
      row.score_basis = ["proxy", ...(proxy.score_basis || [])];
      copyQualityFields(row, proxy);
      row.score_proxy_for = row.id;
      continue;
    }
    // Nothing in the reference carries this model. Rather than leave the row
    // blank, estimate it from the facts the provider declared, using the same
    // fit that scores the reference's own unmeasured rows — flagged "local" so
    // the number is never mistaken for a borrowed or measured one.
    const local = specModelFor(catalogRows);
    if (local && hasSpecSignal(row)) {
      row.score = Math.round(clamp(local.predict(row), local.floor, local.ceiling) * 10) / 10;
      row.score_source = "local";
      row.score_basis = ["spec"];
      row.catalog_rank = null;
      row.matched_id = null;
      row.bench_id = null;
      delete row.score_proxy_for;
      continue;
    }
    row.score = null;
    row.score_source = null;
    row.score_basis = [];
    row.catalog_rank = null;
    row.matched_id = null;
    row.bench_id = null;
    delete row.score_proxy_for;
  }
  assignDenseRank(rows);
  return rows;
}

module.exports = {
  scoreQuality,
  fitLinear,
  assignScores,
  assignDenseRank,
  buildMatchIndex,
  lookupCatalogRow,
  attachScores,
  specModelFor,
  hasSpecSignal,
};
