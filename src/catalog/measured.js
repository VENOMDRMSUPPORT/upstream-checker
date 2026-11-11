"use strict";

// First-party measured model cards (foundation rebuild, step R1).
//
// The catalog's declared facts say what a provider CLAIMS about a
// model. These cards say what THIS APP observed when it actually
// called the model: how often it answered, how fast it answered, how
// fast it generated, and when it was last seen working. Cards are
// derived from the request log — the same derive-don't-store doctrine
// as the pool window ledger — and are stamped onto catalog rows so
// every consumer (the router's pools today, the Models page next)
// reads the same measured truth.
//
// A row with no card has simply never been measured here. That
// absence is itself a fact, and it is never papered over with a
// guess: consumers must treat "unmeasured" as its own state.

function measuredKey(providerId, modelId) {
  return `${providerId || ''}::${modelId || ''}`;
}

// measurementRows: the logs query's modelMeasurements output
// ({ providerId, modelId, attempts, passed, successRate,
//    avgLatencyMs, avgTtftMs, outputTps, lastSeenAt }).
function buildMeasuredCards(measurementRows) {
  const cards = new Map();
  for (const row of measurementRows || []) {
    if (!row || !row.providerId || !row.modelId) continue;
    cards.set(measuredKey(row.providerId, row.modelId), {
      attempts: row.attempts || 0,
      passed: row.passed || 0,
      successRate: row.successRate == null ? null : row.successRate,
      avgLatencyMs: row.avgLatencyMs == null ? null : row.avgLatencyMs,
      avgTtftMs: row.avgTtftMs == null ? null : row.avgTtftMs,
      outputTps: row.outputTps == null ? null : row.outputTps,
      lastSeenAt: row.lastSeenAt || null,
    });
  }
  return cards;
}

// Rows arrive in either spelling: catalog rows are snake_case
// (provider_id / model_id), router rows are camelCase.
function rowMeasuredCard(row, cards) {
  if (!row || !cards) return null;
  const providerId = row.providerId || row.provider_id;
  const modelId = row.modelId || row.model_id;
  if (!providerId || !modelId) return null;
  return cards.get(measuredKey(providerId, modelId)) || null;
}

function attachMeasured(rows, cards) {
  for (const row of rows || []) {
    if (row) row.measured = rowMeasuredCard(row, cards);
  }
  return rows;
}

// Probe facts (foundation rebuild R2): the latest capability verdicts
// this app measured for the row's model, folded from the model_probes
// rows ({ providerId, modelId, kind, ok, measuredAt }). A row with no
// probe rows gets probeFacts: null — never probed is its own state,
// distinct from a probe that ran and failed.
function attachProbeFacts(rows, probeRows) {
  const byModel = new Map();
  for (const p of probeRows || []) {
    if (!p || !p.providerId || !p.modelId) continue;
    const key = measuredKey(p.providerId, p.modelId);
    const facts = byModel.get(key) || { chatOk: null, toolsObserved: null, probedAt: null };
    if (p.kind === 'chat') facts.chatOk = p.ok === true;
    if (p.kind === 'tools') facts.toolsObserved = p.ok === true;
    if (p.measuredAt && (!facts.probedAt || p.measuredAt > facts.probedAt)) facts.probedAt = p.measuredAt;
    byModel.set(key, facts);
  }
  for (const row of rows || []) {
    if (!row) continue;
    const providerId = row.providerId || row.provider_id;
    const modelId = row.modelId || row.model_id;
    row.probeFacts = providerId && modelId
      ? byModel.get(measuredKey(providerId, modelId)) || null : null;
  }
  return rows;
}

// Benchmark scores (model-information rebuild, 2026-11-11): the
// latest run of the app's own benchmark suite per model, folded from
// the model_benchmarks rows. Stamping one onto a row makes it the
// row's SCORE — first-party measurement outranks every external
// index for this app's own decisions, because it was measured on the
// owner's own lane. The displaced external number is preserved as
// reference_score / reference_source so nothing is hidden: the page
// can show both, labeled as what they are.
function attachBenchmarks(rows, benchRows) {
  const byModel = new Map();
  for (const b of benchRows || []) {
    if (!b || !b.providerId || !b.modelId || !Number.isFinite(b.score)) continue;
    byModel.set(measuredKey(b.providerId, b.modelId), {
      score: b.score, passed: b.passed, total: b.total, measuredAt: b.measuredAt,
    });
  }
  for (const row of rows || []) {
    if (!row) continue;
    const providerId = row.providerId || row.provider_id;
    const modelId = row.modelId || row.model_id;
    const bench = providerId && modelId
      ? byModel.get(measuredKey(providerId, modelId)) || null : null;
    row.benchmark = bench;
    if (bench) {
      if (row.score != null && row.score_source !== 'benchmark') {
        row.reference_score = row.score;
        row.reference_source = row.score_source || null;
      }
      row.score = bench.score;
      row.score_source = 'benchmark';
    }
  }
  return rows;
}

module.exports = { measuredKey, buildMeasuredCards, rowMeasuredCard, attachMeasured, attachProbeFacts, attachBenchmarks };
