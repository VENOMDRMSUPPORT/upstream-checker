# VENOM Router Rebrand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebrand Upstream Checker as VENOM Router — new name, router vocabulary in all user-facing copy, the Viper V logo — without removing any page or losing any user data.

**Architecture:** Copy and asset changes across the Electron shell (index.html, renderer JS), a new pure `src/user-data.js` module that moves the legacy data folder before `app` is ready, and a rewritten icon generator that reads three SVG masters from `src/assets/brand/`.

**Tech Stack:** Electron 33, plain JS renderer, electron-builder (NSIS + portable), sharp (dev) for icons, `node --test` for the one unit-tested module.

**Spec:** `docs/superpowers/specs/2026-09-26-venom-router-rebrand-design.md`

**Execution (chosen by owner):** implemented in this session; each task group is reviewed by a dedicated reviewer subagent before moving on, then a whole-branch review, a leftover-brand hunt and a visual inspection agent at the end.

## Global Constraints

- User-visible name: `VENOM Router` (uppercase `VENOM ROUTER` only where the existing UI is all caps: titlebar, sidebar brand).
- Page names: Model Pool, Route Test, Routing Profiles; nav group Routing; settings sections Model Pool and About VENOM Router; stat label Last test.
- Keep unchanged: `appId` `com.upstream.checker`, `build.publish` repo `upstream-checker`, `scripts/release.mjs` REPO, the release-notes URL in `main.js`, code identifiers (`CATALOG`, `sec-catalog`, page id `check`, `#/check/...`), IPC channels, CSS classes, stored file names.
- Data folder: `%APPDATA%\upstream-checker` → `%APPDATA%\venom-router`; skip migration when `--user-data-dir` is passed.
- Logo: mono masters use `fill="currentColor"` and even-odd holes; app icon = `#00d4ff` mark on `#0b0f17` tile, rx 112/512.
- Everything written to disk is English. No Arabic in files.
- Never launch a test instance against the user's real data folder.

## Review Focus

1. Old version still running while the new one starts → rename fails → app uses the legacy folder and keeps every key (Task 2 test `locked legacy`).
2. Both `upstream-checker` and `venom-router` exist → new folder wins, legacy untouched (Task 2 test `both exist`).
3. Saved hash routes such as `#/check/<providerId>` and `#/settings/catalog` from before the rebrand still open the right page (Task 7 CDP check).
4. A light accent colour or the daylight theme → the brand glyph on the accent square stays visible (Task 7 screenshots with `daylight` + a light accent).
5. The 16 px taskbar/ico frame is a readable V, not mush (Task 1 upscaled 16 px check).

---

### Task 1: Brand masters and icon generator

**Files:**
- Create: `src/assets/brand/mark.svg`, `src/assets/brand/mark-32.svg`, `src/assets/brand/mark-16.svg`
- Modify: `scripts/generate-icons.js` (full rewrite)
- Regenerate: `src/assets/icon-{16,32,48,64,128,256,512}.png`, `src/assets/icon.png`, `src/assets/favicon.png`, `src/assets/icon.ico`

**Interfaces:**
- Produces: the three masters (512 viewBox, one `<path fill="currentColor" fill-rule="evenodd">` each). Task 4 inlines their `d` attributes.

- [ ] **Step 1: Write the masters**

`mark.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <!-- VENOM Router mark: a V whose counter is a viper head with a forked tongue (one request in, routes out). -->
  <path fill="currentColor" fill-rule="evenodd" d="M84 106 L206 106 L226.4 133.9 A8 8 0 0 1 228 138.6 L228 150.2 A6 6 0 0 1 227 153.5 L208.4 182.3 A7 7 0 0 0 208.3 189.8 L250.6 259.1 A3 3 0 0 1 251 260.6 L251 294 L232.5 332 L241.4 332 L256 302 L270.6 332 L279.5 332 L261 294 L261 260.6 A3 3 0 0 1 261.4 259.1 L303.7 189.8 A7 7 0 0 0 303.6 182.3 L285 153.5 A6 6 0 0 1 284 150.2 L284 138.6 A8 8 0 0 1 285.6 133.9 L306 106 L428 106 L262 424 L250 424 Z"/>
</svg>
```
`mark-32.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <!-- 20-48 px master: 16 units per pixel at 32 px, simplified tongue. -->
  <path fill="currentColor" fill-rule="evenodd" d="M80 96 L208 96 L224 128 L224 144 L208 176 L248 248 L248 288 L232.4 320 L250.2 320 L256 308.1 L261.8 320 L279.6 320 L264 288 L264 248 L304 176 L288 144 L288 128 L304 96 L432 96 L264 416 L248 416 Z"/>
</svg>
```
`mark-16.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <!-- 16 px master: 32 units per pixel, neck and head only, no tongue. -->
  <path fill="currentColor" fill-rule="evenodd" d="M96 96 L224 96 L224 160 L192 160 L192 192 L256 256 L320 192 L320 160 L288 160 L288 96 L416 96 L272 416 L240 416 Z"/>
</svg>
```

- [ ] **Step 2: Rewrite `scripts/generate-icons.js`**

```js
// Builds every app icon from the brand masters in src/assets/brand/.
// Small sizes use hand-hinted masters: the full mark's tongue and chamfers
// turn to noise below 64 px.
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const ASSETS = path.join(__dirname, '..', 'src', 'assets');
const BRAND = path.join(ASSETS, 'brand');
const MARK_COLOR = '#00d4ff';
const TILE_COLOR = '#0b0f17';

function markPath(file) {
  const svg = fs.readFileSync(path.join(BRAND, file), 'utf8');
  const d = svg.match(/\sd="([^"]+)"/);
  if (!d) throw new Error(`No path in ${file}`);
  return d[1];
}

// The master for a given pixel size.
function masterFor(size) {
  if (size <= 16) return 'mark-16.svg';
  if (size <= 64) return 'mark-32.svg';
  return 'mark.svg';
}

function tileSVG(size) {
  const d = markPath(masterFor(size));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}">
  <rect width="512" height="512" rx="112" fill="${TILE_COLOR}"/>
  <path fill="${MARK_COLOR}" fill-rule="evenodd" d="${d}"/>
</svg>`;
}

const png = (size) => sharp(Buffer.from(tileSVG(size))).resize(size, size).png().toBuffer();

function buildICO(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = [];
  for (const img of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 0);
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(img.buffer.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += img.buffer.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.buffer)]);
}

async function main() {
  for (const size of [16, 32, 48, 64, 128, 256, 512]) {
    fs.writeFileSync(path.join(ASSETS, `icon-${size}.png`), await png(size));
  }
  fs.writeFileSync(path.join(ASSETS, 'icon.png'), await png(512));
  fs.writeFileSync(path.join(ASSETS, 'favicon.png'), await png(32));
  const ico = [];
  for (const size of [16, 32, 48, 256]) ico.push({ size, buffer: await png(size) });
  fs.writeFileSync(path.join(ASSETS, 'icon.ico'), buildICO(ico));
  console.log('Icons generated from src/assets/brand/.');
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 3: Generate and verify**

Run: `node scripts/generate-icons.js`
Expected: `Icons generated from src/assets/brand/.`
Then verify dimensions and the ICO directory:
```bash
node -e "const s=require('sharp');(async()=>{for(const n of ['icon-16','icon-32','icon-48','icon-256','icon','favicon']){const m=await s('src/assets/'+n+'.png').metadata();console.log(n,m.width+'x'+m.height)}const b=require('fs').readFileSync('src/assets/icon.ico');console.log('ico count',b.readUInt16LE(4),[0,1,2,3].map(i=>b.readUInt8(6+i*16)||256))})()"
```
Expected: `icon-16 16x16`, `icon-32 32x32`, `icon-48 48x48`, `icon-256 256x256`, `icon 512x512`, `favicon 32x32`, `ico count 4 [16,32,48,256]`.
Look at `icon-16.png` upscaled 8x (nearest) and `icon-256.png` with the Read tool: a clear V on the dark tile.

- [ ] **Step 4: Commit**

```bash
git add src/assets/brand scripts/generate-icons.js src/assets/*.png src/assets/icon.ico
git commit -m "feat(brand): Viper V masters and icon generator"
```

---

### Task 2: Data folder migration

**Files:**
- Create: `src/user-data.js`, `test/user-data.test.js`
- Modify: `src/main.js` (top, after the requires), `package.json` (`scripts.test`)

**Interfaces:**
- Produces: `resolveUserDataDir(appData: string, fsLike: {existsSync, renameSync}) → { dir: string, migrated: boolean, error?: Error }`, plus `LEGACY_DIR = 'upstream-checker'`, `CURRENT_DIR = 'venom-router'`.

- [ ] **Step 1: Write the failing test** — `test/user-data.test.js`

```js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { resolveUserDataDir } = require('../src/user-data');

const APP = 'C:\\Users\\u\\AppData\\Roaming';
const LEGACY = path.join(APP, 'upstream-checker');
const TARGET = path.join(APP, 'venom-router');

function fakeFs(existing, { renameThrows = false } = {}) {
  const set = new Set(existing);
  const calls = [];
  return {
    calls,
    existsSync: (p) => set.has(p),
    renameSync: (from, to) => {
      calls.push([from, to]);
      if (renameThrows) { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; }
      set.delete(from); set.add(to);
    },
  };
}

test('fresh install uses the new folder and renames nothing', () => {
  const fs = fakeFs([]);
  assert.deepStrictEqual(resolveUserDataDir(APP, fs), { dir: TARGET, migrated: false });
  assert.strictEqual(fs.calls.length, 0);
});

test('legacy only is moved to the new folder', () => {
  const fs = fakeFs([LEGACY]);
  assert.deepStrictEqual(resolveUserDataDir(APP, fs), { dir: TARGET, migrated: true });
  assert.deepStrictEqual(fs.calls, [[LEGACY, TARGET]]);
});

test('both exist: the new folder wins and legacy is untouched', () => {
  const fs = fakeFs([LEGACY, TARGET]);
  assert.deepStrictEqual(resolveUserDataDir(APP, fs), { dir: TARGET, migrated: false });
  assert.strictEqual(fs.calls.length, 0);
});

test('locked legacy (old version running) keeps using the legacy folder', () => {
  const fs = fakeFs([LEGACY], { renameThrows: true });
  const r = resolveUserDataDir(APP, fs);
  assert.strictEqual(r.dir, LEGACY);
  assert.strictEqual(r.migrated, false);
  assert.strictEqual(r.error.code, 'EBUSY');
});
```
Add to `package.json` scripts: `"test": "node --test test/"`.

- [ ] **Step 2: Run it to see it fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/user-data'`.

- [ ] **Step 3: Implement `src/user-data.js`**

```js
// Where the app keeps its data. Electron names the userData folder after the
// package, and the package was renamed from upstream-checker to venom-router, so
// without this the app would open empty — and the encrypted API keys would stop
// decrypting, because safeStorage's master key lives in `Local State` inside
// that folder. The old folder is moved over whole, once. DPAPI ties that key to
// the Windows user, not to the path, so the keys survive the move.
const path = require('path');

const LEGACY_DIR = 'upstream-checker';
const CURRENT_DIR = 'venom-router';

function resolveUserDataDir(appData, fsLike) {
  const target = path.join(appData, CURRENT_DIR);
  const legacy = path.join(appData, LEGACY_DIR);
  if (fsLike.existsSync(target) || !fsLike.existsSync(legacy)) return { dir: target, migrated: false };
  try {
    fsLike.renameSync(legacy, target);
    return { dir: target, migrated: true };
  } catch (error) {
    // Held open — usually an older version still running. Keep using it; the
    // move is tried again on the next launch.
    return { dir: legacy, migrated: false, error };
  }
}

module.exports = { resolveUserDataDir, LEGACY_DIR, CURRENT_DIR };
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: 4 passing, 0 failing.

- [ ] **Step 5: Wire it into `src/main.js`** — directly after the `require('./keystore')` block and before `let autoUpdater;`:

```js
const { resolveUserDataDir } = require('./user-data');

// Settled before anything reads a path or writes a log. An explicit
// --user-data-dir (dev and test instances) is used as given.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  const userData = resolveUserDataDir(app.getPath('appData'), fs);
  app.setPath('userData', userData.dir);
  if (userData.migrated) log.info('Moved app data to', userData.dir);
  if (userData.error) log.warn('Could not move the old app data folder, still using it:', userData.error.message);
}
```

- [ ] **Step 6: Check syntax and commit**

Run: `node --check src/main.js && node --check src/user-data.js && npm test`
Expected: no output from the checks; 4 passing.
```bash
git add src/user-data.js test/user-data.test.js src/main.js package.json
git commit -m "feat: move app data from upstream-checker to venom-router on first launch"
```

---

### Task 3: Package metadata

**Files:**
- Modify: `package.json`, `package-lock.json` (the two top-level `name` fields only), `src/main.js:274` (User-Agent)

- [ ] **Step 1: Edit `package.json`**

- `"name": "venom-router"`
- `"description": "LLM model router — one endpoint across every provider and key"`
- `build.productName`: `"VENOM Router"`
- `build.nsis.artifactName`: `"VENOM-Router-Setup-${version}.exe"`
- `build.portable.artifactName`: `"VENOM Router - Portable.exe"`
- Leave `build.appId` and `build.publish` exactly as they are.

- [ ] **Step 2: Edit `package-lock.json`** — the root `"name"` and `packages[""].name` → `"venom-router"`.

- [ ] **Step 3: `src/main.js`** — in the release-notes request, `'User-Agent': 'Upstream-Checker'` → `'User-Agent': 'VENOM-Router'`. Leave the URL's repo as is.

- [ ] **Step 4: Verify**

Run: `node -e "const p=require('./package.json');console.log(p.name,'|',p.build.productName,'|',p.build.appId,'|',p.build.publish.repo,'|',p.build.nsis.artifactName)" && npm ls --depth=0`
Expected: `venom-router | VENOM Router | com.upstream.checker | upstream-checker | VENOM-Router-Setup-${version}.exe`, and `npm ls` exits 0.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/main.js
git commit -m "chore: package as VENOM Router (repo and appId unchanged for updates)"
```

---

### Task 4: Shell branding and logo in index.html

**Files:**
- Modify: `src/renderer/index.html`, `src/renderer/styles.css` (banner comment; brand-mark sizing only if the new glyph needs it)

**Interfaces:**
- Consumes: `d` of `mark-32.svg` (titlebar, sidebar) and `mark.svg` (About) from Task 1.

- [ ] **Step 1: Titlebar** — `<title>Upstream Checker</title>` → `<title>VENOM Router</title>`. Replace the titlebar icon's stacked-layers SVG with:
```html
<svg width="18" height="18" viewBox="0 0 512 512" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M80 96 L208 96 L224 128 L224 144 L208 176 L248 248 L248 288 L232.4 320 L250.2 320 L256 308.1 L261.8 320 L279.6 320 L264 288 L264 248 L304 176 L288 144 L288 128 L304 96 L432 96 L264 416 L248 416 Z"/></svg>
```
`UPSTREAM CHECKER` → `VENOM ROUTER`.

- [ ] **Step 2: Sidebar brand** — replace the `.shell-brand-mark` SVG with the same `mark-32` path at `width="20" height="20"`; `UPSTREAM` → `VENOM`, `CHECKER` → `ROUTER`.

- [ ] **Step 3: Nav** — `Model catalog` → `Model Pool`; group label `Testing` → `Routing`; `Upstream Check` → `Route Test`; `Venom Profiles` → `Routing Profiles`. Comment "opens Upstream Check" → "opens Route Test". Quick stats `Last Check` → `Last test`. Overview KPI label `Last check` → `Last test`.

- [ ] **Step 4: Settings** — nav `Model Catalog` → `Model Pool`, `About Upstream` → `About VENOM Router`. `<!-- Model Catalog -->` → `<!-- Model Pool -->`. Model Pool note: "The catalogue re-reads" → "The model pool re-reads". Zone: `Clear catalogue data` → `Clear model pool data`; "or the whole catalogue" → "or the whole model pool"; `Reset catalogue` → `Reset model pool`.

- [ ] **Step 5: About** — replace the About mark SVG with the full `mark.svg` path at `width="34" height="34"`; `Upstream Checker` → `VENOM Router`; the About note paragraph becomes: `Routes every request to the best model across your providers, chosen from measurements taken on your own keys &mdash; not from marketing claims.`

- [ ] **Step 6: styles.css** — banner `UPSTREAM CHECKER — Enterprise Dark Theme` → `VENOM ROUTER — Enterprise Dark Theme`; comment `Upstream Check — inner sidebar` → `Route Test — inner sidebar`.

- [ ] **Step 7: Verify and commit**

Run: `grep -n -i -E "upstream|checker|catalogue|model catalog" src/renderer/index.html`
Expected: only `data-page="catalog"`, `sec-catalog`, `set-catalog-*`, `btn-catalog-*`, `page-catalog`, `catalog.js` and the `upstream` word inside unrelated comments (none expected).
```bash
git add src/renderer/index.html src/renderer/styles.css
git commit -m "feat(brand): VENOM Router shell, nav vocabulary and logo"
```

---

### Task 5: Renderer copy in JS

**Files:**
- Modify: `src/renderer/app.js`, `src/renderer/catalog.js`, `src/renderer/profiles.js`

- [ ] **Step 1: app.js**
- Banner: `// UPSTREAM CHECKER — Application Logic v2` → `// VENOM ROUTER — Application Logic v2`.
- `exportFilename`: `` `upstream-${slug}-${stamp}.${ext}` `` → `` `venom-router-${slug}-${stamp}.${ext}` ``.
- `SETTINGS_SECTIONS_META['sec-catalog']` → `{ label: 'Model Pool', desc: 'How the model pool syncs, benchmarks and ranks models' }`; `'sec-about'` → `{ label: 'About VENOM Router', desc: 'Version, providers and updates' }`.
- `PAGE_META`:
  - `overview.desc`: `'Routing health — providers, models and test activity at a glance.'`
  - `catalog`: `{ title: 'Model Pool', desc: 'Every model your connected providers offer — the pool the router draws from, kept live, benchmarked and ranked against the global leaderboard.' }`
  - `profiles`: `{ title: 'Routing Profiles', desc: 'Three virtual models — Lite, Pro, Max — that route each request to the best real model in the pool by measured intelligence, speed, reliability and cost.' }`
  - `check`: `{ title: 'Route Test', desc: 'Test every route a provider offers against one prompt.' }`
- `document.title = \`${meta.title} — Upstream Checker\`` → `— VENOM Router`.
- `Open Upstream Check` (overview empty state) → `Open Route Test`.
- Both `title="Open in Upstream Check" aria-label="Open in Upstream Check"` → `Open in Route Test`.

- [ ] **Step 2: catalog.js**
- Line 743: "test it from Upstream Check." → "test it from Route Test."
- Breadcrumb `{ label: 'Model Catalog', icon: 'catalog' }` → `{ label: 'Model Pool', icon: 'catalog' }`.
- Empty state: "The catalogue lists the models…" → "The model pool lists the models…".
- `'Catalogue reset — re-syncing'` → `'Model pool reset — re-syncing'`.

- [ ] **Step 3: profiles.js**
- `generator: 'Upstream Checker'` → `generator: 'VENOM Router'`.
- `'No models in the catalogue.'` → `'No models in the pool.'`.
- Breadcrumb `{ label: 'Profiles', icon: 'profiles' }` → `{ label: 'Routing Profiles', icon: 'profiles' }`.
- "Profiles are built from the Model Catalog, which is empty until a provider has a key." → "Profiles route through the Model Pool, which is empty until a provider has a key."
- "measured against your own keys by the Model Catalog benchmark" → "measured against your own keys by the Model Pool benchmark".

- [ ] **Step 4: Verify and commit**

Run: `for f in src/renderer/app.js src/renderer/catalog.js src/renderer/profiles.js; do node --check "$f"; done` — no output.
Run: `git grep -n -E "Upstream Check|Upstream Checker|Model Catalog|[Cc]atalogue[^s]" -- src/renderer/*.js` and confirm every remaining hit is a `//` or `/* */` comment.
```bash
git add src/renderer/app.js src/renderer/catalog.js src/renderer/profiles.js
git commit -m "feat(brand): router vocabulary in renderer copy"
```

---

### Task 6: Docs

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: README** — title `# VENOM Router`; intro: "Desktop LLM model router for Windows. Connect your providers and API keys, keep a live pool of every model they offer, measure each one for real, and route requests through `venom-lite`, `venom-pro` and `venom-max` to the best model for the job." Feature names: `Model testing` → `Route testing`, `Model catalog` → `Model pool`, `Venom profiles` → `Routing profiles`. Replace any other "Upstream Checker" with "VENOM Router". Add a line under the version: "Formerly Upstream Checker — existing installs update in place and keep their data."

- [ ] **Step 2: CHANGELOG** — header line → "All notable changes to VENOM Router (formerly Upstream Checker) will be documented in this file." Under `## [Unreleased]`:
```markdown
### Changed
- Upstream Checker is now **VENOM Router**, an LLM model router. The app has a
  new name, a new logo (the Viper V) and router vocabulary throughout: Model
  catalog is now Model Pool, Upstream Check is Route Test, and Venom Profiles
  are Routing Profiles. No page, feature or setting was removed.
- App data moves from `%APPDATA%\upstream-checker` to `%APPDATA%\venom-router`
  on first launch, keys and history included. If an older version is still
  running, the old folder is kept in use and the move is tried again next time.
- Installers are named `VENOM-Router-Setup-<version>.exe` and
  `VENOM Router - Portable.exe`. Existing installs keep updating in place.
```

- [ ] **Step 3: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: VENOM Router rebrand in README and CHANGELOG"
```

---

### Task 7: Live verification

**Files:** scratch only under `tmp/` (deleted at the end).

- [ ] **Step 1: Scratch data folder** — copy `%APPDATA%\upstream-checker` to `%TEMP%\venom-router-verify` excluding cache folders (`Cache`, `Code Cache`, `GPUCache`, `Dawn*`, `DevToolsActivePort`). Never read the files' contents.

- [ ] **Step 2: Launch** — `npx electron . --user-data-dir="%TEMP%\venom-router-verify" --remote-debugging-port=9333 --disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding`, and confirm the process command line contains `9333`.

- [ ] **Step 3: CDP script** (`tmp/verify-rebrand.mjs`, Node 24 global fetch + WebSocket, a timeout on every call, `Browser.close` in `finally`):
  - Assert `document.title` ends with `— VENOM Router`, `.titlebar-text` is `VENOM ROUTER`, brand text is `VENOM`/`ROUTER`.
  - Assert nav labels in order: Overview, Providers, Model Pool, Route Test, Routing Profiles, Test History, Monitoring, Settings.
  - Set `location.hash = '#/check'` and `'#/settings/catalog'` → assert the page title shows Route Test / the Model Pool section (Review Focus 3).
  - Screenshot each page (overview, providers, catalog, check, profiles, settings → Model Pool, settings → About) at 1400x900 in the dark theme; then `settings.theme='daylight'; applyAppearance()` plus a light accent (`setAccent` is persistent — instead set `document.documentElement.style.setProperty('--accent', '#a3e635')`) and screenshot overview + About (Review Focus 4). Restore in-page state afterwards.
  - Assert `document.body.innerText` has no `Upstream`, `Checker` or `catalogue` (case-insensitive).

- [ ] **Step 4: Reviews (dedicated subagents)** — (a) code reviewer on `git diff 42f76c6..HEAD`; (b) leftover-brand hunter over the whole repo; (c) visual inspector reading every screenshot and the generated icons. Fix findings, re-run Steps 3–4 until clean.

- [ ] **Step 5: Clean up** — kill only the 9333 instance, delete `%TEMP%\venom-router-verify`, `tmp/verify-rebrand.mjs`, screenshots, and `tmp/logo-lab/`.
