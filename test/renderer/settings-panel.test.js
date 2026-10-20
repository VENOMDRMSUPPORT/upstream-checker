// General settings form binding and section navigation.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererModules } = require('./module-loader');

function node(extra = {}) {
  return {
    textContent: '',
    value: '',
    checked: false,
    hidden: false,
    title: '',
    dataset: {},
    id: '',
    classList: {
      values: new Set(),
      add(v) { this.values.add(v); },
      remove(v) { this.values.delete(v); },
      toggle(v, on) {
        if (on === false) this.values.delete(v);
        else if (on === true) this.values.add(v);
        else if (this.values.has(v)) this.values.delete(v);
        else this.values.add(v);
      },
      contains(v) { return this.values.has(v); },
    },
    handlers: {},
    style: {},
    children: [],
    setAttribute(k, v) { this[k] = v; },
    addEventListener(type, fn) { this.handlers[type] = fn; },
    querySelector(sel) {
      if (sel === '.reset-btn-label') return node({ textContent: '' });
      if (sel === '.settings-nav-icon') return node({ cloneNode: () => node() });
      return null;
    },
    replaceChildren(...c) { this.children = c; },
    getBoundingClientRect() { return { top: 0 }; },
    cloneNode() { return node(); },
    ...extra,
  };
}

function setup() {
  const nodes = new Map();
  const get = (s) => {
    if (!nodes.has(s)) nodes.set(s, node());
    return nodes.get(s);
  };
  const navItems = [
    node({ dataset: { section: 'sec-appearance' } }),
    node({ dataset: { section: 'sec-speed' } }),
  ];
  navItems[1].classList.add('active');
  const sections = [
    Object.assign(node(), { id: 'sec-appearance', hidden: true }),
    Object.assign(node(), { id: 'sec-speed', hidden: false }),
  ];
  const document = {
    querySelector: (s) => {
      if (s === '.settings-nav-item.active') return navItems.find((n) => n.classList.contains('active')) || null;
      if (s.startsWith('#settings-nav .settings-nav-item[data-section=')) {
        const id = s.match(/data-section="([^"]+)"/)[1];
        return navItems.find((n) => n.dataset.section === id) || null;
      }
      return get(s);
    },
    querySelectorAll: (s) => {
      if (s === '#settings-nav .settings-nav-item') return navItems;
      if (s === '.settings-section') return sections;
      return [];
    },
  };
  const modules = loadRendererModules(['settings-panel'], {
    window: {},
    document,
    getComputedStyle: () => ({ paddingTop: '0' }),
  });
  let settings = {
    deadlineChatMs: 45000,
    lockIdleMin: 30,
    perModelBudgetMs: 12000,
    hedgeEnabled: true,
    hedgeMax: 3,
    maxTestRetries: 2,
    concurrency: 2,
    decisionThreshold: 0.7,
    maxOutputTokens: 128,
    reduceMotion: false,
    debugHeader: false,
  };
  const calls = { saves: 0, appearance: 0, tokens: [] };
  const panel = modules.settingsPanel.create({
    getSettings: () => settings,
    queueSettingsSave: () => { calls.saves++; },
    applyAppearance: () => { calls.appearance++; },
    hasResultRows: () => false,
    renderResultsTable: () => {},
    getSelectedModels: () => [{ id: 'm1' }, { id: 'm2' }],
    getAutoTestMinutes: () => 0,
    getTestPrompt: () => 'prompt',
    getExpectedAnswer: () => '4',
    escapeHtml: (s) => String(s || ''),
    showPage: () => {},
    syncRoute: () => {},
    getCurrentPage: () => 'settings',
    breadcrumbHTML: (items) => items.map((i) => i.label).join('>'),
    renderDecisionThreshold: () => {
      get('#decision-threshold-value').textContent = settings.decisionThreshold.toFixed(2);
    },
    updatePromptStats: () => {},
    updateExpectedChips: () => {},
    syncPromptPresetPills: () => {},
    syncTokenPresets: (n) => { calls.tokens.push(n); },
    renderAppearancePickers: () => {},
    refreshLogInfo: () => {},
    renderAbout: () => {},
    renderSecuritySection: () => {},
    fillCatalogSettings: () => {},
    renderCatalogSources: () => {},
    onCatalogRepaint: () => {},
  });
  return { panel, settings: () => settings, get, calls, document, navItems, sections };
}

test('settings panel module registers create', () => {
  const modules = loadRendererModules(['settings-panel'], {
    window: {},
    document: { querySelector() { return null; }, querySelectorAll() { return []; } },
    getComputedStyle: () => ({ paddingTop: '0' }),
  });
  assert.equal(typeof modules.settingsPanel.create, 'function');
});

test('fillForm converts stored milliseconds to seconds', () => {
  const { panel, get } = setup();
  panel.fillForm();
  assert.equal(get('#set-deadline-chat').value, 45);
  assert.equal(get('#prompt-input').value, 'prompt');
  assert.equal(get('#expected-input').value, '4');
});

test('bindForm ignores an empty per-model budget field', () => {
  const { panel, get, settings, calls } = setup();
  panel.bindForm();
  const el = get('#set-per-model-budget');
  el.value = '   ';
  el.handlers.input();
  assert.equal(settings().perModelBudgetMs, 12000);
  assert.equal(calls.saves, 0);
});

test('lock idle minutes are clamped to 5..480', () => {
  const { panel, get, settings, calls } = setup();
  panel.bindForm();
  const el = get('#set-lock-idle');
  el.value = '1';
  el.handlers.input();
  assert.equal(settings().lockIdleMin, 5);
  assert.equal(calls.saves, 1);
  el.value = '999';
  el.handlers.input();
  assert.equal(settings().lockIdleMin, 480);
});

test('gateway port is clamped to 1024..65535', () => {
  const { panel, get, settings } = setup();
  panel.bindForm();
  const el = get('#set-gateway-port');
  el.value = '80';
  el.handlers.input();
  assert.equal(settings().routerGatewayPort, 1024);
  el.value = '99999';
  el.handlers.input();
  assert.equal(settings().routerGatewayPort, 65535);
  el.value = '20129';
  el.handlers.input();
  assert.equal(settings().routerGatewayPort, 20129);
});

test('switchSection updates the active nav and page head', () => {
  const { panel, get, navItems, sections } = setup();
  panel.switchSection('sec-appearance');
  assert.equal(navItems[0].classList.contains('active'), true);
  assert.equal(navItems[1].classList.contains('active'), false);
  assert.equal(sections[0].hidden, false);
  assert.equal(sections[1].hidden, true);
  assert.equal(get('#settings-main-head-title').textContent, 'Appearance');
});

test('cost estimate shows the request range for multiplying sections', () => {
  const { panel, get, navItems } = setup();
  navItems.forEach((n) => n.classList.values.clear());
  navItems[1].classList.add('active'); // sec-speed
  panel.renderCostEstimate();
  const el = get('#settings-estimate');
  assert.equal(el.hidden, false);
  assert.match(el.textContent, /2 models/);
  assert.match(el.textContent, /2 to 18 requests per run/);
});
