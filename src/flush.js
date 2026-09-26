// ============================================
// Close handshake with the renderer
// ============================================
// Before the window closes, and before an update installs, the renderer is
// asked to write what it still holds (debounced settings, the test prompt, the
// model pool). Main waits for its answer, but at most timeoutMs, so a hung
// renderer can never keep the app open. The token ties an answer to its
// request, so a late answer to an earlier close can't end this one.
const DEFAULT_FLUSH_TIMEOUT_MS = 2000;

function requestFlush({ webContents, ipcMain, timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    if (!webContents || webContents.isDestroyed() || webContents.isCrashed()) {
      resolve('skipped');
      return;
    }
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let timer = null;
    const finish = (how) => {
      clearTimeout(timer);
      ipcMain.removeListener('flush-done', onDone);
      resolve(how);
    };
    function onDone(_event, answer) {
      if (answer === token) finish('done');
    }
    ipcMain.on('flush-done', onDone);
    timer = setTimeout(() => finish('timeout'), timeoutMs);
    try {
      webContents.send('flush-pending', token);
    } catch (_) {
      finish('skipped');
    }
  });
}

module.exports = { requestFlush, DEFAULT_FLUSH_TIMEOUT_MS };
