// Venom Profiles page: the complete production module against a fake DOM
// and a fake bridge. No secrets cross, and every dynamic string is escaped.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererModules } = require('./module-loader');

function element() {
  return {
    innerHTML: '',
    textContent: '',
    dataset: {},
    handlers: {},
    value: '',
    hidden: false,
    classList: { add() {}, remove() {} },
    addEventListener(type, fn) { this.handlers[type] = fn; },
    focus() {},
    setSelectionRange() {},
    getAttribute() { return ''; },
  };
}

const PROFILES_REPLY = {
  ok: true,
  gateway: { listening: true, port: 28228 },
  fleet: { active: 6, total: 7, disabled: 1, liveKeys: 3, cooldowns: 1 },
  pools: { total: 7, scored: 7, unscored: 0 },
  pool: { keys: 3, cooldowns: [] },
  profiles: {
    lite: { name: 'venom-lite', count: 2, eligible: [
      { providerId: 'groq', modelId: 'llama-flash', score: 30, scoreSource: 'aa', tools: true, costInPerM: 0, activeKeys: 1 },
      { providerId: 'groq', modelId: 'mystery-free', score: 12, scoreSource: 'est-heuristic', tools: false, costInPerM: 0, activeKeys: 1 },
    ] },
    pro: { name: 'venom-pro', count: 1, eligible: [
      { providerId: 'anthropic', modelId: 'claude-sonnet', score: 62, scoreSource: 'aa', tools: true, costInPerM: 3, activeKeys: 2 },
    ],
    efficient: [{ providerId: 'anthropic', modelId: 'claude-sonnet', score: 62 }],
    capable: [] },
    max: { name: 'venom-max', count: 1, eligible: [
      { providerId: 'openai', modelId: 'gpt-frontier', score: 88, scoreSource: 'aa', tools: true, costInPerM: 20, activeKeys: 1 },
    ] },
  },
};

function setup({ profiles = PROFILES_REPLY, logs = { rows: [] }, status = null } = {}) {
  const dom = new Map();
  const calls = [];
  const document = {
    getElementById: (id) => {
      if (!dom.has(id)) dom.set(id, element());
      return dom.get(id);
    },
    querySelectorAll: () => [],
    activeElement: null,
  };
  const win = {
    VENOM_RENDERER: {},
    PROFILE_BADGES: { warm: async () => null },
    electronAPI: {
      routerProfiles: async () => { calls.push('profiles'); return profiles; },
      routerStatus: async () => { calls.push('status'); return status || { ok: false, message: 'no status' }; },
      routerRefresh: async () => { calls.push('refresh'); return { ok: true }; },
      logsList: async () => { calls.push('logs'); return logs; },
    },
  };
  loadRendererModules(['router-status'], {
    window: win,
    document,
    escapeHtml: (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    breadcrumbHTML: (items) => items.map((i) => i.label).join(' / '),
    statCardsHTML: (cards) => cards.map((c) => `[${c.label}=${c.value} ${c.pill || ''}]`).join(' '),
  });
  return { win, dom, calls, document };
}

test('profiles page renders policy cards, search, dossiers and targets without secrets', async () => {
  const { win, dom } = setup();
  await win.ROUTER.render();
  const body = dom.get('rt-body').innerHTML;
  for (const label of ['LITE POLICY', 'PRO POLICY', 'MAX POLICY', 'FLEET TARGETS']) {
    assert.match(body, new RegExp(label), `policy card ${label} renders`);
  }
  assert.match(body, /2 Eligible/, 'lite count matches its list');
  assert.match(body, /6\/7/, 'fleet shows active/total');
  assert.match(body, /Listening · 127\.0\.0\.1:28228/, 'gateway badge keeps the address on the page');
  assert.match(body, /Search targets across all profiles/, 'cross-profile search renders');
  for (const pill of ['Venom Lite', 'Venom Pro', 'Venom Max']) {
    assert.match(body, new RegExp(pill), `dossier ${pill} renders`);
  }
  assert.match(body, /SELECTION ORDER/, 'waterfall renders');
  assert.match(body, /ELIGIBLE TARGETS/, 'target list renders');
  assert.match(body, /llama-flash/, 'eligible model rows render');
  assert.match(body, /VQ 30/, 'scores render beside targets');
  assert.match(body, /MEASURED OUTCOMES/, 'outcomes box renders');
  assert.match(body, /Insufficient evidence/, 'empty log reads as insufficient, never a rate');
  assert.ok(!body.includes('sk-'), 'no key material in the page');
  assert.match(dom.get('rt-crumbs').innerHTML, /Venom Profiles/);
});

test('typing in search updates the query state for live filtering', async () => {
  const { win, dom } = setup();
  await win.ROUTER.render();
  const input = dom.get('vp-search');
  assert.ok(input, 'search input exists');
  input.value = 'flash';
  input.handlers.input();
  assert.equal(win.ROUTER.state.query, 'flash');
});

test('measured outcomes compute from routed log rows only', async () => {
  const rows = [];
  for (let i = 0; i < 5; i += 1) {
    rows.push({ model_requested: 'llama-flash', provider_id: 'groq', source: 'venom-router',
      status: 'ok', attempt: 1, is_hedge: 0, latency_ms: 1200 + i * 100, error_message: null });
  }
  rows.push({ model_requested: 'llama-flash', provider_id: 'groq', source: 'venom-router',
    status: 'error', attempt: 2, is_hedge: 0, latency_ms: 900, error_message: 'upstream answered 500' });
  const { win, dom } = setup({ logs: { rows, nextCursor: null } });
  await win.ROUTER.render();
  const body = dom.get('rt-body').innerHTML;
  assert.match(body, /FIRST-TARGET SUCCESS/, 'success card renders');
  assert.match(body, /100%/, 'five first attempts all ok reads 100%');
  assert.match(body, /FAILOVER RATE/, 'failover card renders');
  assert.match(body, /No eligible target/, 'no-route line renders');
  assert.match(body, /<strong>0<\/strong>/, 'empty no-route counter renders');
});

test('dossiers share one data-profile component with per-column search and count badges', async () => {
  const { win, dom } = setup();
  await win.ROUTER.render();
  const body = dom.get('rt-body').innerHTML;
  for (const key of ['lite', 'pro', 'max']) {
    assert.match(body, new RegExp(`data-profile="${key}"`), `${key} column carries the shared hook`);
  }
  assert.match(body, /Search models or providers\.\.\./, 'per-column filter renders');
  assert.match(body, /All \(2\)/, 'all-count badge renders');
  assert.match(body, /Eligible \(2\)/, 'eligible-count badge renders');
  assert.match(body, /vp-dossier-head/, 'pill head opts out of the shared accent bar');
});

test('targets show the display name, provider pill, VQ keys line and exclude toggle', async () => {
  const withNames = structuredClone(PROFILES_REPLY);
  withNames.profiles.pro.eligible[0].displayName = 'Sonnet Clean';
  const { win, dom } = setup({ profiles: withNames });
  await win.ROUTER.render();
  const body = dom.get('rt-body').innerHTML;
  assert.match(body, /Sonnet Clean/, 'display name renders instead of the raw id');
  assert.match(body, /vp-provider-pill/, 'provider pill renders beside the name');
  assert.match(body, /VQ 62 · 2 keys/, 'VQ score and key count share one line');
  assert.match(body, /vp-exclude/, 'per-model exclude toggle renders');
  assert.match(body, /data-profile-search="pro"/, 'column search is scoped per profile');
});

test('outcome labels sit above their values', async () => {
  const { win, dom } = setup();
  await win.ROUTER.render();
  const body = dom.get('rt-body').innerHTML;
  const labelAt = body.indexOf('FIRST-TARGET SUCCESS');
  const dashAt = body.indexOf('vp-outcome-num">—');
  assert.ok(labelAt > 0 && dashAt > labelAt, 'the label renders before its value');
});

test('dynamic strings are escaped', async () => {
  const evil = structuredClone(PROFILES_REPLY);
  evil.profiles.lite.eligible[0].modelId = '<img src=x>';
  const { win, dom } = setup({ profiles: evil });
  await win.ROUTER.render();
  assert.match(dom.get('rt-body').innerHTML, /&lt;img src=x&gt;/);
});

test('refresh button re-queries main and re-renders', async () => {
  const { win, dom, calls } = setup();
  await win.ROUTER.render();
  assert.ok(calls.includes('refresh') && calls.includes('profiles'));
  const before = calls.length;
  await dom.get('rt-refresh').handlers.click();
  assert.ok(calls.length > before, 'refresh re-queries');
  assert.deepEqual(calls.slice(before, before + 2), ['refresh', 'profiles']);
});

test('a refused profiles payload falls back to status counts, never a throw', async () => {
  const { win, dom } = setup({
    profiles: { ok: false, code: 'NOPE', message: 'denied' },
    status: { ok: true, gateway: true, port: 28228,
      pools: { total: 9, scored: 7, unscored: 2 },
      tiers: { lite: 4, proEfficient: 5, proCapable: 3, max: 2 },
      pool: { keys: 3, cooldowns: [] } },
  });
  await win.ROUTER.render();
  assert.match(dom.get('rt-body').innerHTML, /4 Eligible/);
});

test('old main without the profiles channel falls back to status counts', async () => {
  const dom = new Map();
  const document = {
    getElementById: (id) => {
      if (!dom.has(id)) dom.set(id, element());
      return dom.get(id);
    },
    querySelectorAll: () => [],
    activeElement: null,
  };
  const win = {
    VENOM_RENDERER: {},
    PROFILE_BADGES: { warm: async () => null },
    electronAPI: {
      routerProfiles: async () => { throw new Error("Error invoking remote method 'router:profiles': Error: No handler registered for 'router:profiles'"); },
      routerStatus: async () => ({ ok: true, gateway: false, port: 28228,
        pools: { total: 9, scored: 7, unscored: 2 },
        tiers: { lite: 4, proEfficient: 5, proCapable: 3, max: 2 },
        pool: { keys: 3, cooldowns: [] } }),
      routerRefresh: async () => ({ ok: true }),
      logsList: async () => ({ rows: [] }),
    },
  };
  loadRendererModules(['router-status'], { window: win, document,
    escapeHtml: (v) => String(v),
    breadcrumbHTML: (items) => items.map((i) => i.label).join(' / '),
    statCardsHTML: (cards) => cards.map((c) => `[${c.label}=${c.value}]`).join(' ') });
  await win.ROUTER.render();
  assert.match(dom.get('rt-body').innerHTML, /4 Eligible/);
});

test('no bridge reads as unavailable, never a throw', async () => {
  const dom = new Map();
  const document = { getElementById: (id) => {
    if (!dom.has(id)) dom.set(id, element());
    return dom.get(id);
  },
  querySelectorAll: () => [],
  activeElement: null };
  const win = { VENOM_RENDERER: {} };
  loadRendererModules(['router-status'], { window: win, document,
    escapeHtml: (v) => String(v),
    breadcrumbHTML: () => '', statCardsHTML: () => '' });
  await win.ROUTER.render();
  assert.match(dom.get('rt-body').innerHTML, /unavailable/);
});
