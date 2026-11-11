"use strict";

// First-party benchmark suite (model-information rebuild, 2026-11-11).
//
// The old pipeline graded models by chaining external regressions
// over whatever metadata happened to be on hand; when the reference
// starved, the page filled with invented numbers, and when the
// invention was removed it filled with blanks. This suite is the
// replacement for the QUALITY question: a small fixed set of
// deterministic tasks, dispatched through the app's own keys on the
// same path routed traffic takes, checked programmatically — no
// judge model, no external catalog, no key beyond the provider keys
// the owner already connected. A model that appears in a roster in
// the morning carries a measured score the same morning.
//
// The score is 0..100, weighted by task. It measures what this app
// could verify, on the owner's own lane (their key, their plan) —
// which is exactly the quality the router will actually get.

const BENCH_STALE_MS = 14 * 24 * 60 * 60 * 1000;
const BENCH_MAX_PER_RUN = 12;

const BENCH_TOOL = {
  type: 'function',
  function: {
    name: 'venom_probe',
    description: 'Measurement probe. Call it with x set to 1.',
    parameters: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
  },
};

function normalizeText(text) {
  return String(text || '').trim().toLowerCase().replace(/[.!"']+$/g, '').trim();
}

function firstNumber(text) {
  const match = String(text || '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function parseJsonObject(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch (_) { return null; }
}

// Each task: a prompt whose correct answer is known exactly, and a
// checker over the reply text. Weights mark what matters for an
// agent router: reasoning and tool use count double.
const BENCH_TASKS = [
  {
    id: 'instruction', weight: 1,
    prompt: 'Reply with exactly the word: ready',
    check: (text) => normalizeText(text) === 'ready',
  },
  {
    id: 'reasoning', weight: 2,
    prompt: 'A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost, in cents? Reply with a single number.',
    check: (text) => firstNumber(text) === 5,
  },
  {
    id: 'arithmetic', weight: 1,
    prompt: 'A train travels 60 kilometres in 45 minutes. What is its average speed in kilometres per hour? Reply with a single number.',
    check: (text) => firstNumber(text) === 80,
  },
  {
    id: 'format', weight: 1,
    prompt: 'Return only a JSON object (no other text) with a single key "sum" whose value is 19 + 23.',
    check: (text) => {
      const parsed = parseJsonObject(text);
      return Boolean(parsed) && Number(parsed.sum) === 42;
    },
  },
  {
    id: 'code', weight: 2,
    prompt: 'Consider this Python code: print("".join(sorted("dcba"))). What does it print? Reply with exactly the output and nothing else.',
    check: (text) => normalizeText(text) === 'abcd',
  },
  {
    id: 'knowledge', weight: 1,
    prompt: 'What is the chemical symbol for gold? Reply with the symbol only.',
    check: (text) => normalizeText(text) === 'au',
  },
];

const TOTAL_WEIGHT = BENCH_TASKS.reduce((sum, t) => sum + t.weight, 0) + 2; // + tools (2)

function replyText(res) {
  if (!res) return '';
  if (typeof res.text === 'string') return res.text;
  if (typeof res.content === 'string') return res.content;
  return '';
}

// dispatch(route, payload) is the app's upstream dispatcher;
// record(result) persists one completed run. A run in which EVERY
// task errored is not a measurement (a dead key grades nothing) —
// it records nothing, like the probes' unobserved verdicts.
async function runBenchmark({ dispatch, route, record }) {
  const results = [];
  let errored = 0;
  for (const task of BENCH_TASKS) {
    try {
      const res = await dispatch(route, {
        body: { model: route.modelId, messages: [{ role: 'user', content: task.prompt }], max_tokens: 128 },
      });
      results.push({ id: task.id, weight: task.weight, pass: task.check(replyText(res)) });
    } catch (_) {
      errored += 1;
      results.push({ id: task.id, weight: task.weight, pass: false, error: true });
    }
  }
  let toolsPass = false;
  try {
    const res = await dispatch(route, {
      body: {
        model: route.modelId,
        messages: [{ role: 'user', content: 'Use the venom_probe tool with x set to 1. Do not answer with plain text.' }],
        tools: [BENCH_TOOL],
        tool_choice: 'auto',
        max_tokens: 64,
      },
    });
    toolsPass = Boolean(res && Array.isArray(res.toolCalls) && res.toolCalls.length);
  } catch (_) {
    errored += 1;
  }
  results.push({ id: 'tools', weight: 2, pass: toolsPass });
  if (errored === results.length) return { ok: false, score: null };
  const earned = results.reduce((sum, r) => sum + (r.pass ? r.weight : 0), 0);
  const score = Math.round((100 * earned) / TOTAL_WEIGHT);
  const passed = results.filter((r) => r.pass).length;
  const verdict = { ok: true, score, passed, total: results.length, detail: { tasks: results } };
  record(verdict);
  return verdict;
}

module.exports = {
  BENCH_TASKS, BENCH_STALE_MS, BENCH_MAX_PER_RUN, TOTAL_WEIGHT,
  runBenchmark, normalizeText, firstNumber, parseJsonObject,
};
