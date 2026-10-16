// Provider detail UI: the complete production module receives app behavior through callbacks.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererModules } = require('./module-loader');

function element() {
  return {
    innerHTML: '',
    textContent: '',
    dataset: {},
    handlers: {},
    addEventListener(type, fn) { this.handlers[type] = fn; },
  };
}

function setup() {
  const dom = new Map();
  const get = (selector) => {
    if (!dom.has(selector)) dom.set(selector, element());
    return dom.get(selector);
  };
  const calls = [];
  const buttons = {};
  const $all = (selector) => (buttons[selector] || (buttons[selector] = [element()]));
  const modules = loadRendererModules(['provider-detail'], {
    window: { VENOM_RENDERER: {} },
  });
  const active = { id: 'alpha', name: '<Alpha>', keys: [] };
  const detail = modules.providerDetail.create({
    $: get,
    $$: $all,
    getProvider: (id) => id === active.id ? active : null,
    getActiveProvider: () => active.id,
    getCurrentPage: () => 'provider',
    breadcrumbHTML: (items) => JSON.stringify(items),
    providerMark: () => 'mark',
    providerStatusHTML: () => 'health',
    renderPageHeader: (page) => calls.push(['header', page]),
    showPage: (page) => calls.push(['page', page]),
    openProviderModal: (id) => calls.push(['edit', id]),
    escapeHtml: (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    toggleKeyActive: (id) => calls.push(['toggle', id]),
    removeKey: (id) => calls.push(['remove', id]),
    copyKey: (id) => calls.push(['copy', id]),
  });
  return { active, detail, dom, buttons, calls };
}

test('header renders live provider breadcrumbs and delegates page navigation and edit', () => {
  const { detail, dom, calls } = setup();
  detail.renderHead();
  assert.match(dom.get('#pt-crumbs').innerHTML, /<Alpha>/);
  assert.equal(dom.get('#pt-health').innerHTML, 'health');
  assert.deepEqual(calls, [['header', 'provider']]);
  dom.get('.page-provider').handlers.click({ target: { closest: () => ({ dataset: { go: 'providers' } }) } });
  dom.get('#pt-edit').handlers.click();
  assert.deepEqual(calls.slice(1), [['page', 'providers'], ['edit', 'alpha']]);
});

test('key list escapes provider text and routes key actions through callbacks', () => {
  const { active, detail, dom, buttons, calls } = setup();
  active.keys = [{ id: 'key-1', name: '<Primary>', hint: '<masked>', active: true }];
  detail.renderKeys();
  assert.equal(dom.get('#pt-key-count').textContent, '1');
  assert.match(dom.get('#keys-list').innerHTML, /&lt;Primary&gt;/);
  assert.match(dom.get('#keys-list').innerHTML, /&lt;masked&gt;/);
  for (const [selector, action] of [['.key-toggle-btn', 'toggle'], ['.key-delete-btn', 'remove'], ['.key-copy-btn', 'copy']]) {
    const button = buttons[selector][0];
    button.dataset.keyId = 'key-1';
    button.handlers.click({ stopPropagation() {} });
    assert.deepEqual(calls.at(-1), [action, 'key-1']);
  }
});

test('empty key list shows the connect hint without binding stale actions', () => {
  const { detail, dom } = setup();
  detail.renderKeys();
  assert.equal(dom.get('#pt-key-count').textContent, '0');
  assert.match(dom.get('#keys-list').innerHTML, /Add a key to fetch/);
});
