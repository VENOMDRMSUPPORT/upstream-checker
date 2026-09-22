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
// Model capabilities
// ============================================
// Providers disagree about almost everything here. Checked against the live
// endpoints of all five configured providers, the shapes actually in use are:
//
//   NaraRouter /api/pricing  supports_vision, supports_image_generation,
//                            supports_video_generation, reasoning
//   NaraRouter /v1/models    vision, reasoning
//   Inception  /v1/models    input_modalities[], output_modalities[],
//                            supported_features[] ("tools", "json_mode",
//                            "structured_outputs")
//   Nexum, Dark API, Mirai   nothing at all
//
// So two providers report capabilities and three report none. A model with no
// declared capability is shown as having none — the table says what the provider
// said, and stays silent where the provider was.
const CAPABILITIES = [
  { id: 'tools',     label: 'Tools',     desc: 'Function calling and external tool use' },
  { id: 'reasoning', label: 'Reasoning', desc: 'Extended thinking before answering' },
  { id: 'structured',label: 'Structured',desc: 'JSON schema and constrained output' },
  { id: 'vision',    label: 'Vision',    desc: 'Accepts images as input' },
  { id: 'image',     label: 'Image gen', desc: 'Produces images' },
  { id: 'audio',     label: 'Audio',     desc: 'Accepts or produces audio' },
  { id: 'video',     label: 'Video',     desc: 'Accepts or produces video' },
  { id: 'files',     label: 'Files',     desc: 'Accepts documents or file uploads' },
];

const CAP_ICONS = {
  tools: '<path d="M14.7 6.3a5 5 0 01-6.6 6.6L3 18l3 3 5.1-5.1a5 5 0 006.6-6.6l-2.8 2.8-2.1-2.1z"/>',
  reasoning: '<path d="M9.5 3A5.5 5.5 0 004 8.5c0 1.6.7 3 1.8 4V15a2 2 0 002 2h.7v2a1 1 0 001 1h5a1 1 0 001-1v-2h.7a2 2 0 002-2v-2.5A5.4 5.4 0 0020 8.5 5.5 5.5 0 0014.5 3z"/>',
  structured: '<path d="M8 3H7a2 2 0 00-2 2v4a2 2 0 01-2 2 2 2 0 012 2v4a2 2 0 002 2h1M16 3h1a2 2 0 012 2v4a2 2 0 002 2 2 2 0 00-2 2v4a2 2 0 01-2 2h-1"/>',
  vision: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  audio: '<path d="M12 2a3 3 0 00-3 3v7a3 3 0 006 0V5a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v3"/>',
  video: '<rect x="2" y="5" width="14" height="14" rx="2"/><path d="M22 8l-6 4 6 4V8z"/>',
  files: '<path d="M21.4 11.05l-9.19 9.19a5 5 0 01-7.07-7.07l9.19-9.19a3.33 3.33 0 014.71 4.71l-9.2 9.19a1.67 1.67 0 01-2.36-2.36l8.49-8.48"/>',
};

const truthy = (v) => v === true || v === 'true' || v === 1;
const listOf = (v) => (Array.isArray(v) ? v.map((x) => String(x).toLowerCase()) : []);

// Reads every shape seen in the wild and returns the capabilities the provider
// actually claimed. Nothing is inferred from a model's name: a name is evidence
// about what someone called it, not about what it can do.
function readCapabilities(m) {
  const caps = new Set();

  // Explicit booleans (NaraRouter, both of its endpoints)
  if (truthy(m.vision) || truthy(m.supports_vision)) caps.add('vision');
  if (truthy(m.reasoning) || truthy(m.supports_reasoning)) caps.add('reasoning');
  if (truthy(m.supports_image_generation)) caps.add('image');
  if (truthy(m.supports_video_generation)) caps.add('video');
  if (truthy(m.tools) || truthy(m.supports_tools) || truthy(m.function_calling)) caps.add('tools');
  if (truthy(m.structured_outputs) || truthy(m.json_mode)) caps.add('structured');
  if (truthy(m.audio) || truthy(m.supports_audio)) caps.add('audio');

  // Modality arrays (Inception, and the OpenRouter shape under architecture)
  const inputs = [...listOf(m.input_modalities), ...listOf(m.architecture?.input_modalities)];
  const outputs = [...listOf(m.output_modalities), ...listOf(m.architecture?.output_modalities)];
  if (inputs.some((x) => x.includes('image'))) caps.add('vision');
  if (inputs.some((x) => x.includes('audio'))) caps.add('audio');
  if (inputs.some((x) => x.includes('video'))) caps.add('video');
  if (inputs.some((x) => x.includes('file') || x.includes('document') || x.includes('pdf'))) caps.add('files');
  if (outputs.some((x) => x.includes('image'))) caps.add('image');
  if (outputs.some((x) => x.includes('audio'))) caps.add('audio');
  if (outputs.some((x) => x.includes('video'))) caps.add('video');

  // Feature lists (Inception's supported_features, OpenRouter's
  // supported_parameters, and the generic capabilities array)
  const feats = [
    ...listOf(m.supported_features),
    ...listOf(m.supported_parameters),
    ...listOf(m.capabilities),
    ...listOf(m.features),
  ];
  feats.forEach((f) => {
    if (f.includes('tool') || f.includes('function')) caps.add('tools');
    if (f.includes('json') || f.includes('structured') || f.includes('response_format')) caps.add('structured');
    if (f.includes('vision') || f.includes('image_input')) caps.add('vision');
    if (f.includes('reasoning') || f.includes('thinking')) caps.add('reasoning');
    if (f.includes('audio')) caps.add('audio');
    if (f.includes('video')) caps.add('video');
    if (f.includes('file') || f.includes('document')) caps.add('files');
  });

  return caps;
}

function capabilityIcons(model) {
  const caps = model.caps instanceof Set ? model.caps : new Set(model.caps || []);
  const proven = model.probedCaps instanceof Set ? model.probedCaps : new Set();
  return CAPABILITIES.filter((c) => caps.has(c.id))
    .map((c) => `<span class="cap-icon cap-${c.id} ${proven.has(c.id) ? 'cap-verified' : ''}" title="${c.label} — ${c.desc}. ${proven.has(c.id) ? 'Proven by probe.' : 'Declared by the provider.'}">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${CAP_ICONS[c.id]}</svg>
      </span>`)
    .join('');
}

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

const KIND_LABELS = { chat: '', image: 'Image', video: 'Video' };

// Hedging is never applied to a generator: it exists to rescue a chat model that
// is unusually slow, and a generator is supposed to be slow, so racing it would
// just buy several images at once.
function kindLimits(kind) {
  if (kind === 'image') return { deadline: settings.deadlineImageMs, hedge: false };
  if (kind === 'video') return { deadline: settings.deadlineVideoMs, hedge: false };
  return { deadline: settings.deadlineChatMs, hedge: settings.hedgeEnabled };
}

function classifyModel(providerId, model) {
  // A declared capability outranks every heuristic below it: NaraRouter states
  // outright which models generate images or video, so there is nothing to infer.
  const caps = model.caps instanceof Set ? model.caps : new Set(model.caps || []);
  if (truthy(model.supports_video_generation)) return 'video';
  if (truthy(model.supports_image_generation)) return 'image';

  const adapter = (window.INTEGRATED_PROVIDERS || {})[providerId];
  if (adapter && typeof adapter.classify === 'function') {
    const k = adapter.classify(model);
    if (KIND_LABELS[k] !== undefined) return k;
  }
  const id = `${model.id || ''} ${model.display_name || model.name || ''}`.toLowerCase();
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

// ============================================
// Settings
// ============================================
// Every value here was a constant in the source. They are settings because each
// one maps to a decision a user actually faces — how much a slow model is worth
// spending on, how long a generator is allowed to take, how much history to
// keep. Defaults are the values the app shipped with.
const DEFAULT_SETTINGS = {
  // Latency bands for the TIME column. Calibrated to what a chat completion
  // actually costs: under 5s flagged most of a healthy run amber, which left
  // the colour saying nothing.
  timeGoodMs: 10000,
  timeOkMs: 15000,

  // How long one model may take before it is called hung. A generator needs
  // minutes; a chat model that takes minutes is broken.
  deadlineChatMs: 75000,
  deadlineImageMs: 240000,
  deadlineVideoMs: 600000,

  // Retry policy for transient failures and for provider rate limits.
  maxTestRetries: 2,
  maxRateLimitWaits: 3,

  // Hedging rescues a model that is merely slow by racing extra attempts. It is
  // also the single biggest multiplier on how many requests a run costs.
  hedgeEnabled: true,
  hedgeMax: 6,
  hedgeStepMs: 2000,

  // A reasoning model can spend its whole budget thinking and return no content
  // at all, which the app then reports as an empty response. Raising this fixes
  // that case.
  maxOutputTokens: 512,
  mediaPrompt: 'A single red circle centred on a plain white background.',

  historyMaxRuns: 300,
  sparkRuns: 12,

  notifyRegression: true,
  notifyRunComplete: false,

  // Generators are unselected by default, but once selected they would join
  // every scheduled run — generating images on a timer, unattended.
  scheduleSkipMedia: true,

  // Appearance. Every colour in the stylesheet comes from a custom property, so
  // a theme is a block of overrides rather than a second stylesheet.
  theme: 'default',
  accent: 'cyan',
  density: 'normal',

  // off | errors | all. Off by default: the log is a file on disk holding the
  // traffic of an authenticated API, even with the key stripped out of it.
  logLevel: 'off',

  legendOpen: false,

  // Sidebar width in px; 0 means hidden. Capped at the design width — the
  // sidebar can be narrowed or shut, never widened, because everything in it is
  // laid out against that measure.
  sidebarWidth: 320,

  // Models tested at the same time. 1 is the original behaviour. Raising it is
  // the only thing that actually shortens a run — widening the hedge spends more
  // requests on one model without lowering that model's own latency.
  concurrency: 1,
};

const THEMES = [
  { id: 'default',  name: 'Deep Space', strip: ['#060a14', '#0f1526', '#243054', '#00d4ff'] },
  { id: 'midnight', name: 'Midnight',   strip: ['#0b0d12', '#181b24', '#2a3040', '#00d4ff'] },
  { id: 'carbon',   name: 'Carbon',     strip: ['#0d0d0d', '#1c1c1c', '#2e2e2e', '#00d4ff'] },
  { id: 'amoled',   name: 'AMOLED',     strip: ['#000000', '#0a0a0a', '#242424', '#00d4ff'] },
  { id: 'nord',     name: 'Nord',       strip: ['#20242e', '#2e3440', '#3f4858', '#88c0d0'] },
  { id: 'daylight', name: 'Daylight',   strip: ['#f4f6fa', '#ffffff', '#cfd8e3', '#0ea5e9'] },
];

const ACCENTS = [
  { id: 'cyan', hex: '#00d4ff' }, { id: 'violet', hex: '#a78bfa' }, { id: 'green', hex: '#34d399' },
  { id: 'amber', hex: '#fbbf24' }, { id: 'rose', hex: '#fb7185' }, { id: 'blue', hex: '#60a5fa' },
];

// The default theme is the stylesheet's own :root, so it carries no attribute.
function applyAppearance() {
  const el = document.documentElement;
  if (settings.theme && settings.theme !== 'default') el.setAttribute('data-theme', settings.theme);
  else el.removeAttribute('data-theme');
  el.setAttribute('data-accent', settings.accent);
  el.setAttribute('data-density', settings.density);
}

let settings = { ...DEFAULT_SETTINGS };

async function loadSettings() {
  try {
    const data = await window.electronAPI.readConfig();
    if (data.settings && typeof data.settings === 'object') {
      Object.keys(DEFAULT_SETTINGS).forEach((k) => {
        const v = data.settings[k];
        if (typeof v === typeof DEFAULT_SETTINGS[k]) settings[k] = v;
      });
    }
  } catch (_) {}
}

let saveSettingsTimer = null;
function queueSettingsSave() {
  clearTimeout(saveSettingsTimer);
  saveSettingsTimer = setTimeout(async () => {
    try {
      const data = await window.electronAPI.readConfig();
      data.settings = { ...settings };
      await window.electronAPI.writeConfig(data);
    } catch (err) {
      console.warn('Failed to persist settings:', err);
    }
  }, 350);
}

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
  const entry = { name: p.name, baseUrl: p.baseUrl, keys: p.keys, rpm: p.rpm ?? null };
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
    await window.electronAPI.appendRun(run, settings.historyMaxRuns);
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
      if (s.rpm !== undefined) p.rpm = s.rpm;
      p.keys = s.keys || [];
    } else {
      stored[def.id] = { name: p.name, baseUrl: p.baseUrl, keys: p.keys, rpm: p.rpm ?? null };
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
      stored[builtin.id] = { name: builtin.name, baseUrl: builtin.baseUrl, keys: builtin.keys, rpm: builtin.rpm ?? null };
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
    p.rpm = s.rpm ?? null;
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

async function addProvider({ name, baseUrl, rpm }) {
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
  PROVIDERS[id].rpm = Number.isFinite(rpm) && rpm > 0 ? rpm : null;
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
  renderLegend();
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

// Discovery for one key. A provider can hand out catalogues that differ per key —
// one key unlocking the Chinese models and another the Claude/GPT ones is a real
// arrangement — so this runs once per key and the caller merges the results.
async function discoverModels(p, apiKey) {
  const adapter = (window.INTEGRATED_PROVIDERS || {})[p.id];
  if (adapter && adapter.fetchModels) {
    return adapter.fetchModels({
      apiKey,
      baseUrl: p.baseUrl,
      plansUrl: p.plansUrl,
      pricingUrl: p.pricingUrl,
      apiRequest: window.electronAPI.apiRequest,
      formatContext,
      getFreeGroupName,
    });
  }

  // Plain OpenAI-compatible provider: show all models, no plan filtering
  const modelsResult = await window.electronAPI.apiRequest({
    url: `${p.baseUrl}/models`,
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  });
  if (modelsResult.status !== 200) throw new Error(`HTTP ${modelsResult.status}`);
  const rawModels = JSON.parse(modelsResult.body).data || [];

  return rawModels
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

$('#btn-fetch-models').addEventListener('click', async () => {
  const p = PROVIDERS[activeProvider];
  const activeKeys = usableKeys(p);
  if (activeKeys.length === 0) {
    setStatus('error', 'No active API keys. Add and activate a key first.');
    return;
  }

  const btn = $('#btn-fetch-models');
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Fetching...';
  setStatus('running', `Fetching models from ${activeKeys.length} key${activeKeys.length === 1 ? '' : 's'}...`);

  // Every key is asked, and the catalogues are unioned. Each model records which
  // keys returned it, because that is what testing needs later: sending a Claude
  // model the key that only unlocks the Chinese ones produces a 404 and records a
  // working model as broken.
  const byId = new Map();
  const failures = [];

  for (const k of activeKeys) {
    try {
      const list = await discoverModels(p, k.key);
      list.forEach((m) => {
        const existing = byId.get(m.id);
        if (existing) {
          if (!existing.keyIds.includes(k.id)) existing.keyIds.push(k.id);
        } else {
          byId.set(m.id, { ...m, keyIds: [k.id] });
        }
      });
    } catch (err) {
      // One bad key must not empty the catalogue the others returned.
      failures.push(`${k.name}: ${err.message || 'failed'}`);
    }
  }

  try {
    if (byId.size === 0) throw new Error(failures[0] || 'No models returned');

    models = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    // Two entries sharing an id are the same model; keeping both would create two
    // table rows with the same key, and only the first would ever be updated.
    models = tagAliasGroups(dedupeById(models));

    const adapter = (window.INTEGRATED_PROVIDERS || {})[p.id];
    if (adapter && typeof adapter.excludeModel === 'function') {
      models = models.filter((m) => !adapter.excludeModel(m));
    }

    models.forEach((m) => {
      m.declaredCaps = readCapabilities(m);
      applyProbedCaps(m, p.id);
      m.kind = classifyModel(p.id, m);
    });

    p.models = [...models];
    // Chat models start selected. Generators don't: each one costs a real image
    // or video generation and a minute of wall clock, so including them in every
    // run — especially a scheduled one — has to be a decision, not a default.
    p.selected = new Set(models.filter((m) => !isMedia(m)).map((m) => m.id));

    renderModelsList();
    renderLegend();

    const keyNote = activeKeys.length > 1 ? ` across ${activeKeys.length} keys` : '';
    if (p.plansUrl) {
      const freeCount = models.filter((m) => m.isFree).length;
      const freeForPaidCount = models.filter((m) => m.isFreeForPaid).length;
      setStatus('done', `Fetched ${models.length} models${keyNote} (${freeCount} free + ${freeForPaidCount} free for paid)`);
    } else if (failures.length) {
      setStatus('error', `Fetched ${models.length} models${keyNote} — ${failures.join('; ')}`);
    } else {
      setStatus('done', `Fetched ${models.length} models${keyNote}`);
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

// A router often exposes the same upstream model twice: once bare and once under
// a tier prefix ("deepseek-v4.1-flash" and "dark-free/deepseek-v4.1-flash"). They
// are separate entries with separate ids, so they can't be deduped — but they are
// the same model, and counting them as two distorts uptime and makes the list
// read as twice the catalogue it is.
//
// The bare name is recorded as an alias group so the sidebar can say so. They are
// still tested separately: a prefix usually routes to a different pool, and the
// whole point of the tool is that one can be up while the other is down.
function tagAliasGroups(list) {
  const bare = (id) => String(id).split('/').pop().toLowerCase();
  const counts = new Map();
  list.forEach((m) => counts.set(bare(m.id), (counts.get(bare(m.id)) || 0) + 1));
  list.forEach((m) => {
    const b = bare(m.id);
    if (counts.get(b) > 1) {
      m.aliasGroup = b;
      m.aliasCount = counts.get(b);
    }
  });
  return list;
}

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
    m.limit?.context ??
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
  renderCostEstimate();
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
  // When a provider's keys unlock different catalogues, say which key reaches
  // this model — otherwise the list looks like one pool and a model that only
  // one key can serve is indistinguishable from one any key can.
  const p = PROVIDERS[activeProvider];
  const allKeys = p ? usableKeys(p) : [];
  if (allKeys.length > 1 && Array.isArray(m.keyIds) && m.keyIds.length < allKeys.length) {
    const names = allKeys.filter((k) => m.keyIds.includes(k.id)).map((k) => k.name);
    if (names.length) {
      const short = names[0].split(/\s+/)[0];
      badges.push(
        `<span class="model-badge badge-key" title="${escapeHtml('Served by: ' + names.join(', '))}">${escapeHtml(
          names.length > 1 ? `${names.length} keys` : short
        )}</span>`
      );
    }
  }
  if (m.aliasGroup) {
    badges.push(
      `<span class="model-badge badge-alias" title="${escapeHtml(m.aliasCount + ' routes expose ' + m.aliasGroup + '. Tested separately — one can be up while another is down.')}">×${m.aliasCount}</span>`
    );
  }
  const kindLabel = KIND_LABELS[m.kind] || '';
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

// Which field a provider accepts for the output cap. Starts at the long-standing
// max_tokens and flips the first time a provider rejects it.
const tokenLimitFields = new Map();
function tokenLimitField(providerId) {
  if (tokenLimitFields.has(providerId)) return tokenLimitFields.get(providerId);
  const declared = (window.INTEGRATED_PROVIDERS || {})[providerId]?.meta?.tokenLimitField;
  return declared || 'max_tokens';
}
function swapTokenLimitField(providerId) {
  if (tokenLimitFields.get(providerId) === 'max_completion_tokens') return false;
  tokenLimitFields.set(providerId, 'max_completion_tokens');
  return true;
}

// ============================================
// Test reliability settings
// ============================================
// Models are tested one at a time, in order. Each model starts with a SINGLE
// request (cheap, stays within the per-minute limit). If it is slow, we escalate
// automatically — firing another parallel attempt every HEDGE_STEP_MS up to
// HEDGE_MAX — and the fastest correct answer wins, cancelling the rest. Fast
// models cost one request; only slow ones fan out, so the result comes back ASAP.
// Per-model hard cap lives in kindLimits() — a video generator legitimately
// needs minutes, a chat model that takes one is broken.
const STREAM_HEDGE = 2;          // parallel streaming attempts during empty recovery
// 429 is handled by the rate-limit path below, not here: it isn't a transient
// glitch to back off from, it's the provider telling us to wait out its window.
const RETRYABLE_STATUS = new Set([502, 503, 504]);

// Hitting a per-minute cap is not a property of the model — it's a property of
// how fast we were going. Waiting the window out and continuing gives the model
// a real verdict instead of recording our own pacing as its failure.
const RATE_LIMIT_WAIT_MS = 60000; // a full window, when the provider doesn't say
const RATE_LIMIT_PATTERN =
  /rate.?limit|too many requests|per[- ]minute|requests? per (minute|min)|\brpm\b|concurrency limit/i;

let runStatusText = '';

// Checked before the rate limit, because a provider will happily return 429 for
// a billing problem: NaraRouter answers "Insufficient credits. Please top up your
// balance" with a 429, and treating that as throttling means waiting out three
// full windows for something no amount of waiting fixes.
function isRateLimit(r) {
  if (isEntitlementDenial(r)) return false;
  if (r.statusCode === 429) return true;
  return typeof r.response === 'string' && RATE_LIMIT_PATTERN.test(r.response);
}

// A key can be refused a model it simply isn't entitled to — an unfunded account
// asked for a paid-tier model, a plan that doesn't include it. That is a fact
// about the key, not about the model, and it is permanent until the account
// changes, so unlike a rate limit there is nothing to wait for.
// Matched on the message, not the status code. Real examples this has to catch:
//   403 "Your plan does not include the requested model."
//   429 "Insufficient credits. Please top up your balance and try again..."
// The status is unreliable — the second is a billing problem wearing a rate
// limit's code — so the wording is what decides.
const ENTITLEMENT_PATTERN = new RegExp(
  [
    'insufficient',
    'top[\s-]?up',
    'no credit|out of credit|credits? remaining',
    'plan does not includ|not includ(?:e|ed) (?:in|on) your',
    'not (?:entitled|available on) your',
    'upgrade your|requires? a paid|paid plan',
    'payment required|billing',
    'quota exceeded|subscribe',
  ].join('|'),
  'i'
);

function isEntitlementDenial(r) {
  if (r.statusCode === 402) return true;
  return typeof r.response === 'string' && ENTITLEMENT_PATTERN.test(r.response);
}

// "keyId::modelId" pairs the provider has refused this session. Discovery can't
// always tell what a key is entitled to — NaraRouter's catalogue comes from
// public pricing endpoints that never see a key, so every key looks like it can
// reach everything — so entitlement is learned the only way it can be: by being
// told no, once, and not asking that key again.
const deniedPairs = new Set();
const denialKey = (keyId, modelId) => `${keyId}::${modelId}`;

// ============================================
// Keys and pacing
// ============================================
// The per-minute cap belongs to the key, not to the app: it is a property of the
// plan that key is on. Both the budget and the cooldown are therefore tracked per
// key, which is also what makes a second key worth having — the run moves onto it
// instead of sitting out a whole minute.
const keyCooldownUntil = new Map(); // keyId -> timestamp
const keyRequestTimes = new Map();  // keyId -> recent request timestamps
let keyCursor = 0;

function keyNameById(keyId) {
  const p = PROVIDERS[activeProvider];
  const k = p && p.keys.find((x) => x.id === keyId);
  return k ? k.name : '';
}

function rpmOf(provider) {
  const n = Number(provider.rpm);
  return Number.isFinite(n) && n > 0 ? n : 0; // 0 = unknown, so don't pace
}

// The keys that can actually serve this model. Discovery records which keys
// returned each model, so a provider whose keys unlock different catalogues gets
// each request sent to a key that has the model — otherwise a working model is
// recorded as broken because the wrong key was used to ask for it.
function keysFor(provider, model) {
  let keys = usableKeys(provider);
  if (model && Array.isArray(model.keyIds) && model.keyIds.length > 0) {
    const listed = keys.filter((k) => model.keyIds.includes(k.id));
    if (listed.length > 0) keys = listed;
  }
  if (!model) return keys;
  const permitted = keys.filter((k) => !deniedPairs.has(denialKey(k.id, model.id)));
  // If every key has been refused, hand back the full list so the caller still
  // gets a real error to report rather than "no key available".
  return permitted.length > 0 ? permitted : keys;
}

function slotsUsed(keyId, now) {
  return (keyRequestTimes.get(keyId) || []).filter((t) => now - t < 60000).length;
}

// Round-robin over the eligible keys, but a key with a free slot in its own
// minute beats one that is merely not cooling off. Without that preference the
// rotation would stop on a key that has spent its budget and wait there while a
// second key sat idle — which is the whole reason a second key is worth having.
function pickKey(provider, model) {
  const keys = keysFor(provider, model);
  if (keys.length === 0) return null;
  const now = Date.now();
  const rpm = rpmOf(provider);

  let free = null;  // usable right now
  let ready = null; // not cooling, but at its per-minute cap

  for (let i = 0; i < keys.length; i++) {
    const k = keys[(keyCursor + i) % keys.length];
    if ((keyCooldownUntil.get(k.id) || 0) > now) continue;
    if (!rpm || slotsUsed(k.id, now) < rpm) { free = k; break; }
    if (!ready) ready = k;
  }

  const chosen = free || ready;
  if (chosen) keyCursor = (keys.indexOf(chosen) + 1) % keys.length;
  return chosen;
}

function soonestKeyAvailable(provider, model) {
  const keys = keysFor(provider, model);
  if (keys.length === 0) return Infinity;
  return Math.min(...keys.map((k) => keyCooldownUntil.get(k.id) || 0));
}

// Holds a request back until its key has a slot in its own minute. Staying under
// the cap costs a few seconds; going over it costs a full window — so pacing is
// strictly cheaper than recovering from a 429.
async function waitForSlot(provider, key) {
  const rpm = rpmOf(provider);
  if (!rpm) return;
  while (!abortTesting) {
    const now = Date.now();
    const recent = (keyRequestTimes.get(key.id) || []).filter((t) => now - t < 60000);
    if (recent.length < rpm) {
      recent.push(now);
      keyRequestTimes.set(key.id, recent);
      return;
    }
    const waitMs = 60000 - (now - recent[0]) + 100;
    keyRequestTimes.set(key.id, recent);
    setStatus('running', `Pacing ${provider.name} — next slot in ${Math.ceil(waitMs / 1000)}s`);
    await sleep(Math.min(1000, waitMs));
  }
}

// Every key is cooling off; wait for whichever frees up first.
async function waitForAnyKey(provider, model) {
  let waited = false;
  while (!abortTesting) {
    const remaining = soonestKeyAvailable(provider, model) - Date.now();
    if (remaining <= 0 || !Number.isFinite(remaining)) break;
    waited = true;
    setStatus('running', `Rate limited — resuming in ${Math.ceil(remaining / 1000)}s`);
    await sleep(Math.min(1000, remaining));
  }
  if (waited && !abortTesting) setStatus('running', runStatusText);
}

function coolKeyDown(keyId, result) {
  const ms = result.retryAfter > 0 ? result.retryAfter * 1000 : RATE_LIMIT_WAIT_MS;
  keyCooldownUntil.set(keyId, Math.max(keyCooldownUntil.get(keyId) || 0, Date.now() + ms));
}

let requestSeq = 0;
// Every id handed out during a run, so Stop can kill sockets that are already in
// flight. Without this, hitting Stop still leaves the hedged requests
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
async function attemptOnce(model, provider, stream, requestId) {
  const key = pickKey(provider, model);
  if (!key) return { status: 'fail', response: 'All keys are rate limited', time: 0, tokens: 0, allKeysCooling: true };
  await waitForSlot(provider, key);
  if (abortTesting) return { status: 'fail', response: 'Aborted', time: 0, tokens: 0, cancelled: true };
  const apiKey = key.key;
  const baseUrl = provider.baseUrl;
  // reasoning_effort:'low' is sent to every model — it is a no-op on non-reasoning
  // models and clamps safely, but it makes reasoning-heavy models think briefly
  // instead of burning time on a deep chain for a trivial prompt. ('minimal' is
  // NOT safe — some models return empty under it — so 'low' is the floor.)
  const media = isMedia(model);
  const payload = {
    model: model.id,
    messages: [{ role: 'user', content: media ? settings.mediaPrompt : testPrompt || DEFAULT_TEST_PROMPT }],
    stream: !!stream,
  };
  // Newer OpenAI-compatible gateways rejected max_tokens in favour of
  // max_completion_tokens. Which one a provider accepts is learned from its own
  // 400 and remembered, so the swap costs one request per provider, once.
  payload[tokenLimitField(provider.id)] = settings.maxOutputTokens;
  // reasoning_effort steers a reasoning model away from a deep chain on a trivial
  // prompt. It means nothing to a generator, so it isn't sent to one.
  if (!media) payload.reasoning_effort = 'low';

  try {
    const { deadline } = kindLimits(model.kind);
    const result = await window.electronAPI.apiRequest({
      url: `${baseUrl}/chat/completions`,
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      requestId,
      timeoutMs: deadline,
      logLevel: settings.logLevel,
    });

    // Cancelled hedge loser — ignore it (raceAttempts skips cancelled results).
    if (result.cancelled) return { status: 'fail', response: 'cancelled', time: result.elapsed || 0, tokens: 0, cancelled: true, keyId: key.id };

    // Transport-level failure; the handler resolves these so the message and the
    // elapsed time survive the trip across IPC.
    if (result.networkError) {
      return { status: 'fail', response: result.error || 'Request failed', time: result.elapsed || 0,
               tokens: 0, networkError: true, timedOut: !!result.timedOut, keyId: key.id };
    }

    if (result.status === 200) {
      const parsed = stream ? parseStreamedCompletion(result.body) : parseChatCompletion(result.body);
      const usage = parsed.usage || {};
      if (!parsed.content) return { ...buildEmptyResult(usage, result.elapsed), keyId: key.id };
      return {
        keyId: key.id,
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

    // "Unsupported parameter: max_tokens" and friends — switch the field and go
    // again rather than reporting a working model as broken.
    if (result.status === 400 && /max_tokens|max_completion_tokens/i.test(errMsg)) {
      const swapped = swapTokenLimitField(provider.id);
      if (swapped) return attemptOnce(model, provider, stream, nextRequestId());
    }
    const ra = parseInt(result.headers?.['retry-after'], 10);
    return { status: 'fail', response: errMsg, time: result.elapsed, tokens: 0, statusCode: result.status, retryAfter: isNaN(ra) ? 0 : ra, keyId: key.id };
  } catch (err) {
    return { status: 'fail', response: err.error || err.message || 'Request failed', time: err.elapsed || 0, tokens: 0, cancelled: !!err.cancelled, networkError: !err.cancelled, keyId: key.id };
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
function raceAttempts(model, provider, stream, count) {
  return new Promise((resolve) => {
    const ids = [];
    let pending = count;
    let best = null;
    let settled = false;
    const cancelRest = () => ids.forEach((id) => window.electronAPI.cancelApiRequest(id));

    for (let i = 0; i < count; i++) {
      const id = nextRequestId();
      ids.push(id);
      attemptOnce(model, provider, stream, id).then((r) => {
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
function adaptiveNonStream(model, provider) {
  const { deadline, hedge } = kindLimits(model.kind);
  const maxAttempts = hedge ? Math.max(1, settings.hedgeMax) : 1;
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
      attemptOnce(model, provider, false, id).then((r) => {
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
      if (!stop && launched < maxAttempts) stepTimer = setTimeout(launch, settings.hedgeStepMs);
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
async function testModel(model, provider) {
  let transientRetries = 0;
  let emptyRetried = false;
  let rateLimitWaits = 0;
  let rounds = 0;

  // `time` is only the winning attempt, so a 502 retried twice still reports
  // ~0.3s. Carrying the round count lets the table show that it took more than
  // one go instead of presenting the last attempt as the whole story.
  const done = (r) => ({ ...r, attempts: rounds });

  while (true) {
    // Every key may still be cooling from an earlier model's 429.
    if (soonestKeyAvailable(provider, model) > Date.now()) {
      updateResultRow(model, { status: 'running', waiting: true, time: null, tokens: null });
      await waitForAnyKey(provider, model);
      updateResultRow(model, RUNNING_RESULT);
    }
    if (abortTesting) return done({ status: 'fail', response: 'Aborted', time: 0, tokens: 0 });
    rounds += 1;

    const r = await adaptiveNonStream(model, provider);

    if (r.status === 'pass' && !r.isEmpty) return done(r);

    if (r.status === 'pass' && r.isEmpty) {
      // Generators don't stream text, so the SSE recovery below would just buy a
      // second generation for nothing.
      if (isMedia(model)) return done(r);
      // Empty on the non-streaming endpoint: some models (byNara event-stream)
      // deliver content only over SSE — try streaming.
      if (abortTesting) return done(r);
      const streamed = await raceAttempts(model, provider, true, STREAM_HEDGE);
      if (streamed.status === 'pass' && !streamed.isEmpty) return done(streamed);
      // Both empty. Empty can be flaky, so retry the whole model once.
      if (!emptyRetried && !abortTesting) {
        emptyRetried = true;
        await sleep(500);
        continue;
      }
      return done(r);
    }

    // This key isn't entitled to this model. Remember that and try another key
    // if one is left — a model the account can actually reach must not be
    // recorded as down because the wrong key asked for it.
    if (isEntitlementDenial(r) && r.keyId && !abortTesting) {
      const before = keysFor(provider, model).length;
      deniedPairs.add(denialKey(r.keyId, model.id));
      const after = keysFor(provider, model).filter(
        (k) => !deniedPairs.has(denialKey(k.id, model.id))
      ).length;
      if (after > 0 && after < before) continue; // another key may be entitled
      return done({ ...r, entitlementDenied: true });
    }

    // Rate limited. Cool that key down and try again — with a second key the run
    // simply moves onto it, and only waits when every key is capped. Being
    // throttled never gets recorded as the model's failure.
    if ((isRateLimit(r) || r.allKeysCooling) && rateLimitWaits < settings.maxRateLimitWaits && !abortTesting) {
      rateLimitWaits += 1;
      if (r.keyId) coolKeyDown(r.keyId, r);
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
    if (retryable && transientRetries < settings.maxTestRetries && !abortTesting) {
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
const QUEUED_RESULT = { status: 'queued', time: null, tokens: null, response: '' };

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
  if (usableKeys(p).length === 0) {
    setStatus('error', 'No active API keys');
    return;
  }

  isTesting = true;
  abortTesting = false;
  inflightIds.clear();
  keyCooldownUntil.clear();
  if (reset) deniedPairs.clear();

  if (reset) {
    testResults = [];
    runTotal = list.length;
    initResultsTable();
    // Pre-create rows in selection order; each is filled in turn, top to bottom.
    list.forEach((model) => addResultRow(model, QUEUED_RESULT));
  } else {
    list.forEach((model) => updateResultRow(model, QUEUED_RESULT));
  }

  updateStats();
  updateTestAllButton();
  runStatusText = `Testing ${list.length} model${list.length === 1 ? '' : 's'}...`;
  setStatus('running', runStatusText);
  showProgress(0, list.length);

  // Models are pulled off a shared queue by a fixed number of lanes. Rows were
  // created up front so the table keeps its order regardless of which lane
  // finishes first; only the fill order varies.
  //
  // This is safe to do now in a way it wasn't before: budget, cooldown and
  // entitlement are all tracked per key, so lanes compete for real slots rather
  // than racing each other into the provider's per-minute cap.
  const lanes = Math.max(1, Math.min(settings.concurrency, list.length));
  let next = 0;
  let done = 0;

  async function lane() {
    while (!abortTesting) {
      const i = next++;
      if (i >= list.length) return;
      const model = list[i];
      updateResultRow(model, RUNNING_RESULT);
      const result = await testModel(model, p);
      if (abortTesting) return;
      recordResult(model, result, p.name);
      updateResultRow(model, result);
      done += 1;
      updateStats();
      showProgress(done, list.length);
    }
  }

  await Promise.all(Array.from({ length: lanes }, lane));

  // Anything the run never reached would otherwise sit on "Queued" forever. With
  // lanes the untested models aren't a contiguous tail, so the whole list is
  // checked rather than sliced.
  if (abortTesting) {
    list.forEach((model) => {
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
  if (!scheduled) return;
  if (settings.notifyRunComplete) {
    const passed = testResults.filter((r) => r.status === 'pass').length;
    window.electronAPI.notifyRegression({
      title: 'Scheduled run finished',
      body: `${passed}/${testResults.length} passed`,
    });
  }
  if (!settings.notifyRegression || changes.broke.length === 0) return;
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
  status: (e) => ({ fail: 0, skipped: 1, queued: 2, running: 3, pass: e.result.isEmpty ? 4 : 5 })[e.result.status] ?? 6,
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
    ({ model }) => (model.caps && model.caps.size > 0) || !model.noPlans
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
  if (result.status === 'queued') return 'row-pending';
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
  if (status === 'queued') {
    return `<span class="status-icon queued" title="Waiting its turn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span>`;
  }
  if (status === 'skipped') {
    return `<span class="status-icon skipped" title="Not tested"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 12h12"/></svg></span>`;
  }
  return `<span class="status-icon running" title="Testing"><span class="spinner"></span></span>`;
}

function buildRowHtml(model, result) {
  const isRunning = result.status === 'running' || result.status === 'queued';
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
    else if (result.time < settings.timeGoodMs) timeClass = 'time-fast';
    else if (result.time <= settings.timeOkMs) timeClass = 'time-medium';
    else timeClass = 'time-slow';
  }

  const capsHtml = capabilityIcons(model);
  const tierHtml = model.noPlans
    ? ''
    : model.isFree
      ? iconSpan('free', 'Free', 'tier-free')
      : iconSpan('free', 'Free for Paid', 'tier-freepaid');
  const typeIcons = capsHtml || tierHtml ? [capsHtml, tierHtml] : [];
  const typeHtml = typeIcons.length ? capsHtml + tierHtml : NA;
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
  // Which key served this test. Only shown when the provider has more than one,
  // and it names the key the request actually went out on rather than the ones
  // that could have — with tiered keys, that is the difference between reading
  // the result and guessing at it.
  const provider = PROVIDERS[activeProvider];
  let keyLine = '';
  if (provider && usableKeys(provider).length > 1) {
    const used = result.keyId ? keyNameById(result.keyId) : '';
    const eligible = Array.isArray(model.keyIds)
      ? provider.keys.filter((k) => model.keyIds.includes(k.id)).map((k) => k.name)
      : [];
    const name = used || (eligible.length === 1 ? eligible[0] : '');
    if (name) {
      const why = used ? 'Tested with this key' : 'Only this key serves the model';
      keyLine = `<span class="cell-model-key" title="${escapeHtml(why)}">${escapeHtml(name)}</span>`;
    }
  }

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
    ? `<span class="response-placeholder">${
        result.status === 'queued' ? 'Queued' : result.waiting ? 'Waiting out rate limit…' : 'Testing…'
      }</span>`
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
    <td class="cell-model">${escapeHtml(model.id)}${keyLine}</td>
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
  const h = modelHistory(modelId).slice(-settings.sparkRuns);
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
  downloadFile(header + rows, exportFilename('csv'), 'text/csv');
});

$('#btn-export-json').addEventListener('click', () => {
  if (testResults.length === 0) return;
  downloadFile(JSON.stringify(testResults, null, 2), exportFilename('json'), 'application/json');
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

// Fixed names meant every export after the first landed as "(1)", "(2)" with no
// way to tell which provider or run it came from.
function exportFilename(ext) {
  const p = PROVIDERS[activeProvider];
  const slug = (p ? p.name : 'results').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `upstream-${slug}-${stamp}.${ext}`;
}

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
    $('#provider-rpm-input').value = p.rpm ?? '';
  } else {
    title.textContent = 'Add Provider';
    submitBtn.textContent = 'Add Provider';
    $('#provider-name-input').value = '';
    $('#provider-url-input').value = '';
    $('#provider-rpm-input').value = '';
  }
  $('#add-provider-modal').style.display = 'flex';
  setTimeout(() => $('#provider-name-input').focus(), 100);
}

async function updateProvider(id, { name, baseUrl, rpm }) {
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
  p.rpm = Number.isFinite(rpm) && rpm > 0 ? rpm : null;
  await saveProviderConfig(id);
  renderProviderTabs();
  setStatus('done', `Provider "${name}" updated`);
  return true;
}

function closeAddProviderModal() {
  $('#add-provider-modal').style.display = 'none';
  $('#provider-name-input').value = '';
  $('#provider-url-input').value = '';
  $('#provider-rpm-input').value = '';
  editingProviderId = null;
}

$('#btn-add-provider').addEventListener('click', () => openProviderModal(null));
$('#provider-modal-close').addEventListener('click', closeAddProviderModal);
$('#provider-modal-cancel').addEventListener('click', closeAddProviderModal);
$('#provider-modal-add').addEventListener('click', async () => {
  const rpmRaw = $('#provider-rpm-input').value.trim();
  const payload = {
    name: $('#provider-name-input').value,
    baseUrl: $('#provider-url-input').value,
    rpm: rpmRaw === '' ? null : Number(rpmRaw),
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
  // Generating images and video unattended on a timer is rarely what someone
  // meant when they ticked a generator once.
  const selected = getSelectedModels().filter((m) => !(settings.scheduleSkipMedia && isMedia(m)));
  if (selected.length === 0 || usableKeys(PROVIDERS[activeProvider]).length === 0) return;
  runTests(selected, { scheduled: true });
}

$('#auto-test-select').addEventListener('change', (e) => {
  autoTestMinutes = Number(e.target.value) || 0;
  applyAutoTestSchedule();
  saveTestDefinition();
});


// ============================================
// Settings panel
// ============================================
// Each control binds a settings key to an input, converting where the stored
// unit and the displayed one differ (milliseconds stored, seconds shown).
const SETTING_INPUTS = [
  ['#set-max-tokens', 'maxOutputTokens', 'int'],
  ['#media-prompt-input', 'mediaPrompt', 'text'],
  ['#set-time-good', 'timeGoodMs', 'sec'],
  ['#set-time-ok', 'timeOkMs', 'sec'],
  ['#set-deadline-chat', 'deadlineChatMs', 'sec'],
  ['#set-deadline-image', 'deadlineImageMs', 'sec'],
  ['#set-deadline-video', 'deadlineVideoMs', 'sec'],
  ['#set-hedge-enabled', 'hedgeEnabled', 'bool'],
  ['#set-hedge-max', 'hedgeMax', 'int'],
  ['#set-hedge-step', 'hedgeStepMs', 'int'],
  ['#set-retries', 'maxTestRetries', 'int'],
  ['#set-rl-waits', 'maxRateLimitWaits', 'int'],
  ['#set-history-max', 'historyMaxRuns', 'int'],
  ['#set-spark-runs', 'sparkRuns', 'int'],
  ['#set-skip-media', 'scheduleSkipMedia', 'bool'],
  ['#set-notify-regression', 'notifyRegression', 'bool'],
  ['#set-notify-complete', 'notifyRunComplete', 'bool'],
  ['#set-density', 'density', 'text'],
  ['#set-log-level', 'logLevel', 'text'],
  ['#set-concurrency', 'concurrency', 'int'],
];

function fillSettingsForm() {
  SETTING_INPUTS.forEach(([sel, key, kind]) => {
    const el = $(sel);
    if (!el) return;
    if (kind === 'bool') el.checked = !!settings[key];
    else if (kind === 'sec') el.value = Math.round(settings[key] / 1000);
    else el.value = settings[key];
  });
  $('#prompt-input').value = testPrompt;
  $('#expected-input').value = expectedAnswer;
  $('#auto-test-select').value = String(autoTestMinutes);
  renderCostEstimate();
}

function bindSettingsForm() {
  SETTING_INPUTS.forEach(([sel, key, kind]) => {
    const el = $(sel);
    if (!el) return;
    el.addEventListener(kind === 'bool' ? 'change' : 'input', () => {
      if (kind === 'bool') settings[key] = el.checked;
      else if (kind === 'text') settings[key] = el.value;
      else {
        const n = Number(el.value);
        if (!Number.isFinite(n) || n <= 0) return; // ignore a half-typed number
        settings[key] = kind === 'sec' ? Math.round(n * 1000) : Math.round(n);
      }
      queueSettingsSave();
      renderCostEstimate();
      // Colour bands and sparkline length change what is already on screen.
      if (tableRows.length > 0) renderResultsTable();
    });
  });
}

// Hedging, retries and the schedule all multiply together, and the product is
// invisible while you are turning one knob. Saying it out loud is the difference
// between settings you can change and settings you can reason about.
function renderCostEstimate() {
  const el = $('#settings-estimate');
  if (!el) return;
  const models = getSelectedModels().length;
  if (models === 0) {
    el.textContent = 'Select some models to see what a run costs.';
    return;
  }
  const perModelMax = (settings.hedgeEnabled ? Math.max(1, settings.hedgeMax) : 1) * (1 + settings.maxTestRetries);
  const low = models;
  const high = models * perModelMax;
  let text = `${models} models · ${low} to ${high} requests per run`;
  if (settings.concurrency > 1) text += ` · ${settings.concurrency} at a time`;
  if (autoTestMinutes > 0) {
    const perDay = Math.round((24 * 60) / autoTestMinutes);
    text += ` · ${(low * perDay).toLocaleString()} to ${(high * perDay).toLocaleString()} per day on this schedule`;
  }
  el.textContent = text;
}

function renderAppearancePickers() {
  $('#theme-grid').innerHTML = THEMES.map((t) =>
    `<button class="theme-card ${t.id === settings.theme ? 'active' : ''}" data-theme-id="${t.id}">
       <span class="theme-card-name">${t.name}</span>
       <span class="theme-card-strip">${t.strip.map((c) => `<span style="background:${c}"></span>`).join('')}</span>
     </button>`).join('');

  $('#accent-row').innerHTML = ACCENTS.map((a) =>
    `<button class="swatch-btn ${a.id === settings.accent ? 'active' : ''}" data-accent-id="${a.id}"
             style="background:${a.hex}" title="${a.id}"></button>`).join('');
}

$('#theme-grid').addEventListener('click', (e) => {
  const card = e.target.closest('.theme-card');
  if (!card) return;
  settings.theme = card.dataset.themeId;
  applyAppearance();
  queueSettingsSave();
  renderAppearancePickers();
});

$('#accent-row').addEventListener('click', (e) => {
  const btn = e.target.closest('.swatch-btn');
  if (!btn) return;
  settings.accent = btn.dataset.accentId;
  applyAppearance();
  queueSettingsSave();
  renderAppearancePickers();
});

async function refreshLogInfo() {
  try {
    const info = await window.electronAPI.readLogInfo();
    const kb = info.size > 0 ? ` — ${(info.size / 1024).toFixed(0)} KB` : ' — empty';
    $('#log-path').textContent = info.path + kb;
  } catch (_) {}
}

function renderAbout() {
  $('#about-version').textContent = ($('#app-version').textContent || '').replace(/^v/, '') || '—';

  $('#about-providers').innerHTML = Object.values(PROVIDERS)
    .map((p) => {
      const n = (p.models || []).length;
      return `<div class="about-provider">
        <span class="about-provider-name">${escapeHtml(p.name)}</span>
        <span class="about-provider-meta">${n ? `${n} models` : 'not fetched'}${p.custom ? ' · custom' : ''}</span>
      </div>`;
    })
    .join('');

  const runs = [...history.values()].reduce((a, h) => a + h.length, 0);
  const tracked = history.size;
  $('#about-stats').innerHTML =
    `<div class="about-provider"><span class="about-provider-name">Models tracked</span><span class="about-provider-meta">${tracked}</span></div>` +
    `<div class="about-provider"><span class="about-provider-name">Results recorded</span><span class="about-provider-meta">${runs}</span></div>`;
}

$('#btn-open-log').addEventListener('click', () => window.electronAPI.openRequestLog());
$('#btn-clear-log').addEventListener('click', async () => {
  await window.electronAPI.clearRequestLog();
  refreshLogInfo();
});
$('#btn-check-updates').addEventListener('click', () => {
  window.electronAPI.updateAPI.checkForUpdates();
  $('#about-update-note').textContent = 'Checking…';
  setTimeout(() => { $('#about-update-note').textContent = ''; }, 6000);
});

function openSettings() {
  fillSettingsForm();
  renderAppearancePickers();
  refreshLogInfo();
  renderAbout();
  $('#settings-overlay').style.display = 'flex';
}

function closeSettings() {
  $('#settings-overlay').style.display = 'none';
}

$('#btn-settings').addEventListener('click', openSettings);
$('#settings-close').addEventListener('click', closeSettings);
$('#settings-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'settings-overlay') closeSettings();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#settings-overlay').style.display === 'flex') closeSettings();
});

$('#settings-nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.settings-nav-item');
  if (!btn) return;
  $$('.settings-nav-item').forEach((b) => b.classList.toggle('active', b === btn));
  $$('.settings-section').forEach((sec) => { sec.hidden = sec.id !== btn.dataset.section; });
});

$('#btn-export-history').addEventListener('click', async () => {
  const data = await window.electronAPI.readHistory();
  downloadFile(JSON.stringify(data, null, 2), exportFilename('history.json'), 'application/json');
});

$('#btn-clear-history').addEventListener('click', async () => {
  await window.electronAPI.clearHistory();
  await loadHistory();
  if (tableRows.length > 0) renderResultsTable();
  setStatus('done', 'History cleared');
});

$('#btn-open-data').addEventListener('click', () => window.electronAPI.openDataFolder());

$('#btn-reset-settings').addEventListener('click', () => {
  settings = { ...DEFAULT_SETTINGS };
  applyAppearance();
  applySidebarWidth(settings.sidebarWidth);
  queueSettingsSave();
  fillSettingsForm();
  renderAppearancePickers();
  if (tableRows.length > 0) renderResultsTable();
  setStatus('done', 'Settings reset to defaults');
});


// ============================================
// Sidebar sizing
// ============================================
const SIDEBAR_FULL = 320;  // the width everything in the sidebar is laid out for
const SIDEBAR_MIN = 190;   // below this the model rows stop being readable
const SIDEBAR_SHUT = 120;  // dragged past this, it closes rather than cramping

function applySidebarWidth(px) {
  const hidden = px <= 0;
  document.documentElement.style.setProperty('--sidebar-width', `${hidden ? 0 : px}px`);
  document.body.classList.toggle('sidebar-hidden', hidden);
  $('#sidebar-restore').style.display = hidden ? '' : 'none';
}

// Snapping happens here rather than in the drag handler so the same rules apply
// to a restored width read back from settings.
function clampSidebar(px) {
  if (px < SIDEBAR_SHUT) return 0;
  return Math.min(SIDEBAR_FULL, Math.max(SIDEBAR_MIN, px));
}

let sidebarDragging = false;

$('#sidebar-resizer').addEventListener('mousedown', (e) => {
  sidebarDragging = true;
  document.body.classList.add('resizing');
  e.preventDefault(); // otherwise the drag selects text across the window
});

window.addEventListener('mousemove', (e) => {
  if (!sidebarDragging) return;
  settings.sidebarWidth = clampSidebar(e.clientX);
  applySidebarWidth(settings.sidebarWidth);
});

window.addEventListener('mouseup', () => {
  if (!sidebarDragging) return;
  sidebarDragging = false;
  document.body.classList.remove('resizing');
  queueSettingsSave();
});

function toggleSidebar() {
  settings.sidebarWidth = settings.sidebarWidth > 0 ? 0 : SIDEBAR_FULL;
  applySidebarWidth(settings.sidebarWidth);
  queueSettingsSave();
}

$('#sidebar-resizer').addEventListener('dblclick', toggleSidebar);
$('#sidebar-restore').addEventListener('click', toggleSidebar);


// ============================================
// Capability probing
// ============================================
// Most providers describe their models poorly or not at all — NaraRouter reports
// vision and reasoning and nothing about tool calling; Dark API and Mirai report
// nothing whatsoever. Reading a capability off a model's name would be guessing,
// and a bundled lookup table would be guessing with extra steps: a reseller's
// "claude-opus-5" is whatever they routed it to.
//
// So capabilities are established the way everything else here is: by asking the
// model to do the thing and seeing whether it does. A probe passes only on
// evidence in the response — a returned tool call, parseable JSON, the colour of
// an image it was shown. A gateway that quietly accepts and ignores an unknown
// field does not pass.
//
// Probes cost real requests, so they are a deliberate action rather than part of
// a run, and results are stored per provider and model.

// 16x16 solid #dc2626. Small enough to be free, large enough that a vision model
// will not reject it outright.
const PROBE_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVQoz2O4o6ZGEmIY1TCqYfhqAAATqigQUzU6ngAAAABJRU5ErkJggg==';

const CAP_PROBES = [
  {
    id: 'tools',
    // Asked for something it cannot answer without the tool, so a model that
    // merely tolerates the field still fails: the proof is a returned call.
    payload: (id) => ({
      model: id,
      messages: [{ role: 'user', content: 'What is the weather in Paris right now? Use the tool.' }],
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the current weather for a city',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      }],
      tool_choice: 'auto',
      max_tokens: 128,
    }),
    verify: (data) => {
      const calls = data.choices?.[0]?.message?.tool_calls;
      return Array.isArray(calls) && calls.length > 0;
    },
  },
  {
    id: 'structured',
    payload: (id) => ({
      model: id,
      messages: [{ role: 'user', content: 'Return the number four.' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'answer',
          strict: true,
          schema: {
            type: 'object',
            properties: { value: { type: 'integer' } },
            required: ['value'],
            additionalProperties: false,
          },
        },
      },
      max_tokens: 64,
    }),
    // Some providers only implement the older json_object mode.
    fallback: (id) => ({
      model: id,
      messages: [{ role: 'user', content: 'Reply with JSON: {"value": 4}' }],
      response_format: { type: 'json_object' },
      max_tokens: 64,
    }),
    verify: (data) => {
      const text = data.choices?.[0]?.message?.content;
      if (!text) return false;
      try {
        return typeof JSON.parse(text) === 'object';
      } catch (_) {
        return false;
      }
    },
  },
  {
    id: 'vision',
    payload: (id) => ({
      model: id,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What colour is this image? Answer in one word.' },
          { type: 'image_url', image_url: { url: PROBE_IMAGE } },
        ],
      }],
      max_tokens: 32,
    }),
    // It has to name the colour. A model that accepts the image part and then
    // talks about something else has not demonstrated it saw anything.
    verify: (data) => /\bred\b|\bcrimson\b/i.test(data.choices?.[0]?.message?.content || ''),
  },
];

// providerId::modelId -> { caps: [...], at }
let probedCaps = new Map();

async function loadProbedCaps() {
  probedCaps = new Map();
  try {
    const data = await window.electronAPI.readConfig();
    Object.entries(data.probedCaps || {}).forEach(([k, v]) => probedCaps.set(k, v));
  } catch (_) {}
}

async function saveProbedCaps() {
  try {
    const data = await window.electronAPI.readConfig();
    data.probedCaps = Object.fromEntries(probedCaps);
    await window.electronAPI.writeConfig(data);
  } catch (err) {
    console.warn('Failed to persist probed capabilities:', err);
  }
}

async function runProbe(model, provider, probe, body) {
  const key = pickKey(provider, model);
  if (!key) return false;
  await waitForSlot(provider, key);
  if (abortTesting) return false;
  try {
    const res = await window.electronAPI.apiRequest({
      url: `${provider.baseUrl}/chat/completions`,
      method: 'POST',
      headers: { Authorization: `Bearer ${key.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      requestId: nextRequestId(),
      timeoutMs: settings.deadlineChatMs,
      logLevel: settings.logLevel,
    });
    if (res.status !== 200) return false;
    return probe.verify(JSON.parse(res.body));
  } catch (_) {
    return false;
  }
}

async function probeModel(model, provider) {
  const found = [];
  for (const probe of CAP_PROBES) {
    if (abortTesting) break;
    let ok = await runProbe(model, provider, probe, probe.payload(model.id));
    if (!ok && probe.fallback) ok = await runProbe(model, provider, probe, probe.fallback(model.id));
    if (ok) found.push(probe.id);
  }
  probedCaps.set(historyKey(provider.id, model.id), { caps: found, at: Date.now() });
  applyProbedCaps(model, provider.id);
  return found;
}

// A probe result is merged with what the provider declared rather than replacing
// it: a provider can know about audio or file support that no chat probe reaches.
function applyProbedCaps(model, providerId) {
  const entry = probedCaps.get(historyKey(providerId, model.id));
  model.probed = !!entry;
  model.probedCaps = new Set(entry ? entry.caps : []);
  model.caps = new Set([...(model.declaredCaps || []), ...model.probedCaps]);
}

$('#btn-probe-caps').addEventListener('click', async () => {
  if (isTesting) return;
  const p = PROVIDERS[activeProvider];
  const list = getSelectedModels().filter((m) => !isMedia(m));
  if (list.length === 0 || usableKeys(p).length === 0) {
    setStatus('error', 'Select some chat models first');
    return;
  }

  isTesting = true;
  abortTesting = false;
  updateTestAllButton();
  showProgress(0, list.length);

  let probedCount = 0;
  for (const model of list) {
    if (abortTesting) break;
    setStatus('running', `Probing ${model.id} (${probedCount + 1}/${list.length})`);
    await probeModel(model, p);
    probedCount += 1;
    renderLegend();
    if (tableRows.length > 0) renderResultsTable();
    showProgress(probedCount, list.length);
  }

  await saveProbedCaps();
  hideProgress();
  const stopped = abortTesting;
  isTesting = false;
  updateTestAllButton();
  renderModelsList();
  setStatus('done', stopped ? `Probing stopped after ${probedCount}` : `Probed ${probedCount} models`);
});

// ============================================
// Capability legend
// ============================================
// Counts come from the models actually loaded, so the legend doubles as an
// answer to "how much does this provider even tell me" — a provider that reports
// nothing shows zeros across the board, which is the honest picture.
function renderLegend() {
  const el = $('#legend');
  if (!el) return;
  if (models.length === 0) {
    el.style.display = 'none';
    return;
  }

  const counts = new Map(CAPABILITIES.map((c) => [c.id, 0]));
  models.forEach((m) => {
    const caps = m.caps instanceof Set ? m.caps : new Set(m.caps || []);
    caps.forEach((c) => counts.set(c, (counts.get(c) || 0) + 1));
  });

  const declared = [...counts.values()].reduce((a, b) => a + b, 0);
  $('#legend-note').textContent = declared === 0
    ? `${PROVIDERS[activeProvider]?.name || 'This provider'} reports no capability data`
    : `${models.length} models`;

  $('#legend-grid').innerHTML = CAPABILITIES.map((c) => `
    <div class="legend-item ${counts.get(c.id) ? '' : 'legend-item-empty'}">
      <span class="cap-icon cap-${c.id}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${CAP_ICONS[c.id]}</svg>
      </span>
      <span class="legend-text">
        <span class="legend-name">${c.label}</span>
        <span class="legend-desc">${c.desc}</span>
      </span>
      <span class="legend-count">${counts.get(c.id)}</span>
    </div>`).join('');

  el.style.display = '';
}

function toggleLegend() {
  settings.legendOpen = !settings.legendOpen;
  $('#legend').classList.toggle('collapsed', !settings.legendOpen);
  queueSettingsSave();
}

$('#legend-toggle').addEventListener('click', toggleLegend);
$('#legend-chevron-btn').addEventListener('click', toggleLegend);

async function init() {
  await loadSettings();
  await loadProbedCaps();
  applyAppearance();
  applySidebarWidth(clampSidebar(settings.sidebarWidth));
  $('#legend').classList.toggle('collapsed', !settings.legendOpen);
  bindSettingsForm();
  window.electronAPI.getDataPath().then((dir) => { $('#settings-path').textContent = dir; });
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
