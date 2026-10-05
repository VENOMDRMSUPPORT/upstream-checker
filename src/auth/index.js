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
const { DEFAULT_PASSWORD, hashPassword, verifyPassword, isReadable } = require('./hash');

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

  // Called once at startup, after the database is open. Hashing the default is
  // only paid when the row is actually missing — a fresh install or a reset.
  function ensureDefault() {
    if (repo.get()) return { created: false };
    const { value } = hashPassword(DEFAULT_PASSWORD);
    repo.ensureDefault(value, { now: now(), isDefault: true });
    log.info('App lock created with the shipped default password; it is unchanged until the owner replaces it.');
    return { created: true };
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
    const row = repo.get();
    if (!row) {
      return { ok: false, code: 'LOCK_NOT_READY', message: 'The app lock has no password yet. Restart VENOM Router.' };
    }
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

  // change-settings. Refuses a weak or unchanged value: the point of the row is
  // to leave the shipped default behind.
  function change(current, next) {
    const wait = throttleRemaining();
    if (wait > 0) return throttled(wait);
    const row = repo.get();
    if (!row) return { ok: false, code: 'LOCK_NOT_READY', message: 'The app lock has no password yet.' };
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
      // A missing row reads as the default, which is what it becomes on the
      // next launch — the warning should not blink off in the meantime.
      isDefault: row ? row.is_default === 1 : true,
      idleMs: idleLimit,
      hasRow: !!row,
    };
  }
  return { ensureDefault, isLocked, takeExpiry, unlock, change, lock, setIdleMs, noteActivity, status };
}

module.exports = { createAuthLock, MAX_FAILED, THROTTLE_MS, MIN_PASSWORD_LENGTH };
