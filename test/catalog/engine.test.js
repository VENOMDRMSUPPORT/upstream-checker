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
    // Turns one source over from success to failure between two syncs of the SAME
    // engine, and waits a few milliseconds while doing it. The wait is what makes
    // "lastAttemptAt advanced" an assertion instead of a coin toss: syncAll stamps
    // the attempt inside itself, so two syncs run back to back can land in the
    // same millisecond and read as identical ISO strings.
    async failSource(id, message) {
      fail[id] = message;
      await new Promise((resolve) => { setTimeout(resolve, 5); });
    },
    healSource(id) { delete fail[id]; },
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
  assert.equal(summary.syncing, false, 'the object is built after the flag is cleared');
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
  const good = engine.state.sourceStore['openrouter-public'];
  assert.equal(good.stale, false, 'the source answered, so nothing here is stale');
  assert.equal(sources.readCache('openrouter-public').payload.data.length, 1);

  // The title's second half: the SAME source, failing on the NEXT sync, against
  // the payload the first sync stored. Spec §8: "its last-good payload stays,
  // marked stale".
  await sources.failSource('openrouter-public', 'HTTP 503');
  await engine.syncAll({ force: true });
  const after = engine.state.sourceStore['openrouter-public'];
  assert.equal(after.stale, true, 'a failure over a stored payload is stale, not silence');
  assert.deepEqual(after.payload, OR_ROWS, 'and the payload it failed to replace is still served');
  assert.equal(after.error, 'HTTP 503');
  assert.equal(after.rowCount, 1, 'the row count of the payload still in memory');
  assert.equal(after.fetchedAt, good.fetchedAt, 'fetchedAt is still the age of those rows');
  assert.notEqual(after.lastAttemptAt, good.lastAttemptAt, 'the attempt that failed is its own moment');
  assert.ok(Date.parse(after.lastAttemptAt) > Date.parse(good.lastAttemptAt),
    'and it is later than the attempt that succeeded');
  assert.equal(engine.state.catalog.rows.length, 1, 'the reference still builds from the last-good payload');

  // The same through the disk, not only in memory: a restart has to see the
  // failure as clearly as the engine that recorded it.
  const onDisk = sources.readCache('openrouter-public');
  assert.equal(onDisk.meta.stale, true);
  assert.equal(onDisk.meta.error, 'HTTP 503');
  assert.equal(onDisk.meta.fetchedAt, good.fetchedAt);
  assert.ok(onDisk.payload, 'the cache file still holds the payload');

  sources.healSource('openrouter-public');
  await engine.syncAll({ force: true });
  assert.equal(engine.state.sourceStore['openrouter-public'].stale, false,
    'and the source that answers again stops claiming to be stale');
});

test('a last-good payload whose cached meta records a failed attempt reads back stale', () => {
  const later = new Date(Date.parse(NEW) + 60000).toISOString();
  const sources = fakeSources();
  sources.seed('openrouter-public', OR_ROWS);
  // What a failed refresh leaves on disk: the payload untouched, the meta marked.
  sources.writeCacheFailure('openrouter-public', 'HTTP 503', later);

  const engine = createEngine({ sources });
  engine.loadCache();
  const entry = engine.state.sourceStore['openrouter-public'];
  assert.equal(entry.stale, true, 'spec §8 survives the restart, not just the session');
  assert.equal(entry.error, 'HTTP 503');
  assert.deepEqual(entry.payload, OR_ROWS, 'the last-good payload is what boots');
  assert.equal(entry.fetchedAt, NEW, 'fetchedAt stays the age of the rows, not of the failure');
  assert.equal(entry.lastAttemptAt, later);
  assert.equal(entry.rowCount, 1);
  assert.equal(engine.state.catalog.rows.length, 1, 'and the reference is rebuilt from it');
});

test('a clean cache read from disk is not stale, and the last-good rows survive the restart', () => {
  const dead = fakeSources({});
  dead.seed('openrouter-public', OR_ROWS);
  const after = createEngine({ sources: dead });
  after.loadCache();
  const before = after.state.sourceStore['openrouter-public'];
  assert.equal(before.stale, false, 'loaded from disk, no attempt made yet');
  assert.equal(before.error, null);
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
  const resolved = await first;
  assert.equal(engine.state.syncing, false, 'the flag is cleared on the happy path too');
  assert.equal(resolved.syncing, false,
    'and so it is in the object the caller awaited — the flag clears before the summary is built');
});

test('syncAll resolves to one shape on either path, with the sync already over', async () => {
  const fresh = new Date().toISOString();
  const sources = fakeSources({ payloads: { 'openrouter-public': OR_ROWS }, newest: fresh });
  const engine = createEngine({ sources });

  const forced = await engine.syncAll({ force: true });
  assert.equal(forced.syncing, false, 'a caller never sees a finished sync as still running');
  assert.equal(forced.skipped, false, 'and skipped is present and false, not absent');

  const ttl = await engine.syncAll();
  assert.equal(ttl.syncing, false);
  assert.equal(ttl.skipped, true, 'the path that did not download says so in the same field');
  assert.deepEqual(Object.keys(forced).sort(), Object.keys(ttl).sort(),
    'one shape either way — a consumer must not have to tell undefined from false');
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

test('an id we gave up on survives a later sync that scored other models', async () => {
  // The fixture the bug needs: a reference that DOES score something. Almost
  // every real sync has a scored row in it, so a clear keyed on that fact is a
  // wipe that runs every time — which is why the case above, whose payloads carry
  // no benchmark source at all, could not see it.
  const payloads = {
    'openrouter-public': { data: [
      { id: 'lab/measured', name: 'Measured', context_length: 1000,
        architecture: { output_modalities: ['text'] } },
      { id: 'lab/unmeasured', name: 'Unmeasured', context_length: 1000,
        architecture: { output_modalities: ['text'] } },
    ] },
    'openrouter-keyed': { data: [{ model_permaslug: 'lab/measured', display_name: 'Measured',
      source: 'artificial-analysis', intelligence_index: 40 }] },
  };
  const sources = fakeSources({ payloads });
  const engine = createEngine({ sources });
  await engine.syncAll({ force: true });
  assert.ok(engine.state.catalog.rows.some((r) => r.score != null),
    'the reference scores one model, and never will score the other');
  assert.deepEqual(engine.unscoredIds([{ id: 'nowhere/model', name: 'Nowhere' }]), ['nowhere/model']);

  await engine.syncIfUnscored([{ id: 'nowhere/model', name: 'Nowhere' }]);
  assert.equal(engine.unscorableSize(), 1, 'the id is given up on after one failed hunt');
  assert.equal(sources.syncs, 2, 'and it cost exactly one four-source download');

  // The 5-minute background timer, or the owner pressing Sync sources. Nothing in
  // this path is a reason to reopen a verdict.
  await engine.syncAll({ force: true });
  assert.equal(sources.syncs, 3);
  const again = await engine.syncIfUnscored([{ id: 'nowhere/model', name: 'Nowhere' }]);
  assert.equal(again.synced, false, 'a sync that scored nothing new does not reopen the ids we gave up on');
  assert.equal(sources.syncs, 3, 'and a permanently unknown model costs the download once, not every timer');
  assert.equal(engine.unscorableSize(), 1, 'the verdict is still standing');
});

test('an id that later scores is dropped when a sync shrinks the unscored list', async () => {
  const payloads = { 'openrouter-public': { data: [{ id: 'later/one', name: 'One',
    context_length: 1000, architecture: { output_modalities: ['text'] } }] } };
  const sources = fakeSources({ payloads });
  const engine = createEngine({ sources });
  await engine.syncAll({ force: true });
  await engine.syncIfUnscored([{ id: 'later/two', name: 'Two' }]);
  assert.equal(engine.unscorableSize(), 1);

  // The reference only scores a row it HAS a row for, and rows come from the
  // rosters — folding a benchmark entry alone does not create one. So the sync
  // that changes the verdict must add both the listing and its measurement, and
  // it has to happen INSIDE the trigger: the trigger is the one place that
  // compares what stayed unscored against what was unscored before it (ref
  // poller.js:154-156). A new unknown id is what drags the old one back into that
  // comparison, exactly as the reference recomputes the list over every provider
  // rather than only over the ids it had not given up on (poller.js:113-120).
  sources.makeScorable();
  const result = await engine.syncIfUnscored([
    { id: 'later/two', name: 'Two' },
    { id: 'later/three', name: 'Three' },
  ]);
  assert.equal(result.synced, true);
  assert.equal(result.scored, 1, 'the id we gave up on scored after all');
  assert.equal(engine.unscorableSize(), 1,
    'the set is re-stamped with what is still unscored, so the id that scored is out of it');
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
