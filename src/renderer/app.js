// ============================================
// UPSTREAM CHECKER — Application Logic v2
// ============================================

const DEFAULT_TEST_PROMPT = 'What is 2+2? Answer in one word.';

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
  return { models: [], planModels: {}, keys: [], ...structuredClone(def) };
}

// State
let activeProvider = null; // resolved to the first available provider in init()
let models = [];
let testResults = [];
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
  renderProviderTabs();
  renderKeysList();
  renderModelsList();
  updateTestAllButton();
}

// ============================================
// API Keys management
// ============================================
function renderKeysList() {
  const p = PROVIDERS[activeProvider];
  const container = $('#keys-list');
  const countEl = $('#key-count');
  countEl.textContent = p.keys.length;

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
      <div class="key-info">
        <div class="key-name">${escapeHtml(k.name)}</div>
        <div class="key-value">
          <span class="key-masked">${maskKey(k.key)}</span>
          <button class="key-reveal-btn" data-key-id="${k.id}" title="Reveal">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="key-actions">
        <button class="key-toggle-btn ${k.active ? 'active' : ''}" data-key-id="${k.id}" title="${k.active ? 'Deactivate' : 'Activate'}">
          <div class="key-toggle-track"><div class="key-toggle-thumb"></div></div>
        </button>
        <button class="key-delete-btn" data-key-id="${k.id}" title="Remove">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </div>`
    )
    .join('');

  // Bind events
  $$('.key-reveal-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const keyId = btn.dataset.keyId;
      toggleKeyReveal(keyId);
    });
  });

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
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 12) return key.slice(0, 6) + '...' + key.slice(-4);
  return key.slice(0, 10) + '...' + key.slice(-4);
}

function toggleKeyReveal(keyId) {
  const p = PROVIDERS[activeProvider];
  const key = p.keys.find((k) => k.id === keyId);
  if (!key) return;

  const valueEl = $(`.key-item[data-key-id="${keyId}"] .key-masked`);
  const revealBtn = $(`.key-item[data-key-id="${keyId}"] .key-reveal-btn`);

  if (valueEl.dataset.revealed === 'true') {
    valueEl.textContent = maskKey(key.key);
    valueEl.dataset.revealed = 'false';
    revealBtn.style.color = '';
  } else {
    valueEl.textContent = key.key;
    valueEl.dataset.revealed = 'true';
    revealBtn.style.color = 'var(--accent)';
    // Auto-hide after 5 seconds
    setTimeout(() => {
      if (valueEl.dataset.revealed === 'true') {
        valueEl.textContent = maskKey(key.key);
        valueEl.dataset.revealed = 'false';
        revealBtn.style.color = '';
      }
    }, 5000);
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
    }

    p.models = [...models];

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

function formatContext(ctx) {
  if (!ctx) return '—';
  if (ctx >= 1000000) return `${Math.round(ctx / 1000000)}M`;
  if (ctx >= 1000) return `${Math.round(ctx / 1000)}K`;
  return String(ctx);
}

// ============================================
// Render models list in sidebar
// ============================================
function renderModelsList() {
  const container = $('#models-list');
  const countEl = $('#model-count');
  countEl.textContent = models.length;

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
    return;
  }

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

  // Bind selection
  $$('.model-item').forEach((item) => {
    item.addEventListener('click', () => item.classList.toggle('selected'));
  });

  updateTestAllButton();
}

function buildModelItem(m) {
  const badges = [];
  if (m.hasVision) badges.push('<span class="model-badge badge-vision">Vision</span>');
  if (m.hasReasoning) badges.push('<span class="model-badge badge-reasoning">Think</span>');
  if (m.isFree) badges.push('<span class="model-badge badge-free">Free</span>');

  return `
    <div class="model-item selected" data-model-id="${m.id}">
      <div class="model-checkbox"></div>
      <div class="model-info">
        <span class="model-name" title="${m.id}">${m.id}</span>
        ${m.contextLabel ? `<span class="model-context">${m.contextLabel}</span>` : ''}
      </div>
      <div class="model-badges">${badges.join('')}</div>
    </div>`;
}

function getSelectedModels() {
  const items = $$('.model-item.selected');
  const ids = [];
  items.forEach((el) => ids.push(el.dataset.modelId));
  return models.filter((m) => ids.includes(m.id));
}

function updateTestAllButton() {
  const count = getSelectedModels().length;
  const btn = $('#btn-test-all');
  const activeKeys = PROVIDERS[activeProvider].keys.filter((k) => k.active);
  btn.disabled = count === 0 || isTesting || activeKeys.length === 0;
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
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

let requestSeq = 0;
function nextRequestId() {
  requestSeq += 1;
  return `req_${Date.now()}_${requestSeq}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Backoff before retrying a hedge round; honors Retry-After (seconds) for 429.
function retryDelay(attempt, result) {
  if (result && result.statusCode === 429 && result.retryAfter) {
    return Math.min(result.retryAfter * 1000, 10000);
  }
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
    messages: [{ role: 'user', content: DEFAULT_TEST_PROMPT }],
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
        if (inflight === 0 && (stop || launched >= HEDGE_MAX)) finish(best);
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

  while (true) {
    if (abortTesting) return { status: 'fail', response: 'Aborted', time: 0, tokens: 0 };

    const r = await adaptiveNonStream(model, apiKey, baseUrl);

    if (r.status === 'pass' && !r.isEmpty) return r;

    if (r.status === 'pass' && r.isEmpty) {
      // Empty on the non-streaming endpoint: some models (byNara event-stream)
      // deliver content only over SSE — try streaming.
      if (abortTesting) return r;
      const streamed = await raceAttempts(model, apiKey, baseUrl, true, STREAM_HEDGE);
      if (streamed.status === 'pass' && !streamed.isEmpty) return streamed;
      // Both empty. Empty can be flaky, so retry the whole model once.
      if (!emptyRetried && !abortTesting) {
        emptyRetried = true;
        await sleep(500);
        continue;
      }
      return r;
    }

    // A failure. Retry on transient errors (429/5xx/network), honoring Retry-After
    // so we back off the per-minute limit instead of failing outright.
    const retryable = (r.statusCode && RETRYABLE_STATUS.has(r.statusCode)) || r.networkError;
    if (retryable && transientRetries < MAX_TEST_RETRIES && !abortTesting) {
      await sleep(retryDelay(transientRetries, r));
      transientRetries++;
      continue;
    }
    return r;
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
$('#btn-test-all').addEventListener('click', async () => {
  const selected = getSelectedModels();
  if (selected.length === 0 || isTesting) return;

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
  testResults = [];
  updateTestAllButton();
  setStatus('running', `Testing ${selected.length} models...`);
  showProgress(0, selected.length);
  initResultsTable();
  $('#btn-test-all').innerHTML = '<span class="spinner"></span> Testing...';

  // Pre-create rows in selection order; each is filled in turn, top to bottom.
  selected.forEach((model) =>
    addResultRow(model, { status: 'running', time: 0, response: 'Testing...', tokens: '-' })
  );

  // Sequential, in order: each model is fully resolved before the next starts, so
  // results appear top-to-bottom (never out of order) and only one request is in
  // flight at a time — well within the provider's per-minute request limit.
  for (let i = 0; i < selected.length; i++) {
    if (abortTesting) break;
    const model = selected[i];
    const result = await testModel(model, apiKey, baseUrl);
    if (abortTesting) break;
    testResults.push({ model: model.id, ...result, provider: p.name, group: model.groupName || '' });
    updateResultRow(model, result);
    updateStats();
    showProgress(i + 1, selected.length);
  }

  hideProgress();
  isTesting = false;
  $('#btn-test-all').innerHTML = originalBtnText;
  updateTestAllButton();

  const passed = testResults.filter((r) => r.status === 'pass').length;
  const failed = testResults.filter((r) => r.status === 'fail').length;
  if (failed === 0) setStatus('done', `All ${passed} models passed`);
  else if (passed === 0) setStatus('error', `All ${failed} models failed`);
  else setStatus('done', `Done: ${passed} passed, ${failed} failed`);
});

const originalBtnText = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Test All Models`;

// ============================================
// Results table
// ============================================
function initResultsTable() {
  $('#results-empty').style.display = 'none';
  $('#results-table').style.display = '';
  $('#results-body').innerHTML = '';
}

function addResultRow(model, result) {
  const tbody = $('#results-body');
  const tr = document.createElement('tr');
  tr.dataset.modelId = model.id;
  tr.className = result.status === 'running' ? 'row-running' : 'row-pending';
  tr.innerHTML = buildRowHtml(model, result);
  tbody.appendChild(tr);
}

function updateResultRow(model, result) {
  const tr = $(`#results-body tr[data-model-id="${model.id}"]`);
  if (!tr) return;
  if (result.isEmpty) tr.className = 'row-empty';
  else tr.className = result.status === 'pass' ? 'row-pass' : 'row-fail';
  tr.innerHTML = buildRowHtml(model, result);
}

// SVG icons for badges
const ICONS = {
  vision: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
  think: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9.5 2A5.5 5.5 0 005 7.5A5.5 5.5 0 009.5 13H10a4 4 0 014 4v1.5a5.5 5.5 0 00-5.5-5.5z"/><path d="M14.5 13H14a4 4 0 00-4 4v1.5a5.5 5.5 0 005.5-5.5V8a2.5 2.5 0 00-1-5z"/></svg>`,
  free: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 12V8H6a2 2 0 01-2-2V6a2 2 0 012-2h12"/><circle cx="16" cy="16" r="4"/><path d="M16 14v4M14 16h4"/></svg>`,
  timeout: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  tokens: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9 9h6M9 15h6"/><path d="M12 9v6"/></svg>`,
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
  return `<span class="status-icon running" title="Testing"><span class="spinner"></span></span>`;
}

function buildRowHtml(model, result) {
  const isRunning = result.status === 'running';
  const badge = statusIconBadge(result.status, result.isEmpty);

  let timeStr = '-';
  let timeClass = '';
  if (result.time != null) {
    const sec = (result.time / 1000).toFixed(1);
    timeStr = `${sec}s`;
    if (result.time < 5000) timeClass = 'time-fast';
    else if (result.time > 15000) timeClass = 'time-slow';
    else timeClass = 'time-medium';
  }

  const typeIcons = [];
  if (model.hasVision) typeIcons.push(iconSpan('vision', 'Vision', 'type-vision'));
  if (model.hasReasoning) typeIcons.push(iconSpan('think', 'Reasoning', 'type-think'));
  // Free tier icon: show on every row (tier comes from provider grouping, not free/paid anymore)
  const planIcon = model.noPlans
    ? ''
    : model.isFree
      ? iconSpan('free', 'Free', 'tier-free')
      : iconSpan('free', 'Free for Paid', 'tier-freepaid');

  const tokens = result.tokens != null ? String(result.tokens) : '-';
  const responseHtml = isRunning
    ? `<span class="response-placeholder">Testing...</span>`
    : result.isEmpty
      ? `<span class="response-empty">${escapeHtml((result.response || 'Empty').slice(0, 120))}</span>`
      : escapeHtml(result.response.slice(0, 120));
  const responseTitle = escapeHtml(result.response || '');

  return `
    <td class="cell-status">${badge}</td>
    <td class="cell-model">${escapeHtml(model.id)}</td>
    <td class="cell-type">${typeIcons.join('')} ${planIcon}</td>
    <td class="cell-context">${model.contextLabel || '—'}</td>
    <td class="cell-time ${timeClass}">${timeStr}</td>
    <td class="cell-tokens">${tokens}</td>
    <td class="cell-response" title="${responseTitle}">${responseHtml}</td>
  `;
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
  $('#stat-total').textContent = String(models.length);
  const passed = testResults.filter((r) => r.status === 'pass').length;
  const failed = testResults.filter((r) => r.status === 'fail').length;
  $('#stat-pass').textContent = String(passed);
  $('#stat-fail').textContent = String(failed);

  if (testResults.length > 0) {
    const times = testResults.filter((r) => r.time).map((r) => r.time);
    if (times.length > 0) {
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      $('#stat-avg-time').textContent = `${(avg / 1000).toFixed(1)}s`;
    }
  } else {
    $('#stat-avg-time').textContent = '-';
  }
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
  const header = 'Model,Provider,Plan,Status,Time (ms),Tokens,Response\n';
  const rows = testResults
    .map((r) => `"${r.model}","${r.provider}","${r.group || ''}","${r.status}",${r.time},${r.tokens},"${(r.response || '').replace(/"/g, '""')}"`)
    .join('\n');
  downloadFile(header + rows, 'upstream-checker-results.csv', 'text/csv');
});

$('#btn-export-json').addEventListener('click', () => {
  if (testResults.length === 0) return;
  downloadFile(JSON.stringify(testResults, null, 2), 'upstream-checker-results.json', 'application/json');
});

$('#btn-clear-results').addEventListener('click', () => {
  testResults = [];
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
