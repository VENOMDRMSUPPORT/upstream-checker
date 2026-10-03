const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// catalog-caps.js is a plain browser script of top-level consts and function
// declarations, the same shape as src/renderer/ulid.js. It is evaluated here
// and the functions taken out, which only works while it touches neither
// window nor document at evaluation time.
const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'catalog-caps.js'), 'utf8');
const F = new Function(`${source}\nreturn { CAT_CAPABILITIES, hasModality, capabilityState, capabilityOrigin, capabilitySet, capabilityCounts };`)();

const IDS = F.CAT_CAPABILITIES.map((c) => c.id);

// The rule the whole file exists for: a provider that published nothing has not
// refused anything. row.js opens by saying so, and scoring.js fillFromCatalog
// treats a stored false as a published answer — so a coerced false here would be
// painted on the legend and then sorted and routed on.
test('a row that published nothing is unknown on every capability, never a refusal', () => {
  const set = F.capabilitySet({});
  for (const id of IDS) {
    assert.strictEqual(set[id], null, `${id} should be unknown, got ${set[id]}`);
  }
  // And the absence of the row itself is the same silence.
  assert.strictEqual(F.capabilityState(null, 'tools'), null);
  assert.strictEqual(F.capabilityState(undefined, 'vision'), null);
});

// A published list that leaves a token out IS a refusal. Silence and a "no" are
// different facts and only one of them may light the icon red.
test('a published modality list that omits a token answers no', () => {
  assert.strictEqual(F.hasModality('text', 'image'), false);
  assert.strictEqual(F.hasModality('text, audio', 'image'), false);
  assert.strictEqual(F.hasModality('text, image', 'image'), true);
  assert.strictEqual(F.hasModality('', 'image'), null);
  assert.strictEqual(F.hasModality(null, 'image'), null);
});

test('vision and audio are read from the input modalities, case-insensitively', () => {
  const row = { input_modalities: 'text, Image, AUDIO' };
  assert.strictEqual(F.capabilityState(row, 'vision'), true);
  assert.strictEqual(F.capabilityState(row, 'audio'), true);
  assert.strictEqual(F.capabilityState({ input_modalities: 'text' }, 'vision'), false);
  assert.strictEqual(F.capabilityState({ input_modalities: 'text' }, 'audio'), false);
});

// Anything that is not literally true or false is a non-answer, not a yes.
test('only a real boolean counts as a published flag', () => {
  assert.strictEqual(F.capabilityState({ tools: true }, 'tools'), true);
  assert.strictEqual(F.capabilityState({ tools: false }, 'tools'), false);
  assert.strictEqual(F.capabilityState({ tools: 'true' }, 'tools'), null);
  assert.strictEqual(F.capabilityState({ tools: 1 }, 'tools'), null);
  assert.strictEqual(F.capabilityState({ tools: '' }, 'tools'), null);
});

test('files prefers the published flag and falls back to the modality list', () => {
  // The field wins even when the list says otherwise — row.js readsAttachment
  // takes the field first for the same reason.
  assert.strictEqual(F.capabilityState({ attachment: true, input_modalities: 'text' }, 'files'), true);
  assert.strictEqual(F.capabilityState({ attachment: false, input_modalities: 'text, file' }, 'files'), false);
  assert.strictEqual(F.capabilityState({ input_modalities: 'text, pdf' }, 'files'), true);
  assert.strictEqual(F.capabilityState({ input_modalities: 'text, document' }, 'files'), true);
  assert.strictEqual(F.capabilityState({ input_modalities: 'text' }, 'files'), false);
  assert.strictEqual(F.capabilityState({}, 'files'), null);
});

test('a declared generator answers yes with no modality published', () => {
  assert.strictEqual(F.capabilityState({ kind: 'video' }, 'video'), true);
  assert.strictEqual(F.capabilityState({ kind: 'image' }, 'imageGen'), true);
  assert.strictEqual(F.capabilityState({ kind: 'chat' }, 'video'), null);
  // Output modalities answer the same question when there is no declared kind.
  assert.strictEqual(F.capabilityState({ output_modalities: 'text, image' }, 'imageGen'), true);
  assert.strictEqual(F.capabilityState({ output_modalities: 'text' }, 'imageGen'), false);
  assert.strictEqual(F.capabilityState({ output_modalities: 'text' }, 'video'), false);
  assert.strictEqual(F.capabilityState({}, 'imageGen'), null);
});

test('capabilityOrigin names where each answer was read from', () => {
  assert.deepStrictEqual(F.capabilityOrigin({ tools: true }, 'tools'), { value: true, from: 'published' });
  assert.deepStrictEqual(F.capabilityOrigin({ input_modalities: 'text, image' }, 'vision'), { value: true, from: 'modalities' });
  assert.deepStrictEqual(F.capabilityOrigin({ attachment: true }, 'files'), { value: true, from: 'published' });
  assert.deepStrictEqual(F.capabilityOrigin({ input_modalities: 'text, file' }, 'files'), { value: true, from: 'modalities' });
  assert.deepStrictEqual(F.capabilityOrigin({ kind: 'video' }, 'video'), { value: true, from: 'kind' });
  assert.deepStrictEqual(F.capabilityOrigin({}, 'audio'), { value: null, from: 'silent' });
});

test('an unknown capability id is silence, not a crash', () => {
  assert.strictEqual(F.capabilityState({ tools: true }, 'telepathy'), null);
  assert.deepStrictEqual(F.capabilityOrigin({ tools: true }, 'telepathy'), { value: null, from: 'silent' });
});

// The legend's numbers. Only `true` counts: a gap in the sources is not a claim
// that the models on screen cannot do the thing.
test('capabilityCounts counts only published yes, and every id is present', () => {
  const counts = F.capabilityCounts([
    { tools: true, reasoning: true },
    { tools: true, input_modalities: 'text, image' },
    { tools: false, reasoning: null },
    {},
  ]);
  assert.strictEqual(counts.tools, 2);
  assert.strictEqual(counts.reasoning, 1);
  assert.strictEqual(counts.vision, 1);
  assert.strictEqual(counts.audio, 0);
  for (const id of IDS) assert.ok(id in counts, `${id} missing from the counts`);
  // An empty roster is all zeros, not an empty object — a tile would otherwise
  // read "undefined models".
  const empty = F.capabilityCounts([]);
  assert.deepStrictEqual(Object.keys(empty).sort(), IDS.slice().sort());
  assert.deepStrictEqual(F.capabilityCounts(null), empty);
});

// The tiles are drawn from this list, so it is UI: a duplicate id would make two
// tiles draw the same capability and one count go missing.
test('the eight capabilities are distinct and each has the fields a tile draws', () => {
  assert.strictEqual(IDS.length, 8);
  assert.strictEqual(new Set(IDS).size, 8);
  for (const cap of F.CAT_CAPABILITIES) {
    assert.ok(cap.id && cap.label && cap.blurb && cap.tone,
      `incomplete capability: ${JSON.stringify(cap)}`);
  }
});