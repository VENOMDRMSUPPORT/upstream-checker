const test = require('node:test');
const assert = require('node:assert');
const { migratedLogsDb } = require('../helpers');
const { readLogSettings } = require('../../src/logs/settings');

test('schema v1 creates the four tables and six indexes', (t) => {
  const db = migratedLogsDb(t);
  const names = (type) => db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite%' ORDER BY name")
    .all(type).map((r) => r.name);
  assert.deepStrictEqual(names('table'), ['meta', 'request_bodies', 'request_logs', 'usage_hourly']);
  assert.deepStrictEqual(names('index'), [
    'request_bodies_by_time', 'request_logs_by_model', 'request_logs_by_provider',
    'request_logs_by_run', 'request_logs_by_source', 'request_logs_by_time',
  ]);
});

test('a row with only the required columns gets the defaults', (t) => {
  const db = migratedLogsDb(t);
  db.prepare("INSERT INTO request_logs (request_uid, created_at, source, method, endpoint, status) VALUES ('u1', 1, 'other', 'GET', 'https://x.test/y', 'ok')").run();
  const row = db.prepare('SELECT attempt, is_hedge, is_stream, has_body, user_id FROM request_logs').get();
  assert.deepStrictEqual({ ...row }, { attempt: 1, is_hedge: 0, is_stream: 0, has_body: 0, user_id: null });
});

test('request_uid is unique', (t) => {
  const db = migratedLogsDb(t);
  const insert = db.prepare("INSERT INTO request_logs (request_uid, created_at, source, method, endpoint, status) VALUES ('same', 1, 'other', 'GET', 'e', 'ok')");
  insert.run();
  assert.throws(() => insert.run(), /UNIQUE constraint failed/);
});

test('usage_hourly has one row per hour, provider, model and source', (t) => {
  const db = migratedLogsDb(t);
  const cols = db.prepare('PRAGMA table_info(usage_hourly)').all().map((c) => c.name);
  const insert = db.prepare(`INSERT INTO usage_hourly (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  const values = cols.map((c) => ({ hour_start: 3600000, provider_id: 'p', model_id: 'm', source: 'other' }[c] ?? 0));
  insert.run(values);
  assert.throws(() => insert.run(values), /UNIQUE constraint failed/);
});

test('readLogSettings: a new install gets Failed only and the default retention', () => {
  const defaults = { logLevel: 'errors', logRetentionDays: 90, bodyRetentionDays: 7, statsRetentionMonths: 12 };
  assert.deepStrictEqual(readLogSettings(null), defaults);
  assert.deepStrictEqual(readLogSettings({ theme: 'vercel' }), defaults);
});

test('readLogSettings: stored values are used as they are', () => {
  assert.deepStrictEqual(
    readLogSettings({ logLevel: 'off', logRetentionDays: 30, bodyRetentionDays: 1, statsRetentionMonths: 6 }),
    { logLevel: 'off', logRetentionDays: 30, bodyRetentionDays: 1, statsRetentionMonths: 6 },
  );
  assert.strictEqual(readLogSettings({ logLevel: 'all' }).logLevel, 'all');
});

test('readLogSettings: unknown or out-of-range values fall back to the defaults', () => {
  assert.deepStrictEqual(
    readLogSettings({ logLevel: 'verbose', logRetentionDays: 0, bodyRetentionDays: -2, statsRetentionMonths: 1.5 }),
    { logLevel: 'errors', logRetentionDays: 90, bodyRetentionDays: 7, statsRetentionMonths: 12 },
  );
  assert.strictEqual(readLogSettings({ logRetentionDays: '30' }).logRetentionDays, 90);
  assert.strictEqual(readLogSettings({ statsRetentionMonths: 999 }).statsRetentionMonths, 12);
});
