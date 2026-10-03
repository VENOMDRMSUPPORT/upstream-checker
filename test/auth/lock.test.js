// The app lock: session, idle expiry and throttle. Pure Node — the lock takes a
// repo and a clock, so nothing here needs Electron or a real database.
const test = require('node:test');
const assert = require('node:assert');
const { createAuthLock, MAX_FAILED, THROTTLE_MS } = require('../../src/auth');
const { hashPassword, DEFAULT_PASSWORD } = require('../../src/auth/hash');
const { quietLog } = require('../helpers');

// A repo shaped like src/db/repos/auth.js with no SQLite behind it, so the clock
// and the row can be driven directly. `insert` mirrors the real one: a row that
// already exists is left alone.
function fakeRepo(realHash = null) {
  const state = { row: null };
  if (realHash) {
    // The real hash at production cost, so DEFAULT_PASSWORD genuinely verifies.
    state.row = { hash: hashPassword(DEFAULT_PASSWORD).value, is_default: 1, failed_attempts: 0, locked_until: 0 };
  }
  return {
    state,
    get: () => (state.row ? { ...state.row } : null),
    ensureDefault(hash, { now = 0, isDefault = true } = {}) {
      if (state.row) return { ...state.row };
      state.row = { hash, is_default: isDefault ? 1 : 0, failed_attempts: 0, locked_until: 0, created_at: now };
      return { ...state.row };
    },
    setHash(hash, { isDefault = false, now = 0 } = {}) {
      Object.assign(state.row, { hash, is_default: isDefault ? 1 : 0, failed_attempts: 0, locked_until: 0, changed_at: now });
      return { ...state.row };
    },
    recordFailure(n) { state.row.failed_attempts = n; return n; },
    setLockedUntil(ts) { state.row.locked_until = ts; },
    clearFailures() { state.row.failed_attempts = 0; state.row.locked_until = 0; },
    remove() { const n = state.row ? 1 : 0; state.row = null; return n; },
  };
}

// A clock the test moves by hand.
function fakeClock(start = 1_000_000) {
  const c = { t: start };
  return { now: () => c.t, advance: (ms) => { c.t += ms; return c.t; } };
}

const makeLock = (repo, clock, idleMs) => createAuthLock({ repo, log: quietLog, now: clock.now, idleMs });

test('a fresh database is locked and carries the shipped default', () => {
  const repo = fakeRepo();
  const clock = fakeClock();
  const auth = makeLock(repo, clock, 60 * 60 * 1000);
  assert.strictEqual(auth.ensureDefault().created, true);
  assert.strictEqual(auth.isLocked(), true);
  const status = auth.status();
  assert.strictEqual(status.locked, true);
  assert.strictEqual(status.isDefault, true);
  assert.strictEqual(status.hasRow, true);
  // The flag is what the UI reads; the hash itself must never be in a status.
  assert.ok(!('hash' in status), 'status must not expose the hash');
});

test('ensureDefault never overwrites a row that already exists', () => {
  const repo = fakeRepo();
  const clock = fakeClock();
  const auth = makeLock(repo, clock, 0);
  auth.ensureDefault();
  const first = repo.get().hash;
  clock.advance(10_000);
  assert.strictEqual(auth.ensureDefault().created, false);
  assert.strictEqual(repo.get().hash, first);
});

test('status with no row reads as the default rather than as unlocked', () => {
  const repo = fakeRepo();
  const clock = fakeClock();
  const auth = makeLock(repo, clock, 0);
  const status = auth.status();
  assert.strictEqual(status.locked, true);
  assert.strictEqual(status.isDefault, true);
  assert.strictEqual(status.hasRow, false);
});

test('the right password unlocks and the wrong one does not', () => {
  const repo = fakeRepo();
  const clock = fakeClock();
  const auth = makeLock(repo, clock, 0);
  auth.ensureDefault();
  assert.deepStrictEqual(auth.unlock('nope'), {
    ok: false, code: 'WRONG_PASSWORD', attemptsLeft: MAX_FAILED - 1, message: 'That is not the owner password.',
  });
  assert.strictEqual(auth.isLocked(), true);
  assert.deepStrictEqual(auth.unlock(DEFAULT_PASSWORD), { ok: true });
  assert.strictEqual(auth.isLocked(), false);
});

test('unlocking with no row is LOCK_NOT_READY, not a wrong password', () => {
  const repo = fakeRepo();
  const clock = fakeClock();
  const auth = makeLock(repo, clock, 0);
  const reply = auth.unlock(DEFAULT_PASSWORD);
  assert.strictEqual(reply.ok, false);
  assert.strictEqual(reply.code, 'LOCK_NOT_READY');
});

test('a stored hash this build cannot read is LOCK_NOT_READY, not a wrong password', () => {
  const repo = fakeRepo();
  repo.ensureDefault('scrypt$16384$8$1$c2FsdA$aGFzaA'); // well-formed shape, wrong key bytes
  const clock = fakeClock();
  const auth = makeLock(repo, clock, 0);
  repo.state.row.hash = 'not-a-hash';
  const reply = auth.unlock(DEFAULT_PASSWORD);
  assert.strictEqual(reply.code, 'LOCK_NOT_READY');
});

test(`${MAX_FAILED} failures throttle, and the next attempt is refused before any KDF runs`, () => {
  const repo = fakeRepo();
  const clock = fakeClock();
  const auth = makeLock(repo, clock, 0);
  auth.ensureDefault();
  for (let i = 1; i < MAX_FAILED; i += 1) {
    const reply = auth.unlock('nope');
    assert.strictEqual(reply.code, 'WRONG_PASSWORD', `attempt ${i}`);
    assert.strictEqual(reply.attemptsLeft, MAX_FAILED - i);
  }
  const braked = auth.unlock('nope');
  assert.strictEqual(braked.code, 'THROTTLED');
  assert.strictEqual(braked.retryAfterMs, THROTTLE_MS);
  // Refused early: even the correct password does not get through the brake.
  assert.strictEqual(auth.unlock(DEFAULT_PASSWORD).code, 'THROTTLED');
  clock.advance(THROTTLE_MS);
  assert.deepStrictEqual(auth.unlock(DEFAULT_PASSWORD), { ok: true });
});

test('the throttle survives closing and reopening the app', () => {
  const repo = fakeRepo();
  const clock = fakeClock();
  const first = makeLock(repo, clock, 0);
  first.ensureDefault();
  for (let i = 0; i < MAX_FAILED; i += 1) first.unlock('nope');
  // A new process, same row: the counter is persisted on purpose.
  const second = makeLock(repo, clock, 0);
  const reply = second.unlock(DEFAULT_PASSWORD);
  assert.strictEqual(reply.code, 'THROTTLED');
  clock.advance(THROTTLE_MS);
  assert.deepStrictEqual(second.unlock(DEFAULT_PASSWORD), { ok: true });
});

test('a successful unlock clears the failure counter', () => {
  const repo = fakeRepo();
  const clock = fakeClock();
  const auth = makeLock(repo, clock, 0);
  auth.ensureDefault();
  auth.unlock('nope');
  auth.unlock('nope');
  assert.strictEqual(repo.get().failed_attempts, 2);
  auth.unlock(DEFAULT_PASSWORD);
  assert.strictEqual(repo.get().failed_attempts, 0);
  assert.strictEqual(repo.get().locked_until, 0);
});

test('the session ends once the idle limit has passed', () => {
  const repo = fakeRepo();
  const clock = fakeClock();
  const idleMs = 60 * 60 * 1000;
  const auth = makeLock(repo, clock, idleMs);
  auth.ensureDefault();
  auth.unlock(DEFAULT_PASSWORD);
  assert.strictEqual(auth.isLocked(), false);
  clock.advance(idleMs - 1);
  assert.strictEqual(auth.isLocked(), false, 'one ms short is still open');
  clock.advance(1);
  assert.strictEqual(auth.isLocked(), true, 'the limit itself closes it');
});

test('activity moves the idle deadline back, and a locked app ignores it', () => {
  const repo = fakeRepo();
  const clock = fakeClock();
  const idleMs = 10 * 60 * 1000;
  const auth = makeLock(repo, clock, idleMs);
  auth.ensureDefault();
  auth.unlock(DEFAULT_PASSWORD);
  clock.advance(idleMs - 1000);
  auth.noteActivity();
  clock.advance(idleMs - 1000);
  assert.strictEqual(auth.isLocked(), false, 'the activity pushed the deadline out');
  clock.advance(idleMs);
  assert.strictEqual(auth.isLocked(), true);
  // Locked: activity must not sneak the session back open.
  auth.noteActivity();
  assert.strictEqual(auth.isLocked(), true);
});

test('takeExpiry reports the idle lock exactly once', () => {
  const repo = fakeRepo();
  const clock = fakeClock();
  const idleMs = 1000;
  const auth = makeLock(repo, clock, idleMs);
  auth.ensureDefault();
  auth.unlock(DEFAULT_PASSWORD);
  clock.advance(idleMs);
  assert.strictEqual(auth.isLocked(), true);
  assert.ok(auth.takeExpiry(), 'the expiry is reported');
  assert.strictEqual(auth.takeExpiry(), null, 'and only once');
});

test('an idle limit of zero means no idle lock, not an immediate one', () => {
  const repo = fakeRepo();
  const clock = fakeClock();
  const auth = makeLock(repo, clock, 0);
  auth.ensureDefault();
  auth.unlock(DEFAULT_PASSWORD);
  clock.advance(24 * 60 * 60 * 1000);
  assert.strictEqual(auth.isLocked(), false);
});

test('a nonsense idle limit falls back to no idle lock rather than sealing the app', () => {
  // A saved setting that failed to read arrives as one of these. "Seal the app
  // immediately" would be the worst possible reading of a broken value.
  for (const bad of [-1, NaN, Infinity, 'soon', null]) {
    const repo = fakeRepo();
    const clock = fakeClock();
    const auth = makeLock(repo, clock, bad);
    auth.ensureDefault();
    auth.unlock(DEFAULT_PASSWORD);
    clock.advance(10 * 60 * 60 * 1000);
    assert.strictEqual(auth.isLocked(), false, `idleMs=${String(bad)} must not lock`);
  }
});

test('omitting the idle limit gets the documented default, not no lock at all', () => {
  // undefined trips the parameter default — 60 minutes — which is different from
  // explicitly passing nonsense above. A caller that says nothing gets the
  // designed behaviour; only a caller that passes a broken value gets it ignored.
  const repo = fakeRepo();
  const clock = fakeClock();
  const auth = createAuthLock({ repo, log: quietLog, now: clock.now });
  auth.ensureDefault();
  auth.unlock(DEFAULT_PASSWORD);
  assert.strictEqual(auth.status().idleMs, 60 * 60 * 1000);
  clock.advance(60 * 60 * 1000 - 1);
  assert.strictEqual(auth.isLocked(), false);
  clock.advance(1);
  assert.strictEqual(auth.isLocked(), true);
});

test('lock now ends the session without a timer', () => {
  const repo = fakeRepo();
  const clock = fakeClock();
  const auth = makeLock(repo, clock, 0);
  auth.ensureDefault();
  auth.unlock(DEFAULT_PASSWORD);
  assert.strictEqual(auth.isLocked(), false);
  assert.deepStrictEqual(auth.lock(), { ok: true });
  assert.strictEqual(auth.isLocked(), true);
  // And the password still works afterwards.
  assert.deepStrictEqual(auth.unlock(DEFAULT_PASSWORD), { ok: true });
});

test('changing the password leaves the default behind and locks the old one out', () => {
  const repo = fakeRepo();
  const clock = fakeClock();
  const auth = makeLock(repo, clock, 0);
  auth.ensureDefault();
  auth.unlock(DEFAULT_PASSWORD);
  assert.deepStrictEqual(auth.change(DEFAULT_PASSWORD, 'a-much-better-one'), { ok: true });
  assert.strictEqual(auth.status().isDefault, false);
  // A new session on the same store: the shipped default is now just wrong.
  const after = makeLock(repo, clock, 0);
  assert.strictEqual(after.unlock(DEFAULT_PASSWORD).code, 'WRONG_PASSWORD');
  assert.deepStrictEqual(after.unlock('a-much-better-one'), { ok: true });
});

test('changing refuses a short new password or the same one, and needs the current one', () => {
  const repo = fakeRepo();
  const clock = fakeClock();
  const auth = makeLock(repo, clock, 0);
  auth.ensureDefault();
  auth.unlock(DEFAULT_PASSWORD);
  assert.strictEqual(auth.change('wrong-current', 'a-much-better-one').code, 'WRONG_PASSWORD');
  assert.strictEqual(auth.change(DEFAULT_PASSWORD, 'short').code, 'WEAK_PASSWORD');
  assert.strictEqual(auth.change(DEFAULT_PASSWORD, '').code, 'WEAK_PASSWORD');
  assert.strictEqual(auth.change(DEFAULT_PASSWORD, null).code, 'WEAK_PASSWORD');
  assert.strictEqual(auth.change(DEFAULT_PASSWORD, DEFAULT_PASSWORD).code, 'WEAK_PASSWORD');
  // None of those changed anything.
  assert.strictEqual(auth.status().isDefault, true);
  assert.deepStrictEqual(auth.unlock(DEFAULT_PASSWORD), { ok: true });
});

test('a weak change does not count against the throttle, a wrong current one does', () => {
  const repo = fakeRepo();
  const clock = fakeClock();
  const auth = makeLock(repo, clock, 0);
  auth.ensureDefault();
  auth.change(DEFAULT_PASSWORD, 'short');
  assert.strictEqual(repo.get().failed_attempts, 0, 'a policy refusal is not a failed guess');
  auth.change('wrong-current', 'a-much-better-one');
  assert.strictEqual(repo.get().failed_attempts, 1);
});

test('a changed password still leaves the app open on the session that set it', () => {
  const repo = fakeRepo();
  const clock = fakeClock();
  const auth = makeLock(repo, clock, 0);
  auth.ensureDefault();
  auth.unlock(DEFAULT_PASSWORD);
  auth.change(DEFAULT_PASSWORD, 'a-much-better-one');
  assert.strictEqual(auth.isLocked(), false, 'the owner just proved who they are');
});

test('changing while throttled is refused before the KDF runs', () => {
  const repo = fakeRepo();
  const clock = fakeClock();
  const auth = makeLock(repo, clock, 0);
  auth.ensureDefault();
  for (let i = 0; i < MAX_FAILED; i += 1) auth.unlock('nope');
  const reply = auth.change(DEFAULT_PASSWORD, 'a-much-better-one');
  assert.strictEqual(reply.code, 'THROTTLED');
  assert.strictEqual(auth.status().isDefault, true);
});
