const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// KiosAPI registers as the eleventh built-in provider. Its roster differs per
// key (26 on a free key, 38 on a funded one) but discovery is the shared
// default path, which already asks every active key and records keyIds — so
// this module needs no fetchModels. What the tests must pin:
//
//   1. registration + structuredClone-safe meta (provider-store clones it)
//   2. the logo file actually exists on disk (a broken path renders a dead tile)
//   3. the odd entry shape KiosAPI returns (supported_endpoint_types,
//      placeholder created/owned_by, alias-to-canonical model echo) is not
//      misread by the default discovery mappers
//   4. no fetchKeyUsage: the billing endpoints answer sentinel limits
//      (100000000) and access_until 0, which must not feed a quota bar —
//      the provider honestly reports "No quota published"

const root = path.join(__dirname, '..', '..');

function loadKiosapi() {
  const source = fs.readFileSync(
    path.join(root, 'src', 'renderer', 'providers', 'kiosapi.js'), 'utf8');
  const window = {};
  new Function('window', source)(window);
  return window.INTEGRATED_PROVIDERS.kiosapi;
}

const KIOSAPI = loadKiosapi();

test('registers into window.INTEGRATED_PROVIDERS with the KiosAPI identity', () => {
  assert.ok(KIOSAPI, 'kiosapi module did not register');
  assert.strictEqual(KIOSAPI.meta.id, 'kiosapi');
  assert.strictEqual(KIOSAPI.meta.name, 'KiosAPI');
  assert.strictEqual(KIOSAPI.meta.baseUrl, 'https://kiosapi.com/v1');
  assert.strictEqual(KIOSAPI.meta.modelsEndpoint, '/models');
  assert.strictEqual(KIOSAPI.meta.chatEndpoint, '/chat/completions');
});

test('meta is plain data — structuredClone-safe for the provider store', () => {
  const clone = structuredClone(KIOSAPI.meta);
  assert.deepStrictEqual(clone, KIOSAPI.meta);
});

test('declares a free tier so the Providers legend shows the Free Tier dot', () => {
  assert.strictEqual(KIOSAPI.meta.freeTier, true);
});

test('logo file exists at the path the meta declares', () => {
  // index.html loads from src/renderer/, so '../assets/…' resolves to
  // src/assets/… — the same layout every other provider module relies on.
  const rel = KIOSAPI.meta.logo.replace(/^\.\.\//, '');
  const file = path.join(root, 'src', rel.replace(/\//g, path.sep));
  assert.ok(fs.existsSync(file), `missing logo file: ${file}`);
});

test('no fetchKeyUsage: sentinel billing numbers must not feed a quota bar', () => {
  // KIOSAPI.md §8: soft/hard limits read 100000000 (a sentinel) and
  // access_until 0 — nothing here is a real quota, so the module must not
  // present one. key-usage.js then shows "No quota published" honestly.
  assert.strictEqual(KIOSAPI.fetchKeyUsage, undefined);
});

test('the default discovery mappers read a KiosAPI-shaped entry without harm', () => {
  // KIOSAPI.md §3: entries carry supported_endpoint_types, a placeholder
  // created timestamp, a generic owned_by, and no context/capability fields.
  // A KiosAPI id is an alias; the canonical id only comes back in a chat
  // response's model field — discovery must keep the alias the roster gave.
  const entry = {
    id: 'qwen3-8b', object: 'model', created: 1626777600,
    owned_by: 'openai', supported_endpoint_types: ['openai'],
  };
  const m = entry;
  const ctx = m.context_window ?? m.context_length ?? m.max_context_tokens ?? m.max_context_length
    ?? m.top_provider?.context_length ?? m.limit?.context ?? null;
  const reasoning = m.reasoning != null ? !!m.reasoning
    : Array.isArray(m.capabilities) && m.capabilities.includes('reasoning');
  const vision = m.vision != null ? !!m.vision
    : Array.isArray(m.capabilities) && m.capabilities.includes('vision');
  assert.strictEqual(ctx, null);
  assert.strictEqual(reasoning, false);
  assert.strictEqual(vision, false);
  // The alias survives: nothing in the entry can rewrite it.
  assert.strictEqual(entry.id, 'qwen3-8b');
});
