// ============================================
// The app lock row — app_lock
// ============================================
// One row, held by the schema (CHECK (id = 1)). This file owns the SQL and
// nothing else: how many failures earn a brake, how long the brake lasts and
// what the idle limit is all live in src/auth/index.js, so the policy can
// change without touching the table.
//
// No row means no password has been created yet. That is the state of a fresh
// database and of a database the recovery script has just reset, and both
// should behave the same way — the create-password screen — so `get()`
// returning null is a normal answer rather than an error. A row flagged
// is_default is a legacy row written by an older build's shipped default; the
// auth layer treats it exactly like no row until the owner replaces it.
//
// The hash is deliberately NOT wrapped in the enc:v1: DPAPI envelope the
// provider keys use. Losing an account key is recoverable (the UI says "locked
// key"); losing the lock hash is not — if the OS keystore were unavailable the
// app would be unopenable with no way back. A salted scrypt hash is the
// standard on-disk form for a password and is safe to leave readable.
function createAuthRepo(db) {
  // Prepared on first use rather than at assembly. The table arrives with
  // migration v4, and `open()` assembles the repos before it knows which
  // migrations will run — the migration-sequence tests open a file against a
  // truncated list on purpose, and assembling the repos must not be what fails
  // there. better-sqlite3 prepares eagerly and throws on a missing table, so the
  // statement is what has to wait.
  const prepared = new Map();
  const sql = (key, text) => {
    if (!prepared.has(key)) prepared.set(key, db.prepare(text));
    return prepared.get(key);
  };

  const get = () => sql('get', 'SELECT * FROM app_lock WHERE id = 1').get() || null;

  // The one insert path, called only from the auth layer's setup() when the
  // owner creates the first password. Nothing calls this at startup: a launch
  // writes no lock row, so a fresh database legitimately has none. An
  // existing row is returned untouched — replacing a password is setHash().
  function insertRow(hashValue, { now = Date.now(), isDefault = false } = {}) {
    const existing = get();
    if (existing) return existing;
    sql('insert', `INSERT INTO app_lock (id, hash, is_default, failed_attempts, locked_until, changed_at, created_at)
      VALUES (1, ?, ?, 0, 0, ?, ?)`).run(hashValue, isDefault ? 1 : 0, isDefault ? null : now, now);
    return get();
  }

  // change: a new password. The failure counters are cleared with it, because
  // the owner has just proved they know the current one.
  function setHash(hashValue, { isDefault = false, now = Date.now() } = {}) {
    const result = sql('setHash', `UPDATE app_lock
      SET hash = ?, is_default = ?, failed_attempts = 0, locked_until = 0, changed_at = ?
      WHERE id = 1`).run(hashValue, isDefault ? 1 : 0, now);
    if (result.changes === 0) throw new Error('No app_lock row to change');
    return get();
  }

  // Persisted on purpose: a lockout that a restart could clear would be no
  // brake at all.
  function recordFailure(count) {
    sql('failures', 'UPDATE app_lock SET failed_attempts = ? WHERE id = 1').run(count);
    return count;
  }

  function setLockedUntil(timestamp) {
    sql('lockedUntil', 'UPDATE app_lock SET locked_until = ? WHERE id = 1').run(timestamp);
  }

  function clearFailures() {
    sql('clearFailures', 'UPDATE app_lock SET failed_attempts = 0, locked_until = 0 WHERE id = 1').run();
  }

  // reset-lock only. The caller deletes one row; nothing else in the file moves.
  function remove() {
    return sql('remove', 'DELETE FROM app_lock WHERE id = 1').run().changes;
  }

  return { get, insertRow, setHash, recordFailure, setLockedUntil, clearFailures, remove };
}

module.exports = { createAuthRepo };
