'use strict';

// Venom Profiles: tier differentiation, heuristic scoring, lead-analyst
// synthesis and true SSE passthrough. Pure Node, no Electron, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateModelCapabilities,
  buildSmartCatalog,
  buildProfilesPayload,
  KeyPoolManager,
  VenomCascadeEngine,
  pipeUpstreamStream,
} = require('../../src/router');

function row(id, providerId, modelId, fields = {}) {
  return { id, provider_id: providerId, model_id: modelId, ...fields };
}

const KEYS = [
  { id: 'free-1', providerId: 'groq', tier: 'free' },
  { id: 'sub-1', providerId: 'anthropic', tier: 'subscription' },
  { id: 'paid-1', providerId: 'anthropic', tier: 'paid' },
  { id: 'paid-2', providerId: 'openai', tier: 'paid' },
  { id: 'paid-3', providerId: 'deepseek', tier: 'paid' },
  { id: 'paid-4', providerId: 'xiaomi', tier: 'paid' },
  { id: 'paid-5', providerId: 'stability', tier: 'paid' },
];

// Realistic VQ scale: the Artificial Analysis intelligence index tops out near
// 57.6 here (claude-opus-5.5), so tier boundaries must live on that scale.
function mixedRows() {
  return [
    row('f1', 'groq', 'llama-flash', { score: 32, score_source: 'aa', cost_in_per_m: 0, cost_kind: 'free', tools: true }),
    row('f2', 'groq', 'mystery-free', { score: null, score_source: null, cost_in_per_m: 0, cost_kind: 'free' }),
    row('f3', 'groq', 'cat-jam', { score: 41, score_source: 'aa', cost_in_per_m: 0, cost_kind: 'free', kind: 'audio', output_modalities: 'audio' }),
    row('e1', 'deepseek', 'deepseek-v4.1-flash', { score: 39.5, score_source: 'aa', cost_in_per_m: 0.3, tools: true }),
    row('e2', 'xiaomi', 'mimo-v2.6-flash', { score: 37.9, score_source: 'aa', cost_in_per_m: 0.4, tools: true }),
    row('e3', 'deepseek', 'deepseek-v4-pro', { score: 36, score_source: 'aa', cost_in_per_m: 1.2, tools: true }),
    row('p1', 'anthropic', 'claude-haiku', { score: 42, score_source: 'aa', cost_in_per_m: 1, tools: true }),
    row('c1', 'anthropic', 'claude-sonnet-5.5', { score: 56, score_source: 'aa', cost_in_per_m: 9, tools: true }),
    row('c2', 'anthropic', 'claude-opus-5.5', { score: 57.6, score_source: 'aa', cost_in_per_m: 25, tools: true }),
    row('g1', 'openai', 'gpt-5.5', { score: 55.2, score_source: 'aa', cost_in_per_m: 20, tools: true }),
    row('x1', 'groq', 'no-tools-cheap', { score: 38, score_source: 'est', cost_in_per_m: 0.2, cost_kind: 'free', tools: false }),
    row('v1', 'stability', 'pixel-video', { score: 44, score_source: 'aa', cost_in_per_m: 5, kind: 'video', output_modalities: 'video', tools: true }),
  ];
}

test('lite admits free rows at VQ >= 20 only, pro and max stay distinct', () => {
  const catalog = buildSmartCatalog(mixedRows(), KEYS);
  assert.ok(catalog.lite.length > 0, 'lite is non-empty');
  for (const r of catalog.lite) {
    assert.ok((r.score || 0) >= 20, `lite keeps VQ >= 20 only, saw ${r.modelId}=${r.score}`);
    const cost = Number(r.cost_in_per_m);
    const freeOrNominal = cost === 0 || (Number.isFinite(cost) && cost <= 0.5)
      || String(r.cost_kind || '').toLowerCase() === 'free';
    const servedByFreeOrSubKey = r.providerId === 'groq' || r.providerId === 'anthropic';
    assert.ok(freeOrNominal || servedByFreeOrSubKey,
      `lite holds zero-cost or free/subscription-served rows only, saw ${r.providerId}/${r.modelId}`);
  }
  const liteIds = new Set(catalog.lite.map((r) => r.modelId));
  assert.ok(!liteIds.has('gpt-5.5'),
    'a paid-only row with no free/subscription key never lands in lite');
  assert.ok(liteIds.has('claude-opus-5.5'),
    'a frontier row served under a subscription key is admitted to lite');
  assert.ok(!liteIds.has('cat-jam'), 'the fake audio listing never lands in lite');
  for (const r of catalog.efficient) {
    assert.ok(r.score >= 30 && r.score < 45, `efficient spans 30..45, saw ${r.score}`);
    assert.notEqual(r.tools, false, 'pro tiers refuse tool-incapable rows');
  }
  for (const r of catalog.capable) {
    assert.ok(r.score >= 45, `capable starts at 45, saw ${r.score}`);
    assert.notEqual(r.tools, false, 'pro tiers refuse tool-incapable rows');
  }
  assert.ok(catalog.max.length > 0, 'venom-max is never empty on a measured roster');
  for (const r of catalog.max) {
    assert.ok(r.score >= 45, `max keeps frontier scores only, saw ${r.score}`);
    assert.ok(r.score_source && r.score_source !== 'est-heuristic',
      `max keeps documented scores only, saw ${r.modelId} (${r.score_source})`);
  }
  const sizes = new Set([catalog.lite.length, catalog.efficient.length + catalog.capable.length, catalog.max.length]);
  assert.ok(sizes.size > 1, `tier sizes differ, saw lite=${catalog.lite.length} pro=${catalog.efficient.length + catalog.capable.length} max=${catalog.max.length}`);
});

test('frontier VQ 56-58 rows reach venom-max and the pro capable rung', () => {
  const catalog = buildSmartCatalog(mixedRows(), KEYS);
  const maxIds = new Set(catalog.max.map((r) => r.modelId));
  assert.ok(maxIds.has('claude-opus-5.5'), 'VQ 57.6 reaches venom-max');
  assert.ok(maxIds.has('claude-sonnet-5.5'), 'VQ 56 reaches venom-max');
  const capableIds = new Set(catalog.capable.map((r) => r.modelId));
  assert.ok(capableIds.has('claude-opus-5.5'), 'VQ 57.6 reaches the pro capable rung');
  assert.ok(capableIds.has('claude-sonnet-5.5'), 'VQ 56 reaches the pro capable rung');
  const scores = catalog.max.map((r) => r.score);
  assert.equal(scores[0], 57.6, 'the top VQ leads venom-max');
  assert.deepEqual(new Set(catalog.max.map((r) => r.modelId)),
    new Set(['claude-opus-5.5', 'claude-sonnet-5.5', 'gpt-5.5']),
    'the frontier set reaches max across providers');
});

test('fake and non-text rows never enter any tier or the counts', () => {
  const catalog = buildSmartCatalog(mixedRows(), KEYS);
  const everywhere = [...catalog.lite, ...catalog.efficient, ...catalog.capable, ...catalog.max]
    .map((r) => r.modelId);
  for (const fake of ['cat-jam', 'pixel-video']) {
    assert.ok(!everywhere.includes(fake), `${fake} is excluded from every tier`);
  }
  assert.equal(catalog.counts.total, 10, 'the two non-text rows leave the usable total');
});

test('formatModelDisplayName strips routing prefixes, upstream id stays raw', () => {
  const { formatModelDisplayName } = require('../../src/router');
  assert.equal(formatModelDisplayName('devora-01/xiaomi-mimo/mimo-v2.6-flash', null), 'mimo-v2.6-flash');
  assert.equal(formatModelDisplayName('qwen-max:free', null), 'qwen-max');
  assert.equal(formatModelDisplayName('gpt-5.5', 'GPT Five Point Five'), 'GPT Five Point Five');
  const catalog = buildSmartCatalog(
    [row('d1', 'devora-01', 'xiaomi-mimo/mimo-v2.6-flash', { score: 37.9, score_source: 'aa', cost_in_per_m: 0.4, tools: true })],
    [{ id: 'k1', providerId: 'devora-01', tier: 'paid' }]);
  const found = [...catalog.efficient, ...catalog.capable].find((r) => r.modelId === 'xiaomi-mimo/mimo-v2.6-flash');
  assert.ok(found, 'the prefixed row is routed');
  assert.equal(found.upstream_id, 'devora-01::xiaomi-mimo/mimo-v2.6-flash', 'dispatch keeps the raw upstream id');
});

test('unscored rows read an est-heuristic score but stay below the lite floor', () => {
  const read = evaluateModelCapabilities({ id: 'brand-new', tools: false });
  assert.equal(read.scoreSource, 'est-heuristic');
  assert.equal(read.estimated, true);
  const catalog = buildSmartCatalog(mixedRows(), KEYS);
  assert.equal(catalog.counts.unscored, 0, 'no row stays unscored');
  assert.equal(catalog.counts.scored, catalog.counts.total);
  const mystery = catalog.lite.find((r) => r.modelId === 'mystery-free');
  assert.ok(!mystery, 'a heuristic score below 20 never clears the lite floor');
});

test('buildProfilesPayload carries per-profile target lists with key counts', () => {
  const catalog = buildSmartCatalog(mixedRows(), KEYS);
  const pool = new KeyPoolManager({ keys: KEYS });
  const payload = buildProfilesPayload(catalog, {
    keys: KEYS,
    poolStatus: pool.status(),
    gateway: { listening: true, port: 28228 },
    fleet: { active: 6, total: 7, disabled: 1 },
  });
  assert.equal(payload.ok, true);
  assert.equal(payload.gateway.port, 28228);
  assert.equal(payload.fleet.active, 6);
  for (const name of ['lite', 'pro', 'max']) {
    const profile = payload.profiles[name];
    assert.ok(profile, `${name} profile exists`);
    assert.equal(profile.count, profile.eligible.length, `${name} count matches its list`);
    for (const target of profile.eligible) {
      assert.ok(target.providerId && target.modelId, 'target names its route');
      assert.ok(Number.isFinite(target.score), 'target carries a score');
      assert.ok(Number.isInteger(target.activeKeys), 'target counts live keys');
    }
  }
  assert.ok(payload.profiles.pro.efficient.length >= 1, 'pro keeps its efficient rung');
  assert.ok(payload.profiles.pro.capable.length >= 1, 'pro keeps its capable rung');
  assert.ok(payload.profiles.max.candidates >= payload.profiles.max.count,
    'max candidates bound the honest progress-bar denominator');
  assert.ok(payload.profiles.lite.candidates >= payload.profiles.lite.count,
    'lite candidates bound the honest progress-bar denominator');
  const liteIds = new Set(payload.profiles.lite.eligible.map((t) => t.modelId));
  assert.ok(!liteIds.has('gpt-5.5'), 'a paid frontier row never lands in lite');
});

test('venom-max synthesizes drafts through the lead route, longest wins only on failure', async () => {
  const rows = [
    row('a', 'groq', 'fast', { score: 84, score_source: 'aa', cost_in_per_m: 0, tools: true }),
    row('b', 'anthropic', 'strong', { score: 86, score_source: 'aa', cost_in_per_m: 3, tools: true }),
    row('c', 'openai', 'frontier', { score: 90, score_source: 'aa', cost_in_per_m: 10, tools: true }),
  ];
  const keys = [
    { id: 'g', providerId: 'groq', tier: 'free' },
    { id: 'a', providerId: 'anthropic', tier: 'paid' },
    { id: 'o', providerId: 'openai', tier: 'paid' },
  ];
  const seen = [];
  const engine = new VenomCascadeEngine({ smartCatalog: buildSmartCatalog(rows, keys),
    keyPool: new KeyPoolManager({ keys }),
    dispatchUpstream: async (route, payload) => {
      seen.push(payload);
      if (payload && payload.synthesis === true) return { text: 'merged analyst answer' };
      return { text: `draft from ${route.modelId} with padding to vary length ${'x'.repeat(route.modelId.length * 7)}` };
    } });
  const result = await engine.route('venom-max', { messages: [{ role: 'user', content: 'decide' }], body: {} });
  assert.equal(result.text, 'merged analyst answer');
  assert.equal(result.model, 'venom-max');
  assert.equal(result.panelSize, 3);
  assert.equal(result.synthesis, 'lead-analyst');
  assert.ok(seen.some((p) => p && p.synthesis === true), 'the lead route received a merge request');
});

test('venom-max falls back to the longest draft when synthesis fails', async () => {
  const rows = [
    row('a', 'groq', 'fast', { score: 84, score_source: 'aa', cost_in_per_m: 0, tools: true }),
    row('b', 'anthropic', 'strong', { score: 86, score_source: 'aa', cost_in_per_m: 3, tools: true }),
  ];
  const keys = [{ id: 'g', providerId: 'groq', tier: 'free' }, { id: 'a', providerId: 'anthropic', tier: 'paid' }];
  const engine = new VenomCascadeEngine({ smartCatalog: buildSmartCatalog(rows, keys),
    keyPool: new KeyPoolManager({ keys }),
    dispatchUpstream: async (route, payload) => {
      if (payload && payload.synthesis === true) throw Object.assign(new Error('lead busy'), { status: 503 });
      return { text: `draft-${route.modelId}` };
    } });
  const result = await engine.route('venom-max', { messages: [{ role: 'user', content: 'decide' }], body: {} });
  assert.ok(String(result.text).startsWith('draft-'), 'longest draft answers when the analyst fails');
  assert.equal(result.synthesis, 'longest-draft-fallback');
});

test('stream passthrough pipes upstream chunks in order and fails over before the first chunk', async () => {
  const events = [];
  const clientRes = {
    writes: [],
    write(chunk) { this.writes.push(String(chunk)); },
    end(tail) { if (tail) this.writes.push(String(tail)); this.ended = true; },
  };
  const goodStream = (async function * fake() {
    yield 'data: {"a":1}\n\n';
    yield 'data: {"a":2}\n\n';
  })();
  const firstAttempt = { status: 500, headers: {}, stream: null };
  const secondAttempt = { status: 200, headers: { 'content-type': 'text/event-stream' }, stream: goodStream };
  const attempts = [firstAttempt, secondAttempt];
  let calls = 0;
  const engine = new VenomCascadeEngine({
    smartCatalog: buildSmartCatalog(
      [row('a', 'groq', 'fast', { score: 84, score_source: 'aa', cost_in_per_m: 0, tools: true }),
       row('b', 'anthropic', 'strong', { score: 86, score_source: 'aa', cost_in_per_m: 3, tools: true })],
      [{ id: 'g', providerId: 'groq', tier: 'free' }, { id: 'a', providerId: 'anthropic', tier: 'paid' }]),
    keyPool: new KeyPoolManager({ keys: [
      { id: 'g', providerId: 'groq', tier: 'free' },
      { id: 'a', providerId: 'anthropic', tier: 'paid' },
    ] }),
    dispatchUpstream: async () => ({ text: 'unused' }),
    streamUpstream: async () => attempts[calls++],
  });
  const outcome = await engine.routeStream('venom-max',
    { messages: [{ role: 'user', content: 'hi' }], body: {} },
    { clientRes, pipe: pipeUpstreamStream, onEvent: (e) => events.push(e) });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.failovers, 1, 'the dead route fails over before the first chunk');
  assert.ok(clientRes.writes.join('').includes('"a":2'), 'upstream bytes reach the client in order');
  assert.equal(clientRes.ended, true);
});

test('catalog score persistence skips est-heuristic guesses', () => {
  const Database = require('better-sqlite3');
  const { persistCatalogScores, readCatalogScores } = require('../../src/router');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE catalog_scores (
    model_key TEXT PRIMARY KEY, score REAL, score_source TEXT,
    score_basis_json TEXT, catalog_rank INTEGER, updated_at INTEGER NOT NULL)`);
  const written = persistCatalogScores(db, [
    { id: 'a', matched_id: 'lab/a', score: 50, score_source: 'aa', score_basis: ['aa'], catalog_rank: 1 },
    { id: 'b', matched_id: 'lab/b', score: 12, score_source: 'est-heuristic', catalog_rank: 9 },
  ]);
  assert.equal(written.written, 1, 'the heuristic guess is not stored as a measurement');
  assert.equal(readCatalogScores(db).length, 1);
  assert.equal(readCatalogScores(db)[0].model_key, 'lab/a');
});
