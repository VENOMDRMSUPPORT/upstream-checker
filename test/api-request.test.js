const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createApiRequester } = require('../src/api-request');
const { quietLog } = require('./helpers');

const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

function startServer(t, handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }));
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function setup({ resolver = null, onFinish = null } = {}) {
  const finished = [];
  const warnings = [];
  const requester = createApiRequester({
    getResolver: () => resolver,
    onFinish: onFinish || ((d) => finished.push(d)),
    log: { ...quietLog, warn: (...a) => warnings.push(a.join(' ')) },
  });
  return { requester, finished, warnings };
}

// Sends headers and one SSE chunk, then holds the response open.
function holdingStream(onWrote = () => {}) {
  return (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n', () => onWrote(res));
  };
}

test('a normal end resolves the reply and reports one record after it', async (t) => {
  const origin = await startServer(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: 'm1', choices: [{ message: { content: 'four' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
  });
  let replied = false;
  const seen = [];
  const { requester } = setup({ onFinish: (d) => seen.push({ ...d, replied }) });
  const r = await requester.request({
    url: `${origin}/v1/chat/completions`, method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: '{"model":"m1"}', requestId: 'r0', source: 'route_test',
  });
  replied = true;
  assert.strictEqual(r.status, 200);
  assert.strictEqual(JSON.parse(r.body).choices[0].message.content, 'four');
  assert.strictEqual(r.headers['content-type'], 'application/json');
  assert.strictEqual(typeof r.elapsed, 'number');
  assert.strictEqual(typeof r.firstTokenMs, 'number');
  await settle();
  assert.strictEqual(seen.length, 1);
  const d = seen[0];
  assert.deepStrictEqual([d.replied, d.outcome, d.httpStatus, d.contentType, d.args.source], [true, 'end', 200, 'application/json', 'route_test']);
  assert.ok(d.responseText.includes('four'));
});

test('a mid-stream cancel resolves as cancelled and reports once with the reason', async (t) => {
  let wrote;
  const wroteChunk = new Promise((resolve) => { wrote = resolve; });
  const origin = await startServer(t, holdingStream(() => wrote()));
  const { requester, finished } = setup();
  const reply = requester.request({ url: `${origin}/v1/chat/completions`, method: 'POST', body: '{"stream":true}', requestId: 'r1' });
  await wroteChunk;
  await settle(100);
  assert.strictEqual(requester.cancel('r1', 'hedge_lost'), true);
  assert.strictEqual(requester.cancel('r1', 'stop'), false);
  const r = await reply;
  assert.deepStrictEqual([r.status, r.cancelled, r.body], [0, true, '']);
  await settle();
  assert.strictEqual(finished.length, 1);
  const d = finished[0];
  assert.deepStrictEqual([d.outcome, d.cancelReason, d.httpStatus], ['cancelled', 'hedge_lost', 200]);
  assert.match(d.responseText, /"Hi"/);
  assert.strictEqual(typeof d.firstTokenMs, 'number');
});

test('a cancel before any response is cancelled too, and deadline is kept as the reason', async (t) => {
  const origin = await startServer(t, () => {});
  const { requester, finished } = setup();
  const reply = requester.request({ url: `${origin}/slow`, requestId: 'r2' });
  await settle();
  assert.strictEqual(requester.cancel('r2', 'deadline'), true);
  const r = await reply;
  assert.strictEqual(r.cancelled, true);
  await settle();
  assert.strictEqual(finished.length, 1);
  assert.deepStrictEqual([finished[0].outcome, finished[0].cancelReason, finished[0].httpStatus], ['cancelled', 'deadline', null]);
});

test('a socket timeout reports exactly one record', async (t) => {
  const origin = await startServer(t, () => {});
  const { requester, finished } = setup();
  const r = await requester.request({ url: `${origin}/slow`, timeoutMs: 100 });
  assert.deepStrictEqual([r.status, r.networkError, r.timedOut], [0, true, true]);
  assert.match(r.error, /No response/);
  await settle(200);
  assert.strictEqual(finished.length, 1);
  assert.strictEqual(finished[0].outcome, 'timeout');
});

test('a connection dropped mid-stream resolves as a network error and reports once', async (t) => {
  const origin = await startServer(t, holdingStream((res) => setTimeout(() => res.socket.destroy(), 50)));
  const { requester, finished } = setup();
  const r = await requester.request({ url: `${origin}/v1/chat/completions`, method: 'POST', body: '{"stream":true}' });
  assert.deepStrictEqual([r.status, r.networkError], [0, true]);
  assert.match(r.error, /closed before the response ended/);
  await settle();
  assert.strictEqual(finished.length, 1);
  assert.deepStrictEqual([finished[0].outcome, finished[0].httpStatus], ['aborted', 200]);
  assert.match(finished[0].responseText, /"Hi"/);
});

test('a blocked request never leaves and reports once', async (t) => {
  let hits = 0;
  const origin = await startServer(t, (req, res) => { hits += 1; res.end('x'); });
  const refused = { kind: 'key', id: 'key_1', providerId: 'nara' };
  const resolver = { resolve: () => ({ blocked: true, error: "Key blocked: 127.0.0.1 is not this key's provider", refs: [refused] }) };
  const { requester, finished, warnings } = setup({ resolver });
  const r = await requester.request({ url: `${origin}/v1/models`, headers: { Authorization: 'Bearer venomkey:key_1' } });
  assert.deepStrictEqual(r, { status: 0, body: '', elapsed: 0, headers: {}, blocked: true, error: "Key blocked: 127.0.0.1 is not this key's provider" });
  await settle();
  assert.strictEqual(hits, 0);
  assert.strictEqual(finished.length, 1);
  assert.deepStrictEqual([finished[0].outcome, finished[0].refs], ['blocked', [refused]]);
  assert.strictEqual(warnings.length, 1);
});

test("the resolved request goes out; the record keeps the renderer's placeholders; the reply carries no substitutions", async (t) => {
  let seenAuth = null;
  const origin = await startServer(t, (req, res) => {
    seenAuth = req.headers.authorization;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"bad key"}}');
  });
  const resolver = {
    resolve: ({ url, headers, body }) => ({
      url, headers: { ...headers, Authorization: 'Bearer sk-real-0001' }, body,
      refs: [{ kind: 'key', id: 'key_1', providerId: 'nara' }],
      substitutions: [{ placeholder: 'venomkey:key_1', secret: 'sk-real-0001' }],
    }),
  };
  const { requester, finished } = setup({ resolver });
  const r = await requester.request({ url: `${origin}/v1/models`, headers: { Authorization: 'Bearer venomkey:key_1' } });
  assert.strictEqual(seenAuth, 'Bearer sk-real-0001');
  assert.deepStrictEqual(Object.keys(r).sort(), ['body', 'elapsed', 'firstByteMs', 'firstTokenMs', 'headers', 'status']);
  assert.ok(!JSON.stringify(r).includes('sk-real-0001'));
  await settle();
  assert.strictEqual(finished[0].args.headers.Authorization, 'Bearer venomkey:key_1');
  assert.deepStrictEqual(finished[0].substitutions, [{ placeholder: 'venomkey:key_1', secret: 'sk-real-0001' }]);
});

test('a cancel after the end, a second cancel and an unknown id change nothing', async (t) => {
  const origin = await startServer(t, (req, res) => res.end('ok'));
  const { requester, finished } = setup();
  const r = await requester.request({ url: `${origin}/x`, requestId: 'r3' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(requester.cancel('r3', 'stop'), false);
  assert.strictEqual(requester.cancel('r3', 'stop'), false);
  assert.strictEqual(requester.cancel('never-sent', 'stop'), false);
  await settle();
  assert.strictEqual(finished.length, 1);
  assert.deepStrictEqual([finished[0].outcome, finished[0].cancelReason], ['end', null]);
});

test('a recorder that throws never touches the reply, and runs only after it', async (t) => {
  const origin = await startServer(t, (req, res) => res.end('fine'));
  let replied = false;
  let sawReply = null;
  let calls = 0;
  const { requester, warnings } = setup({
    onFinish: () => {
      calls += 1;
      if (sawReply === null) sawReply = replied;
      throw new Error('recorder bug');
    },
  });
  const first = await requester.request({ url: `${origin}/a` });
  replied = true;
  assert.strictEqual(first.body, 'fine');
  await settle();
  assert.strictEqual(sawReply, true);
  const second = await requester.request({ url: `${origin}/b` });
  assert.strictEqual(second.body, 'fine');
  await settle();
  assert.strictEqual(calls, 2);
  assert.strictEqual(warnings.length, 2);
  assert.match(warnings[0], /recorder bug/);
});

test('an unparsable URL resolves as a network error instead of rejecting', async () => {
  const { requester, finished } = setup();
  const r = await requester.request({ url: 'not a url' });
  assert.deepStrictEqual([r.status, r.networkError], [0, true]);
  assert.match(r.error, /Invalid URL/);
  await settle();
  assert.deepStrictEqual([finished.length, finished[0].outcome], [1, 'error']);
  assert.strictEqual(requester.inFlight(), 0);
});

test('inFlight counts requests until they finish', async (t) => {
  const origin = await startServer(t, () => {});
  const { requester } = setup();
  const reply = requester.request({ url: `${origin}/slow`, requestId: 'r4' });
  await settle();
  assert.strictEqual(requester.inFlight(), 1);
  requester.cancel('r4', 'stop');
  await reply;
  assert.strictEqual(requester.inFlight(), 0);
});

test('an unknown cancel reason is recorded as stop', async (t) => {
  const origin = await startServer(t, () => {});
  const { requester, finished } = setup();
  const reply = requester.request({ url: `${origin}/slow`, requestId: 'r5' });
  await settle();
  requester.cancel('r5', 'whatever');
  await reply;
  await settle();
  assert.strictEqual(finished[0].cancelReason, 'stop');
});
