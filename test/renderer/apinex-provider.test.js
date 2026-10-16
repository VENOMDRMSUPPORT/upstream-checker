const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Apinex discovery is tier-aware: a free key may call only the ids the public
// models endpoint flags allowFree (everything else answers 402 Insufficient
// balance), a subscription key gets the full roster. The roster itself is
// never hardcoded — it comes from the key's own /v1/models — so the test
// uses a roster the source has never seen, to pin that the filtering reads
// live data rather than a copied list.
//
// The bug this pins: a discovery that trusted /v1/models alone would offer a
// free key all 36 ids and learn "broken" by being told 402, and a
// subscription answer that fails to parse would silently upgrade the key to
// paid and expose balance-consuming ids to it.

const root = path.join(__dirname, '..', '..');

function loadApinex() {
  const source = fs.readFileSync(
    path.join(root, 'src', 'renderer', 'providers', 'apinex.js'), 'utf8');
  const window = {};
  new Function('window', source)(window);
  return window.INTEGRATED_PROVIDERS.apinex;
}

const APINEX = loadApinex();

// Ids deliberately absent from APINEX.md's rosters: if the module ever
// hardcodes the documented list, these disappear and the test fails.
const MODELS = ['doc-alpha', 'doc-beta-paid', 'doc-gamma', 'doc-delta-paid'];
const FREE_OK = ['doc-alpha', 'doc-gamma'];

const rosterReply = () => ({
  status: 200, headers: {},
  body: JSON.stringify({ object: 'list', data: MODELS.map((id) => ({ id, object: 'model', owned_by: 'apinex' })) }),
});
const subReply = (mode) => ({
  status: 200, headers: {},
  body: JSON.stringify({ object: 'subscription', mode }),
});
// The public endpoint's allowFree flags are live data: FREE_OK here, not a
// copy of the documented 25.
const publicReply = (ids) => ({
  status: 200, headers: {},
  body: JSON.stringify({ models: ids.map((id) => ({ id, allowFree: ids.includes(id) })) }),
});

async function runFetchModels({ sub = 'free', publicIds = FREE_OK, replies = {} } = {}) {
  const calls = [];
  const apiRequest = async (req) => {
    calls.push(req.url);
    if (req.url.endsWith('/v1/models')) return replies.roster || rosterReply();
    if (req.url.endsWith('/v1/subscription')) return replies.sub || subReply(sub);
    if (req.url.includes('/api/public/models')) return replies.public || publicReply(publicIds);
    throw new Error(`fixture: no route for ${req.url}`);
  };
  const models = await APINEX.fetchModels({
    apiKey: 'sk-test', baseUrl: 'https://api.apinex.bond/v1',
    pricingUrl: 'https://apinex.bond/api/public/models',
    apiRequest, formatContext: (n) => (n ? `${Math.round(n / 1000)}K` : ''),
    getFreeGroupName: (code) => (code === 'free' ? 'FREE' : code),
  });
  return { models, calls };
}

test('a free key sees only allowFree ids, tagged FREE', async () => {
  const { models } = await runFetchModels({ sub: 'free' });
  assert.deepStrictEqual(models.map((m) => m.id), ['doc-alpha', 'doc-gamma']);
  assert.ok(models.every((m) => m.isFree && m.groupName === 'FREE' && !m.isFreeForPaid));
});

test('a subscription key sees the full roster, none tagged FREE', async () => {
  const { models } = await runFetchModels({ sub: 'subscription' });
  assert.deepStrictEqual(models.map((m) => m.id).sort(), [...MODELS].sort());
  assert.ok(models.every((m) => !m.isFree && !m.isFreeForPaid && m.groupName === 'MODELS'));
});

test('an unreadable subscription answer is treated as free, not as paid', async () => {
  const { models } = await runFetchModels({
    replies: { sub: { status: 200, headers: {}, body: '<html>gateway error</html>' } },
  });
  assert.deepStrictEqual(models.map((m) => m.id), ['doc-alpha', 'doc-gamma']);
});

test('a failed public endpoint is fatal for a free key, harmless for a subscription key', async () => {
  await assert.rejects(
    () => runFetchModels({ sub: 'free', replies: { public: { status: 503, headers: {}, body: 'down' } } }),
    /public models endpoint unreachable/,
  );
  const { models } = await runFetchModels({ sub: 'subscription', replies: { public: { status: 503, headers: {}, body: 'down' } } });
  assert.strictEqual(models.length, MODELS.length);
});

test('a 401 roster is an error naming the status, not an empty list', async () => {
  await assert.rejects(
    () => runFetchModels({ replies: { roster: { status: 401, headers: {}, body: '{"error":{"message":"Invalid API key"}}' } } }),
    /HTTP 401/,
  );
});

const SUB = (d) => ({ status: 200, headers: {}, body: JSON.stringify({ object: 'subscription', ...d }) });

async function runFetchKeyUsage(reply) {
  const calls = [];
  const apiRequest = async (req) => { calls.push(req.url); return reply; };
  const usage = await APINEX.fetchKeyUsage({ apiKey: 'sk-test', baseUrl: 'https://api.apinex.bond/v1', apiRequest });
  return { usage, calls };
}

test('a free key reads its daily quota and the 00:00 UTC reset as expiry', async () => {
  const { usage, calls } = await runFetchKeyUsage(SUB({
    mode: 'free', plan: null, plan_label: 'FREE', token_limit: 10000000,
    tokens_used: 7268, tokens_remaining: 9992732,
    expires_at_utc: null, resets_at_utc: '2026-10-12T00:00:00.000Z', allowed: true,
  }));
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].endsWith('/v1/subscription'));
  assert.deepStrictEqual(usage.quota, { total: 10000000, remaining: 9992732, unit: 'tokens' });
  assert.strictEqual(usage.expiresAt, Date.parse('2026-10-12T00:00:00.000Z'));
  assert.strictEqual(usage.plan, 'FREE');
});

test('a subscription key reads its plan quota and the plan expiry', async () => {
  const { usage } = await runFetchKeyUsage(SUB({
    mode: 'subscription', plan: '10_days', plan_label: '20 days', token_limit: 1100000000,
    tokens_used: 52665, tokens_remaining: 1099947335,
    expires_at_utc: '2026-10-30T22:42:24.926Z', resets_at_utc: null, allowed: true,
  }));
  assert.deepStrictEqual(usage.quota, { total: 1100000000, remaining: 1099947335, unit: 'tokens' });
  assert.strictEqual(usage.expiresAt, Date.parse('2026-10-30T22:42:24.926Z'));
  assert.strictEqual(usage.plan, '20 days');
});

test('an unlimited plan reads as no quota, not as a zeroed bar', async () => {
  const { usage } = await runFetchKeyUsage(SUB({
    mode: 'subscription', plan: 'unlimited', plan_label: 'Unlimited', token_limit: null,
    tokens_used: 0, tokens_remaining: null, expires_at_utc: '2026-10-30T22:42:24.926Z', resets_at_utc: null,
  }));
  assert.strictEqual(usage.quota, null);
  assert.strictEqual(usage.expiresAt, Date.parse('2026-10-30T22:42:24.926Z'));
});

test('a refused subscription read is an error carrying the status', async () => {
  await assert.rejects(
    () => runFetchKeyUsage({ status: 401, headers: {}, body: '{"error":{"message":"Invalid API key"}}' }),
    /HTTP 401/,
  );
});
