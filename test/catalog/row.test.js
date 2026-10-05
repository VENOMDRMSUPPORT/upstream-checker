const test = require('node:test');
const assert = require('node:assert/strict');
const {
  providerRow, costKind, readPricing, matchIds, qualityProxyIds, rosterProxyIds, ROW_FIELDS,
} = require('../../src/catalog/row');

const base = (over = {}) => ({ id: 'lab/model', name: 'Model', ...over });
const day = new Date(1727000000000).toISOString().slice(0, 10);

test('the row is exactly the reference shape, with nothing invented', () => {
  assert.equal(ROW_FIELDS.length, 17, 'ref §8.1 counts seventeen fields');
  assert.deepEqual(Object.keys(providerRow(base(), 'nara')).sort(), [...ROW_FIELDS].sort());
});

test('an absent capability is null, never false — the rule the port rests on', () => {
  const row = providerRow(base(), 'nara');
  for (const field of ['tools', 'reasoning', 'structured', 'attachment',
    'context_tokens', 'output_tokens', 'cost_in_per_m', 'cost_out_per_m']) {
    assert.equal(row[field], null, `${field} must stay null when nobody published it`);
  }
  assert.equal(row.release_date, '', 'dates read as empty string');
  assert.equal(row.input_modalities, '');
  assert.equal(row.output_modalities, '');
  assert.equal(row.description, '');
  assert.equal(row.status, 'active');
});

test('today\'s !!m.hasVision is gone: vision unknown is not vision refused', () => {
  assert.equal(providerRow(base(), 'nara').attachment, null);
  assert.equal(providerRow(base({ modalities: { input: ['image'] } }), 'nara').attachment, null,
    'image input is an attachment claim only for file/pdf/document');
  assert.equal(providerRow(base({ modalities: { input: ['file', 'text'] } }), 'nara').attachment, true);
  assert.equal(providerRow(base({ attachment: false }), 'nara').attachment, false,
    'a published false is still an answer');
});

test('eight price spellings all land on cost per million', () => {
  const shapes = [
    { pricing: { input_usd_per_1m: 2, output_usd_per_1m: 10 } },
    { pricing: { input_per_1m: 2, output_per_1m: 10 } },
    { input_price_per_1m: 2, output_price_per_1m: 10 },
    { price_input: 2, price_output: 10 },
    { pricing: { prompt: '0.000002', completion: '0.00001' } },
    { input_cost_per_token: 0.000002, output_cost_per_token: 0.00001 },
    { pricing: { input: 2, output: 10 } },
    { isFree: true },
  ];
  shapes.forEach((shape, i) => {
    const row = providerRow(base(shape), 'nara');
    assert.equal(row.cost_in_per_m, i === 7 ? 0 : 2, `shape ${i} input`);
    assert.equal(row.cost_out_per_m, i === 7 ? 0 : 10, `shape ${i} output`);
  });
  assert.equal(costKind({ inCost: 0, outCost: 0 }), 'free');
  assert.equal(costKind({ inCost: 2, outCost: 10 }), 'token');
});

test('the preferred spelling wins when a provider co-publishes both spellings', () => {
  // src/renderer/catalog.js:154-155 tries `pricing.*` before the top-level fields.
  // An adapter that normalises onto `pricing` while still carrying its raw `0`
  // default at the top level read the top-level fields first and came out as `0`
  // with `cost_kind: 'free'`. Free is a claim, not a gap, and nothing downstream
  // can undo it.
  const row = providerRow(base({
    pricing: { input_usd_per_1m: 3, output_usd_per_1m: 15 },
    input_price_per_1m: 0, output_price_per_1m: 0,
  }), 'nara');
  assert.equal(row.cost_in_per_m, 3);
  assert.equal(row.cost_out_per_m, 15);
  assert.equal(row.cost_kind, 'token', 'a priced model co-publishing a raw 0 is not free');
  assert.deepEqual(readPricing({
    pricing: { input_per_1m: 2, output_per_1m: 8 }, price_input: 0, price_output: 0,
  }), { input: 2, output: 8 });
  assert.deepEqual(readPricing({
    pricing: { input_usd_per_1m: 5, input_per_1m: 1, output_usd_per_1m: 20, output_per_1m: 4 },
  }), { input: 5, output: 20 }, 'the same unit spelling wins within `pricing` too');
});

test('a negative published price reads as null, and the kind says unknown', () => {
  const row = providerRow(base({ pricing: { prompt: '-1', completion: '-1' } }), 'nara');
  assert.equal(row.cost_in_per_m, null);
  assert.equal(row.cost_out_per_m, null);
  assert.equal(row.cost_kind, 'unknown');
});

test('one free leg with no priced other leg is free, per the reference rule', () => {
  assert.equal(costKind({ inCost: 0, outCost: null }), 'free');
  assert.equal(costKind({ inCost: null, outCost: null }), 'unknown');
  assert.equal(costKind({ inCost: null, outCost: 10 }), 'token');
});

test('a published cost_kind survives the reader rather than being re-derived', () => {
  // Nexum's plan is flat-rate: the row says "subscription" and no price reading
  // may quietly turn that into "unknown" (ref §8.2).
  assert.equal(providerRow(base({ cost_kind: 'subscription' }), 'nexum').cost_kind, 'subscription');
  assert.deepEqual(readPricing({}), { input: null, output: null });
});

test('tools is read from every place a provider puts it, and stays null when none answer', () => {
  for (const shape of [{ supports_tools: true }, { supports_function_calling: true },
    { tool_call: true }, { capabilities: ['tools'] }, { capabilities: ['function_calling'] },
    { supported_parameters: ['tools'] }]) {
    assert.equal(providerRow(base(shape), 'nara').tools, true, JSON.stringify(shape));
  }
  assert.equal(providerRow(base({ supported_parameters: ['temperature'] }), 'nara').tools, null);
  assert.equal(providerRow(base({ supports_tools: false }), 'nara').tools, false,
    'a published false is an answer');
});

test('reasoning comes from the flag, the parameters, then the route name', () => {
  assert.equal(providerRow(base({ hasReasoning: true }), 'nara').reasoning, true);
  assert.equal(providerRow(base({ reasoning: true }), 'nara').reasoning, true);
  assert.equal(providerRow(base({ supported_parameters: ['include_reasoning'] }), 'nara').reasoning, true);
  assert.equal(providerRow(base({ id: 'lab/model-thinking' }), 'nara').reasoning, true,
    'a thinking route thinks; silence must not outrank the provider naming it');
  assert.equal(providerRow(base({ reasoning: false }), 'nara').reasoning, false);
});

// `hasReasoning` is not a provider field in this app: every adapter that sets it
// sets it through `!!` (src/renderer/app.js:1483-1487, providers/nara.js:87,
// providers/experiential.js:89) or hardcodes `false` (providers/tokenharbor.js:98).
// Reading it raw files a coerced silence as a published refusal, and
// src/catalog/scoring.js:369 then treats that `false` as an answer the catalog may
// never repair.
test('a coerced false reads as silence: hasReasoning is this app\'s `!!`, not a refusal', () => {
  assert.equal(providerRow(base({ hasReasoning: false }), 'nara').reasoning, null,
    'the shape every adapter actually produces when nobody said anything');
  assert.equal(providerRow(base({ id: 'meta-llama/llama-4-scout', hasReasoning: false }), 'nara')
    .reasoning, null);
  assert.equal(providerRow(base({ hasReasoning: false, supported_parameters: ['temperature'] }), 'nara')
    .reasoning, null, 'a parameter list that names no reasoning param is still silence');
  for (const raw of [{ reasoning: false }, { supports_reasoning: false }]) {
    assert.equal(providerRow(base({ ...raw, hasReasoning: false }), 'nara').reasoning, false,
      `a raw field that independently says false (${JSON.stringify(raw)}) is an answer`);
  }
  for (const raw of [{ reasoning: true }, { supports_reasoning: true },
    { capabilities: ['reasoning'] }, { supported_parameters: ['reasoning'] }]) {
    assert.equal(providerRow(base({ ...raw, hasReasoning: false }), 'nara').reasoning, true,
      `a raw field that says true (${JSON.stringify(raw)}) outranks the coerced flag`);
  }
  assert.equal(providerRow(base({ hasReasoning: false, id: 'lab/model-thinking' }), 'nara')
    .reasoning, true, 'a thinking route is still a thinking route');
});

test('structured comes from the flag, then the parameters', () => {
  assert.equal(providerRow(base({ structured_output: true }), 'nara').structured, true);
  assert.equal(providerRow(base({ supported_parameters: ['response_format'] }), 'nara').structured, true);
  assert.equal(providerRow(base({ supported_parameters: ['structured_outputs'] }), 'nara').structured, true);
  assert.equal(providerRow(base(), 'nara').structured, null);
});

test('modalities join both source spellings and dedupe case-insensitively', () => {
  const row = providerRow(base({
    modalities: { input: ['text', 'image'], output: ['text'] },
    architecture: { input_modalities: ['image', 'audio'], output_modalities: ['text', 'image'] },
  }), 'nara');
  assert.equal(row.input_modalities, 'text, image, audio');
  assert.equal(row.output_modalities, 'text, image');
});

test('output limit comes from four places, first real answer wins', () => {
  assert.equal(providerRow(base({ max_output_tokens: 4096 }), 'nara').output_tokens, 4096);
  assert.equal(providerRow(base({ max_completion_tokens: 2048 }), 'nara').output_tokens, 2048);
  assert.equal(providerRow(base({ top_provider: { max_completion_tokens: 1024 } }), 'nara').output_tokens, 1024);
  assert.equal(providerRow(base({ limit: { output: 512 } }), 'nara').output_tokens, 512);
});

test('context comes from limit, context_length or context_window', () => {
  assert.equal(providerRow(base({ limit: { context: 200000 } }), 'nara').context_tokens, 200000);
  assert.equal(providerRow(base({ context_length: 100000 }), 'nara').context_tokens, 100000);
  assert.equal(providerRow(base({ context_window: 32768 }), 'nara').context_tokens, 32768);
});

test('a created stamp becomes a release date, and a published date wins', () => {
  assert.equal(providerRow(base({ created: 1727000000 }), 'nara').release_date, day);
  assert.equal(providerRow(base({ created: 1727000000, release_date: '2026-01-02' }), 'nara').release_date, '2026-01-02');
});

test('name falls back to the id and a leading lab prefix is stripped', () => {
  assert.equal(providerRow({ id: 'lab/only-id' }, 'nara').name, 'lab/only-id');
  assert.equal(providerRow(base({ name: 'Anthropic: Claude Fable' }), 'nara').name, 'Claude Fable');
});

test('family is owned_by, then the id segment that is not the serving host, then empty', () => {
  assert.equal(providerRow(base({ owned_by: 'anthropic' }), 'nara').family, 'anthropic');
  assert.equal(providerRow(base({ ownedBy: 'Anthropic' }), 'nara').family, 'Anthropic');
  assert.equal(providerRow({ id: 'google/gemini-4' }, 'nara').family, 'google');
  assert.equal(providerRow(base(), 'lab').family, '',
    'the serving host is not a family — lab/model under lab publishes no family');
  assert.equal(providerRow({ id: 'deepseek-v4' }, 'nara').family, '',
    'and a family token is only a family in front of a slash');
  // The provider-relative rule, not a whitelist: every one of these is a real lab
  // with real rows, and a list of "known labs" lost all of them.
  for (const id of ['mistralai/mistral-large-3', 'deepseek-ai/deepseek-v3.2', 'xai/grok-4',
    'x-ai/grok-4', 'zai-org/glm-4.6', 'cohere/command-a', 'nvidia/nemotron-3-ultra',
    'xiaomi/mimo-v2.5']) {
    const [host] = id.split('/');
    assert.equal(providerRow({ id }, 'nara').family, host, `${id} lost its family`);
    assert.equal(providerRow({ id }, host).family, '', `${id} served by ${host} names no family`);
  }
});

// A routing host in front of an id is not model lineage. `dark-free/deepseek-v4.1-flash`
// is Dark API's free tier of somebody else's model (src/renderer/app.js:1426-1428,
// providers/darkapi.js:9), and `nexum/deepseek-v4` is a routed id: made purely
// provider-relative, both published `dark-free` and `nexum` as families — a host
// name in the lineage column, which the list this replaces never emitted. So the
// segment must be a known lab token, and the WHOLE segment: `deepseek-ai` reads as
// `deepseek-ai` (230 ids in the reference's models.dev cache), never as its own
// prefix `deepseek`, and `qwen-org` is not `qwen`.
test('a family is a known lab token in full, never a routing host or a prefix of one', () => {
  for (const [id, family] of [
    ['deepseek-ai/deepseek-v3.2', 'deepseek-ai'],
    ['x-ai/grok-4', 'x-ai'],
    ['mistralai/codestral', 'mistralai'],
  ]) {
    assert.equal(providerRow({ id }, 'nara').family, family, `${id} lost its lab`);
  }
  for (const [id, providerId] of [['dark-free/deepseek-v4.1-flash', 'darkapi'],
    ['nexum/deepseek-v4', 'nara'], ['qwen-org/qwen3-max', 'nara']]) {
    assert.equal(providerRow({ id }, providerId).family, '',
      `${id} served by ${providerId} is a host, not a family`);
  }
  // A lab whose name is a prefix of another lab's still reads as itself.
  assert.equal(providerRow({ id: 'deepseek/deepseek-v4' }, 'nara').family, 'deepseek');
});

test('status is kept when published and active otherwise', () => {
  assert.equal(providerRow(base({ status: 'deprecated' }), 'nara').status, 'deprecated');
  assert.equal(providerRow(base(), 'nara').status, 'active');
});

test('a model with no id is refused at the door, not filed under the empty string', () => {
  assert.throws(() => providerRow({ name: 'No Id' }, 'nara'), /nara listed a model with no id/);
  assert.throws(() => providerRow(null, 'nara'), /no id/);
});

test('a nexum-style thin row publishes nothing and therefore claims nothing', () => {
  const row = providerRow({ id: 'nexum/kimi-k3-thinking' }, 'nexum');
  assert.equal(row.tools, null);
  assert.equal(row.context_tokens, null);
  assert.equal(row.output_modalities, '');
  assert.equal(row.reasoning, true);
  assert.equal(row.cost_kind, 'unknown');
  assert.equal('match_ids' in row, false, 'aliases are the adapter\'s, not this reader\'s');
  assert.ok(matchIds('nexum/kimi-k3-thinking').length > 0);
});

test('matchIds emits the variants the reference matched on, quality tokens kept', () => {
  const ids = matchIds('nexum/deepseek-v4-thinking');
  assert.ok(ids.some((k) => k.includes('deepseek')));
  assert.ok(ids.some((k) => k.includes('v4')));
  assert.ok(!ids.some((k) => k.includes('nexum')), 'the routing prefix is not identity');
  assert.deepEqual(matchIds('qwen-3.8-max'), [
    'qwen3.8-max', 'qwen/qwen-3.8-max', 'qwen-3.8-max',
  ], 'the collapsed form the catalog has rows under leads, then the host form and the published id');
  assert.deepEqual(matchIds(''), []);
});

// The reference's own keys for these ids are lost when the lab is taken up to the
// FIRST hyphen: `x-ai-grok-4` split as lab `x` / rest `ai-grok-4` emits a key no
// catalog row has (`ai-grok-4`, 0 rows) instead of one that has five (`grok-4`).
test('matchIds splits the lab at the longest known lab token, not at the first hyphen', () => {
  for (const [id, key, half] of [['x-ai-grok-4', 'grok-4', 'ai-grok-4'],
    ['z-ai-glm-4.6', 'glm-4.6', 'ai-glm-4.6'],
    ['nexum/x-ai-grok-4', 'grok-4', 'ai-grok-4'],
    ['nexum/z-ai-glm-4.6', 'glm-4.6', 'ai-glm-4.6']]) {
    assert.ok(matchIds(id).includes(key), `${id} lost the reference's own key ${key}`);
    assert.equal(matchIds(id).includes(half), false,
      `${id} must not emit the half-token rest ${half} a first-hyphen split invents`);
  }
  // Every key the reference emits for its own examples survives.
  for (const [id, keys] of [
    ['nexum/meta-muse-spark-1.2', ['muse-spark-1.2', 'muse-spark-v1.2', 'meta/muse-spark-1.2']],
    ['nexum/xiaomi-mimo-2.5', ['mimo-2.5', 'mimo-v2.5', 'xiaomi/mimo-2.5']],
    ['nexum/qwen-3.8-max', ['qwen3.8-max']],
  ]) {
    for (const key of keys) assert.ok(matchIds(id).includes(key), `${id} lost ${key}`);
  }
});

// MATCH_AMBIGUOUS cannot protect a loose variant here: it fires when two CATALOG
// rows collide under one key, not when two provider rows reach the same alias, so
// the loose form that leads simply attaches the other model's score.
test('matchIds emits the precise form before any loose variant and never a bare number', () => {
  assert.equal(matchIds('qwen-3.8-max')[0], 'qwen3.8-max');
  assert.deepEqual(matchIds('openai/gpt-5'), ['gpt-5'],
    'no lab token fronts `gpt-5`, so there is nothing to collapse and no `gpt/gpt-5` to invent');
  for (const id of ['openai/gpt-5', 'x-ai-grok-4', 'z-ai-glm-4.6', 'qwen-3.8-max', 'meta-muse-spark-1.2']) {
    const ids = matchIds(id);
    assert.ok(ids.length > 0, `${id} still needs at least one alias`);
    for (const alias of ids) {
      assert.equal(/^\d/.test(alias), false, `${id} emitted the bare numeric rest ${alias}`);
    }
  }
});

test('qualityProxyIds points a thinking route at its base route', () => {
  assert.deepEqual(qualityProxyIds('nexum/deepseek-v4-thinking'), ['deepseek/deepseek-v4']);
  assert.deepEqual(qualityProxyIds('nexum/deepseek-v4'), []);
});

// The rule that carries a variant to its base when the provider declared a
// truncated name. Dark API declares `longcat`, `muse` and `step-3.7` for its
// -unrestricted routes; the only seven things it serves under those prefixes are
// the full names below. Uniqueness is the whole rule: two candidates means no
// answer, because picking one of two would be a guess.
test('rosterProxyIds resolves a truncated base against the roster that named it', () => {
  const roster = ['longcat-2.5-preview', 'longcat-unrestricted',
    'muse-spark-1.3-contributor', 'muse-unrestricted',
    'step-3.7-flash', 'step-3.7-unrestricted', 'unrestricted'];
  assert.deepEqual(rosterProxyIds('longcat-unrestricted', roster), ['longcat-2.5-preview']);
  assert.deepEqual(rosterProxyIds('muse-unrestricted', roster), ['muse-spark-1.3-contributor']);
  assert.deepEqual(rosterProxyIds('step-3.7-unrestricted', roster), ['step-3.7-flash']);
});

// Two served models under one prefix is not an answer. A variant that is the
// only thing under its own prefix borrows from nothing, and a bare token has no
// base to look for at all.
test('rosterProxyIds refuses anything that is not unique', () => {
  const two = ['acme-1', 'acme-2', 'acme-unrestricted'];
  assert.deepEqual(rosterProxyIds('acme-unrestricted', two), []);
  assert.deepEqual(rosterProxyIds('longcat-unrestricted', ['longcat-unrestricted']), []);
  assert.deepEqual(rosterProxyIds('unrestricted', ['longcat-2.5-preview']), []);
  assert.deepEqual(rosterProxyIds('longcat-2.5-preview', ['longcat-2.5-preview']), []);
  assert.deepEqual(rosterProxyIds('plain-model', ['plain-model']), []);
  assert.deepEqual(rosterProxyIds('', []), []);
});

// A variant never resolves to another variant, or two of them would point at
// each other and the reference would be asked for a score neither could supply.
test('rosterProxyIds never points a variant at another variant', () => {
  const roster = ['acme-model', 'acme-model-uncensored', 'acme-model-unrestricted'];
  assert.deepEqual(rosterProxyIds('acme-model-unrestricted', roster), ['acme-model']);
  const only = ['acme-model-uncensored', 'acme-model-unrestricted'];
  assert.deepEqual(rosterProxyIds('acme-model-unrestricted', only), []);
});

// The host's spelling is kept; the wrong one is understood. Dark API serves
// qwen3.8-27b-unsencored beside qwen3.8-27b, and only the base has a reference row.
test('a misspelled variant token still reaches its base', () => {
  const roster = ['qwen3.8-27b', 'qwen3.8-27b-unsencored'];
  assert.deepEqual(rosterProxyIds('qwen3.8-27b-unsencored', roster), ['qwen3.8-27b']);
  assert.deepEqual(qualityProxyIds('qwen3.8-27b-unsencored'), ['qwen3.8-27b']);
  assert.deepEqual(qualityProxyIds('acme-model-uncensored'), ['acme-model']);
});
