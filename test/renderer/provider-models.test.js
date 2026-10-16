// Provider model discovery owns the per-provider roster and catalog handoff.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererModules } = require('./module-loader');

function setup({ status = 200, body = { data: [{ id: 'chat-a', context_length: 128000 }, { id: 'image-a', capabilities: ['vision'] }] } } = {}) {
  const elements = new Map();
  const get = (selector) => {
    if (!elements.has(selector)) elements.set(selector, {
      innerHTML: selector === '#btn-fetch-models' ? 'Fetch models' : '', textContent: '', disabled: false,
      value: '', handlers: {}, classList: { add() {}, remove() {} },
      addEventListener(type, fn) { this.handlers[type] = fn; },
    });
    return elements.get(selector);
  };
  const button = get('#btn-fetch-models');
  const providers = { alpha: { id: 'alpha', name: 'Alpha', baseUrl: 'https://alpha.test/v1', keys: [
    { id: 'key-a', name: 'Key A', key: 'secret', active: true },
    { id: 'key-b', name: 'Key B', key: 'secret-b', active: true },
  ] } };
  const calls = { api: [], ingest: [], statuses: [], updates: 0, activity: 0 };
  const win = { VENOM_RENDERER: {}, INTEGRATED_PROVIDERS: {}, ACTIVITY: null };
  win.electronAPI = {
    apiRequest: async (options) => { calls.api.push(options); return { status, body: JSON.stringify(body) }; },
    catalogIngest: async (id, models) => { calls.ingest.push([id, models]); return { ok: true, rows: models.map((m) => ({ ...m, score: 1 })) }; },
  };
  const ns = loadRendererModules(['provider-models'], { window: win, document: {}, console: { error() {} } });
  const unit = ns.providerModels.create({
    $: get, $$: () => [], electronAPI: win.electronAPI, getProviders: () => providers,
    getActiveProvider: () => 'alpha', integratedProviders: () => win.INTEGRATED_PROVIDERS,
    usableKeys: (p) => p.keys.filter((k) => k.active && k.key),
    setStatus: (...args) => calls.statuses.push(args), updateTestAllButton() {},
    renderCostEstimate() {}, updateStats: () => { calls.updates++; },
    classifyModel: (_, m) => m.id.startsWith('image') ? 'image' : 'chat',
    escapeHtml: (value) => String(value), kindLabels: { image: 'Image' },
    isMedia: (m) => m.kind === 'image' || m.kind === 'video', refreshActivity: () => { calls.activity++; },
  });
  return { unit, providers, calls, button, elements };
}

test('provider model discovery unions key coverage and persists the roster on its provider record', async () => {
  const { unit, providers, calls, button, elements } = setup();
  await button.handlers.click();
  const models = unit.getModels('alpha');
  assert.deepEqual(Array.from(models, (m) => m.id), ['chat-a', 'image-a']);
  assert.deepEqual(JSON.parse(JSON.stringify(models.map((m) => m.keyIds))), [['key-a', 'key-b'], ['key-a', 'key-b']]);
  assert.deepEqual([...providers.alpha.selected], ['chat-a']);
  assert.equal(calls.ingest.length, 1);
  assert.equal(calls.ingest[0][1], providers.alpha.models);
  assert.match(elements.get('#models-list').innerHTML, /chat-a/);
  assert.equal(calls.updates, 2);
  assert.equal(calls.activity, 1);
  assert.equal(button.disabled, false);
  assert.equal(button.innerHTML, 'Fetch models');
  const search = elements.get('#models-search');
  search.value = 'image';
  search.handlers.input({ target: search });
  elements.get('#btn-select-all').handlers.click();
  assert.deepEqual(Array.from(unit.getSelectedModels(), (m) => m.id), ['chat-a', 'image-a']);
  elements.get('#btn-select-none').handlers.click();
  assert.deepEqual(Array.from(unit.getSelectedModels(), (m) => m.id), ['chat-a']);
});

test('plain-provider metadata, request tagging and duplicate helpers retain their contracts', async () => {
  const { unit, calls } = setup();
  const discovered = await unit.discoverModels({ id: 'alpha', baseUrl: 'https://alpha.test/v1' }, 'secret');
  assert.equal(discovered[0].contextLabel, '128K');
  assert.equal(discovered[1].hasVision, true);
  const request = unit.taggedApiRequest('discovery', { pricingUrl: 'https://alpha.test/pricing' });
  await request({ url: 'https://alpha.test/pricing' });
  await request({ url: 'https://alpha.test/v1/models' });
  assert.equal(calls.api.at(-2).source, 'pricing');
  assert.equal(calls.api.at(-1).source, 'discovery');
  assert.equal(unit.dedupeById([{ id: 'x' }, { id: 'x' }]).length, 1);
  assert.deepEqual(Array.from(unit.tagAliasGroups([{ id: 'one/model' }, { id: 'two/model' }]), (m) => m.aliasCount), [2, 2]);
  assert.equal(calls.api.length, 3);
});

test('HTTP discovery failure leaves the provider roster intact and restores the button', async () => {
  const { unit, providers, calls, button } = setup({ status: 401, body: {} });
  providers.alpha.models = [{ id: 'kept' }];
  await button.handlers.click();
  assert.equal(JSON.stringify(unit.getModels('alpha')), JSON.stringify([{ id: 'kept' }]));
  assert.match(calls.statuses.at(-1)[1], /HTTP 401/);
  assert.equal(button.disabled, false);
});
