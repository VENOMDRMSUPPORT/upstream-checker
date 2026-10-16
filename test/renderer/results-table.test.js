// Results table sort/filter/export through the production factory.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererModules } = require('./module-loader');

function node(extra = {}) {
  return {
    textContent: '',
    innerHTML: '',
    style: { display: '' },
    dataset: {},
    className: '',
    classList: {
      values: new Set(),
      add(v) { this.values.add(v); },
      remove(v) { this.values.delete(v); },
      toggle(v, on) { if (on) this.values.add(v); else this.values.delete(v); },
    },
    handlers: {},
    children: [],
    setAttribute(k, v) { this[k] = v; },
    addEventListener(type, fn) { this.handlers[type] = fn; },
    closest() { return null; },
    querySelector() { return null; },
    ...extra,
  };
}

function setup(overrides = {}) {
  const nodes = new Map();
  const get = (s) => {
    if (!nodes.has(s)) nodes.set(s, node(s === '#results-body' ? { children: [], appendChild(ch) { this.children.push(ch); } } : {}));
    return nodes.get(s);
  };
  const document = {
    querySelector: get,
    querySelectorAll: (s) => {
      if (s === '#results-table th') return [get('#results-table th')];
      if (s === '#results-body tr') return get('#results-body').children;
      return [];
    },
    createElement: () => node({ click() {}, href: '', download: '' }),
  };
  const window = {
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    Blob: function Blob(parts, opts) { this.parts = parts; this.type = opts && opts.type; },
  };
  const modules = loadRendererModules(['results-table'], { window, document, navigator: { clipboard: { writeText() {} } } });
  const calls = { stats: 0, status: [], downloads: [] };
  const settings = { timeGoodMs: 1000, timeOkMs: 3000, sparkRuns: 5 };
  const table = modules.results.create({
    getSettings: () => settings,
    escapeHtml: (s) => String(s || '').replace(/</g, '&lt;'),
    NA: '—',
    RESPONSE_PREVIEW: 160,
    buildRowHtml: (model, result) => `<td>${model.id}:${result.status}</td>`,
    contextOf: () => 8000,
    scoreOf: () => 50,
    costOf: () => ({ in: 1, out: 2 }),
    latencyOf: () => 100,
    uptimeOf: () => 1,
    isCorrect: (result) => result.status === 'pass',
    updateStats: () => { calls.stats++; },
    setStatus: (kind, text) => calls.status.push({ kind, text }),
    getTestResults: () => overrides.testResults || [],
    setTestResults: (rows) => { overrides.testResults = rows; },
    clearRunState: () => { overrides.runCleared = true; },
    getActiveProviderMeta: () => ({ name: 'Demo Provider' }),
    downloadFile: (content, filename, mime) => calls.downloads.push({ content, filename, mime }),
    ...overrides.deps,
  });
  table.bind();
  return { table, get, nodes, calls, settings, overrides, document, window };
}

test('results module registers a create factory', () => {
  const modules = loadRendererModules(['results-table'], {
    window: {},
    document: { querySelector() { return null; }, querySelectorAll() { return []; }, createElement() { return {}; } },
  });
  assert.equal(typeof modules.results.create, 'function');
});

test('sort sinks null times and toggles failed-only filter', () => {
  const { table, get } = setup();
  table.init();
  const pass = { id: 'a' };
  const fail = { id: 'b' };
  table.addRow(pass, { status: 'pass', time: 2000, isEmpty: false, response: 'ok' });
  table.addRow(fail, { status: 'fail', time: null, isEmpty: false, response: 'err' });
  assert.equal(table.hasRows(), true);
  assert.equal(get('#results-body').children.length, 2);

  // Activate time sort via thead handler with a fake th.
  const th = node({ dataset: { sort: 'time' }, classList: { values: new Set(), add(v) { this.values.add(v); }, remove() {} } });
  get('#results-table thead').handlers.click({ target: { closest: () => th } });
  table.render();
  const ids = get('#results-body').innerHTML.match(/data-model-id="([^"]+)"/g);
  assert.ok(ids);
  assert.match(ids[0], /a/);

  table.toggleFailedFilter();
  assert.equal(table.isFailedFilterActive(), true);
  assert.match(get('#results-body').innerHTML, /data-model-id="b"/);
  assert.equal(get('#results-body').innerHTML.includes('data-model-id="a"'), false);
});

test('clear restores empty DOM and notifies status', () => {
  const { table, get, calls, overrides } = setup({ testResults: [{ model: 'a', status: 'pass' }] });
  table.init();
  table.addRow({ id: 'a' }, { status: 'pass', time: 1, response: 'x' });
  table.clear();
  assert.equal(table.hasRows(), false);
  assert.equal(get('#results-empty').style.display, '');
  assert.equal(get('#results-table').style.display, 'none');
  assert.equal((overrides.testResults || []).length, 0);
  assert.equal(overrides.runCleared, true);
  assert.deepEqual(calls.status.at(-1), { kind: 'idle', text: 'Ready' });
});

test('CSV export uses provider slug and includes status', () => {
  const { table, calls } = setup({
    testResults: [{ model: 'm1', provider: 'Demo', group: '', status: 'pass', time: 10, tokens: 3, completionTokens: 2, attempts: 1, response: '4' }],
  });
  getBtnClick(table, '#btn-export-csv');
  assert.equal(calls.downloads.length, 1);
  assert.match(calls.downloads[0].filename, /^venom-router-demo-provider-\d{4}-\d{2}-\d{2}-\d{4}\.csv$/);
  assert.match(calls.downloads[0].content, /Model,Provider/);
  assert.match(calls.downloads[0].content, /m1/);
  assert.match(calls.downloads[0].mime, /csv/);
});

test('tokensPerSecond ignores prompt tokens and non-pass rows', () => {
  const { table } = setup();
  assert.equal(table.tokensPerSecond({ status: 'pass', isEmpty: false, completionTokens: 100, time: 2000 }), 50);
  assert.equal(table.tokensPerSecond({ status: 'fail', completionTokens: 100, time: 2000 }), null);
  assert.equal(table.tokensPerSecond({ status: 'pass', isEmpty: true, completionTokens: 100, time: 2000 }), null);
});

function getBtnClick(table, sel) {
  // Re-bind is already done; invoke the stored listener by synthesizing through document query in bind.
  // The factory attaches listeners at bind(); call the export path directly if needed.
  if (sel === '#btn-export-csv') table.exportCsv();
  if (sel === '#btn-export-json') table.exportJson();
}
