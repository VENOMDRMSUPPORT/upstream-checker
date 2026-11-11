const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Groq registers as a built-in provider through the standard contract:
// a base URL, a Bearer key and /models + /chat/completions. The custom code
// is the key-usage reading (readUsageHeaders + fetchKeyUsage) — Groq
// publishes no usage endpoint, but chat answers carry the rate window in
// their headers. What the tests must pin:
//
//   1. registration + structuredClone-safe meta (provider-store clones it)
//   2. the logo file actually exists on disk (a broken path renders a dead tile)
//
// The free-tier facts in meta were verified against the provider's own
// documentation on the verifiedOn date — see docs/integrations/GROQ.md.

const root = path.join(__dirname, '..', '..');

function loadProvider() {
  const source = fs.readFileSync(
    path.join(root, 'src', 'renderer', 'providers', 'groq.js'), 'utf8');
  const window = {};
  new Function('window', source)(window);
  return window.INTEGRATED_PROVIDERS.groq;
}

const ENTRY = loadProvider();

test('registers into window.INTEGRATED_PROVIDERS with the Groq identity', () => {
  assert.ok(ENTRY, 'groq module did not register');
  assert.strictEqual(ENTRY.meta.id, 'groq');
  assert.strictEqual(ENTRY.meta.name, 'Groq');
  assert.strictEqual(ENTRY.meta.baseUrl, 'https://api.groq.com/openai/v1');
  assert.strictEqual(ENTRY.meta.modelsEndpoint, '/models');
  assert.strictEqual(ENTRY.meta.chatEndpoint, '/chat/completions');
  assert.deepStrictEqual(ENTRY.meta.auth, ['apikey']);
});

test('meta is plain data — structuredClone-safe for the provider store', () => {
  assert.deepStrictEqual(structuredClone(ENTRY.meta), ENTRY.meta);
});

test('the entry is meta plus the key-usage hooks — no other behaviour', () => {
  assert.deepStrictEqual(Object.keys(ENTRY), ['meta', 'readUsageHeaders', 'fetchKeyUsage']);
  assert.strictEqual(typeof ENTRY.readUsageHeaders, 'function');
  assert.strictEqual(typeof ENTRY.fetchKeyUsage, 'function');
});

test('logo file exists at the path the meta declares', () => {
  const logoPath = path.join(root, 'src', 'renderer', ENTRY.meta.logo);
  assert.ok(fs.existsSync(logoPath), `missing logo file: ${ENTRY.meta.logo}`);
});

test('carries its verified free-tier facts', () => {
  assert.match(ENTRY.meta.verifiedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(ENTRY.meta.planNote.length > 0);
  assert.ok(ENTRY.meta.rateLimits.lines.length > 0);
  assert.strictEqual(ENTRY.meta.freeTier, true);
});

// The header set captured live from a one-token chat on 2026-11-11.
const LIVE_HEADERS = {
  'x-ratelimit-limit-requests': '1000',
  'x-ratelimit-limit-tokens': '8000',
  'x-ratelimit-remaining-requests': '999',
  'x-ratelimit-remaining-tokens': '7927',
  'x-ratelimit-reset-requests': '1m26.4s',
  'x-ratelimit-reset-tokens': '547ms',
};

test('readUsageHeaders reads the token window off a chat answer', () => {
  const before = Date.now();
  const usage = ENTRY.readUsageHeaders(LIVE_HEADERS);
  assert.ok(usage);
  assert.strictEqual(usage.quota, null);
  assert.strictEqual(usage.allowance.label, 'Rate window');
  assert.ok(Math.abs(usage.allowance.usedPct - ((8000 - 7927) / 8000) * 100) < 0.01);
  assert.ok(usage.allowance.resetsAt >= before + 400 && usage.allowance.resetsAt <= Date.now() + 900,
    'the 547ms reset-tokens duration becomes resetsAt');
});

test('readUsageHeaders falls back to the requests reset and parses compound durations', () => {
  const headers = {
    'x-ratelimit-limit-tokens': '8000',
    'x-ratelimit-remaining-tokens': '4000',
    'x-ratelimit-reset-requests': '1m26.4s',
  };
  const before = Date.now();
  const usage = ENTRY.readUsageHeaders(headers);
  assert.strictEqual(usage.allowance.usedPct, 50);
  assert.ok(usage.allowance.resetsAt >= before + 85000 && usage.allowance.resetsAt <= Date.now() + 88000,
    '1m26.4s parses to about 86.4 seconds');
});

test('readUsageHeaders returns null without the token headers', () => {
  assert.strictEqual(ENTRY.readUsageHeaders(null), null);
  assert.strictEqual(ENTRY.readUsageHeaders({}), null);
  assert.strictEqual(ENTRY.readUsageHeaders({ 'x-ratelimit-limit-tokens': '8000' }), null);
});

test('fetchKeyUsage probes a one-token chat and reads its headers', async () => {
  const calls = [];
  const apiRequest = async ({ url }) => {
    calls.push(url);
    if (url.endsWith('/models')) return { status: 200, headers: {}, body: JSON.stringify({ data: [{ id: 'openai/gpt-oss-20b' }] }) };
    return { status: 200, headers: LIVE_HEADERS, body: '{}' };
  };
  const usage = await ENTRY.fetchKeyUsage({ apiKey: 'gsk_test', baseUrl: ENTRY.meta.baseUrl, apiRequest });
  assert.strictEqual(calls.length, 2);
  assert.ok(calls[1].endsWith('/chat/completions'));
  assert.strictEqual(usage.allowance.label, 'Rate window');
});

test('fetchKeyUsage takes the reading from /models when headers ride along', async () => {
  let calls = 0;
  const apiRequest = async () => { calls += 1; return { status: 200, headers: LIVE_HEADERS, body: JSON.stringify({ data: [] }) }; };
  const usage = await ENTRY.fetchKeyUsage({ apiKey: 'gsk_test', baseUrl: ENTRY.meta.baseUrl, apiRequest });
  assert.strictEqual(calls, 1);
  assert.ok(usage.allowance);
});
