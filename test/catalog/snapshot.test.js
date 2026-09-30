'use strict';

// src/catalog/snapshot.js diffs each sync against a store seam and reports which
// models came and went. The reference passed a directory and read
// cache/providers/<id>.json back; here the directory is `repos.snapshots` in
// production and the Map below in tests, so every
// `JSON.parse(fs.readFileSync(path.join(dir, "provider.json")))` became
// `store.dump("provider")` and the `dir` argument disappeared from every call.
//
// The second conversion is the one that fails silently. venom.db holds
// INTEGER epoch-ms (`snapshot_meta.created_at`, `fetched_at`,
// `roster_snapshot.first_seen/last_seen/removed_at`), so `daysBetween` subtracts
// integers instead of parsing ISO strings. Ported unchanged it would have called
// `Date.parse(1727000000000)` → NaN, `NaN <= 7` is false, and every window would
// read as "nothing is new" while the suite stayed green. So every timestamp here
// is an integer off one fixed anchor, and the day-6/day-8 test below is the proof
// that the arithmetic is arithmetic.
//
// No test touches the wall clock, the network or the disk.

const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryStore } = require('../helpers');

const {
  syncSnapshot,
  validateProviderRows,
  providerRowSnapshot,
  cloneRows,
  restoreLastGoodRows,
  providerIdContract,
  daysBetween,
  DERIVED_FIELDS,
  BLANK_STRING_FIELDS,
  NEW_WINDOW_DAYS,
  REMOVED_WINDOW_DAYS,
  DROP_CONFIRMATION_MS,
  DROP_MIN_PREVIOUS,
  DROP_MIN_LOSS,
} = require('../../src/catalog/snapshot');

const DAY = 86400000;
const T0 = 1727000000000;   // a fixed anchor; tests must not depend on the clock

/** The store seam: { read, write }, plus dump() so a test can see what was kept. */
function memStore() {
  const files = new Map();
  return {
    read: (id) => (files.has(id) ? structuredClone(files.get(id)) : null),
    write: (id, snapshot) => { files.set(id, structuredClone(snapshot)); },
    dump: (id) => files.get(id),
  };
}

const rowOf = (id) => ({ id, name: id.toUpperCase() });
const idsOf = (list) => list.map((item) => item.id);

test('one provider\'s roster never reaches another\'s, and an unknown id has no snapshot', () => {
  // The reference proved this with snapshotSummary(), which counted the files of
  // the provider ids it was handed. `syncSnapshot(store, providerId, …)` keys the
  // store by id instead, and the read path that iterates providers is Task 10's,
  // so what survives the conversion is the keying itself.
  const store = memStore();
  syncSnapshot(store, 'connected-a', [rowOf('a1'), rowOf('a2')], T0);
  syncSnapshot(store, 'connected-b', [rowOf('b1')], T0);

  assert.deepEqual(Object.keys(store.dump('connected-a').models).sort(), ['a1', 'a2']);
  assert.deepEqual(Object.keys(store.dump('connected-b').models), ['b1']);
  assert.equal(store.read('never-synced'), null, 'a provider that never produced one reads back as none');
});

test('baseline sync: nothing is flagged new or removed', () => {
  const store = memStore();
  const rows = [rowOf('a'), rowOf('b')];
  const changes = syncSnapshot(store, 'provider', rows, T0);

  assert.equal(changes.baseline, true);
  assert.equal(changes.since, null);
  assert.deepEqual(changes.added, []);
  assert.deepEqual(changes.removed, []);
  assert.equal(rows[0].is_new, false);
  assert.equal(rows[1].is_new, false);

  const stored = store.dump('provider');
  assert.deepEqual(stored.lastGoodRows.map((row) => row.id), ['a', 'b']);
  assert.equal(stored.createdAt, T0, 'an integer, as the INTEGER column holds it');
  assert.equal(stored.fetchedAt, T0);
  assert.deepEqual(stored.lastSync, { at: T0, ok: true, warning: null });
});

test('a model appearing after the baseline is flagged added and is_new', () => {
  const store = memStore();
  syncSnapshot(store, 'provider', [rowOf('a')], T0);

  const t1 = T0 + 3 * DAY;
  const rows = [rowOf('a'), rowOf('c')];
  const changes = syncSnapshot(store, 'provider', rows, t1);

  assert.equal(changes.baseline, false);
  assert.equal(changes.since, T0, 'the previous fetch, in the same integer currency');
  assert.deepEqual(idsOf(changes.added), ['c']);
  assert.equal(rows.find((r) => r.id === 'c').is_new, true);
});

test('a model missing from the current fetch is flagged removed, within the window', () => {
  const store = memStore();
  syncSnapshot(store, 'provider', [rowOf('a'), rowOf('b')], T0);

  const changes = syncSnapshot(store, 'provider', [rowOf('a')], T0 + 3 * DAY);

  assert.deepEqual(idsOf(changes.removed), ['b']);
});

test('added stops being new after NEW_WINDOW_DAYS, but keeps showing until then', () => {
  const store = memStore();
  const t0 = T0 - 60 * DAY;
  syncSnapshot(store, 'provider', [rowOf('a')], t0);

  const t1 = t0 + 3 * DAY;
  const rows1 = [rowOf('a'), rowOf('c')];
  syncSnapshot(store, 'provider', rows1, t1);
  assert.equal(rows1.find((r) => r.id === 'c').is_new, true);

  const t2 = t1 + (NEW_WINDOW_DAYS + 1) * DAY;
  const rows2 = [rowOf('a'), rowOf('c')];
  syncSnapshot(store, 'provider', rows2, t2);
  assert.equal(rows2.find((r) => r.id === 'c').is_new, false);
});

/**
 * The window measured from the row's own first_seen, on both sides of the
 * cutoff: `daysBetween` must return a number for integers. Feed it a
 * `Date.parse(now)` and both of these assertions come out FALSE — which is why
 * the TRUE half is written down explicitly rather than trusted to the test above.
 */
test('the new window is real arithmetic: the same row is new on day 6 and not new on day 8', () => {
  const store = memStore();
  syncSnapshot(store, 'provider', [rowOf('a')], T0);
  const arrived = T0 + DAY;
  syncSnapshot(store, 'provider', [rowOf('a'), rowOf('c')], arrived);

  const day6 = [rowOf('a'), rowOf('c')];
  const onDay6 = syncSnapshot(store, 'provider', day6, arrived + 6 * DAY);
  assert.equal(day6.find((r) => r.id === 'c').is_new, true, 'day 6 of seven is still new');
  assert.deepEqual(idsOf(onDay6.added), ['c']);

  const day8 = [rowOf('a'), rowOf('c')];
  const onDay8 = syncSnapshot(store, 'provider', day8, arrived + 8 * DAY);
  assert.equal(day8.find((r) => r.id === 'c').is_new, false, 'day 8 is not');
  assert.deepEqual(onDay8.added, [], 'and the window stops listing it');

  assert.equal(daysBetween(T0, T0 + DAY), 1);
  assert.equal(daysBetween(T0, T0 + 6.5 * DAY), 6.5);
  assert.ok(Number.isFinite(daysBetween(T0, T0 + DAY)), 'no Date.parse of an integer, so no NaN');
});

test('removed models become retained tombstones after REMOVED_WINDOW_DAYS', () => {
  const store = memStore();
  // b's last_seen is set here (t0) and never again, since every later call
  // omits it — the window is measured from this timestamp throughout.
  const t0 = T0 - 90 * DAY;
  syncSnapshot(store, 'provider', [rowOf('a'), rowOf('b')], t0);

  // One day short of the cutoff: b still shows as removed.
  const justInside = syncSnapshot(store, 'provider', [rowOf('a')], t0 + (REMOVED_WINDOW_DAYS - 1) * DAY);
  assert.deepEqual(idsOf(justInside.removed), ['b']);

  // One day past the cutoff: stop notifying, but retain identity history.
  const pastCutoff = syncSnapshot(store, 'provider', [rowOf('a')], t0 + (REMOVED_WINDOW_DAYS + 1) * DAY);
  assert.deepEqual(pastCutoff.removed, []);

  const stored = store.dump('provider');
  assert.equal('b' in stored.models, true, 'kept forever — this port has no 14-day purge');
  assert.equal(stored.models.b.first_seen, t0);
  assert.equal(stored.models.b.removed_at, t0 + (REMOVED_WINDOW_DAYS - 1) * DAY);
});

test('a returning tombstoned model keeps first_seen and is not reported as newly discovered', () => {
  const store = memStore();
  const t0 = T0 - 90 * DAY;
  syncSnapshot(store, 'provider', [rowOf('a'), rowOf('b')], t0);
  syncSnapshot(store, 'provider', [rowOf('a')], t0 + 2 * DAY);
  syncSnapshot(store, 'provider', [rowOf('a')], t0 + 40 * DAY);

  const rows = [rowOf('a'), { id: 'b', name: 'B returned' }];
  const changes = syncSnapshot(store, 'provider', rows, t0 + 50 * DAY);

  assert.deepEqual(changes.added, []);
  assert.equal(rows[1].first_seen, t0, 'the tombstone is where first_seen came from');
  assert.equal(store.dump('provider').models.b.removed_at, undefined);
});

/**
 * `moved` vs the windows, which is the distinction the whole event layer rests
 * on (ref §12).
 *
 * `added` and `removed` are deliberately sticky — a model stays "new" for
 * NEW_WINDOW_DAYS and a tombstone shows for REMOVED_WINDOW_DAYS, because that is
 * what the table's badge and the "changes since" line want. `moved` is the edge,
 * and it must go quiet the moment the roster stops changing even though the
 * windows still have plenty to say — only `moved` may gate a notice, because a
 * read path that gated on a window would refetch itself without bound.
 */
test('moved reports the edge, not the window a change is still inside', () => {
  const store = memStore();
  const t0 = T0 - 5 * DAY;
  syncSnapshot(store, 'provider', [rowOf('a'), rowOf('b')], t0);

  // One model arrives, one leaves — both well inside their windows.
  const t1 = t0 + 1 * DAY;
  const churn = syncSnapshot(store, 'provider', [rowOf('a'), rowOf('c')], t1);
  assert.deepEqual(churn.moved, { appeared: 1, disappeared: 1 }, 'the edge, at the moment it happened');
  assert.deepEqual(idsOf(churn.added), ['c']);
  assert.deepEqual(idsOf(churn.removed), ['b']);

  // Same roster, three days later. Nothing has changed; the windows disagree.
  const t2 = t1 + 3 * DAY;
  const quiet = syncSnapshot(store, 'provider', [rowOf('a'), rowOf('c')], t2);
  assert.deepEqual(quiet.moved, { appeared: 0, disappeared: 0 }, 'nothing moved — this is the loop guard');
  assert.deepEqual(idsOf(quiet.added), ['c'], 'and the window still lists it, on purpose');
  assert.deepEqual(idsOf(quiet.removed), ['b']);
});

test('a model coming back from a tombstone is a move', () => {
  const store = memStore();
  const t0 = T0 - 5 * DAY;
  syncSnapshot(store, 'provider', [rowOf('a')], t0);
  syncSnapshot(store, 'provider', [rowOf('z')], t0 + DAY);

  const back = syncSnapshot(store, 'provider', [rowOf('a'), rowOf('z')], t0 + 2 * DAY);
  assert.deepEqual(back.moved, { appeared: 1, disappeared: 0 }, 'it was gone and is not any more');
});

test('the baseline is the roster arriving, not moving', () => {
  const store = memStore();
  const changes = syncSnapshot(store, 'provider', [rowOf('a'), rowOf('b')], T0);
  assert.deepEqual(changes.moved, { appeared: 0, disappeared: 0 });
});

test('re-fetching the same ids reports no changes and keeps first_seen stable', () => {
  const store = memStore();
  const t0 = T0 - 20 * DAY;
  const rows0 = [rowOf('a')];
  syncSnapshot(store, 'provider', rows0, t0);
  const firstSeen = rows0[0].first_seen;

  const rows1 = [rowOf('a')];
  const changes = syncSnapshot(store, 'provider', rows1, t0 + 1 * DAY);

  assert.deepEqual(changes.added, []);
  assert.deepEqual(changes.removed, []);
  assert.equal(rows1[0].first_seen, firstSeen);
});

test('provider validation rejects an empty successful payload before snapshot mutation', () => {
  const store = memStore();
  assert.throws(
    () => syncSnapshot(store, 'opencode-go', [], T0),
    (error) => error && error.code === 'INVALID_PROVIDER_PAYLOAD' && /empty/i.test(error.message),
  );
  assert.equal(store.read('opencode-go'), null, 'validation runs first, so a rejected payload writes nothing');
});

test('an empty roster is refused whether or not a snapshot already exists', () => {
  // Not the same claim as the one above: a provider that answers with nothing
  // must never become "the provider removed everything" through the back door.
  const store = memStore();
  syncSnapshot(store, 'provider', [rowOf('a')], T0);
  assert.throws(() => syncSnapshot(store, 'provider', [], T0 + DAY),
    (e) => e.code === 'INVALID_PROVIDER_PAYLOAD');
  assert.equal(store.dump('provider').fetchedAt, T0, 'and the roster it had stands unchanged');
});

test('provider validation rejects a non-array and missing and duplicate model ids', () => {
  assert.throws(
    () => validateProviderRows('provider', null),
    (error) => error && error.code === 'INVALID_PROVIDER_PAYLOAD' && /array/i.test(error.message),
  );
  assert.throws(
    () => validateProviderRows('provider', [{ id: 'a' }, { name: 'missing' }]),
    (error) => error && error.code === 'INVALID_PROVIDER_PAYLOAD' && /missing id/i.test(error.message),
  );
  assert.throws(
    () => validateProviderRows('provider', [{ id: 'a' }, { id: 'a' }]),
    (error) => error && error.code === 'INVALID_PROVIDER_PAYLOAD' && /duplicate/i.test(error.message),
  );
});

test('a provider that answers with nothing never becomes a removal: last-good rows stand in', () => {
  // The reference drove this through fetchProviderRows(), which owns the
  // fetch-then-fall-back orchestration (Task 10's ingest here). What Task 8 owes
  // it is the two halves: a rejected payload leaves the snapshot alone, and
  // restoreLastGoodRows hands back copies rather than the caller's rows.
  const store = memStore();
  const baseline = [{ id: 'a', name: 'A', context_tokens: 1000 }];
  syncSnapshot(store, 'provider', baseline, T0 - DAY);

  assert.throws(() => validateProviderRows('provider', []),
    (e) => e.code === 'INVALID_PROVIDER_PAYLOAD');

  const rows = restoreLastGoodRows(store.read('provider'), T0);
  assert.deepEqual(idsOf(rows), ['a']);
  assert.equal(rows[0].context_tokens, 1000);
  assert.notEqual(rows, baseline, 'a fallback is a fresh array, never the rows it came from');
  assert.equal(store.dump('provider').fetchedAt, T0 - DAY, 'and nothing was rewritten by the attempt');
});

test('a stale fallback row is re-filled from the current catalog, not frozen with old metadata', () => {
  const store = memStore();
  // What a scored row looks like when it is stored: some fields are the
  // provider's own, some were borrowed from the catalog of that day.
  const rows = [{
    id: 'm1',
    name: 'M1',
    context_tokens: 100000,
    output_tokens: 4096,
    input_modalities: 'text',
    cost_in_per_m: 1,
    filled_from_catalog: ['context_tokens', 'input_modalities'],
    score: 50,
    score_source: 'aa',
    score_basis: ['aa'],
    rank: 1,
    catalog_rank: 7,
    matched_id: 'lab/m1',
    aa_intelligence: 50,
  }];
  syncSnapshot(store, 'demo', rows, T0);

  const restored = restoreLastGoodRows(store.read('demo'), T0)[0];

  assert.equal(restored.context_tokens, null, 'a borrowed field must be blank again so the current catalog refills it');
  assert.equal(restored.input_modalities, '', 'string fields blank to the empty string, not to null');
  assert.equal(restored.output_tokens, 4096, 'a provider-supplied field must survive');
  assert.equal(restored.cost_in_per_m, 1);
  assert.equal(restored.score, undefined, 'a stale row must be re-scored, never replayed');
  assert.equal(restored.matched_id, undefined);
  assert.equal(restored.aa_intelligence, undefined);
  assert.equal(restored.filled_from_catalog, undefined, 'this app must not store what it re-blanks on read');
  assert.equal(restored.first_seen, T0, 'first_seen still comes from the snapshot, as an integer');
  assert.equal(restored.is_new, false, 'and the window is recomputed at read time, never replayed');
});

test('a snapshot that was never taken has no last-good roster to fall back to', () => {
  // The reference asked this before fetching, so an unconnected provider reported
  // a prerequisite (NOT_CONNECTED) instead of an upstream failure it never
  // attempted. The gate itself is Task 10's; the fact it reads is this one.
  const store = memStore();
  assert.equal(store.read('gated'), null);
  assert.deepEqual(restoreLastGoodRows({ createdAt: T0, fetchedAt: null, models: {}, lastGoodRows: [] }, T0), []);
});

test('providerRowSnapshot keeps the provider\'s own facts and stores nothing derived', () => {
  const stored = providerRowSnapshot({
    id: 'm1', name: 'M1', context_tokens: 1000,
    score: 50, score_basis: ['aa'], rank: 1, is_new: true, first_seen: T0,
    filled_from_catalog: ['context_tokens'],
  });
  for (const field of DERIVED_FIELDS) {
    assert.equal(stored[field], undefined, `${field} is derived and must not be stored`);
  }
  assert.equal(stored.context_tokens, null, 'the borrow is blanked before it is written');
  assert.equal(stored.id, 'm1');
  assert.equal(stored.name, 'M1');
  assert.ok(DERIVED_FIELDS.includes('filled_from_catalog'), 'this app re-blanks on read, so it must not store it');
  assert.ok(DERIVED_FIELDS.includes('is_new'), 'is_new is stamped per pass, never a column');
  assert.ok(BLANK_STRING_FIELDS.has('output_modalities'), 'modality blanks to "" like its input twin');
});

test('cloneRows copies the arrays a row carries, not the row itself', () => {
  const row = { id: 'm1', match_ids: ['a'], quality_proxy_ids: ['b'], score_basis: ['aa'], filled_from_catalog: ['rank'] };
  const [copy] = cloneRows([row]);

  assert.deepEqual(copy, row);
  assert.notEqual(copy, row);
  assert.notEqual(copy.match_ids, row.match_ids);
  assert.notEqual(copy.score_basis, row.score_basis);
  assert.notEqual(copy.filled_from_catalog, row.filled_from_catalog);
  // A field that is not an array is carried as it stands — the clone never
  // invents an empty list for a row that published none.
  const bare = cloneRows([{ id: 'm2', match_ids: 'keep-me' }])[0];
  assert.equal(bare.match_ids, 'keep-me');
  assert.equal(bare.quality_proxy_ids, undefined);
});

test('providerIdContract fingerprints the sorted id set, not the order it arrived in', () => {
  const contract = providerIdContract([{ id: 'b' }, { id: 'a' }]);
  assert.deepEqual(contract, providerIdContract([{ id: 'a' }, { id: 'b' }]));
  assert.equal(contract.count, 2);
  assert.equal(contract.sha256, '7e18f737311b2dc3b2f269dd78396b0351f14fb66efa879f768cb23181883c78');
  assert.notEqual(providerIdContract([{ id: 'a' }, { id: 'c' }]).sha256, contract.sha256,
    'a different set is a different candidate, which restarts the count');
});

test('a large partial response must repeat three times before snapshot removal is accepted', () => {
  const store = memStore();
  const baseline = Array.from({ length: 10 }, (_, index) => ({ id: `m${index}`, name: `M${index}` }));
  syncSnapshot(store, 'provider', baseline, T0);
  const partial = [{ id: 'm0', name: 'M0' }];

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assert.throws(
      () => syncSnapshot(store, 'provider', structuredClone(partial), T0 + attempt),
      (error) => error && error.code === 'SUSPICIOUS_PROVIDER_DROP',
    );
    const stored = store.dump('provider');
    assert.equal(Object.keys(stored.models).length, 10);
    assert.equal(stored.pendingDrop.attempts, attempt);
    assert.equal(stored.lastGoodRows.length, 10);
  }

  // Three attempts alone are not enough — the six hours must also have passed.
  const accepted = syncSnapshot(store, 'provider', structuredClone(partial), T0 + 1 + DROP_CONFIRMATION_MS);
  assert.deepEqual(idsOf(accepted.removed).sort(), baseline.slice(1).map((row) => row.id).sort());
});

test('the quarantine gate is exactly DROP_MIN_PREVIOUS, DROP_MIN_LOSS and half the roster', () => {
  const dropTo = (from, to) => {
    const store = memStore();
    syncSnapshot(store, 'p', Array.from({ length: from }, (_, i) => rowOf(`m${i}`)), T0);
    const kept = Array.from({ length: to }, (_, i) => rowOf(`m${i}`));
    try {
      const out = syncSnapshot(store, 'p', kept, T0 + DAY);
      return { quarantined: false, removed: out.removed.length };
    } catch (error) {
      assert.equal(error.code, 'SUSPICIOUS_PROVIDER_DROP');
      return { quarantined: true };
    }
  };

  // Fewer than DROP_MIN_PREVIOUS active rows: a small roster is allowed to change.
  assert.deepEqual(dropTo(DROP_MIN_PREVIOUS - 1, 1), { quarantined: false, removed: DROP_MIN_PREVIOUS - 2 });
  // Losing fewer than DROP_MIN_LOSS: six to four is a tidy-up, not a truncation.
  assert.deepEqual(dropTo(6, 6 - (DROP_MIN_LOSS - 1)), { quarantined: false, removed: DROP_MIN_LOSS - 1 });
  // The half rule on its own edge: six to three loses three but is still half.
  assert.deepEqual(dropTo(6, 3), { quarantined: false, removed: 3 });
  // Six to two trips every one of the three conditions.
  assert.deepEqual(dropTo(6, 2), { quarantined: true });
});

// --- the four cases that exist because the storage changed -------------------

function sixModels() {
  const models = {};
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
    models[id] = { name: id.toUpperCase(), first_seen: 1, last_seen: 2 };
  }
  return { createdAt: 1, fetchedAt: 2, models, lastGoodRows: [], lastSync: null };
}

test('quarantine freezes history: the counter persists and nothing is tombstoned', () => {
  const store = memStore();
  store.write('p', sixModels());
  assert.throws(() => syncSnapshot(store, 'p', [{ id: 'a', name: 'A' }], 3000),
    (e) => e.code === 'SUSPICIOUS_PROVIDER_DROP');
  const held = store.read('p');
  assert.equal(held.pendingDrop.attempts, 1);
  assert.equal(Object.keys(held.models).length, 6, 'no tombstone — the drop was not accepted');
  assert.equal(held.fetchedAt, 2, 'and the rows kept their age');
});

test('the same set three times over six hours is allowed through, and the claim clears', () => {
  const store = memStore();
  store.write('p', sixModels());
  const rows = [{ id: 'a', name: 'A' }];
  assert.throws(() => syncSnapshot(store, 'p', rows, 3000), (e) => e.code === 'SUSPICIOUS_PROVIDER_DROP');
  assert.throws(() => syncSnapshot(store, 'p', rows, 3000), (e) => e.code === 'SUSPICIOUS_PROVIDER_DROP');
  const out = syncSnapshot(store, 'p', rows, 3000 + DROP_CONFIRMATION_MS);
  assert.equal(out.removed.length, 5);
  assert.equal(store.read('p').pendingDrop, undefined);
});

test('a different candidate set restarts the attempt count rather than adding to it', () => {
  const store = memStore();
  store.write('p', sixModels());
  assert.throws(() => syncSnapshot(store, 'p', [{ id: 'a', name: 'A' }], 3000),
    (e) => e.code === 'SUSPICIOUS_PROVIDER_DROP');
  assert.throws(() => syncSnapshot(store, 'p', [{ id: 'b', name: 'B' }], 4000),
    (e) => e.code === 'SUSPICIOUS_PROVIDER_DROP');
  assert.equal(store.read('p').pendingDrop.attempts, 1, 'a new fingerprint is a new candidate');
});

test('a tombstone is kept forever, so a returning model keeps its first_seen and is not re-announced', () => {
  const store = memStore();
  syncSnapshot(store, 'p', [{ id: 'a', name: 'A' }], 1000);
  syncSnapshot(store, 'p', [{ id: 'b', name: 'B' }], 400 * DAY);
  const held = store.read('p');
  assert.equal(held.models.a.removed_at, 400 * DAY);
  assert.equal(held.models.a.first_seen, 1000);

  syncSnapshot(store, 'p', [{ id: 'a', name: 'A' }], 401 * DAY);
  const back = store.read('p');
  assert.equal(back.models.a.first_seen, 1000, 'the original first_seen survives the return');
  assert.equal(back.models.a.removed_at, undefined);
  assert.equal(back.lastGoodRows[0].is_new, undefined, 'and it is not flagged new again');
});

// --- the same behaviour over the production store ---------------------------
// `repos.snapshots` splits what the reference kept in one JSON file across two
// INTEGER columns. These two runs are the proof that nothing in this module
// depends on the fixture being a Map.

test('the store seam is repos.snapshots: windows and is_new survive the database', async (t) => {
  const { repos } = await memoryStore(t);
  syncSnapshot(repos.snapshots, 'nara', [rowOf('a')], T0);
  const rows = [rowOf('a'), rowOf('c')];
  const changes = syncSnapshot(repos.snapshots, 'nara', rows, T0 + 3 * DAY);

  assert.deepEqual(idsOf(changes.added), ['c']);
  assert.equal(rows.find((r) => r.id === 'c').is_new, true);

  const stored = repos.snapshots.read('nara');
  assert.equal(stored.createdAt, T0, 'INTEGER columns, read back as integers');
  assert.equal(stored.fetchedAt, T0 + 3 * DAY);
  assert.equal(stored.models.c.first_seen, T0 + 3 * DAY);

  // `is_new` is no column: the read path recomputes it, and on day 8 it is gone.
  assert.equal(restoreLastGoodRows(stored, T0 + 5 * DAY).find((r) => r.id === 'c').is_new, true);
  assert.equal(restoreLastGoodRows(stored, T0 + 3 * DAY + 8 * DAY).find((r) => r.id === 'c').is_new, false);
});

test('a quarantined drop over the real store rewrites nothing it did not accept', async (t) => {
  const { repos } = await memoryStore(t);
  const baseline = Array.from({ length: 10 }, (_, i) => rowOf(`m${i}`));
  syncSnapshot(repos.snapshots, 'nara', baseline, T0);
  repos.snapshots.setHealth('nara', 'm0', { status: 'healthy', at: T0 });

  assert.throws(() => syncSnapshot(repos.snapshots, 'nara', [rowOf('m0')], T0 + DAY),
    (e) => e.code === 'SUSPICIOUS_PROVIDER_DROP');

  const held = repos.snapshots.read('nara');
  assert.equal(Object.keys(held.models).length, 10, 'the roster is the one the provider last answered');
  assert.equal(held.lastGoodRows.length, 10);
  assert.equal(held.fetchedAt, T0, 'and the rows kept their age');
  assert.equal(held.pendingDrop.attempts, 1);
  assert.deepEqual(repos.snapshots.getHealth('nara', 'm0'), { status: 'healthy', at: T0 },
    'a rejected sync must not cost a model its health history');
});
