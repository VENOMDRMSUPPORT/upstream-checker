const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const database = require('../../src/db');
const { fakeCipher, quietLog, tempDir, memoryStore } = require('../helpers');

const opts = () => ({ cipher: fakeCipher(), log: quietLog });

test('schema v1: user_version, every table, install_id', async (t) => {
  const store = await memoryStore(t);
  assert.strictEqual(store.db.pragma('user_version', { simple: true }), 1);
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  assert.deepStrictEqual(tables, [
    'catalog_meta', 'key_model_counts', 'meta', 'model_keys', 'models', 'provider_keys',
    'provider_sync', 'providers', 'secrets', 'settings', 'test_results', 'test_runs',
  ]);
  assert.match(store.repos.meta.get('install_id'), /^[0-9a-f-]{36}$/);
});

test('pragmas on a file: WAL, NORMAL, foreign keys, busy timeout, temp store', async (t) => {
  const dir = tempDir(t);
  const store = await database.open(dir, opts());
  try {
    assert.strictEqual(store.db.pragma('journal_mode', { simple: true }), 'wal');
    assert.strictEqual(store.db.pragma('synchronous', { simple: true }), 1); // NORMAL
    assert.strictEqual(store.db.pragma('foreign_keys', { simple: true }), 1);
    assert.strictEqual(store.db.pragma('busy_timeout', { simple: true }), 5000);
    assert.strictEqual(store.db.pragma('temp_store', { simple: true }), 2); // MEMORY
    assert.strictEqual(store.file, path.join(dir, 'venom.db'));
    assert.ok(fs.existsSync(store.file));
  } finally {
    store.close();
  }
});

test(':memory: reports journal_mode memory', async (t) => {
  const store = await memoryStore(t);
  assert.strictEqual(store.db.pragma('journal_mode', { simple: true }), 'memory');
});

test('reopening an up-to-date file runs nothing and makes no backup', async (t) => {
  const dir = tempDir(t);
  (await database.open(dir, opts())).close();
  const store = await database.open(dir, opts());
  try {
    assert.deepStrictEqual(store.migration, { from: 1, to: 1, backup: null });
    assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.includes('.bak-v')), []);
  } finally {
    store.close();
  }
});

test('a pending migration backs up first, then runs and bumps user_version', async (t) => {
  const dir = tempDir(t);
  (await database.open(dir, opts())).close();
  const withV2 = [...database.MIGRATIONS, { version: 2, up(db) { db.exec('CREATE TABLE extra_v2 (x INTEGER)'); } }];
  const store = await database.open(dir, { ...opts(), migrations: withV2 });
  try {
    assert.strictEqual(store.migration.from, 1);
    assert.strictEqual(store.migration.to, 2);
    assert.strictEqual(store.migration.backup, path.join(dir, 'venom.db.bak-v1'));
    assert.ok(fs.existsSync(store.migration.backup));
    assert.strictEqual(store.db.pragma('user_version', { simple: true }), 2);
  } finally {
    store.close();
  }
});

test('a migration that throws rolls back and leaves the version', async (t) => {
  const dir = tempDir(t);
  (await database.open(dir, opts())).close();
  const broken = [...database.MIGRATIONS, {
    version: 2,
    up(db) { db.exec('CREATE TABLE half_done (x INTEGER)'); throw new Error('migration bug'); },
  }];
  await assert.rejects(database.open(dir, { ...opts(), migrations: broken }), /migration bug/);
  const store = await database.open(dir, opts());
  try {
    assert.strictEqual(store.db.pragma('user_version', { simple: true }), 1);
    assert.strictEqual(store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'half_done'").get().n, 0);
  } finally {
    store.close();
  }
});

test('keeps only the three newest backups', async (t) => {
  const dir = tempDir(t);
  (await database.open(dir, opts())).close();
  const steps = [...database.MIGRATIONS];
  for (let v = 2; v <= 5; v += 1) {
    steps.push({ version: v, up(db) { db.exec(`CREATE TABLE step_${v} (x INTEGER)`); } });
    (await database.open(dir, { ...opts(), migrations: [...steps] })).close();
  }
  const backups = fs.readdirSync(dir).filter((n) => n.startsWith('venom.db.bak-v')).sort();
  assert.deepStrictEqual(backups, ['venom.db.bak-v2', 'venom.db.bak-v3', 'venom.db.bak-v4']);
});

test('downgrade guard: a newer schema is refused and the file is not written', async (t) => {
  const dir = tempDir(t);
  const first = await database.open(dir, opts());
  first.db.pragma('user_version = 9');
  first.close();
  const file = path.join(dir, 'venom.db');
  const before = fs.readFileSync(file);
  await assert.rejects(database.open(dir, opts()), (err) => err.code === 'DB_TOO_NEW');
  assert.strictEqual(Buffer.compare(before, fs.readFileSync(file)), 0);
});

test('a newer schema on a DELETE-journal file is refused without switching it to WAL', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'venom.db');
  const fixture = new Database(file);
  fixture.pragma('journal_mode = DELETE');
  fixture.pragma('user_version = 9');
  fixture.close();
  const before = fs.readFileSync(file);
  await assert.rejects(database.open(dir, opts()), (err) => err.code === 'DB_TOO_NEW');
  assert.strictEqual(Buffer.compare(before, fs.readFileSync(file)), 0);
});

test('a corrupt file is refused and left as it was', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'venom.db');
  const garbage = Buffer.alloc(4096, 0x41);
  fs.writeFileSync(file, garbage);
  await assert.rejects(database.open(dir, opts()), (err) => err instanceof Error && err.message.includes('not a database'));
  assert.strictEqual(Buffer.compare(garbage, fs.readFileSync(file)), 0);
});

test('meta get/set round-trips strings and returns null when unset', async (t) => {
  const store = await memoryStore(t);
  assert.strictEqual(store.repos.meta.get('imported_from_json_at'), null);
  store.repos.meta.set('imported_from_json_at', 1727000000000);
  assert.strictEqual(store.repos.meta.get('imported_from_json_at'), '1727000000000');
  store.repos.meta.set('imported_from_json_at', 'none');
  assert.strictEqual(store.repos.meta.get('imported_from_json_at'), 'none');
});
