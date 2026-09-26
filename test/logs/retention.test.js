const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Database = require('better-sqlite3');
const MIGRATIONS = require('../../src/logs/migrations');
const { ROLLUP_COUNTERS } = require('../../src/logs/writer');
const { purge, monthsAgo, createPurgeScheduler } = require('../../src/logs/retention');
const { migratedLogsDb, countRows, fakeTimers, tempDir, quietLog } = require('../helpers');

const DAY = 86400000;
const HOUR = 3600000;
const NOW = Date.UTC(2026, 8, 26);
const LIMITS = { logRetentionDays: 90, bodyRetentionDays: 7, statsRetentionMonths: 12 };
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fakeMeta() {
  return { values: {}, set(key, value) { this.values[key] = value; } };
}

function seed(db, n, createdAt, { body = false, prefix = 'S' } = {}) {
  const row = db.prepare("INSERT INTO request_logs (request_uid, created_at, source, method, endpoint, status, has_body) VALUES (?, ?, 'other', 'GET', 'https://x.test/y', 'ok', ?)");
  const b = db.prepare('INSERT INTO request_bodies (log_id, created_at, response_body) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (let i = 0; i < n; i += 1) {
      const id = Number(row.run(`${prefix}-${createdAt}-${i}`, createdAt, body ? 1 : 0).lastInsertRowid);
      if (body) b.run(id, createdAt, 'x');
    }
  })();
}

function rollup(db, hourStart) {
  const cols = ['hour_start', 'provider_id', 'model_id', 'source', ...ROLLUP_COUNTERS];
  db.prepare(`INSERT INTO usage_hourly (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(hourStart, 'p', 'm', 'other', ...ROLLUP_COUNTERS.map(() => 1));
}

test('rows older than the limit go with their bodies, a chunk at a time', async (t) => {
  const db = migratedLogsDb(t);
  seed(db, 2500, NOW - 91 * DAY, { body: true, prefix: 'old' });
  seed(db, 10, NOW - 1 * DAY, { body: true, prefix: 'new' });
  let yields = 0;
  const out = await purge(db, { now: NOW, ...LIMITS, meta: fakeMeta(), yieldFn: async () => { yields += 1; } });
  assert.deepStrictEqual(out, { rows: 2500, bodies: 2500, rollups: 0 });
  assert.strictEqual(countRows(db, 'request_logs'), 10);
  assert.strictEqual(countRows(db, 'request_bodies'), 10);
  assert.ok(yields >= 2, `yielded ${yields} times`);
});

test('bodies older than their limit go and has_body is cleared; the rows stay', async (t) => {
  const db = migratedLogsDb(t);
  seed(db, 5, NOW - 10 * DAY, { body: true });
  const out = await purge(db, { now: NOW, ...LIMITS, meta: fakeMeta() });
  assert.deepStrictEqual(out, { rows: 0, bodies: 5, rollups: 0 });
  assert.strictEqual(countRows(db, 'request_logs'), 5);
  assert.strictEqual(countRows(db, 'request_bodies'), 0);
  assert.strictEqual(db.prepare('SELECT SUM(has_body) AS n FROM request_logs').get().n, 0);
});

test('roll-ups older than the stats limit go', async (t) => {
  const db = migratedLogsDb(t);
  const limit = monthsAgo(NOW, 12);
  rollup(db, limit - HOUR);
  rollup(db, limit);
  const out = await purge(db, { now: NOW, ...LIMITS, meta: fakeMeta() });
  assert.strictEqual(out.rollups, 1);
  assert.deepStrictEqual(db.prepare('SELECT hour_start FROM usage_hourly').all().map((r) => r.hour_start), [limit]);
});

test('last_purge_at is recorded and the freed pages are handed back', async (t) => {
  const dir = tempDir(t);
  const db = new Database(path.join(dir, 'purge.db'));
  t.after(() => { if (db.open) db.close(); });
  db.pragma('auto_vacuum = INCREMENTAL');
  db.pragma('journal_mode = WAL');
  MIGRATIONS.forEach((m) => m.up(db));
  seed(db, 3000, NOW - 100 * DAY, { body: true });
  const meta = fakeMeta();
  await purge(db, { now: NOW, ...LIMITS, meta });
  assert.strictEqual(db.pragma('freelist_count', { simple: true }), 0);
  assert.strictEqual(meta.values.last_purge_at, NOW);
});

test('purge lets other work run between chunks', async (t) => {
  const db = migratedLogsDb(t);
  seed(db, 5000, NOW - 100 * DAY);
  const seen = [];
  let done = false;
  const watch = () => {
    if (done) return;
    seen.push(countRows(db, 'request_logs'));
    setImmediate(watch);
  };
  setImmediate(watch);
  await purge(db, { now: NOW, ...LIMITS, meta: fakeMeta() });
  done = true;
  assert.ok(seen.some((n) => n > 0 && n < 5000), `the watcher saw ${[...new Set(seen)].join(', ')}`);
});

test('closing the database mid-purge ends it without throwing', async (t) => {
  const db = migratedLogsDb(t);
  seed(db, 5000, NOW - 100 * DAY);
  let calls = 0;
  const out = await purge(db, {
    now: NOW, ...LIMITS, meta: fakeMeta(),
    yieldFn: async () => {
      calls += 1;
      if (calls === 1) db.close();
    },
  });
  assert.strictEqual(out, null);
  assert.strictEqual(db.open, false);
});

test('monthsAgo counts calendar months in UTC', () => {
  assert.strictEqual(monthsAgo(Date.UTC(2026, 8, 26, 12), 12), Date.UTC(2025, 8, 26, 12));
  assert.strictEqual(monthsAgo(Date.UTC(2026, 1, 15), 3), Date.UTC(2025, 10, 15));
});

test('scheduler: first run 30 s after start, then every 24 h', async () => {
  const timers = fakeTimers();
  let runs = 0;
  const s = createPurgeScheduler({ run: async () => { runs += 1; }, ...timers, log: quietLog });
  s.start();
  assert.deepStrictEqual(timers.delays(), [30000]);
  timers.fire();
  await settle();
  assert.strictEqual(runs, 1);
  assert.deepStrictEqual(timers.delays(), [86400000]);
});

test('scheduler: defers while requests are in flight', async () => {
  const timers = fakeTimers();
  let runs = 0;
  let busy = true;
  const s = createPurgeScheduler({ run: async () => { runs += 1; }, isBusy: () => busy, ...timers, log: quietLog });
  s.start();
  timers.fire();
  await settle();
  assert.strictEqual(runs, 0);
  assert.deepStrictEqual(timers.delays(), [60000]);
  busy = false;
  timers.fire();
  await settle();
  assert.strictEqual(runs, 1);
});

test('scheduler: a failing run is logged and the schedule goes on; stop() cancels the next run', async () => {
  const timers = fakeTimers();
  const warnings = [];
  const s = createPurgeScheduler({
    run: async () => { throw new Error('boom'); },
    ...timers,
    log: { ...quietLog, warn: (...a) => warnings.push(a.join(' ')) },
  });
  s.start();
  timers.fire();
  await settle();
  assert.match(warnings[0], /boom/);
  assert.deepStrictEqual(timers.delays(), [86400000]);
  s.stop();
  assert.deepStrictEqual(timers.delays(), []);
});
