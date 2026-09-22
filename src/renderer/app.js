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

// ============================================
// Model kinds
// ============================================
// A router can sit an image or video generator behind the same /chat/completions
// endpoint as its chat models. Asking one of those "what is 2+2" is not a test of
// anything: it spends real generation quota, takes a minute, and comes back with
// a picture of the question — which then scores as a wrong answer. So each model
// is tagged and judged by the standard that applies to it.
//
// A provider module can override this with its own classify(model); the fallback
// below is name matching, which is a guess and is shown as a badge so it can be
// seen and corrected.
const MEDIA_PROMPT = 'A single red circle centred on a plain white background.';

const KIND_SETTINGS = {
  chat:  { deadline: 75000,  hedge: true,  label: '' },
  image: { deadline: 240000, hedge: false, label: 'Image' },
  video: { deadline: 600000, hedge: false, label: 'Video' },
};

function classifyModel(providerId, model) {
  const adapter = (window.INTEGRATED_PROVIDERS || {})[providerId];
  if (adapter && typeof adapter.classify === 'function') {
    const k = adapter.classify(model);
    if (KIND_SETTINGS[k]) return k;
  }
  const id = String(model.id || '').toLowerCase();
  if (/\b(wan|veo|sora|kling|runway|luma|hailuo|pika)\b|video|t2v|i2v/.test(id)) return 'video';
  if (/image|flux|dall-?e|stable-?diffusion|midjourney|seedream|imagen|ideogram|t2i/.test(id)) return 'image';
  return 'chat';
}

const isMedia = (model) => model && (model.kind === 'image' || model.kind === 'video');

// testResults rows carry only the model id; correctness needs the model itself
// to know which standard applies.
function modelById(id) {
  return models.find((m) => m.id === id) || null;
}

// A generator's output is a link to an asset, not prose. Finding one is the whole
// pass criterion — there is no "right answer" to compare against.
function containsMediaUrl(text) {
  return /https?:\/\/\S+|data:(image|video)\//i.test(text || '');
}

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
// Run history — uptime, regressions, scheduling
// ============================================
// Answers the question the tool's name implies: not "does this model work right
// now" but "is it reliable". Keyed per provider, because the same model id can
// be solid on one router and flaky on another.
const SPARK_RUNS = 12;    // recent runs drawn in the uptime cell
const MIN_RUNS_FOR_UPTIME = 2; // one data point is not a rate

// providerId::modelId -> [{ at, ok }] oldest first
let history = new Map();
let autoTestMinutes = 0; // 0 = off
let autoTestTimer = null;

function historyKey(providerId, modelId) {
  return `${providerId}::${modelId}`;
}

async function loadHistory() {
  history = new Map();
  let data = { runs: [] };
  try {
    data = await window.electronAPI.readHistory();
  } catch (_) {}
  (data.runs || []).forEach((run) => {
    (run.results || []).forEach((r) => {
      const key = historyKey(run.provider, r.model);
      if (!history.has(key)) history.set(key, []);
      history.get(key).push({ at: run.at, ok: r.status === 'pass' });
    });
  });
}

function modelHistory(modelId) {
  return history.get(historyKey(activeProvider, modelId)) || [];
}

// null until there are enough runs to mean anything — a single sample rendered
// as "100%" or "0%" reads like a measurement it isn't.
function uptimeOf(modelId) {
  const h = modelHistory(modelId);
  if (h.length < MIN_RUNS_FOR_UPTIME) return null;
  return h.filter((e) => e.ok).length / h.length;
}

// How the model finished the run before this one, or null if it's new.
function previousStatus(modelId) {
  const h = modelHistory(modelId);
  if (h.length < 2) return null;
  return h[h.length - 2].ok;
}

async function recordRun(providerId, providerName, results) {
  if (results.length === 0) return;
  const run = {
    at: Date.now(),
    provider: providerId,
    providerName,
    prompt: testPrompt,
    results: results.map((r) => ({
      model: r.model,
      status: r.status,
      time: r.time ?? null,
      tokens: r.tokens ?? null,
      completionTokens: r.completionTokens ?? null,
      attempts: r.attempts ?? 1,
      correct: isCorrect(r, modelById(r.model)),
    })),
  };
  try {
    await window.electronAPI.appendRun(run);
  } catch (err) {
    console.warn('Failed to record run history:', err);
  }
  // Fold into the in-memory index so the table reflects it immediately.
  run.results.forEach((r) => {
    const key = historyKey(providerId, r.model);
    if (!history.has(key)) history.set(key, []);
    history.get(key).push({ at: run.at, ok: r.status === 'pass' });
  });
}

// Compares this run against each model's previous recorded outcome. Called after
// the run is folded in, so the last entry is this run and the one before it is
// what we are comparing against.
function runRegressions() {
  const broke = [];
  const recovered = [];
  testResults.forEach((r) => {
    const was = previousStatus(r.model);
    if (was === null) return;
    const now = r.status === 'pass';
    if (was && !now) broke.push(r.model);
    else if (!was && now) recovered.push(r.model);
  });
  return { broke, recovered };
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
    if (Number.isFinite(t.autoMinutes)) autoTestMinutes = t.autoMinutes;
  } catch (_) {}
  $('#prompt-input').value = testPrompt;
  $('#expected-input').value = expectedAnswer;
  $('#auto-test-select').value = String(autoTestMinutes);
  applyAutoTestSchedule();
}

async function saveTestDefinition() {
  try {
    const data = await window.electronAPI.readConfig();
    data.test = { prompt: testPrompt, expected: expectedAnswer, autoMinutes: autoTestMinutes };
    await window.electronAPI.writeConfig(data);
  } catch (err) {
    console.warn('Failed to persist test definition:', err);
  }
}

// Typing fires per keystroke, and a save now costs an OS keystore round trip for
// every stored key plus a full config rewrite. Coalesce the writes.
let saveTestTimer = null;
function queueTestDefinitionSave() {
  clearTimeout(saveTestTimer);
  saveTestTimer = setTimeout(saveTestDefinition, 400);
}

$('#prompt-input').addEventListener('input', (e) => {
  testPrompt = e.target.value;
  queueTestDefinitionSave();
});

$('#expected-input').addEventListener('input', (e) => {
  expectedAnswer = e.target.value;
  queueTestDefinitionSave();
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
  clearTimeout(saveTestTimer);
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
function isCorrect(result, model) {
  // A generator is right when it returned an asset. There is no expected word to
  // compare against, and scoring its image link against "4, four" would mark
  // every working generator wrong.
  if (model && isMedia(model)) {
    if (!result || result.status !== 'pass') return null;
    return containsMediaUrl(result.response);
  }

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
      // Undecryptable keys all read as '', so identify by ciphertext when present
      // — otherwise merging would silently drop all but the first of them.
      const identity = (k) => k.cipher || k.key;
      const have = new Set(builtin.keys.map(identity));
      (s.keys || []).forEach((k) => {
        if (!have.has(identity(k))) {
          builtin.keys.push(k);
          have.add(identity(k));
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
    btn.innerHTML =
      `<span class="provider-name">${escapeHtml(p.name)}</span>` +
      `<span class="provider-actions">${actions}</span>`;

    // Built as a node rather than markup: the onerror attribute this used to
    // carry was the only inline script in the app and the sole reason the CSP
    // had to allow 'unsafe-inline'. Setting the dot colour as a property instead
    // of interpolating it into a style attribute closes the same hole for CSS.
    let badge;
    if (p.logo) {
      badge = document.createElement('img');
      badge.className = 'provider-logo';
      badge.alt = '';
      badge.addEventListener('error', () => { badge.style.display = 'none'; });
      badge.src = p.logo;
    } else {
      badge = document.createElement('span');
      badge.className = 'provider-dot';
      badge.style.background = p.color;
    }
    btn.prepend(badge);

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
    <div class="key-item ${k.locked ? 'unreadable' : k.active ? 'active' : ''}" data-key-id="${k.id}">
      <div class="key-header">
        <div class="key-name">${escapeHtml(k.name)}</div>
        <div class="key-actions">
          <button class="key-icon-btn key-toggle-btn ${k.active && !k.locked ? 'active' : ''}" data-key-id="${k.id}"
                  ${k.locked ? 'disabled' : ''}
                  title="${k.locked ? 'Unreadable on this machine' : k.active ? 'In use — click to disable' : 'Disabled — click to enable'}">
            ${k.active && !k.locked ? ICON_UNLOCKED : ICON_LOCKED}
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
        <span class="key-masked ${k.locked ? 'unreadable' : ''}">${
          k.locked ? 'Encrypted for another machine — re-add it' : maskKey(k.key)
        }</span>
        <button class="key-icon-btn key-copy-btn" data-key-id="${k.id}" title="Copy key" ${k.locked ? 'disabled' : ''}>
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
// A key flagged `locked` came out of config.json as ciphertext this machine
// can't open, so there is nothing to send — it is excluded from every run.
function usableKeys(p) {
  return p.keys.filter((k) => k.active && !k.locked);
}

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
  const activeKeys = usableKeys(p);
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
    models.forEach((m) => { m.kind = classifyModel(p.id, m); });

    p.models = [...models];
    // Chat models start selected. Generators don't: each one costs a real image
    // or video generation and a minute of wall clock, so including them in every
    // run — especially a scheduled one — has to be a decision, not a default.
    p.selected = new Set(models.filter((m) => !isMedia(m)).map((m) => m.id));

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
  const kindLabel = (KIND_SETTINGS[m.kind] || {}).label;
  if (kindLabel) badges.push(`<span class="model-badge badge-media">${kindLabel}</span>`);
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
  const activeKeys = usableKeys(PROVIDERS[activeProvider]);
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
// Per-model hard cap now lives in KIND_SETTINGS — a video generator legitimately
// needs minutes, a chat model that takes one is broken.
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
  const media = isMedia(model);
  const payload = {
    model: model.id,
    messages: [{ role: 'user', content: media ? MEDIA_PROMPT : testPrompt || DEFAULT_TEST_PROMPT }],
    max_tokens: 512,
    stream: !!stream,
  };
  // reasoning_effort steers a reasoning model away from a deep chain on a trivial
  // prompt. It means nothing to a generator, so it isn't sent to one.
  if (!media) payload.reasoning_effort = 'low';

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
// A hard per-kind deadline prevents a pathologically slow model from hanging.
function adaptiveNonStream(model, apiKey, baseUrl) {
  const { deadline, hedge } = KIND_SETTINGS[model.kind] || KIND_SETTINGS.chat;
  const maxAttempts = hedge ? HEDGE_MAX : 1;
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
      if (settled || stop || abortTesting || launched >= maxAttempts) return;
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
        if (inflight === 0 && (stop || abortTesting || launched >= maxAttempts)) finish(best);
      });
      if (!stop && launched < maxAttempts) stepTimer = setTimeout(launch, HEDGE_STEP_MS);
    };

    deadlineTimer = setTimeout(
      () => finish(best || { status: 'fail', response: 'Timed out', time: deadline, tokens: 0, statusCode: 0, timedOut: true }),
      deadline
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
      // Generators don't stream text, so the SSE recovery below would just buy a
      // second generation for nothing.
      if (isMedia(model)) return done(r);
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

async function runTests(list, { reset = true, scheduled = false } = {}) {
  if (list.length === 0 || isTesting) return;

  const p = PROVIDERS[activeProvider];
  const activeKeys = usableKeys(p);
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

  await recordRun(p.id, p.name, testResults);
  lastRun = { done, total: list.length, stopped: abortTesting, changes: runRegressions() };
  renderResultsTable(); // uptime cells now include this run
  renderRunSummary();
  announceRegressions(lastRun.changes, scheduled);
}

// A scheduled run happens while the user is looking elsewhere, so a model that
// used to pass and now doesn't is worth an OS notification. A manual run doesn't
// need one — the result is already on screen.
function announceRegressions(changes, scheduled) {
  if (!scheduled || changes.broke.length === 0) return;
  const n = changes.broke.length;
  window.electronAPI.notifyRegression({
    title: `${n} model${n === 1 ? '' : 's'} stopped working`,
    body: changes.broke.slice(0, 5).join(', ') + (n > 5 ? `, +${n - 5} more` : ''),
  });
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
  const judged = testResults.filter((r) => isCorrect(r, modelById(r.model)) !== null);
  const correct = judged.filter((r) => isCorrect(r, modelById(r.model))).length;
  const answers = judged.length > 0 ? ` — ${correct}/${judged.length} correct` : '';

  // What moved since the previous run matters more than the absolute numbers —
  // "2 stopped working" is the thing a person actually needs to see.
  const c = lastRun.changes || { broke: [], recovered: [] };
  const moved = [];
  if (c.broke.length) moved.push(`${c.broke.length} newly failing`);
  if (c.recovered.length) moved.push(`${c.recovered.length} recovered`);
  const delta = moved.length ? ` · ${moved.join(', ')}` : '';

  if (lastRun.stopped) {
    setStatus('idle', `Stopped — ${lastRun.done}/${lastRun.total} tested (${passed} passed, ${failed} failed)${answers}${delta}`);
  } else if (failed === 0) setStatus('done', `All ${passed} models passed${answers}${delta}`);
  else if (passed === 0) setStatus('error', `All ${failed} models failed${delta}`);
  else setStatus(c.broke.length ? 'error' : 'done', `Done: ${passed} passed, ${failed} failed${answers}${delta}`);
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
  uptime: (e) => uptimeOf(e.model.id),
  correct: (e) => {
    const c = isCorrect(e.result, e.model);
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
    ({ model }) => model.hasVision || model.hasReasoning || isMedia(model) || !model.noPlans
  );
  const hasContext = tableRows.some(({ model }) => !!model.contextLabel);
  table.classList.toggle('hide-type', !hasType);
  table.classList.toggle('hide-context', !hasContext);
  // Answer checking is off when no expected answer is set — hide the column
  // rather than fill it with placeholders.
  table.classList.toggle('hide-correct', expectedAnswer.trim() === '');
  const hasUptime = tableRows.some(({ model }) => uptimeOf(model.id) != null);
  table.classList.toggle('hide-uptime', !hasUptime);
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
  image: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`,
  video: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="14" height="14" rx="2"/><path d="M22 8l-6 4 6 4V8z"/></svg>`,
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
  if (model.kind === 'image') typeIcons.push(iconSpan('image', 'Image generator', 'type-media'));
  if (model.kind === 'video') typeIcons.push(iconSpan('video', 'Video generator', 'type-media'));
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
  // Reliability over time, next to this run's result: a model that passed now
  // but fails a third of the time is a different proposition from a steady one.
  const uptime = uptimeOf(model.id);
  const uptimeHtml = uptime == null ? NA : `${Math.round(uptime * 100)}%`;
  const uptimeClass =
    uptime == null ? 'cell-na' : uptime >= 0.95 ? 'uptime-high' : uptime >= 0.8 ? 'uptime-mid' : 'uptime-low';

  const correct = isCorrect(result, model);
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
    <td class="cell-uptime ${uptimeClass}">${uptimeHtml}${sparkline(model.id)}</td>
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

// A bar per recent run, oldest on the left. Drawn rather than charted because
// the only question it has to answer at a glance is "was this always like that,
// or did something change".
function sparkline(modelId) {
  const h = modelHistory(modelId).slice(-SPARK_RUNS);
  if (h.length < MIN_RUNS_FOR_UPTIME) return '';
  const w = 4;
  const gap = 1;
  const bars = h
    .map(
      (e, i) =>
        `<rect x="${i * (w + gap)}" y="${e.ok ? 0 : 5}" width="${w}" height="${e.ok ? 12 : 7}" rx="1" fill="${
          e.ok ? 'var(--pass)' : 'var(--fail)'
        }"/>`
    )
    .join('');
  return `<svg class="spark" width="${h.length * (w + gap)}" height="12" viewBox="0 0 ${h.length * (w + gap)} 12">${bars}</svg>`;
}

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
      const correct = isCorrect(r, modelById(r.model));
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
    notesEl.replaceChildren(buildReleaseNotes(notes));
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

// Release notes come from GitHub, so they are remote text rendered inside the
// app. Built as DOM nodes with textContent rather than an HTML string: markup in
// a release body can only ever be read as characters, never parsed.
//
// The previous version also never rendered its headings — it bailed on any line
// starting with '#', which made both heading branches below it unreachable.
function buildReleaseNotes(notes) {
  const list = document.createElement('ul');

  notes.split('\n').forEach((raw) => {
    const line = raw.trim().replace(/<[^>]*>/g, '').trim();
    if (!line || line === '---' || line.startsWith('[')) return;

    const heading = /^(#{2,3})\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (!heading && !bullet) return;

    const li = document.createElement('li');
    if (heading) {
      const strong = document.createElement('strong');
      strong.className = heading[1] === '##' ? 'notes-version' : 'notes-section';
      strong.textContent = heading[2];
      li.className = 'notes-heading';
      li.appendChild(strong);
    } else {
      li.textContent = bullet[1];
    }
    if (li.textContent) list.appendChild(li);
  });

  return list;
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
// ============================================
// Scheduled re-testing
// ============================================
// Off by default and never silently enabled: every tick spends real API quota.
function applyAutoTestSchedule() {
  clearInterval(autoTestTimer);
  autoTestTimer = null;
  if (autoTestMinutes > 0) {
    autoTestTimer = setInterval(runScheduledTest, autoTestMinutes * 60 * 1000);
  }
  const label = $('#auto-test-note');
  if (label) {
    label.textContent = autoTestMinutes > 0 ? `Re-tests every ${autoTestMinutes}m` : '';
  }
}

function runScheduledTest() {
  // Never interrupt a run in progress, and never fire with nothing selected.
  if (isTesting) return;
  const selected = getSelectedModels();
  if (selected.length === 0 || usableKeys(PROVIDERS[activeProvider]).length === 0) return;
  runTests(selected, { scheduled: true });
}

$('#auto-test-select').addEventListener('change', (e) => {
  autoTestMinutes = Number(e.target.value) || 0;
  applyAutoTestSchedule();
  saveTestDefinition();
});

async function init() {
  await loadTestDefinition();
  await loadHistory();
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
