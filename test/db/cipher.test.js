const test = require('node:test');
const assert = require('node:assert');
const { createCipher, revealCached, isEnvelope, ENC_PREFIX } = require('../../src/db/cipher');
const { fakeSafeStorage, LOCKED_BLOB } = require('../helpers');

test('encrypt wraps in the enc:v1: envelope and decrypt opens it', () => {
  const cipher = createCipher(fakeSafeStorage());
  const value = cipher.encrypt('sk-secret-1');
  assert.ok(value.startsWith(ENC_PREFIX));
  assert.ok(!value.includes('sk-secret-1'));
  assert.strictEqual(cipher.decrypt(value), 'sk-secret-1');
});

test('encrypt refuses when OS encryption is unavailable (never plaintext)', () => {
  const cipher = createCipher(fakeSafeStorage({ available: false }));
  assert.strictEqual(cipher.available(), false);
  assert.throws(() => cipher.encrypt('sk-secret-1'), /unavailable/);
});

test('encrypt refuses an empty value', () => {
  const cipher = createCipher(fakeSafeStorage());
  assert.throws(() => cipher.encrypt(''), /Nothing to encrypt/);
});

test('decrypt refuses a value without the envelope', () => {
  const cipher = createCipher(fakeSafeStorage());
  assert.throws(() => cipher.decrypt('sk-plain'), /enc:v1:/);
});

test('decrypt of a value encrypted elsewhere throws', () => {
  const cipher = createCipher(fakeSafeStorage());
  assert.throws(() => cipher.decrypt(LOCKED_BLOB));
});

test('isEnvelope needs the prefix and a payload', () => {
  assert.strictEqual(isEnvelope('enc:v1:abc'), true);
  assert.strictEqual(isEnvelope('enc:v1:'), false);
  assert.strictEqual(isEnvelope('sk-abc'), false);
  assert.strictEqual(isEnvelope(null), false);
});

test('revealCached decrypts once and remembers a locked value as null', () => {
  const cipher = createCipher(fakeSafeStorage());
  let decrypts = 0;
  const counting = { ...cipher, decrypt: (v) => { decrypts += 1; return cipher.decrypt(v); } };
  const cache = new Map();
  const good = cipher.encrypt('abc');
  assert.strictEqual(revealCached(counting, cache, 'key:a', good), 'abc');
  assert.strictEqual(revealCached(counting, cache, 'key:a', good), 'abc');
  assert.strictEqual(revealCached(counting, cache, 'key:b', LOCKED_BLOB), null);
  assert.strictEqual(revealCached(counting, cache, 'key:b', LOCKED_BLOB), null);
  assert.strictEqual(decrypts, 2);
});
