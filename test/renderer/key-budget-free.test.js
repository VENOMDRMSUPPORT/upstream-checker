// Free-budget checks through the same production pacing used by test attempts.
const test = require('node:test');
const assert = require('node:assert');
const { loadRendererModules } = require('./module-loader');

async function setup(count, rpm = 2) {
  let now = 1_000_000;
  const provider = { id: 'p', rpm, keys: [{ id: 'k1' }] };
  const M = loadRendererModules(['test-policy'], { Date: { now: () => now } }).policy.create({
    usableKeys: p => p.keys, isAborted: () => false,
    setStatus: () => {}, sleep: async ms => { now += ms; },
  });
  for (let i = 0; i < count; i++) await M.waitForSlot(provider, provider.keys[0]);
  return { M, provider, advance: ms => { now += ms; } };
}

test('a key under its cap has a free slot', async () => {
  const { M, provider } = await setup(1);
  assert.strictEqual(M.hasFreeKeyBudget(provider, { id: 'm1' }), true);
});

test('a key at its cap is not free', async () => {
  const { M, provider } = await setup(2);
  assert.strictEqual(M.slotsUsed('k1', 1_000_000), 2);
  assert.strictEqual(M.hasFreeKeyBudget(provider, { id: 'm1' }), false);
});

test('slots older than a minute do not count against the cap', async () => {
  const { M, provider, advance } = await setup(2);
  advance(61_000);
  assert.strictEqual(M.hasFreeKeyBudget(provider, { id: 'm1' }), true);
});

test('no configured cap means no constraint (always free)', async () => {
  const { M, provider } = await setup(3, 0);
  assert.strictEqual(M.hasFreeKeyBudget(provider, { id: 'm1' }), true);
});
