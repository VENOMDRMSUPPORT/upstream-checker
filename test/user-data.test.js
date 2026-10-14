const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { resolveUserDataDir, DEV_DIR, CURRENT_DIR, LEGACY_DIR } = require('../src/user-data');

const APP = 'C:\\Users\\u\\AppData\\Roaming';
const LEGACY = path.join(APP, 'upstream-checker');
const TARGET = path.join(APP, 'venom-router');
const DEV_TARGET = path.join(APP, 'venom-router-dev');

function fakeFs(existing, { renameThrows = false } = {}) {
  const set = new Set(existing);
  const calls = [];
  return {
    calls,
    existsSync: (p) => set.has(p),
    renameSync: (from, to) => {
      calls.push([from, to]);
      if (renameThrows) { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; }
      set.delete(from); set.add(to);
    },
  };
}

test('fresh install uses the new folder and renames nothing', () => {
  const fs = fakeFs([]);
  assert.deepStrictEqual(resolveUserDataDir(APP, fs), { dir: TARGET, migrated: false });
  assert.strictEqual(fs.calls.length, 0);
});

test('legacy only is moved to the new folder', () => {
  const fs = fakeFs([LEGACY]);
  assert.deepStrictEqual(resolveUserDataDir(APP, fs), { dir: TARGET, migrated: true });
  assert.deepStrictEqual(fs.calls, [[LEGACY, TARGET]]);
});

test('both exist: the new folder wins and legacy is untouched', () => {
  const fs = fakeFs([LEGACY, TARGET]);
  assert.deepStrictEqual(resolveUserDataDir(APP, fs), { dir: TARGET, migrated: false });
  assert.strictEqual(fs.calls.length, 0);
});

test('two first launches racing: the loser follows the folder the winner moved', () => {
  const set = new Set([LEGACY]);
  const fs = {
    existsSync: (p) => set.has(p),
    // The other instance renamed it between our existsSync and renameSync.
    renameSync: () => {
      set.delete(LEGACY); set.add(TARGET);
      const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
    },
  };
  assert.deepStrictEqual(resolveUserDataDir(APP, fs), { dir: TARGET, migrated: false });
});

test('locked legacy (old version running) keeps using the legacy folder', () => {
  const fs = fakeFs([LEGACY], { renameThrows: true });
  const r = resolveUserDataDir(APP, fs);
  assert.strictEqual(r.dir, LEGACY);
  assert.strictEqual(r.migrated, false);
  assert.strictEqual(r.error.code, 'EBUSY');
});

test('folder names: dev, packaged and legacy constants', () => {
  assert.strictEqual(DEV_DIR, 'venom-router-dev');
  assert.strictEqual(CURRENT_DIR, 'venom-router');
  assert.strictEqual(LEGACY_DIR, 'upstream-checker');
});

test('unpackaged (dev) resolves the dev folder and never migrates', () => {
  // Even when the legacy folder exists, dev starts empty in its own folder
  // and never touches the real one.
  const fs = fakeFs([LEGACY]);
  assert.deepStrictEqual(resolveUserDataDir(APP, fs, false), { dir: DEV_TARGET, migrated: false });
  assert.strictEqual(fs.calls.length, 0);
});

test('unpackaged (dev) resolves the dev folder when nothing exists', () => {
  const fs = fakeFs([]);
  assert.deepStrictEqual(resolveUserDataDir(APP, fs, false), { dir: DEV_TARGET, migrated: false });
  assert.strictEqual(fs.calls.length, 0);
});

test('unpackaged (dev) resolves the dev folder even when the real folder exists', () => {
  // Dev and installed must never share venom.db.
  const fs = fakeFs([TARGET]);
  assert.deepStrictEqual(resolveUserDataDir(APP, fs, false), { dir: DEV_TARGET, migrated: false });
  assert.strictEqual(fs.calls.length, 0);
});

test('packaged resolves the real folder and keeps the legacy migration', () => {
  const fresh = fakeFs([]);
  assert.deepStrictEqual(resolveUserDataDir(APP, fresh, true), { dir: TARGET, migrated: false });
  const legacyOnly = fakeFs([LEGACY]);
  assert.deepStrictEqual(resolveUserDataDir(APP, legacyOnly, true), { dir: TARGET, migrated: true });
  assert.deepStrictEqual(legacyOnly.calls, [[LEGACY, TARGET]]);
});
