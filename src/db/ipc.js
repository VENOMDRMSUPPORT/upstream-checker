// ============================================
// Data IPC — the renderer's only way to the database
// ============================================
// Each channel reads or writes one thing, so two writers no longer overwrite
// each other's sections of one big file. A handler that fails throws: the
// renderer's promise rejects and it says so. Nothing is swallowed here.
function readConfig(repos, { plaintext = false } = {}) {
  const providers = repos.providers.list();
  if (plaintext) Object.values(providers).forEach((p) => revealKeys(repos, p));
  const data = { version: 1, providers };
  const settings = repos.settings.get('settings');
  const aa = plaintext
    ? repos.secrets.reveal('aaApiKey') || ''
    : repos.secrets.has('aaApiKey') ? 'venomsecret:aaApiKey' : '';
  if (settings || aa) data.settings = { ...(settings || {}), aaApiKey: aa };
  const test = repos.settings.get('test');
  if (test) data.test = test;
  const win = repos.settings.get('window');
  if (win) data.window = win;
  return data;
}

// Until the renderer works with placeholders, it still gets each key's
// plaintext. Removed when keys stay in main.
function revealKeys(repos, provider) {
  if (!provider) return provider;
  provider.keys.forEach((k) => {
    if (!k.locked) k.key = repos.providers.revealKey(k.id) || '';
  });
  return provider;
}

function registerDataIpc({ ipcMain, repos, log = console, plaintextKeys = false }) {
  const opts = { plaintext: plaintextKeys };
  const out = (provider) => (plaintextKeys ? revealKeys(repos, provider) : provider);
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

  handle('read-config', () => readConfig(repos, opts));
  handle('save-settings', (settings) => {
    repos.settings.saveSettings(settings);
    return { success: true };
  });
  handle('save-secret', (name, value) => ({ placeholder: repos.secrets.save(name, value) ? `venomsecret:${name}` : '' }));
  handle('save-test-definition', (test) => {
    repos.settings.saveTest(test);
    return { success: true };
  });
  handle('save-provider', (provider) => out(repos.providers.save(provider)));
  handle('merge-provider', (fromId, intoId) => out(repos.providers.merge(fromId, intoId)));
  handle('delete-provider', (id) => ({ deleted: repos.providers.remove(id) }));
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
