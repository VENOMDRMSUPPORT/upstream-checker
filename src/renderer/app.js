// ============================================
// UPSTREAM CHECKER — Application Logic v2
// ============================================

const DEFAULT_TEST_PROMPT = 'What is 2+2? Answer in one word.';
const DEFAULT_EXPECTED = '4, four';

// The prompt actually sent, and what a correct answer looks like. Both are user
// editable and persisted, so the pair always travels together — changing the
// prompt without changing the expected answer would silently mark everything
// wrong.
let testPrompt = DEFAULT_TEST_PROMPT;
let expectedAnswer = DEFAULT_EXPECTED;

// Single placeholder for "no value applies here", so an empty cell never reads as
// a real measurement (a failed request has no token count — it is not zero).
const NA = '—';

// Characters of a response shown inline; longer ones get a click-to-expand cell.
const RESPONSE_PREVIEW = 160;

// Latency bands for the TIME column. Calibrated to what a chat completion
// actually costs: under 5s was flagging most of a healthy run amber, which left
// the colour saying nothing.
const TIME_GOOD_MS = 10000; // green below this
const TIME_OK_MS = 15000;   // amber up to here, red beyond

// Set app version from main process
window.electronAPI.onAppVersion((version) => {
  const versionEl = document.getElementById('app-version');
  if (versionEl) versionEl.textContent = `v${version}`;
});

// Built-in providers register their metadata into window.INTEGRATED_PROVIDERS
// (see src/renderer/providers/*.js, loaded before this file).
const BUILTIN_PROVIDERS = {};
Object.values(window.INTEGRATED_PROVIDERS || {}).forEach((entry) => {
  BUILTIN_PROVIDERS[entry.meta.id] = { ...entry.meta };
});

const CUSTOM_COLORS = ['#7b2ff7', '#00e0a4', '#ff6b6b', '#ffb020', '#4dabf7', '#e64980'];

// Runtime provider map — built at init from BUILTIN_PROVIDERS + config
let PROVIDERS = {};

function makeRuntimeProvider(def) {
  // `selected` holds the chosen model ids. It lives on the provider rather than in
  // the DOM so a re-render (or switching providers and back) doesn't silently
  // reset the user's picks to "everything".
  return { models: [], planModels: {}, keys: [], selected: new Set(), ...structuredClone(def) };
}

// State
let activeProvider = null; // resolved to the first available provider in init()
let models = [];
let modelFilter = ''; // sidebar search box, lowercased
let testResults = [];
let runTotal = null; // models covered by the current/last run; null = no run yet
let lastRun = null; // { done, total, stopped } — lets the summary be re-stated
let isTesting = false;
let abortTesting = false;
let updateInfo = null;
let isUpdateDownloading = false;
let isUpdateReady = false;

// DOM helpers
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ============================================
// Persistence — JSON config file
// ============================================
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

// ============================================
// Test definition — prompt + expected answer
// ============================================
async function loadTestDefinition() {
  try {
    const data = await window.electronAPI.readConfig();
    const t = data.test || {};
    if (typeof t.prompt === 'string') testPrompt = t.prompt;
    // An empty string is a real choice (checking off), so only a missing key
    // falls back to the default.
    if (typeof t.expected === 'string') expectedAnswer = t.expected;
  } catch (_) {}
  $('#prompt-input').value = testPrompt;
  $('#expected-input').value = expectedAnswer;
}

async function saveTestDefinition() {
  try {
    const data = await window.electronAPI.readConfig();
    data.test = { prompt: testPrompt, expected: expectedAnswer };
    await window.electronAPI.writeConfig(data);
  } catch (err) {
    console.warn('Failed to persist test definition:', err);
  }
}

$('#prompt-input').addEventListener('input', (e) => {
  testPrompt = e.target.value;
  saveTestDefinition();
});

$('#expected-input').addEventListener('input', (e) => {
  expectedAnswer = e.target.value;
  saveTestDefinition();
  // Existing rows are re-judged against the new answer without re-running them.
  if (tableRows.length > 0) renderResultsTable();
  updateStats();
  renderRunSummary();
});

$('#btn-reset-prompt').addEventListener('click', () => {
  testPrompt = DEFAULT_TEST_PROMPT;
  expectedAnswer = DEFAULT_EXPECTED;
  $('#prompt-input').value = testPrompt;
  $('#expected-input').value = expectedAnswer;
  saveTestDefinition();
  if (tableRows.length > 0) renderResultsTable();
  updateStats();
  renderRunSummary();
});

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Returns true/false, or null when answer checking is switched off (no expected
// answer) or there is no response to judge.
function isCorrect(result) {
  const alts = expectedAnswer
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (alts.length === 0) return null;
  if (!result || result.status !== 'pass' || result.isEmpty) return null;

  const text = (result.response || '').toLowerCase();
  return alts.some((alt) => {
    // A plain alphanumeric answer is matched on token boundaries, so "4" doesn't
    // match "14" and "four" doesn't match "fourteen". Anything containing spaces
    // or punctuation is matched as a substring, where boundaries don't apply.
    if (/^[a-z0-9]+$/.test(alt)) {
      return new RegExp(`(^|[^a-z0-9])${escapeRegex(alt)}([^a-z0-9]|$)`).test(text);
    }
    return text.includes(alt);
  });
}

async function loadAllProviders() {
  let data = { providers: {} };
  try {
    data = await window.electronAPI.readConfig();
  } catch (_) {}
  data.providers = data.providers || {};
  const stored = data.providers;
  const norm = (u) => (u || '').trim().replace(/\/+$/, '').toLowerCase();
  let dirty = false;

  PROVIDERS = {};

  // Built-ins: code template with config name/baseUrl/keys overlaid (config wins).
  // A newly-shipped built-in that isn't in config yet is seeded so its name/baseUrl
  // are visible and editable.
  Object.values(BUILTIN_PROVIDERS).forEach((def) => {
    const p = makeRuntimeProvider(def);
    const s = stored[def.id];
    if (s) {
      if (s.name) p.name = s.name;
      if (s.baseUrl) p.baseUrl = s.baseUrl;
      p.keys = s.keys || [];
    } else {
      stored[def.id] = { name: p.name, baseUrl: p.baseUrl, keys: p.keys };
      dirty = true;
    }
    PROVIDERS[def.id] = p;
  });

  // Custom providers from config. A custom provider whose baseUrl now matches a
  // built-in (i.e. that provider became integrated) is migrated into the built-in:
  // its keys move over and the standalone custom entry is dropped.
  Object.entries(stored).forEach(([id, s]) => {
    if (!s.custom || PROVIDERS[id]) return;
    const builtin = Object.values(PROVIDERS).find((p) => !p.custom && norm(p.baseUrl) === norm(s.baseUrl));
    if (builtin) {
      const have = new Set(builtin.keys.map((k) => k.key));
      (s.keys || []).forEach((k) => {
        if (!have.has(k.key)) {
          builtin.keys.push(k);
          have.add(k.key);
        }
      });
      delete stored[id];
      stored[builtin.id] = { name: builtin.name, baseUrl: builtin.baseUrl, keys: builtin.keys };
      dirty = true;
      return;
    }
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

  if (dirty) {
    try {
      await window.electronAPI.writeConfig(data);
    } catch (err) {
      console.warn('Failed to persist providers:', err);
    }
  }
}

// ============================================
// Title bar
// ============================================
$('#btn-minimize').addEventListener('click', () => window.electronAPI.minimize());
$('#btn-maximize').addEventListener('click', () => window.electronAPI.maximize());
$('#btn-close').addEventListener('click', () => window.electronAPI.close());

// ============================================
// Provider tab switching
// ============================================
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
    // An integrated provider can ship a logo (meta.logo); otherwise fall back to a
    // colored dot (used by custom, user-added providers).
    const badge = p.logo
      ? `<img class="provider-logo" src="${escapeHtml(p.logo)}" alt="" onerror="this.style.display='none'">`
      : `<span class="provider-dot" style="background:${p.color}"></span>`;
    btn.innerHTML =
      badge +
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

async function addProvider({ name, baseUrl }) {
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

function switchProvider(providerId) {
  activeProvider = providerId;
  const p = PROVIDERS[activeProvider];
  models = p.models || [];
  modelFilter = '';
  const search = $('#models-search');
  if (search) search.value = '';
  renderProviderTabs();
  renderKeysList();
  renderModelsList();
  updateTestAllButton();
  updateStats();
}

// ============================================
// API Keys management
// ============================================
// Open padlock = the key is in use for runs; closed = held back. The icon shows
// the current state, and the tooltip spells out what clicking it will do.
const ICON_UNLOCKED = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="11" width="18" height="11" rx="2"/>
  <path d="M7 11V7a5 5 0 019.9-1"/>
</svg>`;
const ICON_LOCKED = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="11" width="18" height="11" rx="2"/>
  <path d="M7 11V7a5 5 0 0110 0v4"/>
</svg>`;

function renderKeysList() {
  const p = PROVIDERS[activeProvider];
  const container = $('#keys-list');

  if (p.keys.length === 0) {
    container.innerHTML = `
      <div class="models-empty">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3">
          <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
        </svg>
        <span>No keys added</span>
      </div>`;
    return;
  }

  container.innerHTML = p.keys
    .map(
      (k) => `
    <div class="key-item ${k.active ? 'active' : ''}" data-key-id="${k.id}">
      <div class="key-header">
        <div class="key-name">${escapeHtml(k.name)}</div>
        <div class="key-actions">
          <button class="key-icon-btn key-toggle-btn ${k.active ? 'active' : ''}" data-key-id="${k.id}"
                  title="${k.active ? 'In use — click to disable' : 'Disabled — click to enable'}">
            ${k.active ? ICON_UNLOCKED : ICON_LOCKED}
          </button>
          <button class="key-icon-btn key-delete-btn" data-key-id="${k.id}" title="Remove key">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/>
              <path d="M10 11v6M14 11v6"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="key-value">
        <span class="key-masked">${maskKey(k.key)}</span>
        <button class="key-icon-btn key-copy-btn" data-key-id="${k.id}" title="Copy key">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="12" height="12" rx="2"/>
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
          </svg>
        </button>
      </div>
    </div>`
    )
    .join('');

  // Bind events
  $$('.key-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const keyId = btn.dataset.keyId;
      toggleKeyActive(keyId);
    });
  });

  $$('.key-delete-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const keyId = btn.dataset.keyId;
      removeKey(keyId);
    });
  });

  $$('.key-copy-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyKey(btn.dataset.keyId, btn);
    });
  });
}

// The key is only ever shown masked. Copy is the one way the full value leaves
// the app, so it can't be shoulder-surfed off the screen.
function maskKey(key) {
  if (!key) return '';
  const head = key.length <= 12 ? 6 : 10;
  return key.slice(0, head) + '********' + key.slice(-4);
}

async function copyKey(keyId, btn) {
  const key = PROVIDERS[activeProvider].keys.find((k) => k.id === keyId);
  if (!key) return;
  try {
    await navigator.clipboard.writeText(key.key);
    btn.classList.add('copied');
    btn.title = 'Copied';
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.title = 'Copy key';
    }, 1200);
  } catch (err) {
    setStatus('error', 'Could not copy the key to the clipboard');
  }
}

async function toggleKeyActive(keyId) {
  const p = PROVIDERS[activeProvider];
  const key = p.keys.find((k) => k.id === keyId);
  if (!key) return;
  key.active = !key.active;
  await saveProviderConfig(activeProvider);
  renderKeysList();
  updateTestAllButton();
}

async function removeKey(keyId) {
  const p = PROVIDERS[activeProvider];
  p.keys = p.keys.filter((k) => k.id !== keyId);
  await saveProviderConfig(activeProvider);
  renderKeysList();
  updateTestAllButton();
}

async function addKey() {
  const nameInput = $('#key-name-input');
  const keyInput = $('#key-value-input');
  const name = nameInput.value.trim() || `Key ${Date.now()}`;
  const key = keyInput.value.trim();

  if (!key) {
    setStatus('error', 'Please enter an API key');
    return;
  }

  const p = PROVIDERS[activeProvider];
  p.keys.push({
    id: `key_${Date.now()}`,
    name,
    key,
    active: true,
  });

  nameInput.value = '';
  keyInput.value = '';
  await saveProviderConfig(activeProvider);
  renderKeysList();
  updateTestAllButton();
  setStatus('done', `Key "${name}" added`);
}

// ============================================
// Fetch models from provider — only models for the key's plan
// ============================================
function getFreeGroupName(code) {
  if (code === 'free') return 'FREE';
  if (code === 'freemium' || code === 'freemium-max') return 'FREE FOR PAID';
  return code;
}

$('#btn-fetch-models').addEventListener('click', async () => {
  const p = PROVIDERS[activeProvider];
  const activeKeys = p.keys.filter((k) => k.active);
  if (activeKeys.length === 0) {
    setStatus('error', 'No active API keys. Add and activate a key first.');
    return;
  }

  const apiKey = activeKeys[0].key;
  const btn = $('#btn-fetch-models');
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Fetching...';
  setStatus('running', 'Fetching models for this key...');

  try {
    const adapter = (window.INTEGRATED_PROVIDERS || {})[p.id];
    if (adapter && adapter.fetchModels) {
      // Integrated provider: delegate discovery to its module
      models = await adapter.fetchModels({
        apiKey,
        baseUrl: p.baseUrl,
        plansUrl: p.plansUrl,
        pricingUrl: p.pricingUrl,
        apiRequest: window.electronAPI.apiRequest,
        formatContext,
        getFreeGroupName,
      });
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
        .map((m) => {
          const ctx = readContextWindow(m);
          return {
            ...m,
            isFree: false,
            isFreeForPaid: false,
            noPlans: true,
            groupName: 'MODELS',
            hasVision: readsVision(m),
            hasReasoning: readsReasoning(m),
            context_window: ctx,
            contextLabel: formatContext(ctx),
          };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
    }

    // Two entries sharing an id are the same model; keeping both would create two
    // table rows with the same key, and only the first would ever be updated.
    models = dedupeById(models);

    p.models = [...models];
    p.selected = new Set(models.map((m) => m.id)); // a fresh fetch starts fully selected

    renderModelsList();
    if (p.plansUrl) {
      const freeCount = models.filter((m) => m.isFree).length;
      const freeForPaidCount = models.filter((m) => m.isFreeForPaid).length;
      setStatus('done', `Fetched ${models.length} models (${freeCount} free + ${freeForPaidCount} free for paid)`);
    } else {
      setStatus('done', `Fetched ${models.length} models`);
    }
    updateStats();
  } catch (err) {
    setStatus('error', err.message || 'Failed to fetch models');
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
});

function dedupeById(list) {
  const seen = new Set();
  return list.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

// "OpenAI-compatible" only pins down the chat endpoint — providers disagree on
// where capability metadata lives in /models, so probe the shapes seen in the
// wild before giving up. Without this the TYPE and CONTEXT columns are empty for
// every plain provider, which is what made them look like dead columns.
function readContextWindow(m) {
  return (
    m.context_window ??
    m.context_length ??
    m.max_context_tokens ??
    m.max_context_length ??
    m.top_provider?.context_length ??
    null
  );
}

function readsVision(m) {
  if (m.vision != null) return !!m.vision;
  if (m.supports_vision != null) return !!m.supports_vision;
  const modality = m.architecture?.input_modalities ?? m.architecture?.modality;
  if (Array.isArray(modality)) return modality.includes('image');
  if (typeof modality === 'string') return modality.includes('image');
  return Array.isArray(m.capabilities) && m.capabilities.includes('vision');
}

function readsReasoning(m) {
  if (m.reasoning != null) return !!m.reasoning;
  if (m.supports_reasoning != null) return !!m.supports_reasoning;
  return Array.isArray(m.capabilities) && m.capabilities.includes('reasoning');
}

// Returns '' when the provider doesn't report a context window, so callers can
// decide how to render "unknown" (the table shows NA, the sidebar shows nothing
// rather than a stray dash under every model name).
function formatContext(ctx) {
  if (!ctx) return '';
  if (ctx >= 1000000) return `${Math.round(ctx / 1000000)}M`;
  if (ctx >= 1000) return `${Math.round(ctx / 1000)}K`;
  return String(ctx);
}

// ============================================
// Render models list in sidebar
// ============================================
// The models matching the sidebar search box. Filtering is display-only — it
// never changes which models are selected, so a filtered-out model stays in the
// run if it was already ticked.
function visibleModels() {
  if (!modelFilter) return models;
  return models.filter((m) => m.id.toLowerCase().includes(modelFilter));
}

function renderModelsList() {
  const container = $('#models-list');
  const countEl = $('#model-count');
  const shown = visibleModels();
  // While filtering, read "matching/total" so the hidden models stay accounted for.
  countEl.textContent =
    shown.length === models.length ? String(models.length) : `${shown.length}/${models.length}`;

  if (models.length === 0) {
    container.innerHTML = `
      <div class="models-empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3">
          <rect x="2" y="3" width="20" height="14" rx="2"/>
          <path d="M8 21h8M12 17v4"/>
        </svg>
        <span>No models loaded</span>
        <span class="models-empty-hint">Add API key and fetch models</span>
      </div>`;
    updateTestAllButton();
    return;
  }

  if (shown.length === 0) {
    container.innerHTML = `
      <div class="models-empty">
        <span>No model matches "${escapeHtml(modelFilter)}"</span>
      </div>`;
    updateTestAllButton();
    return;
  }

  let html = '';
  if (shown[0].noPlans) {
    // No group label here — the sidebar section header already reads "MODELS <n>".
    html += shown.map((m) => buildModelItem(m)).join('');
  } else {
    const free = shown.filter((m) => m.isFree);
    const freeForPaid = shown.filter((m) => m.isFreeForPaid);
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

  $$('.model-item').forEach((item) => {
    item.addEventListener('click', () => toggleModelSelection(item.dataset.modelId, item));
  });

  updateTestAllButton();
  updateStats();
}

// Toggling must refresh the Test button (it disables at zero selected) and the
// Total stat (which counts the models the next run will cover).
function toggleModelSelection(id, item) {
  const sel = PROVIDERS[activeProvider].selected;
  if (sel.has(id)) {
    sel.delete(id);
    item.classList.remove('selected');
  } else {
    sel.add(id);
    item.classList.add('selected');
  }
  updateTestAllButton();
  updateStats();
}

// All / None apply to what the filter is currently showing, so "None" after a
// search clears just that subset rather than the whole list.
function setSelectionForVisible(on) {
  const sel = PROVIDERS[activeProvider].selected;
  visibleModels().forEach((m) => (on ? sel.add(m.id) : sel.delete(m.id)));
  renderModelsList();
}

$('#models-search').addEventListener('input', (e) => {
  modelFilter = e.target.value.trim().toLowerCase();
  renderModelsList();
});
$('#btn-select-all').addEventListener('click', () => setSelectionForVisible(true));
$('#btn-select-none').addEventListener('click', () => setSelectionForVisible(false));

function buildModelItem(m) {
  const badges = [];
  if (m.hasVision) badges.push('<span class="model-badge badge-vision">Vision</span>');
  if (m.hasReasoning) badges.push('<span class="model-badge badge-reasoning">Think</span>');
  if (m.isFree) badges.push('<span class="model-badge badge-free">Free</span>');

  const id = escapeHtml(m.id);
  const selected = PROVIDERS[activeProvider]?.selected.has(m.id);
  return `
    <div class="model-item ${selected ? 'selected' : ''}" data-model-id="${id}">
      <div class="model-checkbox"></div>
      <div class="model-info">
        <span class="model-name" title="${id}">${id}</span>
        ${m.contextLabel ? `<span class="model-context">${m.contextLabel}</span>` : ''}
      </div>
      <div class="model-badges">${badges.join('')}</div>
    </div>`;
}

function getSelectedModels() {
  const sel = PROVIDERS[activeProvider]?.selected;
  if (!sel) return [];
  return models.filter((m) => sel.has(m.id));
}

const TEST_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
const STOP_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;

function updateTestAllButton() {
  const btn = $('#btn-test-all');
  // Mid-run the same button is Stop, which must stay clickable.
  if (isTesting) {
    btn.innerHTML = `${STOP_ICON} Stop`;
    btn.classList.add('btn-stop');
    btn.disabled = false;
    return;
  }
  const count = getSelectedModels().length;
  const activeKeys = PROVIDERS[activeProvider].keys.filter((k) => k.active);
  btn.innerHTML = `${TEST_ICON} Test Selected${count > 0 ? ` (${count})` : ''}`;
  btn.classList.remove('btn-stop');
  btn.disabled = count === 0 || activeKeys.length === 0;
}

// ============================================
// Test reliability settings
// ============================================
// Models are tested one at a time, in order. Each model starts with a SINGLE
// request (cheap, stays within the per-minute limit). If it is slow, we escalate
// automatically — firing another parallel attempt every HEDGE_STEP_MS up to
// HEDGE_MAX — and the fastest correct answer wins, cancelling the rest. Fast
// models cost one request; only slow ones fan out, so the result comes back ASAP.
const HEDGE_MAX = 6;
const HEDGE_STEP_MS = 2000;
const MODEL_DEADLINE_MS = 75000; // hard cap per model so a stuck one can't block the run
const STREAM_HEDGE = 2;          // parallel streaming attempts during empty recovery
const MAX_TEST_RETRIES = 2;
// 429 is handled by the rate-limit path below, not here: it isn't a transient
// glitch to back off from, it's the provider telling us to wait out its window.
const RETRYABLE_STATUS = new Set([502, 503, 504]);

// Hitting a per-minute cap is not a property of the model — it's a property of
// how fast we were going. Waiting the window out and continuing gives the model
// a real verdict instead of recording our own pacing as its failure.
const RATE_LIMIT_WAIT_MS = 60000; // a full window, when the provider doesn't say
const MAX_RATE_LIMIT_WAITS = 3;   // stop after ~3 windows rather than hang forever
const RATE_LIMIT_PATTERN =
  /rate.?limit|too many requests|per[- ]minute|requests? per (minute|min)|\brpm\b|concurrency limit/i;

// Run-level: once one model is capped every other model would be too, so a single
// wait covers the rest of the queue instead of each model rediscovering the cap.
let rateLimitUntil = 0;
let runStatusText = '';

function isRateLimit(r) {
  if (r.statusCode === 429) return true;
  return typeof r.response === 'string' && RATE_LIMIT_PATTERN.test(r.response);
}

// Blocks until the provider's window should have rolled over. The clock runs
// outside any request, so this pause is never charged to a model's reported time
// — neither the one that was capped nor the ones tested after it.
async function waitForRateLimitWindow() {
  let waited = false;
  while (!abortTesting) {
    const remaining = rateLimitUntil - Date.now();
    if (remaining <= 0) break;
    waited = true;
    setStatus('running', `Rate limited — resuming in ${Math.ceil(remaining / 1000)}s`);
    await sleep(Math.min(1000, remaining));
  }
  if (waited && !abortTesting) setStatus('running', runStatusText);
}

function scheduleRateLimitWait(result) {
  const ms = result.retryAfter > 0 ? result.retryAfter * 1000 : RATE_LIMIT_WAIT_MS;
  rateLimitUntil = Math.max(rateLimitUntil, Date.now() + ms);
}

let requestSeq = 0;
// Every id handed out during a run, so Stop can kill sockets that are already in
// flight. Without this, hitting Stop still leaves up to HEDGE_MAX requests
// running (and billing) until the 60s request timeout fires.
const inflightIds = new Set();

function nextRequestId() {
  requestSeq += 1;
  const id = `req_${Date.now()}_${requestSeq}`;
  inflightIds.add(id);
  return id;
}

// Cancelling an already-finished id is a no-op in the main process, so this can
// safely fire at every id from the current run.
function cancelAllInflight() {
  inflightIds.forEach((id) => window.electronAPI.cancelApiRequest(id));
  inflightIds.clear();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Backoff before retrying a transient failure. Rate limits don't come here —
// they get a full window wait instead of a few hundred milliseconds.
function retryDelay(attempt) {
  return 600 * Math.pow(2, attempt) + Math.floor(Math.random() * 300);
}

// One single request. Returns a pass (content), an empty pass, or a fail carrying
// statusCode/retryAfter so the caller can decide whether to retry.
async function attemptOnce(model, apiKey, baseUrl, stream, requestId) {
  // reasoning_effort:'low' is sent to every model — it is a no-op on non-reasoning
  // models and clamps safely, but it makes reasoning-heavy models think briefly
  // instead of burning time on a deep chain for a trivial prompt. ('minimal' is
  // NOT safe — some models return empty under it — so 'low' is the floor.)
  const payload = {
    model: model.id,
    messages: [{ role: 'user', content: testPrompt || DEFAULT_TEST_PROMPT }],
    max_tokens: 512,
    reasoning_effort: 'low',
    stream: !!stream,
  };

  try {
    const result = await window.electronAPI.apiRequest({
      url: `${baseUrl}/chat/completions`,
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      requestId,
    });

    // Cancelled hedge loser — ignore it (raceAttempts skips cancelled results).
    if (result.cancelled) return { status: 'fail', response: 'cancelled', time: result.elapsed || 0, tokens: 0, cancelled: true };

    if (result.status === 200) {
      const parsed = stream ? parseStreamedCompletion(result.body) : parseChatCompletion(result.body);
      const usage = parsed.usage || {};
      if (!parsed.content) return buildEmptyResult(usage, result.elapsed);
      return {
        status: 'pass',
        response: parsed.content,
        isEmpty: false,
        time: result.elapsed,
        tokens: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
      };
    }

    let errMsg = `HTTP ${result.status}`;
    try {
      const errData = JSON.parse(result.body);
      errMsg = errData.error?.message || errMsg;
    } catch (_) {}
    const ra = parseInt(result.headers?.['retry-after'], 10);
    return { status: 'fail', response: errMsg, time: result.elapsed, tokens: 0, statusCode: result.status, retryAfter: isNaN(ra) ? 0 : ra };
  } catch (err) {
    return { status: 'fail', response: err.error || err.message || 'Request failed', time: err.elapsed || 0, tokens: 0, cancelled: !!err.cancelled, networkError: !err.cancelled };
  }
}

// non-empty pass > empty pass > fail
function resultRank(r) {
  if (r.status === 'pass' && !r.isEmpty) return 3;
  if (r.status === 'pass' && r.isEmpty) return 2;
  return 1;
}

// Fire `count` parallel attempts; resolve as soon as one returns a non-empty pass
// (cancelling the rest). If none do, wait for all and resolve with the best result.
function raceAttempts(model, apiKey, baseUrl, stream, count) {
  return new Promise((resolve) => {
    const ids = [];
    let pending = count;
    let best = null;
    let settled = false;
    const cancelRest = () => ids.forEach((id) => window.electronAPI.cancelApiRequest(id));

    for (let i = 0; i < count; i++) {
      const id = nextRequestId();
      ids.push(id);
      attemptOnce(model, apiKey, baseUrl, stream, id).then((r) => {
        pending -= 1;
        if (settled) return;
        if (r.status === 'pass' && !r.isEmpty) {
          settled = true;
          cancelRest();
          resolve(r);
          return;
        }
        if (!r.cancelled && (!best || resultRank(r) > resultRank(best))) best = r;
        if (pending === 0) {
          settled = true;
          resolve(best || r);
        }
      });
    }
  });
}

// Adaptive non-streaming hedge: start with one request; if it is slow, fire
// another parallel attempt every HEDGE_STEP_MS (up to HEDGE_MAX). The first
// non-empty answer wins (cancel the rest). An empty 200 is deterministic per
// model, so we stop escalating once we see one and resolve with the best result.
// A hard MODEL_DEADLINE_MS cap prevents a pathologically slow model from hanging.
function adaptiveNonStream(model, apiKey, baseUrl) {
  return new Promise((resolve) => {
    const ids = [];
    let settled = false;
    let best = null;
    let inflight = 0;
    let launched = 0;
    let stop = false; // stop launching new attempts (saw an empty, or aborted)
    let stepTimer = null;
    let deadlineTimer = null;

    const cancelAll = () => ids.forEach((id) => window.electronAPI.cancelApiRequest(id));
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(stepTimer);
      clearTimeout(deadlineTimer);
      cancelAll();
      resolve(r);
    };

    const launch = () => {
      if (settled || stop || abortTesting || launched >= HEDGE_MAX) return;
      launched += 1;
      inflight += 1;
      const id = nextRequestId();
      ids.push(id);
      attemptOnce(model, apiKey, baseUrl, false, id).then((r) => {
        inflight -= 1;
        if (settled) return;
        // Stop was pressed. Every attempt comes back `cancelled`, which sets
        // neither `stop` nor `best` — without this the promise would hang until
        // the 75s deadline and "Stopping..." would sit there for over a minute.
        if (abortTesting) return finish(best || { status: 'fail', response: 'Aborted', time: 0, tokens: 0 });
        if (r.status === 'pass' && !r.isEmpty) return finish(r); // fastest correct wins
        if (!r.cancelled && (!best || resultRank(r) > resultRank(best))) best = r;
        // A completed non-win result (empty or failure) means the model isn't just
        // slow — stop fanning out. Escalation is only for slowness (pending attempts);
        // an empty goes to streaming and a failure (e.g. 429) is retried with backoff
        // by testModel, so we must not keep firing requests at it here.
        if (!r.cancelled) {
          stop = true;
          clearTimeout(stepTimer);
        }
        if (inflight === 0 && (stop || abortTesting || launched >= HEDGE_MAX)) finish(best);
      });
      if (!stop && launched < HEDGE_MAX) stepTimer = setTimeout(launch, HEDGE_STEP_MS);
    };

    deadlineTimer = setTimeout(
      () => finish(best || { status: 'fail', response: 'Timed out', time: MODEL_DEADLINE_MS, tokens: 0, statusCode: 0, timedOut: true }),
      MODEL_DEADLINE_MS
    );

    launch();
  });
}

// ============================================
// Test a single model — adaptive hedge, handles reasoning, empty, rate limits
// ============================================
async function testModel(model, apiKey, baseUrl) {
  let transientRetries = 0;
  let emptyRetried = false;
  let rateLimitWaits = 0;
  let rounds = 0;

  // `time` is only the winning attempt, so a 502 retried twice still reports
  // ~0.3s. Carrying the round count lets the table show that it took more than
  // one go instead of presenting the last attempt as the whole story.
  const done = (r) => ({ ...r, attempts: rounds });

  while (true) {
    // An earlier model may have parked the whole run behind a rate-limit window.
    if (rateLimitUntil > Date.now()) {
      updateResultRow(model, { status: 'running', waiting: true, time: null, tokens: null });
      await waitForRateLimitWindow();
      updateResultRow(model, RUNNING_RESULT);
    }
    if (abortTesting) return done({ status: 'fail', response: 'Aborted', time: 0, tokens: 0 });
    rounds += 1;

    const r = await adaptiveNonStream(model, apiKey, baseUrl);

    if (r.status === 'pass' && !r.isEmpty) return done(r);

    if (r.status === 'pass' && r.isEmpty) {
      // Empty on the non-streaming endpoint: some models (byNara event-stream)
      // deliver content only over SSE — try streaming.
      if (abortTesting) return done(r);
      const streamed = await raceAttempts(model, apiKey, baseUrl, true, STREAM_HEDGE);
      if (streamed.status === 'pass' && !streamed.isEmpty) return done(streamed);
      // Both empty. Empty can be flaky, so retry the whole model once.
      if (!emptyRetried && !abortTesting) {
        emptyRetried = true;
        await sleep(500);
        continue;
      }
      return done(r);
    }

    // Rate limited. Park the whole run until the window rolls over and try this
    // model again — it never gets recorded as a failure for being throttled.
    if (isRateLimit(r) && rateLimitWaits < MAX_RATE_LIMIT_WAITS && !abortTesting) {
      rateLimitWaits += 1;
      scheduleRateLimitWait(r);
      continue;
    }
    if (isRateLimit(r)) {
      return done({
        ...r,
        response: `Still rate limited after ${rateLimitWaits} window${rateLimitWaits === 1 ? '' : 's'} — ${r.response}`,
      });
    }

    // A failure. Retry on transient errors (5xx/network) with backoff.
    const retryable = (r.statusCode && RETRYABLE_STATUS.has(r.statusCode)) || r.networkError;
    if (retryable && transientRetries < MAX_TEST_RETRIES && !abortTesting) {
      await sleep(retryDelay(transientRetries));
      transientRetries++;
      continue;
    }
    return done(r);
  }
}

// Parse a non-streaming chat completion body into { content, usage }.
function parseChatCompletion(body) {
  const data = JSON.parse(body);
  const choice = data.choices?.[0];
  let content = choice?.message?.content?.trim() || '';
  if (!content && choice?.message?.reasoning_content) {
    content = choice.message.reasoning_content.trim();
  }
  return { content, usage: data.usage || {} };
}

// Parse an SSE (stream:true) chat completion body: concatenate delta.content
// across chunks and read usage from the final chunk.
function parseStreamedCompletion(body) {
  let content = '';
  let usage = null;
  for (const line of (body || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch (_) {
      continue;
    }
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.content) content += delta.content;
    if (chunk.usage) usage = chunk.usage;
  }
  return { content: content.trim(), usage: usage || {} };
}

// An empty 200 (no content even after streaming recovery) is a real outcome:
// the provider returned no text. Report it honestly rather than as a plain pass.
function buildEmptyResult(usage, elapsed) {
  return {
    status: 'pass',
    response: 'No content returned by provider',
    isEmpty: true,
    time: elapsed,
    tokens: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
  };
}

// ============================================
// Test all selected models
// ============================================
const RUNNING_RESULT = { status: 'running', time: null, tokens: null, response: '' };

// The one button is Test while idle and Stop while a run is going.
$('#btn-test-all').addEventListener('click', () => {
  if (isTesting) {
    abortTesting = true;
    cancelAllInflight();
    setStatus('running', 'Stopping...');
    return;
  }
  runTests(getSelectedModels());
});

// Retry just the models that failed or never got tested, reusing their existing
// rows instead of wiping the table and re-running everything.
$('#btn-retry-failed').addEventListener('click', () => {
  const list = retryableModels();
  if (list.length > 0) runTests(list, { reset: false });
});

// Delegated so it survives every table re-render.
$('#results-body').addEventListener('click', (e) => {
  const btn = e.target.closest('.row-retry-btn');
  if (!btn || isTesting) return;
  const model = models.find((m) => m.id === btn.dataset.modelId);
  if (model) runTests([model], { reset: false });
});

// Failed results, plus rows a stopped run never reached (those aren't recorded
// in testResults at all, so they're read back off the table).
function retryableModels() {
  const ids = new Set(testResults.filter((r) => r.status === 'fail').map((r) => r.model));
  // Read off the backing data, not the DOM — a "failed only" filter or a sort
  // can leave skipped rows out of the table entirely.
  tableRows.forEach((e) => {
    if (e.result.status === 'skipped') ids.add(e.model.id);
  });
  return models.filter((m) => ids.has(m.id));
}

// A retry replaces the model's previous verdict rather than appending a second one.
function recordResult(model, result, providerName) {
  const entry = { model: model.id, ...result, provider: providerName, group: model.groupName || '' };
  const i = testResults.findIndex((r) => r.model === model.id);
  if (i >= 0) testResults[i] = entry;
  else testResults.push(entry);
}

async function runTests(list, { reset = true } = {}) {
  if (list.length === 0 || isTesting) return;

  const p = PROVIDERS[activeProvider];
  const activeKeys = p.keys.filter((k) => k.active);
  if (activeKeys.length === 0) {
    setStatus('error', 'No active API keys');
    return;
  }

  const apiKey = activeKeys[0].key;
  const baseUrl = p.baseUrl;

  isTesting = true;
  abortTesting = false;
  inflightIds.clear();
  rateLimitUntil = 0;

  if (reset) {
    testResults = [];
    runTotal = list.length;
    initResultsTable();
    // Pre-create rows in selection order; each is filled in turn, top to bottom.
    list.forEach((model) => addResultRow(model, RUNNING_RESULT));
  } else {
    list.forEach((model) => updateResultRow(model, RUNNING_RESULT));
  }

  updateStats();
  updateTestAllButton();
  runStatusText = `Testing ${list.length} model${list.length === 1 ? '' : 's'}...`;
  setStatus('running', runStatusText);
  showProgress(0, list.length);

  // Sequential, in order: each model is fully resolved before the next starts, so
  // results appear top-to-bottom (never out of order) and only one request is in
  // flight at a time — well within the provider's per-minute request limit.
  let done = 0;
  for (const model of list) {
    if (abortTesting) break;
    const result = await testModel(model, apiKey, baseUrl);
    if (abortTesting) break;
    recordResult(model, result, p.name);
    updateResultRow(model, result);
    done += 1;
    updateStats();
    showProgress(done, list.length);
  }

  // Models the run never reached would otherwise sit on "Testing..." forever.
  if (abortTesting) {
    list.slice(done).forEach((model) => {
      if (!testResults.some((r) => r.model === model.id)) {
        updateResultRow(model, { status: 'skipped', response: 'Not tested — run stopped', time: null, tokens: null });
      }
    });
  }

  hideProgress();
  isTesting = false;
  updateTestAllButton();
  updateStats();

  lastRun = { done, total: list.length, stopped: abortTesting };
  renderRunSummary();
}

// Rebuilt from the results rather than written once at the end of the run, so
// editing the expected answer re-states the summary instead of leaving the
// status bar claiming "6/7 correct" while the table shows seven ticks.
function renderRunSummary() {
  if (!lastRun || isTesting) return;

  const passed = testResults.filter((r) => r.status === 'pass').length;
  const failed = testResults.filter((r) => r.status === 'fail').length;

  // Answer quality is reported alongside the HTTP outcome, never folded into it:
  // "7 passed" and "6 of 7 correct" are two different things a user needs.
  const judged = testResults.filter((r) => isCorrect(r) !== null);
  const correct = judged.filter((r) => isCorrect(r)).length;
  const answers = judged.length > 0 ? ` — ${correct}/${judged.length} correct` : '';

  if (lastRun.stopped) {
    setStatus('idle', `Stopped — ${lastRun.done}/${lastRun.total} tested (${passed} passed, ${failed} failed)${answers}`);
  } else if (failed === 0) setStatus('done', `All ${passed} models passed${answers}`);
  else if (passed === 0) setStatus('error', `All ${failed} models failed`);
  else setStatus('done', `Done: ${passed} passed, ${failed} failed${answers}`);
}

// ============================================
// Results table
// ============================================
// The table's backing data, in the order rows were created. Sorting and
// filtering are views over this — the underlying run order never changes, so
// clearing a sort restores the original sequence.
let tableRows = [];
let sortKey = null;
let sortDir = 1;
let showFailedOnly = false;

function initResultsTable() {
  tableRows = [];
  sortKey = null;
  sortDir = 1;
  showFailedOnly = false;
  $('#filter-failed').classList.remove('active');
  $('#results-empty').style.display = 'none';
  $('#results-table').style.display = '';
  $('#results-body').innerHTML = '';
}

function addResultRow(model, result) {
  tableRows.push({ model, result });
  const tbody = $('#results-body');
  const tr = document.createElement('tr');
  tr.dataset.modelId = model.id;
  tr.className = rowClassFor(result);
  tr.innerHTML = buildRowHtml(model, result);
  tbody.appendChild(tr);
  syncColumnVisibility();
}

const SORTERS = {
  status: (e) => ({ fail: 0, skipped: 1, running: 2, pass: e.result.isEmpty ? 3 : 4 })[e.result.status] ?? 5,
  model: (e) => e.model.id.toLowerCase(),
  context: (e) => e.model.context_window ?? -1,
  time: (e) => (e.result.status === 'pass' ? e.result.time : null),
  tokens: (e) => (e.result.status === 'pass' ? e.result.tokens : null),
  tps: (e) => tokensPerSecond(e.result),
  correct: (e) => {
    const c = isCorrect(e.result);
    return c == null ? null : c ? 1 : 0;
  },
};

// Rows with no value for the sort column always sink to the bottom, whichever
// direction is active — a failed model has no "slowest time", it has no time.
function sortedRows(rows) {
  if (!sortKey) return rows;
  const read = SORTERS[sortKey];
  return [...rows].sort((a, b) => {
    const x = read(a);
    const y = read(b);
    const xNull = x == null || x === '';
    const yNull = y == null || y === '';
    if (xNull && yNull) return 0;
    if (xNull) return 1;
    if (yNull) return -1;
    if (typeof x === 'string') return x.localeCompare(y) * sortDir;
    return (x - y) * sortDir;
  });
}

function visibleRows() {
  const rows = showFailedOnly
    ? tableRows.filter((e) => e.result.status === 'fail' || e.result.isEmpty)
    : tableRows;
  return sortedRows(rows);
}

function renderResultsTable() {
  $('#results-body').innerHTML = visibleRows()
    .map(
      ({ model, result }) =>
        `<tr class="${rowClassFor(result)}" data-model-id="${escapeHtml(model.id)}">${buildRowHtml(model, result)}</tr>`
    )
    .join('');
  syncColumnVisibility();
}

// A column every provider leaves blank is noise, not information. Hide TYPE and
// CONTEXT when no row in the table has anything to put in them.
function syncColumnVisibility() {
  const table = $('#results-table');
  const hasType = tableRows.some(
    ({ model }) => model.hasVision || model.hasReasoning || !model.noPlans
  );
  const hasContext = tableRows.some(({ model }) => !!model.contextLabel);
  table.classList.toggle('hide-type', !hasType);
  table.classList.toggle('hide-context', !hasContext);
  // Answer checking is off when no expected answer is set — hide the column
  // rather than fill it with placeholders.
  table.classList.toggle('hide-correct', expectedAnswer.trim() === '');
}

$('#results-table thead').addEventListener('click', (e) => {
  const th = e.target.closest('.th-sortable');
  if (!th) return;
  const key = th.dataset.sort;
  if (sortKey === key) {
    // third click clears the sort and restores run order
    if (sortDir === -1) sortKey = null;
    else sortDir = -1;
  } else {
    sortKey = key;
    sortDir = 1;
  }
  $$('#results-table th').forEach((el) => el.classList.remove('sort-asc', 'sort-desc'));
  if (sortKey) th.classList.add(sortDir === 1 ? 'sort-asc' : 'sort-desc');
  renderResultsTable();
});

$('#filter-failed').addEventListener('click', () => {
  showFailedOnly = !showFailedOnly;
  $('#filter-failed').classList.toggle('active', showFailedOnly);
  renderResultsTable();
});

// Matched on the dataset value rather than an attribute selector, because model
// ids carry '/', '.' and ':' and would need escaping to be used as a selector.
function findResultRow(modelId) {
  let found = null;
  $$('#results-body tr').forEach((tr) => {
    if (!found && tr.dataset.modelId === modelId) found = tr;
  });
  return found;
}

function rowClassFor(result) {
  if (result.isEmpty) return 'row-empty';
  if (result.status === 'running') return 'row-running';
  if (result.status === 'skipped') return 'row-skipped';
  return result.status === 'pass' ? 'row-pass' : 'row-fail';
}

function updateResultRow(model, result) {
  const entry = tableRows.find((e) => e.model.id === model.id);
  if (entry) entry.result = result;

  // With a sort or filter active the row may need to move (or vanish), so the
  // whole view is rebuilt. Otherwise patch the one row in place.
  if (sortKey || showFailedOnly) {
    renderResultsTable();
    return;
  }
  const tr = findResultRow(model.id);
  if (!tr) return;
  tr.className = rowClassFor(result);
  tr.innerHTML = buildRowHtml(model, result);
}

// SVG icons for badges
const ICONS = {
  vision: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
  think: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9.5 2A5.5 5.5 0 005 7.5A5.5 5.5 0 009.5 13H10a4 4 0 014 4v1.5a5.5 5.5 0 00-5.5-5.5z"/><path d="M14.5 13H14a4 4 0 00-4 4v1.5a5.5 5.5 0 005.5-5.5V8a2.5 2.5 0 00-1-5z"/></svg>`,
  free: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 12V8H6a2 2 0 01-2-2V6a2 2 0 012-2h12"/><circle cx="16" cy="16" r="4"/><path d="M16 14v4M14 16h4"/></svg>`,
  timeout: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  tokens: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9 9h6M9 15h6"/><path d="M12 9v6"/></svg>`,
  retry: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 11-6.219-8.56"/><polyline points="22 2 22 8 16 8"/></svg>`,
};

function iconSpan(key, label, cls) {
  return `<span class="icon-badge ${cls}" title="${label}">${ICONS[key]}</span>`;
}

// Status badge as icon pill
function statusIconBadge(status, isEmpty) {
  if (status === 'pass' && !isEmpty) {
    return `<span class="status-icon pass" title="Pass"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 13l4 4L19 7"/></svg></span>`;
  }
  if (status === 'pass' && isEmpty) {
    return `<span class="status-icon empty" title="Empty response"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 15h8M8 9h8"/></svg></span>`;
  }
  if (status === 'fail') {
    return `<span class="status-icon fail" title="Failed"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 6l12 12M18 6L6 18"/></svg></span>`;
  }
  if (status === 'skipped') {
    return `<span class="status-icon skipped" title="Not tested"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 12h12"/></svg></span>`;
  }
  return `<span class="status-icon running" title="Testing"><span class="spinner"></span></span>`;
}

function buildRowHtml(model, result) {
  const isRunning = result.status === 'running';
  const isFailed = result.status === 'fail';
  const badge = statusIconBadge(result.status, result.isEmpty);

  // A failed request's elapsed time is how fast the error came back, not how fast
  // the model is — it gets the muted "dead" colour, never the fast/slow scale.
  let timeStr = NA;
  let timeClass = 'cell-na';
  if (isRunning) {
    timeClass = 'cell-na';
  } else if (result.time != null) {
    timeStr = `${(result.time / 1000).toFixed(1)}s`;
    if (isFailed) timeClass = 'time-dead';
    else if (result.time < TIME_GOOD_MS) timeClass = 'time-fast';
    else if (result.time <= TIME_OK_MS) timeClass = 'time-medium';
    else timeClass = 'time-slow';
  }

  const typeIcons = [];
  if (model.hasVision) typeIcons.push(iconSpan('vision', 'Vision', 'type-vision'));
  if (model.hasReasoning) typeIcons.push(iconSpan('think', 'Reasoning', 'type-think'));
  // Free tier icon: show on every row (tier comes from provider grouping, not free/paid anymore)
  if (!model.noPlans) {
    typeIcons.push(
      model.isFree
        ? iconSpan('free', 'Free', 'tier-free')
        : iconSpan('free', 'Free for Paid', 'tier-freepaid')
    );
  }
  const typeHtml = typeIcons.length ? typeIcons.join('') : NA;
  const contextHtml = model.contextLabel || NA;

  // No tokens on a failed or in-flight request — '0' would read as a measurement.
  const tokens = isRunning || isFailed || result.tokens == null ? NA : String(result.tokens);

  const tps = tokensPerSecond(result);
  const tpsHtml = tps == null ? NA : tps >= 100 ? String(Math.round(tps)) : tps.toFixed(1);

  // Answer correctness is deliberately separate from pass/fail: pass means the
  // endpoint worked, this means the model got it right. A model that answers
  // fast and wrong is a different problem from one that 502s.
  const correct = isCorrect(result);
  const correctHtml =
    correct == null
      ? NA
      : correct
        ? `<span class="correct-mark yes" title="Matches the expected answer">✓</span>`
        : `<span class="correct-mark no" title="Does not contain the expected answer">✗</span>`;

  const full = result.response || '';
  const truncated = full.length > RESPONSE_PREVIEW;
  const preview = escapeHtml(full.slice(0, RESPONSE_PREVIEW)) + (truncated ? '…' : '');
  const responseHtml = isRunning
    ? `<span class="response-placeholder">${result.waiting ? 'Waiting out rate limit…' : 'Testing...'}</span>`
    : result.isEmpty
      ? `<span class="response-empty">${preview}</span>`
      : preview;
  const responseTitle = escapeHtml(truncated ? 'Click to see the full response' : full);

  // A row worth re-running gets its own retry button, so one bad model doesn't
  // cost a full re-test of the whole list.
  // The reported time covers only the winning attempt, so say when there were more.
  const extraRounds = (result.attempts || 1) - 1;
  const retriesHtml =
    extraRounds > 0
      ? ` <span class="retry-count" title="Retried ${extraRounds} time${extraRounds === 1 ? '' : 's'}; the time shown is the last attempt">↻${extraRounds}</span>`
      : '';

  const canRetry = !isRunning && (isFailed || result.status === 'skipped' || result.isEmpty);
  const actionsHtml = canRetry
    ? `<button class="row-retry-btn" data-model-id="${escapeHtml(model.id)}" title="Retry this model">${ICONS.retry}</button>`
    : '';

  return `
    <td class="cell-status">${badge}</td>
    <td class="cell-model">${escapeHtml(model.id)}</td>
    <td class="cell-type ${typeIcons.length ? '' : 'cell-na'}">${typeHtml}</td>
    <td class="cell-context ${model.contextLabel ? '' : 'cell-na'}">${contextHtml}</td>
    <td class="cell-time ${timeClass}">${timeStr}${retriesHtml}</td>
    <td class="cell-tokens ${tokens === NA ? 'cell-na' : ''}">${tokens}</td>
    <td class="cell-tps ${tps == null ? 'cell-na' : ''}">${tpsHtml}</td>
    <td class="cell-correct ${correct == null ? 'cell-na' : ''}">${correctHtml}</td>
    <td class="cell-response ${truncated ? 'response-expandable' : ''}" title="${responseTitle}">${responseHtml}</td>
    <td class="cell-actions">${actionsHtml}</td>
  `;
}

// Generation speed. Only completion tokens count — prompt tokens aren't
// generated, so including them inflates the rate on a long prompt. This is
// end-to-end (the elapsed time includes connection and queueing), so treat it as
// a comparison between models on equal terms, not a raw decode rate.
function tokensPerSecond(result) {
  if (!result || result.status !== 'pass' || result.isEmpty) return null;
  if (!result.completionTokens || !result.time) return null;
  return result.completionTokens / (result.time / 1000);
}

// ============================================
// Full response modal
// ============================================
$('#results-body').addEventListener('click', (e) => {
  const cell = e.target.closest('.response-expandable');
  if (!cell) return;
  const tr = cell.closest('tr');
  const entry = tableRows.find((r) => r.model.id === tr?.dataset.modelId);
  if (!entry) return;
  $('#response-modal-title').textContent = entry.model.id;
  $('#response-modal-body').textContent = entry.result.response || '';
  $('#response-modal').style.display = 'flex';
});

$('#response-modal-close').addEventListener('click', () => {
  $('#response-modal').style.display = 'none';
});
$('#response-modal').addEventListener('click', (e) => {
  if (e.target.id === 'response-modal') $('#response-modal').style.display = 'none';
});
$('#response-modal-copy').addEventListener('click', () => {
  navigator.clipboard.writeText($('#response-modal-body').textContent || '');
});

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================
// Stats & status
// ============================================
function setStatus(state, text) {
  const dot = $('#status-indicator .status-dot');
  dot.className = `status-dot ${state}`;
  $('#status-text').textContent = text;
}

function updateStats() {
  // Total = the models this run covers, not every model fetched — otherwise
  // testing 3 of 9 shows "Total 9 / Passed 2 / Failed 1". Before a run it
  // previews the current selection, so Passed + Failed can never exceed it.
  $('#stat-total').textContent = String(runTotal ?? getSelectedModels().length);
  const passed = testResults.filter((r) => r.status === 'pass').length;
  const failed = testResults.filter((r) => r.status === 'fail').length;
  $('#stat-pass').textContent = String(passed);
  $('#stat-fail').textContent = String(failed);

  // Average latency measures speed, so only completed calls count. A 502 comes
  // back in ~0.3s and would otherwise drag the average down and make the
  // provider look faster than it actually is.
  const times = testResults.filter((r) => r.status === 'pass' && r.time).map((r) => r.time);
  if (times.length > 0) {
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    $('#stat-avg-time').textContent = `${(avg / 1000).toFixed(1)}s`;
  } else {
    $('#stat-avg-time').textContent = NA;
  }

  const retryBtn = $('#btn-retry-failed');
  if (retryBtn) retryBtn.disabled = isTesting || retryableModels().length === 0;
}

function showProgress(current, total) {
  $('#progress-container').style.display = '';
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  $('#progress-fill').style.width = `${pct}%`;
  $('#progress-count').textContent = `${current}/${total}`;
  $('#progress-label').textContent = current === total ? 'Complete' : `Testing ${current}/${total}...`;
}

function hideProgress() {
  setTimeout(() => { if (!isTesting) $('#progress-container').style.display = 'none'; }, 2000);
}

// ============================================
// Export
// ============================================
$('#btn-export-csv').addEventListener('click', () => {
  if (testResults.length === 0) return;
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header =
    'Model,Provider,Plan,Status,Correct,Time (ms),Tokens,Completion Tokens,TPS,Attempts,Response\n';
  const rows = testResults
    .map((r) => {
      const tps = tokensPerSecond(r);
      const correct = isCorrect(r);
      return [
        q(r.model), q(r.provider), q(r.group || ''), q(r.status),
        correct == null ? '' : correct ? 'yes' : 'no',
        r.time ?? '', r.tokens ?? '', r.completionTokens ?? '',
        tps == null ? '' : tps.toFixed(2), r.attempts ?? 1,
        q(r.response),
      ].join(',');
    })
    .join('\n');
  downloadFile(header + rows, 'upstream-checker-results.csv', 'text/csv');
});

$('#btn-export-json').addEventListener('click', () => {
  if (testResults.length === 0) return;
  downloadFile(JSON.stringify(testResults, null, 2), 'upstream-checker-results.json', 'application/json');
});

$('#btn-clear-results').addEventListener('click', () => {
  testResults = [];
  runTotal = null;
  lastRun = null;
  tableRows = [];
  sortKey = null;
  sortDir = 1;
  showFailedOnly = false;
  $('#filter-failed').classList.remove('active');
  $$('#results-table th').forEach((el) => el.classList.remove('sort-asc', 'sort-desc'));
  $('#results-empty').style.display = '';
  $('#results-table').style.display = 'none';
  $('#results-body').innerHTML = '';
  updateStats();
  setStatus('idle', 'Ready');
  $('#progress-container').style.display = 'none';
});

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ============================================
// Update handling
// ============================================
function showUpdateModal(info) {
  updateInfo = info;
  $('#update-modal-version').textContent = info.version;

  const notesEl = $('#update-modal-notes');
  if (info.releaseNotes) {
    const notes = Array.isArray(info.releaseNotes) ? info.releaseNotes.join('\n') : info.releaseNotes;
    notesEl.innerHTML = formatReleaseNotes(notes);
  } else {
    notesEl.textContent = 'No release notes available.';
  }

  $('#update-progress').style.display = 'none';
  $('#update-modal-download-btn').style.display = '';
  $('#update-modal-download-btn').disabled = false;
  $('#update-modal-download-btn').innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download Update`;
  $('#update-modal-install-btn').style.display = 'none';
  $('#update-modal-later-btn').style.display = '';

  $('#update-modal').style.display = 'flex';
}

function hideUpdateModal() {
  $('#update-modal').style.display = 'none';
  updateInfo = null;
}

function formatReleaseNotes(notes) {
  // Strip markdown/HTML tags and format cleanly
  const lines = notes.split('\n');
  let html = '<ul>';
  lines.forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith('[') || line === '---') return;
    if (line.startsWith('<')) {
      // Strip HTML tags
      line = line.replace(/<[^>]*>/g, '').trim();
    }
    if (line.startsWith('### ')) {
      // Section header
      line = line.replace(/^###\s*/, '<strong style="color:var(--accent);font-size:11px;">');
      line += '</strong>';
    } else if (line.startsWith('- ')) {
      // List item
      line = line.replace(/^-\s*/, '');
    } else if (line.startsWith('## ')) {
      // Version header
      line = line.replace(/^##\s*/, '<strong style="color:var(--text-0);font-size:12px;">');
      line += '</strong>';
    } else {
      return; // Skip non-list lines
    }
    if (line.length > 0) html += `<li>${escapeHtml(line)}</li>`;
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

function setupUpdateListeners() {
  if (!window.electronAPI || !window.electronAPI.updateAPI) return;
  const updateAPI = window.electronAPI.updateAPI;

  updateAPI.onUpdateChecking(() => console.log('Checking for updates...'));

  updateAPI.onUpdateAvailable((info) => {
    if (!isUpdateDownloading && !isUpdateReady) {
      // Show titlebar badge
      const badge = $('#update-badge');
      badge.style.display = 'flex';
      $('#update-badge-version').textContent = info.version;
      // Also show modal
      showUpdateModal(info);
    }
  });

  updateAPI.onUpdateNotAvailable(() => console.log('No updates available'));

  updateAPI.onUpdateError((data) => {
    console.error('Update error:', data.message);
    if (isUpdateDownloading) {
      setStatus('error', 'Update download failed');
      isUpdateDownloading = false;
      // Update badge progress
      const progressEl = $('#update-badge-progress');
      if (progressEl) progressEl.style.display = 'none';
    }
  });

  updateAPI.onDownloadProgress((progress) => {
    showDownloadProgress(progress.percent);
    // Update badge text
    const progressEl = $('#update-badge-progress');
    if (progressEl) {
      progressEl.style.display = '';
      progressEl.textContent = `${progress.percent}%`;
    }
  });

  updateAPI.onUpdateDownloaded(() => {
    isUpdateDownloading = false;
    isUpdateReady = true;
    showInstallButton();
    // Update badge to install state
    const badge = $('#update-badge');
    badge.classList.add('update-ready');
    $('#update-badge-progress').style.display = 'none';
    $('#update-badge-version').textContent = 'ready!';
    badge.title = 'Click to install update';
  });

  // Badge click handler
  $('#update-badge')?.addEventListener('click', () => {
    if (isUpdateReady) {
      window.electronAPI.updateAPI.installUpdate();
    } else if (!isUpdateDownloading) {
      // Start download
      isUpdateDownloading = true;
      const badge = $('#update-badge');
      badge.classList.add('update-downloading');
      window.electronAPI.updateAPI.downloadUpdate();
    }
  });

  // Update modal button handlers
  $('#update-modal-download-btn')?.addEventListener('click', () => {
    isUpdateDownloading = true;
    const btn = $('#update-modal-download-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Downloading...';
    updateAPI.downloadUpdate();
  });

  $('#update-modal-install-btn')?.addEventListener('click', () => {
    updateAPI.installUpdate();
  });

  $('#update-modal-later-btn')?.addEventListener('click', () => {
    hideUpdateModal();
    isUpdateDownloading = false;
  });

  $('#update-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'update-modal') hideUpdateModal();
  });
}

// ============================================
// Add Key modal
// ============================================
$('#btn-add-key').addEventListener('click', () => {
  const modal = $('#add-key-modal');
  modal.style.display = 'flex';
  setTimeout(() => $('#key-name-input').focus(), 100);
});

function closeAddKeyModal() {
  $('#add-key-modal').style.display = 'none';
  $('#key-name-input').value = '';
  $('#key-value-input').value = '';
}

$('#modal-cancel').addEventListener('click', closeAddKeyModal);
$('#modal-cancel-btn').addEventListener('click', closeAddKeyModal);

$('#modal-add').addEventListener('click', () => {
  addKey();
  $('#add-key-modal').style.display = 'none';
});

$('#add-key-modal').addEventListener('click', (e) => {
  if (e.target.id === 'add-key-modal') {
    $('#add-key-modal').style.display = 'none';
  }
});

// ============================================
// Add / Edit Provider modal
// ============================================
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

// ============================================
// Init
// ============================================
async function init() {
  await loadTestDefinition();
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

init();
