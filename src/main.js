const { app, BrowserWindow, ipcMain, Notification, shell, dialog, safeStorage, clipboard, nativeImage } = require('electron');
const path = require('path');
const https = require('https');
const fs = require('fs');
const log = require('electron-log');
const { resolveUserDataDir } = require('./user-data');
const { createCipher } = require('./db/cipher');
const { importLegacy, listImportedFiles, describeImportWarnings, needsReimportPrompt, FILES } = require('./db/import-json');
const { registerDataIpc } = require('./db/ipc');
const { createKeyResolver } = require('./db/keys');
const { requestFlush } = require('./flush');
const { createApiRequester } = require('./api-request');
const { readLogSettings } = require('./logs/settings');
const { createRecorder } = require('./logs/recorder');
const { createPriceBook, createProviderLookup } = require('./logs/lookups');
const { purge, createPurgeScheduler } = require('./logs/retention');
const { registerLogsIpc } = require('./logs/ipc');
const { createFetcher, DEFAULT_TIMEOUT_MS } = require('./catalog/fetch');
const { createSources } = require('./catalog/sources');
const { createEngine } = require('./catalog/engine');
const { createCatalogIpc } = require('./catalog/ipc');

// --smoke-test only ever runs on an explicit scratch folder: refused here,
// before the real data folder is resolved, moved or locked.
if (app.commandLine.hasSwitch('smoke-test') && !app.commandLine.hasSwitch('user-data-dir')) {
  console.error('SMOKE FAILED: --smoke-test needs --user-data-dir');
  process.exit(2);
}

// Settled before anything reads a path or writes a log. An explicit
// --user-data-dir (dev and test instances) is used as given; otherwise a
// packaged run and an unpackaged run resolve the same real data folder.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  const userData = resolveUserDataDir(app.getPath('appData'), fs);
  app.setPath('userData', userData.dir);
  if (userData.migrated) log.info('Moved app data to', userData.dir);
  if (userData.error) log.warn('Could not move the old app data folder, still using it:', userData.error.message);
}

// One instance per data folder (the lock is per userData, so it comes right
// after setPath and before the database opens). A second instance would run
// every timer twice and race the first one's writes; it hands over to the
// window that is already open and quits.
const isPrimary = app.requestSingleInstanceLock();
if (!isPrimary) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
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

// ============================================
// Request log — venom-logs.db (src/logs)
// ============================================
// Not critical data. If it can't be opened, logging is off for the session:
// the reason goes to electron-log and to logs-info, the window shows one
// warning, and the app carries on.
let logs = null;
let logsError = null;
let recorder = null;
let priceBook = null;
let purgeScheduler = null;
// The body setting and the retention limits, read from the saved settings
// row at startup and again on every save-settings; a request no longer
// carries logLevel.
let logSettings = readLogSettings(null);

function startLogs() {
  try {
    logSettings = readLogSettings(store.repos.settings.get('settings'));
    // Required here, like ./db: a native-module fault turns logging off
    // instead of stopping the app at module load.
    const logsDb = require('./logs');
    const opened = logsDb.tryOpen(app.getPath('userData'), { log });
    if (!opened.logs) throw opened.error;
    logs = opened.logs;
    priceBook = createPriceBook(store.db);
    recorder = createRecorder({
      writer: logs.writer,
      prices: priceBook,
      providers: createProviderLookup(store.db),
      getLogLevel: () => logSettings.logLevel,
    });
    const purgeIsBusy = () => requester.inFlight() > 0;
    purgeScheduler = createPurgeScheduler({
      run: () => purge(logs.db, { now: Date.now(), ...logSettings, meta: logs.repos.meta, isBusy: purgeIsBusy }),
      isBusy: purgeIsBusy,
      log,
    });
    purgeScheduler.start();
  } catch (err) {
    log.error('Request logging is off for this session:', err);
    logsError = (err && err.message) || String(err);
    stopLogs();
  }
}

// The spec's will-quit order: the purge timer first, then the log DB's own
// close (flush timer, synchronous flush, close). venom.db closes after this.
function stopLogs() {
  if (purgeScheduler) {
    purgeScheduler.stop();
    purgeScheduler = null;
  }
  recorder = null;
  priceBook = null;
  if (logs) {
    try {
      logs.close();
    } catch (err) {
      log.warn('Could not close venom-logs.db:', err.message);
    }
    logs = null;
  }
}

function showStartupError(message, detail) {
  dialog.showErrorBox('VENOM Router', `${message}\n\n${detail}`);
}

// ============================================
// Model catalog engine — src/catalog
// ============================================
// The four upstream documents, the merged reference built from them and the five
// catalog:* channels. Started after both databases and after their IPC: it writes
// through repos.snapshots, so nothing here may run before venom.db is open.
//
// Boot reads the disk and nothing else. `loadCache()` is four `readFileSync` calls
// under <userData>\catalog-cache, and there is no timer on this plane at all: the
// first byte of upstream traffic is the owner clicking Sync sources (or a provider
// page fetching its own models), never a window opening. That is why there is no
// stopCatalog() to match — there is nothing running to stop, and will-quit is not
// touched.
let catalogEngine = null;

function startCatalog({ repos, log, onRosterWritten }) {
  const cacheDir = path.join(app.getPath('userData'), 'catalog-cache');
  const fetcher = createFetcher({
    // ONE fetcher for the whole app: its URL-keyed dedup Map is per instance, and a
    // second one silently re-downloads the 4.9 MB models.dev document.
    timeoutMs: Number(repos.settings.get('settings')?.fetchTimeoutMs) || DEFAULT_TIMEOUT_MS,
  });
  const sources = createSources({
    cacheDir, fetcher,
    // Read at the point of use, so a key saved in Settings needs no restart. The
    // secret never leaves main: the renderer gets "key set" or "no OpenRouter key".
    readKey: () => repos.secrets.reveal('openRouterApiKey') || '',
  });
  const engine = createEngine({ sources, log: (line) => log.info(line) });
  try {
    engine.loadCache();
  } catch (err) {
    // A cache that will not read is not a reason to stop the app: the sources
    // re-fetch and rebuild. Unlike the database, which must stop it.
    log.warn('catalog cache load failed, starting empty:', err.message);
  }
  createCatalogIpc({ ipcMain, repos, engine, log, onRosterWritten });
  return engine;
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
    importReport = await importLegacy({ dir, db: store.db, repos: store.repos, cipher, log, source, fs });
  } catch (err) {
    log.error('Import of the saved JSON files failed:', err);
    // A damaged config.json is the one failure the owner can work around
    // without our help: it's the only file the importer insists on, so
    // moving it out of the data folder lets the app start — but without the
    // providers and keys that file held. That is not a deferred import:
    // once startup succeeds without it, imported_from_json_at is set and a
    // config.json that turns up later is never imported.
    const workaround = err.code === 'IMPORT_CONFIG_PARSE'
      ? '\n\nMoving this file out of the data folder lets VENOM Router start, but WITHOUT the providers and keys in that file. Nothing is deleted; keep the moved file safe.'
      : '';
    showStartupError(
      `VENOM Router could not import its saved data, so it will close.\n\n${err.message}`,
      `${err.file || dir}\n\nThe import runs again the next time VENOM Router starts.${workaround}`,
    );
    store.close();
    store = null;
    return false;
  }
  return true;
}

// Release check (scripts/release.mjs): the packaged app is started with
// --smoke-test --user-data-dir=<temp>. It opens the database and the request
// log, writes and reads back a row in each, and exits 0 — proof that the
// native SQLite module loads from app.asar.unpacked. No window, no import, no
// network. (A run without --user-data-dir was already refused at the top of
// this file.)
async function runSmokeTest() {
  let code = 1;
  try {
    // Same lazy require as startDatabase(): an ABI mismatch throws here, not at
    // module load, and lands in the catch below either way.
    const database = require('./db');
    const smoke = await database.open(app.getPath('userData'), { cipher: createCipher(safeStorage), log });
    const stamp = `smoke-${Date.now()}`;
    smoke.repos.settings.set('smoke', { stamp });
    const back = smoke.repos.settings.get('smoke');
    smoke.close();
    // The request log opens in the same scratch folder, so a packaging fault
    // in src/logs shows up here, before release, and not as "logging is off"
    // on the owner's machine later.
    const logsDb = require('./logs');
    const smokeLogs = logsDb.open(app.getPath('userData'), { log });
    const uid = `SMOKE${Date.now()}`;
    smokeLogs.writer.add({ request_uid: uid, created_at: Date.now(), source: 'other', method: 'GET', endpoint: 'smoke://local', status: 'ok' });
    smokeLogs.writer.flush();
    const logged = smokeLogs.repos.query.list({ text: uid }, null, 1).rows[0];
    smokeLogs.close();
    const dbOk = !!back && back.stamp === stamp;
    const logsOk = !!logged && logged.request_uid === uid;
    code = dbOk && logsOk ? 0 : 1;
    console.log(code === 0 ? 'SMOKE OK' : `SMOKE FAILED: ${dbOk ? 'the log row' : 'the row'} read back differs`);
  } catch (err) {
    console.error('SMOKE FAILED:', (err && err.stack) || err);
  }
  app.exit(code);
}

let mainWindow;

// Damaged files and skipped rows from the import, said once the window is up.
function showImportWarnings() {
  const detail = describeImportWarnings(importReport);
  importReport = null;
  if (!detail || !mainWindow) return;
  dialog.showMessageBox(mainWindow, { type: 'warning', title: 'VENOM Router', message: 'Some saved data could not be imported.', detail });
}

// The renderer's pending saves go out before the window closes or an update
// installs (src/flush.js). One flush per window, shared: a second click on
// the X, or the update path, waits on the same one.
let flushPromise = null;
let flushed = false;
function flushBeforeClose() {
  if (!flushPromise) {
    const asked = mainWindow && !mainWindow.isDestroyed()
      ? requestFlush({ webContents: mainWindow.webContents, ipcMain })
      : Promise.resolve('skipped');
    flushPromise = asked.then((how) => {
      if (how === 'timeout') log.warn('The window did not confirm its pending saves within 2 s; closing anyway');
      saveWindowState();
      flushed = true;
    });
  }
  return flushPromise;
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed() || !store) return;
  try {
    store.repos.settings.set('window', { ...mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() });
  } catch (err) {
    log.warn('Could not save window state:', err.message);
  }
}

// ---------- Dev-only live reload ----------
// Electron reads the renderer's files from disk on every load, so a change to
// styles.css or app.js only needs the page to pick them up again — a restart
// was never the thing that was required. A CSS change is swapped in place so
// the window keeps the page it was showing; a .js or .html change has to
// reload. Only in development: in a packaged build the watcher never starts.
let devWatcher = null;

function watchRendererInDev(win) {
  if (app.isPackaged || devWatcher) return;
  const dir = path.join(__dirname, 'renderer');
  let timer = null;
  let sheets = new Set();
  let needsReload = false;
  try {
    devWatcher = fs.watch(dir, { recursive: true }, (_event, file) => {
      if (!file) return;
      const ext = path.extname(file).toLowerCase();
      // Only the sheet that changed is named: reloading both stylesheets at
      // once wedges the renderer, and fonts.css (nothing but @font-face over
      // bundled files) has no reason to come back when styles.css is edited.
      if (ext === '.css') sheets.add(path.basename(file));
      else if (ext === '.js' || ext === '.html') needsReload = true;
      else return;
      // An editor writes one save as several events; act once it goes quiet.
      clearTimeout(timer);
      timer = setTimeout(() => {
        const changed = [...sheets];
        const reload = needsReload;
        sheets = new Set();
        needsReload = false;
        if (!win || win.isDestroyed()) return;
        if (reload) {
          log.info(`Dev reload (page): ${file}`);
          win.webContents.reload();
          return;
        }
        changed.forEach((name) => {
          log.info(`Dev reload (css): ${name}`);
          win.webContents.send('dev-reload-css', name);
        });
      }, 120);
    });
    log.info('Dev live-reload is watching src/renderer');
  } catch (err) {
    log.warn('Could not watch the renderer folder, live reload is off:', err.message);
  }
}

function createWindow() {
  flushPromise = null;
  flushed = false;
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
  watchRendererInDev(mainWindow);

  // Send app version to renderer after load
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('app-version', app.getVersion());
    showImportWarnings();
  });

  // The X button, Alt+F4 and the title-bar close all land here. The first
  // close waits for the renderer's pending saves (at most 2 s) and the window
  // row, then destroys the window; destroy() does not fire 'close' again.
  mainWindow.on('close', (event) => {
    if (flushed) return;
    event.preventDefault();
    flushBeforeClose().then(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    });
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (devWatcher) {
      devWatcher.close();
      devWatcher = null;
    }
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
    // install-update flushes before quitAndInstall(), which marks the flush
    // done so a second click on the X doesn't wait again. When quitAndInstall
    // itself fails, the app keeps running with flushed stuck true — the next
    // real close would skip the flush and the window row entirely. An update
    // error can only mean the flush already ran for a close that never
    // followed through, so it's always safe to make the next close redo it.
    flushPromise = null;
    flushed = false;
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
  if (!isPrimary) return;
  if (app.commandLine.hasSwitch('smoke-test')) {
    await runSmokeTest();
    return;
  }
  if (!(await startDatabase())) {
    app.quit();
    return;
  }
  // Never throws: a log database that won't open turns logging off.
  startLogs();
  try {
    registerDataIpc({
      ipcMain,
      repos: store.repos,
      databases: { app: store.db, logs: logs && logs.db },
      clipboard,
      log,
      hooks: {
        onSettingsSaved: (saved) => {
          logSettings = readLogSettings(saved);
        },
      },
    });
    registerLogsIpc({ ipcMain, getState: () => ({ logs, error: logsError }), dialog, getWindow: () => mainWindow, log });
    // After both databases and after their IPC, before the window: the catalog
    // writes through repos.snapshots. Disk only at boot — see startCatalog above.
    catalogEngine = startCatalog({
      repos: store.repos,
      log,
      // The roster is the price book now (src/logs/lookups.js reads
      // roster_snapshot), so a write that changes what a model costs must drop
      // the recorder's cached price for it. Ingest is the only writer and this
      // is its only caller, which is why it can be this narrow.
      onRosterWritten: () => { if (priceBook) priceBook.invalidate(); },
    });
    keyResolver = createKeyResolver({ providers: store.repos.providers, secrets: store.repos.secrets });
    initAutoUpdater();
    createWindow();
    startUpdateChecks();
  } catch (err) {
    // No windowless process may stay alive holding venom.db open.
    log.error('Startup failed after opening venom.db:', err);
    showStartupError('VENOM Router could not start, so it will close. Nothing was changed.', err.message);
    stopLogs();
    if (store) {
      store.close();
      store = null;
    }
    app.quit();
  }
});

app.on('will-quit', () => {
  stopUpdateChecks();
  // The request log first, so its queue is flushed before venom.db closes.
  stopLogs();
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

// The taskbar icon in the accent the user picked. The .ico is baked in the
// default accent; the renderer sends the accent's id and the emblem drawn in
// that colour is set from the bundled files. An id not in the list is ignored.
const ACCENT_EMBLEMS = new Set(['emerald', 'cyan', 'violet', 'crimson', 'amber']);
ipcMain.on('set-window-icon', (_event, accentId) => {
  if (!mainWindow || !ACCENT_EMBLEMS.has(accentId)) return;
  const image = nativeImage.createFromPath(path.join(__dirname, 'assets', 'brand', `emblem-${accentId}.png`));
  if (!image.isEmpty()) mainWindow.setIcon(image);
});

// ============================================
// API requests (src/api-request.js)
// ============================================
// Every request the renderer asks for goes out here, key placeholders
// swapped for secrets by keyResolver. Each one is handed to the request log
// once it has finished and its reply is on its way back.
const requester = createApiRequester({
  getResolver: () => keyResolver,
  onFinish: (done) => {
    if (recorder) recorder.record(done);
  },
  log,
});

ipcMain.handle('api-request', (_event, args) => requester.request(args || {}));

// Cancel an in-flight request by id. reason: hedge_lost (a faster attempt
// won), stop (the user), deadline (the adaptive per-kind limit).
ipcMain.on('cancel-api-request', (_event, requestId, reason) => {
  requester.cancel(requestId, reason);
});

// ============================================
// Old request log file (requests.log)
// ============================================
// Requests are recorded in venom-logs.db now (src/logs) and this file is no
// longer written. It stays where it is until the owner clears it, so Settings
// can still show it and delete it.
let requestLogPath;
function getRequestLogPath() {
  if (!requestLogPath) requestLogPath = path.join(app.getPath('userData'), 'requests.log');
  return requestLogPath;
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
  if (!autoUpdater) return;
  // electron-updater starts the installer before the app quits, so the
  // renderer's pending saves are written first.
  flushBeforeClose().then(() => setImmediate(() => autoUpdater.quitAndInstall(true, true)));
});

ipcMain.on('check-for-updates-manual', () => {
  log.info('Manual update check requested');
  checkForUpdates();
});
