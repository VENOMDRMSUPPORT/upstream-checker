// ============================================
// Request log IPC — what the log pages (sub-project C) call
// ============================================
// Registered whether or not logging is on. When the log database couldn't be
// opened, logs-info says why and every other read answers empty. A query
// that fails throws: the renderer's promise rejects and it says so.
const { emptyStats, emptyRunSummary } = require('./query');

const LOGS_CHANNELS = ['logs-list', 'logs-get', 'logs-stats', 'logs-facets', 'logs-runs', 'logs-run-summary', 'logs-export', 'logs-info', 'logs-clear'];
const NOT_SAVED = Object.freeze({ saved: false, path: null, rows: 0 });

function offInfo(error) {
  return {
    enabled: false,
    error: error ? String(error.message || error) : 'Request logging is off',
    path: null,
    sizeBytes: 0,
    rows: 0,
    oldestAt: null,
    droppedRows: 0,
    lastPurgeAt: null,
  };
}

function registerLogsIpc({ ipcMain, getState, dialog, getWindow = () => null, log = console }) {
  // on(query, ...args) when logging is on; off(error, ...args) when it isn't.
  const handle = (channel, on, off) => {
    ipcMain.handle(channel, async (_event, ...args) => {
      const { logs, error } = getState() || {};
      try {
        if (!logs) return off(error, ...args);
        return await on(logs.repos.query, ...args);
      } catch (err) {
        log.error(`${channel} failed:`, err.message);
        throw err;
      }
    });
  };

  handle('logs-list', (q, filters, cursor, limit, sort) => q.list(filters, cursor, limit, sort), () => ({ rows: [], nextCursor: null }));
  handle('logs-get', (q, id) => q.get(id), () => null);
  handle('logs-stats', (q, filters, bucket, groupBy) => q.stats(filters, bucket, groupBy), () => emptyStats());
  handle('logs-facets', (q, range) => q.facets(range), () => ({ providers: [], models: [], sources: [] }));
  handle('logs-runs', (q, filters, cursor, limit) => q.runs(filters, cursor, limit), () => ({ rows: [], nextCursor: null }));
  handle('logs-run-summary', (q, runId) => q.runSummary(runId), (_error, runId) => emptyRunSummary(runId));
  handle('logs-export', async (q, filters, format) => {
    if (format !== 'csv' && format !== 'json') throw new TypeError(`Unknown export format "${format}"`);
    const options = {
      title: 'Export request log',
      defaultPath: `venom-requests-${new Date().toISOString().slice(0, 10)}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    };
    const win = getWindow();
    const pick = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (!pick || pick.canceled || !pick.filePath) return { ...NOT_SAVED };
    const rows = await q.exportTo(pick.filePath, filters, format);
    return { saved: true, path: pick.filePath, rows };
  }, () => ({ ...NOT_SAVED }));
  handle('logs-info', (q) => q.info(), (error) => offInfo(error));
  handle('logs-clear', (q, opts) => q.clear(opts), () => ({ rows: 0, bodies: 0, rollups: 0 }));
}

module.exports = { registerLogsIpc, LOGS_CHANNELS };
