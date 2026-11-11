const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Nexum Router registers as a built-in provider: an OpenAI-compatible
// relay on a fixed-price weekly unlimited plan. What the tests must pin:
//
//   1. registration + structuredClone-safe meta (provider-store clones it)
//   2. the unlimited-usage declaration the key-usage UI renders
//   3. the keyTier declaration provider-store stamps onto its keys, so the
//      router's drain waterfall treats them as the subscriptions they are
//   4. the logo file actually exists on disk

const root = path.join(__dirname, '..', '..');

function loadProvider() {
  const source = fs.readFileSync(
    path.join(root, 'src', 'renderer', 'providers', 'nexum.js'), 'utf8');
  const window = {};
  new Function('window', source)(window);
  return window.INTEGRATED_PROVIDERS.nexum;
}

const ENTRY = loadProvider();

test('registers into window.INTEGRATED_PROVIDERS with the Nexum identity', () => {
  assert.ok(ENTRY, 'nexum module did not register');
  assert.strictEqual(ENTRY.meta.id, 'nexum');
  assert.strictEqual(ENTRY.meta.name, 'Nexum Router');
  assert.strictEqual(ENTRY.meta.baseUrl, 'https://dialagram.me/router/v1');
  assert.strictEqual(ENTRY.meta.modelsEndpoint, '/models');
  assert.strictEqual(ENTRY.meta.chatEndpoint, '/chat/completions');
});

test('meta is plain data — structuredClone-safe for the provider store', () => {
  assert.deepStrictEqual(structuredClone(ENTRY.meta), ENTRY.meta);
});

test('declares unlimited usage on the weekly plan', () => {
  assert.strictEqual(ENTRY.meta.billing.usage, 'unlimited');
  assert.ok(ENTRY.meta.unlimitedUsage);
  assert.match(ENTRY.meta.unlimitedUsage.detail, /Unlimited/);
});

test('declares its keys as subscription tier for the router waterfall', () => {
  assert.strictEqual(ENTRY.meta.keyTier, 'subscription');
});

test('logo file exists at the path the meta declares', () => {
  const logoPath = path.join(root, 'src', 'renderer', ENTRY.meta.logo);
  assert.ok(fs.existsSync(logoPath), `missing logo file: ${ENTRY.meta.logo}`);
});

test('classify keeps generators out of the chat pool', () => {
  assert.strictEqual(ENTRY.classify({ id: 'qwen-3.8-max' }), 'chat');
  assert.strictEqual(ENTRY.classify({ id: 'qwen-image-3.0' }), 'image');
  assert.strictEqual(ENTRY.classify({ id: 'wan-2.0' }), 'video');
});
