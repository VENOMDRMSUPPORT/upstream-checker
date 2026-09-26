const { app, BrowserWindow, ipcMain, Notification, shell } = require('electron');
const path = require('path');
const https = require('https');
const http = require('http');
const fs = require('fs');
const log = require('electron-log');
const {
  ENC_PREFIX,
  decryptKeyEntry,
  encryptKeyEntry,
  eachStoredKey,
  countPlaintextKeys,
} = require('./keystore');
const { resolveUserDataDir } = require('./user-data');

// Settled before anything reads a path or writes a log. An explicit
// --user-data-dir (dev and test instances) is used as given.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  const userData = resolveUserDataDir(app.getPath('appData'), fs);
  app.setPath('userData', userData.dir);
  if (userData.migrated) log.info('Moved app data to', userData.dir);
  if (userData.error) log.warn('Could not move the old app data folder, still using it:', userData.error.message);
}

let autoUpdater; // Lazy load after app ready
let updateCheckInterval;
let configPath;

const CONFIG_VERSION = 1;

function getDefaultConfig() {
  return { version: CONFIG_VERSION, providers: {} };
}


// Config file helpers
function getConfigPath() {
  if (!configPath) {
    configPath = path.join(app.getPath('userData'), 'config.json');
  }
  return configPath;
}

function readConfig() {
  try {
    const cp = getConfigPath();
    if (!fs.existsSync(cp)) {
      writeConfig(getDefaultConfig());
      return getDefaultConfig();
    }
    const parsed = JSON.parse(fs.readFileSync(cp, 'utf-8'));
    if (typeof parsed.version !== 'number') parsed.version = CONFIG_VERSION;
    if (!parsed.providers || typeof parsed.providers !== 'object') parsed.providers = {};
    return eachStoredKey(parsed, (k) => decryptKeyEntry(k, log));
  } catch (err) {
    log.error('Failed to read config:', err);
    return getDefaultConfig();
  }
}

function ensureConfig() {
  const cp = getConfigPath();
  if (!fs.existsSync(cp)) writeConfig(getDefaultConfig());
}

// Encrypt keys written by an older build. Without this, existing keys would stay
// readable on disk until the user happened to save something.
function migrateConfigSecrets() {
  try {
    const cp = getConfigPath();
    if (!fs.existsSync(cp)) return;
    const raw = JSON.parse(fs.readFileSync(cp, 'utf-8'));
    const plaintext = countPlaintextKeys(raw);
    if (plaintext === 0) return;
    log.info(`Encrypting ${plaintext} API key(s) previously stored as plaintext`);
    writeConfig(readConfig());
  } catch (err) {
    log.error('Failed to migrate stored keys:', err);
  }
}

function writeConfig(data) {
  try {
    const cp = getConfigPath();
    const dir = path.dirname(cp);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Encrypt a copy — the caller keeps working with the plaintext it passed in.
    const onDisk = eachStoredKey(structuredClone(data), (k) => encryptKeyEntry(k, log));
    // Written to a temp file and renamed over the real one. A crash partway
    // through an in-place write would truncate config.json, and now that the keys
    // are encrypted there is no readable copy left to recover them from — the
    // rename is atomic, so the file is either the old config or the new one.
    const tmp = `${cp}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(onDisk, null, 2), 'utf-8');
    fs.renameSync(tmp, cp);
    return { success: true };
  } catch (err) {
    log.error('Failed to write config:', err);
    return { success: false, error: err.message };
  }
}

// ============================================
// Run history
// ============================================
// Kept out of config.json so the settings file stays small and a corrupt or
// pruned history can never cost the user their providers or keys. Only the
// verdict of each test is stored — never the response text, which would grow the
// file without bound for no benefit.
const HISTORY_VERSION = 1;
const MAX_RUNS = 300; // fallback when the renderer sends no cap

let historyPath;
function getHistoryPath() {
  if (!historyPath) historyPath = path.join(app.getPath('userData'), 'history.json');
  return historyPath;
}

function readHistory() {
  try {
    const hp = getHistoryPath();
    if (!fs.existsSync(hp)) return { version: HISTORY_VERSION, runs: [] };
    const parsed = JSON.parse(fs.readFileSync(hp, 'utf-8'));
    if (!Array.isArray(parsed.runs)) parsed.runs = [];
    return parsed;
  } catch (err) {
    // A damaged history is an inconvenience, not a reason to fail the app.
    log.error('Failed to read history:', err);
    return { version: HISTORY_VERSION, runs: [] };
  }
}

function writeHistory(data) {
  const hp = getHistoryPath();
  const tmp = `${hp}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8');
  fs.renameSync(tmp, hp);
}

function appendRun(run, maxRuns) {
  try {
    const cap = Number(maxRuns) > 0 ? Math.min(Number(maxRuns), 5000) : MAX_RUNS;
    const data = readHistory();
    data.version = HISTORY_VERSION;
    data.runs.push(run);
    if (data.runs.length > cap) data.runs = data.runs.slice(-cap);
    writeHistory(data);
    return { success: true, runs: data.runs.length };
  } catch (err) {
    log.error('Failed to append run to history:', err);
    return { success: false, error: err.message };
  }
}

// ============================================
// Model catalog — catalog.json
// ============================================
// Every model each connected provider has ever listed, with when it was first
// and last seen, whether it has since disappeared, and its benchmark results.
// Kept apart from history.json (per-run verdicts) and config.json (keys), so a
// growing catalogue never slows either of those down.
const CATALOG_VERSION = 1;

let catalogPath;
function getCatalogPath() {
  if (!catalogPath) catalogPath = path.join(app.getPath('userData'), 'catalog.json');
  return catalogPath;
}

function emptyCatalog() {
  return { version: CATALOG_VERSION, models: {}, lastSync: {}, leaderboard: null };
}

function readCatalog() {
  try {
    const cp = getCatalogPath();
    if (!fs.existsSync(cp)) return emptyCatalog();
    const parsed = JSON.parse(fs.readFileSync(cp, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return emptyCatalog();
    if (!parsed.models || typeof parsed.models !== 'object') parsed.models = {};
    if (!parsed.lastSync || typeof parsed.lastSync !== 'object') parsed.lastSync = {};
    return parsed;
  } catch (err) {
    log.error('Failed to read catalog:', err);
    return emptyCatalog();
  }
}

function writeCatalog(data) {
  try {
    const cp = getCatalogPath();
    const tmp = `${cp}.tmp`;
    data.version = CATALOG_VERSION;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8');
    fs.renameSync(tmp, cp);
    return { success: true };
  } catch (err) {
    log.error('Failed to write catalog:', err);
    return { success: false, error: err.message };
  }
}

let mainWindow;

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const data = readConfig();
    data.window = { ...mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() };
    writeConfig(data);
  } catch (err) {
    log.warn('Could not save window state:', err.message);
  }
}

function createWindow() {
  const saved = (readConfig().window) || {};
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
    icon: path.join(__dirname, 'assets', 'icon.png'),
  });

  if (saved.maximized) mainWindow.maximize();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Send app version to renderer after load
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('app-version', app.getVersion());
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
        const req = https.get(url, { headers: { 'User-Agent': 'Upstream-Checker', Accept: 'application/vnd.github+json' } }, (res) => {
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

app.whenReady().then(() => {
  ensureConfig();
  migrateConfigSecrets();
  initAutoUpdater();
  createWindow();
  startUpdateChecks();
});

app.on('will-quit', () => {
  stopUpdateChecks();
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
  return new Promise((resolve) => {
    const startTime = Date.now();
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const client = isHttps ? https : http;

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: method || 'GET',
      headers: headers || {},
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

    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
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

// History IPC handlers
ipcMain.handle('read-history', () => readHistory());
ipcMain.handle('append-run', (event, run, maxRuns) => appendRun(run, maxRuns));
ipcMain.handle('clear-history', () => {
  try {
    writeHistory({ version: HISTORY_VERSION, runs: [] });
    return { success: true };
  } catch (err) {
    log.error('Failed to clear history:', err);
    return { success: false, error: err.message };
  }
});

// Catalog IPC handlers
ipcMain.handle('read-catalog', () => readCatalog());
ipcMain.handle('write-catalog', (event, data) => writeCatalog(data));

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

// Config IPC handlers
ipcMain.handle('read-config', () => {
  return readConfig();
});

ipcMain.handle('write-config', (event, data) => {
  return writeConfig(data);
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
