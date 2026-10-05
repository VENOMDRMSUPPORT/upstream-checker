const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  // Taskbar icon in the current accent: main knows the emblem by the accent's id.
  setWindowIcon: (accentId) => ipcRenderer.send('set-window-icon', accentId),

  // App lock (src/auth/ipc.js). Every call RESOLVES:
  // `{ ok: true, ... }` or `{ ok: false, code, message }` — WRONG_PASSWORD,
  // THROTTLED, WEAK_PASSWORD, LOCK_NOT_READY. Test `reply.ok`, never `catch`.
  // The state itself is main's: nothing here reads the stored hash back out.
  authStatus: () => ipcRenderer.invoke('auth:status'),
  authUnlock: (candidate) => ipcRenderer.invoke('auth:unlock', candidate),
  authChange: (current, next) => ipcRenderer.invoke('auth:change', current, next),
  authLock: () => ipcRenderer.invoke('auth:lock'),
  authActivity: () => ipcRenderer.invoke('auth:activity'),
  // Main locked the app by itself. Sent, not invoked: there is nothing for the
  // window to answer. `reason` is 'expired' (the idle limit) or 'locked' (the
  // owner asked) — the screen says something different for each, and main is
  // the side that knows which happened.
  onAuthLocked: (callback) => ipcRenderer.on('auth:locked', (_, reason) => callback(reason)),

  // API requests
  apiRequest: (opts) => ipcRenderer.invoke('api-request', opts),
  // reason: hedge_lost | stop | deadline, recorded in the request log.
  cancelApiRequest: (requestId, reason) => ipcRenderer.send('cancel-api-request', requestId, reason),

  // App info
  onAppVersion: (callback) => {
    ipcRenderer.on('app-version', (_, version) => callback(version));
  },

  // Development only: main watches src/renderer and names the stylesheet that
  // changed, so the page can swap that one without reloading. Never sent from
  // a packaged build — the watcher there is not started.
  onDevReloadCss: (callback) => ipcRenderer.on('dev-reload-css', (_, file) => callback(file)),

  // Close handshake: main asks for pending saves before the window closes or
  // an update installs; the renderer answers once they are written.
  onFlushPending: (callback) => ipcRenderer.on('flush-pending', (_, token) => callback(token)),
  flushDone: (token) => ipcRenderer.send('flush-done', token),

  // Saved data (venom.db, owned by main). Each call writes one thing.
  readConfig: () => ipcRenderer.invoke('read-config'),
  databaseExplorer: (query) => ipcRenderer.invoke('database-explorer', query),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  saveSecret: (name, value) => ipcRenderer.invoke('save-secret', name, value),
  saveTestDefinition: (test) => ipcRenderer.invoke('save-test-definition', test),
  saveProvider: (provider) => ipcRenderer.invoke('save-provider', provider),
  mergeProvider: (fromId, intoId) => ipcRenderer.invoke('merge-provider', fromId, intoId),
  deleteProvider: (id) => ipcRenderer.invoke('delete-provider', id),
  // Main decrypts the key and writes the clipboard; the page never holds it.
  copyKey: (keyId) => ipcRenderer.invoke('copy-key', keyId),

  // Run history
  readHistory: () => ipcRenderer.invoke('read-history'),
  appendRun: (run, maxRuns) => ipcRenderer.invoke('append-run', run, maxRuns),
  clearHistory: () => ipcRenderer.invoke('clear-history'),

  // Catalog engine (main owns the sources, the merge and the score). Rows travel
  // as the adapter's own objects and come back scored; no key goes either way.
  //
  // The contract, which the Models-page batch is written against: these five always
  // RESOLVE. An outcome the UI must act on arrives as `{ ok: false, code, message }`
  // — INVALID_PROVIDER_PAYLOAD, NOT_FOUND, SUSPICIOUS_PROVIDER_DROP,
  // SYNC_IN_PROGRESS — because `err.code` cannot cross a rejection. Test
  // `reply && reply.ok === false`, not `catch`; only a real defect rejects.
  // catalogRead takes the connected set, because the renderer owns PROVIDERS and
  // isConnected: `{ providerIds: [...] }`. Empty or absent serves nothing.
  catalogIngest: (providerId, rows) => ipcRenderer.invoke('catalog:ingest', providerId, rows),
  catalogRead: (query) => ipcRenderer.invoke('catalog:read', query || {}),
  catalogHealth: (providerId, modelId, result) => ipcRenderer.invoke('catalog:health', providerId, modelId, result),
  catalogSources: (query) => ipcRenderer.invoke('catalog:sources', query),
  catalogFetchInfo: (providerId, modelId, rows) => ipcRenderer.invoke('catalog:fetch-info', providerId, modelId, rows),
  getDataPath: () => ipcRenderer.invoke('get-data-path'),
  openDataFolder: () => ipcRenderer.send('open-data-folder'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  readLogInfo: () => ipcRenderer.invoke('read-log-info'),
  openRequestLog: () => ipcRenderer.send('open-request-log'),
  clearRequestLog: () => ipcRenderer.invoke('clear-request-log'),

  // Request log (venom-logs.db, owned by main). Read-only except export and clear.
  logsList: (filters, cursor, limit, sort) => ipcRenderer.invoke('logs-list', filters, cursor, limit, sort),
  logsGet: (id) => ipcRenderer.invoke('logs-get', id),
  logsStats: (filters, bucket, groupBy) => ipcRenderer.invoke('logs-stats', filters, bucket, groupBy),
  logsFacets: (range) => ipcRenderer.invoke('logs-facets', range),
  logsRuns: (filters, cursor, limit) => ipcRenderer.invoke('logs-runs', filters, cursor, limit),
  logsRunSummary: (runId) => ipcRenderer.invoke('logs-run-summary', runId),
  logsExport: (filters, format) => ipcRenderer.invoke('logs-export', filters, format),
  logsInfo: () => ipcRenderer.invoke('logs-info'),
  logsClear: (opts) => ipcRenderer.invoke('logs-clear', opts),
  notifyRegression: (payload) => ipcRenderer.send('notify-regression', payload),

  // Update API
  updateAPI: {
    onUpdateChecking: (callback) => {
      ipcRenderer.on('update-checking', () => callback());
    },
    onUpdateAvailable: (callback) => {
      ipcRenderer.on('update-available', (_, info) => callback(info));
    },
    onUpdateNotAvailable: (callback) => {
      ipcRenderer.on('update-not-available', () => callback());
    },
    onUpdateError: (callback) => {
      ipcRenderer.on('update-error', (_, data) => callback(data));
    },
    onDownloadProgress: (callback) => {
      ipcRenderer.on('update-download-progress', (_, progress) => callback(progress));
    },
    onUpdateDownloaded: (callback) => {
      ipcRenderer.on('update-downloaded', (_, info) => callback(info));
    },
    downloadUpdate: () => ipcRenderer.send('download-update'),
    installUpdate: () => ipcRenderer.send('install-update'),
    checkForUpdates: () => ipcRenderer.send('check-for-updates-manual'),
  },
});
