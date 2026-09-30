const test = require('node:test');
const assert = require('node:assert/strict');
const {
  providerRow, costKind, readPricing, matchIds, qualityProxyIds, ROW_FIELDS,
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

test('family is owned_by, then a known lab in front of the id, then empty', () => {
  assert.equal(providerRow(base({ owned_by: 'anthropic' }), 'nara').family, 'anthropic');
  assert.equal(providerRow(base({ ownedBy: 'Anthropic' }), 'nara').family, 'Anthropic');
  assert.equal(providerRow({ id: 'google/gemini-4' }, 'nara').family, 'google');
  assert.equal(providerRow(base(), 'nara').family, '',
    'the first segment of a routed id is a HOST, not a family — nexum/deepseek is not a lab');
  assert.equal(providerRow({ id: 'deepseek-v4' }, 'nara').family, '',
    'and a family token is only a family in front of a slash');
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
    'qwen/qwen-3.8-max', 'qwen-3.8-max', '3.8-max', 'qwen3.8-max',
  ], 'the dotted-version form the catalog knows, alongside the host form');
  assert.deepEqual(matchIds(''), []);
});

test('qualityProxyIds points a thinking route at its base route', () => {
  assert.deepEqual(qualityProxyIds('nexum/deepseek-v4-thinking'), ['deepseek/deepseek-v4']);
  assert.deepEqual(qualityProxyIds('nexum/deepseek-v4'), []);
});
