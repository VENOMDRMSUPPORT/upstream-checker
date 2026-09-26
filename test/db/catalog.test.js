const test = require('node:test');
const assert = require('node:assert');
const { memoryStore } = require('../helpers');

function catalogFixture() {
  return {
    version: 1,
    models: {
      'nara::qwen3.8-flash:free': {
        key: 'nara::qwen3.8-flash:free', providerId: 'nara', id: 'qwen3.8-flash:free',
        firstSeen: 1727000000000, lastSeen: 1727100000000, removedAt: null, isNew: true,
        pricing: { input: 0, output: 0, source: 'free tier' }, declaresTools: null, maxOutput: 8192,
        name: 'Qwen 3.8 Flash', kind: 'chat', hasVision: false, hasReasoning: true, isFree: true, isFreeForPaid: false,
        contextLabel: '128K', contextWindow: 131072, keyIds: ['key_2', 'key_1'], ownedBy: 'qwen',
        bench: { suite: 3, at: 1727100000000, composite: 71.5, tier: 'B', items: [{ id: 'r1', ok: true, reply: 'four' }] },
        history: [{ at: 1727100000000, composite: 71.5, tier: 'B', quality: 70, latencyMs: 900, ttftMs: 300 }],
        benchError: null,
        caps: { version: 1, at: 1727100000000, tools: { supported: true, time: 800, note: '' } },
        capsError: null,
        aliasGroup: 'qwen3.8-flash',
      },
      'darkapi::old-model': {
        key: 'darkapi::old-model', providerId: 'darkapi', id: 'old-model',
        firstSeen: 1726000000000, lastSeen: 1726500000000, removedAt: 1726600000000, isNew: false,
        pricing: null, declaresTools: false, maxOutput: null, name: 'old-model', kind: 'image',
        hasVision: false, hasReasoning: false, isFree: false, isFreeForPaid: true, contextLabel: '', contextWindow: null,
        keyIds: [], ownedBy: '', bench: null, history: [], benchError: 'HTTP 502', capsError: null,
      },
    },
    lastSync: { nara: 1727100000000, darkapi: 1726600000000 },
    keyModels: { key_1: { count: 12, at: 1727100000000 }, key_2: { count: 3, at: 1727100000000 } },
    leaderboard: {
      source: 'artificialanalysis.ai (live API)', at: 1727000000000,
      models: [{ name: 'Qwen', slug: 'qwen3-8', creator: 'Alibaba', index: 55, codingIndex: 50, mathIndex: 60, tps: 120, ttft: 0.4, priceBlended: 0.2 }],
    },
    leaderboardError: null,
    profiles: { policy: { version: 1, minRuns: 3, topN: 5 } },
  };
}

test('a catalogue round-trips deep-equal', async (t) => {
  const { repos } = await memoryStore(t);
  repos.catalog.write(catalogFixture(), { reset: true });
  assert.deepStrictEqual(repos.catalog.read(), catalogFixture());
});

test('unknown entry fields are kept under summary_json.extra', async (t) => {
  const store = await memoryStore(t);
  store.repos.catalog.write(catalogFixture(), { reset: true });
  const row = store.db.prepare("SELECT summary_json FROM models WHERE model_id = 'qwen3.8-flash:free'").get();
  const summary = JSON.parse(row.summary_json);
  assert.deepStrictEqual(summary.extra, { aliasGroup: 'qwen3.8-flash' });
  assert.deepStrictEqual(Object.keys(summary).filter((k) => k !== 'extra').sort(), [
    'contextLabel', 'contextWindow', 'declaresTools', 'hasReasoning', 'hasVision', 'isFree', 'isFreeForPaid', 'maxOutput', 'ownedBy', 'pricing',
  ]);
});

test('absent benchError/capsError read back as null; absent caps stays absent', async (t) => {
  const { repos } = await memoryStore(t);
  const cat = catalogFixture();
  delete cat.models['darkapi::old-model'].benchError;
  delete cat.models['darkapi::old-model'].capsError;
  repos.catalog.write(cat, { reset: true });
  const e = repos.catalog.read().models['darkapi::old-model'];
  assert.strictEqual(e.benchError, null);
  assert.strictEqual(e.capsError, null);
  assert.strictEqual('caps' in e, false);
});

test('keyIds keep their order', async (t) => {
  const { repos } = await memoryStore(t);
  repos.catalog.write(catalogFixture(), { reset: true });
  assert.deepStrictEqual(repos.catalog.read().models['nara::qwen3.8-flash:free'].keyIds, ['key_2', 'key_1']);
});

test('unchanged rows are not rewritten, before or after a read', async (t) => {
  const { repos } = await memoryStore(t);
  assert.deepStrictEqual(repos.catalog.write(catalogFixture(), { reset: true }), { written: 2, deleted: 0 });
  assert.deepStrictEqual(repos.catalog.write(catalogFixture()), { written: 0, deleted: 0 });
  repos.catalog.resetCache();
  repos.catalog.read();
  assert.deepStrictEqual(repos.catalog.write(catalogFixture()), { written: 0, deleted: 0 });
});

test('a changed row is written alone and a missing entry is deleted with its key links', async (t) => {
  const store = await memoryStore(t);
  store.repos.catalog.write(catalogFixture(), { reset: true });
  const cat = catalogFixture();
  cat.models['darkapi::old-model'].lastSeen = 1726700000000;
  delete cat.models['nara::qwen3.8-flash:free'];
  assert.deepStrictEqual(store.repos.catalog.write(cat), { written: 1, deleted: 1 });
  assert.deepStrictEqual(Object.keys(store.repos.catalog.read().models), ['darkapi::old-model']);
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM model_keys').get().n, 0);
});

test('an empty model set never replaces a non-empty one without reset', async (t) => {
  const { repos } = await memoryStore(t);
  const empty = { ...catalogFixture(), models: {} };
  assert.deepStrictEqual(repos.catalog.write(empty), { written: 0, deleted: 0 });
  repos.catalog.write(catalogFixture(), { reset: true });
  assert.throws(() => repos.catalog.write(empty), /Refusing to empty the model pool/);
  assert.throws(() => repos.catalog.write(empty, { reset: 'yes' }), /Refusing to empty the model pool/);
  assert.strictEqual(Object.keys(repos.catalog.read().models).length, 2);
  assert.deepStrictEqual(repos.catalog.write(empty, { reset: true }), { written: 0, deleted: 2 });
  assert.deepStrictEqual(repos.catalog.read().models, {});
});

test('lastSync, keyModels and meta follow the payload; absent sections are left alone', async (t) => {
  const { repos } = await memoryStore(t);
  repos.catalog.write(catalogFixture(), { reset: true });
  const cat = catalogFixture();
  delete cat.lastSync.darkapi;
  cat.keyModels = { key_1: { count: 13, at: 1727200000000 } };
  delete cat.profiles;
  cat.leaderboardError = undefined;
  repos.catalog.write(cat);
  const back = repos.catalog.read();
  assert.deepStrictEqual(back.lastSync, { nara: 1727100000000 });
  assert.deepStrictEqual(back.keyModels, { key_1: { count: 13, at: 1727200000000 } });
  assert.deepStrictEqual(back.profiles, catalogFixture().profiles);
  assert.strictEqual('leaderboardError' in back, false);
});

test('a write that fails inside the transaction is retried in full next time', async (t) => {
  const store = await memoryStore(t);
  const cat = catalogFixture();
  store.repos.catalog.write(cat, { reset: true });
  store.db.exec(`CREATE TRIGGER fail_sync BEFORE INSERT ON provider_sync WHEN NEW.provider_id = 'boom'
    BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
  cat.models['nara::qwen3.8-flash:free'].name = 'Renamed';
  cat.lastSync.boom = 1;
  assert.throws(() => store.repos.catalog.write(cat), /disk full/);
  // Raw SQL, not read(): read() would rebuild the hashes and hide the bug this pins.
  assert.strictEqual(store.db.prepare("SELECT name FROM models WHERE model_id = 'qwen3.8-flash:free'").get().name, 'Qwen 3.8 Flash');
  store.db.exec('DROP TRIGGER fail_sync');
  delete cat.lastSync.boom;
  assert.strictEqual(store.repos.catalog.write(cat).written, 1);
  assert.strictEqual(store.repos.catalog.read().models['nara::qwen3.8-flash:free'].name, 'Renamed');
});

test('an entry without providerId or id is refused before anything is written', async (t) => {
  const { repos } = await memoryStore(t);
  const cat = catalogFixture();
  cat.models['broken'] = { id: 'x' };
  assert.throws(() => repos.catalog.write(cat, { reset: true }), /providerId and id/);
  assert.deepStrictEqual(repos.catalog.read().models, {});
});
