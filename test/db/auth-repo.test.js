// The app_lock row: one row, enforced by the schema, and a fresh database reads
// as "default password" rather than as an error.
const test = require('node:test');
const assert = require('node:assert');
const { memoryStore } = require('../helpers');
const { hashPassword, DEFAULT_PASSWORD, verifyPassword } = require('../../src/auth/hash');
const { createAuthRepo } = require('../../src/db/repos/auth');
const MIGRATIONS = require('../../src/db/migrations');

test('migration v4 creates an empty app_lock table', async (t) => {
  const { db } = await memoryStore(t);
  assert.strictEqual(db.pragma('user_version', { simple: true }), 5);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM app_lock').get().n, 0);
});

test('a fresh database has no row, so the default password applies', async (t) => {
  const { repos } = await memoryStore(t);
  assert.strictEqual(repos.auth.get(), null);
});

test('ensureDefault writes exactly one row and never replaces it', async (t) => {
  const store = await memoryStore(t);
  const { value } = hashPassword(DEFAULT_PASSWORD);
  const first = store.repos.auth.ensureDefault(value, { now: 111 });
  assert.strictEqual(first.is_default, 1);
  assert.strictEqual(first.created_at, 111);
  assert.strictEqual(first.failed_attempts, 0);
  assert.strictEqual(first.locked_until, 0);

  // A second call with a different hash must leave the first row alone: that is
  // what makes it safe to run on every launch.
  const second = store.repos.auth.ensureDefault(hashPassword('something-else').value, { now: 999 });
  assert.strictEqual(second.hash, first.hash);
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM app_lock').get().n, 1);
});

test('the schema refuses a second row', async (t) => {
  const store = await memoryStore(t);
  store.repos.auth.ensureDefault(hashPassword(DEFAULT_PASSWORD).value);
  assert.throws(
    () => store.db.prepare('INSERT INTO app_lock (id, hash, created_at) VALUES (2, ?, ?)').run('scrypt$x', 1),
    /CHECK constraint failed|UNIQUE constraint failed/,
  );
});

test('the stored hash is a scrypt string and the plaintext is nowhere in the row', async (t) => {
  const store = await memoryStore(t);
  const { value } = hashPassword(DEFAULT_PASSWORD);
  store.repos.auth.ensureDefault(value);
  const raw = store.db.prepare('SELECT * FROM app_lock WHERE id = 1').get();
  assert.ok(raw.hash.startsWith('scrypt$'));
  assert.ok(!JSON.stringify(raw).includes(DEFAULT_PASSWORD));
  assert.strictEqual(verifyPassword(DEFAULT_PASSWORD, raw.hash), true);
});

test('setHash clears is_default and the failure counters', async (t) => {
  const store = await memoryStore(t);
  store.repos.auth.ensureDefault(hashPassword(DEFAULT_PASSWORD).value);
  store.repos.auth.recordFailure(3);
  store.repos.auth.setLockedUntil(5000);
  store.repos.auth.setHash(hashPassword('a-much-better-one').value, { isDefault: false, now: 777 });
  const row = store.repos.auth.get();
  assert.strictEqual(row.is_default, 0);
  assert.strictEqual(row.failed_attempts, 0);
  assert.strictEqual(row.locked_until, 0);
  assert.strictEqual(row.changed_at, 777);
  assert.strictEqual(verifyPassword('a-much-better-one', row.hash), true);
  assert.strictEqual(verifyPassword(DEFAULT_PASSWORD, row.hash), false);
});

test('setHash on a missing row throws rather than silently doing nothing', async (t) => {
  const { repos } = await memoryStore(t);
  assert.throws(() => repos.auth.setHash('scrypt$x'), /No app_lock row/);
});

test('remove deletes exactly the one row and nothing else moves', async (t) => {
  const store = await memoryStore(t);
  store.repos.auth.ensureDefault(hashPassword(DEFAULT_PASSWORD).value);
  store.repos.providers.save({ id: 'nara', name: 'NaraRouter', baseUrl: 'https://x', keys: [] });
  store.repos.settings.set('settings', { theme: 'vercel' });
  assert.strictEqual(store.repos.auth.remove(), 1);
  assert.strictEqual(store.repos.auth.get(), null);
  // The recovery path must not be a data-loss path.
  assert.ok(store.repos.providers.get('nara'), 'providers survive a lock reset');
  assert.deepStrictEqual(store.repos.settings.get('settings'), { theme: 'vercel' });
  // And the next ensureDefault brings the shipped default back.
  store.repos.auth.ensureDefault(hashPassword(DEFAULT_PASSWORD).value, { isDefault: true });
  assert.strictEqual(store.repos.auth.get().is_default, 1);
});

test('remove on an already-empty table is a no-op', async (t) => {
  const { repos } = await memoryStore(t);
  assert.strictEqual(repos.auth.remove(), 0);
});

test('createAuthRepo works against a bare database, not only the assembled store', async (t) => {
  const { db } = await memoryStore(t);
  const repo = createAuthRepo(db);
  repo.ensureDefault(hashPassword(DEFAULT_PASSWORD).value);
  assert.strictEqual(repo.get().is_default, 1);
  assert.strictEqual(repo.remove(), 1);
});

test('migration v4 applied to a v3 database leaves the earlier tables intact', async (t) => {
  // Build a database at v3 only, put a setting in it, then run v4. A migration
  // that drops or rewrites anything else would show up here.
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  t.after(() => { if (db.open) db.close(); });
  const v3 = MIGRATIONS.filter((m) => m.version <= 3);
  v3.forEach((m) => db.transaction(() => { m.up(db); db.pragma(`user_version = ${m.version}`); })());
  db.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)').run('settings', '{"theme":"vercel"}', 1);

  const v4 = MIGRATIONS.find((m) => m.version === 4);
  db.transaction(() => { v4.up(db); db.pragma('user_version = 4'); })();

  assert.strictEqual(db.pragma('user_version', { simple: true }), 4);
  assert.deepStrictEqual(
    JSON.parse(db.prepare("SELECT value_json FROM settings WHERE key = 'settings'").get().value_json),
    { theme: 'vercel' },
  );
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM app_lock').get().n, 0);
});
