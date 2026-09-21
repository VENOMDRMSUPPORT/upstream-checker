# Data-Driven Multi-Provider Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Initialize the config file on first launch and make providers data-driven so OpenAI-compatible providers can be added from the UI without code changes.

**Architecture:** Built-in providers stay as immutable code templates (`BUILTIN_PROVIDERS`). The config file (`config.json` in Electron `userData`) stores per-provider user data (keys, baseUrl overrides) plus full definitions for user-added custom providers. At startup the runtime `PROVIDERS` map is built by merging built-in templates (hydrated from config) with custom providers from config. nara's free/freemium plan filtering is gated behind the presence of a `plansUrl`.

**Tech Stack:** Electron 33, vanilla JS (no framework), Node `fs`/`https` in the main process, IPC via a `contextBridge` preload.

**Spec:** [docs/superpowers/specs/2026-09-22-data-driven-providers-design.md](../specs/2026-09-22-data-driven-providers-design.md)

## Global Constraints

- Everything written to disk stays in English (code, comments, config, docs).
- No test framework exists; verification is manual via `npm start` or a Node one-liner. Each task still ends with a commit.
- Config schema version is `1`. Default config is exactly `{ "version": 1, "providers": {} }`.
- All providers are assumed OpenAI-compatible: `GET /models`, `POST /chat/completions`.
- Keep the runtime map named `PROVIDERS` to minimize churn across existing references.
- Follow existing code style: 2-space indent, single quotes, no semicolon-free style (semicolons used).

---

### Task 0: Commit the pending bug fixes

Two already-approved fixes are uncommitted in the working tree (modal Cancel button listener + CSV `group` column). Commit them so feature work starts from a clean tree.

**Files:**
- Modify: `src/renderer/app.js` (already edited)

- [ ] **Step 1: Confirm the working-tree changes are only the two bug fixes**

Run: `git diff --stat`
Expected: only `src/renderer/app.js` shown as modified.

- [ ] **Step 2: Commit**

```bash
git add src/renderer/app.js
git commit -m "fix: wire modal Cancel button and correct CSV plan column"
```

---

### Task 1: Config scaffolding in the main process

Make the config file exist from first launch with the versioned skeleton, and make reads robust.

**Files:**
- Modify: `src/main.js` (config helpers near lines 10-46; `app.whenReady` near lines 170-174)

**Interfaces:**
- Produces: `getDefaultConfig()` → `{ version: 1, providers: {} }`; `ensureConfig()` (writes default if file missing); `readConfig()` returns an object that always has `version` (number) and `providers` (object).

- [ ] **Step 1: Add the version constant and default-config helper**

In `src/main.js`, just above `getConfigPath()` (after the `let configPath;` line ~10), add:

```javascript
const CONFIG_VERSION = 1;

function getDefaultConfig() {
  return { version: CONFIG_VERSION, providers: {} };
}
```

- [ ] **Step 2: Make `readConfig()` robust and self-healing**

Replace the body of `readConfig()` so a missing file is created, and a file missing `version`/`providers` is normalized:

```javascript
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
```

- [ ] **Step 3: Add `ensureConfig()` and call it on startup**

Add this helper next to the other config helpers:

```javascript
function ensureConfig() {
  const cp = getConfigPath();
  if (!fs.existsSync(cp)) writeConfig(getDefaultConfig());
}
```

Then in `app.whenReady().then(() => { ... })`, add `ensureConfig();` as the first line inside the callback (before `initAutoUpdater();`).

- [ ] **Step 4: Verify the file is created on first launch**

Delete any existing config first, then launch:

Run: `rm -f "$APPDATA/upstream-checker/config.json"; npm start`
(Windows bash: `$APPDATA` resolves to the Roaming path; the app's `userData` dir is `%APPDATA%/upstream-checker`.)

Expected: after the window opens, the file exists. Verify in a second terminal:
Run: `cat "$APPDATA/upstream-checker/config.json"`
Expected output: `{ "version": 1, "providers": {} }` (pretty-printed). Close the app.

- [ ] **Step 5: Commit**

```bash
git add src/main.js
git commit -m "feat: scaffold versioned config file on first launch"
```

---

### Task 2: Split built-in templates and build the runtime provider map

Introduce `BUILTIN_PROVIDERS` as the code-defined templates and construct the runtime `PROVIDERS` map at init by merging config over the templates. nara behavior must be unchanged.

**Files:**
- Modify: `src/renderer/app.js` (provider definition ~15-29; `saveProviderConfig`/`loadProviderConfig` ~48-64; `init` ~928-939)

**Interfaces:**
- Consumes: `window.electronAPI.readConfig()` / `writeConfig(data)`.
- Produces: `BUILTIN_PROVIDERS` (const templates); runtime `PROVIDERS` (object keyed by id); `loadAllProviders()` (async, hydrates `PROVIDERS`); `saveProviderConfig(id)` persisting keys + baseUrl (+ custom definition fields when `custom`).

- [ ] **Step 1: Rename the hardcoded object to `BUILTIN_PROVIDERS` and add a runtime map**

Replace the `const PROVIDERS = { nara: {...} };` block (~15-29) with:

```javascript
// Built-in provider templates — code-defined, never mutated
const BUILTIN_PROVIDERS = {
  nara: {
    id: 'nara',
    name: 'NARA Router',
    baseUrl: 'https://router.bynara.id/v1',
    plansUrl: 'https://router.bynara.id/api/plans',
    color: '#00d4ff',
    modelsEndpoint: '/models',
    plansEndpoint: '/api/plans',
    chatEndpoint: '/chat/completions',
  },
};

const CUSTOM_COLORS = ['#7b2ff7', '#00e0a4', '#ff6b6b', '#ffb020', '#4dabf7', '#e64980'];

// Runtime provider map — built at init from BUILTIN_PROVIDERS + config
let PROVIDERS = {};

function makeRuntimeProvider(def) {
  return { models: [], planModels: {}, keys: [], ...structuredClone(def) };
}
```

- [ ] **Step 2: Replace `loadProviderConfig` with `loadAllProviders`**

Replace `saveProviderConfig` and `loadProviderConfig` (~48-64) with:

```javascript
async function saveProviderConfig(providerId) {
  const p = PROVIDERS[providerId];
  if (!p) return;
  const data = await window.electronAPI.readConfig();
  if (!data.providers) data.providers = {};
  const entry = { keys: p.keys, baseUrl: p.baseUrl };
  if (p.custom) {
    entry.custom = true;
    entry.name = p.name;
    entry.color = p.color;
  }
  data.providers[providerId] = entry;
  await window.electronAPI.writeConfig(data);
}

async function loadAllProviders() {
  let stored = {};
  try {
    const data = await window.electronAPI.readConfig();
    stored = data.providers || {};
  } catch (_) {}

  PROVIDERS = {};

  // Built-ins first, hydrated from config
  Object.values(BUILTIN_PROVIDERS).forEach((def) => {
    const p = makeRuntimeProvider(def);
    const s = stored[def.id];
    if (s) {
      p.keys = s.keys || [];
      if (s.baseUrl) p.baseUrl = s.baseUrl;
    }
    PROVIDERS[def.id] = p;
  });

  // Custom providers from config
  Object.entries(stored).forEach(([id, s]) => {
    if (!s.custom || PROVIDERS[id]) return;
    PROVIDERS[id] = makeRuntimeProvider({
      id,
      name: s.name || id,
      baseUrl: s.baseUrl || '',
      color: s.color || CUSTOM_COLORS[0],
      custom: true,
    });
    PROVIDERS[id].keys = s.keys || [];
  });
}
```

- [ ] **Step 3: Update `init()` to load all providers and pick a valid active one**

Replace the top of `init()` (~928-931):

```javascript
async function init() {
  await loadAllProviders();
  if (!PROVIDERS[activeProvider]) {
    activeProvider = Object.keys(PROVIDERS)[0];
  }
  const p = PROVIDERS[activeProvider];
  $('#base-url').value = p.baseUrl;
```

Leave the rest of `init()` unchanged.

- [ ] **Step 4: Verify nara still works and persists**

Run: `npm start`
Expected: nara tab shows; add a key, activate it, fetch models (free/freemium list appears as before), close the app, reopen. The key is still present and active. Confirm config on disk now has a `providers.nara` entry:
Run: `cat "$APPDATA/upstream-checker/config.json"`
Expected: `providers.nara.keys` has your key; `version` is `1`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/app.js
git commit -m "feat: build runtime providers from built-in templates + config"
```

---

### Task 3: Add and remove custom providers from the UI

Add the "+ Add Provider" control, a modal, a delete affordance on custom tabs, and the `addProvider`/`removeProvider` logic.

**Files:**
- Modify: `src/renderer/app.js` (`renderProviderTabs` ~76-87; add new functions; modal wiring near the Add Key modal ~902-923)
- Modify: `src/renderer/index.html` (add an "Add Provider" modal near the Add Key modal ~246-272)
- Modify: `src/renderer/styles.css` (small styles for the add-provider tab button and delete ×)

**Interfaces:**
- Consumes: `PROVIDERS`, `CUSTOM_COLORS`, `saveProviderConfig(id)`, `switchProvider(id)`, `renderProviderTabs()`, `setStatus(state, text)`.
- Produces: `addProvider({ name, baseUrl })` (async); `removeProvider(id)` (async).

- [ ] **Step 1: Add the Add Provider modal to the HTML**

In `src/renderer/index.html`, after the Add Key modal block (closing `</div>` of `#add-key-modal`, ~line 272), insert:

```html
  <!-- Add Provider Modal -->
  <div class="modal-overlay" id="add-provider-modal" style="display:none">
    <div class="modal">
      <div class="modal-header">
        <h3>Add Provider</h3>
        <button class="modal-close" id="provider-modal-close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="config-group">
          <label class="config-label">Provider Name</label>
          <input type="text" class="config-input" id="provider-name-input" placeholder="e.g. OpenRouter">
        </div>
        <div class="config-group">
          <label class="config-label">Base URL (OpenAI-compatible)</label>
          <input type="text" class="config-input" id="provider-url-input" placeholder="https://api.example.com/v1">
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="provider-modal-cancel">Cancel</button>
        <button class="btn btn-primary" id="provider-modal-add">Add Provider</button>
      </div>
    </div>
  </div>
```

- [ ] **Step 2: Render the "+ Add Provider" button and custom-tab delete in `renderProviderTabs`**

Replace `renderProviderTabs` (~76-87) with:

```javascript
function renderProviderTabs() {
  const container = $('#provider-tabs');
  container.innerHTML = '';
  Object.values(PROVIDERS).forEach((p) => {
    const btn = document.createElement('button');
    btn.className = `provider-btn ${p.id === activeProvider ? 'active' : ''}`;
    btn.dataset.provider = p.id;
    let inner = `<span class="provider-dot" style="background:${p.color}"></span>${escapeHtml(p.name)}`;
    if (p.custom) {
      inner += `<span class="provider-delete" data-provider="${p.id}" title="Remove provider">&times;</span>`;
    }
    btn.innerHTML = inner;
    btn.addEventListener('click', () => switchProvider(p.id));
    container.appendChild(btn);
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'provider-btn provider-add';
  addBtn.title = 'Add provider';
  addBtn.innerHTML = '+';
  addBtn.addEventListener('click', () => {
    $('#add-provider-modal').style.display = 'flex';
    setTimeout(() => $('#provider-name-input').focus(), 100);
  });
  container.appendChild(addBtn);

  $$('.provider-delete').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      removeProvider(el.dataset.provider);
    });
  });
}
```

- [ ] **Step 3: Implement `addProvider` and `removeProvider`**

Add these functions directly below `renderProviderTabs`:

```javascript
async function addProvider({ name, baseUrl }) {
  name = (name || '').trim();
  baseUrl = (baseUrl || '').trim().replace(/\/$/, '');

  if (!name || !baseUrl) {
    setStatus('error', 'Provider name and Base URL are required');
    return false;
  }
  try {
    new URL(baseUrl);
  } catch (_) {
    setStatus('error', 'Base URL is not a valid URL');
    return false;
  }
  const dupe = Object.values(PROVIDERS).some(
    (p) => p.name.toLowerCase() === name.toLowerCase()
  );
  if (dupe) {
    setStatus('error', `A provider named "${name}" already exists`);
    return false;
  }

  const id = `prov_${Date.now()}`;
  const color = CUSTOM_COLORS[Object.keys(PROVIDERS).length % CUSTOM_COLORS.length];
  PROVIDERS[id] = makeRuntimeProvider({ id, name, baseUrl, color, custom: true });
  await saveProviderConfig(id);
  switchProvider(id);
  setStatus('done', `Provider "${name}" added`);
  return true;
}

async function removeProvider(id) {
  const p = PROVIDERS[id];
  if (!p || !p.custom) return;
  delete PROVIDERS[id];
  const data = await window.electronAPI.readConfig();
  if (data.providers) delete data.providers[id];
  await window.electronAPI.writeConfig(data);
  if (activeProvider === id) activeProvider = Object.keys(PROVIDERS)[0];
  switchProvider(activeProvider);
  setStatus('done', `Provider "${p.name}" removed`);
}
```

- [ ] **Step 4: Wire the Add Provider modal buttons**

In the modal-wiring area (near the Add Key modal handlers ~902-923), add:

```javascript
function closeAddProviderModal() {
  $('#add-provider-modal').style.display = 'none';
  $('#provider-name-input').value = '';
  $('#provider-url-input').value = '';
}

$('#provider-modal-close').addEventListener('click', closeAddProviderModal);
$('#provider-modal-cancel').addEventListener('click', closeAddProviderModal);
$('#provider-modal-add').addEventListener('click', async () => {
  const ok = await addProvider({
    name: $('#provider-name-input').value,
    baseUrl: $('#provider-url-input').value,
  });
  if (ok) closeAddProviderModal();
});
$('#add-provider-modal').addEventListener('click', (e) => {
  if (e.target.id === 'add-provider-modal') closeAddProviderModal();
});
```

- [ ] **Step 5: Add minimal styles**

In `src/renderer/styles.css`, append:

```css
.provider-btn.provider-add {
  justify-content: center;
  font-size: 16px;
  font-weight: 600;
  min-width: 34px;
  opacity: 0.7;
}
.provider-btn.provider-add:hover { opacity: 1; }
.provider-delete {
  margin-left: 6px;
  font-size: 14px;
  line-height: 1;
  opacity: 0.5;
  padding: 0 2px;
}
.provider-delete:hover { opacity: 1; color: var(--fail, #ff6b6b); }
```

- [ ] **Step 6: Verify add/remove/persist**

Run: `npm start`
Expected: a "+" tab appears after nara. Click it, add `{ name: "Test", baseUrl: "https://example.com/v1" }`. A new tab appears and becomes active, base URL field shows the URL. Reopen the app → the Test provider is still there. Click the × on the Test tab → it is removed and the active tab falls back to nara. Reopen → Test stays gone.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/app.js src/renderer/index.html src/renderer/styles.css
git commit -m "feat: add and remove custom providers from the UI"
```

---

### Task 4: Branch model fetching and rendering on `plansUrl`

Providers without a `plansUrl` (all custom ones) must show every `/models` entry under one generic group instead of the nara-only FREE / FREE FOR PAID grouping.

**Files:**
- Modify: `src/renderer/app.js` (`#btn-fetch-models` handler ~270-356; `renderModelsList` ~368-410; `buildRowHtml` plan icon ~632-635)

**Interfaces:**
- Consumes: `PROVIDERS[activeProvider]` with optional `plansUrl`; `formatContext`, `buildModelItem`, `getFreeGroupName`.
- Produces: model objects that, for providers without `plansUrl`, have `isFree: false`, `isFreeForPaid: false`, `groupName: 'MODELS'`, and a truthy `noPlans` flag used by rendering.

- [ ] **Step 1: Branch the fetch handler on `plansUrl`**

In the `#btn-fetch-models` click handler, replace the section that fetches plans and builds `models` (the `Promise.all` through the `.sort(...)`, ~286-339) with:

```javascript
    if (p.plansUrl) {
      // Plan-aware provider (e.g. nara): fetch models + plans, keep only free tiers
      const [modelsResult, plansResult] = await Promise.all([
        window.electronAPI.apiRequest({
          url: `${p.baseUrl}/models`,
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        }),
        window.electronAPI.apiRequest({
          url: p.plansUrl,
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        }),
      ]);

      if (modelsResult.status !== 200) throw new Error(`HTTP ${modelsResult.status}`);
      const rawModels = JSON.parse(modelsResult.body).data || [];

      let planModels = {};
      if (plansResult.status === 200) {
        JSON.parse(plansResult.body).data?.forEach((plan) => {
          planModels[plan.code] = { name: plan.name, models: plan.models || [] };
        });
      }

      const freeIds = new Set(planModels['free']?.models || []);
      const freemiumIds = new Set(planModels['freemium']?.models || []);
      const allowedIds = new Set([...freeIds, ...freemiumIds]);

      models = rawModels
        .filter((m) => allowedIds.has(m.id))
        .map((m) => {
          const isFree = freeIds.has(m.id);
          const isFreeForPaid = !isFree && freemiumIds.has(m.id);
          return {
            ...m,
            isFree,
            isFreeForPaid,
            noPlans: false,
            groupName: getFreeGroupName(isFree ? 'free' : 'freemium'),
            hasVision: !!m.vision,
            hasReasoning: !!m.reasoning,
            contextLabel: formatContext(m.context_window),
          };
        })
        .sort((a, b) => {
          if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
          return a.id.localeCompare(b.id);
        });

      p.planModels = planModels;
    } else {
      // Plain OpenAI-compatible provider: show all models, no plan filtering
      const modelsResult = await window.electronAPI.apiRequest({
        url: `${p.baseUrl}/models`,
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      });
      if (modelsResult.status !== 200) throw new Error(`HTTP ${modelsResult.status}`);
      const rawModels = JSON.parse(modelsResult.body).data || [];

      models = rawModels
        .map((m) => ({
          ...m,
          isFree: false,
          isFreeForPaid: false,
          noPlans: true,
          groupName: 'MODELS',
          hasVision: !!m.vision,
          hasReasoning: !!m.reasoning,
          contextLabel: formatContext(m.context_window),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));

      p.planModels = {};
    }

    p.models = [...models];
```

- [ ] **Step 2: Fix the success status message to not assume free counts**

Immediately after `renderModelsList();` in the same handler (~344-347), replace the two count lines + `setStatus` with:

```javascript
    if (p.plansUrl) {
      const freeCount = models.filter((m) => m.isFree).length;
      const freeForPaidCount = models.filter((m) => m.isFreeForPaid).length;
      setStatus('done', `Fetched ${models.length} models (${freeCount} free + ${freeForPaidCount} free for paid)`);
    } else {
      setStatus('done', `Fetched ${models.length} models`);
    }
```

- [ ] **Step 3: Render a generic group when there are no plans**

In `renderModelsList` (~386-402), replace the grouping block (from `const free = ...` through `container.innerHTML = html;`) with:

```javascript
  let html = '';
  const noPlans = models.length > 0 && models[0].noPlans;

  if (noPlans) {
    html += `<div class="model-group-label">MODELS (${models.length})</div>`;
    html += models.map((m) => buildModelItem(m)).join('');
  } else {
    const free = models.filter((m) => m.isFree);
    const freeForPaid = models.filter((m) => m.isFreeForPaid);
    if (free.length > 0) {
      html += `<div class="model-group-label">FREE (${free.length})</div>`;
      html += free.map((m) => buildModelItem(m)).join('');
    }
    if (freeForPaid.length > 0) {
      html += `<div class="model-group-label">FREE FOR PAID (${freeForPaid.length})</div>`;
      html += freeForPaid.map((m) => buildModelItem(m)).join('');
    }
  }

  container.innerHTML = html;
```

- [ ] **Step 4: Omit the plan icon for plan-less providers in `buildRowHtml`**

In `buildRowHtml` (~632-635), replace the `planIcon` assignment with:

```javascript
  const planIcon = model.noPlans
    ? ''
    : model.isFree
      ? iconSpan('free', 'Free', 'tier-free')
      : iconSpan('free', 'Free for Paid', 'tier-freepaid');
```

- [ ] **Step 5: Verify both provider types**

Run: `npm start`
Expected — nara: fetch models still shows FREE / FREE FOR PAID groups and status reads "Fetched N models (X free + Y free for paid)". Custom provider (add one pointing at any real OpenAI-compatible endpoint you have a key for, or observe behavior): fetching shows a single "MODELS" group with all models and status "Fetched N models"; result rows for it show no free-tier icon. If you have no external endpoint, at minimum confirm nara is unchanged and the code path for `noPlans` renders without error using a throwaway provider (expect an HTTP error status, not a crash).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/app.js
git commit -m "feat: support plan-less OpenAI-compatible providers in fetch and render"
```

---

## Self-Review

**Spec coverage:**
- Config exists from first launch → Task 1. ✓
- Versioned schema + robust read/migration → Task 1. ✓
- Built-in templates vs runtime merge → Task 2. ✓
- Per-provider persistence (keys, baseUrl, custom defs) → Task 2 (`saveProviderConfig`). ✓
- Add/remove custom providers from UI → Task 3. ✓
- Fetch/render branching on `plansUrl` → Task 4. ✓
- Validation (empty, invalid URL, duplicate name) → Task 3 Step 3. ✓
- Manual testing plan → per-task Verify steps. ✓
- Out of scope (adapters, editing built-ins, import/export) → not planned. ✓

**Placeholder scan:** No TBD/TODO; all code steps contain concrete code. ✓

**Type consistency:** `makeRuntimeProvider(def)` defined in Task 2 Step 1, used in Tasks 2 and 3. `saveProviderConfig(id)`, `switchProvider(id)`, `setStatus(state, text)`, `renderProviderTabs()`, `escapeHtml`, `buildModelItem`, `getFreeGroupName`, `formatContext` all pre-exist or are defined before use. `noPlans` flag introduced in Task 4 Step 1 and consumed in Steps 3-4. `PROVIDERS` is now `let` (reassigned in `loadAllProviders`). ✓
