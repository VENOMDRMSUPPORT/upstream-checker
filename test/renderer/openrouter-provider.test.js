const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// OpenRouter registers as a built-in provider through the standard contract:
// a base URL, a Bearer key and /models + /chat/completions. The one piece
// of custom code is fetchKeyUsage, reading the key's usage from /auth/key.
// What the tests must pin:
//
//   1. registration + structuredClone-safe meta (provider-store clones it)
//   2. the logo file actually exists on disk (a broken path renders a dead tile)
//
// The free-tier facts in meta were verified against the provider's own
// documentation on the verifiedOn date — see docs/integrations/OPENROUTER.md.

const root = path.join(__dirname, '..', '..');

function loadProvider() {
  const source = fs.readFileSync(
    path.join(root, 'src', 'renderer', 'providers', 'openrouter.js'), 'utf8');
  const window = {};
  new Function('window', source)(window);
  return window.INTEGRATED_PROVIDERS.openrouter;
}

const ENTRY = loadProvider();

test('registers into window.INTEGRATED_PROVIDERS with the OpenRouter identity', () => {
  assert.ok(ENTRY, 'openrouter module did not register');
  assert.strictEqual(ENTRY.meta.id, 'openrouter');
  assert.strictEqual(ENTRY.meta.name, 'OpenRouter');
  assert.strictEqual(ENTRY.meta.baseUrl, 'https://openrouter.ai/api/v1');
  assert.strictEqual(ENTRY.meta.modelsEndpoint, '/models');
  assert.strictEqual(ENTRY.meta.chatEndpoint, '/chat/completions');
  assert.deepStrictEqual(ENTRY.meta.auth, ['apikey']);
});

test('meta is plain data — structuredClone-safe for the provider store', () => {
  assert.deepStrictEqual(structuredClone(ENTRY.meta), ENTRY.meta);
});

test('the entry is meta plus the key-usage hook — no other behaviour', () => {
  assert.deepStrictEqual(Object.keys(ENTRY), ['meta', 'fetchKeyUsage']);
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

// fetchKeyUsage reads GET /auth/key. The free-tier shape below is the one
// verified live on 2026-11-11 (usage $0.1557, limit null, is_free_tier true):
// no limit means no quota bar — the plan label is the reading.
test('fetchKeyUsage maps a free-tier key to a plan label with no quota', async () => {
  const apiRequest = async ({ url }) => {
    assert.ok(url.endsWith('/auth/key'), `unexpected probe url: ${url}`);
    return { status: 200, body: JSON.stringify({ data: { usage: 0.1557, limit: null, limit_remaining: null, is_free_tier: true } }) };
  };
  const usage = await ENTRY.fetchKeyUsage({ apiKey: 'sk-or-test', baseUrl: ENTRY.meta.baseUrl, apiRequest });
  assert.strictEqual(usage.quota, null);
  assert.strictEqual(usage.plan, 'Free tier');
  assert.strictEqual(usage.expiresAt, null);
});

test('fetchKeyUsage maps a limited key to a USD quota bar', async () => {
  const apiRequest = async () => ({ status: 200, body: JSON.stringify({ data: { usage: 2.5, limit: 10, limit_remaining: 7.5, is_free_tier: false } }) });
  const usage = await ENTRY.fetchKeyUsage({ apiKey: 'sk-or-test', baseUrl: ENTRY.meta.baseUrl, apiRequest });
  assert.deepStrictEqual(usage.quota, { total: 10, remaining: 7.5, unit: 'USD' });
  assert.strictEqual(usage.plan, null);
});

test('fetchKeyUsage derives remaining from limit minus usage when the field is absent', async () => {
  const apiRequest = async () => ({ status: 200, body: JSON.stringify({ data: { usage: 2.5, limit: 10, is_free_tier: false } }) });
  const usage = await ENTRY.fetchKeyUsage({ apiKey: 'sk-or-test', baseUrl: ENTRY.meta.baseUrl, apiRequest });
  assert.deepStrictEqual(usage.quota, { total: 10, remaining: 7.5, unit: 'USD' });
});

test('fetchKeyUsage throws on a refused or malformed answer', async () => {
  const refused = async () => ({ status: 401, body: 'unauthorized' });
  await assert.rejects(() => ENTRY.fetchKeyUsage({ apiKey: 'bad', baseUrl: ENTRY.meta.baseUrl, apiRequest: refused }), /HTTP 401/);
  const malformed = async () => ({ status: 200, body: '{"nope":true}' });
  await assert.rejects(() => ENTRY.fetchKeyUsage({ apiKey: 'bad', baseUrl: ENTRY.meta.baseUrl, apiRequest: malformed }), /without a key object/);
});
