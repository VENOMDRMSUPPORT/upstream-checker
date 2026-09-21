# Electron Auto-Update Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Set up complete auto-update infrastructure for Upstream Checker v1.0.0 using electron-updater and GitHub Releases as the update server.

**Architecture:** Install electron-updater, configure electron-builder to auto-publish to GitHub Releases, add update checking and notification UI in the main process, create CHANGELOG.md with v1.0.0 baseline, and test the full update flow. No bug fixes — infrastructure only.

**Tech Stack:** Electron 33, electron-updater 6.x, electron-builder 26.x, GitHub Releases, vanilla JavaScript

**Spec:** This plan establishes auto-update capability for an Electron desktop application. The app is "Upstream Checker" — an AI model provider testing tool. Current version is 1.0.0. Users should receive in-app notifications when new versions are published to GitHub Releases and be able to update with one click. The update system must work for both NSIS installer and portable builds on Windows x64.

## Global Constraints

- Windows 10/11 x64 only
- Electron 33.x (already installed)
- electron-builder 26.x (already installed)
- Must work for both NSIS and portable builds
- No breaking changes to existing UI
- Update checks: on app start + every 2 hours
- CHANGELOG.md must follow Keep a Changelog format
- Semantic versioning (MAJOR.MINOR.PATCH)
- All code in English, comments optional except complex logic
- Git commit messages: conventional commits format

---

### Task 1: Initialize Git Repository and GitHub Setup

**Files:**
- Create: `.gitignore`
- Create: `README.md`
- Modify: None (git init in root)

**Interfaces:**
- Consumes: Nothing
- Produces: Git repository with initial commit, ready for GitHub push

- [ ] **Step 1: Create .gitignore file**

```
# Node
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# Build outputs
dist/
*.exe
*.blockmap
builder-debug.yml

# IDE
.vscode/
.idea/
*.swp
*.swo
*~

# OS
.DS_Store
Thumbs.db

# Environment
.env
.env.local

# Claude Code (keep settings but ignore sensitive data)
.claude/settings.local.json
```

- [ ] **Step 2: Create README.md**

```markdown
# Upstream Checker

Professional AI Model Provider Testing Tool

## Features

- Test multiple AI models across providers
- Support for free and freemium model tiers
- Real-time testing with detailed metrics
- Export results to CSV/JSON
- Beautiful dark theme UI

## Version

**Current:** 1.0.0

## Development

```bash
# Install dependencies
npm install

# Run in development
npm start

# Build installer
npm run build

# Build portable
npm run build:portable
```

## Auto-Updates

This app uses electron-updater to check for updates automatically:
- On startup
- Every 2 hours while running

Updates are published to GitHub Releases.

## License

Proprietary
```

- [ ] **Step 3: Initialize git repository**

Run:
```bash
cd "C:/Users/venom/Desktop/UPSTREAM CHECKER"
git init
git add .gitignore README.md
git commit -m "chore: initial commit with gitignore and readme"
```

Expected: Repository initialized with first commit

- [ ] **Step 4: Add existing source files to git**

Run:
```bash
git add package.json package-lock.json
git add src/
git add scripts/
git commit -m "feat: add upstream checker v1.0.0 source code"
```

Expected: All source files committed

- [ ] **Step 5: Create GitHub repository and push**

**Manual step (user must do this):**
1. Go to https://github.com/new
2. Create repository named `upstream-checker` (public or private)
3. Do NOT initialize with README (we have one)
4. Copy the remote URL

Then run (replace YOUR_USERNAME):
```bash
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/upstream-checker.git
git push -u origin main
```

Expected: Code pushed to GitHub, repository visible online

---

### Task 2: Install and Configure electron-updater

**Files:**
- Modify: `package.json` (add dependency + publish config)
- Create: None

**Interfaces:**
- Consumes: GitHub repository URL from Task 1
- Produces: `package.json` with electron-updater dependency and publish configuration for electron-builder

- [ ] **Step 1: Install electron-updater**

Run:
```bash
cd "C:/Users/venom/Desktop/UPSTREAM CHECKER"
npm install electron-updater@^6.3.0 --save
```

Expected: electron-updater added to dependencies in package.json

- [ ] **Step 2: Configure electron-builder publish settings**

In `package.json`, update the `"build"` section to add `"publish"` configuration. Find the existing build config (starts around line 11) and add the publish key:

```json
{
  "build": {
    "appId": "com.upstream.checker",
    "productName": "Upstream Checker",
    "directories": {
      "output": "dist"
    },
    "publish": {
      "provider": "github",
      "owner": "YOUR_GITHUB_USERNAME",
      "repo": "upstream-checker",
      "releaseType": "release"
    },
    "win": {
      "target": [
        {
          "target": "nsis",
          "arch": ["x64"]
        },
        {
          "target": "portable",
          "arch": ["x64"]
        }
      ],
      "icon": "src/assets/icon.ico",
      "publisherName": "Upstream Checker"
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "allowElevation": true
    },
    "portable": {
      "artifactName": "Upstream Checker - Portable.exe"
    },
    "files": [
      "src/**/*"
    ]
  }
}
```

**Important:** Replace `YOUR_GITHUB_USERNAME` with actual GitHub username

- [ ] **Step 3: Add publish script to package.json**

In the `"scripts"` section of package.json, add:

```json
{
  "scripts": {
    "start": "electron .",
    "build": "electron-builder --win --x64",
    "build:portable": "electron-builder --win portable",
    "publish": "electron-builder --win --x64 --publish always"
  }
}
```

- [ ] **Step 4: Commit configuration changes**

Run:
```bash
git add package.json package-lock.json
git commit -m "feat: add electron-updater and configure auto-publish"
git push
```

Expected: Changes pushed to GitHub

---

### Task 3: Add Update Checking Logic to Main Process

**Files:**
- Modify: `src/main.js` (add auto-updater integration)

**Interfaces:**
- Consumes: electron-updater package from Task 2
- Produces: Update checking on app start, IPC events for renderer: `update-available`, `update-not-available`, `update-downloaded`, `download-progress`

- [ ] **Step 1: Import autoUpdater in main.js**

At the top of `src/main.js` (after line 4), add:

```javascript
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

// Configure logging for updates
log.transports.file.level = 'info';
autoUpdater.logger = log;
```

- [ ] **Step 2: Add update configuration**

After the imports, before `createWindow()` function (around line 6), add:

```javascript
// Auto-updater configuration
autoUpdater.autoDownload = false; // Don't auto-download, ask user first
autoUpdater.autoInstallOnAppQuit = true; // Install when app closes

let updateCheckInterval;
```

- [ ] **Step 3: Add update checking function**

After the `createWindow()` function (around line 30), add:

```javascript
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
  // Check on startup (after 5 seconds to let app settle)
  setTimeout(() => checkForUpdates(), 5000);
  
  // Check every 2 hours
  updateCheckInterval = setInterval(() => checkForUpdates(), 2 * 60 * 60 * 1000);
}

function stopUpdateChecks() {
  if (updateCheckInterval) {
    clearInterval(updateCheckInterval);
    updateCheckInterval = null;
  }
}
```

- [ ] **Step 4: Add autoUpdater event handlers**

After the update checking functions, add:

```javascript
// AutoUpdater events
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
  mainWindow?.webContents.send('update-downloaded', {
    version: info.version,
  });
});
```

- [ ] **Step 5: Add IPC handlers for update actions**

After the existing ipcMain handlers (after line 99), add:

```javascript
// Update control handlers
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
```

- [ ] **Step 6: Start update checks when app is ready**

Modify the `app.whenReady()` call (line 32) to:

```javascript
app.whenReady().then(() => {
  createWindow();
  startUpdateChecks();
});
```

- [ ] **Step 7: Stop update checks on quit**

Before `app.on('window-all-closed'...)` (around line 34), add:

```javascript
app.on('will-quit', () => {
  stopUpdateChecks();
});
```

- [ ] **Step 8: Commit update logic**

Run:
```bash
git add src/main.js
git commit -m "feat: add auto-updater logic to main process"
git push
```

Expected: Update checking implemented in main process

---

### Task 4: Expose Update API to Renderer via Preload

**Files:**
- Modify: `src/preload.js`

**Interfaces:**
- Consumes: IPC channels from Task 3 main.js
- Produces: `window.electronAPI.updateAPI` object with methods: `onUpdateChecking(callback)`, `onUpdateAvailable(callback)`, `onUpdateNotAvailable(callback)`, `onUpdateError(callback)`, `onDownloadProgress(callback)`, `onUpdateDownloaded(callback)`, `downloadUpdate()`, `installUpdate()`, `checkForUpdates()`

- [ ] **Step 1: Add update API to context bridge**

In `src/preload.js`, replace the entire file content with:

```javascript
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  
  // API requests
  apiRequest: (opts) => ipcRenderer.invoke('api-request', opts),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  
  // Update API
  updateAPI: {
    // Listeners (one-way from main to renderer)
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
    
    // Actions (renderer to main)
    downloadUpdate: () => ipcRenderer.send('download-update'),
    installUpdate: () => ipcRenderer.send('install-update'),
    checkForUpdates: () => ipcRenderer.send('check-for-updates-manual'),
  },
});
```

- [ ] **Step 2: Commit preload changes**

Run:
```bash
git add src/preload.js
git commit -m "feat: expose update API to renderer via preload"
git push
```

Expected: Update API available in renderer

---

### Task 5: Create Update Notification UI

**Files:**
- Modify: `src/renderer/index.html` (add update modal HTML)
- Modify: `src/renderer/styles.css` (add update modal styles)

**Interfaces:**
- Consumes: `window.electronAPI.updateAPI` from Task 4
- Produces: HTML modal structure for update notifications with IDs: `update-modal`, `update-modal-version`, `update-modal-notes`, `update-modal-download-btn`, `update-modal-install-btn`, `update-modal-later-btn`, `update-progress-bar`, `update-progress-percent`

- [ ] **Step 1: Add update modal HTML**

In `src/renderer/index.html`, before the closing `</body>` tag (before line 265), add:

```html
  <!-- Update Notification Modal -->
  <div class="modal-overlay" id="update-modal" style="display:none">
    <div class="modal update-modal">
      <div class="modal-header">
        <div class="update-header-content">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="update-icon">
            <path d="M21 12a9 9 0 11-6.219-8.56"/>
            <polyline points="22 2 22 8 16 8"/>
          </svg>
          <h3>Update Available</h3>
        </div>
      </div>
      <div class="modal-body update-modal-body">
        <div class="update-version">
          Version <span id="update-modal-version">-</span>
        </div>
        <div class="update-notes-section">
          <div class="update-notes-label">What's New:</div>
          <div class="update-notes" id="update-modal-notes">
            Loading release notes...
          </div>
        </div>
        <div class="update-progress" id="update-progress" style="display:none">
          <div class="progress-info">
            <span class="progress-label">Downloading update...</span>
            <span class="progress-count" id="update-progress-percent">0%</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill" id="update-progress-bar" style="width: 0%"></div>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="update-modal-later-btn">Remind Later</button>
        <button class="btn btn-primary" id="update-modal-download-btn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          Download Update
        </button>
        <button class="btn btn-accent" id="update-modal-install-btn" style="display:none">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          Install & Restart
        </button>
      </div>
    </div>
  </div>

  <script src="app.js"></script>
```

- [ ] **Step 2: Add update modal styles**

In `src/renderer/styles.css`, at the end of the file (after line 1220), add:

```css
/* ============================================
   Update Modal
   ============================================ */
.update-modal {
  width: 500px;
  max-width: 90vw;
}

.update-header-content {
  display: flex;
  align-items: center;
  gap: 10px;
}

.update-icon {
  color: var(--accent);
}

.update-modal-body {
  padding: 20px;
}

.update-version {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-2);
  margin-bottom: 16px;
}

.update-version span {
  color: var(--accent);
  font-family: 'JetBrains Mono', monospace;
}

.update-notes-section {
  margin-bottom: 16px;
}

.update-notes-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-4);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
}

.update-notes {
  background: var(--bg-3);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-md);
  padding: 12px;
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.6;
  max-height: 200px;
  overflow-y: auto;
}

.update-notes ul {
  list-style: none;
  padding-left: 0;
  margin: 0;
}

.update-notes li {
  padding: 4px 0;
  padding-left: 20px;
  position: relative;
}

.update-notes li::before {
  content: '•';
  position: absolute;
  left: 8px;
  color: var(--accent);
}

.update-progress {
  margin-top: 16px;
}
```

- [ ] **Step 3: Commit UI changes**

Run:
```bash
git add src/renderer/index.html src/renderer/styles.css
git commit -m "feat: add update notification modal UI"
git push
```

Expected: Update modal HTML and styles added

---

### Task 6: Implement Update UI Logic in Renderer

**Files:**
- Modify: `src/renderer/app.js` (add update listeners and handlers)

**Interfaces:**
- Consumes: `window.electronAPI.updateAPI` from Task 4, modal DOM elements from Task 5
- Produces: Functional update flow: modal shows when update available → user downloads → progress bar updates → install button appears → app restarts with new version

- [ ] **Step 1: Add update state variables**

In `src/renderer/app.js`, after the existing state variables (after line 30), add:

```javascript
let updateInfo = null;
let isUpdateDownloading = false;
let isUpdateReady = false;
```

- [ ] **Step 2: Add update modal control functions**

At the end of `src/renderer/app.js` (before the `init()` call around line 765), add:

```javascript
// ============================================
// Update handling
// ============================================
function showUpdateModal(info) {
  updateInfo = info;
  $('#update-modal-version').textContent = info.version;
  
  // Format release notes
  const notesEl = $('#update-modal-notes');
  if (info.releaseNotes) {
    // Handle string or array of release notes
    const notes = Array.isArray(info.releaseNotes) ? info.releaseNotes.join('\n') : info.releaseNotes;
    notesEl.innerHTML = formatReleaseNotes(notes);
  } else {
    notesEl.textContent = 'No release notes available.';
  }
  
  // Reset UI state
  $('#update-progress').style.display = 'none';
  $('#update-modal-download-btn').style.display = '';
  $('#update-modal-install-btn').style.display = 'none';
  $('#update-modal-later-btn').style.display = '';
  
  $('#update-modal').style.display = 'flex';
}

function hideUpdateModal() {
  $('#update-modal').style.display = 'none';
  updateInfo = null;
}

function formatReleaseNotes(notes) {
  // Convert markdown-style lists to HTML
  const lines = notes.split('\n');
  let html = '<ul>';
  
  lines.forEach(line => {
    line = line.trim();
    if (!line) return;
    
    // Remove markdown list markers (-, *, +)
    line = line.replace(/^[-*+]\s+/, '');
    
    // Skip headers
    if (line.startsWith('#')) return;
    
    if (line.length > 0) {
      html += `<li>${escapeHtml(line)}</li>`;
    }
  });
  
  html += '</ul>';
  return html;
}

function showDownloadProgress(percent) {
  $('#update-progress').style.display = '';
  $('#update-progress-bar').style.width = `${percent}%`;
  $('#update-progress-percent').textContent = `${percent}%`;
}

function showInstallButton() {
  $('#update-modal-download-btn').style.display = 'none';
  $('#update-modal-install-btn').style.display = '';
  $('#update-modal-later-btn').style.display = 'none';
  $('#update-progress').style.display = 'none';
}
```

- [ ] **Step 3: Set up update event listeners**

After the update modal functions, add:

```javascript
// Update API listeners
if (window.electronAPI && window.electronAPI.updateAPI) {
  const updateAPI = window.electronAPI.updateAPI;
  
  updateAPI.onUpdateChecking(() => {
    console.log('Checking for updates...');
  });
  
  updateAPI.onUpdateAvailable((info) => {
    console.log('Update available:', info);
    if (!isUpdateDownloading && !isUpdateReady) {
      showUpdateModal(info);
    }
  });
  
  updateAPI.onUpdateNotAvailable(() => {
    console.log('No updates available');
  });
  
  updateAPI.onUpdateError((data) => {
    console.error('Update error:', data.message);
    if (isUpdateDownloading) {
      setStatus('error', 'Update download failed');
      isUpdateDownloading = false;
    }
  });
  
  updateAPI.onDownloadProgress((progress) => {
    showDownloadProgress(progress.percent);
  });
  
  updateAPI.onUpdateDownloaded((info) => {
    console.log('Update downloaded:', info);
    isUpdateDownloading = false;
    isUpdateReady = true;
    showInstallButton();
  });
}
```

- [ ] **Step 4: Add update button event handlers**

After the update listeners, add:

```javascript
// Update modal buttons
$('#update-modal-download-btn')?.addEventListener('click', () => {
  isUpdateDownloading = true;
  $('#update-modal-download-btn').disabled = true;
  $('#update-modal-download-btn').innerHTML = '<span class="spinner"></span> Downloading...';
  window.electronAPI.updateAPI.downloadUpdate();
});

$('#update-modal-install-btn')?.addEventListener('click', () => {
  window.electronAPI.updateAPI.installUpdate();
  // App will quit and install
});

$('#update-modal-later-btn')?.addEventListener('click', () => {
  hideUpdateModal();
  isUpdateDownloading = false;
});

// Close modal on overlay click
$('#update-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'update-modal') {
    hideUpdateModal();
  }
});
```

- [ ] **Step 5: Commit renderer update logic**

Run:
```bash
git add src/renderer/app.js
git commit -m "feat: implement update UI logic in renderer"
git push
```

Expected: Update flow functional in renderer

---

### Task 7: Create CHANGELOG.md

**Files:**
- Create: `CHANGELOG.md`

**Interfaces:**
- Consumes: Nothing
- Produces: `CHANGELOG.md` file following Keep a Changelog format with v1.0.0 baseline entry

- [ ] **Step 1: Write CHANGELOG.md**

```markdown
# Changelog

All notable changes to Upstream Checker will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2025-09-21

### Added
- Initial release of Upstream Checker
- Test AI models from NARA Router provider
- Support for free and freemium model tiers
- Real-time model testing with detailed metrics
- Display test results with pass/fail status, response time, and tokens used
- Export test results to CSV and JSON formats
- Multi-API key management with toggle activation
- Auto-update infrastructure for seamless future updates
- Beautiful enterprise dark theme UI
- Custom window controls (minimize, maximize, close)
- Model filtering: free tier and free-for-paid models
- Support for reasoning models with special handling
- Responsive results table with status indicators
- Progress tracking during batch testing

### Technical
- Built with Electron 33.0.0
- Vanilla JavaScript (no framework dependencies)
- electron-updater integration for auto-updates
- GitHub Releases as update server
- NSIS installer and portable builds for Windows x64

[1.0.0]: https://github.com/YOUR_GITHUB_USERNAME/upstream-checker/releases/tag/v1.0.0
```

**Important:** Replace `YOUR_GITHUB_USERNAME` with actual GitHub username

- [ ] **Step 2: Commit CHANGELOG**

Run:
```bash
git add CHANGELOG.md
git commit -m "docs: add CHANGELOG.md with v1.0.0 baseline"
git push
```

Expected: CHANGELOG.md created and committed

---

### Task 8: Build and Publish v1.0.0 Release

**Files:**
- Modify: None (build process creates dist files)

**Interfaces:**
- Consumes: All previous tasks (configured build, update logic, CHANGELOG)
- Produces: GitHub Release v1.0.0 with NSIS installer and portable exe, auto-update enabled for future versions

- [ ] **Step 1: Clean previous builds**

Run:
```bash
cd "C:/Users/venom/Desktop/UPSTREAM CHECKER"
rm -rf dist/
```

Expected: dist directory removed

- [ ] **Step 2: Set GitHub token for publishing**

**Manual step (user must do this):**
1. Go to https://github.com/settings/tokens
2. Click "Generate new token (classic)"
3. Give it a name: "upstream-checker-publish"
4. Select scopes: `repo` (all sub-scopes)
5. Click "Generate token"
6. Copy the token

Set environment variable (Windows PowerShell):
```powershell
$env:GH_TOKEN="your_github_token_here"
```

Or (Git Bash):
```bash
export GH_TOKEN="your_github_token_here"
```

- [ ] **Step 3: Build and publish to GitHub Releases**

Run:
```bash
npm run publish
```

Expected: 
- Build completes successfully
- Files uploaded to GitHub Releases as draft
- Release tagged as v1.0.0

Output should show:
```
  • building        target=nsis arch=x64
  • building        target=portable arch=x64
  • uploading       file=Upstream Checker Setup 1.0.0.exe
  • uploading       file=Upstream Checker - Portable.exe
  • published to GitHub Releases
```

- [ ] **Step 4: Edit release on GitHub and publish**

**Manual step:**
1. Go to https://github.com/YOUR_USERNAME/upstream-checker/releases
2. Find the draft release v1.0.0
3. Copy content from CHANGELOG.md [1.0.0] section
4. Paste into release description
5. Click "Publish release"

Expected: Release is now public and downloadable

- [ ] **Step 5: Download and test the installer**

1. Download "Upstream Checker Setup 1.0.0.exe" from the release page
2. Run the installer
3. Install the application
4. Launch Upstream Checker
5. Check that titlebar shows "v1.0.0"
6. Application should work normally (add key, fetch models, test)

Expected: App installs and runs correctly

- [ ] **Step 6: Verify update checking is working**

Check the logs to confirm update checks are running:

Windows logs location:
```
%APPDATA%\Upstream Checker\logs\main.log
```

Look for lines like:
```
[2025-09-21] [info] Checking for updates...
[2025-09-21] [info] Update not available. Current version: 1.0.0
```

Expected: Update checks are running (showing "not available" because 1.0.0 is latest)

- [ ] **Step 7: Final commit with build confirmation**

Run:
```bash
git add .
git commit -m "chore: v1.0.0 release published to GitHub"
git push
```

Expected: Repository up to date with release

---

## Self-Review

**1. Spec coverage:**
✅ Git repository initialized and pushed to GitHub
✅ electron-updater installed and configured  
✅ Auto-update checking every 2 hours + on startup
✅ Update notification UI with download progress
✅ CHANGELOG.md created with Keep a Changelog format
✅ electron-builder configured to publish to GitHub Releases
✅ v1.0.0 built and released
✅ No bug fixes included (infrastructure only)

**2. Placeholder scan:**
- "YOUR_GITHUB_USERNAME" appears in Task 1 (README), Task 2 (package.json), Task 7 (CHANGELOG) — this is intentional, user must replace
- "your_github_token_here" in Task 8 — this is intentional, user must provide their own token
- No TBD, TODO, or implementation placeholders present

**3. Type consistency:**
- Update info object: `{ version, releaseNotes, releaseDate }` — consistent across Task 3, 4, 6
- Progress object: `{ percent, transferred, total }` — consistent across Task 3, 4, 6
- IPC channel names match between main.js (Task 3) and preload.js (Task 4)
- DOM element IDs match between index.html (Task 5) and app.js (Task 6)
- Function names consistent: `checkForUpdates()`, `showUpdateModal()`, `hideUpdateModal()`

**4. Gaps found:** None — all requirements covered

---

## Plan Complete ✅

**Plan saved to:** `docs/superpowers/plans/2025-09-21-auto-update-infrastructure.md`

**Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
