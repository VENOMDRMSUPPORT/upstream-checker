const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// provider-facts.js is a plain browser script of top-level consts and function
// declarations, the same shape as src/renderer/catalog-caps.js. It is evaluated
// here and the functions taken out, which only works while it touches neither
// window nor document at evaluation time.
const source = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'renderer', 'provider-facts.js'), 'utf8');
const F = new Function(`${source}
return { TEST_INPUTS, MIN_SAMPLES_FOR_LATENCY, resolveContext, resolveScore, resolveCost,
  resolveCapabilityRow, resolveInputs, fmtPrice, columnHasData, resolveFacts,
  medianOf, resolveLatency, resolveVision, resolveReasoning, fmtMs, timeClassOf };`)();

// The rule the whole file exists for. A provider that published no limits leaves
// CONTEXT as dashes, not as a folded column; a provider that published no score
// leaves a column of dashes. Silence is not a zero, and an
// unrated model is not a bad one — so every gap has to come back as null.
test('a model with nothing published resolves to null, never to zero', () => {
  const f = F.resolveFacts({ id: 'mystery-1' }, null, null);
  assert.strictEqual(f.context, null);
  assert.strictEqual(f.score, null);
  assert.strictEqual(f.scoreSource, null);
  assert.deepStrictEqual(f.cost, { in: null, out: null });
  assert.deepStrictEqual(f.inputs.map((i) => i.state), [null, null, null, null, null]);
});

// The provider is authoritative for what IT serves, so its own published limit
// wins; the reference is the fallback, not the override.
test('the provider context wins and the reference fills only the gap', () => {
  assert.strictEqual(F.resolveContext(200000, { context_tokens: 128000 }), 200000);
  assert.strictEqual(F.resolveContext(null, { context_tokens: 128000 }), 128000);
  assert.strictEqual(F.resolveContext(undefined, { context_tokens: 128000 }), 128000);
  assert.strictEqual(F.resolveContext(null, null), null);
  assert.strictEqual(F.resolveContext(null, {}), null);
  // A reference context of 0 is a published 0, not a gap to fill.
  assert.strictEqual(F.resolveContext(null, { context_tokens: 0 }), 0);
});

// The score is the reference's alone, and its tier has to travel with it: a
// fitted estimate and a measured index are not the same claim.
test('the score carries its tier, and an unrated model stays unrated', () => {
  assert.deepStrictEqual(F.resolveScore({ score: 52.7, score_source: 'aa' }), { value: 52.7, source: 'aa' });
  assert.deepStrictEqual(F.resolveScore({ score: 39.0, score_source: 'est' }), { value: 39.0, source: 'est' });
  assert.deepStrictEqual(F.resolveScore({ score: null }), { value: null, source: null });
  assert.deepStrictEqual(F.resolveScore({}), { value: null, source: null });
  assert.deepStrictEqual(F.resolveScore(null), { value: null, source: null });
  // A zero is a value somebody published, so it survives.
  assert.deepStrictEqual(F.resolveScore({ score: 0, score_source: 'aa' }), { value: 0, source: 'aa' });
});

// A free model and an unpriced model are different facts. Only the reference may
// say a price is 0, because row.js cost_kind is the thing that can walk it back.
test('an unpriced model is null, and a published zero is a zero', () => {
  assert.deepStrictEqual(F.resolveCost({ cost_in_per_m: 0, cost_out_per_m: 0 }), { in: 0, out: 0 });
  assert.deepStrictEqual(F.resolveCost({ cost_in_per_m: 0.1, cost_out_per_m: 0.2 }), { in: 0.1, out: 0.2 });
  assert.deepStrictEqual(F.resolveCost({ cost_in_per_m: null, cost_out_per_m: 0.2 }), { in: null, out: 0.2 });
  assert.deepStrictEqual(F.resolveCost(null), { in: null, out: null });
});

// The ingested row is already normalised by mapRows, so it is used whole; the
// raw provider model only covers the window before an ingest has answered.
test('the ingested row is preferred, and the raw model is the fallback', () => {
  const cat = { input_modalities: 'text, image', tools: true };
  assert.strictEqual(F.resolveCapabilityRow({ input_modalities: 'text' }, cat), cat);
  const raw = F.resolveCapabilityRow({ input_modalities: 'text', tools: true }, null);
  assert.strictEqual(raw.input_modalities, 'text');
  assert.strictEqual(raw.tools, true);
  // An empty ingested row is not a normalised row, so the raw model answers.
  const raw2 = F.resolveCapabilityRow({ kind: 'chat' }, {});
  assert.strictEqual(raw2.kind, 'chat');
});

// The chip asks about a modality TOKEN, not a legend capability id. `vision` is
// the legend's name for the image token and `video` there is video GENERATION —
// an output — so reading an input off either id answers the wrong question.
test('the five inputs are read from the modality tokens, not the legend ids', () => {
  const inputs = (mods) => F.resolveInputs({ input_modalities: mods }).map((i) => i.state);
  assert.deepStrictEqual(F.resolveInputs({}).map((i) => i.token), ['text', 'image', 'audio', 'video', 'pdf']);
  assert.deepStrictEqual(inputs('text'), [true, false, false, false, false]);
  assert.deepStrictEqual(inputs('text, image'), [true, true, false, false, false]);
  assert.deepStrictEqual(inputs('text,image,audio,video,pdf'), [true, true, true, true, true]);
  assert.deepStrictEqual(inputs('TEXT, IMAGE'), [true, true, false, false, false]);
  // A generator that declares output video is NOT an input-video model.
  assert.deepStrictEqual(F.resolveInputs({ kind: 'video', output_modalities: 'video' })
    .map((i) => i.state), [null, null, null, null, null]);
});

// Silence and a refusal are different facts: only a published list that omits a
// token may draw the struck-through chip.
test('a published list that omits a token answers no, and silence answers nothing', () => {
  const byToken = (row) => Object.fromEntries(F.resolveInputs(row).map((i) => [i.token, i.state]));
  assert.strictEqual(byToken({ input_modalities: 'text' }).image, false);
  assert.strictEqual(byToken({ input_modalities: '' }).image, null);
  assert.strictEqual(byToken({ input_modalities: null }).image, null);
  assert.strictEqual(byToken({}).image, null);
});

// `files` prefers the published boolean and falls back to the list, matching
// row.js readsAttachment and catalog-caps.filesState.
test('pdf prefers the published attachment flag over the modality list', () => {
  const pdf = (row) => F.resolveInputs(row)[4].state;
  assert.strictEqual(pdf({ attachment: true, input_modalities: 'text' }), true);
  assert.strictEqual(pdf({ attachment: false, input_modalities: 'text, file' }), false);
  assert.strictEqual(pdf({ input_modalities: 'text, pdf' }), true);
  assert.strictEqual(pdf({ input_modalities: 'text, document' }), true);
  assert.strictEqual(pdf({ input_modalities: 'text, file' }), true);
  assert.strictEqual(pdf({ input_modalities: 'text' }), false);
  assert.strictEqual(pdf({}), null);
});

// Prices span four orders of magnitude, so the decimal count has to move with
// them or the cheap end rounds to zero and the dear end turns to noise.
test('prices are formatted at a precision that survives the range', () => {
  assert.strictEqual(F.fmtPrice(0), '0');
  assert.strictEqual(F.fmtPrice(30), '30.00');
  assert.strictEqual(F.fmtPrice(1.5), '1.50');
  assert.strictEqual(F.fmtPrice(0.1), '0.100');
  assert.strictEqual(F.fmtPrice(0.002), '0.0020');
  assert.strictEqual(F.fmtPrice(0.0001), '0.0001');
  assert.strictEqual(F.fmtPrice(null), '—');
  assert.strictEqual(F.fmtPrice(undefined), '—');
  assert.strictEqual(F.fmtPrice('abc'), '—');
});

// columnHasData reports data presence per column. Every provider shows the same
// columns, always — an empty column renders em-dashes rather than folding away.
test('columnHasData reports whether any row has an answer for a column', () => {
  const none = [F.resolveFacts({ id: 'a' }, null, null)];
  assert.strictEqual(F.columnHasData(none, 'context'), false);
  assert.strictEqual(F.columnHasData(none, 'score'), false);
  assert.strictEqual(F.columnHasData(none, 'price'), false);
  assert.strictEqual(F.columnHasData(none, 'caps'), false);

  // One row with a fact is enough to report data — it is per column, not
  // per row.
  const one = [F.resolveFacts({ id: 'a' }, null, null),
    F.resolveFacts({ id: 'b' }, { score: 52.7, score_source: 'aa', context_tokens: 128000,
      cost_in_per_m: 1.25, cost_out_per_m: 4.25, input_modalities: 'text' }, null)];
  assert.strictEqual(F.columnHasData(one, 'context'), true);
  assert.strictEqual(F.columnHasData(one, 'score'), true);
  assert.strictEqual(F.columnHasData(one, 'price'), true);
  assert.strictEqual(F.columnHasData(one, 'caps'), true);

  assert.strictEqual(F.columnHasData([], 'score'), false);
  assert.strictEqual(F.columnHasData(null, 'score'), false);
  assert.strictEqual(F.columnHasData(one, 'nonsense'), false);
  // A free model reports data for PRICE: 0 is an answer, null is not.
  const free = [F.resolveFacts({ id: 'c' }, { cost_in_per_m: 0, cost_out_per_m: 0 }, null)];
  assert.strictEqual(F.columnHasData(free, 'price'), true);
});

// A median of one reading is a measurement wearing a statistic's name, so the
// floor is the same rule the page already applies to uptime.
test('a median needs its samples before it will claim to be one', () => {
  assert.strictEqual(F.MIN_SAMPLES_FOR_LATENCY, 2);
  assert.deepStrictEqual(F.medianOf([]), { p50: null, samples: 0 });
  assert.deepStrictEqual(F.medianOf(null), { p50: null, samples: 0 });
  // One reading is reported as a count, never as a p50.
  assert.deepStrictEqual(F.medianOf([741]), { p50: null, samples: 1 });
  assert.deepStrictEqual(F.medianOf([741, 900]), { p50: 821, samples: 2 });
  // Odd counts take the middle; even counts average the two middles and round,
  // because a latency is shown in whole milliseconds.
  assert.deepStrictEqual(F.medianOf([100, 200, 900]), { p50: 200, samples: 3 });
  assert.deepStrictEqual(F.medianOf([100, 201, 300, 400]), { p50: 251, samples: 4 });
  // Order does not matter, and a non-number is not a reading.
  assert.deepStrictEqual(F.medianOf([900, 100, 200]), { p50: 200, samples: 3 });
  assert.deepStrictEqual(F.medianOf([100, null, undefined, 'x', NaN, 200]), { p50: 150, samples: 2 });
  assert.deepStrictEqual(F.resolveLatency([5, 5, 5]).p50, 5);
  // A measured 0 is a reading, not a gap.
  assert.deepStrictEqual(F.medianOf([0, 0]), { p50: 0, samples: 2 });
});

// The provider's own `hasVision` is false both when it refused vision and when
// it said nothing. Only one of those may be drawn as a refusal, so the table
// reads the merged row instead and keeps the third state.
test('vision and reasoning are three-state, not the provider boolean', () => {
  assert.strictEqual(F.resolveVision({ input_modalities: 'text, image' }), true);
  assert.strictEqual(F.resolveVision({ input_modalities: 'text' }), false);
  assert.strictEqual(F.resolveVision({}), null);
  assert.strictEqual(F.resolveVision(null), null);
  // Case-insensitive, like every other modality read on the page.
  assert.strictEqual(F.resolveVision({ input_modalities: 'TEXT, IMAGE' }), true);

  assert.strictEqual(F.resolveReasoning({ reasoning: true }), true);
  assert.strictEqual(F.resolveReasoning({ reasoning: false }), false);
  // A non-boolean is a non-answer, the same rule publishedBool enforces.
  assert.strictEqual(F.resolveReasoning({ reasoning: 'true' }), null);
  assert.strictEqual(F.resolveReasoning({}), null);
  assert.strictEqual(F.resolveReasoning(null), null);
});

test('latency reports data only when a row has a median', () => {
  const none = [F.resolveFacts({ id: 'a' }, null, null, [])];
  assert.strictEqual(F.columnHasData(none, 'latency'), false);
  // One sample is not a median, so it does not report data either.
  assert.strictEqual(F.columnHasData([F.resolveFacts({ id: 'a' }, null, null, [741])], 'latency'), false);
  const some = [F.resolveFacts({ id: 'a' }, null, null, [741]), F.resolveFacts({ id: 'b' }, null, null, [800, 900])];
  assert.strictEqual(F.columnHasData(some, 'latency'), true);
  assert.strictEqual(F.resolveFacts({ id: 'b' }, null, null, [800, 900]).latency, 850);
  assert.strictEqual(F.resolveFacts({ id: 'b' }, null, null, [800, 900]).latencySamples, 2);
});

// The two pages print the same measurement, so the shape has to be the same one
// catalog.js uses — and a gap is a dash, never "0ms".
test('a duration is printed the way the Models page prints it', () => {
  assert.strictEqual(F.fmtMs(null), '—');
  assert.strictEqual(F.fmtMs(undefined), '—');
  assert.strictEqual(F.fmtMs(0), '0ms');
  assert.strictEqual(F.fmtMs(741), '741ms');
  assert.strictEqual(F.fmtMs(999), '999ms');
  assert.strictEqual(F.fmtMs(1000), '1.0s');
  assert.strictEqual(F.fmtMs(1500), '1.5s');
  assert.strictEqual(F.fmtMs(9999), '10.0s');
  // Past ten seconds the tenth is noise, exactly as catalog.js drops it.
  assert.strictEqual(F.fmtMs(10000), '10s');
  assert.strictEqual(F.fmtMs(22170), '22s');
});

test('the magnitude classes match the ones the table already paints time with', () => {
  assert.strictEqual(F.timeClassOf(null), 'dt-muted');
  assert.strictEqual(F.timeClassOf(100), 'time-fast');
  assert.strictEqual(F.timeClassOf(1999), 'time-fast');
  assert.strictEqual(F.timeClassOf(2000), 'time-mid');
  assert.strictEqual(F.timeClassOf(6000), 'time-slow');
});

// One row end to end, so the pieces are proved to fit together.
test('a fully published model resolves every fact in one call', () => {
  const model = { id: 'gpt-6-astra', context_window: 400000 };
  // The caller reads the provider's own limit with app.js readContextWindow and
  // passes it in — the one context reader stays in app.js rather than being
  // reimplemented here, so the two pages cannot disagree about the same model.
  const f = F.resolveFacts(
    model,
    { context_tokens: 1000000, score: 52.7, score_source: 'aa',
      cost_in_per_m: 1.25, cost_out_per_m: 4.25,
      input_modalities: 'text, image, pdf', tools: true, reasoning: true },
    model.context_window);
  assert.strictEqual(f.context, 400000);
  assert.strictEqual(f.score, 52.7);
  assert.strictEqual(f.scoreSource, 'aa');
  assert.deepStrictEqual(f.cost, { in: 1.25, out: 4.25 });
  assert.deepStrictEqual(f.inputs.map((i) => [i.token, i.state]),
    [['text', true], ['image', true], ['audio', false], ['video', false], ['pdf', true]]);
  assert.strictEqual(f.capRow.tools, true);
});
