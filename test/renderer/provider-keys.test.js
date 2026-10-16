// Shared key status and provider-row rendering.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererModules } = require('./module-loader');

function setup() {
  const listeners = [];
  const window = { VENOM_RENDERER: {}, CATALOG: null, KEY_USAGE: null, addEventListener: (...args) => listeners.push(args) };
  const namespace = loadRendererModules(['provider-keys'], { window });
  const keyProbe = new Map();
  const module = namespace.providerKeys.create({
    $$: () => [],
    getProviders: () => ({ alpha: provider }),
    getSettings: () => ({ liveUpdates: true }),
    getKeyDeleteArmed: () => null,
    pvCopied: new Map(), keyProbe, keyTestAct: new Map(), keyPolicy: { cooldownUntil: () => 0 },
    isKeyFullySpent: () => false, isKeyPartiallySpent: () => false, spentHint: () => '',
    escapeHtml: (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    formatAgo: () => 'just now', formatIn: () => '1m', statusPillHTML: (state) => `<span>${state}</span>`,
    actIconHTML: () => 'icon', KX_ICON: { alert: 'alert', lock: 'lock', unlock: 'unlock', test: 'test', trash: 'trash' },
    PV_ICON: { copy: 'copy' }, scheduleInterval() {}, onCatalogChanged: (fn) => listeners.push(['catalog-changed', fn]),
    getCurrentPage: () => 'providers', renderProvidersPage() {}, refreshAfterKeyChange() {},
  });
  return { module, keyProbe, listeners };
}

const provider = { id: 'alpha', name: 'Alpha', keys: [
  { id: 'key-1', name: 'Production', key: 'must-not-render-this-secret', hint: '••••abcd', active: true },
] };

test('key panel and provider row render only the saved hint and delegated key actions', () => {
  const { module } = setup();
  const panel = module.keysPanelHTML(provider);
  const rows = module.keyRowsHTML(provider);
  assert.match(panel, /Production/);
  assert.match(panel, /••••abcd/);
  assert.match(panel, /data-kx-test="alpha\|key-1"/);
  assert.match(rows, /class="pv-krow/);
  assert.match(rows, /data-kx-active="alpha\|key-1"/);
  assert.doesNotMatch(`${panel}${rows}`, /must-not-render-this-secret/);
});

test('key state prioritizes locked and switched-off keys before runtime quota state', () => {
  const { module } = setup();
  assert.equal(module.keyState({ id: 'locked', locked: true, active: true }).id, 'locked');
  assert.equal(module.keyState({ id: 'off', locked: false, active: false }).id, 'off');
});
