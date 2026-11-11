const test = require('node:test');
const assert = require('node:assert');
const { createWriter } = require('../../src/logs/writer');
const { createQuery, createMeta } = require('../../src/logs/query');
const { migratedLogsDb, logRow, quietLog } = require('../helpers');

// modelMeasurements is the SQL half of the first-party measurement
// layer (foundation rebuild R1): per provider + answering model, what
// this app itself observed — attempts, successes, latency, TTFT and
// generation speed — from the requests that actually reached a
// provider.

const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);

function setup(t, rows) {
  const db = migratedLogsDb(t);
  const writer = createWriter(db, { log: quietLog, setTimer: () => null, clearTimer: () => {} });
  rows.forEach((r) => writer.add(r));
  writer.flush();
  const query = createQuery(db, { file: ':memory:', meta: createMeta(db), droppedRows: () => 0 });
  return { query };
}

test('measures attempts, success rate, latency, TTFT and speed per answering model', (t) => {
  const { query } = setup(t, [
    logRow({ provider_id: 'p1', model_requested: 'm1', model_returned: 'm1', created_at: T0, status: 'ok', latency_ms: 1000, ttft_ms: 200, output_tokens: 100 }),
    logRow({ provider_id: 'p1', model_requested: 'm1', model_returned: 'm1', created_at: T0 + 1000, status: 'ok', latency_ms: 3000, ttft_ms: 400, output_tokens: 300 }),
    // Gateway traffic measures the model that ANSWERED, not the alias asked for.
    logRow({ provider_id: 'p1', model_requested: 'venom-lite', model_returned: 'm1', created_at: T0 + 2000, status: 'ok', latency_ms: 1000, output_tokens: 50 }),
    logRow({ provider_id: 'p1', model_requested: 'm1', model_returned: 'm1', created_at: T0 + 3000, status: 'error', latency_ms: 9000, output_tokens: 0 }),
    // Never sent: not an attempt.
    logRow({ provider_id: 'p1', model_requested: 'm1', model_returned: 'm1', created_at: T0 + 4000, status: 'cancelled' }),
    logRow({ provider_id: 'p1', model_requested: 'm1', model_returned: 'm1', created_at: T0 + 5000, status: 'blocked' }),
    // A different model with no timing recorded.
    logRow({ provider_id: 'p2', model_requested: 'm2', model_returned: 'm2', created_at: T0, status: 'ok', latency_ms: null, ttft_ms: null, output_tokens: 10 }),
  ]);
  const rows = query.modelMeasurements();
  const byModel = Object.fromEntries(rows.map((r) => [`${r.providerId}/${r.modelId}`, r]));
  assert.deepStrictEqual(Object.keys(byModel).sort(), ['p1/m1', 'p2/m2']);
  const m1 = byModel['p1/m1'];
  assert.equal(m1.attempts, 4);
  assert.equal(m1.passed, 3);
  assert.equal(m1.successRate, 0.75);
  assert.equal(m1.avgLatencyMs, 1667); // (1000 + 3000 + 1000) / 3, ok rows only
  assert.equal(m1.avgTtftMs, 300); // (200 + 400) / 2
  assert.equal(m1.outputTps, 90); // 450 output tokens over 5 ok seconds
  assert.equal(m1.lastSeenAt, T0 + 3000);
  const m2 = byModel['p2/m2'];
  assert.equal(m2.attempts, 1);
  assert.equal(m2.avgLatencyMs, null);
  assert.equal(m2.outputTps, null);
});

test('the from bound excludes older traffic', (t) => {
  const { query } = setup(t, [
    logRow({ provider_id: 'p1', model_requested: 'm1', model_returned: 'm1', created_at: T0 - 10000, status: 'ok', latency_ms: 10, output_tokens: 1 }),
    logRow({ provider_id: 'p1', model_requested: 'm1', model_returned: 'm1', created_at: T0, status: 'ok', latency_ms: 10, output_tokens: 1 }),
  ]);
  const rows = query.modelMeasurements({ from: T0 - 1000 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attempts, 1);
});
