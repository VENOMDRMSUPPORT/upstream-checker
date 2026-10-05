// Deletes the app lock row, nothing else.
//
//   npm run reset:lock -- "<data folder>"
//
// The folder is an explicit argument with NO default. A bare run must never be
// able to reach the owner's real %APPDATA%\venom-router by accident, so this
// script refuses to guess instead of picking the most likely path.
//
// This is the documented way back in after a forgotten password, and it is not
// a back door: it needs filesystem access to the data folder, which already
// implies the ability to do anything to this app. What it does NOT do is touch
// a single row outside app_lock — providers, keys, history, settings and the
// request log are left exactly as they are, and the command says so before it
// runs.
//
// It runs under Electron, not plain Node, because the SQLite module it opens is
// the one built for Electron's ABI (the same reason scripts/keystore-check.js
// does).
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const REQUIRED = 'venom.db';

// A sentinel, not a real error: `fail()` has already printed the reason, and
// this exists only to stop the code below it from running. `app.exit()` is not
// guaranteed to unwind the current tick, and continuing past a refusal is how a
// command that "changed nothing" ends up changing something.
class Refused extends Error {}

function fail(message) {
  console.error(`\n${message}\n`);
  throw new Refused(message);
}

function usage() {
  fail([
    'Nothing was changed.',
    '',
    'Usage:  npm run reset:lock -- "<data folder>"',
    '',
    'The folder is the one VENOM Router shows in Settings → Data folder,',
    'usually  %APPDATA%\\venom-router',
    '',
    'No default is used on purpose: this command must never be able to reach',
    'that folder because a path was left out.',
  ].join('\n'));
}

app.whenReady().then(() => {
  const args = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-'));
  const target = args[0];
  if (!target) usage();

  const dir = path.resolve(target);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    fail(`Nothing was changed.\n\nNot a folder:\n  ${dir}`);
  }
  const dbFile = path.join(dir, REQUIRED);
  if (!fs.existsSync(dbFile)) {
    fail([
      `Nothing was changed.`,
      '',
      `There is no ${REQUIRED} in:`,
      `  ${dir}`,
      '',
      'Point this at the folder that holds the database — Settings → Data folder.',
    ].join('\n'));
  }
  const size = fs.statSync(dbFile).size;

  console.log('\nVENOM Router — reset the app lock\n');
  console.log(`  data folder   ${dir}`);
  console.log(`  database      ${REQUIRED}  (${size} bytes)`);
  console.log('\n  This deletes the saved owner password and nothing else.');
  console.log('  Providers, API keys, history, settings and the request log are not touched.');
  console.log('  The next launch starts with the shipped default password.\n');

  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (err) {
    fail(`Nothing was changed.\n\nCould not load the SQLite module: ${err.message}`);
  }

  let db;
  try {
    db = new Database(dbFile);
  } catch (err) {
    fail(`Nothing was changed.\n\nThe database could not be opened: ${err.message}`);
  }

  // A database older than schema v4 has no table to delete from, and creating it
  // by hand here would leave a file the app then has to migrate. This is checked
  // outside the write so a refusal and a failure are not the same path.
  const hasTable = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'app_lock'").get().n;
  if (!hasTable) {
    db.close();
    fail([
      'Nothing was changed.',
      '',
      'This database has no app_lock table, so it has no saved password.',
      'Start VENOM Router once so it can migrate, then run this again.',
    ].join('\n'));
  }

  try {
    const removed = db.prepare('DELETE FROM app_lock WHERE id = 1').run().changes;
    db.close();
    if (removed === 0) {
      console.log('  There was no saved password — the default already applies.');
    } else {
      console.log('  Removed 1 row from app_lock.');
    }
    console.log('\n  Done. Start VENOM Router and log in with 123456.\n');
    app.exit(0);
  } catch (err) {
    try { db.close(); } catch (_) { /* dying anyway */ }
    console.error(`\nNothing was changed.\n\n${err.message}\n`);
    app.exit(1);
  }
}).catch((err) => {
  // `fail()` printed the reason already; anything else is a bug worth seeing.
  if (!(err instanceof Refused)) console.error('\nreset-lock failed:\n', err);
  app.exit(1);
});
