'use strict';

/**
 * Non-text models are excluded everywhere (owner's ruling, 2026-09-16).
 *
 * An image, video or audio generator is not something this router can route to,
 * and carrying one as a permanently unrated row was the visible half of that. It
 * is dropped from the catalog, from the ingest, from the snapshot and from the
 * diff.
 *
 * The rule is PROVEN non-text, never "unproven text", and the direction matters:
 * the tiers gate refuses the unknown because refusing to ROUTE costs one request,
 * while deleting the unknown from the catalog would erase every listing from a
 * provider that publishes no metadata — all eighteen of the reference's
 * nexum-router's among them.
 *
 * Ported from the reference's test/non-text.test.js with one structural change:
 * `engine.isNonTextModel(row)` was reached through a module singleton there. Here
 * the engine lives in main and the filter runs at ingest, so the third proof
 * arrives as the injected `isNonTextModel` argument of
 * `dropNonText({ provider, rows, isNonTextModel })`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCatalog } = require('../../src/catalog/build');
const { buildMatchIndex, lookupCatalogRow } = require('../../src/catalog/scoring');
const { declaresNonTextOutput, dropNonText, syncSnapshot } = require('../../src/catalog/snapshot');

const DAY = 86400000;
const T0 = 1727000000000;   // a fixed anchor; tests must not depend on the clock

function memStore() {
  const files = new Map();
  return {
    read: (id) => (files.has(id) ? structuredClone(files.get(id)) : null),
    write: (id, snapshot) => { files.set(id, structuredClone(snapshot)); },
    dump: (id) => files.get(id),
  };
}

// --------------------------------------------------------------------------
// The test itself

test('a published non-text output is proof; silence is not', () => {
  assert.equal(declaresNonTextOutput({ output_modalities: 'video' }), true);
  assert.equal(declaresNonTextOutput({ output_modalities: 'image' }), true);
  assert.equal(declaresNonTextOutput({ output_modalities: 'audio' }), true);

  assert.equal(declaresNonTextOutput({ output_modalities: 'text' }), false);
  assert.equal(declaresNonTextOutput({ output_modalities: 'text, image' }), false,
    'a model that ALSO emits text is a text model');

  // The line the whole ruling rests on.
  assert.equal(declaresNonTextOutput({ output_modalities: '' }), false, 'nothing published is not proof');
  assert.equal(declaresNonTextOutput({}), false);
  assert.equal(declaresNonTextOutput({ output_modalities: null }), false);
  assert.equal(declaresNonTextOutput(null), false, 'and neither is a row that is not there');
});

// --------------------------------------------------------------------------
// The catalog

/** models.dev's own shape, trimmed to the fields buildCatalog reads. */
function spec(models) {
  return {
    testhost: {
      name: 'Test Host',
      models: Object.fromEntries(models.map((m) => [m.id, m])),
    },
  };
}

const CHAT = {
  id: 'chat-model',
  name: 'Chat Model',
  modalities: { input: ['text'], output: ['text'] },
  limit: { context: 128000, output: 8192 },
  cost: { input: 1, output: 2 },
};
const VIDEO = {
  id: 'video-model',
  name: 'Video Model',
  modalities: { input: ['text'], output: ['video'] },
  limit: { context: 128000 },
  cost: { input: 1, output: 2 },
};

function build(models) {
  return buildCatalog({
    spec: spec(models),
    openrouter: { data: [] },
    benchmarks: { data: [] },
    lmarena: null,
  });
}

test('output_modalities reaches the row at all', () => {
  // It was computed and dropped: every row carried `undefined`, so the tiers
  // gate that reads it saw `modality_unknown` for the entire fleet.
  const { rows } = build([CHAT]);
  assert.equal(rows.length, 1);
  assert.match(String(rows[0].output_modalities), /text/);
});

test('a video model never enters the catalog', () => {
  const { rows, nonText } = build([CHAT, VIDEO]);

  assert.deepEqual(rows.map((r) => r.id), ['testhost/chat-model']);
  assert.equal(nonText.length, 1, 'it is returned as evidence, not merely discarded');
  assert.equal(nonText[0].id, 'testhost/video-model');
});

test('a row that publishes no modality is kept', () => {
  const quiet = { id: 'quiet-model', name: 'Quiet', limit: { context: 1000 }, cost: { input: 1, output: 2 } };
  const { rows } = build([CHAT, quiet]);

  assert.equal(rows.length, 2, 'silence must never delete a provider\'s listings');
});

test('the dropped rows are gone BEFORE the fits are computed', () => {
  // A text-to-video model's price and context would otherwise sit in the spec
  // regression that estimates every chat model's score.
  const { rows } = build([CHAT, VIDEO]);
  for (const row of rows) {
    assert.notEqual(row.id, 'testhost/video-model');
    // And it cannot have taken a rank either.
    if (row.rank != null) assert.ok(row.rank >= 1);
  }
});

// --------------------------------------------------------------------------
// The ingest filter, and the three proofs it accepts

/**
 * The engine's own third proof, rebuilt from the two pieces it is made of: the
 * non-text evidence the reference keeps beside the catalog, and the lookup that
 * reaches a catalog row through a provider row's aliases.
 */
const engineProof = (nonText) => {
  const index = buildMatchIndex(nonText);
  return (row) => Boolean(lookupCatalogRow(row, index));
};

test('a provider row is dropped when the CATALOG recognises it, not only when it declares', () => {
  const { nonText } = build([CHAT, VIDEO]);
  const isNonTextModel = engineProof(nonText);

  // A provider that publishes NOTHING about modality — nexum-router's shape.
  const known = { id: 'video-model', name: 'Video Model', match_ids: ['testhost/video-model'] };
  const other = { id: 'chat-model', name: 'Chat Model', match_ids: ['testhost/chat-model'] };

  assert.equal(isNonTextModel(known), true, 'recognised through the model it matches');
  assert.equal(isNonTextModel(other), false);
  assert.equal(isNonTextModel({ id: 'never-heard-of-it', name: '?' }), false, 'no match is not evidence');

  const { kept, dropped } = dropNonText({
    provider: { id: 'silent-provider' },
    rows: [known, other],
    isNonTextModel,
  });
  assert.deepEqual(kept.map((r) => r.id), ['chat-model']);
  assert.deepEqual(dropped, ['video-model']);
});

test('any one of the three proofs drops the row, and none of them keeps it', () => {
  const { nonText } = build([CHAT, VIDEO]);
  const rows = [
    { id: 'declared', name: 'Declared', output_modalities: 'video' },
    { id: 'enumerated', name: 'Enumerated', output_modalities: 'text' }, // the document is wrong
    { id: 'recognised', name: 'Recognised', match_ids: ['testhost/video-model'] },
    { id: 'chat', name: 'Chat', output_modalities: 'text' },
  ];
  const provider = { id: 'p', NON_TEXT_MODELS: { enumerated: 'returns typed decisions, never text (read 2026-09-19)' } };

  // Every proof on its own, with the other two switched off.
  const { dropped: allThree } = dropNonText({ provider, rows, isNonTextModel: engineProof(nonText) });
  assert.deepEqual(allThree, ['declared', 'enumerated', 'recognised'], 'and the text model survives');
  const { dropped: declaredOnly } = dropNonText({ provider: { id: 'p' }, rows, isNonTextModel: () => false });
  assert.deepEqual(declaredOnly, ['declared']);
  const { dropped: enumeratedOnly } = dropNonText({ provider, rows, isNonTextModel: () => false });
  assert.deepEqual(enumeratedOnly, ['declared', 'enumerated']);
  const { dropped: recognisedOnly } = dropNonText({ provider: { id: 'p' }, rows, isNonTextModel: engineProof(nonText) });
  assert.deepEqual(recognisedOnly, ['declared', 'recognised']);
});

test('the enumerated list is applied through `forget`, not by silent filtering', () => {
  const provider = {
    id: 'enumerating-provider',
    NON_TEXT_MODELS: { 'decision-model': 'returns typed decisions, never text (read 2026-09-19)' },
  };
  const rows = [
    { id: 'chat-model', name: 'Chat', output_modalities: 'text' },
    { id: 'decision-model', name: 'Decision', output_modalities: 'text' }, // the document is wrong
  ];

  const { kept, dropped } = dropNonText({ provider, rows });
  assert.deepEqual(kept.map((r) => r.id), ['chat-model']);
  // In `dropped` is what makes it a `forget` id downstream — the snapshot diff
  // must never call this a removal (see the tests below).
  assert.deepEqual(dropped, ['decision-model']);

  // A provider that declares nothing is unaffected: the list is opt-in.
  const plain = dropNonText({ provider: { id: 'plain-provider' }, rows });
  assert.deepEqual(plain.kept.map((r) => r.id), ['chat-model', 'decision-model']);
});

test('dropNonText answers with the { kept, dropped } shape even for a payload that is not a list', () => {
  // The reference returned the bare payload here; this port never does, so a
  // caller cannot read `undefined.length` when a provider hands back an object.
  const out = dropNonText({ provider: { id: 'p' }, rows: null });
  assert.deepEqual(out, { kept: null, dropped: [] });
});

// --------------------------------------------------------------------------
// The diff must not report our own filtering as the provider's removal

test('a filtered model is forgotten, never reported as removed', () => {
  const store = memStore();
  const row = (id) => ({ id, name: id });

  // The provider listed three models, including a video one.
  syncSnapshot(store, 'p', [row('chat'), row('other'), row('video')], T0);

  // Now this app filters the video model out. The provider still lists it.
  const changes = syncSnapshot(store, 'p', [row('chat'), row('other')], T0 + DAY, ['video']);

  assert.deepEqual(changes.removed, [], 'the provider removed nothing, so nothing is reported removed');
  assert.equal(changes.moved.disappeared, 0, "and nothing 'moved' — an event here would be a lie");

  // And it leaves no tombstone to resurface in the 30-day removed window.
  const snapshot = store.dump('p');
  assert.equal('video' in snapshot.models, false);
});

test('a filtered id already in the snapshot leaves without a removal notice, and can come back', () => {
  // The reference's Zen case (jev-1.13-free, 2026-09-19): a listing that is
  // already stored when the enumeration starts to cover it must leave quietly,
  // and — because this app filtered it rather than the provider removing it — a
  // later return is not a discovery either.
  const store = memStore();
  const row = (id) => ({ id, name: id });
  syncSnapshot(store, 'zen', [row('chat'), row('jev')], T0);
  const gone = syncSnapshot(store, 'zen', [row('chat')], T0 + DAY, ['jev']);
  assert.deepEqual(gone.removed, []);
  assert.deepEqual(gone.moved, { appeared: 0, disappeared: 0 });

  const back = syncSnapshot(store, 'zen', [row('chat'), row('jev')], T0 + 2 * DAY);
  assert.equal(back.moved.appeared, 1, 'the roster did change just now');
  assert.deepEqual(back.added.map((m) => m.id), ['jev'],
    'and it returns as a first sighting: `forget` gave up the history too, which is the price '
    + 'of not writing a tombstone for something the provider never removed');
  assert.equal(store.dump('zen').models.jev.removed_at, undefined);
});

test('a model the PROVIDER really dropped is still reported', () => {
  const store = memStore();
  const row = (id) => ({ id, name: id });
  syncSnapshot(store, 'p', [row('chat'), row('gone')], T0);
  const changes = syncSnapshot(store, 'p', [row('chat')], T0 + DAY, []);

  assert.equal(changes.moved.disappeared, 1, 'a real removal must still fire');
  assert.deepEqual(changes.removed.map((m) => m.id), ['gone']);
});

test('forgetting an id is not a mass drop: filtered rows never count toward the quarantine', () => {
  // The provider lists eight models, three of them generators this app refuses.
  // Because they are dropped before the snapshot is written, the roster the NEXT
  // sync is diffed against holds five listings, not eight — and eight-to-three
  // is a truncation worth quarantining while five-to-three is not.
  const listed = Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, name: `M${i}` }));
  const forget = ['m5', 'm6', 'm7'];
  const kept = listed.filter((row) => !forget.includes(row.id));

  const withFilter = memStore();
  syncSnapshot(withFilter, 'p', kept, T0, forget);
  assert.equal(Object.keys(withFilter.dump('p').models).length, 5, 'the snapshot never learned the filtered three');
  const trimmed = syncSnapshot(withFilter, 'p', kept.slice(0, 3), T0 + DAY, forget);
  assert.equal(trimmed.removed.length, 2, 'two real absences, reported as absences');
  assert.equal(withFilter.read('p').pendingDrop, undefined, 'five to three loses two: a roster change, not a truncation');

  const withoutFilter = memStore();
  syncSnapshot(withoutFilter, 'p', listed, T0);
  assert.throws(() => syncSnapshot(withoutFilter, 'p', listed.slice(0, 3), T0 + DAY),
    (e) => e.code === 'SUSPICIOUS_PROVIDER_DROP', 'the same answer against eight active rows is');
});
