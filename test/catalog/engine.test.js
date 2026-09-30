const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngine, SOURCE_SYNC_MIN_AGE_MS } = require('../../src/catalog/engine');
const { createSources } = require('../../src/catalog/sources');
const { createFetcher } = require('../../src/catalog/fetch');
const { tempDir } = require('../helpers');

const OR_ROWS = { data: [{
  id: 'anthropic/claude-fable-5.1', name: 'Anthropic: Claude Fable 5.1',
  context_length: 200000, pricing: { prompt: '0.000008', completion: '0.00004' },
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
  supported_parameters: ['tools', 'response_format'],
}] };
const SPEC = { anthropic: { models: { 'claude-fable-5.1': { id: 'claude-fable-5.1',
  name: 'Claude Fable 5.1', limit: { context: 200000, output: 64000 }, tool_call: true,
  reasoning: true, release_date: '2026-08-31' } } } };
const NEW = new Date().toISOString();

// A sources stand-in backed by two Maps. It keeps the disk out of the test while
// exercising the same read/write calls the engine makes against the real one.
function fakeSources({ payloads = {}, newest = NEW, fail = {} } = {}) {
  const cache = new Map(); const meta = new Map();
  const store = {
    SOURCES: [
      { id: 'models-dev-spec', name: 'models.dev (spec)', description: 'd' },
      { id: 'openrouter-public', name: 'OpenRouter (models)', description: 'd' },
      { id: 'openrouter-keyed', name: 'OpenRouter (benchmarks)', description: 'd' },
      { id: 'lmarena', name: 'LMArena (text)', description: 'd' },
    ],
    syncs: 0,
    readKey: () => 'k',
    rowCount: (id, p) => (p && p.data ? p.data.length : 0),
    writeCache: (id, payload, m) => { cache.set(id, payload); meta.set(id, m); },
    writeCacheFailure: (id, message, at) => {
      if (!cache.has(id)) return false;
      meta.set(id, { ...(meta.get(id) || {}), lastAttemptAt: at, error: message, stale: true });
      return true;
    },
    readCache: (id) => (cache.has(id) ? { payload: cache.get(id), meta: meta.get(id) } : null),
    newestFetchedAt: () => (meta.size ? newest : null),
    hasPayload: (id) => cache.has(id),
    fetchAll: async () => {
      store.syncs += 1;
      return Object.entries(payloads).map(([id, payload]) => (fail[id]
        ? { id, source: { id }, payload: null, at: newest, error: fail[id] }
        : { id, source: { id }, payload, at: newest, error: null }));
    },
    seed(id, payload, at = newest) {
      cache.set(id, payload);
      // A payload cached in an error state is what the real writeCacheFailure
      // leaves behind: the error and the stale flag live in the META, beside an
      // `{ error }` stub in the data file. The engine reads the meta, so the
      // fake has to write it the same way or it is not the same disk.
      const stub = payload && typeof payload === 'object' && Object.keys(payload).length === 1
        && typeof payload.error === 'string';
      meta.set(id, stub
        ? { fetchedAt: at, lastAttemptAt: at, error: payload.error, stale: true, rowCount: 0 }
        : { fetchedAt: at, lastAttemptAt: at, error: null, stale: false, rowCount: 0 });
    },
    // Rewrites the payloads so a previously unknown id becomes both a listing and
    // a measured row — the only way the reference can score it: rows come from the
    // rosters, and folding a benchmark entry alone does not create one.
    makeScorable() {
      payloads['openrouter-public'] = { data: [
        ...payloads['openrouter-public'].data,
        { id: 'later/two', name: 'Two', context_length: 1000,
          architecture: { output_modalities: ['text'] } },
      ] };
      payloads['openrouter-keyed'] = { data: [{ model_permaslug: 'later/two',
        display_name: 'Two', source: 'artificial-analysis', intelligence_index: 30 }] };
    },
  };
  return store;
}

test('the engine hands out exactly the seam the later tasks are written against', () => {
  const engine = createEngine({ sources: fakeSources() });
  assert.deepEqual(Object.keys(engine).sort(), [
    'health', 'isNonTextModel', 'loadCache', 'minAgeMs', 'rebuild', 'scoreRows', 'state',
    'summary', 'syncAll', 'syncIfUnscored', 'unscorableSize', 'unscoredIds',
  ]);
});

test('a fresh engine has no catalog, and scoreRows leaves a row honestly unscored', () => {
  const engine = createEngine({ sources: fakeSources() });
  engine.loadCache();
  assert.equal(engine.state.catalog.rows.length, 0);
  const [row] = engine.scoreRows([{ id: 'x/y', name: 'X Y' }]);
  assert.equal(row.score, null);
  assert.equal(row.score_source, null);
  assert.deepEqual(row.score_basis, []);
  assert.equal(row.rank, null);
  assert.equal(row.matched_id, null);
  assert.equal(row.bench_id, null);
});

test('loadCache rebuilds from what is already cached, with no fetch at all', () => {
  const sources = fakeSources();
  sources.seed('openrouter-public', OR_ROWS);
  sources.seed('models-dev-spec', SPEC);
  const engine = createEngine({ sources });
  engine.loadCache();
  assert.equal(engine.state.catalog.rows.length, 1);
  assert.equal(engine.state.lastSyncAt, NEW);
  assert.equal(sources.syncs, 0);
});

test('syncAll stores every payload that arrived and rebuilds', async () => {
  const sources = fakeSources({ payloads: { 'openrouter-public': OR_ROWS, 'models-dev-spec': SPEC } });
  const engine = createEngine({ sources });
  const summary = await engine.syncAll({ force: true });
  assert.equal(summary.catalogCount, 1);
  assert.equal(sources.syncs, 1);
  assert.equal(engine.state.sourceStore['openrouter-public'].stale, false);
  assert.equal(engine.state.sourceStore['openrouter-public'].error, null);
});

test('a source that fails has nothing cached is absent, not stale; the merge still runs', async () => {
  const sources = fakeSources({
    payloads: { 'openrouter-public': OR_ROWS, 'models-dev-spec': SPEC, lmarena: { data: [], webdev: [] } },
    fail: { lmarena: 'timed out after 20s (retried once)' },
  });
  const engine = createEngine({ sources });
  await engine.syncAll({ force: true });
  assert.equal(engine.state.sourceStore.lmarena.stale, false, 'stale requires a previous payload');
  assert.equal(engine.state.sourceStore.lmarena.error, 'timed out after 20s (retried once)');
  assert.equal(engine.state.sourceStore['openrouter-public'].stale, false);
  assert.equal(engine.state.catalog.rows.length, 1);
});

test('a source that fails after succeeding keeps its payload and reads stale', async () => {
  const sources = fakeSources({ payloads: { 'openrouter-public': OR_ROWS } });
  const engine = createEngine({ sources });
  await engine.syncAll({ force: true });
  assert.equal(sources.readCache('openrouter-public').payload.data.length, 1);

  const dead = fakeSources({});
  dead.seed('openrouter-public', OR_ROWS);
  const after = createEngine({ sources: dead });
  after.loadCache();
  const before = after.state.sourceStore['openrouter-public'];
  assert.equal(before.stale, false, 'loaded from disk, no attempt made yet');
  assert.equal(after.state.catalog.rows.length, 1, 'last-good survives the restart');
});

test('a second syncAll while one is in flight is refused with SYNC_IN_PROGRESS', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const base = fakeSources({ payloads: { 'openrouter-public': OR_ROWS } });
  const slow = { ...base, fetchAll: async () => { await gate; return base.fetchAll(); } };
  const engine = createEngine({ sources: slow });
  const first = engine.syncAll({ force: true });
  await assert.rejects(() => engine.syncAll({ force: true }), (e) => e.code === 'SYNC_IN_PROGRESS');
  release();
  await first;
  assert.equal(engine.state.syncing, false, 'the flag is cleared on the happy path too');
});

test('scoreRows reaches the reference through the merge and borrows what the row lacks', async () => {
  const sources = fakeSources({ payloads: {
    'openrouter-public': OR_ROWS,
    'models-dev-spec': SPEC,
    'openrouter-keyed': { data: [{ model_permaslug: 'anthropic/claude-fable-5.1',
      display_name: 'Anthropic: Claude Fable 5.1', source: 'artificial-analysis', intelligence_index: 53 }] },
    lmarena: { data: [], webdev: [] },
  } });
  const engine = createEngine({ sources });
  await engine.syncAll({ force: true });
  const [row] = engine.scoreRows([{ id: 'nexum/claude-fable-5.1', name: 'Claude Fable 5.1' }]);
  assert.equal(row.matched_id, 'anthropic/claude-fable-5.1');
  assert.equal(row.score, 53);
  assert.equal(row.rank, 1);
  assert.equal(row.context_tokens, 200000, 'a thin row borrows the context it never published');
  assert.ok(row.filled_from_catalog.includes('context_tokens'), 'and every borrow is recorded');
});

test('syncIfUnscored syncs once for an unknown row, then gives up on it', async () => {
  const sources = fakeSources({ payloads: { 'openrouter-public': OR_ROWS, 'models-dev-spec': SPEC } });
  const engine = createEngine({ sources });
  await engine.syncAll({ force: true });
  const rows = [{ id: 'brand/new-model', name: 'Brand New' }];
  assert.deepEqual(engine.unscoredIds(rows), ['brand/new-model']);

  const first = await engine.syncIfUnscored(rows);
  assert.equal(first.synced, true, 'a model discovered this cycle is the reason to sync');
  assert.equal(first.scored, 0);
  assert.equal(sources.syncs, 2);

  const second = await engine.syncIfUnscored(rows);
  assert.equal(second.synced, false, 'an unscorable id costs no further syncs');
  assert.equal(sources.syncs, 2);
});

test('an id that later scores clears the unscorable set', async () => {
  const payloads = { 'openrouter-public': { data: [{ id: 'later/one', name: 'One',
    context_length: 1000, architecture: { output_modalities: ['text'] } }] } };
  const sources = fakeSources({ payloads });
  const engine = createEngine({ sources });
  await engine.syncAll({ force: true });
  await engine.syncIfUnscored([{ id: 'later/two', name: 'Two' }]);
  assert.equal(engine.unscorableSize(), 1);

  // The reference only scores a row it HAS a row for, and rows come from the
  // rosters — folding a benchmark entry alone does not create one. So the second
  // sync must add both the listing and its measurement.
  sources.makeScorable();
  await engine.syncAll({ force: true });
  assert.equal(engine.unscorableSize(), 0, 'the signal that made one scoreable may make the next one too');
  assert.equal(engine.unscoredIds([{ id: 'later/two', name: 'Two' }]).length, 0);
});

test('syncAll without force skips the network inside the TTL and still re-merges', async () => {
  const sources = fakeSources({ payloads: { 'openrouter-public': OR_ROWS }, newest: new Date().toISOString() });
  const engine = createEngine({ sources });
  const first = await engine.syncAll({ force: true });
  assert.equal(sources.syncs, 1);
  const second = await engine.syncAll();
  assert.equal(sources.syncs, 1, 'the download is gated, the merge is not');
  assert.equal(second.skipped, true);
  assert.equal(second.catalogCount, first.catalogCount);
});

test('syncAll without force does hit the network when the newest payload is old', async () => {
  const old = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  const sources = fakeSources({ payloads: { 'openrouter-public': OR_ROWS }, newest: old });
  const engine = createEngine({ sources });
  await engine.syncAll();
  assert.equal(sources.syncs, 1);
});

test('summary reports six fields per source, in the declared order', () => {
  const sources = fakeSources();
  sources.seed('lmarena', { data: [], webdev: [] });
  const engine = createEngine({ sources });
  engine.loadCache();
  const entry = engine.summary().sources.find((s) => s.id === 'lmarena');
  assert.deepEqual(Object.keys(entry).sort(),
    ['description', 'error', 'fetchedAt', 'id', 'lastAttemptAt', 'name', 'rowCount', 'stale']);
  assert.equal(engine.summary().keyedAuthConfigured, true, 'a readable key is a configured key');
});

test('an error stub cached on disk still reports itself stale', () => {
  const sources = fakeSources();
  sources.seed('openrouter-keyed', { error: 'HTTP 401' });
  const engine = createEngine({ sources });
  engine.loadCache();
  const entry = engine.state.sourceStore['openrouter-keyed'];
  assert.equal(entry.stale, true, 'the six-field bug: this used to read as silence');
  assert.ok(Object.prototype.hasOwnProperty.call(entry, 'lastAttemptAt'));
  assert.equal(entry.payload, null);
  assert.equal(entry.error, 'HTTP 401');
});

test('every source entry carries all six fields, before any sync and after a failed one', async () => {
  const SIX = ['error', 'fetchedAt', 'lastAttemptAt', 'payload', 'rowCount', 'stale'];
  const sources = fakeSources({ payloads: { 'openrouter-public': OR_ROWS }, fail: { lmarena: 'no route' } });
  const engine = createEngine({ sources });
  const booting = Object.values(engine.state.sourceStore);
  assert.equal(booting.length, 4, 'one entry per declared source, created at construction');
  booting.forEach((entry) => assert.deepEqual(Object.keys(entry).sort(), SIX));
  await engine.syncAll({ force: true });
  Object.values(engine.state.sourceStore).forEach((entry) => assert.deepEqual(Object.keys(entry).sort(), SIX));
});

test('health reports the payload age, the gate it is measured against, and the set it gave up on', async () => {
  const sources = fakeSources({ payloads: { 'openrouter-public': OR_ROWS } });
  const engine = createEngine({ sources, minAgeMs: 60000 });
  await engine.syncAll({ force: true });
  const health = engine.health();
  assert.equal(health.minSyncAgeMs, 60000, 'the gate a caller may override per engine');
  assert.equal(health.unscorableCount, 0);
  assert.ok(health.newestPayloadAgeMs >= 0 && health.newestPayloadAgeMs < 60000);
  assert.equal(health.catalogCount, 1, 'and everything summary() says');
});

test('an empty cache is a real sources object, not a fake: booting on one is quiet', async (t) => {
  // The seam the engine is written against, exercised against the object Task 5
  // actually returns: an empty cache directory, a fetcher that is never called.
  const sources = createSources({ cacheDir: tempDir(t), fetcher: createFetcher({}), readKey: () => 'sk-or' });
  const engine = createEngine({ sources });
  engine.loadCache();
  assert.equal(engine.state.catalog.rows.length, 0);
  assert.equal(engine.state.lastSyncAt, null);
  assert.equal(engine.summary().keyedAuthConfigured, true, 'readKey is part of the seam, so a stored key reads as configured');
  assert.equal(engine.health().newestPayloadAgeMs, null, 'nothing cached is no age, not age zero');
  assert.equal(engine.summary().catalogCount, 0);
});

test('the TTL constant is the one spec §11 names', () => {
  assert.equal(SOURCE_SYNC_MIN_AGE_MS, 15 * 60 * 1000);
});

test('isNonTextModel knows a generator the reference dropped, and never guesses', async () => {
  const sources = fakeSources({ payloads: { 'openrouter-public': { data: [
    { id: 'lab/painter', name: 'Painter', architecture: { output_modalities: ['image'] } },
  ] } } });
  const engine = createEngine({ sources });
  await engine.syncAll({ force: true });
  assert.equal(engine.isNonTextModel({ id: 'lab/painter', name: 'Painter' }), true);
  assert.equal(engine.isNonTextModel({ id: 'host/silent', name: 'Silent' }), false,
    'unknown is not non-text — otherwise every listing of a provider that publishes nothing is deleted');
});
