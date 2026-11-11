// ============================================
// The app lock — session, idle and throttle
// ============================================
// The authority for whether the app is open. This lives in the main process
// and nowhere else: the renderer is handed `locked: true/false` and can ask to
// be unlocked, but it never holds the state and never sees a hash.
//
// Pure Node, like src/db — it takes a repo and a clock, loads no Electron, and
// runs under `npm test`.
//
// The session is a plain in-memory boolean plus a timestamp. There is no token,
// because the renderer never presents one: it is the same window on the same
// channel, so a token would be ceremony around a variable. A restart drops both
// the flag and the timestamp, which is what "unlock at every launch" means.
const { hashPassword, verifyPassword, isReadable } = require('./hash');

// Five consecutive misses earn a brake; the counter is persisted, so closing
// and reopening the app is not a way around it.
const MAX_FAILED = 5;
const THROTTLE_MS = 30_000;
const MIN_PASSWORD_LENGTH = 8;

// An idle limit that is absent or nonsense means "no idle lock" rather than
// "lock immediately" — a settings row that failed to read must not seal the app.
function normaliseIdle(ms) {
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function createAuthLock({ repo, log = console, idleMs = 60 * 60 * 1000, now = Date.now } = {}) {
  let idleLimit = normaliseIdle(idleMs);
  let unlocked = false;
  let lastActivity = 0;
  // Set when the idle check closes the session, so the IPC layer can tell the
  // window it was locked by time rather than by the owner. Consumed once.
  let expiredSince = null;

  const wrong = (attempts) => ({
    ok: false,
    code: 'WRONG_PASSWORD',
    attemptsLeft: Math.max(0, MAX_FAILED - attempts),
    message: 'That is not the owner password.',
  });

  const throttled = (retryAfterMs) => ({
    ok: false,
    code: 'THROTTLED',
    retryAfterMs,
    message: `Too many attempts. Try again in ${Math.ceil(retryAfterMs / 1000)} s.`,
  });

  // Setup is required until the owner has created a password of their own:
  // either there is no row at all (a fresh install, or a reset), or the row is
  // a legacy one an older build wrote with its shipped default — flagged
  // is_default, and never treated as a credential anyone may unlock with.
  function setupRequired() {
    const row = repo.get();
    return !row || row.is_default === 1;
  }

  // First run (and the recovery path after a reset): the owner creates the
  // password. This is the only way a lock row comes into existence — nothing
  // is written at startup, and no build ships a password of its own. Creating
  // the password also opens the session: the person who just chose it does
  // not have to type it straight back in.
  function setup(next) {
    const row = repo.get();
    if (row && row.is_default !== 1) {
      return { ok: false, code: 'ALREADY_SET', message: 'An owner password is already set. Unlock and change it from the Profile page.' };
    }
    const value = typeof next === 'string' ? next : '';
    if (value.length < MIN_PASSWORD_LENGTH) {
      return { ok: false, code: 'WEAK_PASSWORD', message: `The password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
    }
    const { value: hash } = hashPassword(value);
    if (row) repo.setHash(hash, { isDefault: false, now: now() });
    else repo.insertRow(hash, { now: now(), isDefault: false });
    unlocked = true;
    lastActivity = now();
    log.info('Owner password created; the app lock is now the owner\'s own password.');
    return { ok: true };
  }

  // Remaining brake, in ms. Reads the row each time so a second write path (the
  // reset script) is seen without restarting.
  function throttleRemaining() {
    const row = repo.get();
    if (!row) return 0;
    return Math.max(0, Number(row.locked_until || 0) - now());
  }

  // The one question the rest of main asks. The idle check runs here rather
  // than on a timer, so there is no interval to leak and no path where a
  // suspended timer leaves the app open.
  function isLocked() {
    if (unlocked && idleLimit > 0 && now() - lastActivity >= idleLimit) {
      unlocked = false;
      expiredSince = now();
    }
    return !unlocked;
  }

  // A timestamp when the last isLocked() call closed the session by time,
  // otherwise null. Called by the IPC layer to decide whether to tell the window.
  function takeExpiry() {
    const at = expiredSince;
    expiredSince = null;
    return at;
  }

  function unlock(candidate) {
    // No password of the owner's own yet — a fresh install, a reset, or a
    // legacy row from a build that shipped a default. There is nothing to
    // verify against; the answer is the setup screen, not a wrong password,
    // and it is given before the throttle is consulted so a brake earned by
    // guessing at the old default cannot block creating a real password.
    if (setupRequired()) {
      return { ok: false, code: 'SETUP_REQUIRED', message: 'Create an owner password to continue.' };
    }
    const row = repo.get();
    // Refused before the KDF runs: a throttled guess must cost no CPU, which is
    // the whole point of the brake.
    const wait = throttleRemaining();
    if (wait > 0) return throttled(wait);
    // A string this build cannot parse is a different problem from a wrong
    // password, and the owner needs to be told the difference.
    if (!isReadable(row.hash)) {
      log.error('The app lock hash cannot be read by this build.');
      return { ok: false, code: 'LOCK_NOT_READY', message: 'This build cannot read the saved app lock. See the recovery note in the docs.' };
    }
    if (!verifyPassword(candidate, row.hash)) {
      const attempts = Number(row.failed_attempts || 0) + 1;
      repo.recordFailure(attempts);
      if (attempts >= MAX_FAILED) {
        repo.setLockedUntil(now() + THROTTLE_MS);
        return throttled(THROTTLE_MS);
      }
      return wrong(attempts);
    }
    repo.clearFailures();
    unlocked = true;
    lastActivity = now();
    return { ok: true };
  }

  // change-settings. Refuses a weak or unchanged value. While setup is still
  // required there is no current password to change from — that is setup()'s
  // path, and it is refused here so there is exactly one door into a first
  // password.
  function change(current, next) {
    if (setupRequired()) {
      return { ok: false, code: 'SETUP_REQUIRED', message: 'Create an owner password first.' };
    }
    const wait = throttleRemaining();
    if (wait > 0) return throttled(wait);
    const row = repo.get();
    if (!verifyPassword(current, row.hash)) {
      const attempts = Number(row.failed_attempts || 0) + 1;
      repo.recordFailure(attempts);
      if (attempts >= MAX_FAILED) {
        repo.setLockedUntil(now() + THROTTLE_MS);
        return throttled(THROTTLE_MS);
      }
      return wrong(attempts);
    }
    const value = typeof next === 'string' ? next : '';
    if (value.length < MIN_PASSWORD_LENGTH) {
      return { ok: false, code: 'WEAK_PASSWORD', message: `The new password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
    }
    if (value === current) {
      return { ok: false, code: 'WEAK_PASSWORD', message: 'The new password is the same as the current one.' };
    }
    const { value: hash } = hashPassword(value);
    repo.setHash(hash, { isDefault: false, now: now() });
    unlocked = true;
    lastActivity = now();
    log.info('Owner password changed.');
    return { ok: true };
  }

  // The lock now. The caller broadcasts; this only moves the state.
  function lock() {
    unlocked = false;
    expiredSince = null;
    return { ok: true };
  }

  // A changed Settings value, applied without a restart. The idle check is
  // arithmetic in isLocked(), so nothing has to be rescheduled for this to take
  // effect: the next call reads the new limit.
  function setIdleMs(ms) {
    idleLimit = normaliseIdle(ms);
    return idleLimit;
  }

  // Nothing is written — the timestamp is a variable in this process — so there
  // is no reason to throttle it here. The renderer coalesces its own sends to
  // keep a drag or a burst of keystrokes from being one IPC call each.
  function noteActivity() {
    if (unlocked) lastActivity = now();
    return { ok: true, locked: !unlocked };
  }

  function status() {
    const row = repo.get();
    return {
      locked: isLocked(),
      // True on a fresh install, after a reset, and for a legacy row an older
      // build wrote with its shipped default. The lock screen reads this to
      // show the create-password form instead of a login.
      setupRequired: !row || row.is_default === 1,
      idleMs: idleLimit,
      hasRow: !!row,
    };
  }
  return { setup, setupRequired, isLocked, takeExpiry, unlock, change, lock, setIdleMs, noteActivity, status };
}

module.exports = { createAuthLock, MAX_FAILED, THROTTLE_MS, MIN_PASSWORD_LENGTH };
