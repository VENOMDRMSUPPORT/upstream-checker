const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// hasFreeKeyBudget is evaluated with its own dependencies (slotsUsed, budgetFor,
// learnRateLimit, learnedRpm, keyRequestTimes) sliced in, while keysFor — which
// drags in usableKeys and the whole key-eligibility rule — is injected as a
// stub. The budget question under test is "does any eligible key have a slot",
// and the eligibility rule is pinned by its own tests elsewhere.
//
// The property pinned: a key at its per-minute cap is not "free", and no
// configured cap means no constraint. Both the hedge escalator and the
// empty-recovery race consult this before firing a parallel attempt, so a
// "free" verdict at the cap would spend slots the models still waiting need.
const source = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'renderer', 'app.js'), 'utf8');
const start = source.indexOf('function slotsUsed(keyId, now) {');
const endMarker = 'function hasFreeKeyBudget(provider, model) {';
const endStart = source.indexOf(endMarker);
assert.ok(start !== -1 && endStart !== -1, 'budget block not found in app.js');
// hasFreeKeyBudget ends at the closing brace before the next comment block.
const end = source.indexOf('\n}\r', endStart) !== -1
  ? source.indexOf('\n}\r', endStart)
  : source.indexOf('\n}\n', endStart);
assert.ok(end !== -1, 'hasFreeKeyBudget end not found');
const block = source.slice(start, end + 3);
const B = new Function('keyRequestTimes', 'keysFor', 'rpmOf', `${block}
return { learnedRpm, slotsUsed, budgetFor, hasFreeKeyBudget };`);

const provider = { rpm: 2 };
const oneKey = [{ id: 'k1' }];
const keysFor = () => oneKey;
const rpmOf = (p) => p?.rpm;
const keyRequestTimes = new Map();
const M = B(keyRequestTimes, keysFor, rpmOf);

test('a key under its cap has a free slot', () => {
  keyRequestTimes.set('k1', [Date.now() - 10_000]);
  assert.strictEqual(M.hasFreeKeyBudget(provider, { id: 'm1' }), true);
});

test('a key at its cap is not free', () => {
  keyRequestTimes.set('k1', [Date.now() - 1000, Date.now() - 2000]);
  assert.strictEqual(M.slotsUsed('k1', Date.now()), 2);
  assert.strictEqual(M.hasFreeKeyBudget(provider, { id: 'm1' }), false);
});

test('slots older than a minute do not count against the cap', () => {
  keyRequestTimes.set('k1', [Date.now() - 61_000, Date.now() - 62_000]);
  assert.strictEqual(M.hasFreeKeyBudget(provider, { id: 'm1' }), true);
});

test('no configured cap means no constraint (always free)', () => {
  keyRequestTimes.set('k1', [Date.now(), Date.now(), Date.now()]);
  assert.strictEqual(M.hasFreeKeyBudget({}, { id: 'm1' }), true);
});
