// Connected and integrated provider page state and rendering.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererModules } = require('./module-loader');

function element(dataset = {}) {
  return {
    innerHTML: '', textContent: '', dataset, hidden: false, handlers: {}, attrs: {}, classes: new Set(),
    classList: {
      toggle(name, on) { if (on) this.owner.classes.add(name); else this.owner.classes.delete(name); },
      add(name) { this.owner.classes.add(name); },
      remove(name) { this.owner.classes.delete(name); },
    },
    addEventListener(type, fn) { this.handlers[type] = fn; },
    setAttribute(name, value) { this.attrs[name] = value; },
    focus() {},
    closest() { return null; },
  };
}

function setup({ matches = false } = {}) {
  const nodes = new Map();
  const get = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, element());
    const node = nodes.get(selector);
    node.classList.owner = node;
    return node;
  };
  const providerPage = get('.page-providers');
  const tabs = [element({ tab: 'connected' }), element({ tab: 'integrated' })];
  tabs.forEach((tab) => { tab.classList.owner = tab; });
  const events = {};
  const document = {
    querySelector: get,
    querySelectorAll: (selector) => selector === '.pv-tab' ? tabs : [],
    getElementById: (id) => get(`#${id}`),
    addEventListener(type, fn) { events[type] = fn; },
    activeElement: { tagName: 'BODY' },
  };
  const viewport = { matches, addEventListener(type, fn) { events[`media:${type}`] = fn; } };
  const providers = {
    alpha: { id: 'alpha', name: 'Alpha', baseUrl: 'https://alpha.test', keys: [{ id: 'key-a', active: true }] },
    beta: { id: 'beta', name: 'Beta', baseUrl: 'https://beta.test', keys: [] },
  };
  const actions = [];
  const win = { VENOM_RENDERER: {}, matchMedia: () => viewport, electronAPI: { openExternal() {} }, CATALOG: null };
  const namespace = loadRendererModules(['provider-roster'], {
    window: win, document, localStorage: { setItem() {} }, navigator: { clipboard: { writeText: async () => {} } },
  });
  const roster = namespace.providerRoster.create({
    $: get, $$: (selector) => selector === '.pv-tab' ? tabs : [], compactLayout: viewport,
    getProviders: () => providers,
    getRunLog: () => [], getCurrentPage: () => 'providers',
    isConnected: (p) => p.keys.length > 0,
    usableKeys: (p) => p.keys.filter((k) => k.active),
    providerHealthLine: () => ({ state: 'ok' }), providerStats: () => ({ rate: 1 }),
    providerAuthKinds: () => ['apikey'], providerAuthGroup: () => 'apikey',
    providerDisplayModelsCount: () => 2, providerHost: (p) => p.baseUrl,
    providerLegendHTML: () => 'Legend', groupHeadHTML: (kind) => `Group:${kind}`,
    providerCardHTML: (p) => `Card:${p.id}`, providerRowsHTML: (groups) => groups.map((g) => g.items.map((p) => p.id).join(',')).join('|'),
    dataToolbarHTML: () => 'Toolbar', bindDataToolbar() {}, statCardsHTML: (cards) => cards.map((x) => x.label).join('|'),
    noMatchIcon: 'empty', emptyIcon: 'empty', plugIcon: 'plug', authGroups: ['oauth', 'apikey'],
    breadcrumbHTML: (items) => items.map((x) => x.label).join('/'), closeRateLimitPop() {},
    toggleExpanded: (id) => actions.push(['toggle', id]), clearExpanded: () => actions.push(['clear-expanded']),
    setLegendCollapsed: (value) => actions.push(['legend', value]), getLegendCollapsed: () => true,
    testKey() {}, setKeyActive() {}, deleteKey() {}, getKey: () => null, markCopied() {}, setStatus() {},
    showPage: (page) => actions.push(['page', page]), switchProvider() {}, openAddKeyModal() {},
    openProviderPage() {}, recheckProvider() {},
  });
  return { roster, nodes, tabs, actions, events, providerPage };
}

test('connected roster renders counts, stats and provider rows from live getters', () => {
  const { roster, nodes, tabs } = setup();
  roster.render();
  assert.equal(nodes.get('#pv-count-connected').textContent, 1);
  assert.equal(nodes.get('#pv-count-integrated').textContent, 2);
  assert.equal(nodes.get('#pv-kpis').innerHTML, 'Connected|Active keys|Reachable|Pass rate');
  assert.equal(nodes.get('#pv-results').innerHTML, 'alpha');
  assert.equal(tabs[0].attrs['aria-selected'], 'true');
  assert.equal(tabs[1].attrs['aria-selected'], 'false');
});

test('switching tabs uses the integrated providers cards and page-entry resets to connected', async () => {
  const { roster, nodes, providerPage, actions } = setup({ matches: true });
  roster.resetForEntry();
  assert.equal(roster.getTab(), 'connected');
  assert.deepEqual(actions.filter(([name]) => name === 'legend'), [['legend', true]]);
  providerPage.handlers.click({ target: { closest: (selector) => selector.startsWith('[data-tab]') ? { dataset: { tab: 'integrated' } } : null } });
  assert.equal(roster.getTab(), 'integrated');
  assert.match(nodes.get('#pv-body').innerHTML, /Card:alpha/);
  assert.match(nodes.get('#pv-body').innerHTML, /Card:beta/);
});
