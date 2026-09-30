// The two-table roster repository: what survives a write, what a tombstone is,
// and which writer is allowed to touch which column — including the one that
// only records how an attempt ended, and must move no roster row at all.
const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryStore, countRows } = require('../helpers');

const base = (over = {}) => ({
  createdAt: 1727000000000, fetchedAt: 1727100000000,
  models: {}, lastGoodRows: [], lastSync: null, ...over,
});

const HEALTH = { status: 'healthy', note: 'Responded normally', httpStatus: 200, at: 99,
  latencies: [{ at: 99, ms: 812 }] };

// Every cell of every roster row, in a fixed order: a writer that touched the
// roster while recording an attempt cannot hide in a column this leaves out.
const rosterRows = (db) => db.prepare(`
  SELECT provider_id, model_id, name, first_seen, last_seen, removed_at,
         summary_json, health_json, updated_at
  FROM roster_snapshot ORDER BY provider_id, model_id`).all();

// A timestamp from 2009, stamped by hand: it is not what any writer puts in
// `updated_at` today, so a writer that re-stamped the roster shows up
// immediately instead of whenever the millisecond happens to differ.
const SENTINEL = 1234567890000;

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
  const repo = store.repos.snapshots;
  repo.write('nara', base({
    fetchedAt: 2,
    models: { m: { name: 'M', first_seen: 2, last_seen: 2 }, z: { name: 'Z', first_seen: 1, last_seen: 2 } },
    lastGoodRows: [{ id: 'm' }, { id: 'z' }],
    lastSync: { at: 2, ok: true, warning: null },
    pendingDrop: { count: 3, sha256: 'x'.repeat(64), attempts: 2, firstSeenAt: 5 },
  }));
  const stamped = store.db.prepare('UPDATE roster_snapshot SET updated_at = ?').run(SENTINEL);
  assert.equal(stamped.changes, 2, 'every roster row is stamped by hand before the attempt is recorded');
  const before = rosterRows(store.db);
  assert.equal(before.length, 2, 'two roster rows to protect');
  assert.equal(before[0].updated_at, SENTINEL, 'and every one of them carries the hand stamp');

  assert.equal(repo.setLastSync('nara', { at: 3, ok: false, warning: 'HTTP 503' }), true,
    'a provider with a snapshot does have something for the attempt to qualify');
  const read = repo.read('nara');
  assert.deepEqual(read.lastSync, { at: 3, ok: false, warning: 'HTTP 503' });
  assert.deepEqual(read.lastGoodRows, [{ id: 'm' }, { id: 'z' }]);
  assert.equal(read.fetchedAt, 2, 'fetchedAt answers "how old are these rows"; lastSync answers "did the last attempt work"');
  assert.deepEqual(rosterRows(store.db), before,
    'not one roster row moved, in any column, and above all not its updated_at: a failed fetch did not re-stamp the roster');
  assert.equal(read.createdAt, base().createdAt, 'the meta keeps the columns this call is not about');
  assert.equal(read.pendingDrop.attempts, 2, 'and a recorded failure does not lift a quarantine');

  // The other half of the same rule: a SUCCESS recorded this way is still only a
  // note about an attempt. Real rows arrive through write(), in a transaction.
  assert.equal(repo.setLastSync('nara', { at: 4, ok: true, warning: null }), true);
  assert.deepEqual(rosterRows(store.db), before, 'a successful attempt re-stamps the roster no further');
  assert.deepEqual(repo.read('nara').lastSync, { at: 4, ok: true, warning: null });
});

test('setLastSync refuses a provider that has never produced a roster, and invents no row', async (t) => {
  const store = await memoryStore(t);
  const repo = store.repos.snapshots;
  // Reversed from the brief, which had this case CREATING the meta row so "the
  // very first failure is not lost". The reference refuses outright: "Nothing is
  // written when there is no snapshot yet — there is no last-good roster for the
  // failure to qualify" (providers/index.js:440-442). Recording a failure against
  // no rows would put a provider on read()'s map that has nothing to serve.
  assert.equal(repo.setLastSync('darkapi', { at: 3, ok: false, warning: 'no route' }), false,
    'a clear signal, the same one writeCacheFailure gives when no payload is cached');
  assert.equal(repo.read('darkapi'), null, 'nothing was written, so nothing reads back');
  assert.equal(countRows(store.db, 'snapshot_meta'), 0);
  assert.equal(countRows(store.db, 'roster_snapshot'), 0);
  assert.deepEqual(repo.listProviderIds(), [], 'an attempt is not a snapshot');
});

test('a warning longer than 200 characters is clipped, as the reference clips it', async (t) => {
  const store = await memoryStore(t);
  const repo = store.repos.snapshots;
  // Changed from the brief: the provider writes a snapshot first, because
  // setLastSync now refuses one that has never produced a roster (the case
  // above). The clipping itself is still what this case pins.
  repo.write('nara', base({
    models: { m: { name: 'M', first_seen: 1, last_seen: 2 } }, lastGoodRows: [{ id: 'm' }],
  }));
  assert.equal(repo.setLastSync('nara', { at: 1, ok: false, warning: 'x'.repeat(500) }), true);
  assert.equal(repo.read('nara').lastSync.warning.length, 200);
  assert.deepEqual(repo.read('nara').lastGoodRows, [{ id: 'm' }]);
});

test('listProviderIds is the set that has ever produced a snapshot', async (t) => {
  const store = await memoryStore(t);
  const repo = store.repos.snapshots;
  repo.write('nara', base());
  repo.write('mirai', base());
  assert.deepEqual(repo.listProviderIds(), ['mirai', 'nara']);
  repo.setLastSync('darkapi', { at: 9, ok: false, warning: 'no route' });
  assert.deepEqual(repo.listProviderIds(), ['mirai', 'nara'],
    'has ever produced a snapshot, not has ever been attempted — read() would serve this list nothing at all');
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

  // An attempt that ended in failure is recorded on the meta row alone, so the
  // latency history cannot be disturbed by it. It used to travel through the same
  // roster rewrite as a real sync — which is exactly what made this worth pinning,
  // and the pin still holds for the reason given in the case above.
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
