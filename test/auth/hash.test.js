// The owner password: scrypt hash and verify. Pure Node, no Electron.
const test = require('node:test');
const assert = require('node:assert');
const { DEFAULT_PASSWORD, hashPassword, verifyPassword, isReadable } = require('../../src/auth/hash');

// N=16384 costs ~50-70 ms per derivation, and these tests derive several times.
// Everything uses one shared hash where a fresh one is not the point.
const fast = { params: { N: 1024, r: 8, p: 1 } };

test('the shipped default round-trips', () => {
  const { value } = hashPassword(DEFAULT_PASSWORD, fast);
  assert.strictEqual(verifyPassword(DEFAULT_PASSWORD, value), true);
});

test('the shipped default is not stored in a comparable form', () => {
  const { value } = hashPassword(DEFAULT_PASSWORD, fast);
  assert.ok(!value.includes(DEFAULT_PASSWORD), 'the password must not appear in the stored string');
  assert.ok(value.startsWith('scrypt$'), 'the algorithm and its parameters are written into the string');
});

test('a wrong password is refused', () => {
  const { value } = hashPassword(DEFAULT_PASSWORD, fast);
  for (const attempt of ['', '123457', '123456 ', ' 123456', 'x']) {
    assert.strictEqual(verifyPassword(attempt, value), false, `"${attempt}" must not unlock`);
  }
});

test('two hashes of the same password differ (fresh salt each time)', () => {
  const a = hashPassword(DEFAULT_PASSWORD, fast).value;
  const b = hashPassword(DEFAULT_PASSWORD, fast).value;
  assert.notStrictEqual(a, b);
  assert.strictEqual(verifyPassword(DEFAULT_PASSWORD, a), true);
  assert.strictEqual(verifyPassword(DEFAULT_PASSWORD, b), true);
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
  const { value } = hashPassword(DEFAULT_PASSWORD, fast);
  assert.strictEqual(isReadable(value), true);
  assert.strictEqual(isReadable('garbage'), false);
  // The verify still says false either way — the caller uses isReadable to pick
  // which message the owner sees.
  assert.strictEqual(verifyPassword(DEFAULT_PASSWORD, 'garbage'), false);
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
