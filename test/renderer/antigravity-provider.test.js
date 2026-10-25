const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Antigravity is Google's Antigravity IDE entitlement: the sign-in is a
// Google account, the API behind it is the Cloud Code Assist service, and the
// service does not speak OpenAI. The app's wire (src/wire/antigravity.js)
// speaks it instead.
//
// What the tests must pin:
//   1. registration + structuredClone-safe meta
//   2. the logo file actually exists on disk
//   3. the account is the key: there is no key to paste, and the sign-in is
//      the app's own browser flow
//   4. the roster comes from the service's own route, through the wire
//   5. the allowance is a fraction of a day, per model
//   6. a spent allowance is recognised, and it names the model
const root = path.join(__dirname, '..', '..');

function loadAntigravity() {
  const source = fs.readFileSync(
    path.join(root, 'src', 'renderer', 'providers', 'antigravity.js'), 'utf8');
  const window = {};
  new Function('window', source)(window);
  return window.INTEGRATED_PROVIDERS.antigravity;
}

const ANTIGRAVITY = loadAntigravity();

const ROSTER = {
  serverTime: '2026-10-20T10:00:00Z',
  models: {
    'gemini-3-pro-high': {
      displayName: 'Gemini 3 Pro',
      supportsThinking: true,
      maxOutputTokens: 64000,
      quotaInfo: { remainingFraction: 0.25, resetTime: '2026-10-21T00:00:00Z' },
    },
    'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6' },
    'gemini-3.5-flash-low': { displayName: 'Gemini 3.5 Flash (Medium)' },
  },
  // The service says this one is on its way out.
  deprecatedModelIds: {
    'gemini-3.5-flash-low': { newModelId: 'gemini-3-pro-high', reasonCode: 'MODEL_RETIRED' },
  },
};

const LIMITS = {
  groups: [
    {
      displayName: 'Gemini Models',
      buckets: [
        { displayName: 'Weekly Limit', window: '7d', remainingFraction: 0.07, resetTime: '2026-10-23T14:00:00Z' },
        { displayName: 'Five Hour Limit', window: '5h', remainingFraction: 0, resetTime: '2026-10-20T22:00:00Z' },
      ],
    },
    {
      displayName: 'Claude and GPT models',
      buckets: [
        { displayName: 'Weekly Limit', window: '7d', remainingFraction: 1 },
        { displayName: 'Five Hour Limit', window: '5h', remainingFraction: 1 },
      ],
    },
  ],
};

// A wire that answers with what the service would answer, and records what
// it was asked for. The answers are read by the app's real wire, so the test
// exercises the translation and not a copy of it.
const realWire = require('../../src/wire');

function fakeWire() {
  const asked = [];
  return {
    asked,
    async build(providerId, op, args) {
      asked.push({ providerId, op, args });
      const route = op === 'models' || op === 'quota' ? 'fetchAvailableModels'
        : op === 'quota-summary' ? 'retrieveUserQuotaSummary'
          : op === 'project' ? 'loadCodeAssist' : 'generateContent';
      return {
        url: `${args.baseUrl}/v1internal:${route}`,
        method: 'POST',
        headers: { Authorization: `Bearer ${args.apiKey}` },
        body: { hello: 'world' },
      };
    },
    async parse(providerId, op, body) {
      return realWire.parse(providerId, op, body);
    },
  };
}

test('registers into window.INTEGRATED_PROVIDERS with the Antigravity identity', () => {
  assert.ok(ANTIGRAVITY, 'antigravity module did not register');
  assert.strictEqual(ANTIGRAVITY.meta.id, 'antigravity');
  assert.strictEqual(ANTIGRAVITY.meta.name, 'Antigravity');
  assert.strictEqual(ANTIGRAVITY.meta.baseUrl, 'https://daily-cloudcode-pa.googleapis.com');
  assert.strictEqual(ANTIGRAVITY.meta.modelsEndpoint, '/v1internal:fetchAvailableModels');
  assert.strictEqual(ANTIGRAVITY.meta.chatEndpoint, '/v1internal:generateContent');
});

test('the account is the key: there is no key to paste', () => {
  assert.deepStrictEqual(ANTIGRAVITY.meta.auth, ['oauth']);
  // The sign-in is the app's own browser flow, with the app's own client.
  assert.deepStrictEqual(ANTIGRAVITY.meta.oauth, { kind: 'loopback', profile: 'antigravity' });
});

test('meta is plain data — structuredClone-safe for the provider store', () => {
  const clone = structuredClone(ANTIGRAVITY.meta);
  assert.deepStrictEqual(clone, ANTIGRAVITY.meta);
});

test('logo file exists at the path the meta declares', () => {
  const rel = ANTIGRAVITY.meta.logo.replace(/^\.\.\//, '');
  const file = path.join(root, 'src', rel.replace(/\//g, path.sep));
  assert.ok(fs.existsSync(file), `missing logo file: ${file}`);
});

test('the roster comes from the service\'s own route, through the wire', async () => {
  const wire = fakeWire();
  let asked = null;
  const models = await ANTIGRAVITY.fetchModels({
    apiKey: 'venomkey:abc',
    baseUrl: 'https://daily-cloudcode-pa.googleapis.com',
    apiRequest: async (opts) => { asked = opts; return { status: 200, body: JSON.stringify(ROSTER) }; },
    wire,
    formatContext: (n) => (n ? `${n / 1000}K` : ''),
    getFreeGroupName: (name) => name.toUpperCase(),
  });
  assert.strictEqual(wire.asked[0].op, 'models');
  assert.strictEqual(wire.asked[0].providerId, 'antigravity');
  assert.ok(asked.url.endsWith('/v1internal:fetchAvailableModels') || asked.url.endsWith('/v1internal:retrieveUserQuotaSummary'),
    asked.url);
  assert.strictEqual(asked.headers.Authorization, 'Bearer venomkey:abc');
  // The roster came from the service's own route.
  const rosterCall = wire.asked.find((a) => a.op === 'models');
  assert.ok(rosterCall);

  assert.strictEqual(models.length, 2);
  const gemini = models.find((m) => m.id === 'gemini-3-pro-high');
  assert.strictEqual(gemini.name, 'Gemini 3 Pro');
  assert.strictEqual(gemini.hasReasoning, true);
  assert.strictEqual(gemini.isFree, true);
  assert.strictEqual(gemini.groupName, 'FREE');
  assert.strictEqual(gemini.maxOutputTokens, 64000);
  // The retired model is not offered, and the one that replaced it is.
  assert.ok(!models.find((m) => m.id === 'gemini-3.5-flash-low'));
});

test('a model of a family the account has no allowance for is not offered', async () => {
  const wire = fakeWire();
  // The account has no Claude group: it cannot call Claude.
  const realParse = wire.parse;
  wire.parse = async (providerId, op, body) => {
    if (op === 'quota-summary') {
      return realWire.parse(providerId, op, JSON.stringify({
        groups: [{ displayName: 'Gemini Models', buckets: [{ displayName: 'Weekly Limit', remainingFraction: 1 }] }],
      }));
    }
    return realParse(providerId, op, body);
  };
  const models = await ANTIGRAVITY.fetchModels({
    apiKey: 'venomkey:abc',
    baseUrl: 'https://daily-cloudcode-pa.googleapis.com',
    apiRequest: async () => ({ status: 200, body: JSON.stringify(ROSTER) }),
    wire,
    formatContext: () => '',
    getFreeGroupName: (n) => n,
  });
  assert.deepStrictEqual(models.map((m) => m.id), ['gemini-3-pro-high']);
});

test('a service that does not answer says so', async () => {
  await assert.rejects(
    () => ANTIGRAVITY.fetchModels({
      apiKey: 'venomkey:abc',
      baseUrl: 'https://daily-cloudcode-pa.googleapis.com',
      apiRequest: async () => ({ status: 503, body: '' }),
      wire: fakeWire(),
      formatContext: () => '',
      getFreeGroupName: (n) => n,
    }),
    /HTTP 503/,
  );
});

test('the allowance is the grouped limits: a weekly and a five-hour one per group', async () => {
  const usage = await ANTIGRAVITY.fetchKeyUsage({
    apiKey: 'venomkey:abc',
    baseUrl: 'https://daily-cloudcode-pa.googleapis.com',
    apiRequest: async () => ({ status: 200, body: JSON.stringify(LIMITS) }),
    wire: fakeWire(),
    account: { tier: 'Pro' },
  });
  assert.strictEqual(usage.plan, 'Pro');
  // A fraction is not an amount: there is no quota bar, only the allowances.
  assert.strictEqual(usage.quota, null);
  assert.strictEqual(usage.allowances.length, 4);
  const weekly = usage.allowances.find((a) => a.label.includes('Gemini Models') && a.label.includes('Weekly'));
  assert.strictEqual(weekly.usedPct, 93);
  assert.strictEqual(weekly.group, 'Gemini Models');
  assert.strictEqual(weekly.window, '7d');
  assert.strictEqual(weekly.resetsAt, Date.parse('2026-10-23T14:00:00Z'));
  // The bar on the row is the tightest limit of them all: the five-hour one
  // is spent, so it is the one that says the most.
  assert.strictEqual(usage.allowance.label, 'Gemini Models · Five Hour Limit');
  assert.strictEqual(usage.allowance.usedPct, 100);
});

test('a spent allowance is recognised, a rate limit is not', () => {
  const spent = ANTIGRAVITY.readQuotaError({ code: null, status: 429, message: 'Quota exceeded for gemini-3-pro-high' });
  assert.ok(spent);
  assert.match(spent.message, /allowance for this model is spent/);
  assert.strictEqual(ANTIGRAVITY.readQuotaError({ code: 'rate_limit_exceeded', message: 'too many requests', status: 429 }), null);
  assert.strictEqual(ANTIGRAVITY.readQuotaError({ code: 'invalid_api_key', message: 'bad key', status: 401 }), null);
});

test('the chat request and its answer go through the wire', async () => {
  const wire = fakeWire();
  const spec = await ANTIGRAVITY.buildChatRequest({
    baseUrl: 'https://daily-cloudcode-pa.googleapis.com',
    model: 'gemini-3-pro-high',
    payload: { messages: [{ role: 'user', content: 'Hello' }] },
    project: 'aicode-consumers',
    apiKey: 'venomkey:abc',
    wire,
  });
  assert.strictEqual(wire.asked[0].op, 'chat');
  assert.strictEqual(wire.asked[0].args.project, 'aicode-consumers');
  assert.ok(spec.url);
});
