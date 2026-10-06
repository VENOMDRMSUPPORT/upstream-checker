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
//
// Fix round 1 added a third seam: `providers`. Main does not own the connected set
// — the renderer does — but it is the only place that knows which providers still
// exist, so a roster for a provider the owner deleted can be refused here and
// nowhere else. And the handlers are wrapped twice over: `send` calls one direct,
// `crossIpc` sends one across the boundary that actually exists.
const test = require('node:test');
const assert = require('node:assert');
const { createCatalogIpc, COMPARE_FIELDS, diffRow } = require('../../src/catalog/ipc');
const { providerRow } = require('../../src/catalog/row');
const { createEngine } = require('../../src/catalog/engine');
const { memoryStore } = require('../helpers');

// A fake ipcMain that records handlers, plus a fake repos with the seam the real
// one has. No electron, no database: the channel contract is what is under test.
function harness({ snapshots, engine, providers } = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn) };
  const calls = [];
  const log = { info: (...a) => calls.push(a), warn: () => {}, error: () => {} };
  createCatalogIpc({
    ipcMain, log,
    engine: engine || fakeEngine(),
    repos: { snapshots: snapshots || fakeSnapshots(), providers: providers || fakeProviders() },
  });
  const send = (name, ...args) => handlers.get(name)({}, ...args);
  return { handlers, send, calls };
}

// The providers the fake store knows, in the shape the real repo answers: `get`
// takes an id and returns the row or null. Anything else is a provider that does
// not exist, and main must not serve a roster for one.
const KNOWN_PROVIDERS = ['nara', 'nexum', 'experiential'];
function fakeProviders(ids = KNOWN_PROVIDERS) {
  return { get: (id) => (ids.map(String).includes(String(id)) ? { id: String(id) } : null) };
}

/**
 * One call as the renderer actually sees it. Electron resolves an `ipcMain.handle`
 * value by STRUCTURE and turns a rejection into a fresh Error carrying only its
 * `message` — `err.code` is a property of an object left behind in main. A JSON
 * round trip is the deterministic half of that (functions, Errors and `undefined`
 * drop out of both), and the wrapped message is Electron's own prefix, which the
 * UI has to strip before a person reads it.
 */
function crossIpc(handlers, name, ...args) {
  return handlers.get(name)({}, ...args).then(
    (reply) => ({ rejected: false, reply: JSON.parse(JSON.stringify(reply)) }),
    (err) => ({ rejected: true,
      message: `Error invoking remote method '${name}': Error: ${err.message}` }),
  );
}

function wireHarness(over = {}) {
  const h = harness(over);
  return { ...h, call: (name, ...args) => crossIpc(h.handlers, name, ...args) };
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
  const out = await send('catalog:read', { providerIds: ['nara'] });
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
  const out = await harness({ snapshots }).send('catalog:read', { providerIds: ['nara'] });
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

// F5: an expected, actionable outcome is DATA. It used to reject with
// `err.code = 'INVALID_PROVIDER_PAYLOAD'`, and the assertion below passed — against
// a handler called directly, where the thrown object still had its code. Across a
// real ipcMain.handle only `err.message` crosses, so the next batch would have had
// a string to pattern-match. The same test now reads the resolved code, and
// `crossIpc` proves it survives the wire.
test('catalog:ingest refuses an empty or malformed roster with INVALID_PROVIDER_PAYLOAD', async () => {
  const { send } = harness();
  for (const models of [[], [{ name: 'no id' }], [{ id: 'a' }, { id: 'a' }]]) {
    const out = await send('catalog:ingest', 'nara', models);
    assert.equal(out.ok, false, 'a refused roster answers with a verdict, not a rejection');
    assert.equal(out.code, 'INVALID_PROVIDER_PAYLOAD');
    assert.equal(typeof out.message, 'string');
  }
  const notAnArray = await send('catalog:ingest', 'nara', { 0: { id: 'a' } });
  assert.equal(notAnArray.code, 'INVALID_PROVIDER_PAYLOAD', 'a non-array is the same bad payload');
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

// Two ways the click cannot honestly compare anything: the roster was refused, and
// the model is not in the roster at all. The first answers with the ingest's own
// verdict; the second with no-longer-listed. What it must never do is diff an empty
// published row against the stored one and tell the owner the provider unpublished
// every fact it has ever stated.
test('catalog:fetch-info reports the ingest refusal instead of a diff it never compared', async () => {
  const snapshots = fakeSnapshots({ read: () => ({ createdAt: 1, fetchedAt: 2,
    models: { 'a/b': { name: 'A B', first_seen: 1, last_seen: 2 } },
    lastGoodRows: [storedRow()], lastSync: null }) });
  const { send } = harness({ snapshots });

  const refused = await send('catalog:fetch-info', 'nara', 'a/b', [{ name: 'no id' }]);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'INVALID_PROVIDER_PAYLOAD');
  assert.equal('changes' in refused, false, 'no diff is claimed for a roster that was refused');

  const gone = await send('catalog:fetch-info', 'nara', 'a/b', [{ id: 'other', name: 'Other' }]);
  assert.equal(gone.ok, true);
  assert.equal(gone.outcome, 'no-longer-listed');
  assert.equal(gone.changes, null);
});

test('only the fields the provider publishes are compared — never a derived score', () => {
  for (const derived of ['score', 'score_source', 'rank', 'matched_id', 'filled_from_catalog']) {
    assert.ok(!COMPARE_FIELDS.includes(derived), `${derived} must not appear in a diff`);
  }
  assert.ok(COMPARE_FIELDS.includes('context_tokens'));
  assert.ok(COMPARE_FIELDS.includes('kind'), 'the provider-declared kind is a published fact, diffed like any other');
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

// F3 — spec §7's `#` column is the dense rank over the MERGED, connected view.
// Scoring one provider at a time is what made a two-provider read answer with two
// rank 1s: attachScores ranks the list it is handed (scoring.js:397-428), so one
// call per roster ranks each roster against itself. The reference merges and then
// ranks once (ref providers/index.js:625, then :693).
//
// The scorer below is deliberately the shape of `assignDenseRank` rather than the
// committed fake, which stamped rank 1 on every row and so could not see the bug:
// it dense-ranks whatever list it is given, and counts the calls.
test('catalog:read merges every connected provider, scores the merged list once and ranks it once', async () => {
  let wrote = 0;
  const SCORES = { 'nara/m': 40, 'nexum/k': 50 };
  const held = {
    nara: { createdAt: 1, fetchedAt: 1000, models: { m: { name: 'M', first_seen: 1, last_seen: 1000 } },
      lastGoodRows: [{ id: 'nara/m', name: 'M' }], lastSync: { at: 1000, ok: true, warning: null } },
    nexum: { createdAt: 1, fetchedAt: 400, models: { k: { name: 'K', first_seen: 1, last_seen: 400 } },
      lastGoodRows: [{ id: 'nexum/k', name: 'K' }], lastSync: { at: 300, ok: false, warning: 'HTTP 429' } },
  };
  const snapshots = fakeSnapshots({ listProviderIds: () => ['nara', 'nexum'],
    read: (id) => held[id], write: () => { wrote += 1; } });
  const scored = [];
  const engine = fakeEngine({ scoreRows: (rows) => {
    scored.push(rows.map((r) => r.id));
    const ordered = [...rows].sort((a, b) => SCORES[b.id] - SCORES[a.id]);
    const rankOf = new Map();
    let rank = 0; let previous = null;
    for (const row of ordered) {
      if (SCORES[row.id] !== previous) rank += 1;
      previous = SCORES[row.id];
      rankOf.set(row.id, rank);
    }
    return rows.map((r) => ({ ...r, score: SCORES[r.id], score_source: 'aa',
      matched_id: r.id, score_basis: ['aa'], rank: rankOf.get(r.id) }));
  } });
  const out = await harness({ snapshots, engine })
    .send('catalog:read', { providerIds: ['nara', 'nexum'] });
  assert.equal(wrote, 0);
  assert.deepEqual(scored, [['nara/m', 'nexum/k']],
    'one scoring pass over the merged rows, in provider order — not one per provider');
  assert.equal(out.rows.length, 2, 'both rosters, one reply');
  assert.deepEqual(out.rows.map((r) => r.id).sort(), ['nara/m', 'nexum/k']);
  assert.deepEqual(out.rows.map((r) => r.rank), [2, 1],
    'two providers, two ranks: the best score across the whole view is rank 1');
  assert.equal(new Set(out.rows.map((r) => r.rank)).size, 2, 'never two rank 1s in one view');
  assert.equal(out.oldestFetch, 400, 'the oldest fetch, not the newest');
  assert.equal(out.stale, true, 'one provider whose last attempt failed marks the read stale');
  assert.equal(out.warning, 'HTTP 429');
});

// ---------------------------------------------------------------------------
// F2 — the read is the CONNECTED view (ref §9 readConnected, which filtered on
// connections.connectedIds). Here the renderer owns PROVIDERS and isConnected, so
// it passes the set and main filters it against repos.providers. Two holes this
// closes: a provider the owner deleted used to be served forever, because the read
// iterated whoever had ever produced a snapshot; and a connected provider with no
// snapshot used to vanish, which reads to the owner as "it has no models".
// ---------------------------------------------------------------------------

test('catalog:read serves only the providers it was given, and never the ones it was not', async () => {
  let wrote = 0;
  const readOf = [];
  const held = {
    nara: { createdAt: 1, fetchedAt: 1000, models: { m: { name: 'M', first_seen: 1, last_seen: 1000 } },
      lastGoodRows: [{ id: 'nara/m', name: 'M' }], lastSync: { at: 1000, ok: true, warning: null } },
    'deleted-co': { createdAt: 1, fetchedAt: 900, models: { d: { name: 'D', first_seen: 1, last_seen: 900 } },
      lastGoodRows: [{ id: 'deleted-co/d', name: 'D' }], lastSync: { at: 900, ok: true, warning: null } },
  };
  const snapshots = fakeSnapshots({
    // The store still holds the deleted provider's roster: listProviderIds is not
    // the filter, the asked-for set is.
    listProviderIds: () => ['nara', 'deleted-co'],
    read: (id) => { readOf.push(id); return held[id]; },
    write: () => { wrote += 1; },
  });
  const out = await harness({ snapshots }).send('catalog:read', { providerIds: ['nara'] });
  assert.equal(wrote, 0);
  assert.deepEqual(readOf, ['nara'], 'a provider outside the connected set is not even read');
  assert.deepEqual(out.rows.map((r) => r.id), ['nara/m']);
  assert.deepEqual(out.providers.map((p) => p.providerId), ['nara']);
});

test('an absent or empty providerIds serves nothing — it is not "everything"', async () => {
  const readOf = [];
  const snapshots = fakeSnapshots({
    listProviderIds: () => ['nara'],
    read: (id) => { readOf.push(id); return { createdAt: 1, fetchedAt: 1, models: {},
      lastGoodRows: [{ id: 'nara/m', name: 'M' }], lastSync: null }; },
  });
  const { send } = harness({ snapshots });
  for (const query of [undefined, {}, { providerIds: [] }, { providerIds: null }]) {
    const out = await send('catalog:read', query);
    assert.deepEqual(out.rows, [], `${JSON.stringify(query)} cannot mean "the whole database"`);
    assert.deepEqual(out.providers, []);
  }
  assert.deepEqual(readOf, [], 'and nothing was read to find out');
});

test('a connected provider with no snapshot is named with NO_SNAPSHOT, not dropped', async () => {
  const snapshots = fakeSnapshots({
    listProviderIds: () => ['nara'],
    read: (id) => (id === 'nara' ? { createdAt: 1, fetchedAt: 1000,
      models: { m: { name: 'M', first_seen: 1, last_seen: 1000 } },
      lastGoodRows: [{ id: 'nara/m', name: 'M' }], lastSync: { at: 1000, ok: true, warning: null } } : null),
  });
  const out = await harness({ snapshots }).send('catalog:read', { providerIds: ['nara', 'nexum'] });
  assert.equal(out.rows.length, 1);
  const nexum = out.providers.find((p) => p.providerId === 'nexum');
  assert.equal(nexum.ok, false, 'the entry is a verdict, not a row');
  assert.equal(nexum.code, 'NO_SNAPSHOT', 'ref readConnected: a missing provider reads as "it has no models" unless it is named');
  assert.equal(nexum.total, 0);
  assert.equal(typeof nexum.message, 'string');
});

test('catalog:read refuses a provider id that is not in repos.providers, even with a snapshot on disk', async () => {
  const readOf = [];
  const held = {
    nara: { createdAt: 1, fetchedAt: 1000, models: { m: { name: 'M', first_seen: 1, last_seen: 1000 } },
      lastGoodRows: [{ id: 'nara/m', name: 'M' }], lastSync: null },
    ghost: { createdAt: 1, fetchedAt: 500, models: { g: { name: 'G', first_seen: 1, last_seen: 500 } },
      lastGoodRows: [{ id: 'ghost/g', name: 'G' }], lastSync: null },
  };
  const snapshots = fakeSnapshots({ listProviderIds: () => ['nara', 'ghost'],
    read: (id) => { readOf.push(id); return held[id]; } });
  const out = await harness({ snapshots, providers: fakeProviders(['nara']) })
    .send('catalog:read', { providerIds: ['nara', 'ghost'] });
  assert.deepEqual(readOf, ['nara'], 'a deleted provider roster is never served');
  assert.deepEqual(out.rows.map((r) => r.id), ['nara/m']);
  const ghost = out.providers.find((p) => p.providerId === 'ghost');
  assert.equal(ghost.ok, false);
  assert.equal(ghost.code, 'NOT_FOUND');
});

// ---------------------------------------------------------------------------
// match_ids and quality_proxy_ids are provider facts: they travel through the
// ingest, through summary_json, and back out of catalog:read. Without them a row
// scoring.js can only reach by an alias stops scoring on the second read — the
// reference's wan-2.0 is unreachable by any generated spelling.
// ---------------------------------------------------------------------------

test('an adapter alias survives ingest and catalog:read, and it is what carries the score', async (t) => {
  const { snapshots, sources, engine, providers, summaryJson } = await refBacked(t);
  const { send } = harness({ snapshots, engine, providers });

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

  const back = await send('catalog:read', { providerIds: ['nara'] });
  assert.equal(back.rows.length, 1);
  assert.equal(back.rows[0].score, 41, 'the score survived the round trip, so the aliases did');
  assert.equal(back.rows[0].matched_id, 'alibaba/wan-2.0');
  assert.equal(sources.syncs, 0, 'and none of this fetched anything');
});

test('a row nothing matches scores null, and a -thinking route keeps its quality proxy after the read', async (t) => {
  const { snapshots, engine, providers } = await refBacked(t);
  const { send } = harness({ snapshots, engine, providers });

  const out = await send('catalog:ingest', 'nara', [
    { id: 'nara/nowhere-model', name: 'Nowhere' },
    { id: 'nara/deepseek-v4-thinking', name: 'DeepSeek V4 Thinking' },
  ]);
  const [first, second] = out.rows;
  assert.equal(first.score, null, 'never a guessed score');
  assert.equal(first.matched_id, null);
  assert.deepEqual(second.quality_proxy_ids, ['deepseek/deepseek-v4'],
    'declared here in main because the adapter said nothing, from the id alone');

  const back = await send('catalog:read', { providerIds: ['nara'] });
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
// F1 — Fetch information answers one question: did the PROVIDER change what it
// publishes? The committed version diffed the stored row against the SCORED row,
// and attachScores → fillFromCatalog (scoring.js:366-388) writes up to eleven
// reference-borrowed values into COMPARE_FIELDS, while providerRowSnapshot
// (snapshot.js:87-95) re-blanks exactly those before storing. So every field a thin
// row borrows diffs on every click — `context_tokens: null → 8192`,
// `output_modalities: "" → "text"` — and a row with no stored twin reported the
// borrow as "what it just learned". The suite was blind to it because the fake
// scorer never fills; these two cases run the REAL engine over the REAL store.
// ---------------------------------------------------------------------------

test('a value borrowed from the reference is never reported as something the provider changed', async (t) => {
  const { snapshots, engine, providers, sources } = await refBacked(t, { freshCache: true });
  const { send } = harness({ snapshots, engine, providers });
  // The provider publishes a name and nothing else. The reference has 8192 context
  // and text output for this model, so the row that reaches the page is filled.
  const thin = [{ id: 'nara/alibaba/wan-2.0', name: 'Wan 2.0' }];

  const first = await send('catalog:ingest', 'nara', thin);
  assert.equal(first.rows[0].context_tokens, 8192, 'the real fillFromCatalog borrowed it');
  assert.ok(first.rows[0].filled_from_catalog.includes('context_tokens'));
  assert.equal(snapshots.read('nara').lastGoodRows[0].context_tokens, null,
    'and the stored row is the provider\'s own facts again — that blank is what made every click a "change"');

  const again = await send('catalog:fetch-info', 'nara', 'nara/alibaba/wan-2.0', thin);
  assert.equal(again.outcome, 'matched',
    'the button promises "either identical, or the provider changed something"');
  assert.equal(again.changes, null, 'a catalog borrow is neither');
  assert.ok(again.borrowed.includes('context_tokens') && again.borrowed.includes('output_modalities'),
    `reference provenance, said where it belongs: ${JSON.stringify(again.borrowed)}`);
  assert.equal(sources.syncs, 0, 'and a click inside the TTL rebuilds from the cache without fetching');

  // The other half: the provider DID move one fact. The diff is that fact alone —
  // not the two the reference lends.
  const moved = await send('catalog:fetch-info', 'nara', 'nara/alibaba/wan-2.0',
    [{ id: 'nara/alibaba/wan-2.0', name: 'Wan 2.0 Turbo' }]);
  assert.equal(moved.outcome, 'updated');
  assert.deepEqual(moved.changes, [{ field: 'name', from: 'Wan 2.0', to: 'Wan 2.0 Turbo' }]);
  for (const change of moved.changes) {
    assert.ok(!moved.borrowed.includes(change.field),
      `${change.field} is borrowed; it may never appear as a provider change`);
  }
});

test('a model with no stored row reports what the PROVIDER published, not what the reference lent', async (t) => {
  const { snapshots, engine, providers } = await refBacked(t, { freshCache: true });
  const { send } = harness({ snapshots, engine, providers });

  const out = await send('catalog:fetch-info', 'nara', 'nara/alibaba/wan-2.0',
    [{ id: 'nara/alibaba/wan-2.0', name: 'Wan 2.0', context_window: 4096 }]);
  assert.equal(out.outcome, 'updated', 'a first read is still a change worth naming');
  assert.deepEqual(out.changes.filter((c) => c.field === 'context_tokens'),
    [{ field: 'context_tokens', from: null, to: 4096 }],
    'the provider said 4096 — the reference says 8192, and the provider is what this button reports');
  assert.equal(out.changes.some((c) => c.field === 'output_modalities'), false,
    'the reference answers "text" for output; the provider never said it, so it is not a fact it published');
  assert.ok(out.after.context_tokens === 4096, 'the scored row still carries what the page shows');
});

// F3 over the real merge: one model behind two hosts is one rank position, not two.
test('the same model served by two providers collapses to one rank position and agrees on catalog_rank', async (t) => {
  const { snapshots, engine, providers, sources } = await refBacked(t);
  const { send } = harness({ snapshots, engine, providers });

  await send('catalog:ingest', 'nara', [
    { id: 'nara/alibaba/wan-2.0', name: 'Wan 2.0' },
    { id: 'nara/deepseek/deepseek-v4', name: 'DeepSeek V4' },
  ]);
  await send('catalog:ingest', 'nexum', [{ id: 'nexum/alibaba/wan-2.0', name: 'Wan 2.0' }]);

  const out = await send('catalog:read', { providerIds: ['nara', 'nexum'] });
  assert.equal(out.rows.length, 3, 'three rows from two connected providers');
  const byId = Object.fromEntries(out.rows.map((r) => [r.id, r]));
  assert.equal(byId['nara/deepseek/deepseek-v4'].rank, 1, 'the best score in the whole merged view');
  const wans = ['nara/alibaba/wan-2.0', 'nexum/alibaba/wan-2.0'].map((id) => byId[id]);
  assert.deepEqual(wans.map((r) => r.rank), [2, 2],
    'one model, one rank position — a per-provider pass would have made nexum\'s Wan rank 1');
  assert.equal(wans[0].catalog_rank, wans[1].catalog_rank,
    'the reference rank belongs to the model, not to the roster it arrived on');
  assert.deepEqual(out.rows.map((r) => r.rank).sort(), [1, 2, 2]);
  assert.equal(sources.syncs, 0, 'and none of it fetched');
});

// ---------------------------------------------------------------------------
// F4 — a provider id is not a free string. validateProviderRows checks the roster,
// not who sent it, so a mistyped id used to create a snapshot_meta row and a
// roster_snapshot set for a provider that does not exist — and with no connected
// filter, read() then served it forever. ref §9 step 1: get(id) unknown → NOT_FOUND,
// asked BEFORE anything is fetched or written.
// ---------------------------------------------------------------------------

test('catalog:ingest refuses a provider main does not know and writes nothing at all', async (t) => {
  const { snapshots, engine, providers, store } = await refBacked(t);
  const { send } = harness({ snapshots, engine, providers });

  const out = await send('catalog:ingest', 'ghost', [{ id: 'ghost/a', name: 'A' }]);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'NOT_FOUND');
  assert.match(out.message, /ghost/, 'and says which id it could not find');
  assert.equal(snapshots.listProviderIds().includes('ghost'), false, 'no snapshot_meta row');
  assert.equal(store.db.prepare(
    'SELECT COUNT(*) AS n FROM roster_snapshot WHERE provider_id = ?').get('ghost').n, 0,
    'no roster rows either: the refusal happens before the door and before the write');
});

test('an unknown provider is refused before the network pass, on fetch-info too, and health never writes for it', async () => {
  const syncs = [];
  const health = [];
  const engine = fakeEngine({ syncAll: async (o = {}) => { syncs.push(o); return engine_summary(); } });
  const snapshots = fakeSnapshots({ setHealth: (p, m, h) => health.push([p, m, h]) });
  const { send } = harness({ engine, snapshots, providers: fakeProviders(['nara']) });

  const out = await send('catalog:fetch-info', 'ghost', 'ghost/a', [{ id: 'ghost/a', name: 'A' }]);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'NOT_FOUND');
  assert.deepEqual(syncs, [], 'nothing was fetched for a provider that does not exist');

  const probe = await send('catalog:health', 'ghost', 'ghost/a', { status: 'healthy', at: 1, timeMs: 10 });
  assert.equal(probe.ok, false);
  assert.equal(probe.code, 'NOT_FOUND');
  assert.deepEqual(health, [], 'and no health row for a provider that does not exist');
});

// ---------------------------------------------------------------------------
// F5 — the error contract, across the boundary that actually exists.
//
// `ipcMain.handle` resolves by structure and turns a rejection into a new Error
// carrying only its message: an `err.code` set in main is gone by the time the
// renderer sees it, wrapped in `Error invoking remote method 'catalog:ingest': `.
// The handlers used to be tested by calling them directly, which handed back the
// original object — `assert.rejects(..., e => e.code === ...)` passed and proved
// nothing. Expected, actionable outcomes therefore RESOLVE as
// `{ ok: false, code, message }`; only a genuine programmer error rejects.
// Everything below goes through the serialization the channel really does.
// ---------------------------------------------------------------------------

const syncInProgressEngine = () => fakeEngine({
  syncAll: async () => {
    const err = new Error('sync already in progress');
    err.code = 'SYNC_IN_PROGRESS';
    throw err;
  },
  summary: () => engine_summary(),
});

test('every expected outcome crosses the wire as data, with its code intact', async () => {
  const six = {}; for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) six[id] =
    { name: id.toUpperCase(), first_seen: 1, last_seen: 2 };
  const quarantinedWithoutRows = { createdAt: 1, fetchedAt: 2, models: six,
    lastGoodRows: [], lastSync: { at: 2, ok: true, warning: null } };
  const cases = [
    ['catalog:ingest', 'INVALID_PROVIDER_PAYLOAD', ['nara', []],
      fakeSnapshots({ read: () => null })],
    ['catalog:ingest', 'INVALID_PROVIDER_PAYLOAD', ['nara', [{ name: 'no id' }]],
      fakeSnapshots({ read: () => null })],
    ['catalog:ingest', 'NOT_FOUND', ['ghost', [{ id: 'ghost/a', name: 'A' }]],
      fakeSnapshots({ read: () => null })],
    // A drop the snapshot refuses, with no last-good roster to stand in: the verdict
    // is the answer, because serving an empty list would claim the provider has none.
    ['catalog:ingest', 'SUSPICIOUS_PROVIDER_DROP', ['nara', [{ id: 'a', name: 'A' }]],
      fakeSnapshots({ read: () => quarantinedWithoutRows })],
    ['catalog:fetch-info', 'NOT_FOUND', ['ghost', 'ghost/a', [{ id: 'ghost/a' }]],
      fakeSnapshots({ read: () => null })],
    ['catalog:health', 'NOT_FOUND', ['ghost', 'ghost/a', { status: 'healthy', at: 1, timeMs: 5 }],
      fakeSnapshots()],
    ['catalog:sources', 'SYNC_IN_PROGRESS', [{ force: true }], fakeSnapshots()],
  ];
  for (const [channel, code, args, snapshots] of cases) {
    const out = await wireHarness({ snapshots, engine: syncInProgressEngine() })
      .call(channel, ...args);
    assert.equal(out.rejected, false, `${channel} answered ${code} by rejecting — nothing crosses that way`);
    assert.equal(out.reply.ok, false, `${channel} said ${code} without saying so in the payload`);
    assert.equal(out.reply.code, code, `${channel}: the code must be DATA to survive the wire`);
    assert.equal(typeof out.reply.message, 'string');
    assert.ok(out.reply.message.length > 0, `${channel} must say what happened in words too`);
  }
});

test('a success reply survives the same round trip, and a programmer error is still a rejection', async () => {
  const snapshots = fakeSnapshots({
    listProviderIds: () => ['nara'],
    read: () => ({ createdAt: 1, fetchedAt: 1000, models: { m: { name: 'M', first_seen: 1, last_seen: 1000 } },
      lastGoodRows: [{ id: 'm', name: 'M' }], lastSync: null }),
  });
  const wired = wireHarness({ snapshots });
  const read = await wired.call('catalog:read', { providerIds: ['nara'] });
  assert.equal(read.rejected, false);
  assert.equal(read.reply.rows.length, 1, 'rows cross intact');
  assert.deepEqual(read.reply.providers.map((p) => [p.providerId, p.code]), [['nara', null]]);

  const ingest = await wired.call('catalog:ingest', 'nara', [{ id: 'a/b', name: 'A B' }]);
  assert.equal(ingest.rejected, false);
  assert.equal(ingest.reply.ok, true);
  assert.equal(ingest.reply.rows[0].score, 50);

  // The half that keeps `catch` honest: an error nobody named a code for is a bug,
  // and a bug must not be dressed up as an outcome.
  const broken = wireHarness({ snapshots, engine: fakeEngine({
    summary: () => { throw new TypeError('cannot read properties of undefined'); },
  }) });
  const failed = await broken.call('catalog:sources', {});
  assert.equal(failed.rejected, true, 'a programmer error still rejects');
  assert.match(failed.message, /^Error invoking remote method 'catalog:sources': Error: /,
    "Electron's prefix is what the UI then has to strip (F6)");
});

// ---------------------------------------------------------------------------
// A failed attempt is recorded where the read path can find it, and a provider
// that never produced a snapshot is never invented by that recording.
// ---------------------------------------------------------------------------

test('a refused ingest records nothing at all: no provider row, no phantom snapshot', async (t) => {
  const { snapshots, engine, providers } = await refBacked(t);
  const { send } = harness({ snapshots, engine, providers });

  const out = await send('catalog:ingest', 'nara', []);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'INVALID_PROVIDER_PAYLOAD');
  assert.deepEqual(snapshots.listProviderIds(), [],
    'setLastSync answers false and writes nothing when no snapshot exists, so no phantom provider');
});

test('a quarantined drop is recorded as the last attempt, so the next read says stale', async (t) => {
  const { snapshots, engine, providers } = await refBacked(t);
  const { send } = harness({ snapshots, engine, providers });

  const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id: `nara/${id}`, name: id.toUpperCase() }));
  const first = await send('catalog:ingest', 'nara', six);
  assert.equal(first.ok, true);
  assert.equal(first.stale, false);
  const fetchedAt = snapshots.read('nara').fetchedAt;

  const quarantined = await send('catalog:ingest', 'nara', [{ id: 'nara/a', name: 'A' }]);
  assert.equal(quarantined.stale, true);
  assert.match(quarantined.warning, /awaiting confirmation/);
  assert.equal(quarantined.rows.length, 6, 'the last-good roster stands in for the quarantined drop');

  const back = await send('catalog:read', { providerIds: ['nara'] });
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
 *
 * `freshCache` stamps the newest payload as just fetched, which is the state of a
 * machine whose owner pressed Sync sources seconds ago: fetch-info's TTL-gated
 * `syncAll` then rebuilds from the cache instead of reaching `fetchAll`, so the
 * borrow cases below exercise the real click without a network. Without it the
 * fixed 2026-09-30 stamp is older than 15 minutes and every click would fetch.
 *
 * Both providers exist in `repos.providers`, because main now refuses a roster for
 * a provider it cannot find there — a store with no provider rows would otherwise
 * fail every ingest in this file for a reason that is not the one under test.
 */
async function refBacked(t, { freshCache = false } = {}) {
  const store = await memoryStore(t);
  for (const id of ['nara', 'nexum']) {
    store.repos.providers.save({ id, name: id.toUpperCase(), baseUrl: 'http://127.0.0.1:1', keys: [] });
  }
  const cache = new Map();
  const newest = () => (freshCache ? new Date().toISOString() : '2026-09-30T10:00:00.000Z');
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
      ? { payload: cache.get(id), meta: { fetchedAt: newest() } } : null),
    newestFetchedAt: newest,
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
    providers: store.repos.providers,
    sources,
    engine,
    // The raw column, because the claim is about what the STORE kept, not about
    // what the repository chooses to hand back.
    summaryJson: (modelId) => store.db
      .prepare('SELECT summary_json FROM roster_snapshot WHERE provider_id = ? AND model_id = ?')
      .get('nara', modelId).summary_json,
  };
}
