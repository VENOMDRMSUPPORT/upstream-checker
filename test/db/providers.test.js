const test = require('node:test');
const assert = require('node:assert');
const { memoryStore, fakeCipher, encFake, LOCKED_BLOB } = require('../helpers');
const { maskKey } = require('../../src/db/repos/providers');

const NARA = 'https://router.bynara.id/v1';
const nara = (keys, extra = {}) => ({ id: 'nara', name: 'NaraRouter', baseUrl: NARA, rpm: null, keys, ...extra });
const cipherOf = (store, id) => store.db.prepare('SELECT cipher FROM provider_keys WHERE id = ?').get(id).cipher;
const OTHER_LOCKED = `enc:v1:${Buffer.from('ciphertext from a second machine').toString('base64')}`;

test('a typed key is stored encrypted and read back as a placeholder with a hint', async (t) => {
  const store = await memoryStore(t);
  const saved = store.repos.providers.save(nara([{ id: 'key_1', name: 'Main', key: 'sk-nara-secret-0001', active: true }]));
  const raw = cipherOf(store, 'key_1');
  assert.ok(raw.startsWith('enc:v1:') && !raw.includes('sk-nara-secret-0001'));
  assert.deepStrictEqual(saved, {
    name: 'NaraRouter', baseUrl: NARA, rpm: null,
    keys: [{ id: 'key_1', name: 'Main', key: 'venomkey:key_1', hint: 'sk-nara-se********0001', active: true, locked: false }],
  });
  assert.strictEqual(store.repos.providers.revealKey('key_1'), 'sk-nara-secret-0001');
  assert.deepStrictEqual(Object.keys(store.repos.providers.list()), ['nara']);
});

test("maskKey is today's mask", () => {
  assert.strictEqual(maskKey(''), '');
  assert.strictEqual(maskKey('sk-short-1'), 'sk-sho********rt-1');
  assert.strictEqual(maskKey('sk-nara-secret-0001'), 'sk-nara-se********0001');
});

test('the placeholder of the same key keeps the stored cipher', async (t) => {
  const cipher = fakeCipher();
  const store = await memoryStore(t, { cipher });
  store.repos.providers.save(nara([{ id: 'key_1', name: 'Main', key: 'sk-1', active: true }]));
  const before = cipherOf(store, 'key_1');
  const encrypts = cipher.calls.encrypt;
  store.repos.providers.save(nara([{ id: 'key_1', name: 'Renamed', key: 'venomkey:key_1', active: false }]));
  assert.strictEqual(cipherOf(store, 'key_1'), before);
  assert.strictEqual(cipher.calls.encrypt, encrypts);
  const k = store.repos.providers.get('nara').keys[0];
  assert.strictEqual(k.name, 'Renamed');
  assert.strictEqual(k.active, false);
});

test("a locked key sent back as '' keeps its ciphertext, save after save", async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.importProvider({
    id: 'nara', name: 'NaraRouter', baseUrl: NARA, rpm: null, custom: false, position: 0,
    keys: [{ id: 'key_1', name: 'Other PC', cipher: LOCKED_BLOB, active: true, quotaSpent: null }],
  });
  for (let i = 0; i < 3; i += 1) {
    const current = store.repos.providers.get('nara');
    assert.deepStrictEqual(current.keys[0], { id: 'key_1', name: 'Other PC', key: '', hint: '', active: true, locked: true });
    store.repos.providers.save({ id: 'nara', name: current.name, baseUrl: current.baseUrl, rpm: current.rpm, keys: current.keys });
    assert.strictEqual(cipherOf(store, 'key_1'), LOCKED_BLOB);
  }
});

test("'' for a key that doesn't exist yet fails and writes nothing", async (t) => {
  const store = await memoryStore(t);
  assert.throws(() => store.repos.providers.save(nara([{ id: 'key_1', name: 'Empty', key: '', active: true }])), /has no value/);
  assert.strictEqual(store.repos.providers.get('nara'), null);
});

test('a new value replaces the secret and the next read sees it', async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.save(nara([{ id: 'key_1', name: 'Main', key: 'sk-old-value-1', active: true }]));
  assert.strictEqual(store.repos.providers.revealKey('key_1'), 'sk-old-value-1');
  store.repos.providers.save(nara([{ id: 'key_1', name: 'Main', key: 'sk-new-value-2', active: true }]));
  assert.strictEqual(store.repos.providers.revealKey('key_1'), 'sk-new-value-2');
});

test('sending the same plaintext back keeps the stored cipher', async (t) => {
  const cipher = fakeCipher();
  const store = await memoryStore(t, { cipher });
  store.repos.providers.save(nara([{ id: 'key_1', name: 'Main', key: 'sk-same', active: true }]));
  const before = cipherOf(store, 'key_1');
  const encrypts = cipher.calls.encrypt;
  store.repos.providers.save(nara([{ id: 'key_1', name: 'Main', key: 'sk-same', active: true }]));
  assert.strictEqual(cipherOf(store, 'key_1'), before);
  assert.strictEqual(cipher.calls.encrypt, encrypts);
});

test('keys missing from the payload are deleted', async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.save(nara([
    { id: 'key_1', name: 'One', key: 'sk-1', active: true },
    { id: 'key_2', name: 'Two', key: 'sk-2', active: true },
  ]));
  store.repos.providers.save(nara([{ id: 'key_2', name: 'Two', key: 'venomkey:key_2', active: true }]));
  assert.deepStrictEqual(store.repos.providers.get('nara').keys.map((k) => k.id), ['key_2']);
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM provider_keys').get().n, 1);
  assert.strictEqual(store.repos.providers.revealKey('key_1'), null);
});

test("a placeholder of another provider's key fails and changes nothing", async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.save(nara([{ id: 'key_1', name: 'Nara', key: 'sk-nara-1', active: true }]));
  const dark = (name, keys) => ({ id: 'darkapi', name, baseUrl: 'https://darkapi.dev/v1', rpm: null, keys });
  store.repos.providers.save(dark('Dark API', [{ id: 'key_2', name: 'Dark', key: 'sk-dark-2', active: true }]));
  assert.throws(() => store.repos.providers.save(dark('Dark API renamed', [
    { id: 'key_2', name: 'Dark', key: 'venomkey:key_2', active: true },
    { id: 'key_3', name: 'Stolen', key: 'venomkey:key_1', active: true },
  ])), /belongs to another provider/);
  assert.strictEqual(store.repos.providers.get('darkapi').name, 'Dark API');
  assert.deepStrictEqual(store.repos.providers.get('darkapi').keys.map((k) => k.id), ['key_2']);
});

test('a key id that another provider owns is refused', async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.save(nara([{ id: 'key_1', name: 'Nara', key: 'sk-nara-1', active: true }]));
  assert.throws(() => store.repos.providers.save({
    id: 'darkapi', name: 'Dark API', baseUrl: 'https://darkapi.dev/v1', rpm: null,
    keys: [{ id: 'key_1', name: 'Clash', key: 'sk-other', active: true }],
  }), /belongs to another provider/);
  assert.strictEqual(store.repos.providers.revealKey('key_1'), 'sk-nara-1');
});

test('an unknown placeholder, a secret placeholder or a ciphertext is refused as a value', async (t) => {
  const store = await memoryStore(t);
  const attempt = (key) => () => store.repos.providers.save(nara([{ id: 'key_1', name: 'Bad', key, active: true }]));
  assert.throws(attempt('venomkey:nope'), /doesn't exist/);
  assert.throws(attempt('venomsecret:aaApiKey'), /not a usable key value/);
  assert.throws(attempt(encFake('x')), /not a usable key value/);
});

test('created_at survives updates and position follows payload order', async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.save(nara([
    { id: 'key_1', name: 'One', key: 'sk-1', active: true },
    { id: 'key_2', name: 'Two', key: 'sk-2', active: true },
  ]));
  const createdAt = (id) => store.db.prepare('SELECT created_at FROM provider_keys WHERE id = ?').get(id).created_at;
  const first = createdAt('key_1');
  await new Promise((r) => setTimeout(r, 5));
  store.repos.providers.save(nara([
    { id: 'key_2', name: 'Two', key: 'venomkey:key_2', active: true },
    { id: 'key_1', name: 'One', key: 'venomkey:key_1', active: true },
  ]));
  assert.deepStrictEqual(store.repos.providers.get('nara').keys.map((k) => k.id), ['key_2', 'key_1']);
  assert.strictEqual(createdAt('key_1'), first);
  const positions = store.db.prepare('SELECT id, position FROM provider_keys ORDER BY id').all();
  assert.deepStrictEqual(positions, [{ id: 'key_1', position: 1 }, { id: 'key_2', position: 0 }]);
});

test('is_custom is kept when the payload leaves it out', async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.save({ ...nara([]), id: 'old_custom', custom: true });
  assert.strictEqual(store.repos.providers.get('old_custom').custom, true);
  store.repos.providers.save({ ...nara([]), id: 'old_custom' });
  assert.strictEqual(store.repos.providers.get('old_custom').custom, true);
  store.repos.providers.save({ ...nara([]), id: 'old_custom', custom: false });
  assert.strictEqual('custom' in store.repos.providers.get('old_custom'), false);
});

test('with OS encryption unavailable a typed key is refused and nothing is stored', async (t) => {
  const store = await memoryStore(t, { cipher: fakeCipher({ available: false }) });
  assert.throws(() => store.repos.providers.save(nara([{ id: 'key_1', name: 'Main', key: 'sk-1', active: true }])), /unavailable/);
  assert.strictEqual(store.repos.providers.get('nara'), null);
});

test('merge moves keys, drops duplicates by value and deletes the source', async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.save(nara([{ id: 'key_1', name: 'Main', key: 'sk-shared', active: true }]));
  store.repos.providers.save({
    id: 'custom_1', name: 'Old custom', baseUrl: `${NARA}/`, rpm: null, custom: true,
    keys: [
      { id: 'key_2', name: 'Dup', key: 'sk-shared', active: true },
      { id: 'key_3', name: 'Only here', key: 'sk-only-custom', active: false },
    ],
  });
  const merged = store.repos.providers.merge('custom_1', 'nara');
  assert.deepStrictEqual(merged.keys.map((k) => [k.id, k.active]), [['key_1', true], ['key_3', false]]);
  assert.strictEqual(store.repos.providers.get('custom_1'), null);
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM provider_keys').get().n, 2);
  assert.strictEqual(store.repos.providers.revealKey('key_3'), 'sk-only-custom');
});

test('merge dedupes locked keys by ciphertext', async (t) => {
  const store = await memoryStore(t);
  const add = (id, keys) => store.repos.providers.importProvider({ id, name: id, baseUrl: NARA, rpm: null, custom: id !== 'nara', position: 0, keys });
  add('nara', [{ id: 'key_1', name: 'Locked A', cipher: LOCKED_BLOB, active: true, quotaSpent: null }]);
  add('custom_1', [
    { id: 'key_2', name: 'Locked A again', cipher: LOCKED_BLOB, active: true, quotaSpent: null },
    { id: 'key_3', name: 'Locked B', cipher: OTHER_LOCKED, active: true, quotaSpent: null },
  ]);
  const merged = store.repos.providers.merge('custom_1', 'nara');
  assert.deepStrictEqual(merged.keys.map((k) => k.id), ['key_1', 'key_3']);
  assert.strictEqual(cipherOf(store, 'key_3'), OTHER_LOCKED);
});

test('merge refuses a missing provider or itself', async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.save(nara([]));
  assert.throws(() => store.repos.providers.merge('nara', 'nara'), /itself/);
  assert.throws(() => store.repos.providers.merge('ghost', 'nara'), /not found/);
  assert.throws(() => store.repos.providers.merge('nara', 'ghost'), /not found/);
});

test('remove deletes the provider and its keys', async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.save(nara([{ id: 'key_1', name: 'Main', key: 'sk-1', active: true }]));
  assert.strictEqual(store.repos.providers.remove('nara'), true);
  assert.strictEqual(store.repos.providers.get('nara'), null);
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM provider_keys').get().n, 0);
  assert.strictEqual(store.repos.providers.remove('nara'), false);
});

test("keyRecord names the key's provider; revealKey is null for a locked key", async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.save(nara([{ id: 'key_1', name: 'Main', key: 'sk-1', active: true }]));
  store.repos.providers.importProvider({
    id: 'darkapi', name: 'Dark API', baseUrl: 'https://darkapi.dev/v1', rpm: null, custom: false, position: 1,
    keys: [{ id: 'key_2', name: 'Other PC', cipher: LOCKED_BLOB, active: true, quotaSpent: null }],
  });
  assert.deepStrictEqual(store.repos.providers.keyRecord('key_1'), { id: 'key_1', name: 'Main', providerId: 'nara', baseUrl: NARA });
  assert.strictEqual(store.repos.providers.keyRecord('key_9'), null);
  assert.strictEqual(store.repos.providers.revealKey('key_2'), null);
  assert.strictEqual(store.repos.providers.revealKey('key_9'), null);
});
