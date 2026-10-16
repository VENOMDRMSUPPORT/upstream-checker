// Provider runtime records, hydration and save reconciliation.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererModules } = require('./module-loader');

function setup({ stored = {}, readError = null, saveResult = null, catalog = null } = {}) {
  const writes = [];
  const changed = [];
  const renders = [];
  const persisted = async (label, call) => {
    const value = await call();
    writes.push({ label, value });
    return value;
  };
  const api = {
    readConfig: async () => {
      if (readError) throw readError;
      return { providers: stored };
    },
    saveProvider: async (payload) => saveResult || { keys: payload.keys.map((k) => ({ ...k, key: `venomkey:${k.id}`, hint: '••••', locked: false })) },
    mergeProvider: async () => null,
    deleteProvider: async () => true,
  };
  const namespace = loadRendererModules(['provider-store'], {
    structuredClone,
    window: { VENOM_RENDERER: {}, electronAPI: api, CATALOG: catalog },
  });
  const store = namespace.providerStore.create({
    builtinProviders: {
      alpha: { id: 'alpha', name: 'Alpha', baseUrl: 'https://alpha.test/v1', rpm: 20 },
      beta: { id: 'beta', name: 'Beta', baseUrl: 'https://beta.test/v1' },
    },
    electronAPI: api,
    persist: persisted,
    quotaSpentExpired: () => false,
    getCurrentPage: () => 'overview',
    renderProvidersPage: () => renders.push('render'),
    onProvidersChanged: (id) => changed.push(id),
  });
  return { store, writes, changed, renders, api };
}

test('load overlays stored values into the stable built-in map and seeds only missing providers', async () => {
  const { store, writes } = setup({ stored: {
    alpha: { name: 'My Alpha', baseUrl: 'https://custom.test/v1', rpm: null, keys: [{ id: 'k1', key: 'venomkey:k1', hint: '••••', active: true }] },
  } });
  const identity = store.providers;
  await store.loadAll();
  assert.equal(store.providers, identity);
  assert.equal(store.providers.alpha.name, 'My Alpha');
  assert.equal(store.providers.alpha.baseUrl, 'https://custom.test/v1');
  assert.equal(store.providers.alpha.rpm, 20);
  assert.equal(store.providers.alpha.keys[0].id, 'k1');
  assert.deepEqual(writes.map((x) => x.label), ['add Beta']);
});

test('failed config read blocks all seed, merge and cleanup writes', async () => {
  const { store, writes } = setup({ readError: new Error('read failed') });
  await assert.rejects(store.loadAll(), /read failed/);
  assert.deepEqual(writes, []);
  assert.deepEqual(Object.keys(store.providers), ['alpha', 'beta']);
  assert.equal(store.providers.alpha.keys.length, 0);
});

test('save reconciles stored key placeholders without erasing live key state', async () => {
  const { store, changed, renders, writes } = setup({ stored: {
    alpha: { name: 'Alpha', baseUrl: 'https://alpha.test/v1', keys: [{ id: 'k1', key: 'venomkey:k1', hint: '••••', active: true }] },
  } });
  await store.loadAll();
  const key = store.providers.alpha.keys[0];
  key.name = 'Renamed';
  key.quotaSpent = { at: 123 };
  const saved = await store.save('alpha');
  assert.equal(saved, true);
  assert.equal(key.key, 'venomkey:k1');
  assert.equal(key.hint, '••••');
  assert.equal(key.name, 'Renamed');
  assert.deepEqual(key.quotaSpent, { at: 123 });
  assert.deepEqual(changed, ['alpha']);
  assert.deepEqual(renders, []);
  assert.equal(writes.at(-1).label, 'save Alpha');
});

test('save invalidates catalog data and refreshes the visible providers page', async () => {
  const syncs = [];
  const catalog = { syncAll: (options) => syncs.push(options) };
  const renders = [];
  const changed = [];
  const api = {
    readConfig: async () => ({ providers: { alpha: { name: 'Alpha', baseUrl: 'https://alpha.test/v1', keys: [] } } }),
    saveProvider: async (payload) => ({ keys: payload.keys }),
    mergeProvider: async () => null,
    deleteProvider: async () => true,
  };
  const withPageCallbacks = loadRendererModules(['provider-store'], {
    structuredClone,
    window: { VENOM_RENDERER: {}, CATALOG: catalog },
  }).providerStore.create({
    builtinProviders: { alpha: { id: 'alpha', name: 'Alpha', baseUrl: 'https://alpha.test' } },
    electronAPI: api,
    persist: async (_, call) => call(),
    quotaSpentExpired: () => false,
    getCurrentPage: () => 'providers',
    renderProvidersPage: () => renders.push('render'),
    onProvidersChanged: (id) => changed.push(id),
  });
  await withPageCallbacks.loadAll();
  await withPageCallbacks.save('alpha');
  assert.equal(syncs.length, 1);
  assert.equal(syncs[0].reason, 'manual');
  assert.equal(syncs[0].providerId, 'alpha');
  assert.deepEqual(renders, ['render']);
  assert.deepEqual(changed, ['alpha']);
});
