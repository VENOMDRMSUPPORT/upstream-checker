const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const logsDb = require('../../src/logs');
const { quietLog, tempDir, logsStore, logRow } = require('../helpers');

const opts = { log: quietLog };

test('open(":memory:") wires the writer, meta and the query API on schema v1', (t) => {
  const logs = logsStore(t);
  assert.strictEqual(logs.db.pragma('user_version', { simple: true }), 1);
  assert.deepStrictEqual(logs.migration, { from: 0, to: 1 });
  logs.writer.add(logRow({ request_uid: 'WIRED' }));
  logs.writer.flush();
  assert.strictEqual(logs.repos.query.list({}).rows[0].request_uid, 'WIRED');
  logs.repos.meta.set('k', 5);
  assert.strictEqual(logs.repos.meta.get('k'), '5');
});

test('pragmas on a new file: WAL, NORMAL, busy timeout, temp store, incremental auto-vacuum', (t) => {
  const dir = tempDir(t);
  const logs = logsDb.open(dir, opts);
  try {
    assert.strictEqual(logs.file, path.join(dir, 'venom-logs.db'));
    assert.strictEqual(logs.db.pragma('journal_mode', { simple: true }), 'wal');
    assert.strictEqual(logs.db.pragma('synchronous', { simple: true }), 1);
    assert.strictEqual(logs.db.pragma('busy_timeout', { simple: true }), 5000);
    assert.strictEqual(logs.db.pragma('temp_store', { simple: true }), 2);
    assert.strictEqual(logs.db.pragma('auto_vacuum', { simple: true }), 2);
    assert.ok(logs.repos.query.info().sizeBytes > 0);
  } finally {
    logs.close();
  }
});

test('reopening an up-to-date file runs no migration', (t) => {
  const dir = tempDir(t);
  logsDb.open(dir, opts).close();
  const logs = logsDb.open(dir, opts);
  try {
    assert.deepStrictEqual(logs.migration, { from: 1, to: 1 });
  } finally {
    logs.close();
  }
});

test('a migration that throws rolls back and leaves the version', (t) => {
  const dir = tempDir(t);
  logsDb.open(dir, opts).close();
  const broken = [...logsDb.MIGRATIONS, {
    version: 2,
    up(db) { db.exec('CREATE TABLE half_done (x INTEGER)'); throw new Error('migration bug'); },
  }];
  assert.throws(() => logsDb.open(dir, { ...opts, migrations: broken }), /migration bug/);
  const logs = logsDb.open(dir, opts);
  try {
    assert.strictEqual(logs.db.pragma('user_version', { simple: true }), 1);
    assert.strictEqual(logs.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'half_done'").get().n, 0);
  } finally {
    logs.close();
  }
});

test('downgrade guard: a newer schema is refused and the file is not written', (t) => {
  const dir = tempDir(t);
  const first = logsDb.open(dir, opts);
  first.db.pragma('user_version = 9');
  first.close();
  const file = path.join(dir, 'venom-logs.db');
  const before = fs.readFileSync(file);
  assert.throws(() => logsDb.open(dir, opts), (err) => err.code === 'LOGS_DB_TOO_NEW');
  assert.strictEqual(Buffer.compare(before, fs.readFileSync(file)), 0);
});

test('tryOpen: a corrupt file turns logging off and is left as it was', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'venom-logs.db');
  const garbage = Buffer.alloc(4096, 0x41);
  fs.writeFileSync(file, garbage);
  const out = logsDb.tryOpen(dir, opts);
  assert.strictEqual(out.logs, null);
  assert.match(out.error.message, /not a database/);
  assert.strictEqual(Buffer.compare(garbage, fs.readFileSync(file)), 0);
});

test('tryOpen: a newer schema turns logging off with the reason', (t) => {
  const dir = tempDir(t);
  const first = logsDb.open(dir, opts);
  first.db.pragma('user_version = 9');
  first.close();
  const out = logsDb.tryOpen(dir, opts);
  assert.strictEqual(out.logs, null);
  assert.strictEqual(out.error.code, 'LOGS_DB_TOO_NEW');
  assert.match(out.error.message, /schema version 9/);
});

test('close() flushes queued rows before closing', (t) => {
  const dir = tempDir(t);
  const logs = logsDb.open(dir, opts);
  logs.writer.add(logRow({ request_uid: 'QUEUED' }));
  assert.strictEqual(logs.writer.queued(), 1);
  logs.close();
  logs.close();
  const db = new Database(path.join(dir, 'venom-logs.db'), { readonly: true });
  try {
    assert.deepStrictEqual(db.prepare('SELECT request_uid FROM request_logs').all().map((r) => r.request_uid), ['QUEUED']);
  } finally {
    db.close();
  }
});

test('the dropped count survives a reopen', (t) => {
  const dir = tempDir(t);
  const first = logsDb.open(dir, opts);
  first.writer.noteDropped(4, new Error('simulated'));
  first.writer.add(logRow());
  first.close();
  const second = logsDb.open(dir, opts);
  try {
    assert.strictEqual(second.writer.droppedRows(), 4);
    assert.strictEqual(second.repos.query.info().droppedRows, 4);
  } finally {
    second.close();
  }
});
