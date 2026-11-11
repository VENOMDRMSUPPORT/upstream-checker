const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// GitHub Models registers as a built-in provider through the standard contract:
// a base URL, a Bearer key and /models + /chat/completions. The custom code
// is the key-usage reading (readUsageHeaders + fetchKeyUsage) from the
// rate-limit headers the inference endpoint documents. What the tests
// must pin:
//
//   1. registration + structuredClone-safe meta (provider-store clones it)
//   2. the logo file actually exists on disk (a broken path renders a dead tile)
//
// The free-tier facts in meta were verified against the provider's own
// documentation on the verifiedOn date — see docs/integrations/GITHUBMODELS.md.

const root = path.join(__dirname, '..', '..');

function loadProvider() {
  const source = fs.readFileSync(
    path.join(root, 'src', 'renderer', 'providers', 'githubmodels.js'), 'utf8');
  const window = {};
  new Function('window', source)(window);
  return window.INTEGRATED_PROVIDERS.githubmodels;
}

const ENTRY = loadProvider();

test('registers into window.INTEGRATED_PROVIDERS with the GitHub Models identity', () => {
  assert.ok(ENTRY, 'githubmodels module did not register');
  assert.strictEqual(ENTRY.meta.id, 'githubmodels');
  assert.strictEqual(ENTRY.meta.name, 'GitHub Models');
  assert.strictEqual(ENTRY.meta.baseUrl, 'https://models.github.ai/inference');
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

// The header dialect is documentation-based (see the module): the parser
// must read the Azure-style names, accept the per-token spellings, and
// return null — never an invented reading — when they are absent.
test('readUsageHeaders reads the documented Azure-style headers', () => {
  const resetSec = Math.floor(Date.now() / 1000) + 3600;
  const usage = ENTRY.readUsageHeaders({
    'x-ratelimit-limit': '150',
    'x-ratelimit-remaining': '75',
    'x-ratelimit-reset': String(resetSec),
  });
  assert.ok(usage);
  assert.strictEqual(usage.allowance.usedPct, 50);
  assert.strictEqual(usage.allowance.resetsAt, resetSec * 1000);
});

test('readUsageHeaders accepts the per-token spellings and returns null when absent', () => {
  const usage = ENTRY.readUsageHeaders({ 'x-ratelimit-limit-tokens': '100', 'x-ratelimit-remaining-tokens': '100' });
  assert.strictEqual(usage.allowance.usedPct, 0);
  assert.strictEqual(usage.allowance.resetsAt, null);
  assert.strictEqual(ENTRY.readUsageHeaders({}), null);
  assert.strictEqual(ENTRY.readUsageHeaders(null), null);
});

test('fetchKeyUsage probes a one-token chat and reads its headers', async () => {
  const calls = [];
  const apiRequest = async ({ url }) => {
    calls.push(url);
    if (url.endsWith('/models')) return { status: 200, headers: {}, body: JSON.stringify({ data: [{ id: 'openai/gpt-4.1' }] }) };
    return { status: 200, headers: { 'x-ratelimit-limit': '150', 'x-ratelimit-remaining': '149' }, body: '{}' };
  };
  const usage = await ENTRY.fetchKeyUsage({ apiKey: 'ghp_test', baseUrl: ENTRY.meta.baseUrl, apiRequest });
  assert.strictEqual(calls.length, 2);
  assert.ok(Math.abs(usage.allowance.usedPct - (1 / 150) * 100) < 0.01);
});
