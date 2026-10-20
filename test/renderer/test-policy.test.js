// Key eligibility, quota facts and request pacing through the production factory.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererModules } = require('./module-loader');

function makePolicy(extra = {}) {
  let now = 1_000_000;
  let aborted = false;
  const statuses = [];
  const provider = { id: 'p', name: 'Provider', rpm: 1, keys: [{ id: 'k1', active: true }, { id: 'k2', active: true }] };
  const namespace = loadRendererModules(['test-policy'], { Date: { now: () => now } }).policy;
  const policy = namespace.create({
    getProviders: () => ({ p: provider }), getActiveProvider: () => 'p',
    isAborted: () => aborted, getRunStatus: () => 'Testing',
    usableKeys: (p) => p.keys.filter(k => k.active !== false),
    saveProviderConfig: async () => true, refreshAfterKeyChange: () => {},
    setStatus: (kind, text) => statuses.push({ kind, text }),
    sleep: async (ms) => { now += ms; }, ...extra,
  });
  return { policy, provider, statuses, advance: (ms) => { now += ms; }, stop: () => { aborted = true; } };
}

test('pacing reserves a slot and another free key beats one at its minute cap', async () => {
  const { policy, provider } = makePolicy();
  const first = policy.pickKey(provider, { id: 'm' });
  assert.equal(first.id, 'k1');
  await policy.waitForSlot(provider, first);
  assert.equal(policy.pickKey(provider, { id: 'm' }).id, 'k2');
  await policy.waitForSlot(provider, provider.keys[1]);
  assert.equal(policy.hasFreeKeyBudget(provider, { id: 'm' }), false);
});

test('minute-old request slots expire and a waiting request reserves the next slot', async () => {
  const { policy, provider, statuses, advance } = makePolicy();
  provider.keys = [provider.keys[0]];
  await policy.waitForSlot(provider, provider.keys[0]);
  assert.equal(policy.hasFreeKeyBudget(provider, { id: 'm' }), false);
  await policy.waitForSlot(provider, provider.keys[0]);
  assert.ok(statuses.some(s => s.text.startsWith('Pacing')));
  assert.equal(policy.hasFreeKeyBudget(provider, { id: 'm' }), false);
  advance(60_001);
  assert.equal(policy.hasFreeKeyBudget(provider, { id: 'm' }), true);
});

test('cooldown selects another key and resetRun only forgets learned rules on reset', async () => {
  const { policy, provider } = makePolicy();
  policy.coolKeyDown('k1', { retryAfter: 30 });
  assert.equal(policy.cooldownUntil('k1'), 1_030_000);
  assert.equal(policy.pickKey(provider, { id: 'm' }).id, 'k2');
  policy.deny('k2', 'm');
  policy.resetRun(false);
  assert.equal(policy.cooldownUntil('k1'), 0);
  assert.equal(policy.isDenied('k2', 'm'), true);
  policy.resetRun(true);
  assert.equal(policy.isDenied('k2', 'm'), false);
});

test('per-model quota is retained without disabling unrelated models', async () => {
  const { policy, provider } = makePolicy();
  await policy.markKeySpent('p', 'k1', { until: null, message: 'Used' }, 'm1');
  assert.equal(policy.isKeyPartiallySpent(provider.keys[0]), true);
  assert.equal(policy.isKeyFullySpent(provider.keys[0]), false);
  assert.equal(policy.isKeySpentFor(provider.keys[0], 'm1'), true);
  assert.equal(policy.isKeySpentFor(provider.keys[0], 'm2'), false);
  assert.deepEqual(Array.from(policy.keysFor(provider, { id: 'm1' }), k => k.id), ['k2']);
  await policy.clearKeySpent('p', 'k1');
  assert.equal(policy.isKeySpent(provider.keys[0]), false);
});

test('billing denial never becomes throttling and learned limits stay key-specific', async () => {
  const { policy, provider } = makePolicy();
  assert.equal(policy.isRateLimit({ statusCode: 429, response: 'Insufficient credits, top up' }), false);
  assert.equal(policy.isRateLimit({ statusCode: 429, response: 'Too many requests' }), true);
  provider.rpm = 20;
  await policy.waitForSlot(provider, provider.keys[0]);
  // The signature takes the provider: a learned ceiling may only narrow a
  // PUBLISHED rpm, never invent one from a single refusal.
  policy.learnRateLimit(provider, 'k1');
  assert.equal(policy.budgetFor(provider, 'k1'), 1);
  assert.equal(policy.budgetFor(provider, 'k2'), 20);
  policy.resetRun(false);
  assert.equal(policy.budgetFor(provider, 'k1'), 1);
  policy.resetRun(true);
  assert.equal(policy.budgetFor(provider, 'k1'), 20);
});

test('Stop while pacing does not reserve another request slot', async () => {
  const { policy, provider, stop } = makePolicy();
  provider.keys = [provider.keys[0]];
  await policy.waitForSlot(provider, provider.keys[0]);
  stop();
  await policy.waitForSlot(provider, provider.keys[0]);
  assert.equal(policy.slotsUsed('k1', 1_000_000), 1);
});
