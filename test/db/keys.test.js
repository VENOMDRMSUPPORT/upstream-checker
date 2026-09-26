const test = require('node:test');
const assert = require('node:assert');
const { createKeyResolver } = require('../../src/db/keys');
const { memoryStore, LOCKED_BLOB, fakeCipher } = require('../helpers');

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

// A non-http(s) URL's "origin" is the opaque string "null" from the platform
// parser: two of them must never be treated as the same origin, whichever
// side (the provider's base_url or the request URL) is opaque.
test('an opaque origin on either side of the comparison is refused, never matched', async (t) => {
  const store = await memoryStore(t);
  const providers = store.repos.providers;
  providers.save({ id: 'noscheme', name: 'NoScheme', baseUrl: 'localhost:8080/v1', rpm: null,
    keys: [{ id: 'key_ns', name: 'NS', key: 'sk-noscheme', active: true }] });
  providers.save({ id: 'typo', name: 'Typo', baseUrl: 'htps://router.bynara.id', rpm: null,
    keys: [{ id: 'key_typo', name: 'Typo', key: 'sk-typo', active: true }] });
  providers.save({ id: 'nara', name: 'NaraRouter', baseUrl: NARA, rpm: null,
    keys: [{ id: 'key_1', name: 'One', key: 'sk-nara-1', active: true }] });
  const resolver = createKeyResolver({ providers, secrets: store.repos.secrets });

  // Provider base_url has no recognizable scheme; request URL is also opaque.
  assert.strictEqual(resolver.resolve({ url: 'x://evil.test/k', headers: { A: 'venomkey:key_ns' } }).blocked, true);
  // Provider base_url has a typo'd scheme; request URL is a different opaque scheme.
  assert.strictEqual(resolver.resolve({ url: 'foo://evil.test/', headers: { A: 'venomkey:key_typo' } }).blocked, true);
  // Userinfo trick: host is evil.test even though the string starts with the real host.
  assert.strictEqual(resolver.resolve({ url: 'https://router.bynara.id@evil.test/', headers: { A: 'venomkey:key_1' } }).blocked, true);
  // Unparsable request URL.
  assert.strictEqual(resolver.resolve({ url: 'not a url at all', headers: { A: 'venomkey:key_ns' } }).blocked, true);
});

test('an oversized token run is refused quickly with a short error', async (t) => {
  const { resolver } = await setup(t);
  const long = 'a'.repeat(20000);
  const start = Date.now();
  const out = resolver.resolve({ url: `${NARA}/m`, headers: { A: `venomkey:${long}` } });
  const elapsed = Date.now() - start;
  assert.strictEqual(out.blocked, true);
  assert.ok(out.error.length < 200, `error should be bounded, was ${out.error.length} chars`);
  assert.ok(elapsed < 1000, `should resolve quickly, took ${elapsed}ms`);
});

test('a placeholder refused for the wrong host never reaches the cipher', async (t) => {
  const cipher = fakeCipher();
  const store = await memoryStore(t, { cipher });
  const providers = store.repos.providers;
  providers.save({ id: 'nara', name: 'NaraRouter', baseUrl: NARA, rpm: null, keys: [{ id: 'key_1', name: 'One', key: 'sk-nara-1', active: true }] });
  store.repos.secrets.save('aaApiKey', 'aa-secret');
  const resolver = createKeyResolver({ providers, secrets: store.repos.secrets });

  const before = cipher.calls.decrypt;
  const out = resolver.resolve({ url: `${MIRAI}/models`, headers: { Authorization: 'Bearer venomkey:key_1' } });
  assert.strictEqual(out.blocked, true);
  assert.strictEqual(cipher.calls.decrypt, before);

  const before2 = cipher.calls.decrypt;
  const out2 = resolver.resolve({ url: `${NARA}/models`, headers: { 'x-api-key': 'venomsecret:aaApiKey' } });
  assert.strictEqual(out2.blocked, true);
  assert.strictEqual(cipher.calls.decrypt, before2);
});
