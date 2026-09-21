// ============================================
// UPSTREAM CHECKER — Application Logic v2
// ============================================

const DEFAULT_TEST_PROMPT = 'What is 2+2? Answer in one word.';
const DEFAULT_MAX_TOKENS = 50;

// Set app version from main process
window.electronAPI.onAppVersion((version) => {
  const versionEl = document.getElementById('app-version');
  if (versionEl) versionEl.textContent = `v${version}`;
});

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

// State
let activeProvider = 'nara';
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

function switchProvider(providerId) {
  activeProvider = providerId;
  const p = PROVIDERS[activeProvider];
  models = p.models || [];
  $('#base-url').value = p.baseUrl;
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
// Base URL
// ============================================
$('#base-url').addEventListener('change', async () => {
  PROVIDERS[activeProvider].baseUrl = $('#base-url').value.trim().replace(/\/$/, '');
  await saveProviderConfig(activeProvider);
});

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
// Test a single model — robust, handles reasoning
// ============================================
async function testModel(model, apiKey, baseUrl) {
  // Reasoning models need higher max_tokens + reasoning_effort
  const isReasoning = model.hasReasoning;
  const maxTokens = isReasoning ? 256 : DEFAULT_MAX_TOKENS;

  const payload = {
    model: model.id,
    messages: [{ role: 'user', content: DEFAULT_TEST_PROMPT }],
    max_tokens: maxTokens,
    stream: false,
  };
  // reasoning_effort: 'low' keeps thinking cheap while still giving an answer
  if (isReasoning) {
    payload.reasoning_effort = 'low';
  }

  try {
    const result = await window.electronAPI.apiRequest({
      url: `${baseUrl}/chat/completions`,
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (result.status === 200) {
      const data = JSON.parse(result.body);
      const choice = data.choices?.[0];
      const usage = data.usage || {};

      // Some reasoning models hide content but still succeed
      let content = choice?.message?.content?.trim() || '';

      // Also check reasoning_content (some providers use this field)
      if (!content && choice?.message?.reasoning_content) {
        content = choice.message.reasoning_content.trim();
      }

      // Empty content on reasoning model is still a valid pass
      const isEmpty = !content;
      return {
        status: 'pass',
        response: isEmpty ? '(reasoning only — no visible output)' : content,
        isEmpty,
        time: result.elapsed,
        tokens: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
      };
    } else {
      let errMsg = `HTTP ${result.status}`;
      try {
        const errData = JSON.parse(result.body);
        errMsg = errData.error?.message || errMsg;
      } catch (_) {}
      return { status: 'fail', response: errMsg, time: result.elapsed, tokens: 0, statusCode: result.status };
    }
  } catch (err) {
    return { status: 'fail', response: err.error || err.message || 'Request failed', time: err.elapsed || 0, tokens: 0 };
  }
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

  for (let i = 0; i < selected.length; i++) {
    if (abortTesting) break;

    const model = selected[i];
    addResultRow(model, { status: 'running', time: 0, response: 'Testing...', tokens: '-' });

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
      ? `<span class="response-empty">Empty</span>`
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
// Add Provider modal
// ============================================
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

// ============================================
// Init
// ============================================
async function init() {
  await loadAllProviders();
  if (!PROVIDERS[activeProvider]) {
    activeProvider = Object.keys(PROVIDERS)[0];
  }
  const p = PROVIDERS[activeProvider];
  $('#base-url').value = p.baseUrl;
  renderProviderTabs();
  renderKeysList();
  renderModelsList();
  setStatus('idle', 'Ready — add an API key to begin');
  setupUpdateListeners();
}

init();
