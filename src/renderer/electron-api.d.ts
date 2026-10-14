// ============================================
// Renderer globals — types only, no runtime code
// ============================================
// Classic scripts share one global scope (see ARCHITECTURE.md section 7) and
// preload injects window.electronAPI via contextBridge. Without this file the
// editor reports TS2568 hints on every window.electronAPI use. Strict enough
// to catch a typo in a channel name, loose enough to never fight the runtime.
interface ElectronAPI {
  minimize: (...args: any[]) => any;
  maximize: (...args: any[]) => any;
  close: (...args: any[]) => any;
  setWindowIcon: (...args: any[]) => any;
  authStatus: (...args: any[]) => any;
  authUnlock: (...args: any[]) => any;
  authChange: (...args: any[]) => any;
  authLock: (...args: any[]) => any;
  authActivity: (...args: any[]) => any;
  onAuthLocked: (...args: any[]) => any;
  apiRequest: (...args: any[]) => any;
  cancelApiRequest: (...args: any[]) => any;
  onAppVersion: (...args: any[]) => any;
  onDevReloadCss: (...args: any[]) => any;
  onFlushPending: (...args: any[]) => any;
  flushDone: (...args: any[]) => any;
  readConfig: (...args: any[]) => any;
  databaseExplorer: (...args: any[]) => any;
  saveSettings: (...args: any[]) => any;
  saveSecret: (...args: any[]) => any;
  saveTestDefinition: (...args: any[]) => any;
  saveProvider: (...args: any[]) => any;
  mergeProvider: (...args: any[]) => any;
  deleteProvider: (...args: any[]) => any;
  copyKey: (...args: any[]) => any;
  readHistory: (...args: any[]) => any;
  appendRun: (...args: any[]) => any;
  clearHistory: (...args: any[]) => any;
  catalogIngest: (...args: any[]) => any;
  catalogRead: (...args: any[]) => any;
  catalogHealth: (...args: any[]) => any;
  catalogSources: (...args: any[]) => any;
  catalogFetchInfo: (...args: any[]) => any;
  catalogEvents: (...args: any[]) => any;
  catalogEventsRead: (...args: any[]) => any;
  getDataPath: (...args: any[]) => any;
  openDataFolder: (...args: any[]) => any;
  openExternal: (...args: any[]) => any;
  readLogInfo: (...args: any[]) => any;
  openRequestLog: (...args: any[]) => any;
  clearRequestLog: (...args: any[]) => any;
  logsList: (...args: any[]) => any;
  logsGet: (...args: any[]) => any;
  logsStats: (...args: any[]) => any;
  logsFacets: (...args: any[]) => any;
  logsRuns: (...args: any[]) => any;
  logsRunSummary: (...args: any[]) => any;
  logsExport: (...args: any[]) => any;
  logsInfo: (...args: any[]) => any;
  logsClear: (...args: any[]) => any;
  notifyRegression: (...args: any[]) => any;
  updateAPI: { [key: string]: (...args: any[]) => any };
}

interface Window {
  electronAPI: ElectronAPI;
  INTEGRATED_PROVIDERS?: any;
  CATALOG?: any;
  ACTIVITY?: any;
  LOGS?: any;
  LOCK?: any;
  KEY_USAGE?: any;
}
