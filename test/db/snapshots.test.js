const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryStore, countRows } = require('../helpers');

const base = (over = {}) => ({
  createdAt: 1727000000000, fetchedAt: 1727100000000,
  models: {}, lastGoodRows: [], lastSync: null, ...over,
});

const HEALTH = { status: 'healthy', note: 'Responded normally', httpStatus: 200, at: 99,
  latencies: [{ at: 99, ms: 812 }] };

test('a provider with no snapshot reads null, not an empty object', async (t) => {
  const store = await memoryStore(t);
  assert.equal(store.repos.snapshots.read('nara'), null);
});

test('every file-level field the reference kept survives the round trip', async (t) => {
  const store = await memoryStore(t);
  const snapshot = base({
    models: {
      'a/model': { name: 'Model A', first_seen: 1727000000000, last_seen: 1727100000000 },
      'b/gone': { name: 'Gone', first_seen: 1726000000000, last_seen: 1726500000000, removed_at: 1726600000000 },
    },
    lastGoodRows: [{ id: 'a/model', name: 'Model A', context_tokens: 8192 }],
    lastSync: { at: 1727100000000, ok: true, warning: null },
  });
  store.repos.snapshots.write('nara', snapshot);
  assert.deepEqual(store.repos.snapshots.read('nara'), snapshot);
});

test('pendingDrop is present only while a mass drop is quarantined', async (t) => {
  const store = await memoryStore(t);
  store.repos.snapshots.write('nara', base({
    pendingDrop: { count: 3, sha256: 'x'.repeat(64), attempts: 2, firstSeenAt: 5 },
  }));
  assert.equal(store.repos.snapshots.read('nara').pendingDrop.attempts, 2);
  store.repos.snapshots.write('nara', base());
  assert.equal(store.repos.snapshots.read('nara').pendingDrop, undefined,
    'a cleared quarantine must not read back as a live claim');
});

test('two providers never read each other, and a second write replaces the first', async (t) => {
  const store = await memoryStore(t);
  store.repos.snapshots.write('nara', base({ createdAt: 1 }));
  store.repos.snapshots.write('mirai', base({ createdAt: 9 }));
  assert.equal(countRows(store.db, 'snapshot_meta'), 2);
  store.repos.snapshots.write('nara', base({ createdAt: 3 }));
  assert.equal(countRows(store.db, 'snapshot_meta'), 2, 'replaced, not appended');
  assert.equal(store.repos.snapshots.read('nara').createdAt, 3);
  assert.equal(store.repos.snapshots.read('mirai').createdAt, 9);
});

test('setLastSync records a failed attempt without touching the rows it failed to replace', async (t) => {
  const store = await memoryStore(t);
  store.repos.snapshots.write('nara', base({
    fetchedAt: 2,
    models: { m: { name: 'M', first_seen: 2, last_seen: 2 } },
    lastGoodRows: [{ id: 'm' }], lastSync: { at: 2, ok: true, warning: null },
  }));
  store.repos.snapshots.setLastSync('nara', { at: 3, ok: false, warning: 'HTTP 503' });
  const read = store.repos.snapshots.read('nara');
  assert.deepEqual(read.lastSync, { at: 3, ok: false, warning: 'HTTP 503' });
  assert.deepEqual(read.lastGoodRows, [{ id: 'm' }]);
  assert.equal(read.fetchedAt, 2, 'fetchedAt answers "how old are these rows"; lastSync answers "did the last attempt work"');
});

test('setLastSync for an unknown provider creates the row so the very first failure is not lost', async (t) => {
  const store = await memoryStore(t);
  store.repos.snapshots.setLastSync('darkapi', { at: 3, ok: false, warning: 'no route' });
  assert.deepEqual(store.repos.snapshots.read('darkapi').lastSync,
    { at: 3, ok: false, warning: 'no route' });
});

test('a warning longer than 200 characters is clipped, as the reference clips it', async (t) => {
  const store = await memoryStore(t);
  store.repos.snapshots.setLastSync('nara', { at: 1, ok: false, warning: 'x'.repeat(500) });
  assert.equal(store.repos.snapshots.read('nara').lastSync.warning.length, 200);
});

test('listProviderIds is the set that has ever produced a snapshot', async (t) => {
  const store = await memoryStore(t);
  store.repos.snapshots.write('nara', base());
  store.repos.snapshots.write('mirai', base());
  assert.deepEqual(store.repos.snapshots.listProviderIds(), ['mirai', 'nara']);
});

// Four cases that only exist because the snapshot is two tables rather than the
// reference's one JSON file.

test('a model that leaves the roster but keeps its history stays a tombstone and loses its summary', async (t) => {
  const store = await memoryStore(t);
  const repo = store.repos.snapshots;
  repo.write('nara', base({
    models: { m: { name: 'M', first_seen: 5, last_seen: 6 } },
    lastGoodRows: [{ id: 'm', name: 'M', context_tokens: 128 }],
  }));
  repo.write('nara', base({
    models: { m: { name: 'M', first_seen: 5, last_seen: 6, removed_at: 9 } },
    lastGoodRows: [],
  }));
  const read = repo.read('nara');
  assert.deepEqual(read.models.m, { name: 'M', first_seen: 5, last_seen: 6, removed_at: 9 });
  assert.deepEqual(read.lastGoodRows, [], 'a tombstone is history, not a row to serve');
  assert.equal(read.models.m.first_seen, 5, 'and the tombstone did not rewrite when it was first seen');
});

test('forgetting a model deletes its row, so it is not read as a removal', async (t) => {
  const store = await memoryStore(t);
  const repo = store.repos.snapshots;
  repo.write('nara', base({ models: { keep: { name: 'K', first_seen: 1, last_seen: 2 },
    drop: { name: 'D', first_seen: 1, last_seen: 2 } }, lastGoodRows: [{ id: 'keep' }, { id: 'drop' }] }));
  repo.write('nara', base({ models: { keep: { name: 'K', first_seen: 1, last_seen: 3 } },
    lastGoodRows: [{ id: 'keep' }] }));
  assert.deepEqual(Object.keys(repo.read('nara').models), ['keep']);
  assert.equal(countRows(store.db, 'roster_snapshot'), 1);
});

test('setHealth records a probe without rewriting the summary or the history', async (t) => {
  const store = await memoryStore(t);
  const repo = store.repos.snapshots;
  repo.write('nara', base({ models: { m: { name: 'M', first_seen: 5, last_seen: 6 } },
    lastGoodRows: [{ id: 'm', name: 'M', context_tokens: 128 }] }));
  const health = { status: 'healthy', note: 'Responded normally', httpStatus: 200, at: 99,
    latencies: [{ at: 99, ms: 812 }] };
  repo.setHealth('nara', 'm', health);
  assert.deepEqual(repo.getHealth('nara', 'm'), health);
  const read = repo.read('nara');
  assert.deepEqual(read.lastGoodRows, [{ id: 'm', name: 'M', context_tokens: 128 }],
    'the provider facts survived a health check');
  assert.equal(read.models.m.first_seen, 5);
});

test('setHealth for a model that is not in the roster throws instead of inventing a row', async (t) => {
  const store = await memoryStore(t);
  assert.throws(() => store.repos.snapshots.setHealth('nara', 'ghost', { status: 'ok' }), /unknown model/);
});

test('a roster rewrite carries the health record forward - it is not this writer\'s column', async (t) => {
  const store = await memoryStore(t);
  const repo = store.repos.snapshots;
  repo.write('nara', base({
    models: { m: { name: 'M', first_seen: 5, last_seen: 6 } },
    lastGoodRows: [{ id: 'm', name: 'M', context_tokens: 128 }],
  }));
  // Twenty samples is what spec §10 says the page reads: a write that cleared
  // this column would take the latency history with it on the next ingest.
  const health = { status: 'healthy', note: 'Responded normally', httpStatus: 200, at: 70,
    latencies: Array.from({ length: 20 }, (_, i) => ({ at: i + 1, ms: 400 + i })) };
  repo.setHealth('nara', 'm', health);

  repo.write('nara', base({
    fetchedAt: 8,
    models: { m: { name: 'M', first_seen: 5, last_seen: 8 } },
    lastGoodRows: [{ id: 'm', name: 'M', context_tokens: 256 }],
  }));
  assert.deepEqual(repo.getHealth('nara', 'm'), health, 'the probe survived a roster rewrite');
  assert.deepEqual(repo.read('nara').lastGoodRows, [{ id: 'm', name: 'M', context_tokens: 256 }],
    'and the writer still owns every other column on that row');

  // setLastSync goes through the same write, so an attempt that ended in failure
  // must cost the latency history nothing either.
  repo.setLastSync('nara', { at: 9, ok: false, warning: 'HTTP 503' });
  assert.deepEqual(repo.getHealth('nara', 'm'), health, 'and a failed attempt keeps its measurements');

  // The one way health does leave: the model itself leaves the roster, and the
  // row goes with it. Deleting a row is not the same as rewriting it.
  repo.write('nara', base({ models: {}, lastGoodRows: [] }));
  assert.equal(repo.getHealth('nara', 'm'), null, 'a forgotten model takes its history with it');
});

test('a last-good row with no history entry is not stored, so no row is invented for it', async (t) => {
  const store = await memoryStore(t);
  const repo = store.repos.snapshots;
  // After a sync every summary has the history entry that names it. A snapshot
  // that pairs a summary with no entry would have to be stored under a first_seen
  // nobody observed, so the row is refused rather than fabricated (spec §5: one
  // roster_snapshot row IS one snapshot entry).
  repo.write('nara', base({ models: {}, lastGoodRows: [{ id: 'ghost', name: 'Ghost' }] }));
  assert.equal(countRows(store.db, 'roster_snapshot'), 0);
  assert.deepEqual(repo.read('nara').lastGoodRows, []);
});

test('a snapshot with no rows reads back as the empty roster it was', async (t) => {
  const store = await memoryStore(t);
  const repo = store.repos.snapshots;
  repo.write('nara', base());
  assert.deepEqual(repo.read('nara'), base());
  assert.deepEqual(repo.listProviderIds(), ['nara'], 'a provider that answered once is on the list');
});
