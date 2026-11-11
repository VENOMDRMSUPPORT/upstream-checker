"use strict";

// Capability probes (foundation rebuild, step R2).
//
// Declared capabilities are claims. A probe is a measurement: two
// tiny real calls through the app's own dispatch path — the same path
// routed traffic takes, so a probe proves the lane end to end.
//
//   chat   — the model answers a one-word call at all.
//   tools  — the model returns a real tool call when handed a tool.
//
// Verdicts are recorded per kind through the injected `record`. A
// tools probe that itself errors observes NOTHING and records
// nothing: "not observed" and "observed absent" are different facts,
// and only the second is a verdict. Probing is bounded by the caller
// (staleness window + per-run cap live here as shared constants).

const PROBE_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const PROBE_MAX_PER_RUN = 20;

const PROBE_TOOL = {
  type: 'function',
  function: {
    name: 'venom_probe',
    description: 'Measurement probe. Call it with x set to 1.',
    parameters: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
  },
};

// dispatch(route, payload) is the engine's upstream dispatcher;
// record({ kind, ok, detail }) persists one verdict.
async function probeModel({ dispatch, route, record }) {
  const verdict = { chatOk: false, toolsObserved: null };
  try {
    await dispatch(route, {
      body: {
        model: route.modelId,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        max_tokens: 8,
      },
    });
    verdict.chatOk = true;
    record({ kind: 'chat', ok: true, detail: null });
  } catch (err) {
    record({ kind: 'chat', ok: false, detail: (err && err.message) || 'chat probe failed' });
    return verdict;
  }
  try {
    const res = await dispatch(route, {
      body: {
        model: route.modelId,
        messages: [{ role: 'user', content: 'Use the venom_probe tool with x set to 1. Do not answer with plain text.' }],
        tools: [PROBE_TOOL],
        tool_choice: 'auto',
        max_tokens: 64,
      },
    });
    verdict.toolsObserved = Boolean(res && Array.isArray(res.toolCalls) && res.toolCalls.length);
    record({
      kind: 'tools',
      ok: verdict.toolsObserved,
      detail: verdict.toolsObserved ? 'tool call observed' : 'no tool call returned',
    });
  } catch (_) {
    // The tools call itself failed: nothing was observed, so no
    // verdict is recorded and tools stay unknown for this model.
  }
  return verdict;
}

module.exports = { probeModel, PROBE_STALE_MS, PROBE_MAX_PER_RUN };
