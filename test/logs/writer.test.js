const test = require('node:test');
const assert = require('node:assert');
const { createWriter } = require('../../src/logs/writer');
const { migratedLogsDb, logRow, countRows, fakeTimers, quietLog } = require('../helpers');

const HOUR = 3600000;
const T = 1790000000000;

test('rows wait for the 250 ms timer, then land in one flush', (t) => {
  const db = migratedLogsDb(t);
  const timers = fakeTimers();
  const writer = createWriter(db, { ...timers, log: quietLog });
  writer.add(logRow());
  writer.add(logRow());
  writer.add(logRow());
  assert.strictEqual(countRows(db, 'request_logs'), 0);
  assert.deepStrictEqual(timers.delays(), [250]);
  timers.fire();
  assert.strictEqual(countRows(db, 'request_logs'), 3);
  assert.strictEqual(writer.queued(), 0);
});

test('the 500th record flushes at once', (t) => {
  const db = migratedLogsDb(t);
  const timers = fakeTimers();
  const writer = createWriter(db, { ...timers, log: quietLog });
  for (let i = 0; i < 499; i += 1) writer.add(logRow());
  assert.strictEqual(countRows(db, 'request_logs'), 0);
  writer.add(logRow());
  assert.strictEqual(countRows(db, 'request_logs'), 500);
  assert.deepStrictEqual(timers.delays(), []);
});

test('a body is stored under its row id and has_body is set', (t) => {
  const db = migratedLogsDb(t);
  const writer = createWriter(db, { ...fakeTimers(), log: quietLog });
  writer.add(logRow({ request_uid: 'WITHBODY', created_at: T + 5 }), {
    request_headers_json: '{"Authorization":"[redacted]"}', request_body: '{"model":"m1"}', response_body: '{"error":"x"}', truncated: 1,
  });
  writer.add(logRow({ request_uid: 'NOBODY' }));
  writer.flush();
  const withBody = db.prepare('SELECT id, has_body FROM request_logs WHERE request_uid = ?').get('WITHBODY');
  const noBody = db.prepare('SELECT has_body FROM request_logs WHERE request_uid = ?').get('NOBODY');
  assert.strictEqual(withBody.has_body, 1);
  assert.strictEqual(noBody.has_body, 0);
  const bodies = db.prepare('SELECT * FROM request_bodies').all();
  assert.strictEqual(bodies.length, 1);
  assert.deepStrictEqual({ ...bodies[0] }, {
    log_id: withBody.id, created_at: T + 5, request_headers_json: '{"Authorization":"[redacted]"}',
    request_body: '{"model":"m1"}', response_body: '{"error":"x"}', truncated: 1,
  });
});

test('beyond the queue cap the oldest records are dropped and counted', (t) => {
  const db = migratedLogsDb(t);
  const writer = createWriter(db, { ...fakeTimers(), log: quietLog, queueCap: 10, batchMax: 1000 });
  for (let i = 1; i <= 15; i += 1) writer.add(logRow({ request_uid: `Q${i}` }));
  assert.strictEqual(writer.queued(), 10);
  assert.strictEqual(writer.droppedRows(), 5);
  writer.flush();
  const uids = db.prepare('SELECT request_uid FROM request_logs ORDER BY id').all().map((r) => r.request_uid);
  assert.deepStrictEqual(uids, Array.from({ length: 10 }, (_, i) => `Q${i + 6}`));
});

test('a failing database drops batches, warns once a minute, and the count reaches meta once writes recover', (t) => {
  const db = migratedLogsDb(t);
  const errors = [];
  let clock = 1000;
  const writer = createWriter(db, {
    ...fakeTimers(), now: () => clock, log: { ...quietLog, error: (...a) => errors.push(a.join(' ')) },
  });
  db.exec("CREATE TRIGGER disk_full BEFORE INSERT ON request_logs BEGIN SELECT RAISE(ABORT, 'disk full (simulated)'); END");
  assert.doesNotThrow(() => {
    writer.add(logRow());
    writer.add(logRow());
    writer.flush();
  });
  assert.strictEqual(writer.droppedRows(), 2);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /disk full \(simulated\)/);

  clock += 1000;
  writer.add(logRow());
  writer.flush();
  assert.strictEqual(writer.droppedRows(), 3);
  assert.strictEqual(errors.length, 1, 'a second warning inside the minute');

  clock += 60000;
  writer.add(logRow());
  writer.flush();
  assert.strictEqual(errors.length, 2);

  db.exec('DROP TRIGGER disk_full');
  writer.add(logRow());
  writer.flush();
  assert.strictEqual(countRows(db, 'request_logs'), 1);
  assert.strictEqual(db.prepare('SELECT SUM(requests) AS n FROM usage_hourly').get().n, 1, 'a dropped batch left no roll-up behind');
  assert.strictEqual(db.prepare("SELECT value FROM meta WHERE key = 'dropped_rows'").get().value, '4');
});

test('add() never throws, even after the database closed', (t) => {
  const db = migratedLogsDb(t);
  const writer = createWriter(db, { ...fakeTimers(), log: quietLog });
  db.close();
  assert.doesNotThrow(() => {
    writer.add(logRow());
    writer.flush();
  });
  assert.strictEqual(writer.droppedRows(), 1);
});

test('roll-ups: counters by status and class, latency buckets, TTFT for streams, tokens and cost', (t) => {
  const db = migratedLogsDb(t);
  const writer = createWriter(db, { ...fakeTimers(), log: quietLog });
  const same = { created_at: T, provider_id: 'nara', model_requested: 'm1', source: 'route_test' };
  const none = { input_tokens: null, output_tokens: null, cost_micros: null };
  [
    logRow({ ...same, status: 'ok', http_status: 200, latency_ms: 800, input_tokens: 10, output_tokens: 2, cached_tokens: 4, cost_micros: 40 }),
    logRow({ ...same, ...none, status: 'error', error_class: 'server', http_status: 500, latency_ms: 150 }),
    logRow({ ...same, ...none, status: 'error', error_class: 'network', http_status: null, latency_ms: 5000 }),
    logRow({ ...same, ...none, status: 'timeout', error_class: 'timeout', http_status: null, latency_ms: 60000 }),
    logRow({ ...same, ...none, status: 'cancelled', error_class: null, http_status: null, latency_ms: 300 }),
    logRow({ ...same, ...none, status: 'blocked', error_class: 'blocked', http_status: null, latency_ms: 0 }),
    logRow({ ...same, status: 'ok', http_status: 200, latency_ms: 130000, is_stream: 1, ttft_ms: 300, input_tokens: 5, output_tokens: 1, cost_micros: 20 }),
    logRow({ ...same, status: 'ok', http_status: 200, latency_ms: 90, is_stream: 0, ttft_ms: 50, input_tokens: 0, output_tokens: 0, cost_micros: 0 }),
  ].forEach((r) => writer.add(r));
  writer.flush();
  const rows = db.prepare('SELECT * FROM usage_hourly').all();
  assert.strictEqual(rows.length, 1);
  const r = rows[0];
  assert.strictEqual(r.hour_start, Math.floor(T / HOUR) * HOUR);
  assert.deepStrictEqual(
    { requests: r.requests, ok: r.ok, cancelled: r.cancelled, blocked: r.blocked, timeouts: r.timeouts, e_server: r.e_server, e_network: r.e_network, e_other: r.e_other },
    { requests: 8, ok: 3, cancelled: 1, blocked: 1, timeouts: 1, e_server: 1, e_network: 1, e_other: 0 },
  );
  // Latency: the three ok answers and the 500. Not the network error, the timeout, the cancel or the block.
  assert.strictEqual(r.latency_count, 4);
  assert.strictEqual(r.latency_sum_ms, 800 + 150 + 130000 + 90);
  assert.deepStrictEqual([r.lb0, r.lb1, r.lb3, r.lb13], [1, 1, 1, 1]);
  // TTFT from the stream only.
  assert.deepStrictEqual([r.ttft_count, r.ttft_sum_ms], [1, 300]);
  assert.deepStrictEqual([r.input_tokens, r.output_tokens, r.cached_tokens, r.cost_micros], [15, 3, 4, 60]);
});

test("separate roll-ups per hour, provider, model and source; unknown ones are ''", (t) => {
  const db = migratedLogsDb(t);
  const writer = createWriter(db, { ...fakeTimers(), log: quietLog });
  [
    logRow({ created_at: T }),
    logRow({ created_at: T + HOUR }),
    logRow({ created_at: T, provider_id: 'mirai' }),
    logRow({ created_at: T, model_requested: 'm2' }),
    logRow({ created_at: T, source: 'health' }),
    logRow({ created_at: T, provider_id: null, model_requested: null }),
  ].forEach((r) => writer.add(r));
  writer.flush();
  assert.strictEqual(countRows(db, 'usage_hourly'), 6);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM usage_hourly WHERE provider_id = '' AND model_id = ''").get().n, 1);
});

test('the count continues from the value in meta', (t) => {
  const db = migratedLogsDb(t);
  const writer = createWriter(db, { ...fakeTimers(), log: quietLog, initialDropped: 7 });
  assert.strictEqual(writer.droppedRows(), 7);
  writer.noteDropped(2, new Error('simulated'));
  writer.add(logRow());
  writer.flush();
  assert.strictEqual(db.prepare("SELECT value FROM meta WHERE key = 'dropped_rows'").get().value, '9');
});

test('stop() cancels the pending timer; flush() still writes', (t) => {
  const db = migratedLogsDb(t);
  const timers = fakeTimers();
  const writer = createWriter(db, { ...timers, log: quietLog });
  writer.add(logRow());
  assert.deepStrictEqual(timers.delays(), [250]);
  writer.stop();
  assert.deepStrictEqual(timers.delays(), []);
  assert.strictEqual(writer.flush(), 1);
  assert.strictEqual(countRows(db, 'request_logs'), 1);
});
