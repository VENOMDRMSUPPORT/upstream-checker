// Roster change events: one row per model arrival and departure, read by the
// bell and the history view. Nothing here touches providers, keys or the
// roster itself — the ingest flow is the only writer, through record().
const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryStore, countRows } = require('../helpers');
const { EVENTS_KEPT } = require('../../src/db/repos/roster-events');

test('an empty store lists nothing and owes no unread', async (t) => {
  const store = await memoryStore(t);
  assert.deepEqual(store.repos.rosterEvents.list(), []);
  assert.equal(store.repos.rosterEvents.unreadCount(), 0);
});

test('recorded arrivals and departures list newest-first with their facts', async (t) => {
  const store = await memoryStore(t);
  const n = store.repos.rosterEvents.record('nara', [{ id: 'm1', name: 'M One' }], 'added', 1000);
  assert.equal(n, 1);
  store.repos.rosterEvents.record('nara', [{ id: 'm2' }], 'removed', 2000);

  const rows = store.repos.rosterEvents.list();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].model_id, 'm2', 'newest first');
  assert.equal(rows[0].kind, 'removed');
  assert.equal(rows[0].name, null, 'a nameless item stores null, not undefined');
  assert.equal(rows[0].is_read, false);
  assert.equal(rows[1].model_id, 'm1');
  assert.equal(rows[1].name, 'M One');
  assert.equal(store.repos.rosterEvents.unreadCount(), 2);
  assert.equal(store.repos.rosterEvents.unreadCount('nara'), 2);
  assert.equal(store.repos.rosterEvents.unreadCount('darkapi'), 0);
});

test('list filters by provider, kind and read state, with a clamped limit', async (t) => {
  const store = await memoryStore(t);
  store.repos.rosterEvents.record('nara', [{ id: 'm1' }], 'added', 1000);
  store.repos.rosterEvents.record('darkapi', [{ id: 'm2' }], 'removed', 2000);
  store.repos.rosterEvents.markRead({ all: true });

  assert.equal(store.repos.rosterEvents.list({ providerId: 'nara' }).length, 1);
  assert.equal(store.repos.rosterEvents.list({ kind: 'removed' }).length, 1);
  assert.deepEqual(store.repos.rosterEvents.list({ unreadOnly: true }), []);
  assert.equal(store.repos.rosterEvents.list({ limit: 1 }).length, 1);
  assert.throws(() => store.repos.rosterEvents.list({ kind: 'edited' }), /unknown roster event kind/);
});

test('markRead takes ids or everything, and concurrent arrivals stay unread', async (t) => {
  const store = await memoryStore(t);
  store.repos.rosterEvents.record('nara', [{ id: 'm1' }, { id: 'm2' }], 'added', 1000);
  const [first] = store.repos.rosterEvents.list({ limit: 2 }).map((r) => r.id).sort((a, b) => a - b);

  assert.equal(store.repos.rosterEvents.markRead({ ids: [first, -3, 'x'] }), 1, 'only real unread ids count');
  assert.equal(store.repos.rosterEvents.unreadCount(), 1);

  store.repos.rosterEvents.record('nara', [{ id: 'm3' }], 'added', 2000);
  assert.equal(store.repos.rosterEvents.markRead({ all: true, before: 1500 }), 1, 'only rows up to the watermark');
  assert.equal(store.repos.rosterEvents.unreadCount(), 1, 'the concurrent arrival stays unread');
  assert.equal(store.repos.rosterEvents.markRead({ all: true }), 1);
  assert.equal(store.repos.rosterEvents.unreadCount(), 0);
});

test('counts totals each kind under the current filter', async (t) => {
  const store = await memoryStore(t);
  store.repos.rosterEvents.record('nara', [{ id: 'm1', name: 'Alpha One' }], 'added', 1000);
  store.repos.rosterEvents.record('nara', [{ id: 'm2' }], 'removed', 2000);
  store.repos.rosterEvents.record('darkapi', [{ id: 'm3' }], 'added', 3000);

  assert.deepEqual(store.repos.rosterEvents.counts(), { added: 2, removed: 1, total: 3 });
  assert.deepEqual(store.repos.rosterEvents.counts({ providerId: 'nara' }), { added: 1, removed: 1, total: 2 });
  assert.deepEqual(store.repos.rosterEvents.counts({ search: 'alpha' }), { added: 1, removed: 0, total: 1 });
  assert.deepEqual(store.repos.rosterEvents.list({ search: 'm_' }).map((r) => r.model_id), [],
    '_ searches literally, never as a wildcard');
});

test('record refuses an unknown kind and an empty batch writes nothing', async (t) => {
  const store = await memoryStore(t);
  assert.throws(() => store.repos.rosterEvents.record('nara', [{ id: 'm1' }], 'edited'), /unknown roster event kind/);
  assert.equal(store.repos.rosterEvents.record('nara', [], 'added'), 0);
  assert.equal(store.repos.rosterEvents.list().length, 0);
});

test('the table is bounded: past the cap only the newest rows survive', async (t) => {
  const store = await memoryStore(t);
  const batch = Array.from({ length: EVENTS_KEPT + 5 }, (_, i) => ({ id: `m${i}` }));
  store.repos.rosterEvents.record('nara', batch, 'added', 1000);
  assert.equal(countRows(store.db, 'roster_events'), EVENTS_KEPT);
  const rows = store.repos.rosterEvents.list({ limit: 200 });
  assert.equal(rows.length, 200);
  assert.equal(rows[rows.length - 1].model_id, 'm305', 'the five oldest went first');
  assert.ok(!rows.some((r) => ['m0', 'm1', 'm2', 'm3', 'm4'].includes(r.model_id)));
});
