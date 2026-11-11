// The owner password: scrypt hash and verify. Pure Node, no Electron.
const test = require('node:test');
const assert = require('node:assert');
const { hashPassword, verifyPassword, isReadable } = require('../../src/auth/hash');

// Any password stands in for the owner's: the subject of this file is the hash
// format, not the value. There is no shipped default left to round-trip.
const SAMPLE = 'an-owner-password';

// N=16384 costs ~50-70 ms per derivation, and these tests derive several times.
// Everything uses one shared hash where a fresh one is not the point.
const fast = { params: { N: 1024, r: 8, p: 1 } };

test('a password round-trips', () => {
  const { value } = hashPassword(SAMPLE, fast);
  assert.strictEqual(verifyPassword(SAMPLE, value), true);
});

test('a password is not stored in a comparable form', () => {
  const { value } = hashPassword(SAMPLE, fast);
  assert.ok(!value.includes(SAMPLE), 'the password must not appear in the stored string');
  assert.ok(value.startsWith('scrypt$'), 'the algorithm and its parameters are written into the string');
});

test('a wrong password is refused', () => {
  const { value } = hashPassword(SAMPLE, fast);
  for (const attempt of ['', 'an-owner-passwore', 'an-owner-password ', ' an-owner-password', 'x']) {
    assert.strictEqual(verifyPassword(attempt, value), false, `"${attempt}" must not unlock`);
  }
});

test('two hashes of the same password differ (fresh salt each time)', () => {
  const a = hashPassword(SAMPLE, fast).value;
  const b = hashPassword(SAMPLE, fast).value;
  assert.notStrictEqual(a, b);
  assert.strictEqual(verifyPassword(SAMPLE, a), true);
  assert.strictEqual(verifyPassword(SAMPLE, b), true);
});

test('a string with its own parameters still verifies after the cost is raised', () => {
  // The point of writing the parameters into the string: an old hash keeps
  // working when DEFAULT_PARAMS changes with a later build.
  const old = hashPassword('an-old-password', { params: { N: 1024, r: 8, p: 1 } }).value;
  const fresh = hashPassword('a-new-password').value;
  assert.strictEqual(verifyPassword('an-old-password', old), true);
  assert.strictEqual(verifyPassword('a-new-password', fresh), true);
  assert.ok(fresh.startsWith('scrypt$16384$8$1$'), 'current cost is N=16384');
  assert.ok(old.startsWith('scrypt$1024$8$1$'), 'the old string kept N=1024');
});

test('malformed strings return false rather than throwing', () => {
  const cases = [
    undefined, null, 42, {}, [], '',
    'scrypt$16384$8$1$onlyfive',
    'scrypt$16384$8$1$c2FsdA$',            // no hash
    'scrypt$16384$8$1$$aGFzaA',            // no salt
    'bcrypt$16384$8$1$c2FsdA$aGFzaA',      // another algorithm
    'scrypt$abc$8$1$c2FsdA$aGFzaA',        // non-numeric cost
    'scrypt$0$8$1$c2FsdA$aGFzaA',          // zero cost
    'scrypt$99999999$8$1$c2FsdA$aGFzaA',   // a cost this build refuses to run
    'not-a-hash-at-all',
  ];
  for (const stored of cases) {
    assert.strictEqual(verifyPassword('anything', stored), false, `${JSON.stringify(stored)} must be refused, not thrown`);
  }
});

test('isReadable tells a wrong password apart from an unreadable lock', () => {
  const { value } = hashPassword(SAMPLE, fast);
  assert.strictEqual(isReadable(value), true);
  assert.strictEqual(isReadable('garbage'), false);
  // The verify still says false either way — the caller uses isReadable to pick
  // which message the owner sees.
  assert.strictEqual(verifyPassword(SAMPLE, 'garbage'), false);
});

test('hashing nothing is a programming error, not a silent empty hash', () => {
  assert.throws(() => hashPassword(''), /Nothing to hash/);
  assert.throws(() => hashPassword(null), /Nothing to hash/);
});

test('an empty candidate never verifies, whatever is stored', () => {
  const { value } = hashPassword('   ', fast); // whitespace is a legal password
  assert.strictEqual(verifyPassword('   ', value), true);
  assert.strictEqual(verifyPassword('', value), false);
});
