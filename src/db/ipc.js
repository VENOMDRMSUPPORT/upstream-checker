// ============================================
// Data IPC — the renderer's only way to the database
// ============================================
// Each channel reads or writes one thing, so two writers no longer overwrite
// each other's sections of one big file. A handler that fails throws: the
// renderer's promise rejects and it says so. Nothing is swallowed here.
//
// No reply ever carries a secret: keys go out as venomkey:<id> placeholders
// with a masked hint, the Artificial Analysis key as venomsecret:aaApiKey.
function readConfig(repos) {
  const data = { version: 1, providers: repos.providers.list() };
  const settings = repos.settings.get('settings');
  const aa = repos.secrets.has('aaApiKey') ? 'venomsecret:aaApiKey' : '';
  if (settings || aa) data.settings = { ...(settings || {}), aaApiKey: aa };
  const test = repos.settings.get('test');
  if (test) data.test = test;
  const win = repos.settings.get('window');
  if (win) data.window = win;
  return data;
}

function registerDataIpc({ ipcMain, repos, clipboard, log = console }) {
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
  handle('save-settings', (settings) => {
    repos.settings.saveSettings(settings);
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
  handle('copy-key', (keyId) => {
    const secret = repos.providers.revealKey(keyId);
    if (secret === null) throw new Error('This key is unknown or cannot be read on this machine');
    clipboard.writeText(secret);
    return { copied: true };
  });
  handle('read-catalog', () => repos.catalog.read());
  handle('write-catalog', (catalog, writeOpts) => repos.catalog.write(catalog, { reset: !!writeOpts && writeOpts.reset === true }));
  handle('read-history', () => repos.history.read());
  handle('append-run', (run, maxRuns) => repos.history.append(run, maxRuns));
  handle('clear-history', () => {
    repos.history.clear();
    return { success: true };
  });
}

module.exports = { registerDataIpc, readConfig };
