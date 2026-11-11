'use strict';

// Model-information rebuild: the first-party benchmark suite. A fake
// dispatch answers as scripted models would, and the suite's verdicts
// are checked exactly — the score is arithmetic over known answers,
// never a judge's opinion.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runBenchmark, BENCH_TASKS } = require('../../src/catalog/benchmark');
const { attachBenchmarks } = require('../../src/catalog/measured');

const ANSWERS = {
  instruction: 'ready',
  reasoning: '5',
  arithmetic: '80',
  format: '{"sum": 42}',
  code: 'abcd',
  knowledge: 'Au',
};

function scriptedDispatch(script) {
  return async (route, payload) => {
    const body = payload.body || {};
    if (Array.isArray(body.tools)) {
      return script.tools ? { text: '', toolCalls: [{ id: 'c1' }] } : { text: 'no tool', toolCalls: [] };
    }
    const prompt = body.messages[0].content;
    const task = BENCH_TASKS.find((t) => t.prompt === prompt);
    const answer = script[task.id];
    if (answer === 'error') throw new Error('upstream down');
    return { text: answer != null ? answer : 'I do not know', toolCalls: null };
  };
}

const ROUTE = { providerId: 'p1', modelId: 'm1' };

test('a model that answers everything scores 100 and the run is recorded', async () => {
  let recorded = null;
  const verdict = await runBenchmark({
    dispatch: scriptedDispatch({ ...ANSWERS, tools: true }),
    route: ROUTE,
    record: (v) => { recorded = v; },
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.score, 100);
  assert.equal(verdict.passed, 7);
  assert.equal(verdict.total, 7);
  assert.equal(recorded.score, 100);
});

test('the score is the weighted pass fraction: missing reasoning+tools lands at 60', async () => {
  const script = { ...ANSWERS, reasoning: '10', tools: false };
  const verdict = await runBenchmark({ dispatch: scriptedDispatch(script), route: ROUTE, record: () => {} });
  // weights: instruction 1, reasoning 2, arithmetic 1, format 1,
  // code 2, knowledge 1, tools 2 = 10; earned 6 -> 60.
  assert.equal(verdict.score, 60);
  assert.equal(verdict.passed, 5);
});

test('a run where every task errors records nothing — a dead key grades no model', async () => {
  let recorded = null;
  const verdict = await runBenchmark({
    dispatch: async () => { throw new Error('401 unauthorized'); },
    route: ROUTE,
    record: (v) => { recorded = v; },
  });
  assert.equal(verdict.ok, false);
  assert.equal(recorded, null);
});

test('attachBenchmarks makes the measured score the row score and keeps the external number as a labeled reference', () => {
  const rows = [
    { provider_id: 'p1', model_id: 'm1', score: 3.7, score_source: 'est' },
    { provider_id: 'p1', model_id: 'm2', score: 44, score_source: 'aa' },
  ];
  attachBenchmarks(rows, [{ providerId: 'p1', modelId: 'm1', score: 82, passed: 6, total: 7, measuredAt: 99 }]);
  assert.equal(rows[0].score, 82);
  assert.equal(rows[0].score_source, 'benchmark');
  assert.equal(rows[0].reference_score, 3.7);
  assert.equal(rows[0].reference_source, 'est');
  assert.equal(rows[0].benchmark.measuredAt, 99);
  assert.equal(rows[1].score, 44, 'an unbenchmarked row keeps its reference score');
  assert.equal(rows[1].benchmark, null);
});
