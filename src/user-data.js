// Where the app keeps its data. Electron names the userData folder after the
// package, and the package was renamed from upstream-checker to venom-router, so
// without this the app would open empty — and the encrypted API keys would stop
// decrypting, because safeStorage's master key lives in `Local State` inside
// that folder. The old folder is moved over whole, once. DPAPI ties that key to
// the Windows user, not to the path, so the keys survive the move.
//
// Unpackaged runs (`npm start`, app.isPackaged=false) use `venom-router-dev`
// so dev and the installed app never share venom.db. Packaged runs keep
// `venom-router`. An explicit --user-data-dir (see src/main.js) still wins
// over both.
const path = require('path');

const LEGACY_DIR = 'upstream-checker';
const CURRENT_DIR = 'venom-router';
const DEV_DIR = 'venom-router-dev';

function resolveUserDataDir(appData, fsLike, isPackaged = true) {
  // Dev never migrates or touches the real folder: it starts empty in its
  // own folder. Secrets saved in the real folder read as locked here until
  // re-entered, because the DPAPI master key lives in that folder's
  // `Local State`.
  if (!isPackaged) return { dir: path.join(appData, DEV_DIR), migrated: false };
  const target = path.join(appData, CURRENT_DIR);
  const legacy = path.join(appData, LEGACY_DIR);
  if (fsLike.existsSync(target) || !fsLike.existsSync(legacy)) return { dir: target, migrated: false };
  try {
    fsLike.renameSync(legacy, target);
    return { dir: target, migrated: true };
  } catch (error) {
    // A second instance launched at the same moment may have moved it first.
    if (fsLike.existsSync(target)) return { dir: target, migrated: false };
    // Held open — usually an older version still running. Keep using it; the
    // move is tried again on the next launch.
    return { dir: legacy, migrated: false, error };
  }
}

module.exports = { resolveUserDataDir, LEGACY_DIR, CURRENT_DIR, DEV_DIR };
