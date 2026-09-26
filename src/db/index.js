// ============================================
// Local database — venom.db
// ============================================
// One SQLite file in the app data folder, opened once by the main process;
// the renderer never touches it. better-sqlite3 is synchronous, so every call
// runs on the main thread: statements stay small and each write is one short
// transaction.
//
// Nothing here loads electron. Encryption comes in as a cipher object
// (src/db/cipher.js builds the real one from safeStorage), so the whole layer
// runs under plain Node in the tests.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const MIGRATIONS = require('./migrations');

const DB_FILE = 'venom.db';
const BACKUPS_KEPT = 3;

class DbTooNewError extends Error {
  constructor(found, known) {
    super(`venom.db is at schema version ${found}; this build knows up to ${known}`);
    this.name = 'DbTooNewError';
    this.code = 'DB_TOO_NEW';
  }
}

// busy_timeout first, so the pragmas after it wait out a lock instead of
// failing. WAL with synchronous=NORMAL can lose the last commits on power loss
// but never corrupts the file.
function applyPragmas(db) {
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');
}

function latestVersion(migrations) {
  return migrations.reduce((max, m) => Math.max(max, m.version), 0);
}

// A copy of the file as it was before migrating, so a migration bug can be
// undone by hand. Only the newest BACKUPS_KEPT are kept.
async function backupBeforeMigrate(db, file, from, log) {
  const dest = `${file}.bak-v${from}`;
  await db.backup(dest);
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.bak-v`;
  fs.readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
    .map((name) => ({ name, version: Number(name.slice(prefix.length)) }))
    .sort((a, b) => b.version - a.version)
    .slice(BACKUPS_KEPT)
    .forEach(({ name }) => {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch (err) {
        log.warn(`Could not remove old backup ${name}:`, err.message);
      }
    });
  return dest;
}

// PRAGMA user_version is the schema version. Each pending migration runs in
// its own transaction together with the version bump, so a failure leaves the
// file at the last version that fully applied.
async function migrate(db, { file = null, migrations = MIGRATIONS, log = console } = {}) {
  const from = db.pragma('user_version', { simple: true });
  const to = latestVersion(migrations);
  if (from > to) throw new DbTooNewError(from, to);
  if (from === to) return { from, to, backup: null };
  const backup = from > 0 && file ? await backupBeforeMigrate(db, file, from, log) : null;
  migrations
    .filter((m) => m.version > from)
    .sort((a, b) => a.version - b.version)
    .forEach((m) => {
      db.transaction(() => {
        m.up(db);
        db.pragma(`user_version = ${m.version}`);
      })();
    });
  return { from, to, backup };
}

function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function createRepos(db, cipher, log) {
  return {
    meta: { get: (key) => getMeta(db, key), set: (key, value) => setMeta(db, key, value) },
  };
}

// Folds the WAL back into the main file, so a closed database is one file.
function close(db) {
  if (!db.open) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (_) {
    // Already failing: close anyway.
  }
  db.close();
}

// dir is the app data folder, or ':memory:' in tests. Throws on any failure
// (corrupt or locked file, newer schema); the caller shows it and quits.
async function open(dir, { cipher = null, log = console, migrations = MIGRATIONS } = {}) {
  const file = dir === ':memory:' ? ':memory:' : path.join(dir, DB_FILE);
  const db = new Database(file);
  try {
    // busy_timeout doesn't touch the file's on-disk format, but journal_mode=WAL
    // does (it rewrites header bytes 18/19 immediately, before any migration
    // runs). Read the version and refuse a newer schema before that pragma, so
    // a rejected open never leaves a write behind.
    db.pragma('busy_timeout = 5000');
    const from = db.pragma('user_version', { simple: true });
    const to = latestVersion(migrations);
    if (from > to) throw new DbTooNewError(from, to);
    applyPragmas(db);
    const migration = await migrate(db, { file: file === ':memory:' ? null : file, migrations, log });
    return { db, file, migration, repos: createRepos(db, cipher, log), close: () => close(db) };
  } catch (err) {
    try {
      db.close();
    } catch (_) {
      // Already unusable.
    }
    throw err;
  }
}

module.exports = { open, migrate, applyPragmas, close, getMeta, setMeta, DB_FILE, MIGRATIONS, DbTooNewError };
