const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const database = require('../../src/db');
const { fakeCipher, quietLog, tempDir, memoryStore } = require('../helpers');

const opts = () => ({ cipher: fakeCipher(), log: quietLog });
const V1_TABLES = [
  'catalog_meta', 'key_model_counts', 'meta', 'model_keys', 'models', 'provider_keys',
  'provider_sync', 'providers', 'secrets', 'settings', 'test_results', 'test_runs',
];
const tablesIn = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  .all().map((r) => r.name);

// Migration v2 is additive, so v1's own shape is worth pinning on its own — and it
// has to be run on a bare handle, because opening a store applies the whole list
// and createRepos prepares statements over the v2 tables. (Same reason
// test/logs/schema.test.js runs the log migrations directly.)
test('schema v1: every table it shipped with, and install_id', (t) => {
  const db = new Database(':memory:');
  t.after(() => { if (db.open) db.close(); });
  assert.strictEqual(database.MIGRATIONS[0].version, 1, 'the entry that shipped is never edited');
  database.MIGRATIONS[0].up(db);
  assert.deepStrictEqual(tablesIn(db), V1_TABLES);
  assert.match(db.prepare("SELECT value FROM meta WHERE key = 'install_id'").get().value, /^[0-9a-f-]{36}$/);
});

test('schema v2 added the two snapshot tables and touched models not at all — v3 undoes the touch', async (t) => {
  const store = await memoryStore(t);
  const tables = tablesIn(store.db);
  assert.ok(tables.includes('snapshot_meta'));
  assert.ok(tables.includes('roster_snapshot'));
  V1_TABLES.forEach((name) => assert.ok(tables.includes(name), `v3 clears, it does not drop: ${name} is still there`));
  const cols = store.db.prepare('PRAGMA table_info(models)').all().map((c) => c.name);
  // The five columns the benchmark and the capability probes wrote, gone with
  // them. v2 left them because the old Models page still read them; nothing does.
  ['bench_json', 'history_json', 'bench_error', 'caps_json', 'caps_error'].forEach((name) => {
    assert.ok(!cols.includes(name), `v3 dropped ${name}`);
  });
  ['summary_json', 'first_seen', 'last_seen', 'removed_at', 'is_new', 'updated_at'].forEach((name) => {
    assert.ok(cols.includes(name), `v3 keeps ${name}`);
  });
  assert.strictEqual(store.db.pragma('user_version', { simple: true }), 4);
});

// v3 is the irreversible one: it clears the legacy pool on the owner's data. The
// two things that must both hold — the copy is taken first, and the pool is
// empty afterwards while the tables the engine needs are untouched.
test('v3 is the irreversible one: backed up first, the legacy pool empty after', async (t) => {
  const dir = tempDir(t);
  const now = Date.now();
  const fixture = new Database(path.join(dir, 'venom.db'));
  database.MIGRATIONS[0].up(fixture);
  database.MIGRATIONS[1].up(fixture);
  fixture.prepare(`INSERT INTO providers (id, name, base_url, rpm, is_custom, position, created_at, updated_at)
    VALUES ('nara', 'NaraRouter', 'https://router.bynara.id', NULL, 0, 0, ?, ?)`).run(now, now);
  fixture.prepare(`INSERT INTO models (provider_id, model_id, name, kind, first_seen, last_seen,
    removed_at, is_new, summary_json, bench_json, history_json, updated_at)
    VALUES ('nara', 'nara/one', 'One', 'chat', ?, ?, NULL, 0, '{"id":"nara/one"}', '{"iq":1}', NULL, ?)`)
    .run(now, now, now);
  fixture.prepare(`INSERT INTO model_keys (provider_id, model_id, key_id) VALUES ('nara', 'nara/one', 'k1')`).run();
  fixture.prepare("INSERT INTO catalog_meta (key, value_json) VALUES ('leaderboard', '{\"capturedAt\":\"2026-09-25\"}')").run();
  fixture.pragma('user_version = 2'); // v1 and v2 applied, v3 pending
  fixture.close();

  // Up to v3 only: the point is what v3 itself did, so v4's table must not be
  // part of the comparison.
  const throughV3 = database.MIGRATIONS.filter((m) => m.version <= 3);
  const store = await database.open(dir, { ...opts(), migrations: throughV3 });
  try {
    assert.deepStrictEqual({ from: store.migration.from, to: store.migration.to }, { from: 2, to: 3 });
    assert.strictEqual(store.migration.backup, path.join(dir, 'venom.db.bak-v2'));
    assert.ok(fs.existsSync(store.migration.backup), 'the copy is on disk before the pool is emptied');
    assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM models').get().n, 0);
    assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM model_keys').get().n, 0);
    assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM catalog_meta').get().n, 0);
    assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM providers').get().n, 1,
      'and the providers it belongs to are not touched');
    assert.strictEqual(store.db.pragma('user_version', { simple: true }), 3);
  } finally {
    store.close();
  }
});

// v2 really is additive, and that is worth proving on its own rather than only
// through v3: the migration list is truncated at v2 and the file opened against
// that list, so the claim is about v2's own half and not about what v3 did
// afterwards. Truncating a list is a supported `open()` call (the sequence tests
// below use it); repos.auth prepares its statements lazily precisely so this one
// does not fail on a table v4 has not created yet.
test('a v1 file upgrades to v2 with every row it held', async (t) => {
  const dir = tempDir(t);
  const now = Date.now();
  const fixture = new Database(path.join(dir, 'venom.db'));
  database.MIGRATIONS[0].up(fixture);
  fixture.prepare(`INSERT INTO providers (id, name, base_url, rpm, is_custom, position, created_at, updated_at)
    VALUES ('nara', 'NaraRouter', 'https://router.bynara.id', NULL, 0, 0, ?, ?)`).run(now, now);
  fixture.prepare(`INSERT INTO models (provider_id, model_id, name, kind, first_seen, last_seen,
    removed_at, is_new, summary_json, bench_json, history_json, updated_at)
    VALUES ('nara', 'nara/one', 'One', 'chat', ?, ?, NULL, 0, '{"id":"nara/one"}', '{"iq":1}', NULL, ?)`)
    .run(now, now, now);
  fixture.prepare("INSERT INTO catalog_meta (key, value_json) VALUES ('leaderboard', '{\"capturedAt\":\"2026-09-25\"}')").run();
  fixture.pragma('user_version = 1'); // as `migrate` leaves it: v1 applied, v2 pending
  fixture.close();

  const throughV2 = database.MIGRATIONS.filter((m) => m.version <= 2);
  const store = await database.open(dir, { ...opts(), migrations: throughV2 });
  try {
    assert.deepStrictEqual({ from: store.migration.from, to: store.migration.to }, { from: 1, to: 2 });
    assert.strictEqual(store.migration.backup, path.join(dir, 'venom.db.bak-v1'));
    assert.ok(fs.existsSync(store.migration.backup), 'the copy is on disk before the new tables exist');
    assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM providers').get().n, 1);
    assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM models').get().n, 1);
    assert.strictEqual(store.db.prepare("SELECT bench_json FROM models WHERE model_id = 'nara/one'").get().bench_json, '{"iq":1}',
      'v2 drops nothing: this is what "additive" means');
    assert.strictEqual(store.db.prepare("SELECT value_json FROM catalog_meta WHERE key = 'leaderboard'").get().value_json,
      '{"capturedAt":"2026-09-25"}', 'and the meta keys it found are left as they were');
    assert.strictEqual(store.db.pragma('user_version', { simple: true }), 2);
  } finally {
    store.close();
  }
});

test('secrets.cipher and provider_keys.cipher accept only a case-exact enc:v1: envelope', async (t) => {
  const store = await memoryStore(t);
  const now = Date.now();
  const insertSecret = (cipher) => store.db.prepare('INSERT INTO secrets (name, cipher, updated_at) VALUES (?, ?, ?)').run('aaApiKey', cipher, now);
  // Schema v1 has not shipped: the CHECK is GLOB (case-sensitive), not LIKE
  // (case-insensitive), so an upper-cased envelope is rejected, not silently let in.
  assert.throws(() => insertSecret('ENC:V1:x'), /CHECK constraint failed/);
  assert.throws(() => insertSecret('plain-text'), /CHECK constraint failed/);
  assert.throws(() => insertSecret('enc:v1:'), /CHECK constraint failed/); // no payload after the prefix
  insertSecret('enc:v1:x');

  store.db.prepare(`INSERT INTO providers (id, name, base_url, rpm, is_custom, position, created_at, updated_at)
    VALUES ('p1', 'P', 'https://x', NULL, 0, 0, ?, ?)`).run(now, now);
  const insertKey = (cipher) => store.db.prepare(`INSERT INTO provider_keys
    (id, provider_id, name, cipher, active, position, quota_spent_json, created_at, updated_at)
    VALUES ('k1', 'p1', 'K', ?, 1, 0, NULL, ?, ?)`).run(cipher, now, now);
  assert.throws(() => insertKey('ENC:V1:x'), /CHECK constraint failed/);
  insertKey('enc:v1:x');
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
    assert.deepStrictEqual(store.migration, { from: 4, to: 4, backup: null });
    assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.includes('.bak-v')), []);
  } finally {
    store.close();
  }
});

// The newest shipped version is 4, so a pending migration here is a v5: these
// three cases are about the migration SEQUENCE, and they read the same whichever
// version the plan has reached — but their fixtures must sit one above it.
test('a pending migration backs up first, then runs and bumps user_version', async (t) => {
  const dir = tempDir(t);
  (await database.open(dir, opts())).close();
  const withV5 = [...database.MIGRATIONS, { version: 5, up(db) { db.exec('CREATE TABLE extra_v5 (x INTEGER)'); } }];
  const store = await database.open(dir, { ...opts(), migrations: withV5 });
  try {
    assert.strictEqual(store.migration.from, 4);
    assert.strictEqual(store.migration.to, 5);
    assert.strictEqual(store.migration.backup, path.join(dir, 'venom.db.bak-v4'));
    assert.ok(fs.existsSync(store.migration.backup));
    assert.strictEqual(store.db.pragma('user_version', { simple: true }), 5);
  } finally {
    store.close();
  }
});

test('a migration that throws rolls back and leaves the version', async (t) => {
  const dir = tempDir(t);
  (await database.open(dir, opts())).close();
  const broken = [...database.MIGRATIONS, {
    version: 5,
    up(db) { db.exec('CREATE TABLE half_done (x INTEGER)'); throw new Error('migration bug'); },
  }];
  await assert.rejects(database.open(dir, { ...opts(), migrations: broken }), /migration bug/);
  const store = await database.open(dir, opts());
  try {
    assert.strictEqual(store.db.pragma('user_version', { simple: true }), 4);
    assert.strictEqual(store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'half_done'").get().n, 0);
  } finally {
    store.close();
  }
});

test('keeps only the three newest backups', async (t) => {
  const dir = tempDir(t);
  (await database.open(dir, opts())).close();
  const steps = [...database.MIGRATIONS];
  for (let v = 5; v <= 8; v += 1) {
    steps.push({ version: v, up(db) { db.exec(`CREATE TABLE step_${v} (x INTEGER)`); } });
    (await database.open(dir, { ...opts(), migrations: [...steps] })).close();
  }
  const backups = fs.readdirSync(dir).filter((n) => n.startsWith('venom.db.bak-v')).sort();
  assert.deepStrictEqual(backups, ['venom.db.bak-v5', 'venom.db.bak-v6', 'venom.db.bak-v7']);
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
