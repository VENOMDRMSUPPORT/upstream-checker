// Real request construction with controlled IPC transport (no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererModules } = require('./module-loader');

function makeAttempts(responses, extra = {}) {
  const calls = [];
  let state = { settings: { maxOutputTokens: 64, verifyAssets: false, imagePrompt: 'circle', videoPrompt: 'moving circle', videoPollMs: 1000 }, prompt: '2+2?', aborted: false };
  const key = { id: 'k', key: 'venomkey:k' };
  const R = loadRendererModules(['test-response', 'test-attempts']);
  const policy = { pickKey: () => key, waitForSlot: async () => {} };
  const attempts = R.attempts.create({
    responses: R.responses, policy, getSettings: () => state.settings,
    getPrompt: () => state.prompt, isAborted: () => state.aborted,
    defaultPrompt: 'default', isMedia: m => ['image', 'video'].includes(m.kind),
    isDecision: m => m.kind === 'decision', kindLimits: () => ({ deadline: 5000 }),
    request: async req => { calls.push(req); return responses[Math.min(calls.length - 1, responses.length - 1)]; },
    routeTestTags: () => ({ source: 'route_test', runId: 'original-run', attempt: 2 }),
    getRequestTags: () => ({ runId: 'original-run', trigger: 'manual' }),
    nextRequestId: () => 'retry', sleep: async () => {},
    tokenLimitField: () => 'max_tokens', swapTokenLimitField: () => false,
    omitReasoning: () => false, disableReasoning: () => {},
    reasoningRejected: () => false, observeUsage: () => {}, getAdapter: () => null,
    ...extra,
  });
  return { attempts, calls, state, key };
}
const provider = { id: 'p', name: 'Provider', baseUrl: 'https://example.test/v1' };
const chat = { status: 200, body: '{"choices":[{"message":{"content":"4"}}],"usage":{"prompt_tokens":2,"completion_tokens":1}}', elapsed: 5, headers: {} };

test('chat request uses live settings, placeholder key and originating run tags', async () => {
  const { attempts, calls, state } = makeAttempts([chat]);
  state.settings = { ...state.settings, maxOutputTokens: 128 };
  state.prompt = 'new prompt';
  const result = await attempts.attemptOnce({ id: 'm', kind: 'chat' }, provider, false, 'request');
  assert.equal(result.response, '4');
  assert.equal(result.tokens, 3);
  assert.equal(calls[0].headers.Authorization, 'Bearer venomkey:k');
  assert.equal(JSON.parse(calls[0].body).max_tokens, 128);
  assert.equal(JSON.parse(calls[0].body).messages[0].content, 'new prompt');
  assert.equal(calls[0].runId, 'original-run');
});

test('rejected token parameter retries with the negotiated field and a tagged id', async () => {
  let field = 'max_tokens';
  const { attempts, calls } = makeAttempts([{ status: 400, body: '{"error":{"message":"max_tokens unsupported"}}', elapsed: 1 }, chat], {
    tokenLimitField: () => field, swapTokenLimitField: () => { field = 'max_completion_tokens'; return true; },
  });
  const result = await attempts.attemptOnce({ id: 'm' }, provider, false, 'first');
  assert.equal(result.status, 'pass');
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[1].body).max_completion_tokens, 64);
  assert.equal(calls[1].requestId, 'retry');
});

test('missing image route is learned per provider without losing chat fallback', async () => {
  const { attempts, calls } = makeAttempts([{ status: 404, body: '{"error":"endpoint not found"}', elapsed: 1 }, chat, chat]);
  const model = { id: 'image-m', kind: 'image' };
  await attempts.attemptOnce(model, provider, false, 'one');
  await attempts.attemptOnce(model, provider, false, 'two');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://example.test/v1/images/generations');
  assert.equal(calls[1].url, 'https://example.test/v1/chat/completions');
  assert.equal(calls[2].url, 'https://example.test/v1/chat/completions');
});

test('asset verification sees replacement settings and never requests inline assets', async () => {
  const { attempts, calls, state } = makeAttempts([{ status: 200, headers: { 'content-type': 'image/png' } }]);
  assert.equal(await attempts.verifyAsset('https://example.test/a.png', 'image'), null);
  state.settings = { ...state.settings, verifyAssets: true };
  assert.equal(await attempts.verifyAsset('data:image/png;base64,abc', 'image'), true);
  assert.equal(calls.length, 0);
  assert.equal(await attempts.verifyAsset('https://example.test/a.png', 'image'), true);
  assert.equal(calls[0].method, 'HEAD');
});

test('Stop after pacing prevents any IPC request from being sent', async () => {
  const { attempts, calls, state } = makeAttempts([chat]);
  state.aborted = true;
  const result = await attempts.attemptOnce({ id: 'm' }, provider, false, 'one');
  assert.equal(result.cancelled, true);
  assert.equal(calls.length, 0);
});
