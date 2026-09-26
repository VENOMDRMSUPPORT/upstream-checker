const { app, BrowserWindow, ipcMain, Notification, shell, dialog, safeStorage, clipboard } = require('electron');
const path = require('path');
const https = require('https');
const http = require('http');
const fs = require('fs');
const log = require('electron-log');
const { resolveUserDataDir } = require('./user-data');
const { createCipher } = require('./db/cipher');
const { importLegacy, listImportedFiles, describeImportWarnings, needsReimportPrompt, FILES } = require('./db/import-json');
const { registerDataIpc } = require('./db/ipc');
const { createKeyResolver } = require('./db/keys');

// Settled before anything reads a path or writes a log. An explicit
// --user-data-dir (dev and test instances) is used as given.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  if (!app.isPackaged) {
    // A dev build never touches the installed app's data folder.
    app.setPath('userData', path.join(app.getPath('appData'), 'venom-router-dev'));
  } else {
    const userData = resolveUserDataDir(app.getPath('appData'), fs);
    app.setPath('userData', userData.dir);
    if (userData.migrated) log.info('Moved app data to', userData.dir);
    if (userData.error) log.warn('Could not move the old app data folder, still using it:', userData.error.message);
  }
}

let autoUpdater; // Lazy load after app ready
let updateCheckInterval;

// ============================================
// Local database — venom.db (src/db)
// ============================================
// Opened once, before the window, and closed on quit. A failure to open or to
// import stops the app with the reason on screen: carrying on with an empty
// store is how keys used to get overwritten.
let store = null;
let importReport = null;
// Swaps key placeholders for secrets in api-request (src/db/keys.js).
let keyResolver = null;

function showStartupError(message, detail) {
  dialog.showErrorBox('VENOM Router', `${message}\n\n${detail}`);
}

async function startDatabase() {
  const dir = app.getPath('userData');
  const cipher = createCipher(safeStorage);
  let dbPath = dir;
  try {
    // Required here, not at module load: a native-module/ABI mismatch throws
    // on require, and this way it goes through showStartupError below instead
    // of Electron's generic crash box.
    const database = require('./db');
    dbPath = path.join(dir, database.DB_FILE);
    store = await database.open(dir, { cipher, log });
    store.repos.meta.set('app_version', app.getVersion());
  } catch (err) {
    log.error('Could not open venom.db:', err);
    showStartupError(
      err.code === 'DB_TOO_NEW'
        ? 'This data was written by a newer VENOM Router. Update the app to open it.'
        : 'VENOM Router could not open its database, so it will close. Nothing was changed.',
      `${dbPath}\n\n${err.message}`,
    );
    if (store) store.close();
    store = null;
    return false;
  }

  // Nothing imported yet, no legacy JSON left, but saved copies from an
  // earlier import: the database was deleted or moved, or a re-import
  // aborted. Starting empty without asking would look like every key had
  // been lost.
  let source = 'legacy';
  const saved = listImportedFiles(dir);
  if (needsReimportPrompt({
    importedAt: store.repos.meta.get('imported_from_json_at'),
    legacyPresent: Object.values(FILES).some((name) => fs.existsSync(path.join(dir, name))),
    savedCopies: saved.length,
  })) {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: 'VENOM Router',
      message: 'The VENOM Router database is missing.',
      detail: `It may have been deleted or moved. The files from the earlier import are still in\n${dir}:\n\n${saved.join('\n')}\n\nRe-import them, or start with no providers, keys or history.`,
      buttons: ['Re-import from the saved files', 'Start empty'],
      defaultId: 0,
      // Neither button's index, so Esc/the dialog's own close button is
      // distinguishable from an explicit "Start empty" click below.
      cancelId: 2,
      noLink: true,
    });
    if (choice === 2) {
      // Dismissed without deciding: quit without writing anything, so the
      // offer comes back on the next launch instead of being lost to 'none'.
      store.close();
      store = null;
      return false;
    }
    if (choice === 0) source = 'imported';
  }

  try {
    importReport = await importLegacy({ dir, db: store.db, repos: store.repos, cipher, log, source });
  } catch (err) {
    log.error('Import of the saved JSON files failed:', err);
    showStartupError(
      `VENOM Router could not import its saved data, so it will close.\n\n${err.message}`,
      `${err.file || dir}\n\nThe import runs again the next time VENOM Router starts.`,
    );
    store.close();
    store = null;
    return false;
  }
  return true;
}

let mainWindow;

// Damaged files and skipped rows from the import, said once the window is up.
function showImportWarnings() {
  const detail = describeImportWarnings(importReport);
  importReport = null;
  if (!detail || !mainWindow) return;
  dialog.showMessageBox(mainWindow, { type: 'warning', title: 'VENOM Router', message: 'Some saved data could not be imported.', detail });
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed() || !store) return;
  try {
    store.repos.settings.set('window', { ...mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() });
  } catch (err) {
    log.warn('Could not save window state:', err.message);
  }
}

function createWindow() {
  const saved = (store && store.repos.settings.get('window')) || {};
  mainWindow = new BrowserWindow({
    width: saved.width || 1400,
    height: saved.height || 900,
    x: Number.isInteger(saved.x) ? saved.x : undefined,
    y: Number.isInteger(saved.y) ? saved.y : undefined,
    minWidth: 1000,
    minHeight: 700,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    // The .ico carries the hand-hinted 16/32/48 px frames for the taskbar and
    // Alt-Tab; the 512 px PNG would be shrunk into a blur there.
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
  });

  if (saved.maximized) mainWindow.maximize();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Send app version to renderer after load
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('app-version', app.getVersion());
    showImportWarnings();
  });

  mainWindow.on('close', saveWindowState);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function checkForUpdates() {
  if (process.env.NODE_ENV === 'development') {
    log.info('Skipping update check in development');
    return;
  }
  if (!autoUpdater) return;
  autoUpdater.checkForUpdates().catch(err => {
    log.error('Error checking for updates:', err);
  });
}

function initAutoUpdater() {
  const { autoUpdater: updater } = require('electron-updater');
  autoUpdater = updater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    log.info('Checking for updates...');
    mainWindow?.webContents.send('update-checking');
  });

  autoUpdater.on('update-available', async (info) => {
    log.info('Update available:', info.version);
    // electron-updater takes the notes from GitHub's releases.atom feed, which
    // carries them as GitHub-rendered HTML. The release body itself is the
    // CHANGELOG section in Markdown, so it is fetched first and the feed's HTML
    // is only the fallback. The renderer reads either shape.
    let releaseNotes = info.releaseNotes;
    try {
      const url = `https://api.github.com/repos/VENOMDRMSUPPORT/upstream-checker/releases/tags/v${info.version}`;
      const response = await new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'VENOM-Router', Accept: 'application/vnd.github+json' } }, (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.setTimeout(8000, () => req.destroy(new Error('timed out')));
        req.on('error', reject);
      });
      if (response.status === 200) {
        const body = JSON.parse(response.body).body;
        if (typeof body === 'string' && body.trim()) releaseNotes = body;
      } else {
        log.warn(`Release notes: GitHub API answered ${response.status}; using the feed's notes`);
      }
    } catch (err) {
      log.warn('Release notes: GitHub API unreachable; using the feed\'s notes:', err.message);
    }

    mainWindow?.webContents.send('update-available', {
      version: info.version,
      releaseNotes: releaseNotes,
      releaseDate: info.releaseDate,
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    log.info('Update not available. Current version:', info.version);
    mainWindow?.webContents.send('update-not-available');
  });

  autoUpdater.on('error', (err) => {
    log.error('Update error:', err);
    mainWindow?.webContents.send('update-error', { message: err.message });
  });

  autoUpdater.on('download-progress', (progressObj) => {
    log.info(`Download speed: ${progressObj.bytesPerSecond} - Downloaded ${progressObj.percent}%`);
    mainWindow?.webContents.send('update-download-progress', {
      percent: Math.round(progressObj.percent),
      transferred: progressObj.transferred,
      total: progressObj.total,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info('Update downloaded:', info.version);
    mainWindow?.webContents.send('update-downloaded', { version: info.version });
  });
}

function startUpdateChecks() {
  setTimeout(() => checkForUpdates(), 5000);
  updateCheckInterval = setInterval(() => checkForUpdates(), 2 * 60 * 60 * 1000);
}

function stopUpdateChecks() {
  if (updateCheckInterval) {
    clearInterval(updateCheckInterval);
    updateCheckInterval = null;
  }
}

app.whenReady().then(async () => {
  if (!(await startDatabase())) {
    app.quit();
    return;
  }
  try {
    registerDataIpc({ ipcMain, repos: store.repos, clipboard, log });
    keyResolver = createKeyResolver({ providers: store.repos.providers, secrets: store.repos.secrets });
    initAutoUpdater();
    createWindow();
    startUpdateChecks();
  } catch (err) {
    // No windowless process may stay alive holding venom.db open.
    log.error('Startup failed after opening venom.db:', err);
    showStartupError('VENOM Router could not start, so it will close. Nothing was changed.', err.message);
    if (store) {
      store.close();
      store = null;
    }
    app.quit();
  }
});

app.on('will-quit', () => {
  stopUpdateChecks();
  if (store) {
    store.close();
    store = null;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Window controls
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window-close', () => mainWindow?.close());

// In-flight API requests by id, so the renderer can cancel hedged losers.
const activeApiRequests = new Map();

// A chunk that carries model text: a non-empty content/text/reasoning field.
// Matches both a streamed delta and a whole non-streamed body.
const CONTENT_TOKEN = /"(?:content|text|reasoning_content|reasoning)"\s*:\s*"[^"\\]/;

// API request handler
// Failures resolve rather than reject. A rejected ipcMain.handle reaches the
// renderer as "Error invoking remote method 'api-request': ..." with the real
// message buried and every other field — notably the elapsed time — gone, so a
// failed model showed a meaningless error and 0.0s.
ipcMain.handle('api-request', async (event, { url, method, headers, body, requestId, timeoutMs, logLevel }) => {
  // The renderer holds placeholders (venomkey:<id>, venomsecret:<name>), not
  // keys. They become the real secret here, only for the origin that secret
  // belongs to; anything else is refused without sending. The request log
  // below records the request as the renderer sent it, placeholders and all.
  const outgoing = keyResolver ? keyResolver.resolve({ url, headers, body }) : { url, headers, body };
  if (outgoing.blocked) {
    log.warn(outgoing.error);
    return { status: 0, body: '', elapsed: 0, headers: {}, blocked: true, error: outgoing.error };
  }
  return new Promise((resolve) => {
    const startTime = Date.now();
    const urlObj = new URL(outgoing.url);
    const isHttps = urlObj.protocol === 'https:';
    const client = isHttps ? https : http;

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: method || 'GET',
      headers: outgoing.headers || {},
      // Socket inactivity timeout. A video generator sends nothing for minutes
      // while it works, so a fixed 60s here would kill it regardless of the
      // deadline the caller set for that kind of model.
      timeout: Number(timeoutMs) > 0 ? Number(timeoutMs) : 60000,
    };

    const cleanup = () => {
      if (requestId) activeApiRequests.delete(requestId);
    };

    const req = client.request(options, (res) => {
      // Collected as Buffers and decoded once at the end. `data += chunk` decodes
      // each chunk on its own, so any UTF-8 character split across a chunk
      // boundary comes out mangled — a model answering "Bốn" renders as "Bón".
      const chunks = [];
      // Time to first byte of the body. For a streamed completion this is the
      // time to first token, which the benchmark reports separately from the
      // total: a model that starts answering in 300ms and streams for 4s feels
      // very different from one that is silent for 4s.
      let firstByteMs = null;
      // Time to the first chunk that carries model text. A proxy can answer
      // with headers, a keep-alive comment or an empty role delta within a few
      // milliseconds, which says nothing about the model; the first non-empty
      // content field does.
      let firstTokenMs = null;
      res.on('data', (chunk) => {
        const now = Date.now() - startTime;
        if (firstByteMs === null) firstByteMs = now;
        if (firstTokenMs === null && CONTENT_TOKEN.test(chunk.toString('utf8'))) firstTokenMs = now;
        chunks.push(chunk);
      });
      res.on('end', () => {
        cleanup();
        const elapsed = Date.now() - startTime;
        const text = Buffer.concat(chunks).toString('utf8');
        if (logLevel === 'all' || (logLevel === 'errors' && res.statusCode !== 200)) {
          appendRequestLog({
            at: new Date().toISOString(),
            url,
            method: method || 'GET',
            status: res.statusCode,
            elapsedMs: elapsed,
            requestHeaders: redactHeaders(headers),
            requestBody: clip(body),
            responseBody: clip(text),
          });
        }
        resolve({ status: res.statusCode, body: text, elapsed, firstByteMs, firstTokenMs, headers: res.headers });
      });
    });

    if (requestId) activeApiRequests.set(requestId, req);

    req.on('error', (err) => {
      cleanup();
      const elapsed = Date.now() - startTime;
      // A cancelled hedge loser is expected — resolve quietly so it isn't logged
      // as an unhandled handler error.
      if (req.__cancelled) {
        resolve({ status: 0, body: '', elapsed, headers: {}, cancelled: true });
        return;
      }
      if (logLevel === 'all' || logLevel === 'errors') {
        appendRequestLog({
          at: new Date().toISOString(), url, method: method || 'GET', status: 0,
          elapsedMs: elapsed, requestHeaders: redactHeaders(headers),
          requestBody: clip(body), error: err.message,
        });
      }
      resolve({ status: 0, body: '', elapsed, headers: {}, networkError: true, error: err.message });
    });

    req.on('timeout', () => {
      cleanup();
      req.destroy();
      const elapsed = Date.now() - startTime;
      resolve({ status: 0, body: '', elapsed, headers: {}, networkError: true, timedOut: true,
                error: `No response for ${Math.round(options.timeout / 1000)}s` });
    });

    if (outgoing.body) req.write(typeof outgoing.body === 'string' ? outgoing.body : JSON.stringify(outgoing.body));
    req.end();
  });
});

// Cancel an in-flight request (hedged loser) by id.
ipcMain.on('cancel-api-request', (event, requestId) => {
  const req = activeApiRequests.get(requestId);
  if (req) {
    activeApiRequests.delete(requestId);
    req.__cancelled = true;
    req.destroy();
  }
});


// ============================================
// Request log
// ============================================
// Written so a failed test can be explained after the fact: what was sent, what
// came back. Off by default, because it is a file on disk containing the
// traffic of an authenticated API.
//
// The Authorization header is never written. A log that captures the request
// faithfully would capture the key with it, which turns a debugging aid into the
// exact thing the keystore work was meant to prevent.
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const REDACTED = '[redacted]';

let requestLogPath;
function getRequestLogPath() {
  if (!requestLogPath) requestLogPath = path.join(app.getPath('userData'), 'requests.log');
  return requestLogPath;
}

function redactHeaders(headers) {
  const out = {};
  Object.entries(headers || {}).forEach(([k, v]) => {
    out[k] = /^(authorization|x-api-key|api-key|cookie)$/i.test(k) ? REDACTED : v;
  });
  return out;
}

function clip(text, max = 4000) {
  const str = String(text ?? '');
  return str.length > max ? `${str.slice(0, max)}… [${str.length - max} more chars]` : str;
}

function appendRequestLog(entry) {
  try {
    const lp = getRequestLogPath();
    // Rotate rather than grow without bound; one previous file is kept.
    try {
      if (fs.existsSync(lp) && fs.statSync(lp).size > LOG_MAX_BYTES) {
        fs.renameSync(lp, `${lp}.1`);
      }
    } catch (_) {}
    fs.appendFileSync(lp, JSON.stringify(entry) + String.fromCharCode(10), 'utf-8');
  } catch (err) {
    log.warn('Could not write request log:', err.message);
  }
}

ipcMain.handle('read-log-info', () => {
  try {
    const lp = getRequestLogPath();
    const size = fs.existsSync(lp) ? fs.statSync(lp).size : 0;
    return { path: lp, size };
  } catch (_) {
    return { path: getRequestLogPath(), size: 0 };
  }
});

ipcMain.on('open-request-log', () => {
  const lp = getRequestLogPath();
  if (fs.existsSync(lp)) shell.showItemInFolder(lp);
  else shell.openPath(app.getPath('userData'));
});

ipcMain.handle('clear-request-log', () => {
  try {
    [getRequestLogPath(), `${getRequestLogPath()}.1`].forEach((f) => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Fired when a scheduled run finds a model that used to pass and no longer does.
ipcMain.on('notify-regression', (event, { title, body }) => {
  if (!Notification.isSupported()) return;
  new Notification({ title: String(title || ''), body: String(body || '') }).show();
});

ipcMain.handle('get-data-path', () => app.getPath('userData'));
ipcMain.on('open-data-folder', () => shell.openPath(app.getPath('userData')));

// Provider websites and similar links open in the user's browser. Only http(s)
// is accepted, so a crafted string can't launch a file or another protocol.
ipcMain.handle('open-external', async (_e, url) => {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    await shell.openExternal(u.toString());
    return true;
  } catch (_) {
    return false;
  }
});

// Update IPC handlers
ipcMain.on('download-update', () => {
  log.info('User requested update download');
  if (autoUpdater) autoUpdater.downloadUpdate();
});

// Silent install with a forced relaunch. The default (wizard) mode reopened the
// full NSIS installer, which sat frozen for several seconds while its
// app-running check shelled out to PowerShell, then needed a Finish click. Silent
// mode keeps the existing install directory and reopens the app on its own.
ipcMain.on('install-update', () => {
  log.info('User requested update install');
  if (autoUpdater) setImmediate(() => autoUpdater.quitAndInstall(true, true));
});

ipcMain.on('check-for-updates-manual', () => {
  log.info('Manual update check requested');
  checkForUpdates();
});
