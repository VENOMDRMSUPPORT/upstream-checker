// ============================================
// Data IPC — the renderer's only way to the database
// ============================================
// Each channel reads or writes one thing, so two writers no longer overwrite
// each other's sections of one big file. A handler that fails throws: the
// renderer's promise rejects and it says so. Nothing is swallowed here.
//
// No reply ever carries a secret: keys go out as venomkey:<id> placeholders
// with a masked hint, the OpenRouter key as venomsecret:openRouterApiKey.
const { inspectDatabase } = require('./explorer');

function readConfig(repos) {
  const data = { version: 1, providers: repos.providers.list() };
  const settings = repos.settings.get('settings');
  const or = repos.secrets.has('openRouterApiKey') ? 'venomsecret:openRouterApiKey' : '';
  if (settings || or) data.settings = { ...(settings || {}), openRouterApiKey: or };
  const test = repos.settings.get('test');
  if (test) data.test = test;
  const win = repos.settings.get('window');
  if (win) data.window = win;
  return data;
}

function registerDataIpc({ ipcMain, repos, clipboard, log = console, hooks = {}, databases = {}, auth = null }) {
  // Main-side caches that follow the saved data (the request log's body
  // setting and retention limits, its price cache). The save itself already
  // succeeded, so a hook that fails is logged, not thrown.
  const notify = (name, ...args) => {
    if (typeof hooks[name] !== 'function') return;
    try {
      hooks[name](...args);
    } catch (err) {
      log.warn(`${name} failed:`, err.message);
    }
  };

  // The lock gate. `copy-key` hands over a decrypted API key, so it is refused
  // while the app is locked — the same rule the request gate in src/main.js
  // applies to api-request. The lock screen covers the window and the shell is
  // inert, so there is no path in the UI to reach this; the check exists because
  // "no path in the UI" is not the same as "cannot happen".
  //
  // It RESOLVES a value rather than throwing, so the renderer can tell a locked
  // app apart from a real failure.
  const whenUnlocked = (fn) => (...args) => {
    if (auth && auth.isLocked()) {
      return { ok: false, code: 'LOCKED', message: 'The app is locked.' };
    }
    return fn(...args);
  };

  const handle = (channel, fn) => {
    ipcMain.handle(channel, (_event, ...args) => {
      try {
        return fn(...args);
      } catch (err) {
        log.error(`${channel} failed:`, err.message);
        throw err;
      }
    });
  };

  handle('read-config', () => readConfig(repos));
  handle('database-explorer', (query = {}) => {
    const database = query && query.database;
    if (database !== 'app' && database !== 'logs') throw new TypeError('Unknown database');
    const db = databases[database];
    if (!db || !db.open) throw new Error(`${database} database is unavailable`);
    const table = query.table == null || query.table === '' ? null : String(query.table);
    return inspectDatabase(db, database, table, query.limit, query.offset);
  });
  handle('save-settings', (settings) => {
    const merged = repos.settings.saveSettings(settings);
    notify('onSettingsSaved', merged);
    return { success: true };
  });
  handle('save-secret', (name, value) => ({ placeholder: repos.secrets.save(name, value) ? `venomsecret:${name}` : '' }));
  handle('save-test-definition', (test) => {
    repos.settings.saveTest(test);
    return { success: true };
  });
  handle('save-provider', (provider) => repos.providers.save(provider));
  handle('merge-provider', (fromId, intoId) => repos.providers.merge(fromId, intoId));
  handle('delete-provider', (id) => ({ deleted: repos.providers.remove(id) }));
  // Main writes the clipboard, so a copied key never passes through the page.
  // Gated: this is one of the two channels that hands over a secret (the other
  // is api-request in src/main.js), so it is refused while the app is locked.
  handle('copy-key', whenUnlocked((keyId) => {
    const secret = repos.providers.revealKey(keyId);
    if (secret === null) throw new Error('This key is unknown or cannot be read on this machine');
    clipboard.writeText(secret);
    return { copied: true };
  }));
  handle('read-history', () => repos.history.read());
  handle('append-run', (run, maxRuns) => repos.history.append(run, maxRuns));
  handle('clear-history', () => {
    repos.history.clear();
    return { success: true };
  });
}

module.exports = { registerDataIpc, readConfig };
