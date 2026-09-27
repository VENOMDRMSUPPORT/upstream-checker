const test = require('node:test');
const assert = require('node:assert');
const C = require('../../src/logs/classify');

const usage = (input, output, cached = null, cacheWrite = null, reasoning = null) => ({ input, output, cached, cacheWrite, reasoning });

test('endpointOf keeps origin and path, drops the query', () => {
  assert.strictEqual(C.endpointOf('https://api.miraiapi.com/v1/usage?key=venomkey:key_m'), 'https://api.miraiapi.com/v1/usage');
  assert.strictEqual(C.endpointOf('http://127.0.0.1:47831/darkapi/v1/models#x'), 'http://127.0.0.1:47831/darkapi/v1/models');
  assert.strictEqual(C.endpointOf('not a url?key=secret'), 'not a url');
  assert.strictEqual(C.endpointOf(undefined), '');
});

test('endpointOf caps a very long http(s) origin+path at 500 characters too', () => {
  const long = `https://api.example.com/${'v'.repeat(600)}`;
  assert.strictEqual(C.endpointOf(long).length, 500);
});

test('bodyText and modelRequested read the model from a JSON body', () => {
  assert.strictEqual(C.bodyText({ model: 'm1' }), '{"model":"m1"}');
  assert.strictEqual(C.bodyText(''), null);
  assert.strictEqual(C.modelRequested('{"model":"gpt-x","messages":[]}'), 'gpt-x');
  assert.strictEqual(C.modelRequested('token=abc'), null);
  assert.strictEqual(C.modelRequested(null), null);
  assert.strictEqual(C.modelRequested(JSON.stringify({ model: 'm'.repeat(300) })).length, 200);
});

test('isStreamRequest: stream true in the body, or an event-stream reply', () => {
  assert.strictEqual(C.isStreamRequest('{"stream":true}', 'application/json'), true);
  assert.strictEqual(C.isStreamRequest('{"stream":false}', 'text/event-stream; charset=utf-8'), true);
  assert.strictEqual(C.isStreamRequest('{"stream":false}', 'application/json'), false);
  assert.strictEqual(C.isStreamRequest(null, null), false);
});

test('OpenAI JSON: usage with cached and reasoning tokens, and the returned model', () => {
  const body = JSON.stringify({
    model: 'gpt-x-2026', choices: [{ message: { content: 'hi' } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 64 }, completion_tokens_details: { reasoning_tokens: 12 } },
  });
  assert.deepStrictEqual(C.readResponse(body, 'application/json'), { usage: usage(100, 20, 64, null, 12), model: 'gpt-x-2026' });
});

test('a returned model is capped at 4096 chars, wider than the requested-model cap', () => {
  const body = JSON.stringify({ model: 'm'.repeat(5000), usage: { prompt_tokens: 1, completion_tokens: 1 } });
  assert.strictEqual(C.readResponse(body, 'application/json').model.length, 4096);
});

test('Anthropic JSON: input counts cache reads and writes', () => {
  const body = JSON.stringify({ model: 'claude-x', usage: { input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 2, output_tokens: 7 } });
  assert.deepStrictEqual(C.readResponse(body, 'application/json'), { usage: usage(16, 7, 4, 2, null), model: 'claude-x' });
});

test('OpenAI SSE: usage from the final chunk, model from the chunks', () => {
  const sse = [
    'data: {"id":"c","model":"gpt-s","choices":[{"delta":{"content":"4"}}]}',
    '',
    'data: {"id":"c","model":"gpt-s","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  assert.deepStrictEqual(C.readResponse(sse, 'text/event-stream'), { usage: usage(5, 1), model: 'gpt-s' });
});

test('Anthropic SSE: message_start and message_delta usage are merged', () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"m","model":"claude-s","usage":{"input_tokens":10,"cache_read_input_tokens":4,"cache_creation_input_tokens":2,"output_tokens":1}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":15}}',
    '',
  ].join('\n');
  assert.deepStrictEqual(C.readResponse(sse, 'text/event-stream'), { usage: usage(16, 15, 4, 2, null), model: 'claude-s' });
});

test('a stream that did not ask for usage has none', () => {
  const sse = 'data: {"model":"m1","choices":[{"delta":{"content":"4"}}]}\n\ndata: [DONE]\n\n';
  assert.deepStrictEqual(C.readResponse(sse, 'text/event-stream'), { usage: null, model: 'm1' });
});

test('a JSON body over 1 MB is read from its ends', () => {
  const body = JSON.stringify({
    id: 'x', model: 'big-model', choices: [{ message: { content: 'a'.repeat(1200000) } }],
    usage: { prompt_tokens: 7, completion_tokens: 3 },
  });
  assert.ok(body.length > C.JSON_PARSE_LIMIT);
  assert.deepStrictEqual(C.readResponse(body, 'application/json'), { usage: usage(7, 3), model: 'big-model' });
});

test('a 5 MB stream is read from its ends in under 250 ms', () => {
  const chunk = `data: ${JSON.stringify({ id: 'c', model: 'stream-model', choices: [{ delta: { content: 'word ' } }] })}\n\n`;
  const last = `data: ${JSON.stringify({ id: 'c', model: 'stream-model', choices: [], usage: { prompt_tokens: 11, completion_tokens: 900 } })}\n\ndata: [DONE]\n\n`;
  const body = chunk.repeat(Math.ceil(5e6 / chunk.length)) + last;
  const started = process.hrtime.bigint();
  const out = C.readResponse(body, 'text/event-stream');
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.deepStrictEqual(out, { usage: usage(11, 900), model: 'stream-model' });
  assert.ok(ms < 250, `took ${ms.toFixed(1)} ms`);
});

test('garbage and empty replies give nothing', () => {
  const none = { usage: null, model: null };
  assert.deepStrictEqual(C.readResponse('', 'application/json'), none);
  assert.deepStrictEqual(C.readResponse('<html>502 Bad Gateway</html>', 'text/html'), none);
  assert.deepStrictEqual(C.readResponse('[1,2,3]', 'application/json'), none);
  assert.deepStrictEqual(C.readResponse('{"usage":"lots"}', 'application/json'), none);
  assert.strictEqual(C.normalizeUsage({ total_tokens: 9 }), null);
});

test('computeCost: tokens × price per 1M in micro-USD; free is 0; unknown is NULL', () => {
  assert.deepStrictEqual(C.computeCost(usage(5, 1), { input: 2, output: 10 }), { costMicros: 20, priceJson: '{"input":2,"output":10}' });
  assert.deepStrictEqual(C.computeCost(usage(1000, 500), { input: 0.15, output: 0.6 }), { costMicros: 450, priceJson: '{"input":0.15,"output":0.6}' });
  assert.deepStrictEqual(C.computeCost(usage(5, 1), { input: 0, output: 0 }), { costMicros: 0, priceJson: '{"input":0,"output":0}' });
  assert.deepStrictEqual(C.computeCost(usage(5, 1), null), { costMicros: null, priceJson: null });
  assert.deepStrictEqual(C.computeCost(null, { input: 2, output: 10 }), { costMicros: null, priceJson: null });
  assert.deepStrictEqual(C.computeCost(usage(null, null), { input: 2, output: 10 }), { costMicros: null, priceJson: null });
  assert.deepStrictEqual(C.computeCost(usage(5, 1), { input: -1e6, output: -1e6 }), { costMicros: null, priceJson: null });
  assert.deepStrictEqual(C.computeCost(usage(5, 1), { input: 1 }), { costMicros: null, priceJson: null });
});

test('classifyStatus: the status and error-class table', () => {
  const cases = [
    [{ outcome: 'end', httpStatus: 200 }, 'ok', null],
    [{ outcome: 'end', httpStatus: 204 }, 'ok', null],
    [{ outcome: 'cancelled', cancelReason: 'hedge_lost' }, 'cancelled', null],
    [{ outcome: 'cancelled', cancelReason: 'stop' }, 'cancelled', null],
    [{ outcome: 'cancelled', cancelReason: 'deadline' }, 'timeout', 'timeout'],
    [{ outcome: 'blocked' }, 'blocked', 'blocked'],
    [{ outcome: 'timeout' }, 'timeout', 'timeout'],
    [{ outcome: 'error' }, 'error', 'network'],
    [{ outcome: 'aborted', httpStatus: 200 }, 'error', 'network'],
    [{ outcome: 'end', httpStatus: 401 }, 'error', 'auth'],
    [{ outcome: 'end', httpStatus: 403 }, 'error', 'auth'],
    [{ outcome: 'end', httpStatus: 402 }, 'error', 'quota'],
    [{ outcome: 'end', httpStatus: 429 }, 'error', 'rate_limit'],
    [{ outcome: 'end', httpStatus: 429, errorCode: 'insufficient_quota' }, 'error', 'quota'],
    [{ outcome: 'end', httpStatus: 400, errorCode: 'quota_exceeded' }, 'error', 'quota'],
    [{ outcome: 'end', httpStatus: 401, errorCode: 'billing_hard_limit_reached' }, 'error', 'quota'],
    [{ outcome: 'end', httpStatus: 404 }, 'error', 'bad_request'],
    [{ outcome: 'end', httpStatus: 500 }, 'error', 'server'],
    [{ outcome: 'end', httpStatus: 503 }, 'error', 'server'],
    [{ outcome: 'end', httpStatus: 302 }, 'error', 'other'],
    [{ outcome: 'something' }, 'error', 'other'],
  ];
  cases.forEach(([input, status, errorClass]) => {
    assert.deepStrictEqual(C.classifyStatus(input), { status, errorClass }, JSON.stringify(input));
  });
});

test('extractError: error.message, a string error, message, detail, or the first 200 characters; code is not clipped here', () => {
  assert.deepStrictEqual(C.extractError(JSON.stringify({ error: { message: 'Bad key', code: 'invalid_api_key' } })), { code: 'invalid_api_key', message: 'Bad key', quota: false });
  assert.deepStrictEqual(C.extractError(JSON.stringify({ error: { type: 'overloaded_error', message: 'Overloaded' } })), { code: 'overloaded_error', message: 'Overloaded', quota: false });
  assert.deepStrictEqual(C.extractError(JSON.stringify({ error: 'plain string' })), { code: null, message: 'plain string', quota: false });
  assert.deepStrictEqual(C.extractError(JSON.stringify({ message: 'top-level' })), { code: null, message: 'top-level', quota: false });
  assert.deepStrictEqual(C.extractError(JSON.stringify({ detail: 'Not Found' })), { code: null, message: 'Not Found', quota: false });
  assert.strictEqual(C.extractError(`<html>${'x'.repeat(500)}`).message.length, 200);
  // The recorder clips error_code to 100 on the way into the row (see
  // recorder.js); extractError itself hands the code back whole.
  const long = C.extractError(JSON.stringify({ error: { code: 'c'.repeat(250) } }));
  assert.strictEqual(long.code.length, 250);
  assert.strictEqual(long.message.length, 200);
  assert.deepStrictEqual(C.extractError(''), { code: null, message: null, quota: false });
});

test('extractError detects a quota code in error.type even when error.code is something else, and code falls through an empty string', () => {
  const statusCode = C.extractError(JSON.stringify({ error: { code: '429', type: 'insufficient_quota' } }));
  assert.strictEqual(statusCode.quota, true);
  assert.deepStrictEqual(
    C.classifyStatus({ outcome: 'end', httpStatus: 429, errorCode: statusCode.code, quota: statusCode.quota }),
    { status: 'error', errorClass: 'quota' },
  );

  const emptyCode = C.extractError(JSON.stringify({ error: { code: '', type: 'insufficient_quota' } }));
  assert.strictEqual(emptyCode.code, 'insufficient_quota');
  assert.strictEqual(emptyCode.quota, true);
  assert.deepStrictEqual(
    C.classifyStatus({ outcome: 'end', httpStatus: 429, errorCode: emptyCode.code, quota: emptyCode.quota }),
    { status: 'error', errorClass: 'quota' },
  );
});

test('latency buckets and the approximate p95', () => {
  assert.deepStrictEqual([0, 100, 101, 1000, 1001, 120000, 120001].map(C.latencyBucket), [0, 0, 1, 3, 4, 12, 13]);
  const b = new Array(14).fill(0);
  b[0] = 94;
  b[3] = 6;
  assert.deepStrictEqual(C.approxP95(b, 100), { ms: 1000, overflow: false });
  const top = new Array(14).fill(0);
  top[13] = 3;
  assert.deepStrictEqual(C.approxP95(top, 3), { ms: 120000, overflow: true });
  assert.strictEqual(C.approxP95(new Array(14).fill(0), 0), null);
});
