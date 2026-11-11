const test = require('node:test');
const assert = require('node:assert');
const { buildMeasuredCards, attachMeasured, rowMeasuredCard } = require('../../src/catalog/measured');

// Measured cards (foundation rebuild R1): first-party observations
// stamped onto catalog rows. Unmeasured rows carry null — the absence
// is a fact, never a guess.

const MEASUREMENTS = [
  { providerId: 'apinex', modelId: 'free/kimi-k3', attempts: 12, passed: 11, successRate: 11 / 12, avgLatencyMs: 2400, avgTtftMs: 300, outputTps: 42.5, lastSeenAt: 999 },
  { providerId: 'groq', modelId: 'gpt-oss-120b', attempts: 3, passed: 3, successRate: 1, avgLatencyMs: 800, avgTtftMs: null, outputTps: 120, lastSeenAt: 555 },
  { providerId: '', modelId: 'x', attempts: 1 }, // unusable: skipped
  { providerId: 'p', modelId: null, attempts: 1 }, // unusable: skipped
];

test('buildMeasuredCards keys cards by provider::model and skips unusable rows', () => {
  const cards = buildMeasuredCards(MEASUREMENTS);
  assert.equal(cards.size, 2);
  assert.deepStrictEqual(cards.get('apinex::free/kimi-k3'), {
    attempts: 12, passed: 11, successRate: 11 / 12, avgLatencyMs: 2400, avgTtftMs: 300, outputTps: 42.5, lastSeenAt: 999,
  });
});

test('attachMeasured stamps snake_case and camelCase rows; unmeasured rows get null', () => {
  const cards = buildMeasuredCards(MEASUREMENTS);
  const rows = [
    { provider_id: 'apinex', model_id: 'free/kimi-k3' },
    { providerId: 'groq', modelId: 'gpt-oss-120b' },
    { provider_id: 'apinex', model_id: 'never-called' },
    { provider_id: 'apinex' },
  ];
  attachMeasured(rows, cards);
  assert.equal(rows[0].measured.attempts, 12);
  assert.equal(rows[1].measured.outputTps, 120);
  assert.strictEqual(rows[2].measured, null);
  assert.strictEqual(rows[3].measured, null);
  assert.strictEqual(rowMeasuredCard(null, cards), null);
  assert.strictEqual(rowMeasuredCard(rows[0], null), null);
});
