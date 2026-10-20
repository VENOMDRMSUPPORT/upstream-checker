'use strict';

// Router plane: smart catalog split, three-level key isolation, cascade
// staging and the local gateway. Pure Node, no Electron, no network.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const {
  canonicalSlug, upstreamModelId, evaluateModelCapabilities,
  compressToolMessages, rescuePlainTextToolCalls, analyzeCascadeStage,
  buildSmartCatalog, KeyPoolManager, VenomCascadeEngine,
  createVenomHttpGateway, persistCatalogScores, readCatalogScores,
  ROUTER_PORT, normalizeGatewayPort,
} = require('../../src/router');

test('gateway port falls back to the default outside 1024..65535', () => {
  assert.equal(normalizeGatewayPort(20129), 20129);
  assert.equal(normalizeGatewayPort('20129'), 20129);
  assert.equal(normalizeGatewayPort(80), ROUTER_PORT);
  assert.equal(normalizeGatewayPort(99999), ROUTER_PORT);
  assert.equal(normalizeGatewayPort(undefined), ROUTER_PORT);
  assert.equal(normalizeGatewayPort('next'), ROUTER_PORT);
});

test('identity keeps the raw upstream address apart from the match key', () => {
  assert.equal(upstreamModelId('AdsLabs', 'Qwen-3:free'), 'AdsLabs::Qwen-3:free');
  assert.equal(canonicalSlug('AdsLabs', 'Qwen-3:free'), 'adslabs/qwen-3');
  assert.notEqual(upstreamModelId('a', 'm:free'), canonicalSlug('a', 'm:free'));
});

test('capability read never invents a measured score', () => {
  const measured = evaluateModelCapabilities({ score: 42, score_source: 'aa' });
  assert.equal(measured.score, 42);
  assert.equal(measured.estimated, false);
  const unknown = evaluateModelCapabilities({ id: 'brand-new-model', tools: false });
  assert.equal(unknown.scoreSource, 'est-heuristic');
  assert.equal(unknown.estimated, true);
});

test('smart catalog preserves upstream ids and splits three tiers', () => {
  const rows = [
    { id: 'cheap-1', provider_id: 'groq', model_id: 'llama-flash', score: 32, score_source: 'aa', cost_in_per_m: 0, cost_kind: 'free', tools: true },
    { id: 'pro-1', provider_id: 'anthropic', model_id: 'claude-sonnet', score: 52, score_source: 'aa', cost_in_per_m: 3, tools: true },
    { id: 'max-1', provider_id: 'openai', model_id: 'gpt-x', score: 55.2, score_source: 'aa', cost_in_per_m: 10, tools: true },
    { id: 'new-1', provider_id: 'groq', model_id: 'mystery', score: null, score_source: null, cost_in_per_m: 0, cost_kind: 'free' },
  ];
  const keys = [
    { id: 'k1', providerId: 'groq', tier: 'free' },
    { id: 'k2', providerId: 'anthropic', tier: 'paid' },
    { id: 'k3', providerId: 'openai', tier: 'paid' },
  ];
  const catalog = buildSmartCatalog(rows, keys);
  assert.equal(catalog.counts.total, 4);
  assert.equal(catalog.counts.unscored, 0, 'heuristic scoring leaves no row outside the tiers');
  for (const pool of [catalog.lite, catalog.efficient, catalog.capable, catalog.max]) {
    for (const row of pool) {
      assert.ok(row.upstream_id.includes('::'), 'dispatch address survives the merge');
      assert.ok(row.canonical_slug.includes('/'), 'match key survives beside it');
    }
  }
  assert.ok(catalog.lite[0].cost_in_per_m === 0, 'lite drains free quota first');
  assert.ok(!catalog.lite.some((r) => r.model_id === 'mystery'), 'a heuristic below 20 never clears the lite floor');
  assert.ok(catalog.max.every((r) => r.score >= 45), 'max keeps frontier scores only');
  assert.ok(catalog.max.length >= 1, 'max is non-empty here');
});

test('key pool isolates a model-on-key failure from the rest of the key', () => {
  const pool = new KeyPoolManager({ keys: [
    { id: 'a1', providerId: 'acme', tier: 'paid' },
    { id: 'a2', providerId: 'acme', tier: 'paid' },
  ], now: () => 1000 });
  pool.reportResult({ keyId: 'a1', modelId: 'opus', outcome: 'rate_limit', retryAfterMs: 60000 });
  assert.equal(pool.isCool('model:opus', 'a1'), false);
  assert.equal(pool.isCool('model:sonnet', 'a1'), true);
  const picked = pool.pickKey([{ keyId: 'a1', modelId: 'opus' }, { keyId: 'a1', modelId: 'sonnet' }, { keyId: 'a2', modelId: 'opus' }]);
  assert.notDeepStrictEqual(picked, { keyId: 'a1', modelId: 'opus' });
  assert.ok(['a1', 'a2'].includes(picked.keyId));
  // A paid-tier outage on the key cools the key but leaves the sibling live.
  pool.reportResult({ keyId: 'a1', outcome: 'payment' });
  assert.equal(pool.isCool('key', 'a1'), false);
  assert.equal(pool.isCool('key', 'a2'), true);
});

test('key pool drains subscription before free before paid', () => {
  const pool = new KeyPoolManager({ keys: [
    { id: 'paid', providerId: 'p', tier: 'paid' },
    { id: 'free', providerId: 'p', tier: 'free' },
    { id: 'sub', providerId: 'p', tier: 'subscription' },
  ] });
  const picked = pool.pickKey([{ keyId: 'paid' }, { keyId: 'free' }, { keyId: 'sub' }]);
  assert.equal(picked.keyId, 'sub');
});

test('cascade stage escalates on tool errors only', () => {
  const calm = analyzeCascadeStage([{ role: 'tool', content: 'wrote 3 files, tests green' }]);
  assert.equal(calm.shouldEscalate, false);
  const broken = analyzeCascadeStage([
    { role: 'user', content: 'fix it' },
    { role: 'tool', content: 'Error: tests FAIL (2 failed)' },
  ]);
  assert.equal(broken.shouldEscalate, true);
  assert.equal(broken.consecutiveErrors, 1);
});

test('pro route escalates the session after a tool failure', async () => {
  const rows = [
    { id: 'e', provider_id: 'groq', model_id: 'fast', score: 38, score_source: 'aa', cost_in_per_m: 0, tools: true },
    { id: 'c', provider_id: 'anthropic', model_id: 'strong', score: 52, score_source: 'aa', cost_in_per_m: 3, tools: true },
  ];
  const keys = [{ id: 'g', providerId: 'groq', tier: 'free' }, { id: 'a', providerId: 'anthropic', tier: 'paid' }];
  const engine = new VenomCascadeEngine({ smartCatalog: buildSmartCatalog(rows, keys),
    keyPool: new KeyPoolManager({ keys }),
    dispatchUpstream: async (route) => ({ text: `via ${route.modelId}` }) });
  const first = await engine.route('venom-pro', { messages: [{ role: 'user', content: 'hi' }], body: {}, sessionId: 's1' });
  assert.match(first.routedVia, /groq/);
  const second = await engine.route('venom-pro', { messages: [{ role: 'tool', content: 'Error: boom' }], body: {}, sessionId: 's1' });
  assert.match(second.routedVia, /anthropic/);
  assert.equal(second.cascadeReason, 'escalated');
});

test('tool output compression bounds long transcripts', () => {
  const long = 'x'.repeat(20000);
  const out = compressToolMessages([{ role: 'tool', content: long }], 100);
  assert.ok(out[0].content.length < long.length);
  assert.match(out[0].content, /trimmed/);
  assert.equal(rescuePlainTextToolCalls('no json here'), null);
  const rescued = rescuePlainTextToolCalls('done {"name": "write_file", "arguments": {"path": "a"}}');
  assert.equal(rescued[0].function.name, 'write_file');
});

test('gateway serves the three venom models and OpenAI shape', async () => {
  const http = require('node:http');
  const rows = [{ id: 'e', provider_id: 'groq', model_id: 'fast', score: 30, score_source: 'aa', cost_in_per_m: 0, tools: true }];
  const keys = [{ id: 'g', providerId: 'groq', tier: 'free', baseUrl: 'https://x' }];
  const engine = new VenomCascadeEngine({ smartCatalog: buildSmartCatalog(rows, keys),
    keyPool: new KeyPoolManager({ keys }),
    dispatchUpstream: async () => ({ text: 'hello' }) });
  const gateway = createVenomHttpGateway({ cascadeEngine: engine, port: 0, log: { warn() {}, info() {} } });
  assert.equal(gateway.isListening(), false, 'boot binds nothing: the socket opens on demand');
  const { port } = await gateway.start();
  try {
    const models = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/v1/models' }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }));
      }).on('error', reject);
    });
    assert.equal(models.status, 200);
    assert.ok(models.body.data.some((m) => m.id === 'venom-lite'));
    assert.ok(models.body.data.some((m) => m.id === 'venom-pro'));
    assert.ok(models.body.data.some((m) => m.id === 'venom-max'));
    const ids = models.body.data.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, 'pools merge without duplicates');
    const chat = await new Promise((resolve, reject) => {
      const payload = JSON.stringify({ model: 'venom-lite', messages: [{ role: 'user', content: 'hi' }] });
      const req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }));
      });
      req.on('error', reject);
      req.end(payload);
    });
    assert.equal(chat.status, 200);
    assert.equal(chat.body.model, 'venom-lite');
    assert.equal(chat.body.choices[0].message.content, 'hello');
    assert.ok(chat.headers['x-venom-routed-via'], 'gateway labels the route');
  } finally {
    await gateway.stop();
    assert.equal(gateway.isListening(), false);
  }
});

test('gateway streams OpenAI SSE when stream:true', async () => {
  const text = 'hello world, this streamed reply is long enough to slice into several event frames for sure';
  const engine = streamEngine(text);
  const gateway = createVenomHttpGateway({ cascadeEngine: engine, port: 0, log: { warn() {}, info() {} } });
  const { port } = await gateway.start();
  try {
    const reply = await postJson(port, '/v1/chat/completions', { model: 'venom-lite', messages: [{ role: 'user', content: 'hi' }], stream: true });
    assert.equal(reply.status, 200);
    assert.match(reply.headers['content-type'], /text\/event-stream/);
    assert.match(reply.body, /data: \{"id":"chatcmpl-/);
    assert.ok(reply.body.includes('hello'), 'chunks carry the text');
    assert.ok(reply.body.trimEnd().endsWith('data: [DONE]'), 'stream terminates with [DONE]');
    const frames = reply.body.split('\n\n').filter((f) => f.startsWith('data: {'));
    assert.ok(frames.length >= 3, 'role + content + stop frames');
    for (const frame of frames) JSON.parse(frame.slice('data: '.length));
  } finally {
    await gateway.stop();
  }
});

test('gateway streams Anthropic SSE when stream:true', async () => {
  const engine = streamEngine('streamed anthropic text here');
  const gateway = createVenomHttpGateway({ cascadeEngine: engine, port: 0, log: { warn() {}, info() {} } });
  const { port } = await gateway.start();
  try {
    const reply = await postJson(port, '/v1/messages', { model: 'venom-pro', input: 'hi', stream: true });
    assert.equal(reply.status, 200);
    assert.match(reply.headers['content-type'], /text\/event-stream/);
    for (const name of ['message_start', 'content_block_delta', 'message_delta', 'message_stop']) {
      assert.ok(reply.body.includes(`event: ${name}`), `has ${name}`);
    }
    assert.ok(reply.body.includes('streamed anthropic text here'));
  } finally {
    await gateway.stop();
  }
});

function postJson(port, path, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

function streamEngine(answer) {
  const rows = [{ id: 'e', provider_id: 'groq', model_id: 'fast', score: 30, score_source: 'aa', cost_in_per_m: 0, tools: true }];
  const keys = [{ id: 'g', providerId: 'groq', tier: 'free', baseUrl: 'https://x' }];
  return new VenomCascadeEngine({ smartCatalog: buildSmartCatalog(rows, keys),
    keyPool: new KeyPoolManager({ keys }),
    dispatchUpstream: async () => ({ text: answer }) });
}

test('catalog scores persist for 0ms boot values and skip unscored rows', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE catalog_scores (
    model_key TEXT PRIMARY KEY, score REAL, score_source TEXT,
    score_basis_json TEXT, catalog_rank INTEGER, updated_at INTEGER NOT NULL)`);
  const written = persistCatalogScores(db, [
    { id: 'a', matched_id: 'lab/a', score: 50, score_source: 'aa', score_basis: ['aa'], catalog_rank: 1 },
    { id: 'b', score: null, score_source: null },
  ]);
  assert.equal(written.written, 1);
  assert.equal(readCatalogScores(db).length, 1);
  assert.equal(readCatalogScores(db)[0].model_key, 'lab/a');
});
