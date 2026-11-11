const test = require('node:test');
const assert = require('node:assert');
const { createWriter } = require('../../src/logs/writer');
const { createQuery, createMeta } = require('../../src/logs/query');
const { migratedLogsDb, logRow, quietLog } = require('../helpers');

// keyWindowUsage is the SQL half of the router's pool window ledger:
// per-(key, model) token sums since a moment, over the requests that
// actually reached a provider.

const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);

function setup(t, rows) {
  const db = migratedLogsDb(t);
  const writer = createWriter(db, { log: quietLog, setTimer: () => null, clearTimer: () => {} });
  rows.forEach((r) => writer.add(r));
  writer.flush();
  const query = createQuery(db, { file: ':memory:', meta: createMeta(db), droppedRows: () => 0 });
  return { query };
}

test('sums tokens per key and model since the given moment', (t) => {
  const { query } = setup(t, [
    logRow({ key_id: 'k1', model_requested: 'm1', created_at: T0, input_tokens: 100, output_tokens: 50 }),
    logRow({ key_id: 'k1', model_requested: 'm1', created_at: T0 + 1000, input_tokens: 10, output_tokens: 5 }),
    logRow({ key_id: 'k1', model_requested: 'm2', created_at: T0 + 2000, input_tokens: 7, output_tokens: 3 }),
    logRow({ key_id: 'k2', model_requested: 'm1', created_at: T0 + 1000, input_tokens: 1, output_tokens: 2 }),
    // Before the window: excluded.
    logRow({ key_id: 'k1', model_requested: 'm1', created_at: T0 - 5000, input_tokens: 555, output_tokens: 555 }),
    // Never reached a provider: excluded even with tokens recorded.
    logRow({ key_id: 'k1', model_requested: 'm1', created_at: T0 + 3000, status: 'cancelled', input_tokens: 999, output_tokens: 999 }),
    logRow({ key_id: 'k1', model_requested: 'm1', created_at: T0 + 4000, status: 'blocked', input_tokens: 888, output_tokens: 888 }),
    // A key nobody asked about: excluded.
    logRow({ key_id: 'other', model_requested: 'm1', created_at: T0, input_tokens: 444, output_tokens: 444 }),
  ]);
  const rows = query.keyWindowUsage(['k1', 'k2'], T0);
  const byKeyModel = Object.fromEntries(rows.map((r) => [`${r.keyId}/${r.modelId}`, r]));
  assert.deepStrictEqual(Object.keys(byKeyModel).sort(), ['k1/m1', 'k1/m2', 'k2/m1']);
  assert.deepStrictEqual(
    { requests: byKeyModel['k1/m1'].requests, inputTokens: byKeyModel['k1/m1'].inputTokens, outputTokens: byKeyModel['k1/m1'].outputTokens },
    { requests: 2, inputTokens: 110, outputTokens: 55 });
  assert.strictEqual(byKeyModel['k1/m2'].requests, 1);
  assert.strictEqual(byKeyModel['k2/m1'].inputTokens + byKeyModel['k2/m1'].outputTokens, 3);
});

test('empty key lists read as no usage; a bad sinceMs throws', (t) => {
  const { query } = setup(t, [logRow({ key_id: 'k1', created_at: T0 })]);
  assert.deepStrictEqual(query.keyWindowUsage([], T0), []);
  assert.deepStrictEqual(query.keyWindowUsage([''], T0), []);
  assert.throws(() => query.keyWindowUsage(['k1'], NaN), TypeError);
});
