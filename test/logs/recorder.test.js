const test = require('node:test');
const assert = require('node:assert');
const { buildRecord, createRecorder } = require('../../src/logs/recorder');

const NARA = 'https://router.bynara.id/v1';
const RUN = '01J00000000000000000000000';
const GROUP = '01J00000000000000000000001';
const PROVIDERS = [
  { id: 'nara', name: 'NaraRouter', baseUrl: NARA },
  { id: 'mirai', name: 'Mirai', baseUrl: 'https://api.miraiapi.com/v1' },
  { id: 'twin_a', name: 'A', baseUrl: 'https://shared.example/v1' },
  { id: 'twin_b', name: 'B', baseUrl: 'https://shared.example/v2' },
];
const prices = {
  get: (p, m) => {
    if (p === 'nara' && m === 'm1') return { input: 2, output: 10 };
    if (p === 'nara' && m === 'free-m') return { input: 0, output: 0 };
    return null;
  },
};
const opts = { prices, providers: PROVIDERS, logLevel: 'errors', newUid: () => 'UID0' };

const BASE_ARGS = {
  url: `${NARA}/chat/completions`,
  method: 'POST',
  headers: { Authorization: 'Bearer venomkey:key_1', 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'm1', messages: [] }),
  requestId: 'req_1',
  timeoutMs: 60000,
  source: 'route_test',
  runId: RUN,
  attempt: 2,
  hedgeIndex: 1,
  testGroup: GROUP,
  trigger: 'manual',
};

function done(over = {}) {
  const { args, ...rest } = over;
  return {
    args: { ...BASE_ARGS, ...(args || {}) },
    startedAt: 1790000000000,
    refs: [{ kind: 'key', id: 'key_1', providerId: 'nara' }],
    substitutions: [{ placeholder: 'venomkey:key_1', secret: 'sk-nara-1' }],
    outcome: 'end',
    cancelReason: null,
    httpStatus: 200,
    contentType: 'application/json',
    responseText: JSON.stringify({ model: 'm1-0925', choices: [{ message: { content: '4' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }),
    error: null,
    elapsed: 812,
    firstByteMs: 700,
    firstTokenMs: 790,
    ...rest,
  };
}

test('a successful chat: identity, tags, model, usage, cost and meta', () => {
  const { row, body } = buildRecord(done(), opts);
  assert.strictEqual(body, null);
  assert.deepStrictEqual(row, {
    request_uid: 'UID0', created_at: 1790000000000, source: 'route_test', run_id: RUN, attempt: 2, is_hedge: 1,
    provider_id: 'nara', provider_name: 'NaraRouter', key_id: 'key_1', method: 'POST',
    endpoint: 'https://router.bynara.id/v1/chat/completions', model_requested: 'm1', model_returned: 'm1-0925',
    is_stream: 0, status: 'ok', http_status: 200, error_class: null, error_code: null, error_message: null,
    latency_ms: 812, ttft_ms: null, first_byte_ms: 700,
    input_tokens: 5, output_tokens: 1, cached_tokens: null, cache_write_tokens: null, reasoning_tokens: null,
    usage_source: 'reported', cost_micros: 20, price_json: '{"input":2,"output":10}',
    meta_json: JSON.stringify({ requestId: 'req_1', timeoutMs: 60000, trigger: 'manual', hedgeIndex: 1, testGroup: GROUP }),
    user_id: null, token_id: null, subscription_id: null, client_ip: null,
  });
});

test('an unknown source is other; missing or malformed tags fall back to the defaults', () => {
  const { row } = buildRecord(done({ args: {
    source: 'telemetry', runId: 42, attempt: 0, hedgeIndex: -1, trigger: 'cron', testGroup: 'x'.repeat(65),
    requestId: undefined, timeoutMs: undefined, paramSwap: 'yes',
  } }), opts);
  assert.deepStrictEqual([row.source, row.run_id, row.attempt, row.is_hedge, row.meta_json], ['other', null, 1, 0, null]);
  const swapped = buildRecord(done({ args: {
    requestId: undefined, timeoutMs: undefined, trigger: undefined, hedgeIndex: undefined, testGroup: undefined, paramSwap: true,
  } }), opts).row;
  assert.strictEqual(swapped.meta_json, '{"paramSwap":true}');
});

test('a secret ref is key_id secret:<name>; without a key, the one provider at that origin, none when two share it', () => {
  const secret = buildRecord(done({
    args: { url: 'https://artificialanalysis.ai/api/v2/data/llms/models', method: 'GET', headers: { 'x-api-key': 'venomsecret:aaApiKey' }, body: undefined },
    refs: [{ kind: 'secret', id: 'aaApiKey', providerId: null }],
  }), opts).row;
  assert.deepStrictEqual([secret.provider_id, secret.provider_name, secret.key_id, secret.model_requested], [null, null, 'secret:aaApiKey', null]);
  const byOrigin = buildRecord(done({ args: { url: 'https://api.miraiapi.com/api/usage/check' }, refs: [] }), opts).row;
  assert.deepStrictEqual([byOrigin.provider_id, byOrigin.provider_name, byOrigin.key_id], ['mirai', 'Mirai', null]);
  const shared = buildRecord(done({ args: { url: 'https://shared.example/v1/models' }, refs: [] }), opts).row;
  assert.deepStrictEqual([shared.provider_id, shared.provider_name], [null, null]);
});

test('a blocked request names the refused key, parses nothing and keeps its body', () => {
  const { row, body } = buildRecord(done({
    outcome: 'blocked', httpStatus: null, contentType: null, responseText: '', elapsed: 0, firstByteMs: null, firstTokenMs: null,
    error: "Key blocked: evil.test is not this key's provider",
    args: { url: 'https://evil.test/v1/models' },
  }), opts);
  assert.deepStrictEqual(
    [row.status, row.error_class, row.http_status, row.key_id, row.provider_id, row.endpoint, row.error_message, row.usage_source, row.cost_micros],
    ['blocked', 'blocked', null, 'key_1', 'nara', 'https://evil.test/v1/models', "Key blocked: evil.test is not this key's provider", 'none', null],
  );
  assert.ok(body, 'a blocked request counts as failed, so its body is kept');
});

test('cost: a free model costs 0; an unknown price or no usage is NULL', () => {
  const free = buildRecord(done({ args: { body: JSON.stringify({ model: 'free-m' }) } }), opts).row;
  assert.deepStrictEqual([free.cost_micros, free.price_json], [0, '{"input":0,"output":0}']);
  const unknown = buildRecord(done({ args: { body: JSON.stringify({ model: 'mystery' }) } }), opts).row;
  assert.deepStrictEqual([unknown.cost_micros, unknown.price_json, unknown.input_tokens], [null, null, 5]);
  const noUsage = buildRecord(done({ responseText: JSON.stringify({ model: 'm1', choices: [] }) }), opts).row;
  assert.deepStrictEqual([noUsage.cost_micros, noUsage.usage_source, noUsage.input_tokens], [null, 'none', null]);
});

test('TTFT is kept for streams only', () => {
  const sse = 'data: {"model":"m1","choices":[{"delta":{"content":"4"}}]}\n\ndata: [DONE]\n\n';
  const streamed = buildRecord(done({
    args: { body: JSON.stringify({ model: 'm1', stream: true }) }, contentType: 'text/event-stream', responseText: sse,
  }), opts).row;
  assert.deepStrictEqual([streamed.is_stream, streamed.ttft_ms, streamed.usage_source, streamed.model_returned], [1, 790, 'none', 'm1']);
  const plain = buildRecord(done(), opts).row;
  assert.deepStrictEqual([plain.is_stream, plain.ttft_ms], [0, null]);
});

test('bodies: Off, Failed only and All, and what counts as failed', () => {
  const kept = (logLevel, over) => buildRecord(done(over), { ...opts, logLevel }).body !== null;
  const fail500 = { httpStatus: 500, responseText: '{"error":{"message":"down"}}' };
  const hedgeLost = { outcome: 'cancelled', cancelReason: 'hedge_lost', httpStatus: null, responseText: '' };
  const deadline = { outcome: 'cancelled', cancelReason: 'deadline', httpStatus: null, responseText: '' };
  const timeout = { outcome: 'timeout', httpStatus: null, responseText: '', error: 'No response for 60s' };
  const network = { outcome: 'error', httpStatus: null, responseText: '', error: 'socket hang up' };
  assert.deepStrictEqual(
    [kept('errors', {}), kept('errors', fail500), kept('errors', hedgeLost), kept('errors', deadline), kept('errors', timeout), kept('errors', network)],
    [false, true, false, true, true, true],
  );
  assert.deepStrictEqual([kept('all', {}), kept('all', hedgeLost)], [true, true]);
  assert.deepStrictEqual([kept('off', fail500), kept('off', network)], [false, false]);
  assert.strictEqual(kept('something-else', fail500), true);
});

test('a captured body: the unresolved request, redacted headers, a scrubbed reply clipped at 8 KB', () => {
  const { row, body } = buildRecord(done({
    httpStatus: 400,
    responseText: JSON.stringify({ error: { message: 'bad key sk-nara-1' }, pad: 'x'.repeat(9000) }),
    args: { headers: { Authorization: 'Bearer venomkey:key_1', 'X-Api-Key': 'venomkey:key_1', Cookie: 'mirai_usage_session=abc', 'Content-Type': 'application/json' } },
  }), opts);
  assert.deepStrictEqual(JSON.parse(body.request_headers_json), {
    Authorization: '[redacted]', 'X-Api-Key': '[redacted]', Cookie: '[redacted]', 'Content-Type': 'application/json',
  });
  assert.strictEqual(body.request_body, JSON.stringify({ model: 'm1', messages: [] }));
  assert.strictEqual(body.response_body.length, 8192);
  assert.ok(body.response_body.includes('bad key venomkey:key_1'));
  assert.ok(!body.response_body.includes('sk-nara-1'));
  assert.strictEqual(body.truncated, 1);
  assert.strictEqual(row.error_message, 'bad key venomkey:key_1');
});

test('no form of a substituted secret reaches a queued record', () => {
  const A = 'sk-"live\\key/0001';
  const B = `${A}-extended`;
  const formsOf = (s) => {
    const json = JSON.stringify(s).slice(1, -1);
    return [s, json, json.replace(/\//g, '\\/'), encodeURIComponent(s)];
  };
  const echo = `bad keys ${A} | ${JSON.stringify({ k: B })} | ${JSON.stringify(A).replace(/\//g, '\\/')} | ?key=${encodeURIComponent(B)}`;
  const added = [];
  const writer = { add: (row, body) => added.push({ row, body }), noteDropped: () => assert.fail('nothing may be dropped') };
  const recorder = createRecorder({ writer, prices: null, providers: { list: () => PROVIDERS }, getLogLevel: () => 'all' });
  const substitutions = [{ placeholder: 'venomkey:key_a', secret: A }, { placeholder: 'venomsecret:aaApiKey', secret: B }];
  recorder.record(done({ substitutions, httpStatus: 401, responseText: JSON.stringify({ error: { message: echo, code: A }, model: B }) }));
  recorder.record(done({ substitutions, outcome: 'error', httpStatus: null, responseText: '', error: `connect failed for ${A}` }));
  recorder.record(done({ substitutions, outcome: 'aborted', contentType: 'text/event-stream', responseText: `data: {"echo":"${encodeURIComponent(B)}"}\n\n` }));
  // A plain-text reply whose first 200 characters would cut the key in half.
  recorder.record(done({ substitutions, httpStatus: 401, contentType: 'text/plain', responseText: `${'x'.repeat(192)}${A} trailing` }));
  assert.strictEqual(added.length, 4);
  const stored = added.flatMap(({ row, body }) => [...Object.values(row), ...Object.values(body || {})]).filter((v) => typeof v === 'string');
  [A, B].forEach((secret) => formsOf(secret).forEach((form) => {
    stored.forEach((value) => assert.ok(!value.includes(form), `stored: ${value}`));
  }));
  stored.forEach((v) => assert.ok(!v.includes(A.slice(0, 8)), `partial: ${v}`));
  assert.ok(stored.some((v) => v.includes('venomkey:key_a')));
  assert.ok(!JSON.stringify(added).includes('substitutions'));
});

test('a record that cannot be built is counted as dropped, never thrown', () => {
  const dropped = [];
  const writer = { add: () => assert.fail('nothing should be queued'), noteDropped: (n, err) => dropped.push([n, err.message]) };
  const recorder = createRecorder({ writer, providers: { list: () => { throw new Error('venom.db is busy'); } } });
  assert.doesNotThrow(() => recorder.record(done()));
  assert.deepStrictEqual(dropped, [[1, 'venom.db is busy']]);
});
