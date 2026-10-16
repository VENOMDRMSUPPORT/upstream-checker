// App shell page lifecycle and Overview summary.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererModules } = require('./module-loader');

function node(dataset = {}) {
  return {
    dataset, hidden: false, textContent: '', innerHTML: '', title: '', attrs: {}, classes: new Set(),
    classList: {
      toggle(name, on) { if (on) this.owner.classes.add(name); else this.owner.classes.delete(name); },
    },
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
    replaceChildren() {},
  };
}

function setup() {
  const nodes = new Map();
  const get = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, node());
    const result = nodes.get(selector);
    result.classList.owner = result;
    return result;
  };
  const pages = ['overview', 'providers', 'provider'].map((page) => node({ page }));
  const nav = ['overview', 'providers'].map((page) => node({ page }));
  [...pages, ...nav].forEach((item) => { item.classList.owner = item; });
  const selectors = {
    '.shell-page': pages,
    '.shell-nav-item[data-page]': nav,
  };
  const document = {
    title: '',
    querySelector: (selector) => selector.includes('.shell-nav-icon') ? null : get(selector),
    querySelectorAll: (selector) => selectors[selector] || [],
    getElementById: (id) => get(`#${id}`),
  };
  const route = { page: 'overview' };
  const calls = [];
  const providers = { alpha: { name: 'Alpha' }, beta: { name: 'Beta' } };
  const health = new Map([['alpha', { state: 'ok' }], ['beta', { state: 'fail' }]]);
  const history = new Map([['alpha::model', [{ at: Date.now() - 60000 }]]]);
  const runLog = [{ providerName: 'Alpha', at: Date.now(), passed: 2, total: 3 }];
  const window = { VENOM_RENDERER: {}, CATALOG: null, ACTIVITY: null, DATABASE: null, LOGS: null,
    matchMedia: () => ({ addEventListener() {} }) };
  const namespace = loadRendererModules(['shell'], { window, document, navigator: { onLine: true } });
  const router = {
    isPage: (page) => ['overview', 'providers', 'provider', 'settings', 'history', 'monitor'].includes(page),
    setCurrentPage(page) { route.page = page; },
  };
  const shell = namespace.shell.create({
    $: get, $$: (selector) => selectors[selector] || [], pageRouter: router,
    pageMeta: { overview: { title: 'Overview', desc: 'Home' }, providers: { title: 'Providers', desc: 'Providers' }, provider: { title: 'Provider', desc: 'Provider' } },
    getProviders: () => providers, getActiveProvider: () => 'alpha', getRunHistory: () => history,
    getRunLog: () => runLog, getProviderHealth: () => health, getCurrentPage: () => route.page,
    renderProviderHead: () => calls.push('provider-head'), resetProviderPage: () => calls.push('provider-reset'),
    renderProfilePage() {}, prepareSettingsPage() {}, providerRoster: { resetForEntry: () => calls.push('providers-reset') },
    syncRoute: () => calls.push('sync-route'), toggleTheme() {}, switchSettingsSection() {}, escapeHtml: (s) => String(s),
  });
  return { shell, nodes, pages, nav, calls, route, window };
}

test('page lifecycle updates visibility, current page, page-specific content and route', () => {
  const { shell, pages, nav, calls, route } = setup();
  shell.showPage('providers');
  assert.equal(route.page, 'providers');
  assert.deepEqual(pages.map((page) => page.hidden), [true, false, true]);
  assert.deepEqual(nav.map((item) => item.classes.has('active')), [false, true]);
  assert.deepEqual(calls, ['providers-reset', 'sync-route']);
});

test('Overview stats and health lamp summarize live getters', () => {
  const { shell, nodes } = setup();
  shell.renderQuickStats();
  assert.equal(nodes.get('#stat-providers').textContent, 2);
  assert.equal(nodes.get('#stat-models').textContent, 1);
  assert.equal(nodes.get('#ov-online').textContent, '1/2');
  assert.equal(nodes.get('#shell-status').dataset.state, 'fail');
  assert.match(nodes.get('#shell-status').title, /Beta is unreachable/);
  assert.match(nodes.get('#ov-trend').innerHTML, /ov-trend-bars/);
  assert.match(nodes.get('#ov-activity').innerHTML, /Alpha/);
});
