const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createMockElement(tag = 'div', dataset = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    innerHTML: '',
    textContent: '',
    dataset: { ...dataset },
    hidden: false,
    handlers: {},
    attrs: {},
    classes: new Set(),
    classList: {
      add(name) { el.classes.add(name); },
      remove(name) { el.classes.delete(name); },
      toggle(name, on) { if (on) el.classes.add(name); else el.classes.delete(name); },
      contains(name) { return el.classes.has(name); },
    },
    addEventListener(type, fn) {
      if (!el.handlers[type]) el.handlers[type] = [];
      el.handlers[type].push(fn);
    },
    setAttribute(name, val) { el.attrs[name] = String(val); },
    getAttribute(name) { return el.attrs[name] ?? null; },
    focus() {},
    click() {
      if (el.handlers.click) {
        el.handlers.click.forEach((fn) => fn({
          target: el,
          stopPropagation() {},
          preventDefault() {},
          closest: (sel) => el.closest(sel),
        }));
      }
    },
    closest(sel) {
      if (!sel) return null;
      if (sel.startsWith('.') && el.classes.has(sel.slice(1))) return el;
      if (sel.startsWith('#') && el.id === sel.slice(1)) return el;
      if (sel.startsWith('[data-ac-provider]') && el.dataset.acProvider) return el;
      if (sel.startsWith('[data-ac-copy]') && el.dataset.acCopy) return el;
      if (sel.startsWith('[data-ac-mark-single]') && el.dataset.acMarkSingle) return el;
      return null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  return el;
}

function setupContext({ eventsReply = { rows: [], unread: 0, counts: null, totals: null }, isCompact = false } = {}) {
  const domElements = new Map();
  const getEl = (id) => {
    if (!domElements.has(id)) {
      const el = createMockElement('div');
      el.id = id;
      domElements.set(id, el);
    }
    return domElements.get(id);
  };

  const document = {
    getElementById(id) { return getEl(id); },
    querySelector(sel) {
      if (sel.startsWith('#')) return getEl(sel.slice(1));
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener() {},
  };

  const PROVIDERS = {
    openai: { id: 'openai', name: 'OpenAI', logo: 'openai.svg', color: '#10a37f', baseUrl: 'https://api.openai.com/v1' },
    anthropic: { id: 'anthropic', name: 'Anthropic', logo: 'anthropic.svg', color: '#d97706', baseUrl: 'https://api.anthropic.com' },
  };

  const CATALOG = {
    state: {
      models: new Map([
        ['openai::gpt-4o', { id: 'gpt-4o', name: 'GPT-4o', context_tokens: 128000, score: 92, pricing: { input: 2.5, output: 10 } }],
      ]),
    },
    openDetails() {},
  };

  const win = {
    PROVIDERS,
    CATALOG,
    matchMedia: () => ({ matches: isCompact, addEventListener() {} }),
    PROFILE_BADGES: { badgeFor: () => '<span class="badge">PRO</span>' },
    escapeHtml: (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    formatAgo: () => '10m ago',
    providerMark: (p) => `<img src="${p.logo}">`,
    statCardsHTML: () => '<div class="kpis"></div>',
    dataToolbarHTML: () => '<div class="dt-toolbar"><div class="dt-right"><div class="dt-actions"></div></div></div>',
    bindDataToolbar: () => {},
    syncDataToolbar: () => {},
    breadcrumbHTML: () => '',
    showPage: () => {},
    openProviderPage: () => {},
    markCopied: () => {},
    electronAPI: {
      catalogEvents: async () => eventsReply,
      catalogEventsRead: async () => ({ ok: true, marked: 1, unread: 0 }),
    },
  };

  const ctx = vm.createContext({
    window: win,
    document,
    PROVIDERS,
    escapeHtml: win.escapeHtml,
    formatAgo: win.formatAgo,
    providerMark: win.providerMark,
    statCardsHTML: win.statCardsHTML,
    dataToolbarHTML: win.dataToolbarHTML,
    bindDataToolbar: win.bindDataToolbar,
    syncDataToolbar: win.syncDataToolbar,
    breadcrumbHTML: win.breadcrumbHTML,
    showPage: win.showPage,
    openProviderPage: win.openProviderPage,
    markCopied: win.markCopied,
    Date,
    Number,
    String,
    Boolean,
    console,
    setTimeout,
    clearTimeout,
  });

  const file = path.join(__dirname, '../../src/renderer/activity.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });

  return { ctx, win, getEl };
}

test('activity module initializes and exports window.ACTIVITY', () => {
  const { win } = setupContext();
  assert.ok(win.ACTIVITY, 'window.ACTIVITY is defined');
  assert.equal(typeof win.ACTIVITY.init, 'function');
  assert.equal(typeof win.ACTIVITY.render, 'function');
  assert.equal(typeof win.ACTIVITY.refreshBell, 'function');
  assert.equal(typeof win.ACTIVITY.renderIfShown, 'function');
  assert.ok(win.ACTIVITY.state, 'state is exposed');
});

test('render() in table mode outputs a table with index/id, state row styling, no indicator dot, and mark-read action', async () => {
  const fakeEvents = {
    ok: true,
    rows: [
      { id: 101, provider_id: 'openai', model_id: 'gpt-4o', name: 'GPT-4o', kind: 'added', at: 1700000000000, is_read: false },
      { id: 102, provider_id: 'anthropic', model_id: 'claude-2', name: 'Claude 2', kind: 'removed', at: 1690000000000, is_read: true },
    ],
    unread: 1,
    counts: { added: 1, removed: 1, total: 2 },
    totals: { added: 1, removed: 1, total: 2 },
  };

  const { win, getEl } = setupContext({ eventsReply: fakeEvents, isCompact: false });
  getEl('ac-crumbs');
  getEl('ac-crumbs-actions');
  getEl('ac-body');
  getEl('ac-results');

  await win.ACTIVITY.render();

  const results = getEl('ac-results');
  // 1. Table structure and # column
  assert.ok(results.innerHTML.includes('<table class="dt-table ac-table">'), 'renders dt-table ac-table');
  assert.ok(results.innerHTML.includes('col-ac-idx'), 'contains index/ID column header');
  assert.ok(results.innerHTML.includes('ac-idx-num'), 'displays sequential row index number');
  assert.ok(results.innerHTML.includes('#101'), 'displays event id in row');

  // 2. Row state color tinting
  assert.ok(results.innerHTML.includes('is-added'), 'added row has is-added class');
  assert.ok(results.innerHTML.includes('is-removed'), 'removed row has is-removed class');

  // 3. No green lamp / unread indicator dot in change column
  assert.ok(!results.innerHTML.includes('ac-unread-indicator'), 'no unread dot in change column');

  // 4. Actions column: Mark read button for unread row, Read status for read row
  assert.ok(results.innerHTML.includes('ac-btn-mark-read'), 'contains mark read button for unread row');
  assert.ok(results.innerHTML.includes('ac-read-done'), 'contains read status indicator for read row');
  assert.ok(!results.innerHTML.includes('data-ac-open-catalog'), 'catalog button removed from actions');

  // 5. Provider details & model
  assert.ok(results.innerHTML.includes('OpenAI'), 'displays provider name');
  assert.ok(results.innerHTML.includes('openai.svg'), 'displays provider logo mark');
  assert.ok(results.innerHTML.includes('GPT-4o'), 'displays model name');

  // 6. Top action: mark all as read moved to right of breadcrumb
  const topActions = getEl('ac-crumbs-actions');
  assert.ok(topActions.innerHTML.includes('ac-top-mark-read'), 'mark all as read rendered in crumbs-actions');
  assert.ok(topActions.innerHTML.includes('Mark all as read'), 'button label is present');
});

test('render() in compact layout automatically switches to cards mode with state styling', async () => {
  const fakeEvents = {
    ok: true,
    rows: [
      { id: 201, provider_id: 'openai', model_id: 'gpt-4o', name: 'GPT-4o', kind: 'added', at: 1700000000000, is_read: false },
      { id: 202, provider_id: 'openai', model_id: 'gpt-3.5', name: 'GPT-3.5', kind: 'removed', at: 1690000000000, is_read: true },
    ],
    unread: 1,
    counts: { added: 1, removed: 1, total: 2 },
    totals: { added: 1, removed: 1, total: 2 },
  };

  const { win, getEl } = setupContext({ eventsReply: fakeEvents, isCompact: true });
  getEl('ac-crumbs');
  getEl('ac-crumbs-actions');
  getEl('ac-body');
  getEl('ac-results');

  await win.ACTIVITY.render();

  const results = getEl('ac-results');
  assert.ok(results.innerHTML.includes('pv-grid ac-grid'), 'renders pv-grid ac-grid');
  assert.ok(results.innerHTML.includes('pv-card ac-card'), 'renders pv-card ac-card');
  assert.ok(results.innerHTML.includes('is-added'), 'card has is-added class');
  assert.ok(results.innerHTML.includes('is-removed'), 'card has is-removed class');
  assert.ok(results.innerHTML.includes('ac-btn-mark-read'), 'card has mark read button for unread');
  assert.ok(results.innerHTML.includes('OpenAI'), 'card displays provider name');
  assert.ok(results.innerHTML.includes('openai.svg'), 'card displays provider logo');
});
