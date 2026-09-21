const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const https = require('https');
const http = require('http');
const fs = require('fs');
const log = require('electron-log');

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
    return parsed;
  } catch (err) {
    log.error('Failed to read config:', err);
    return getDefaultConfig();
  }
}

function ensureConfig() {
  const cp = getConfigPath();
  if (!fs.existsSync(cp)) writeConfig(getDefaultConfig());
}

function writeConfig(data) {
  try {
    const cp = getConfigPath();
    const dir = path.dirname(cp);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(cp, JSON.stringify(data, null, 2), 'utf-8');
    return { success: true };
  } catch (err) {
    log.error('Failed to write config:', err);
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
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
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

// API request handler
ipcMain.handle('api-request', async (event, { url, method, headers, body }) => {
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

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const elapsed = Date.now() - startTime;
        resolve({
          status: res.statusCode,
          body: data,
          elapsed,
          headers: res.headers,
        });
      });
    });

    req.on('error', (err) => {
      const elapsed = Date.now() - startTime;
      reject({ error: err.message, elapsed });
    });

    req.on('timeout', () => {
      req.destroy();
      reject({ error: 'Request timed out', elapsed: Date.now() - startTime });
    });

    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
});

// Open external links
ipcMain.on('open-external', (event, url) => {
  shell.openExternal(url);
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
