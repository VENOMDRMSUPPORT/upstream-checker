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

module.exports = { measuredKey, buildMeasuredCards, rowMeasuredCard, attachMeasured };
