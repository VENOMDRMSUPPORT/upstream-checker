// Runs the unit tests under Electron's own Node (ELECTRON_RUN_AS_NODE=1).
// better-sqlite3 is rebuilt for Electron's ABI by postinstall, so the system
// Node can't load it. Node 20 (Electron 33) has no globs in --test, so the
// test files are listed here.
//
//   npm test                          every test/**/*.test.js
//   npm test -- test/db/x.test.js     just the files given
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
// Required from plain Node, the electron package exports the binary's path.
const electron = require('electron');

const ROOT = path.join(__dirname, '..');

function findTests(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return findTests(full);
      return entry.name.endsWith('.test.js') ? [full] : [];
    })
    .sort();
}

const args = process.argv.slice(2);
const files = args.length ? args.map((f) => path.resolve(ROOT, f)) : findTests(path.join(ROOT, 'test'));
if (files.length === 0) {
  console.error('No test files found');
  process.exit(1);
}

const result = spawnSync(electron, ['--test', ...files], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
