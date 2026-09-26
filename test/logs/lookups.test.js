const test = require('node:test');
const assert = require('node:assert');
const { createPriceBook, createProviderLookup } = require('../../src/logs/lookups');
const { memoryStore } = require('../helpers');

const entry = (id, pricing) => ({
  key: `nara::${id}`, providerId: 'nara', id, name: id, removedAt: null, isNew: false, keyIds: [], pricing,
});

test('the price book reads the pool price, caches it, and reads again after invalidate', async (t) => {
  const store = await memoryStore(t);
  store.repos.catalog.write({ models: { 'nara::m1': entry('m1', { input: 2, output: 10, source: 'provider' }) } });
  const prices = createPriceBook(store.db);
  assert.deepStrictEqual(prices.get('nara', 'm1'), { input: 2, output: 10 });
  store.repos.catalog.write({ models: { 'nara::m1': entry('m1', { input: 3, output: 12, source: 'provider' }) } });
  assert.deepStrictEqual(prices.get('nara', 'm1'), { input: 2, output: 10 }, 'cached until invalidated');
  prices.invalidate();
  assert.deepStrictEqual(prices.get('nara', 'm1'), { input: 3, output: 12 });
});

test('a missing or malformed price is null', async (t) => {
  const store = await memoryStore(t);
  store.repos.catalog.write({ models: {
    'nara::none': entry('none', null),
    'nara::half': entry('half', { input: 2 }),
    'nara::neg': entry('neg', { input: -1, output: 1 }),
    'nara::free': entry('free', { input: 0, output: 0, source: 'free tier' }),
  } });
  const prices = createPriceBook(store.db);
  assert.strictEqual(prices.get('nara', 'none'), null);
  assert.strictEqual(prices.get('nara', 'half'), null);
  assert.strictEqual(prices.get('nara', 'neg'), null);
  assert.strictEqual(prices.get('nara', 'unknown'), null);
  assert.deepStrictEqual(prices.get('nara', 'free'), { input: 0, output: 0 });
});

test('the provider lookup lists id, name and base URL', async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.save({ id: 'nara', name: 'NaraRouter', baseUrl: 'https://router.bynara.id/v1', rpm: null, keys: [] });
  assert.deepStrictEqual(createProviderLookup(store.db).list().map((p) => ({ ...p })), [
    { id: 'nara', name: 'NaraRouter', baseUrl: 'https://router.bynara.id/v1' },
  ]);
});
