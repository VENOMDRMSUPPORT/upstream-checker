const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const https = require('https');
const http = require('http');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

// Auto-updater configuration
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

let updateCheckInterval;

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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function checkForUpdates() {
  if (process.env.NODE_ENV === 'development') {
    log.info('Skipping update check in development');
    return;
  }

  autoUpdater.checkForUpdates().catch(err => {
    log.error('Error checking for updates:', err);
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

autoUpdater.on('checking-for-update', () => {
  log.info('Checking for updates...');
  mainWindow?.webContents.send('update-checking');
});

autoUpdater.on('update-available', (info) => {
  log.info('Update available:', info.version);
  mainWindow?.webContents.send('update-available', {
    version: info.version,
    releaseNotes: info.releaseNotes,
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

app.whenReady().then(() => {
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

// Update IPC handlers
ipcMain.on('download-update', () => {
  log.info('User requested update download');
  autoUpdater.downloadUpdate();
});

ipcMain.on('install-update', () => {
  log.info('User requested update install');
  setImmediate(() => autoUpdater.quitAndInstall());
});

ipcMain.on('check-for-updates-manual', () => {
  log.info('Manual update check requested');
  checkForUpdates();
});
