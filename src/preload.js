const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  // Taskbar icon in the current accent: main knows the emblem by the accent's id.
  setWindowIcon: (accentId) => ipcRenderer.send('set-window-icon', accentId),

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

  // Model pool (models seen per provider + benchmark results). opts.reset is
  // sent only by the Clear and Reset buttons.
  readCatalog: () => ipcRenderer.invoke('read-catalog'),
  writeCatalog: (data, opts) => ipcRenderer.invoke('write-catalog', data, opts),
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
