// ============================================
// Request log — venom-logs.db
// ============================================
// Every outbound request the app makes, one row each, in its own file next to
// venom.db and on its own connection. Not critical data: nothing is backed up
// before a migration, and a file that can't be opened turns logging off for
// the session (tryOpen) instead of stopping the app.
//
// Nothing here loads electron, so the layer runs under plain Node in tests.
const path = require('path');
const Database = require('better-sqlite3');
const MIGRATIONS = require('./migrations');
const { createWriter } = require('./writer');
const { createQuery, createMeta } = require('./query');

const LOGS_FILE = 'venom-logs.db';

class LogsTooNewError extends Error {
  constructor(found, known) {
    super(`venom-logs.db is at schema version ${found}; this build knows up to ${known}`);
    this.name = 'LogsTooNewError';
    this.code = 'LOGS_DB_TOO_NEW';
  }
}

function latestVersion(migrations) {
  return migrations.reduce((max, m) => Math.max(max, m.version), 0);
}

// Each pending migration runs in its own transaction with its version bump,
// so a failure leaves the file at the last version that fully applied.
function migrate(db, migrations = MIGRATIONS) {
  const from = db.pragma('user_version', { simple: true });
  const to = latestVersion(migrations);
  if (from > to) throw new LogsTooNewError(from, to);
  migrations
    .filter((m) => m.version > from)
    .sort((a, b) => a.version - b.version)
    .forEach((m) => {
      db.transaction(() => {
        m.up(db);
        db.pragma(`user_version = ${m.version}`);
      })();
    });
  return { from, to };
}

// dir is the app data folder, or ':memory:' in tests. Throws on any failure.
function open(dir, { log = console, migrations = MIGRATIONS, writerOptions = {} } = {}) {
  const file = dir === ':memory:' ? ':memory:' : path.join(dir, LOGS_FILE);
  const db = new Database(file);
  try {
    // The version is read before any pragma that writes (journal_mode=WAL
    // rewrites the header at once), so a newer schema is refused untouched.
    db.pragma('busy_timeout = 5000');
    const found = db.pragma('user_version', { simple: true });
    const known = latestVersion(migrations);
    if (found > known) throw new LogsTooNewError(found, known);
    // auto_vacuum can only be chosen before the first table exists.
    // INCREMENTAL lets the purge hand pages back a few thousand at a time.
    if (db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get().n === 0) db.pragma('auto_vacuum = INCREMENTAL');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('temp_store = MEMORY');
    const migration = migrate(db, migrations);
    const meta = createMeta(db);
    const writer = createWriter(db, { log, initialDropped: Number(meta.get('dropped_rows')) || 0, ...writerOptions });
    const query = createQuery(db, { file, meta, droppedRows: () => writer.droppedRows() });
    let closed = false;
    // Flush timer, synchronous flush, then the file (the spec's will-quit order).
    function close() {
      if (closed) return;
      closed = true;
      writer.stop();
      writer.flush();
      if (!db.open) return;
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
      } catch (_) {
        // Already failing: close anyway.
      }
      db.close();
    }
    return { db, file, migration, writer, repos: { meta, query }, close };
  } catch (err) {
    try {
      db.close();
    } catch (_) {
      // Already unusable.
    }
    throw err;
  }
}

// open() that never throws: the caller turns logging off with the error.
function tryOpen(dir, options = {}) {
  try {
    return { logs: open(dir, options), error: null };
  } catch (err) {
    return { logs: null, error: err };
  }
}

module.exports = { open, tryOpen, migrate, LOGS_FILE, MIGRATIONS, LogsTooNewError };
