// Where the app keeps its data. Electron names the userData folder after the
// package, and the package was renamed from upstream-checker to venom-router, so
// without this the app would open empty — and the encrypted API keys would stop
// decrypting, because safeStorage's master key lives in `Local State` inside
// that folder. The old folder is moved over whole, once. DPAPI ties that key to
// the Windows user, not to the path, so the keys survive the move.
const path = require('path');

const LEGACY_DIR = 'upstream-checker';
const CURRENT_DIR = 'venom-router';

function resolveUserDataDir(appData, fsLike) {
  const target = path.join(appData, CURRENT_DIR);
  const legacy = path.join(appData, LEGACY_DIR);
  if (fsLike.existsSync(target) || !fsLike.existsSync(legacy)) return { dir: target, migrated: false };
  try {
    fsLike.renameSync(legacy, target);
    return { dir: target, migrated: true };
  } catch (error) {
    // Held open — usually an older version still running. Keep using it; the
    // move is tried again on the next launch.
    return { dir: legacy, migrated: false, error };
  }
}

module.exports = { resolveUserDataDir, LEGACY_DIR, CURRENT_DIR };
