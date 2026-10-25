// The Antigravity wire: the service does not speak OpenAI, and this is where
// that is dealt with.
//
// What the tests must pin:
//   1. the request is the service's own shape: the envelope, the project, the
//      conversation as contents, the instruction apart
//   2. the answer is read out of its wrapper, and the tokens are counted
//   3. a stream is read line by line, and the thinking is kept apart
//   4. the roster and the quota come from one route, and an allowance is a
//      fraction of a day
//   5. the stream translator turns the service's stream into the one a
//      client that speaks OpenAI can read
const test = require('node:test');
const assert = require('node:assert');
const wire = require('../../src/wire');
const antigravity = require('../../src/wire/antigravity');

const BASE = 'https://daily-cloudcode-pa.googleapis.com';

test('only Antigravity has a wire; the rest speak OpenAI', () => {
  assert.strictEqual(wire.supports('antigravity'), true);
  assert.strictEqual(wire.supports('muse'), false);
  assert.strictEqual(wire.getWire('muse'), null);
});

test('the request is the service\'s own shape', () => {
  const spec = wire.build('antigravity', 'chat', {
    baseUrl: BASE,
    model: 'claude-sonnet-4-6',
    apiKey: 'venomkey:abc',
    payload: {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hello' }],
      max_tokens: 64,
    },
  });
  assert.strictEqual(spec.url, `${BASE}/v1internal:generateContent`);
  assert.strictEqual(spec.method, 'POST');
  assert.strictEqual(spec.headers.Authorization, 'Bearer venomkey:abc');
  // The client the service expects to be talking to.
  assert.match(spec.headers['User-Agent'], /^antigravity\//);
  assert.ok(spec.headers['X-Goog-Api-Client']);
  assert.ok(spec.headers['Client-Metadata']);

  assert.strictEqual(spec.body.project, 'aicode-consumers');
  assert.strictEqual(spec.body.model, 'claude-sonnet-4-6');
  assert.strictEqual(spec.body.userAgent, 'antigravity');
  assert.match(spec.body.requestId, /^agent-[0-9a-f]{32}$/);
  // The conversation is contents, and the instruction is apart.
  assert.deepStrictEqual(spec.body.request.contents, [{ role: 'user', parts: [{ text: 'Hello' }] }]);
  assert.deepStrictEqual(spec.body.request.systemInstruction, { parts: [{ text: 'Be brief.' }] });
  assert.strictEqual(spec.body.request.generationConfig.maxOutputTokens, 64);
});

test('a tool answer and a tool call survive the round trip', () => {
  const spec = wire.build('antigravity', 'chat', {
    baseUrl: BASE,
    model: 'gemini-3-pro-high',
    payload: {
      messages: [
        { role: 'user', content: 'Weather?' },
        { role: 'assistant', content: '', tool_calls: [{ function: { name: 'weather', arguments: '{"city":"Cairo"}' } }] },
        { role: 'tool', name: 'weather', content: 'Sunny' },
      ],
    },
  });
  const contents = spec.body.request.contents;
  assert.strictEqual(contents[0].role, 'user');
  assert.strictEqual(contents[1].role, 'model');
  assert.deepStrictEqual(contents[1].parts[0], { functionCall: { name: 'weather', args: { city: 'Cairo' } } });
  assert.strictEqual(contents[2].role, 'function');
  assert.deepStrictEqual(contents[2].parts[0].functionResponse, { name: 'weather', response: { result: 'Sunny' } });
});

test('a streamed request asks for the stream', () => {
  const spec = wire.build('antigravity', 'chat', {
    baseUrl: BASE, model: 'gemini-3-pro-high', payload: { stream: true, messages: [] },
  });
  assert.strictEqual(spec.url, `${BASE}/v1internal:streamGenerateContent?alt=sse`);
});

test('the answer is read out of its wrapper', () => {
  const answer = wire.parse('antigravity', 'chat', JSON.stringify({
    response: {
      candidates: [{ content: { parts: [{ text: 'Hello there' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 },
    },
  }));
  assert.strictEqual(answer.content, 'Hello there');
  assert.strictEqual(answer.finishReason, 'STOP');
  assert.strictEqual(answer.usage.prompt_tokens, 12);
  assert.strictEqual(answer.usage.completion_tokens, 8);
  assert.strictEqual(answer.usage.total_tokens, 20);
});

test('the thinking that came with the answer is kept apart', () => {
  const answer = wire.parse('antigravity', 'chat', JSON.stringify({
    response: {
      candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: 'the answer' }] } }],
    },
  }));
  assert.strictEqual(answer.content, 'the answer');
  assert.strictEqual(answer.reasoning, 'thinking…');
});

test('a refusal comes back as a refusal', () => {
  const answer = wire.parse('antigravity', 'chat', JSON.stringify({
    error: { code: 429, message: 'Quota exceeded for model', status: 'RESOURCE_EXHAUSTED' },
  }));
  assert.match(answer.error, /Quota exceeded/);
});

test('a stream is read line by line', () => {
  const body = [
    'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}}',
    '',
    'data: {"response":{"candidates":[{"content":{"parts":[{"text":"lo"}]}}]}}',
    '',
  ].join('\n');
  const answer = wire.parse('antigravity', 'chat', body, { stream: true });
  assert.strictEqual(answer.content, 'Hello');
});

test('the roster and the quota come from one route', () => {
  const spec = wire.build('antigravity', 'models', { baseUrl: BASE, apiKey: 'venomkey:abc' });
  assert.strictEqual(spec.url, `${BASE}/v1internal:fetchAvailableModels`);
  assert.strictEqual(spec.method, 'POST');

  const body = JSON.stringify({
    serverTime: '2026-10-20T10:00:00Z',
    models: {
      'gemini-3-pro-high': {
        displayName: 'Gemini 3 Pro',
        supportsThinking: true,
        maxOutputTokens: 64000,
        quotaInfo: { remainingFraction: 0.25, resetTime: '2026-10-21T00:00:00Z' },
      },
      'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6' },
    },
  });
  const roster = wire.parse('antigravity', 'models', body);
  assert.strictEqual(roster.models.length, 2);
  const gemini = roster.models.find((m) => m.id === 'gemini-3-pro-high');
  assert.strictEqual(gemini.name, 'Gemini 3 Pro');
  assert.strictEqual(gemini.thinking, true);
  assert.strictEqual(gemini.quota.remaining, 0.25);
  assert.strictEqual(gemini.quota.resetAt, Date.parse('2026-10-21T00:00:00Z'));
  // A model with no allowance published has none, not a zero.
  const sonnet = roster.models.find((m) => m.id === 'claude-sonnet-4-6');
  assert.strictEqual(sonnet.quota, null);

  const quota = wire.parse('antigravity', 'quota', body);
  assert.strictEqual(quota.models.length, 1);
  assert.strictEqual(quota.models[0].remaining, 0.25);
});

test('a retired model is named, and the models the service keeps for itself are not listed', () => {
  const body = JSON.stringify({
    models: {
      'gemini-3.5-flash-low': { displayName: 'Gemini 3.5 Flash (Medium)' },
      'gemini-3.8-flash-low': { displayName: 'Gemini 3.8 Flash (Low)' },
      chat_20706: { displayName: 'Internal' },
      tab_flash_lite_preview: { displayName: 'Internal' },
    },
    deprecatedModelIds: {
      'gemini-3.5-flash-low': { newModelId: 'gemini-3.8-flash-low', reasonCode: 'MODEL_RETIRED' },
    },
  });
  const roster = wire.parse('antigravity', 'models', body);
  // The service's own models are not models a person picks.
  assert.deepStrictEqual(roster.models.map((m) => m.id), ['gemini-3.5-flash-low', 'gemini-3.8-flash-low']);
  // The retired one is named, with what replaces it.
  assert.deepStrictEqual(roster.deprecated['gemini-3.5-flash-low'], {
    replacement: 'gemini-3.8-flash-low',
    reason: 'MODEL_RETIRED',
  });
});

test('the grouped limits are the weekly and the five-hour one, per group', () => {
  const spec = wire.build('antigravity', 'quota-summary', { baseUrl: BASE, apiKey: 'venomkey:abc', project: 'projects/abc' });
  assert.strictEqual(spec.url, `${BASE}/v1internal:retrieveUserQuotaSummary`);
  assert.strictEqual(spec.body.project, 'projects/abc');

  const summary = wire.parse('antigravity', 'quota-summary', JSON.stringify({
    groups: [
      {
        displayName: 'Gemini Models',
        description: 'Models within this group: Gemini Flash, Gemini Pro',
        buckets: [
          { displayName: 'Weekly Limit', bucketId: 'weekly', window: '7d', remainingFraction: 0.07, resetTime: '2026-10-23T14:00:00Z' },
          { displayName: 'Five Hour Limit', bucketId: 'session', window: '5h', remainingFraction: 0, resetTime: '2026-10-20T22:00:00Z' },
        ],
      },
      {
        displayName: 'Claude and GPT models',
        buckets: [
          { displayName: 'Weekly Limit', bucketId: 'weekly', window: '7d', remainingFraction: 1 },
          { displayName: 'Five Hour Limit', bucketId: 'session', window: '5h', remainingFraction: 1 },
        ],
      },
    ],
  }));
  assert.strictEqual(summary.groups.length, 2);
  const gemini = summary.groups[0];
  assert.strictEqual(gemini.name, 'Gemini Models');
  assert.strictEqual(gemini.windows.length, 2);
  // The service reports what is left; the app shows what was used.
  assert.strictEqual(gemini.windows[0].usedPct, 93);
  assert.strictEqual(gemini.windows[0].remainingPct, 7);
  assert.strictEqual(gemini.windows[0].resetAt, Date.parse('2026-10-23T14:00:00Z'));
  assert.strictEqual(gemini.windows[1].usedPct, 100);
  assert.strictEqual(gemini.windows[1].window, '5h');
  assert.strictEqual(summary.groups[1].name, 'Claude and GPT models');
});

test('the plan is the subscription, not the API tier', () => {
  const pro = wire.parse('antigravity', 'project', JSON.stringify({
    cloudaicompanionProject: 'projects/abc-123',
    currentTier: { id: 'free-tier', name: 'Free' },
    paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
  }));
  assert.strictEqual(pro.project, 'projects/abc-123');
  assert.strictEqual(pro.tier, 'PRO');
  assert.strictEqual(pro.tierLabel, 'Pro');
  assert.strictEqual(pro.tierName, 'Google AI Pro');
  assert.strictEqual(pro.apiTier, 'free-tier');

  const ultra = wire.parse('antigravity', 'project', JSON.stringify({ paidTier: { name: 'Google AI Ultra' } }));
  assert.strictEqual(ultra.tier, 'ULTRA');
  assert.strictEqual(ultra.tierLabel, 'Ultra');

  // No subscription: the answer is the safe one.
  const free = wire.parse('antigravity', 'project', JSON.stringify({ currentTier: { id: 'free-tier' } }));
  assert.strictEqual(free.tier, 'FREE');
  assert.strictEqual(free.tierLabel, 'Free');
});

test('the project the account is on is read out of the answer', () => {
  const found = wire.parse('antigravity', 'project', JSON.stringify({
    cloudaicompanionProject: 'projects/abc-123',
  }));
  assert.strictEqual(found.project, 'projects/abc-123');
  const none = wire.parse('antigravity', 'project', JSON.stringify({}));
  assert.strictEqual(none.project, null);
});

test('the stream translator turns the service\'s stream into an OpenAI one', () => {
  const translator = wire.stream('antigravity', { model: 'gemini-3-pro-high' });
  const first = translator.push('data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}}\n');
  assert.strictEqual(first.length, 1);
  const chunk = JSON.parse(first[0].replace(/^data: /, '').trim());
  assert.strictEqual(chunk.object, 'chat.completion.chunk');
  assert.strictEqual(chunk.choices[0].delta.content, 'Hel');
  assert.strictEqual(chunk.model, 'gemini-3-pro-high');

  const second = translator.push('data: {"response":{"candidates":[{"content":{"parts":[{"text":"lo"}]}}]}}\n');
  assert.strictEqual(JSON.parse(second[0].replace(/^data: /, '').trim()).choices[0].delta.content, 'lo');

  const end = translator.flush();
  assert.ok(end.some((piece) => piece.includes('"finish_reason":"stop"')));
  assert.ok(end.some((piece) => piece.includes('[DONE]')));
});

test('the translator keeps a half-finished line for the next piece', () => {
  const translator = wire.stream('antigravity', {});
  const out = translator.push('data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hel');
  assert.strictEqual(out.length, 0);
  const rest = translator.push('lo"}]}}]}}\n');
  assert.strictEqual(rest.length, 1);
  assert.strictEqual(JSON.parse(rest[0].replace(/^data: /, '').trim()).choices[0].delta.content, 'Hello');
});

test('the wire is a module of its own, with no browser in it', () => {
  assert.strictEqual(typeof antigravity.buildChat, 'function');
  assert.strictEqual(typeof antigravity.parseChat, 'function');
  assert.strictEqual(antigravity.id, 'antigravity');
});
