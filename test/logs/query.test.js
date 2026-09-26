const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createWriter } = require('../../src/logs/writer');
const { createQuery, createMeta } = require('../../src/logs/query');
const { migratedLogsDb, logRow, countRows, tempDir, quietLog } = require('../helpers');

const HOUR = 3600000;
const T0 = Date.UTC(2026, 8, 20, 12);
const hourOf = (ms) => Math.floor(ms / HOUR) * HOUR;

// entries: a row, or { row, body }.
function setup(t, entries) {
  const db = migratedLogsDb(t);
  const writer = createWriter(db, { log: quietLog, setTimer: () => null, clearTimer: () => {} });
  entries.forEach((e) => (e.row ? writer.add(e.row, e.body || null) : writer.add(e)));
  writer.flush();
  const meta = createMeta(db);
  const query = createQuery(db, { file: ':memory:', meta, droppedRows: () => 3 });
  return { db, query, meta };
}

test('list: newest first; the cursor neither skips nor repeats rows that share a time', (t) => {
  const times = [T0, T0 + 5, T0 + 5, T0 + 5, T0 + 9, T0 + 1, T0 + 5];
  const { query } = setup(t, times.map((created_at) => logRow({ created_at })));
  const all = query.list({}, null, 200).rows.map((r) => [r.created_at, r.id]);
  const expected = [...all].sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  assert.deepStrictEqual(all, expected);
  assert.strictEqual(all.length, 7);
  const paged = [];
  let cursor = null;
  do {
    const page = query.list({}, cursor, 2);
    paged.push(...page.rows.map((r) => [r.created_at, r.id]));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepStrictEqual(paged, expected);
});

test('list: limit defaults to 50 and is capped at 200', (t) => {
  const { query } = setup(t, Array.from({ length: 250 }, () => logRow()));
  assert.strictEqual(query.list({}, null, 1000).rows.length, 200);
  assert.strictEqual(query.list({}).rows.length, 50);
  assert.strictEqual(query.list({}, null, 0).rows.length, 50);
  assert.strictEqual(query.list(null, null, 'x').rows.length, 50);
});

test('list filters: time range, source, provider, model, status, run id', (t) => {
  const { query } = setup(t, [
    logRow({ created_at: T0, source: 'route_test', provider_id: 'nara', model_requested: 'm1', status: 'ok', run_id: 'RUN1' }),
    logRow({ created_at: T0 + 1000, source: 'health', provider_id: 'mirai', model_requested: null, status: 'error', error_class: 'auth' }),
    logRow({ created_at: T0 + 2000, source: 'benchmark', provider_id: 'nara', model_requested: 'm2', status: 'timeout', error_class: 'timeout', run_id: 'RUN2' }),
  ]);
  const at = (filters) => query.list(filters).rows.map((r) => r.created_at - T0).sort((a, b) => a - b);
  assert.deepStrictEqual(at({ from: T0 + 1000 }), [1000, 2000]);
  assert.deepStrictEqual(at({ to: T0 + 1000 }), [0]);
  assert.deepStrictEqual(at({ source: ['health', 'benchmark'] }), [1000, 2000]);
  assert.deepStrictEqual(at({ providerId: ['nara'] }), [0, 2000]);
  assert.deepStrictEqual(at({ model: 'm2' }), [2000]);
  assert.deepStrictEqual(at({ status: ['error', 'timeout'] }), [1000, 2000]);
  assert.deepStrictEqual(at({ runId: 'RUN1' }), [0]);
  assert.deepStrictEqual(at({ source: ['route_test'], providerId: ['mirai'] }), []);
});

test('list text search: uid, run id and error message; % and _ are literal', (t) => {
  const { query } = setup(t, [
    logRow({ request_uid: 'UIDALPHA', error_message: '100% done' }),
    logRow({ request_uid: 'UIDBETA', error_message: 'a_b' }),
    logRow({ request_uid: 'UIDGAMMA', error_message: 'axb', run_id: 'RUN-XYZ' }),
  ]);
  const msgs = (text) => query.list({ text }).rows.map((r) => r.error_message).sort();
  assert.deepStrictEqual(msgs('%'), ['100% done']);
  assert.deepStrictEqual(msgs('_'), ['a_b']);
  assert.deepStrictEqual(msgs('a_b'), ['a_b']);
  assert.deepStrictEqual(msgs('beta'), ['a_b']);
  assert.deepStrictEqual(msgs('xyz'), ['axb']);
  assert.deepStrictEqual(msgs('   '), ['100% done', 'a_b', 'axb']);
});

test('filter arrays are capped at 50 items', (t) => {
  const { query } = setup(t, [logRow({ source: 'health' })]);
  const many = Array.from({ length: 60 }, (_, i) => `s${i}`);
  many[55] = 'health';
  assert.strictEqual(query.list({ source: many }).rows.length, 0);
  many[10] = 'health';
  assert.strictEqual(query.list({ source: many }).rows.length, 1);
});

test('afterId returns only newer rows (live tail)', (t) => {
  const { query } = setup(t, [logRow(), logRow(), logRow()]);
  const ids = query.list({}).rows.map((r) => r.id);
  assert.deepStrictEqual(query.list({ afterId: ids[2] }).rows.map((r) => r.id), [ids[0], ids[1]]);
});

test('get: the row with its body, or null', (t) => {
  const { query } = setup(t, [
    { row: logRow({ request_uid: 'WITHBODY' }), body: { request_headers_json: '{}', request_body: 'req', response_body: 'res', truncated: 0 } },
    logRow({ request_uid: 'NOBODY' }),
  ]);
  const [withBody] = query.list({ text: 'WITHBODY' }).rows;
  const full = query.get(withBody.id);
  assert.strictEqual(full.request_uid, 'WITHBODY');
  assert.deepStrictEqual({ ...full.body }, { request_headers_json: '{}', request_body: 'req', response_body: 'res', truncated: 0 });
  const [plain] = query.list({ text: 'NOBODY' }).rows;
  assert.strictEqual(query.get(plain.id).body, null);
  assert.strictEqual(query.get(99999), null);
  assert.strictEqual(query.get('1'), null);
});

test('stats totals: ok %, errors by class, average and p95 latency, TTFT, tokens and cost', (t) => {
  const same = { created_at: T0, provider_id: 'nara', model_requested: 'm1', source: 'route_test' };
  const none = { input_tokens: null, output_tokens: null, cost_micros: null };
  const { query } = setup(t, [
    ...Array.from({ length: 18 }, () => logRow({ ...same, latency_ms: 800 })),
    logRow({ ...same, latency_ms: 4000, is_stream: 1, ttft_ms: 1200 }),
    logRow({ ...same, ...none, status: 'error', error_class: 'server', http_status: 500, latency_ms: 200 }),
    logRow({ ...same, ...none, status: 'error', error_class: 'auth', http_status: 401, latency_ms: 100 }),
    logRow({ ...same, ...none, status: 'timeout', error_class: 'timeout', http_status: null }),
    logRow({ ...same, ...none, status: 'cancelled', error_class: null, http_status: null }),
    logRow({ ...same, ...none, status: 'blocked', error_class: 'blocked', http_status: null }),
  ]);
  const { totals } = query.stats({}, 'hour', 'none');
  assert.deepStrictEqual(
    [totals.requests, totals.ok, totals.cancelled, totals.blocked, totals.timeouts, totals.errors],
    [24, 19, 1, 1, 1, 3],
  );
  assert.ok(Math.abs(totals.okPct - (19 * 100) / 22) < 1e-9);
  assert.ok(Math.abs(totals.errorRate - 3 / 22) < 1e-9);
  assert.deepStrictEqual(totals.errorsByClass, { auth: 1, rate_limit: 0, quota: 0, bad_request: 0, server: 1, network: 0, other: 0, timeout: 1 });
  // 21 answered: 18 × 800, 4000, 200, 100.
  assert.strictEqual(totals.avgLatencyMs, Math.round((18 * 800 + 4000 + 200 + 100) / 21));
  assert.deepStrictEqual([totals.p95LatencyMs, totals.p95Overflow], [1000, false]);
  assert.strictEqual(totals.avgTtftMs, 1200);
  assert.deepStrictEqual([totals.inputTokens, totals.outputTokens, totals.costMicros], [190, 38, 760]);

  const slow = setup(t, [logRow({ created_at: T0, latency_ms: 200000 })]).query.stats({}).totals;
  assert.deepStrictEqual([slow.p95LatencyMs, slow.p95Overflow], [120000, true]);
});

test('stats by hour and by local day, grouped by source, provider or model', (t) => {
  const noon = new Date(2026, 8, 20, 12).getTime();
  const { query } = setup(t, [
    logRow({ created_at: noon, source: 'route_test', provider_id: 'nara', model_requested: 'm1' }),
    logRow({ created_at: noon + HOUR, source: 'health', provider_id: 'nara', model_requested: 'm1' }),
    logRow({ created_at: noon + 24 * HOUR, source: 'health', provider_id: 'mirai', model_requested: 'm2' }),
  ]);
  const view = (series) => series.map((s) => [s.bucket, s.group, s.requests]);
  assert.deepStrictEqual(view(query.stats({}, 'hour', 'none').series), [
    [hourOf(noon), null, 1], [hourOf(noon + HOUR), null, 1], [hourOf(noon + 24 * HOUR), null, 1],
  ]);
  assert.deepStrictEqual(view(query.stats({}, 'day', 'source').series), [
    ['2026-09-20', 'route_test', 1], ['2026-09-20', 'health', 1], ['2026-09-21', 'health', 1],
  ]);
  assert.deepStrictEqual(view(query.stats({}, 'day', 'provider').series), [['2026-09-20', 'nara', 2], ['2026-09-21', 'mirai', 1]]);
  assert.deepStrictEqual(view(query.stats({ providerId: ['nara'] }, 'hour', 'model').series), [
    [hourOf(noon), 'm1', 1], [hourOf(noon + HOUR), 'm1', 1],
  ]);
  assert.strictEqual(query.stats({ source: ['health'] }).totals.requests, 2);
  assert.strictEqual(query.stats({ model: 'm2' }).totals.requests, 1);
  assert.strictEqual(query.stats({ from: hourOf(noon + HOUR) }).totals.requests, 2);
  assert.strictEqual(query.stats({ to: hourOf(noon + HOUR) }).totals.requests, 1);
});

test('stats grouped by error_class counts each class per bucket', (t) => {
  const { query } = setup(t, [
    logRow({ created_at: T0, status: 'error', error_class: 'auth', http_status: 401 }),
    logRow({ created_at: T0, status: 'error', error_class: 'auth', http_status: 403 }),
    logRow({ created_at: T0, status: 'error', error_class: 'server', http_status: 502 }),
    logRow({ created_at: T0, status: 'timeout', error_class: 'timeout', http_status: null }),
    logRow({ created_at: T0, status: 'blocked', error_class: 'blocked', http_status: null }),
    logRow({ created_at: T0 }),
  ]);
  const series = query.stats({}, 'hour', 'error_class').series;
  assert.deepStrictEqual(series.map((s) => [s.bucket, s.group, s.count]), [
    [T0, 'auth', 2], [T0, 'server', 1], [T0, 'timeout', 1], [T0, 'blocked', 1],
  ]);
});

test('stats refuses an unknown bucket or groupBy', (t) => {
  const { query } = setup(t, []);
  assert.throws(() => query.stats({}, 'week'), /Unknown bucket/);
  assert.throws(() => query.stats({}, 'hour', 'key'), /Unknown groupBy/);
});

test('facets: providers with their latest name, models and sources in the range', (t) => {
  const { query } = setup(t, [
    logRow({ created_at: T0, provider_id: 'nara', provider_name: 'Nara (old)', model_requested: 'm1', source: 'route_test' }),
    logRow({ created_at: T0 + 10, provider_id: 'nara', provider_name: 'NaraRouter', model_requested: 'm2', source: 'health' }),
    logRow({ created_at: T0 + 20, provider_id: null, provider_name: null, model_requested: null, source: 'leaderboard' }),
    logRow({ created_at: T0 + 100000, provider_id: 'mirai', provider_name: 'Mirai', model_requested: 'm3', source: 'benchmark' }),
  ]);
  assert.deepStrictEqual(query.facets({ from: T0, to: T0 + 1000 }), {
    providers: [{ id: 'nara', name: 'NaraRouter' }],
    models: ['m1', 'm2'],
    sources: ['health', 'leaderboard', 'route_test'],
  });
  assert.deepStrictEqual(query.facets({}).providers.map((p) => p.id), ['mirai', 'nara']);
});

test('runSummary: counts, classes, models, providers, cost, first/last and median latency', (t) => {
  const run = (o) => logRow({ run_id: 'RUNA', ...o });
  const { query } = setup(t, [
    run({ created_at: T0, latency_ms: 300, model_requested: 'm1', cost_micros: 20 }),
    run({ created_at: T0 + 10, latency_ms: 500, model_requested: 'm2', cost_micros: 30 }),
    run({ created_at: T0 + 20, status: 'error', error_class: 'server', http_status: 502, latency_ms: 100, model_requested: 'm2', cost_micros: null }),
    run({ created_at: T0 + 30, status: 'error', error_class: 'network', http_status: null, latency_ms: 9000, cost_micros: null }),
    run({ created_at: T0 + 40, status: 'cancelled', http_status: null, latency_ms: 50, cost_micros: null }),
    logRow({ run_id: 'OTHER', created_at: T0 }),
  ]);
  assert.deepStrictEqual(query.runSummary('RUNA'), {
    runId: 'RUNA', count: 5, ok: 2, cancelled: 1,
    errorsByClass: { auth: 0, rate_limit: 0, quota: 0, bad_request: 0, server: 1, network: 1, other: 0, timeout: 0, blocked: 0 },
    models: ['m1', 'm2'], providers: ['nara'], costMicros: 50, firstAt: T0, lastAt: T0 + 40, medianLatencyMs: 300,
  });
  const empty = query.runSummary('NONE');
  assert.deepStrictEqual([empty.count, empty.costMicros, empty.medianLatencyMs, empty.firstAt], [0, null, null, null]);
  assert.throws(() => query.runSummary(''), /run id/);
});

test('exportTo writes CSV and JSON of the filtered rows in chunks; formula-like cells are defused', async (t) => {
  const dir = tempDir(t);
  const { query } = setup(t, [
    logRow({ created_at: T0, source: 'health', error_message: '=HYPERLINK("x")' }),
    logRow({ created_at: T0 + 1, source: 'health', error_message: 'plain, with "quotes"' }),
    logRow({ created_at: T0 + 2, source: 'route_test' }),
  ]);
  const csv = path.join(dir, 'out.csv');
  assert.strictEqual(await query.exportTo(csv, { source: ['health'] }, 'csv'), 2);
  const lines = fs.readFileSync(csv, 'utf8').trimEnd().split('\r\n');
  assert.strictEqual(lines.length, 3);
  assert.ok(lines[0].startsWith('id,request_uid,created_at,source,'));
  assert.ok(lines[1].includes('"plain, with ""quotes"""'));
  assert.ok(lines[2].includes(`"'=HYPERLINK(""x"")"`));

  const json = path.join(dir, 'out.json');
  assert.strictEqual(await query.exportTo(json, { source: ['health'] }, 'json'), 2);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(json, 'utf8')).map((r) => r.error_message), ['plain, with "quotes"', '=HYPERLINK("x")']);

  const empty = path.join(dir, 'empty.json');
  assert.strictEqual(await query.exportTo(empty, { source: ['nothing'] }, 'json'), 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(empty, 'utf8')), []);
  await assert.rejects(query.exportTo(path.join(dir, 'x.xml'), {}, 'xml'), /Unknown export format/);

  const big = setup(t, Array.from({ length: 2100 }, (_, i) => logRow({ created_at: T0 + i })));
  const bigFile = path.join(dir, 'big.json');
  assert.strictEqual(await big.query.exportTo(bigFile, {}, 'json'), 2100);
  assert.strictEqual(new Set(JSON.parse(fs.readFileSync(bigFile, 'utf8')).map((r) => r.id)).size, 2100);
});

test('info: rows, oldest, dropped, last purge', (t) => {
  const { query, meta } = setup(t, [logRow({ created_at: T0 + 5 }), logRow({ created_at: T0 })]);
  assert.strictEqual(query.info().lastPurgeAt, null);
  meta.set('last_purge_at', 1234);
  assert.deepStrictEqual(query.info(), {
    enabled: true, error: null, path: ':memory:', sizeBytes: 0, rows: 2, oldestAt: T0, droppedRows: 3, lastPurgeAt: 1234,
  });
});

test('clear with before deletes older rows, bodies and fully covered roll-ups; without it, everything', async (t) => {
  const body = { request_headers_json: '{}', request_body: 'q', response_body: 'r', truncated: 0 };
  const { db, query } = setup(t, [
    { row: logRow({ created_at: T0 - 2 * HOUR }), body },
    { row: logRow({ created_at: T0 - 10 }), body },
    { row: logRow({ created_at: T0 + 10 }), body },
  ]);
  assert.deepStrictEqual(await query.clear({ before: T0 }), { rows: 2, bodies: 2, rollups: 2 });
  assert.deepStrictEqual([countRows(db, 'request_logs'), countRows(db, 'request_bodies'), countRows(db, 'usage_hourly')], [1, 1, 1]);
  assert.deepStrictEqual(await query.clear(), { rows: 1, bodies: 1, rollups: 1 });
  assert.deepStrictEqual([countRows(db, 'request_logs'), countRows(db, 'request_bodies'), countRows(db, 'usage_hourly')], [0, 0, 0]);
});
