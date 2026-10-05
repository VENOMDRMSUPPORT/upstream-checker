const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// The quota-state helpers in src/renderer/app.js are plain top-level function
// declarations, the same shape as provider-facts.js: queriable here by slicing
// the block between the QUOTA_SPENT_TTL_MS declaration and the end of
// isKeySpentFor, which touches neither window nor PROVIDERS at evaluation.
//
// The bug this pins: a per-model refusal (quotaSpent.models = ['atria-...'])
// rendered as a key-wide "Quota used" badge with "No reset time", while the
// usage cell beside it said Unlimited — on a provider that publishes no quota
// at all. A model list means some models, never the key.
const source = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'renderer', 'app.js'), 'utf8');
const start = source.indexOf('const QUOTA_SPENT_TTL_MS');
const anchor = 'function isKeySpentFor(k, modelId) {';
const afterAnchor = source.indexOf(anchor);
assert.ok(start !== -1 && afterAnchor !== -1, 'quota-state block not found in app.js');
const endBrace = source.indexOf('}', source.indexOf('includes(modelId)', afterAnchor));
const block = source.slice(start, endBrace + 1);
const Q = new Function(`${block}
return { QUOTA_SPENT_TTL_MS, quotaSpentExpired, isKeySpent, isKeyFullySpent,
  isKeyPartiallySpent, isKeySpentFor };`)();

// One refused model on a key that serves dozens: the routing already treats it
// this way (keysFor filters just isKeySpentFor), and now the badge agrees.
test('a per-model refusal is a partial spend, never a spent key', () => {
  const k = { id: 'k1', quotaSpent: { until: null, status: 429, message: 'Quota used up', at: Date.now(), models: ['atria-dawn-preview'] } };
  assert.strictEqual(Q.isKeySpent(k), true);
  assert.strictEqual(Q.isKeyFullySpent(k), false);
  assert.strictEqual(Q.isKeyPartiallySpent(k), true);
  assert.strictEqual(Q.isKeySpentFor(k, 'atria-dawn-preview'), true);
  assert.strictEqual(Q.isKeySpentFor(k, 'deepseek-v4.1-flash'), false);
});

// A record with no model list is the only shape that spends the whole key:
// Token Harbor's free tier, an allowance with nothing left to try.
test('a model-less record spends the whole key', () => {
  const k = { id: 'k1', quotaSpent: { until: null, status: 429, message: 'x', at: Date.now(), models: [] } };
  assert.strictEqual(Q.isKeyFullySpent(k), true);
  assert.strictEqual(Q.isKeyPartiallySpent(k), false);
});

// A refusal that named no reset is one model's answer on one day. Without an
// expiry it would sit on the key forever — Dark API's generic readQuotaError
// path never sets `until`.
test('a reset-less record expires after the TTL', () => {
  const stale = { until: null, at: Date.now() - Q.QUOTA_SPENT_TTL_MS - 1000, models: ['m'] };
  const k = { id: 'k1', quotaSpent: stale };
  assert.strictEqual(Q.quotaSpentExpired(stale), true);
  assert.strictEqual(Q.isKeySpent(k), false);
  assert.strictEqual(Q.isKeySpentFor(k, 'm'), false);
});

// A dated record keeps the old behaviour: it lives until its reset passes, so
// Token Harbor's named reset is never cut short by the TTL.
test('a dated record is untouched by the TTL', () => {
  const s = { until: Date.now() + 3600000, at: Date.now() - Q.QUOTA_SPENT_TTL_MS - 1000, models: ['m'] };
  assert.strictEqual(Q.quotaSpentExpired(s), false);
  const k = { id: 'k1', quotaSpent: s };
  assert.strictEqual(Q.isKeySpent(k), true);
  const past = { until: Date.now() - 1000, at: Date.now(), models: ['m'] };
  assert.strictEqual(Q.isKeySpent({ id: 'k1', quotaSpent: past }), false);
});
