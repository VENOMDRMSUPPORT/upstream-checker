const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Pollinations registers as a built-in provider through the standard contract:
// a base URL, a Bearer key and /models + /chat/completions — no custom
// code, so this module is meta only. What the tests must pin:
//
//   1. registration + structuredClone-safe meta (provider-store clones it)
//   2. the logo file actually exists on disk (a broken path renders a dead tile)
//
// The free-tier facts in meta were verified against the provider's own
// documentation on the verifiedOn date — see docs/integrations/POLLINATIONS.md.

const root = path.join(__dirname, '..', '..');

function loadProvider() {
  const source = fs.readFileSync(
    path.join(root, 'src', 'renderer', 'providers', 'pollinations.js'), 'utf8');
  const window = {};
  new Function('window', source)(window);
  return window.INTEGRATED_PROVIDERS.pollinations;
}

const ENTRY = loadProvider();

test('registers into window.INTEGRATED_PROVIDERS with the Pollinations identity', () => {
  assert.ok(ENTRY, 'pollinations module did not register');
  assert.strictEqual(ENTRY.meta.id, 'pollinations');
  assert.strictEqual(ENTRY.meta.name, 'Pollinations');
  assert.strictEqual(ENTRY.meta.baseUrl, 'https://gen.pollinations.ai/v1');
  assert.strictEqual(ENTRY.meta.modelsEndpoint, '/models');
  assert.strictEqual(ENTRY.meta.chatEndpoint, '/chat/completions');
  assert.deepStrictEqual(ENTRY.meta.auth, ['apikey']);
});

test('meta is plain data — structuredClone-safe for the provider store', () => {
  assert.deepStrictEqual(structuredClone(ENTRY.meta), ENTRY.meta);
});

test('the entry is data only — no behaviour hooks', () => {
  assert.deepStrictEqual(Object.keys(ENTRY), ['meta']);
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
