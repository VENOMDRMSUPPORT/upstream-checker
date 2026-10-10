// Reference facts for the Providers test table.
//
// A provider's /models payload is a roster, not a spec sheet. What it publishes
// is its own choice, and a thin provider publishes little more than ids — which
// is why the CONTEXT and TYPE columns came up empty for a provider that states
// no limits and then folded themselves away. The facts a row is missing already
// exist locally: main holds the merged reference, and `catalog:ingest` answers
// with a scored row per model for the whole roster at once. This file decides
// what a row should say, so the renderer and its test cannot disagree about it.
//
// Pure on purpose: no window, no document, no DOM. The test evaluates this file
// the same way test/renderer/catalog-caps.test.js evaluates catalog-caps.js.
//
// Nothing here guesses. Every answer is either a value somebody published or
// `null`, and a `null` renders as an em-dash — never as a zero. An unrated model
// is not a bad one, and a model with no published price is not free.

// The five inputs the Providers page checks a row for. These are the catalogue's
// own modality tokens, NOT the legend's capability ids: `vision` there is the
// legend's name for the image token, and `video` there means video GENERATION —
// an output. Reading an input off either id would answer a different question
// than the chip asks.
const TEST_INPUTS = ['text', 'image', 'audio', 'video', 'pdf'];

// The tokens `files` accepts for its answer, matching catalog-caps.filesState and
// row.js readsAttachment so the chip and the legend cannot disagree.
const FILE_TOKENS = ['file', 'pdf', 'document'];

// Two readings before a median is shown, matching the page's own rule for uptime
// (MIN_RUNS_FOR_UPTIME). One reading is a measurement, not a median of anything.
const MIN_SAMPLES_FOR_LATENCY = 2;

/**
 * The context window a row should show.
 *
 * The provider's own answer wins when it published one — it is authoritative for
 * what it serves — and the reference fills only the gap. Same order
 * app.js readContextWindow already reads, so the two pages agree.
 *
 * @returns {number|null}
 */
function resolveContext(ownContext, catRow) {
  if (ownContext != null) return ownContext;
  const cat = catRow || {};
  return cat.context_tokens != null ? cat.context_tokens : null;
}

/**
 * The reference's score for a row, and which tier it came from.
 *
 * Only the reference has a score. An unrated model stays null rather than 0,
 * because a zero sorts below a measured 12 and reads as a claim nobody made.
 * `aa` is the measured Artificial Analysis index; `est` is the fitted estimate.
 *
 * @returns {{ value: number|null, source: string|null }}
 */
function resolveScore(catRow) {
  const cat = catRow || {};
  const value = cat.score != null ? cat.score : null;
  return {
    value,
    source: value == null ? null : (cat.score_source || null),
  };
}

/**
 * Input and output price per million tokens.
 *
 * Read from the ingested row only, never re-parsed from the provider payload:
 * row.js readPricing already walks all eight shapes the ecosystem uses, and a
 * second parser here would be a second answer to the same question. `null` on a
 * side means nothing was published for it — not that it is free.
 *
 * @returns {{ in: number|null, out: number|null }}
 */
function resolveCost(catRow) {
  const cat = catRow || {};
  return {
    in: cat.cost_in_per_m != null ? cat.cost_in_per_m : null,
    out: cat.cost_out_per_m != null ? cat.cost_out_per_m : null,
  };
}

/**
 * The row the capability renderer reads.
 *
 * The ingested row is already normalised — mapRows ran the provider's fields
 * through the same readers the Models page uses — so it is used as-is. The raw
 * provider model is the fallback for the window before an ingest has answered,
 * where the first paint would otherwise disagree with every later one. `kind`
 * is a §8.1 field (row.js readsKind of the provider's explicit supports_*
 * flags): a stored verdict outranks re-deriving it from the raw model, whose
 * flags mean the same thing in a different place.
 */
function resolveCapabilityRow(model, catRow) {
  const cat = catRow || {};
  const own = model || {};
  const hasCat = cat && (cat.input_modalities != null || cat.tools != null
    || cat.reasoning != null || cat.structured != null || cat.attachment != null
    || cat.output_modalities != null || cat.kind != null);
  if (hasCat) return cat;
  return {
    tools: own.tools != null ? own.tools : null,
    reasoning: own.reasoning != null ? own.reasoning : null,
    structured: own.structured != null ? own.structured : null,
    attachment: own.attachment != null ? own.attachment : null,
    input_modalities: own.input_modalities != null ? own.input_modalities : null,
    output_modalities: own.output_modalities != null ? own.output_modalities : null,
    kind: own.kind != null ? own.kind : null,
  };
}

/**
 * One answer per token in TEST_INPUTS, in that order.
 *
 * `null` is silence and stays `null`: a chip is only drawn for a token somebody
 * answered. A published list that omits a token IS an answer of `false` — that
 * is the whole reason these are three-state and not booleans.
 *
 * @returns {Array<{ token: string, state: boolean|null }>}
 */
function resolveInputs(capRow) {
  const row = capRow || {};
  return TEST_INPUTS.map((token) => ({
    token,
    state: token === 'pdf' ? filesState(row) : readsToken(row, token),
  }));
}

// A published modality list, or silence. Matches catalog-caps.hasModality: an
// empty or absent list is `null`, and a non-empty list answers yes or no for
// every token it does not contain.
function readsToken(row, token) {
  const parts = modalityParts(row && row.input_modalities);
  if (!parts.length) return null;
  return parts.includes(token);
}

// `files` prefers a published boolean and falls back to the list, the same order
// row.js readsAttachment and catalog-caps.filesState use.
function filesState(row) {
  const r = row || {};
  if (r.attachment === true) return true;
  if (r.attachment === false) return false;
  const parts = modalityParts(r.input_modalities);
  if (!parts.length) return null;
  return FILE_TOKENS.some((t) => parts.includes(t));
}

function modalityParts(list) {
  return String(list == null ? '' : list).toLowerCase().split(/[,\s]+/).filter(Boolean);
}

/**
 * A per-million price, at a decimal count that survives the range.
 *
 * Prices span four orders of magnitude — $0.002 to $30 — so a fixed two decimals
 * is either noise at the top or a rounded-to-zero at the bottom.
 */
function fmtPrice(v) {
  // Number(null) is 0 and Number('') is 0, so the gap has to be caught before
  // the conversion or an unpriced model prints as a free one.
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.01) return n.toFixed(3);
  return n.toFixed(4);
}

/**
 * Whether any row has an answer for a column.
 *
 * Every provider shows the same columns, always — a column with no answers
 * renders em-dashes, never folds away. This helper only reports data presence
 * (kept so the table and its test share one definition of "has an answer").
 */
function columnHasData(factsList, field) {
  return (factsList || []).some((f) => {
    if (!f) return false;
    if (field === 'context') return f.context != null;
    if (field === 'score') return f.score != null;
    if (field === 'price') return f.cost && (f.cost.in != null || f.cost.out != null);
    if (field === 'caps') return Array.isArray(f.inputs) && f.inputs.some((i) => i.state != null);
    if (field === 'latency') return f.latency != null;
    return false;
  });
}

/**
 * A duration in milliseconds, at a width a table column can hold.
 *
 * The same shape catalog.js fmtMs uses for the health latency it shows on the
 * Models page, so the two pages cannot print the same measurement two ways. It
 * lives here as well because that one is scoped inside that module and is not
 * reachable from the provider table.
 */
function fmtMs(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

/**
 * The CSS class a latency's magnitude is painted with.
 *
 * The live page reads its own bands from settings (the Latency colours in
 * Speed & Timeouts). This pure helper keeps the documented defaults so its
 * test still proves the shape; app code passes the settings bands.
 */
function timeClassOf(ms, goodMs = 10000, okMs = 15000) {
  if (ms == null) return 'dt-muted';
  if (ms < goodMs) return 'time-fast';
  if (ms <= okMs) return 'time-medium';
  return 'time-slow';
}

/**
 * The median of a list of measurements, and how many made it.
 *
 * `null` below the sample floor rather than an average of one: a single reading
 * printed as a median is a measurement wearing a statistic's name, and `null`
 * makes the column fold instead of asserting it. Same rule the page already
 * applies to uptime — one data point is not a rate.
 *
 * @returns {{ p50: number|null, samples: number }}
 */
function medianOf(values, minSamples = MIN_SAMPLES_FOR_LATENCY) {
  const kept = (values || []).filter((v) => Number.isFinite(v));
  if (kept.length < minSamples) return { p50: null, samples: kept.length };
  const sorted = kept.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const p50 = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  return { p50, samples: sorted.length };
}

/** The latency column for one model, from the times its own runs recorded. */
function resolveLatency(runTimes) {
  return medianOf(runTimes);
}

/**
 * Whether a row reads images, three-state.
 *
 * Kept separate from the provider's own `hasVision` boolean, which is false both
 * when a provider refused vision and when it said nothing at all — and only one
 * of those may be drawn as a refusal. This reads the merged row, so the answer
 * is published-first and reference-second like every other fact here.
 */
function resolveVision(capRow) {
  return readsToken(capRow, 'image');
}

/** Reasoning, three-state, from the row's own published flag. */
function resolveReasoning(capRow) {
  const row = capRow || {};
  if (row.reasoning === true) return true;
  if (row.reasoning === false) return false;
  return null;
}

/**
 * Every fact a test row shows, resolved in one place.
 *
 * @param model     the provider's own /models entry
 * @param catRow    the row `catalog:ingest` answered with, or null
 * @param ownContext what app.js readContextWindow(model) returned
 * @param runTimes  the response times this model's earlier runs recorded, ms
 */
function resolveFacts(model, catRow, ownContext, runTimes) {
  const capRow = resolveCapabilityRow(model, catRow);
  const score = resolveScore(catRow);
  const latency = resolveLatency(runTimes);
  return {
    context: resolveContext(ownContext, catRow),
    score: score.value,
    scoreSource: score.source,
    cost: resolveCost(catRow),
    capRow,
    vision: resolveVision(capRow),
    reasoning: resolveReasoning(capRow),
    latency: latency.p50,
    latencySamples: latency.samples,
    inputs: resolveInputs(capRow),
  };
}
