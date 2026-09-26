const test = require('node:test');
const assert = require('node:assert');
const { createKeyResolver } = require('../../src/db/keys');
const { memoryStore, LOCKED_BLOB } = require('../helpers');

const NARA = 'https://router.bynara.id/v1';
const MIRAI = 'https://api.miraiapi.com/v1';
// Needs escaping in JSON and in a URL.
const TRICKY = 'sk-"mirai\\quote';

async function setup(t) {
  const store = await memoryStore(t);
  const providers = store.repos.providers;
  providers.save({ id: 'nara', name: 'NaraRouter', baseUrl: NARA, rpm: null, keys: [
    { id: 'key_1', name: 'One', key: 'sk-nara-1', active: true },
    { id: 'key_12', name: 'Twelve', key: 'sk-nara-12', active: true },
  ] });
  providers.save({ id: 'mirai', name: 'Mirai', baseUrl: MIRAI, rpm: null, keys: [{ id: 'key_m', name: 'M', key: TRICKY, active: true }] });
  providers.importProvider({ id: 'darkapi', name: 'Dark API', baseUrl: 'https://darkapi.dev/v1', rpm: null, custom: false, position: 2,
    keys: [{ id: 'key_locked', name: 'Other PC', cipher: LOCKED_BLOB, active: true, quotaSpent: null }] });
  store.repos.secrets.save('aaApiKey', 'aa-secret');
  return { store, resolver: createKeyResolver({ providers, secrets: store.repos.secrets }) };
}

test('a header placeholder becomes the key for its own provider', async (t) => {
  const { resolver } = await setup(t);
  const out = resolver.resolve({ url: `${NARA}/models`, headers: { Authorization: 'Bearer venomkey:key_1', 'Content-Type': 'application/json' } });
  assert.deepStrictEqual(out, {
    url: `${NARA}/models`,
    headers: { Authorization: 'Bearer sk-nara-1', 'Content-Type': 'application/json' },
    body: undefined,
  });
});

test('a placeholder in the URL is replaced URL-encoded', async (t) => {
  const { resolver } = await setup(t);
  const out = resolver.resolve({ url: `${MIRAI}/usage?key=venomkey:key_m`, headers: {} });
  assert.strictEqual(out.url, `${MIRAI}/usage?key=${encodeURIComponent(TRICKY)}`);
});

test('inside a JSON body the key is inserted JSON-escaped', async (t) => {
  const { resolver } = await setup(t);
  const out = resolver.resolve({
    url: 'https://api.miraiapi.com/api/usage/check', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: 'venomkey:key_m' }),
  });
  assert.deepStrictEqual(JSON.parse(out.body), { api_key: TRICKY });
});

test('a non-JSON string body gets the raw key', async (t) => {
  const { resolver } = await setup(t);
  const out = resolver.resolve({ url: `${NARA}/x`, headers: {}, body: 'token=venomkey:key_1&x=1' });
  assert.strictEqual(out.body, 'token=sk-nara-1&x=1');
});

test('an object body is sent as JSON with the key inside', async (t) => {
  const { resolver } = await setup(t);
  const out = resolver.resolve({ url: `${NARA}/x`, headers: {}, body: { key: 'venomkey:key_1' } });
  assert.deepStrictEqual(JSON.parse(out.body), { key: 'sk-nara-1' });
});

test('the longest matching key id wins', async (t) => {
  const { resolver } = await setup(t);
  const header = (value) => resolver.resolve({ url: `${NARA}/m`, headers: { A: value } }).headers.A;
  assert.strictEqual(header('venomkey:key_12'), 'sk-nara-12');
  assert.strictEqual(header('venomkey:key_1'), 'sk-nara-1');
  assert.strictEqual(header('venomkey:key_1,next'), 'sk-nara-1,next');
});

test("a key sent to another provider's host is refused", async (t) => {
  const { resolver } = await setup(t);
  const auth = { Authorization: 'Bearer venomkey:key_1' };
  assert.deepStrictEqual(resolver.resolve({ url: `${MIRAI}/models`, headers: auth }),
    { blocked: true, error: "Key blocked: api.miraiapi.com is not this key's provider" });
  assert.strictEqual(resolver.resolve({ url: 'http://router.bynara.id/v1/models', headers: auth }).blocked, true);
  assert.strictEqual(resolver.resolve({ url: 'https://router.bynara.id:8443/v1/models', headers: auth }).blocked, true);
  assert.strictEqual(resolver.resolve({ url: 'https://evil.test/?u=https://router.bynara.id', headers: auth }).blocked, true);
});

test('the Artificial Analysis key goes to artificialanalysis.ai only', async (t) => {
  const { resolver } = await setup(t);
  const ok = resolver.resolve({ url: 'https://artificialanalysis.ai/api/v2/data/llms/models', headers: { 'x-api-key': 'venomsecret:aaApiKey' } });
  assert.strictEqual(ok.headers['x-api-key'], 'aa-secret');
  assert.deepStrictEqual(resolver.resolve({ url: `${NARA}/models`, headers: { 'x-api-key': 'venomsecret:aaApiKey' } }),
    { blocked: true, error: "Key blocked: router.bynara.id is not this key's provider" });
});

test('unknown keys, locked keys and unknown secrets are refused', async (t) => {
  const { resolver } = await setup(t);
  assert.match(resolver.resolve({ url: `${NARA}/m`, headers: { A: 'venomkey:nope' } }).error, /unknown key/);
  assert.match(resolver.resolve({ url: 'https://darkapi.dev/v1/m', headers: { A: 'venomkey:key_locked' } }).error, /can't be read on this machine/);
  assert.match(resolver.resolve({ url: `${NARA}/m`, headers: { A: 'venomsecret:githubToken' } }).error, /unknown secret/);
});

test('a request without placeholders is passed through untouched', async (t) => {
  const { resolver } = await setup(t);
  const req = { url: `${NARA}/m`, headers: { A: 'plain', N: 5 }, body: { x: 1 } };
  const out = resolver.resolve(req);
  assert.strictEqual(out.headers, req.headers);
  assert.strictEqual(out.body, req.body);
  assert.strictEqual(out.url, req.url);
});

test('one refused placeholder blocks the whole request', async (t) => {
  const { resolver } = await setup(t);
  const out = resolver.resolve({ url: `${NARA}/m`, headers: { A: 'venomkey:key_1', B: 'venomkey:key_m' } });
  assert.strictEqual(out.blocked, true);
});

test('a replaced key is sent with its new value', async (t) => {
  const { store, resolver } = await setup(t);
  assert.strictEqual(resolver.resolve({ url: `${NARA}/m`, headers: { A: 'venomkey:key_1' } }).headers.A, 'sk-nara-1');
  store.repos.providers.save({ id: 'nara', name: 'NaraRouter', baseUrl: NARA, rpm: null, keys: [{ id: 'key_1', name: 'One', key: 'sk-nara-rotated', active: true }] });
  assert.strictEqual(resolver.resolve({ url: `${NARA}/m`, headers: { A: 'venomkey:key_1' } }).headers.A, 'sk-nara-rotated');
});
