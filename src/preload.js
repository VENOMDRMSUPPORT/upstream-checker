const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),

  // API requests
  apiRequest: (opts) => ipcRenderer.invoke('api-request', opts),
  cancelApiRequest: (requestId) => ipcRenderer.send('cancel-api-request', requestId),

  // App info
  onAppVersion: (callback) => {
    ipcRenderer.on('app-version', (_, version) => callback(version));
  },

  // Config file operations
  readConfig: () => ipcRenderer.invoke('read-config'),
  writeConfig: (data) => ipcRenderer.invoke('write-config', data),

  // Run history
  readHistory: () => ipcRenderer.invoke('read-history'),
  appendRun: (run, maxRuns) => ipcRenderer.invoke('append-run', run, maxRuns),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  getDataPath: () => ipcRenderer.invoke('get-data-path'),
  openDataFolder: () => ipcRenderer.send('open-data-folder'),
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
