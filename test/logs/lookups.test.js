const test = require('node:test');
const assert = require('node:assert');
const { createPriceBook, createProviderLookup } = require('../../src/logs/lookups');
const { memoryStore } = require('../helpers');

// The engine's row shape, as repos.snapshots stores it: provider facts only,
// every derived field stripped, every field borrowed from the reference
// re-blanked to null (src/catalog/snapshot.js providerRowSnapshot).
function storeRow(store, providerId, modelId, row) {
  const now = Date.now();
  store.db.prepare(`INSERT INTO roster_snapshot
      (provider_id, model_id, name, first_seen, last_seen, removed_at, summary_json, health_json, updated_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?)
    ON CONFLICT(provider_id, model_id) DO UPDATE SET summary_json = excluded.summary_json`)
    .run(providerId, modelId, modelId, now, now, JSON.stringify(row), now);
  store.db.prepare(`INSERT INTO snapshot_meta (provider_id, created_at, fetched_at, last_sync_json, pending_drop_json)
    VALUES (?, ?, ?, NULL, NULL) ON CONFLICT(provider_id) DO NOTHING`).run(providerId, now, now);
}

const entry = (id, costIn, costOut, extra = {}) => ({
  id, name: id, context_tokens: null, cost_in_per_m: costIn, cost_out_per_m: costOut, cost_kind: 'unknown', ...extra,
});

test('the price book reads the roster price, caches it, and reads again after invalidate', async (t) => {
  const store = await memoryStore(t);
  storeRow(store, 'nara', 'm1', entry('m1', 2, 10));
  const prices = createPriceBook(store.db);
  assert.deepStrictEqual(prices.get('nara', 'm1'), { input: 2, output: 10 });
  storeRow(store, 'nara', 'm1', entry('m1', 3, 12));
  assert.deepStrictEqual(prices.get('nara', 'm1'), { input: 2, output: 10 }, 'cached until invalidated');
  prices.invalidate();
  assert.deepStrictEqual(prices.get('nara', 'm1'), { input: 3, output: 12 });
});

test('a missing, half-stated or malformed price is null', async (t) => {
  const store = await memoryStore(t);
  storeRow(store, 'nara', 'none', entry('none', null, null));
  storeRow(store, 'nara', 'half', entry('half', 2, null));
  storeRow(store, 'nara', 'neg', entry('neg', -1, 1));
  storeRow(store, 'nara', 'free', entry('free', 0, 0, { cost_kind: 'free' }));
  store.db.prepare(`INSERT INTO roster_snapshot
      (provider_id, model_id, name, first_seen, last_seen, removed_at, summary_json, health_json, updated_at)
    VALUES ('nara', 'junk', 'junk', 1, 1, NULL, 'not json', NULL, 1)`).run();
  const prices = createPriceBook(store.db);
  assert.strictEqual(prices.get('nara', 'none'), null);
  assert.strictEqual(prices.get('nara', 'half'), null, 'half a price is not a price');
  assert.strictEqual(prices.get('nara', 'neg'), null, 'a negative price is never carried');
  assert.strictEqual(prices.get('nara', 'junk'), null);
  assert.strictEqual(prices.get('nara', 'unknown'), null, 'an unknown model is null, not a throw');
  assert.deepStrictEqual(prices.get('nara', 'free'), { input: 0, output: 0 });
});

// A row whose price came from the reference is stored blanked, so the log says
// "unknown" rather than logging a number the provider never published.
test("a price borrowed from the reference is not logged as the provider's own", async (t) => {
  const store = await memoryStore(t);
  storeRow(store, 'nara', 'borrowed', { ...entry('borrowed', null, null), filled_from_catalog: ['cost_in_per_m', 'cost_out_per_m'] });
  const prices = createPriceBook(store.db);
  assert.strictEqual(prices.get('nara', 'borrowed'), null);
});

// The old table is gone with migration v3, so the book must not read it: this
// is the case that would otherwise leave every request's cost silently blank.
test('the price book never reads the retired models table', async (t) => {
  const store = await memoryStore(t);
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.ok(tables.includes('models'), 'the table still exists — v3 clears it, it does not drop it');
  assert.ok(!store.db.prepare('PRAGMA table_info(models)').all().some((c) => c.name === 'bench_json'),
    'the benchmark columns are gone');
  storeRow(store, 'nara', 'm1', entry('m1', 2, 10));
  const prices = createPriceBook(store.db);
  assert.deepStrictEqual(prices.get('nara', 'm1'), { input: 2, output: 10 });
});

test('the provider lookup lists id, name and base URL', async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.save({ id: 'nara', name: 'NaraRouter', baseUrl: 'https://router.bynara.id/v1', rpm: null, keys: [] });
  assert.deepStrictEqual(createProviderLookup(store.db).list().map((p) => ({ ...p })), [
    { id: 'nara', name: 'NaraRouter', baseUrl: 'https://router.bynara.id/v1' },
  ]);
});