# Provider Name in Config + Edit From UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `config.json` the source of truth for provider `name` and `baseUrl` (built-ins seeded on first launch), let the user edit name+URL from the UI, relocate/restyle the "+" add button, and remove the sidebar Base URL field.

**Architecture:** `BUILTIN_PROVIDERS` in code stays the seed + fallback for non-editable fields (`plansUrl`, `color`, `endpoints`). Config stores `name`, `baseUrl`, `keys` for every provider (custom adds `custom`, `color`). A generalized provider modal handles add and edit.

**Tech Stack:** Electron 33, vanilla JS, config via IPC (`readConfig`/`writeConfig`).

**Spec:** [docs/superpowers/specs/2026-09-22-provider-name-in-config-and-edit-design.md](../specs/2026-09-22-provider-name-in-config-and-edit-design.md)

## Global Constraints

- Everything on disk in English. 2-space indent, single quotes, semicolons.
- Config is source of truth for `name`+`baseUrl`; code (`BUILTIN_PROVIDERS`) is seed + fallback for `plansUrl`/`color`/`endpoints`.
- Editing a built-in's `baseUrl` must NOT change its `plansUrl` (kept from code) — nara free/freemium filtering stays working.
- No automated test framework: verify with `node --check src/renderer/app.js` plus an Electron launch that does not crash the renderer; interactive flows need a human. Never leave a hanging electron process (`taskkill //F //IM electron.exe` in Git Bash uses double-slash).

---

### Task 1: Config as source of truth for name + baseUrl (seed built-ins)

**Files:**
- Modify: `src/renderer/app.js` — `saveProviderConfig` (lines 54-67), `loadAllProviders` (lines 69-101)

**Interfaces:**
- Produces: `saveProviderConfig(id)` persists `{ name, baseUrl, keys }` for all providers (custom adds `custom`, `color`); `loadAllProviders()` overlays config `name`/`baseUrl`/`keys` over each built-in template and seeds any built-in missing from config back to disk.

- [ ] **Step 1: Rewrite `saveProviderConfig` to persist name+baseUrl for all providers**

Replace lines 54-67 (the whole `saveProviderConfig` function) with:

```javascript
async function saveProviderConfig(providerId) {
  const p = PROVIDERS[providerId];
  if (!p) return;
  const data = await window.electronAPI.readConfig();
  if (!data.providers) data.providers = {};
  const entry = { name: p.name, baseUrl: p.baseUrl, keys: p.keys };
  if (p.custom) {
    entry.custom = true;
    entry.color = p.color;
  }
  data.providers[providerId] = entry;
  await window.electronAPI.writeConfig(data);
}
```

- [ ] **Step 2: Rewrite `loadAllProviders` to overlay name+baseUrl and seed missing built-ins**

Replace lines 69-101 (the whole `loadAllProviders` function) with:

```javascript
async function loadAllProviders() {
  let data = { providers: {} };
  try {
    data = await window.electronAPI.readConfig();
  } catch (_) {}
  const stored = data.providers || {};
  let needsSeed = false;

  PROVIDERS = {};

  // Built-ins: code template with config name/baseUrl/keys overlaid (config wins)
  Object.values(BUILTIN_PROVIDERS).forEach((def) => {
    const p = makeRuntimeProvider(def);
    const s = stored[def.id];
    if (s) {
      if (s.name) p.name = s.name;
      if (s.baseUrl) p.baseUrl = s.baseUrl;
      p.keys = s.keys || [];
    } else {
      needsSeed = true;
    }
    PROVIDERS[def.id] = p;
  });

  // Custom providers from config
  Object.entries(stored).forEach(([id, s]) => {
    if (!s.custom || PROVIDERS[id]) return;
    const p = makeRuntimeProvider({
      id,
      name: s.name || id,
      baseUrl: s.baseUrl || '',
      color: s.color || CUSTOM_COLORS[0],
      custom: true,
    });
    p.keys = s.keys || [];
    PROVIDERS[id] = p;
  });

  // Seed any built-in missing from config so its name/baseUrl are visible + editable
  if (needsSeed) {
    if (!data.providers) data.providers = {};
    Object.values(PROVIDERS).forEach((p) => {
      if (!p.custom && !stored[p.id]) {
        data.providers[p.id] = { name: p.name, baseUrl: p.baseUrl, keys: p.keys };
      }
    });
    await window.electronAPI.writeConfig(data);
  }
}
```

- [ ] **Step 3: Verify**

Run `node --check src/renderer/app.js` (must pass). Then, from a fresh config:
`rm -f "$APPDATA/upstream-checker/config.json"` → `npm start &` → `sleep 8` → `cat "$APPDATA/upstream-checker/config.json"` → expect `providers.nara` present with `"name": "NARA Router"` and its `baseUrl`. Kill: `taskkill //F //IM electron.exe`; confirm none remain.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/app.js
git commit -m "feat: persist provider name+baseUrl in config, seed built-ins"
```

---

### Task 2: Edit from UI, relocate + button, remove Base URL field

**Files:**
- Modify: `src/renderer/index.html` — PROVIDER section-label (line 78), remove ENDPOINT section (lines 82-89), modal title (line 278) and submit button (line 297)
- Modify: `src/renderer/app.js` — `renderProviderTabs` (113-145), `addProvider` trailing-slash (149), `switchProvider` (190-199), `init` (1085-1097), base-url change handler (358-361), provider-modal wiring (1063-1080), add `openProviderModal`/`updateProvider` + `editingProviderId`
- Modify: `src/renderer/styles.css` — replace `.provider-btn.provider-add` / `.provider-delete` (1358-1373) with tab-action + section-action styles

**Interfaces:**
- Consumes: `PROVIDERS`, `saveProviderConfig`, `addProvider`, `removeProvider`, `switchProvider`, `setStatus`, `escapeHtml`, `renderProviderTabs`.
- Produces: `editingProviderId` (module state), `openProviderModal(id|null)`, `updateProvider(id, {name, baseUrl})`.

- [ ] **Step 1: index.html — add "+" button to the PROVIDER label and remove the ENDPOINT section**

Replace lines 76-89 (the Provider Tabs section AND the Base URL section) with:

```html
      <!-- Provider Tabs (dynamic) -->
      <div class="sidebar-section">
        <div class="section-label">
          PROVIDER
          <button class="section-action-btn" id="btn-add-provider" title="Add provider">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </button>
        </div>
        <div class="provider-selector" id="provider-tabs"></div>
      </div>
```

(The `<!-- Base URL -->` section and its `#base-url` input are removed entirely.)

- [ ] **Step 2: index.html — make the modal title and submit button addressable**

Line 278: change `<h3>Add Provider</h3>` to `<h3 id="provider-modal-title">Add Provider</h3>`.
Line 297: change `<button class="btn btn-primary" id="provider-modal-add">Add Provider</button>` to `<button class="btn btn-primary" id="provider-modal-add">Add Provider</button>` — keep as-is (the id already exists; JS will set its text). No change needed if the id is present; confirm it is.

- [ ] **Step 3: app.js — rewrite `renderProviderTabs` (remove floating + button, add edit/delete actions)**

Replace lines 113-145 (the whole `renderProviderTabs` function) with:

```javascript
function renderProviderTabs() {
  const container = $('#provider-tabs');
  container.innerHTML = '';
  Object.values(PROVIDERS).forEach((p) => {
    const btn = document.createElement('button');
    btn.className = `provider-btn ${p.id === activeProvider ? 'active' : ''}`;
    btn.dataset.provider = p.id;
    let actions =
      `<span class="provider-action provider-edit" data-provider="${p.id}" title="Edit provider">` +
      `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>` +
      `</span>`;
    if (p.custom) {
      actions +=
        `<span class="provider-action provider-delete" data-provider="${p.id}" title="Remove provider">` +
        `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>` +
        `</span>`;
    }
    btn.innerHTML =
      `<span class="provider-dot" style="background:${p.color}"></span>` +
      `<span class="provider-name">${escapeHtml(p.name)}</span>` +
      `<span class="provider-actions">${actions}</span>`;
    btn.addEventListener('click', () => switchProvider(p.id));
    container.appendChild(btn);
  });

  $$('.provider-edit').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      openProviderModal(el.dataset.provider);
    });
  });
  $$('.provider-delete').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      removeProvider(el.dataset.provider);
    });
  });
}
```

- [ ] **Step 4: app.js — tighten `addProvider` trailing-slash trim**

Line 149: change `baseUrl = (baseUrl || '').trim().replace(/\/$/, '');` to `baseUrl = (baseUrl || '').trim().replace(/\/+$/, '');`.

- [ ] **Step 5: app.js — remove `#base-url` from `switchProvider` and `init`**

In `switchProvider` (190-199) delete the line `  $('#base-url').value = p.baseUrl;` (line 194).
In `init` (1085-1097) delete the line `  $('#base-url').value = p.baseUrl;` (line 1091). Keep the `const p = PROVIDERS[activeProvider];` line above it (it is still used by the removed line's neighbors? No — after removal `const p` is unused in init). Remove the now-unused `const p = PROVIDERS[activeProvider];` line in `init` as well, so init reads:

```javascript
async function init() {
  await loadAllProviders();
  if (!PROVIDERS[activeProvider]) {
    activeProvider = Object.keys(PROVIDERS)[0];
  }
  renderProviderTabs();
  renderKeysList();
  renderModelsList();
  setStatus('idle', 'Ready — add an API key to begin');
  setupUpdateListeners();
}
```

(Do NOT remove `const p` in `switchProvider` — it is still used there by `models = p.models || [];`.)

- [ ] **Step 6: app.js — remove the base-url change handler**

Delete lines 358-361 entirely:

```javascript
$('#base-url').addEventListener('change', async () => {
  PROVIDERS[activeProvider].baseUrl = $('#base-url').value.trim().replace(/\/$/, '');
  await saveProviderConfig(activeProvider);
});
```

- [ ] **Step 7: app.js — add `editingProviderId`, `openProviderModal`, `updateProvider`, and rewrite modal wiring**

Replace the Add Provider modal wiring block (lines 1063-1080) with:

```javascript
let editingProviderId = null;

function openProviderModal(id) {
  editingProviderId = id || null;
  const title = $('#provider-modal-title');
  const submitBtn = $('#provider-modal-add');
  if (editingProviderId) {
    const p = PROVIDERS[editingProviderId];
    title.textContent = 'Edit Provider';
    submitBtn.textContent = 'Save Changes';
    $('#provider-name-input').value = p.name;
    $('#provider-url-input').value = p.baseUrl;
  } else {
    title.textContent = 'Add Provider';
    submitBtn.textContent = 'Add Provider';
    $('#provider-name-input').value = '';
    $('#provider-url-input').value = '';
  }
  $('#add-provider-modal').style.display = 'flex';
  setTimeout(() => $('#provider-name-input').focus(), 100);
}

async function updateProvider(id, { name, baseUrl }) {
  const p = PROVIDERS[id];
  if (!p) return false;
  name = (name || '').trim();
  baseUrl = (baseUrl || '').trim().replace(/\/+$/, '');
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
    (o) => o.id !== id && o.name.toLowerCase() === name.toLowerCase()
  );
  if (dupe) {
    setStatus('error', `A provider named "${name}" already exists`);
    return false;
  }
  p.name = name;
  p.baseUrl = baseUrl;
  await saveProviderConfig(id);
  renderProviderTabs();
  setStatus('done', `Provider "${name}" updated`);
  return true;
}

function closeAddProviderModal() {
  $('#add-provider-modal').style.display = 'none';
  $('#provider-name-input').value = '';
  $('#provider-url-input').value = '';
  editingProviderId = null;
}

$('#btn-add-provider').addEventListener('click', () => openProviderModal(null));
$('#provider-modal-close').addEventListener('click', closeAddProviderModal);
$('#provider-modal-cancel').addEventListener('click', closeAddProviderModal);
$('#provider-modal-add').addEventListener('click', async () => {
  const payload = {
    name: $('#provider-name-input').value,
    baseUrl: $('#provider-url-input').value,
  };
  const ok = editingProviderId
    ? await updateProvider(editingProviderId, payload)
    : await addProvider(payload);
  if (ok) closeAddProviderModal();
});
$('#add-provider-modal').addEventListener('click', (e) => {
  if (e.target.id === 'add-provider-modal') closeAddProviderModal();
});
```

- [ ] **Step 8: styles.css — replace the old provider-add/delete styles with tab-action + section-action styles**

Replace lines 1358-1373 (the `.provider-btn.provider-add` … `.provider-delete:hover` block) with:

```css
.section-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--accent-border);
  border-radius: 6px;
  background: var(--accent-bg);
  color: var(--accent);
  cursor: pointer;
  transition: all var(--transition-fast);
}
.section-action-btn:hover {
  background: var(--accent);
  color: var(--bg-0, #0a0e1a);
}

.provider-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.provider-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity var(--transition-fast);
}
.provider-btn:hover .provider-actions,
.provider-btn.active .provider-actions {
  opacity: 1;
}
.provider-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  color: var(--text-3);
}
.provider-action:hover {
  background: var(--bg-4, rgba(255,255,255,0.08));
  color: var(--text-1);
}
.provider-delete:hover {
  color: var(--fail, #ff6b6b);
}
```

- [ ] **Step 9: Verify**

`node --check src/renderer/app.js` (must pass). Launch: `npm start &`, `sleep 8`, check stdout/stderr for renderer exceptions, `taskkill //F //IM electron.exe`, confirm none remain. Statically confirm: no remaining `#base-url` reference in app.js (`grep -n "base-url" src/renderer/app.js` → no matches); the PROVIDER label has the `#btn-add-provider` button; modal title/submit ids exist; `openProviderModal`/`updateProvider` defined once; edit opens modal prefilled; nara has edit but no delete.

- [ ] **Step 10: Commit**

```bash
git add src/renderer/app.js src/renderer/index.html src/renderer/styles.css
git commit -m "feat: edit provider name/URL from UI, relocate add button, drop Base URL field"
```

---

## Self-Review

**Spec coverage:**
- Config source of truth for name+baseUrl + seed built-ins → Task 1. ✓
- Name entered on add (already), editable on edit → Task 2 (openProviderModal/updateProvider). ✓
- Edit name+URL from UI (incl. nara) → Task 2 (provider-edit action, works for built-ins). ✓
- "+" relocated + restyled beside PROVIDER label → Task 2 Steps 1, 8. ✓
- Base URL sidebar section removed + handler + refs → Task 2 Steps 1, 5, 6. ✓
- baseUrl edit doesn't touch plansUrl (kept from code template; updateProvider only sets name/baseUrl) → preserved. ✓
- Validation (empty, invalid URL, dup excluding self) → Task 2 Step 7. ✓

**Placeholder scan:** No TBD/TODO; all code steps concrete. ✓

**Type consistency:** `openProviderModal(id|null)`, `updateProvider(id,{name,baseUrl})`, `editingProviderId` defined in Task 2 Step 7 and referenced by renderProviderTabs (Step 3) and the `#btn-add-provider`/modal wiring (Step 7). `saveProviderConfig`/`addProvider`/`removeProvider`/`switchProvider` unchanged signatures. `provider-modal-title` id added in Step 2 and used in Step 7. ✓
