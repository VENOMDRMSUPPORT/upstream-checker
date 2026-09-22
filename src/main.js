const { app, BrowserWindow, ipcMain, Notification } = require('electron');
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
const MAX_RUNS = 300;

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

function appendRun(run) {
  try {
    const data = readHistory();
    data.version = HISTORY_VERSION;
    data.runs.push(run);
    if (data.runs.length > MAX_RUNS) data.runs = data.runs.slice(-MAX_RUNS);
    writeHistory(data);
    return { success: true, runs: data.runs.length };
  } catch (err) {
    log.error('Failed to append run to history:', err);
    return { success: false, error: err.message };
  }
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0a0e1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Send app version to renderer after load
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('app-version', app.getVersion());
  });

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
    let releaseNotes = info.releaseNotes;

    // Fetch release notes from GitHub if not available
    if (!releaseNotes || (Array.isArray(releaseNotes) && releaseNotes.length === 0)) {
      try {
        const url = `https://api.github.com/repos/VENOMDRMSUPPORT/upstream-checker/releases/tags/v${info.version}`;
        const response = await new Promise((resolve, reject) => {
          https.get(url, { headers: { 'User-Agent': 'Upstream-Checker' } }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
          }).on('error', reject);
        });

        if (response.status === 200) {
          const release = JSON.parse(response.body);
          releaseNotes = release.body || 'No release notes available';
        }
      } catch (err) {
        log.warn('Failed to fetch release notes:', err);
      }
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

// API request handler
ipcMain.handle('api-request', async (event, { url, method, headers, body, requestId }) => {
  return new Promise((resolve, reject) => {
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
      timeout: 60000,
    };

    const cleanup = () => {
      if (requestId) activeApiRequests.delete(requestId);
    };

    const req = client.request(options, (res) => {
      // Collected as Buffers and decoded once at the end. `data += chunk` decodes
      // each chunk on its own, so any UTF-8 character split across a chunk
      // boundary comes out mangled — a model answering "Bốn" renders as "Bón".
      const chunks = [];
      res.on('data', (chunk) => { chunks.push(chunk); });
      res.on('end', () => {
        cleanup();
        const elapsed = Date.now() - startTime;
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
          elapsed,
          headers: res.headers,
        });
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
      reject({ error: err.message, elapsed });
    });

    req.on('timeout', () => {
      cleanup();
      req.destroy();
      reject({ error: 'Request timed out', elapsed: Date.now() - startTime });
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

// History IPC handlers
ipcMain.handle('read-history', () => readHistory());
ipcMain.handle('append-run', (event, run) => appendRun(run));
ipcMain.handle('clear-history', () => {
  try {
    writeHistory({ version: HISTORY_VERSION, runs: [] });
    return { success: true };
  } catch (err) {
    log.error('Failed to clear history:', err);
    return { success: false, error: err.message };
  }
});

// Fired when a scheduled run finds a model that used to pass and no longer does.
ipcMain.on('notify-regression', (event, { title, body }) => {
  if (!Notification.isSupported()) return;
  new Notification({ title: String(title || ''), body: String(body || '') }).show();
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

ipcMain.on('install-update', () => {
  log.info('User requested update install');
  if (autoUpdater) setImmediate(() => autoUpdater.quitAndInstall());
});

ipcMain.on('check-for-updates-manual', () => {
  log.info('Manual update check requested');
  checkForUpdates();
});
