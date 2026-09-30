// The five catalog channels, the single-flight door and the read/write split.
//
// No electron and no network here: the channel contract is what is under test, so
// the handlers run against a recorded ipcMain. Four cases are deliberately built
// over the REAL repos.snapshots (in-memory SQLite, migration v2) AND the REAL
// engine with a disk-shaped fake — the aliases a row needs in order to be scored
// at all are provider facts, and only the real store and the real merge can say
// whether they survived.
//
// Two seams the brief's example did not need and this module does:
// `setLastSync` (a failed attempt is recorded so the read path can call it stale)
// and a raw-roster validation before the row mapping (a model with no id is
// refused with INVALID_PROVIDER_PAYLOAD, the code the contract names).
const test = require('node:test');
const assert = require('node:assert');
const { createCatalogIpc, COMPARE_FIELDS, diffRow } = require('../../src/catalog/ipc');
const { providerRow } = require('../../src/catalog/row');
const { createEngine } = require('../../src/catalog/engine');
const { memoryStore } = require('../helpers');

// A fake ipcMain that records handlers, plus a fake repos with the seam the real
// one has. No electron, no database: the channel contract is what is under test.
function harness({ snapshots, engine } = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn) };
  const calls = [];
  const log = { info: (...a) => calls.push(a), warn: () => {}, error: () => {} };
  createCatalogIpc({
    ipcMain, log,
    engine: engine || fakeEngine(),
    repos: { snapshots: snapshots || fakeSnapshots() },
  });
  const send = (name, ...args) => handlers.get(name)({}, ...args);
  return { handlers, send, calls };
}

// The seam the real repos.snapshots offers. listProviderIds is required: read()
// iterates providers and must not be handed a whole-database scan. setLastSync is
// the only writer of "how the last attempt ended", and it answers false rather
// than inventing a provider that never produced a snapshot.
function fakeSnapshots(over = {}) {
  return { listProviderIds: () => [], read: () => null, write: () => {},
    setLastSync: () => true,
    getHealth: () => null, setHealth: () => {}, ...over };
}

const fakeEngine = (overrides = {}) => ({
  loadCache() {}, syncAll: async (o = {}) => ({ catalogCount: 1, skipped: !o.force }),
  scoreRows: (rows) => rows.map((r) => ({ ...r, score: 50, score_source: 'aa', rank: 1,
    matched_id: r.id, score_basis: ['aa'] })),
  isNonTextModel: () => false,
  summary: () => ({ catalogCount: 1, sources: [] }),
  syncIfUnscored: async () => ({ synced: false, scored: 0, unscored: [] }),
  state: { lastSyncAt: 1000, catalog: { rows: [] } },
  ...overrides,
});

test('registers exactly the five channels spec §6 names', () => {
  const { handlers } = harness();
  assert.deepEqual([...handlers.keys()].sort(),
    ['catalog:fetch-info', 'catalog:health', 'catalog:ingest', 'catalog:read', 'catalog:sources']);
});

test('catalog:read re-scores stored rows and fetches nothing, writes nothing, publishes nothing', async () => {
  let wrote = 0; let readCount = 0; let fetched = 0;
  const snapshots = fakeSnapshots({
    listProviderIds: () => ['nara'],
    read: (id) => { readCount += 1; return { createdAt: 1, fetchedAt: 1000, models: {
      m: { name: 'M', first_seen: 1, last_seen: 1000 } },
      lastGoodRows: [{ id: 'm', name: 'M', context_tokens: 10 }], lastSync: null }; },
    write: () => { wrote += 1; },
  });
  const engine = fakeEngine({ syncAll: async () => { fetched += 1; return engine_summary(); } });
  const { send } = harness({ snapshots, engine });
  const out = await send('catalog:read');
  assert.equal(wrote, 0);
  assert.equal(fetched, 0, 'a read never touches the network');
  assert.equal(readCount, 1);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].score, 50, 'scored against today\'s reference, not the day it was fetched');
  assert.equal(out.rows[0].is_new, false, 'recomputed from first_seen, never read from a column');
  assert.equal(out.oldestFetch, 1000);
  assert.equal(out.stale, false, 'stale here means "the last attempt failed", not "the rows are old"');
});

test('catalog:read reports the last failed attempt as stale while serving the rows it did get', async () => {
  const snapshots = fakeSnapshots({ listProviderIds: () => ['nara'], read: () => ({ createdAt: 1,
    fetchedAt: 1000, models: { m: { name: 'M', first_seen: 1, last_seen: 1000 } },
    lastGoodRows: [{ id: 'm' }], lastSync: { at: 2000, ok: false, warning: 'HTTP 503' } }) });
  const out = await harness({ snapshots }).send('catalog:read');
  assert.equal(out.stale, true);
  assert.equal(out.warning, 'HTTP 503');
  assert.equal(out.rows.length, 1);
});

test('catalog:ingest maps the adapter rows, scores them and returns the changes', async () => {
  const snapshots = { read: () => null, write: () => {}, setLastSync: () => true };
  const { send } = harness({ snapshots });
  const out = await send('catalog:ingest', 'nara', [{ id: 'a/b', name: 'A B', context_window: 1000 }]);
  assert.equal(out.ok, true);
  assert.equal(out.rows[0].id, 'a/b');
  assert.equal(out.rows[0].score, 50);
  assert.equal(out.changes.baseline, true, 'the first snapshot flags nothing new');
});

test('catalog:ingest refuses an empty or malformed roster with INVALID_PROVIDER_PAYLOAD', async () => {
  const { send } = harness();
  await assert.rejects(() => send('catalog:ingest', 'nara', []),
    (e) => e.code === 'INVALID_PROVIDER_PAYLOAD');
  await assert.rejects(() => send('catalog:ingest', 'nara', [{ name: 'no id' }]),
    (e) => e.code === 'INVALID_PROVIDER_PAYLOAD');
  await assert.rejects(() => send('catalog:ingest', 'nara', [{ id: 'a' }, { id: 'a' }]),
    (e) => e.code === 'INVALID_PROVIDER_PAYLOAD', 'a duplicate id is as unusable as a missing one');
});

test('an empty roster with rows already stored is served as stale, not as a removal', async () => {
  const snapshots = fakeSnapshots({ read: () => ({ createdAt: 1, fetchedAt: 500,
    models: { m: { name: 'M', first_seen: 1, last_seen: 500 } },
    lastGoodRows: [{ id: 'm', name: 'M' }], lastSync: { at: 500, ok: true, warning: null } }) });
  const out = await harness({ snapshots }).send('catalog:ingest', 'nara', []);
  assert.equal(out.ok, true);
  assert.equal(out.stale, true, 'a provider that answered nothing is not a provider that removed everything');
  assert.equal(out.rows.length, 1);
  assert.equal(out.changes, null, 'and no diff is claimed for a sync that never happened');
});

test('catalog:ingest falls back to last-good rows and marks stale when the snapshot rejects the drop', async () => {
  const many = {}; for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) many[id] =
    { name: id.toUpperCase(), first_seen: 1, last_seen: 2 };
  const snapshots = { read: () => ({ createdAt: 1, fetchedAt: 2, models: many,
    lastGoodRows: Object.keys(many).map((id) => ({ id, name: id.toUpperCase() })),
    lastSync: { at: 2, ok: true, warning: null } }), write: () => {}, setLastSync: () => true };
  const out = await harness({ snapshots }).send('catalog:ingest', 'nara', [{ id: 'a', name: 'A' }]);
  assert.equal(out.stale, true, 'a quarantined drop is served as stale, not as a removal');
  assert.equal(out.rows.length, 6, 'the last-good roster is what the page shows');
  assert.match(out.warning, /awaiting confirmation/);
});

test('two overlapping ingests for one provider cost one snapshot write', async () => {
  let writes = 0;
  const snapshots = { read: () => null, write: () => { writes += 1; }, setLastSync: () => true };
  const { send } = harness({ snapshots });
  const rows = [{ id: 'a/b', name: 'A B' }];
  await Promise.all([send('catalog:ingest', 'nara', rows), send('catalog:ingest', 'nara', rows)]);
  assert.equal(writes, 1, 'the door: one fetch, one write, one diff per overlap');
});

test('catalog:health stores the verdict with the latency sample and answers p50', async () => {
  const health = [];
  const snapshots = fakeSnapshots({
    getHealth: () => ({ status: 'healthy', at: 1, latencies: [{ at: 1, ms: 100 }, { at: 2, ms: 300 }, { at: 3, ms: 200 }] }),
    setHealth: (p, m, h) => health.push(h),
  });
  const out = await harness({ snapshots }).send('catalog:health', 'nara', 'a/b',
    { status: 'healthy', note: 'Responded normally', httpStatus: 200, at: 4, timeMs: 250 });
  assert.deepEqual(out, { p50: 225, samples: 4 }, 'median of 100, 200, 250, 300 → the middle pair averaged');
  assert.equal(health.length, 1);
  assert.equal(health[0].latencies.length, 4, 'the new sample joined the ring');
  assert.equal(health[0].latencies[3].ms, 250, 'newest last');
  assert.equal(health[0].status, 'healthy');
});

test('a health result with no usable latency records the verdict without a sample', async () => {
  let stored;
  const snapshots = fakeSnapshots({ setHealth: (p, m, h) => { stored = h; } });
  const out = await harness({ snapshots }).send('catalog:health', 'nara', 'a/b',
    { status: 'unreachable', note: 'No response', httpStatus: 0, at: 5 });
  assert.deepEqual(out, { p50: null, samples: 0 });
  assert.deepEqual(stored.latencies, []);
  assert.equal(stored.status, 'unreachable');
});

test('catalog:health keeps only the last 20 samples', async () => {
  const long = Array.from({ length: 20 }, (_, i) => ({ at: i, ms: i }));
  let stored;
  const snapshots = fakeSnapshots({
    getHealth: () => ({ status: 'healthy', at: 1, latencies: long }),
    setHealth: (p, m, h) => { stored = h; },
  });
  await harness({ snapshots }).send('catalog:health', 'nara', 'a/b',
    { status: 'healthy', at: 99, timeMs: 500 });
  assert.equal(stored.latencies.length, 20);
  assert.equal(stored.latencies[0].ms, 1, 'the oldest sample fell off');
  assert.equal(stored.latencies[19].ms, 500);
});

// The controller's hard rule, pinned here: opening Settings › Catalog draws these
// four lines, and drawing them may not download anything. syncAll's TTL is "older
// than 15 minutes is due", which on a machine that has never fetched means "fetch
// five megabytes because a page opened" — so the non-forced half of this channel
// is engine.summary(), a pure read of state. See ipc.js for the full reason.
test('catalog:sources syncs when forced and reports without the TTL otherwise', async () => {
  const seen = [];
  const engine = fakeEngine({
    syncAll: async ({ force } = {}) => { seen.push(Boolean(force)); return engine_summary(); },
    summary: () => engine_summary(),
  });
  const { send } = harness({ engine, snapshots: { read: () => null, write: () => {}, setLastSync: () => true } });
  const forced = await send('catalog:sources', { force: true });
  const reported = await send('catalog:sources', {});
  await send('catalog:sources');
  assert.deepEqual(seen, [true], 'only a forced call reaches syncAll, and only once');
  assert.deepEqual(reported, forced, 'both halves answer with the engine summary');
});

test('catalog:sources answers with the engine summary, not with a bare ok', async () => {
  const engine = fakeEngine({ syncAll: async () => engine_summary() });
  const out = await harness({ engine }).send('catalog:sources', { force: true });
  assert.deepEqual(out, engine_summary());
});

function engine_summary() { return { catalogCount: 3, syncing: false, sources: [], fits: {} }; }

// The stored row is built by providerRow itself, so the two tests below diff a
// real shape against a real shape rather than a hand-written fixture that happens
// to match on the fields the author remembered.
const storedRow = (over = {}) => ({ ...providerRow({ id: 'a/b', name: 'A B',
  context_window: 1000, pricing: { input: 2 } }, 'nara'), ...over });

test('catalog:fetch-info says matched when nothing the provider publishes moved', async () => {
  const snapshots = fakeSnapshots({ read: () => ({ createdAt: 1, fetchedAt: 2,
    models: { 'a/b': { name: 'A B', first_seen: 1, last_seen: 2 } },
    lastGoodRows: [storedRow()], lastSync: null }) });
  const rows = [{ id: 'a/b', name: 'A B', context_window: 1000, pricing: { input: 2 } }];
  const out = await harness({ snapshots }).send('catalog:fetch-info', 'nara', 'a/b', rows);
  assert.equal(out.outcome, 'matched');
  assert.equal(out.changes, null, 'the merge changed nothing to report');
});

// The submitted row re-publishes the stored price on purpose. The brief sent a
// thinner row, and then two more fields HAD moved — the provider stopped saying
// anything about price at all — so the diff the assertion reads as "context moved"
// was three changes, not one. The implementation is right to report a price the
// provider no longer states; the fixture was wrong to hide it.
test('catalog:fetch-info lists each field that moved, old to new', async () => {
  const snapshots = fakeSnapshots({ read: () => ({ createdAt: 1, fetchedAt: 2,
    models: { 'a/b': { name: 'A B', first_seen: 1, last_seen: 2 } },
    lastGoodRows: [storedRow({ context_tokens: 1000 })], lastSync: null }) });
  const out = await harness({ snapshots }).send('catalog:fetch-info', 'nara', 'a/b',
    [{ id: 'a/b', name: 'A B', context_window: 2000, pricing: { input: 2 } }]);
  assert.equal(out.outcome, 'updated');
  assert.deepEqual(out.changes, [{ field: 'context_tokens', from: 1000, to: 2000 }]);
});

// The other half of the note above: a provider that stops publishing a fact IS
// reporting a change, and saying so is the honest behaviour. Pinned so fixing the
// fixture above cannot be read as softening the diff.
test('a field the provider stopped publishing is reported as moved to null', async () => {
  const snapshots = fakeSnapshots({ read: () => ({ createdAt: 1, fetchedAt: 2,
    models: { 'a/b': { name: 'A B', first_seen: 1, last_seen: 2 } },
    lastGoodRows: [storedRow()], lastSync: null }) });
  const out = await harness({ snapshots }).send('catalog:fetch-info', 'nara', 'a/b',
    [{ id: 'a/b', name: 'A B', context_window: 1000 }]);
  assert.equal(out.outcome, 'updated');
  assert.deepEqual(out.changes.filter((c) => c.field === 'cost_in_per_m'),
    [{ field: 'cost_in_per_m', from: 2, to: null }]);
});

test('catalog:fetch-info on a model with no stored row reports what it just learned', async () => {
  const snapshots = fakeSnapshots({ read: () => null });
  const out = await harness({ snapshots }).send('catalog:fetch-info', 'nara', 'a/b',
    [{ id: 'a/b', name: 'A B', context_window: 2000 }]);
  assert.equal(out.outcome, 'updated', 'a first read is a change worth naming');
  assert.ok(out.changes.some((c) => c.field === 'context_tokens' && c.from === null && c.to === 2000));
});

test('catalog:fetch-info says no-match when the reference knows nothing of it', async () => {
  const engine = fakeEngine({ scoreRows: (rows) => rows.map((r) => ({ ...r, matched_id: null, score: null })) });
  const snapshots = { read: () => null, write: () => {}, setLastSync: () => true };
  const out = await harness({ snapshots, engine }).send('catalog:fetch-info', 'nara', 'x/y',
    [{ id: 'x/y', name: 'X Y' }]);
  assert.equal(out.outcome, 'no-match');
});

test('catalog:fetch-info says no-longer-listed when the provider dropped it', async () => {
  const snapshots = { read: () => null, write: () => {}, setLastSync: () => true };
  const out = await harness({ snapshots }).send('catalog:fetch-info', 'nara', 'a/b',
    [{ id: 'other', name: 'Other' }]);
  assert.equal(out.outcome, 'no-longer-listed');
});

test('only the fields the provider publishes are compared — never a derived score', () => {
  for (const derived of ['score', 'score_source', 'rank', 'matched_id', 'filled_from_catalog']) {
    assert.ok(!COMPARE_FIELDS.includes(derived), `${derived} must not appear in a diff`);
  }
  assert.ok(COMPARE_FIELDS.includes('context_tokens'));
});

test('diffRow reads changed fields with the exact old and new values', () => {
  assert.deepEqual(diffRow({ context_tokens: 1, tools: null }, { context_tokens: 2, tools: true }),
    [{ field: 'context_tokens', from: 1, to: 2 }, { field: 'tools', from: null, to: true }]);
  assert.deepEqual(diffRow({ a: 1 }, { a: 1 }), []);
});

// ---------------------------------------------------------------------------
// The door is per provider, and the read path is per provider too.
// ---------------------------------------------------------------------------

test('the door is per provider: two providers in the same moment cost two writes', async () => {
  let writes = 0;
  const snapshots = { read: () => null, write: () => { writes += 1; }, setLastSync: () => true };
  const { send } = harness({ snapshots });
  await Promise.all([
    send('catalog:ingest', 'nara', [{ id: 'a', name: 'A' }]),
    send('catalog:ingest', 'experiential', [{ id: 'b', name: 'B' }]),
  ]);
  assert.equal(writes, 2, 'one in-flight job per provider, not one for the whole app');
});

test('catalog:read serves every provider it has a snapshot for and never writes one', async () => {
  let wrote = 0;
  const held = {
    nara: { createdAt: 1, fetchedAt: 1000, models: { m: { name: 'M', first_seen: 1, last_seen: 1000 } },
      lastGoodRows: [{ id: 'nara/m', name: 'M' }], lastSync: { at: 1000, ok: true, warning: null } },
    nexum: { createdAt: 1, fetchedAt: 400, models: { k: { name: 'K', first_seen: 1, last_seen: 400 } },
      lastGoodRows: [{ id: 'nexum/k', name: 'K' }], lastSync: { at: 300, ok: false, warning: 'HTTP 429' } },
  };
  const snapshots = fakeSnapshots({ listProviderIds: () => ['nara', 'nexum'],
    read: (id) => held[id], write: () => { wrote += 1; } });
  const out = await harness({ snapshots }).send('catalog:read');
  assert.equal(wrote, 0);
  assert.equal(out.rows.length, 2, 'both rosters, one reply');
  assert.deepEqual(out.rows.map((r) => r.id).sort(), ['nara/m', 'nexum/k']);
  assert.equal(out.oldestFetch, 400, 'the oldest fetch, not the newest');
  assert.equal(out.stale, true, 'one provider whose last attempt failed marks the read stale');
  assert.equal(out.warning, 'HTTP 429');
});

// ---------------------------------------------------------------------------
// match_ids and quality_proxy_ids are provider facts: they travel through the
// ingest, through summary_json, and back out of catalog:read. Without them a row
// scoring.js can only reach by an alias stops scoring on the second read — the
// reference's wan-2.0 is unreachable by any generated spelling.
// ---------------------------------------------------------------------------

test('an adapter alias survives ingest and catalog:read, and it is what carries the score', async (t) => {
  const { snapshots, sources, engine, summaryJson } = await refBacked(t);
  const { send } = harness({ snapshots, engine });

  const out = await send('catalog:ingest', 'nara', [
    // Reachable only by the alias the adapter declared: no generated spelling of
    // `nara/wan-x-rebrand` names the catalog's `alibaba/wan-2.0`.
    { id: 'nara/wan-x-rebrand', name: 'Wan X', match_ids: ['alibaba/wan-2.0'] },
  ]);
  assert.equal(out.rows[0].score, 41, 'the alias is the only thing that found a score');
  assert.equal(out.rows[0].matched_id, 'alibaba/wan-2.0');
  assert.deepEqual(JSON.parse(summaryJson('nara/wan-x-rebrand')).match_ids,
    ['alibaba/wan-2.0', 'wan-x-rebrand'],
    'the adapter alias first, then the generated one, stored as the provider fact it is');

  const back = await send('catalog:read');
  assert.equal(back.rows.length, 1);
  assert.equal(back.rows[0].score, 41, 'the score survived the round trip, so the aliases did');
  assert.equal(back.rows[0].matched_id, 'alibaba/wan-2.0');
  assert.equal(sources.syncs, 0, 'and none of this fetched anything');
});

test('a row nothing matches scores null, and a -thinking route keeps its quality proxy after the read', async (t) => {
  const { snapshots, engine } = await refBacked(t);
  const { send } = harness({ snapshots, engine });

  const out = await send('catalog:ingest', 'nara', [
    { id: 'nara/nowhere-model', name: 'Nowhere' },
    { id: 'nara/deepseek-v4-thinking', name: 'DeepSeek V4 Thinking' },
  ]);
  const [first, second] = out.rows;
  assert.equal(first.score, null, 'never a guessed score');
  assert.equal(first.matched_id, null);
  assert.deepEqual(second.quality_proxy_ids, ['deepseek/deepseek-v4'],
    'declared here in main because the adapter said nothing, from the id alone');

  const back = await send('catalog:read');
  const stored = back.rows.find((r) => r.id === 'nara/deepseek-v4-thinking');
  assert.deepEqual(stored.quality_proxy_ids, ['deepseek/deepseek-v4'],
    'a provider fact, so DERIVED_FIELDS never strips it and a fallback row still borrows');
});

test('the aliases main generates never displace the ones the adapter declared', async () => {
  const { send } = harness();
  const out = await send('catalog:ingest', 'nara', [
    { id: 'a/b', name: 'A B', match_ids: ['z/curated-first', 'b'] },
  ]);
  assert.deepEqual(out.rows[0].match_ids, ['z/curated-first', 'b'],
    'declared first, generated after, deduped — lookupCatalogRow returns the FIRST verbatim hit');
});

// ---------------------------------------------------------------------------
// A failed attempt is recorded where the read path can find it, and a provider
// that never produced a snapshot is never invented by that recording.
// ---------------------------------------------------------------------------

test('a refused ingest records nothing at all: no provider row, no phantom snapshot', async (t) => {
  const { snapshots, engine } = await refBacked(t);
  const { send } = harness({ snapshots, engine });

  await assert.rejects(() => send('catalog:ingest', 'nara', []),
    (e) => e.code === 'INVALID_PROVIDER_PAYLOAD');
  assert.deepEqual(snapshots.listProviderIds(), [],
    'setLastSync answers false and writes nothing when no snapshot exists, so no phantom provider');
});

test('a quarantined drop is recorded as the last attempt, so the next read says stale', async (t) => {
  const { snapshots, engine } = await refBacked(t);
  const { send } = harness({ snapshots, engine });

  const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id: `nara/${id}`, name: id.toUpperCase() }));
  const first = await send('catalog:ingest', 'nara', six);
  assert.equal(first.ok, true);
  assert.equal(first.stale, false);
  const fetchedAt = snapshots.read('nara').fetchedAt;

  const quarantined = await send('catalog:ingest', 'nara', [{ id: 'nara/a', name: 'A' }]);
  assert.equal(quarantined.stale, true);
  assert.match(quarantined.warning, /awaiting confirmation/);
  assert.equal(quarantined.rows.length, 6, 'the last-good roster stands in for the quarantined drop');

  const back = await send('catalog:read');
  assert.equal(back.stale, true, 'the failed attempt outlived the call that failed');
  assert.match(back.warning, /awaiting confirmation/);
  assert.equal(back.rows.length, 6);
  assert.equal(snapshots.read('nara').fetchedAt, fetchedAt,
    'and the quarantine moved no fetch stamp: nothing was fetched');
});

/**
 * The real engine over the real store, with a disk that is two Maps.
 *
 * `writeCache` and `fetchAll` both throw, so a channel that reached the network or
 * the cache would fail the test that names it rather than quietly doing IO. `syncs`
 * counts anything that got past that, and the alias case asserts it stays zero.
 * The two cached documents are enough for the real merge to build two scored rows,
 * which is what makes the alias claims above worth anything.
 */
async function refBacked(t) {
  const store = await memoryStore(t);
  const cache = new Map();
  const sources = {
    SOURCES: [
      { id: 'models-dev-spec', name: 'models.dev (spec)', description: 'd' },
      { id: 'openrouter-public', name: 'OpenRouter (models)', description: 'd' },
      { id: 'openrouter-keyed', name: 'OpenRouter (benchmarks)', description: 'd' },
      { id: 'lmarena', name: 'LMArena (text)', description: 'd' },
    ],
    syncs: 0,
    readKey: () => '',
    rowCount: (id, p) => (p && p.data ? p.data.length : 0),
    writeCache: () => { throw new Error('these channels never write the cache'); },
    writeCacheFailure: () => false,
    readCache: (id) => (cache.has(id)
      ? { payload: cache.get(id), meta: { fetchedAt: '2026-09-30T10:00:00.000Z' } } : null),
    newestFetchedAt: () => '2026-09-30T10:00:00.000Z',
    hasPayload: (id) => cache.has(id),
    fetchAll: async () => { sources.syncs += 1; throw new Error('these channels never fetch'); },
  };
  cache.set('openrouter-public', { data: [
    { id: 'alibaba/wan-2.0', name: 'Wan 2.0', context_length: 8192,
      architecture: { output_modalities: ['text'] } },
    { id: 'deepseek/deepseek-v4', name: 'DeepSeek V4', context_length: 163840,
      architecture: { output_modalities: ['text'] } },
  ] });
  cache.set('openrouter-keyed', { data: [
    { model_permaslug: 'alibaba/wan-2.0', display_name: 'Wan 2.0',
      source: 'artificial-analysis', intelligence_index: 41 },
    { model_permaslug: 'deepseek/deepseek-v4', display_name: 'DeepSeek V4',
      source: 'artificial-analysis', intelligence_index: 44 },
  ] });
  const engine = createEngine({ sources, log: () => {} });
  engine.loadCache();
  return {
    store,
    snapshots: store.repos.snapshots,
    sources,
    engine,
    // The raw column, because the claim is about what the STORE kept, not about
    // what the repository chooses to hand back.
    summaryJson: (modelId) => store.db
      .prepare('SELECT summary_json FROM roster_snapshot WHERE provider_id = ? AND model_id = ?')
      .get('nara', modelId).summary_json,
  };
}
