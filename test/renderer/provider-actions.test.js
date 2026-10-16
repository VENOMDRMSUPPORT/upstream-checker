// Provider-key actions use injected persistence and the main request path.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererModules } = require('./module-loader');

function setup() {
  const providers = { alpha: { id: 'alpha', keys: [
    { id: 'key-1', name: 'One', active: true, key: 'fixture-secret' },
    { id: 'locked', name: 'Locked', active: true, locked: true },
  ] } };
  const expanded = new Set();
  const saved = [];
  const refreshed = [];
  let armed = null;
  const window = { VENOM_RENDERER: {}, CATALOG: null, KEY_USAGE: null, electronAPI: { copyKey: async () => {} } };
  const document = { getElementById: () => null };
  const namespace = loadRendererModules(['provider-actions'], { window, document, requestAnimationFrame: (fn) => fn() });
  const actions = namespace.providerActions.create({
    getProviders: () => providers,
    getActiveProvider: () => 'alpha',
    getCurrentPage: () => 'overview',
    getKeyDeleteArmed: () => armed,
    setKeyDeleteArmed: (value) => { armed = value; },
    getExpanded: () => expanded,
    keyProbe: new Map(), keyTestAct: new Map(), recheckAct: new Map(),
    saveProviderConfig: async (id) => { saved.push(id); return true; },
    renderKeysList: () => refreshed.push('keys'), updateTestAllButton: () => refreshed.push('test-all'),
    renderProvidersPage: () => refreshed.push('providers'), setStatus() {},
    isHealthyResponse: () => false, keyProbeResult: () => ({ state: 'ok' }), setAct() {},
    healthTimeoutMs: 1000, actionMinRunningMs: 0,
    KX_ICON: { trash: 'trash' }, escapeHtml: (value) => String(value),
  });
  return { actions, providers, expanded, saved, refreshed, getArmed: () => armed };
}

test('key activation saves changes and locked keys remain unchanged', async () => {
  const { actions, providers, saved, refreshed } = setup();
  await actions.toggleKeyActive('key-1');
  assert.equal(providers.alpha.keys[0].active, false);
  assert.equal(providers.alpha.keys[1].active, true);
  assert.deepEqual(saved, ['alpha']);
  assert.deepEqual(refreshed, ['keys', 'test-all']);
});

test('connected-row deletion requires a second click, saves, and clears its armed state', async () => {
  const { actions, providers, saved, getArmed } = setup();
  await actions.deleteKey('alpha', 'key-1');
  assert.equal(getArmed(), 'key-1');
  assert.equal(providers.alpha.keys.length, 2);
  await actions.deleteKey('alpha', 'key-1');
  assert.equal(getArmed(), null);
  assert.deepEqual(providers.alpha.keys.map((key) => key.id), ['locked']);
  assert.deepEqual(saved, ['alpha']);
});
