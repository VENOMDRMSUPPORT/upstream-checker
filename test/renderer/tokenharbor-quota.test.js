const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Token Harbor quota reads share one account-wide 60/min budget across keys,
// so the first-add burst (probe + catalog sync + usage refresh) usually spends
// it: one 429 or dropped request must not blank the usage cell. The provider
// module retries over-budget 429s (rate_limit_exceeded) with capped
// Retry-After waits, never retries an auth refusal or a spent allowance (that
// is a valid 100%-used reading), and walks up to three free models when one
// answers without usage headers.
//
// The bug this pins: fetchKeyUsage probed a single model with a single bare
// apiRequest — a 429 on the shared budget, a dropped request, or a 200
// without x-th-* headers threw and blanked the usage cell, and the header
// reads missed mixed-case names from a proxied or mocked reply.

const root = path.join(__dirname, '..', '..');

function loadTokenHarbor() {
  const source = fs.readFileSync(
    path.join(root, 'src', 'renderer', 'providers', 'tokenharbor.js'), 'utf8');
  const window = {};
  new Function('window', source)(window);
  return window.INTEGRATED_PROVIDERS.tokenharbor;
}

const TH = loadTokenHarbor();

const freeList = (ids) => ({
  status: 200,
  headers: {},
  body: JSON.stringify({ data: ids.map((id) => ({ id, pricing: { input_usd_per_1m: 0, output_usd_per_1m: 0 } })) }),
});

const chatOk = (usedPct) => ({
  status: 200,
  headers: {
    'x-th-free-used-pct': String(usedPct),
    'x-th-free-resets': '2026-10-03T06:42:00.000Z',
    'x-th-plan': 'free',
  },
  body: JSON.stringify({ choices: [] }),
});

const SPENT_MESSAGE = "You've used this period's free allowance. Your next rolling 7-day period starts on 26 Sep 2026 at 06:42 UTC. Use the paid model ...";
const spentRefusal = () => ({
  status: 429,
  headers: { 'retry-after': '5' },
  body: JSON.stringify({ error: { code: 'free_tier_limit_reached', message: SPENT_MESSAGE } }),
});

async function runFetchKeyUsage({ models, chats }) {
  const calls = [];
  let chat = 0;
  const apiRequest = async (req) => {
    calls.push(req);
    if (req.url.endsWith('/models')) return models;
    const step = chats[Math.min(chat, chats.length - 1)];
    chat += 1;
    return step;
  };
  const usage = await TH.fetchKeyUsage({ apiKey: 'sk-test', baseUrl: 'https://x/v1', apiRequest });
  return { usage, calls };
}

const chatCalls = (calls) => calls.filter((c) => !c.url.endsWith('/models'));

test('usage headers are read case-insensitively', () => {
  const usage = TH.readUsageHeaders({
    'X-TH-Free-Used-Pct': '42',
    'X-TH-Free-Resets': '2026-10-03T06:42:00.000Z',
    'X-TH-Plan': 'free',
  });
  assert.strictEqual(usage.allowance.usedPct, 42);
  assert.strictEqual(usage.allowance.resetsAt, Date.parse('2026-10-03T06:42:00.000Z'));
  assert.strictEqual(usage.plan, 'free');
});

test('missing usage headers read as no reading', () => {
  assert.strictEqual(TH.readUsageHeaders({}), null);
  assert.strictEqual(TH.readUsageHeaders(null), null);
  assert.strictEqual(TH.readUsageHeaders(undefined), null);
});

test('only the spent code reads as a spent allowance', () => {
  const quota = TH.readQuotaError({ code: 'free_tier_limit_reached', message: SPENT_MESSAGE });
  assert.strictEqual(quota.until, Date.parse('26 Sep 2026 06:42 UTC'));
  assert.strictEqual(quota.message, SPENT_MESSAGE);
  // An over-budget refusal is a retry cue, never a spent allowance.
  assert.strictEqual(TH.readQuotaError({ code: 'rate_limit_exceeded', message: 'slow down' }), null);
  assert.strictEqual(TH.readQuotaError({ code: undefined, message: 'x' }), null);
});

test('a header reading returns the allowance', async () => {
  const { usage, calls } = await runFetchKeyUsage({ models: freeList(['a-free']), chats: [chatOk(17)] });
  assert.strictEqual(usage.allowance.usedPct, 17);
  assert.strictEqual(usage.plan, 'free');
  assert.strictEqual(usage.probe, undefined);
  assert.strictEqual(chatCalls(calls).length, 1);
});

test('a spent refusal reads as fully used with the probe attached, never retried', async () => {
  const { usage, calls } = await runFetchKeyUsage({ models: freeList(['a-free']), chats: [spentRefusal()] });
  assert.strictEqual(usage.allowance.usedPct, 100);
  assert.strictEqual(usage.allowance.resetsAt, Date.parse('26 Sep 2026 06:42 UTC'));
  assert.strictEqual(usage.probe.model, 'a-free');
  assert.strictEqual(usage.probe.status, 429);
  // The spent allowance is an answer, not a failure: exactly one probe.
  assert.strictEqual(chatCalls(calls).length, 1);
});

test('an over-budget 429 is retried and then read', async () => {
  const overBudget = { status: 429, headers: {}, body: JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'slow down' } }) };
  const { usage, calls } = await runFetchKeyUsage({ models: freeList(['a-free']), chats: [overBudget, chatOk(33)] });
  assert.strictEqual(usage.allowance.usedPct, 33);
  assert.strictEqual(chatCalls(calls).length, 2);
});

test('a model answering without headers is skipped for the next free model', async () => {
  const bare = { status: 200, headers: {}, body: JSON.stringify({ choices: [] }) };
  const { usage, calls } = await runFetchKeyUsage({ models: freeList(['a-free', 'b-free']), chats: [bare, chatOk(55)] });
  assert.strictEqual(usage.allowance.usedPct, 55);
  assert.strictEqual(JSON.parse(chatCalls(calls)[0].body).model, 'a-free');
  assert.strictEqual(JSON.parse(chatCalls(calls)[1].body).model, 'b-free');
});

test('an auth refusal on /models throws a readable error without retry', async () => {
  const calls = [];
  const apiRequest = async (req) => { calls.push(req); return { status: 401, headers: {}, body: 'unauthorized' }; };
  await assert.rejects(
    TH.fetchKeyUsage({ apiKey: 'sk-bad', baseUrl: 'https://x/v1', apiRequest }),
    /TokenHarbor \/models HTTP 401/);
  assert.strictEqual(calls.length, 1);
});

test('no free model on the key throws instead of probing', async () => {
  const apiRequest = async () => freeList([]);
  await assert.rejects(
    TH.fetchKeyUsage({ apiKey: 'sk-test', baseUrl: 'https://x/v1', apiRequest }),
    /No free model on this key/);
});
