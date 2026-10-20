// ============================================
// VENOM ROUTER — Application Logic v2
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

// Shared pure response helpers; catalog.js also consumes the chat parser.
const {
  usageTokens, parseRetryAfter, failFromResponse, transportFailure, authHeaders, isMissingRoute,
  findAssetUrl, extractMediaUrl, parseChatCompletion, parseStreamedCompletion, buildEmptyResult,
  resultRank,
} = window.VENOM_RENDERER.responses;


const truthy = (v) => v === true || v === 'true' || v === 1;

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
// below is name matching, which is a guess — a provider that declares the fact
// outright is believed over it. Discovery stamps the classify() verdict onto
// the roster as `kind` (catalog.js stampKinds), so the stored row and the test
// table cannot disagree with what the fetch already decided.

const KIND_LABELS = { chat: '', image: 'Image', video: 'Video', decision: 'Decision' };

// Hedging is never applied to a generator: it exists to rescue a chat model that
// is unusually slow, and a generator is supposed to be slow, so racing it would
// just buy several images at once.
function kindLimits(kind) {
  if (kind === 'image') return { deadline: settings.deadlineImageMs, hedge: false };
  if (kind === 'video') return { deadline: settings.deadlineVideoMs, hedge: false };
  // A decision call has no idempotency guarantee — a raced duplicate is real
  // provider work — so it is never hedged either.
  if (kind === 'decision') return { deadline: settings.deadlineDecisionMs, hedge: false };
  return { deadline: settings.deadlineChatMs, hedge: settings.hedgeEnabled };
}

function classifyModel(providerId, model) {
  // A declared capability outranks every heuristic below it: NaraRouter states
  // outright which models generate images or video, so there is nothing to infer.
  // A native decision model (Experiential's TypeSafe Jev) refuses chat entirely
  // and answers only on the provider's declared decisionEndpoint.
  // `kind` is the same declaration in row shape (row.js readsKind of the
  // provider's explicit supports_* flags, mirrored into COMPARE_FIELDS so
  // fetch-info diffs it like any other published fact). A stored verdict is
  // believed, never re-derived from the row that already survived it.
  if (model && model.kind === 'decision') return 'decision';
  if (model && model.kind === 'video') return 'video';
  if (model && model.kind === 'image') return 'image';
  if (truthy(model.supports_decisions)) return 'decision';
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
const isDecision = (model) => model && model.kind === 'decision';

// testResults rows carry only the model id; correctness needs the model itself
// to know which standard applies.
function modelById(id) {
  return getProviderModels().find((m) => m.id === id) || null;
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
const { DEFAULT_SETTINGS, THEMES, ACCENTS, LEGACY_ACCENTS } = window.VENOM_RENDERER.defaults;

// Assigned when the results-table unit is composed below; appearance/runner
// call through this binding so create order does not hit the TDZ.
let resultsTable = null;
const appearance = window.VENOM_RENDERER.appearance.create({
  defaults: window.VENOM_RENDERER.defaults, getSettings: () => settings,
  getCurrentPage: () => getCurrentPage(), queueSettingsSave,
  hasResultRows: () => !!(resultsTable && resultsTable.hasRows()),
  renderResultsTable: () => { if (resultsTable) resultsTable.render(); },
  escapeHtml, showPage, switchSettingsSection,
});
const { effectiveTheme, accentLabel, applyAppearance, preloadEmblems, toggleTheme,
  renderAppearancePickers, saveAppearance, setAccent, renderAccentPop, setAccentPopOpen } = appearance;

let settings = { ...DEFAULT_SETTINGS };

// A failed read throws to init(), which shows it and blocks every write.
async function loadSettings() {
  const data = await window.electronAPI.readConfig();
  if (data.settings && typeof data.settings === 'object') {
    Object.keys(DEFAULT_SETTINGS).forEach((k) => {
      const v = data.settings[k];
      if (typeof v === typeof DEFAULT_SETTINGS[k]) settings[k] = v;
    });
    // One prompt used to drive both generators; it seeds both of their own.
    const legacy = data.settings.mediaPrompt;
    if (typeof legacy === 'string' && legacy.trim()) {
      if (typeof data.settings.imagePrompt !== 'string') settings.imagePrompt = legacy;
      if (typeof data.settings.videoPrompt !== 'string') settings.videoPrompt = legacy;
    }
  }
  // Themes that no longer exist (Deep Space, Midnight, Carbon, AMOLED, Nord)
  // were all dark, so they land on Dark.
  if (!THEMES.some((t) => t.id === settings.theme)) settings.theme = 'vercel';
  // A custom colour no longer exists; it, and any other unknown id, lands on
  // the default.
  settings.accent = LEGACY_ACCENTS[settings.accent] || settings.accent;
  if (!ACCENTS.some((a) => a.id === settings.accent)) settings.accent = DEFAULT_SETTINGS.accent;
}

// One row, written on its own: no read-modify-write, so it can't undo a key
// or provider change made meanwhile. openRouterApiKey is dropped by main (the
// key is a secret, saved with saveSecret).
let saveSettingsTimer = null;
function saveSettingsNow() {
  clearTimeout(saveSettingsTimer);
  saveSettingsTimer = null;
  return persist('save settings', () => window.electronAPI.saveSettings({ ...settings }));
}

function queueSettingsSave() {
  clearTimeout(saveSettingsTimer);
  saveSettingsTimer = setTimeout(saveSettingsNow, 350);
}

// Set app version from main process
// Reported by the main process once the window loads; shown in the nav and About.
let appVersion = '';
window.electronAPI.onAppVersion((version) => {
  appVersion = version;
  document.querySelectorAll('[data-app-version]').forEach((el) => { el.textContent = `v${version}`; });
});

// Development only: main names a stylesheet that changed on disk. It is
// replaced by a fresh link that only takes over once it has loaded — the old
// sheet stays up until then, so the page never flashes unstyled — and nothing
// on screen is rebuilt. Keeping the page you are looking at is the whole point
// of swapping the CSS instead of reloading.
// The swaps are chained, never concurrent: two sheets reloading at the same
// moment hang the renderer. The link is looked up inside the chain because an
// earlier swap may already have replaced it. A packaged build never fires this.
let cssSwapChain = Promise.resolve();
window.electronAPI.onDevReloadCss?.((file) => {
  cssSwapChain = cssSwapChain.then(() => new Promise((done) => {
    const old = [...document.querySelectorAll('link[rel="stylesheet"]')]
      .find((l) => (l.getAttribute('href') || '').split('?')[0] === file);
    if (!old) { done(); return; }
    const fresh = old.cloneNode();
    fresh.setAttribute('href', `${file}?t=${Date.now()}`);
    const finish = () => { old.remove(); done(); };
    fresh.addEventListener('load', finish, { once: true });
    fresh.addEventListener('error', finish, { once: true });
    // Later in the document, so the new rules win the cascade while both are up.
    old.after(fresh);
  }));
});

// Built-in providers register their metadata into window.INTEGRATED_PROVIDERS
// (see src/renderer/providers/*.js, loaded before this file).
const BUILTIN_PROVIDERS = {};
Object.values(window.INTEGRATED_PROVIDERS || {}).forEach((entry) => {
  BUILTIN_PROVIDERS[entry.meta.id] = { ...entry.meta };
});


// Provider records and persistence live in a dedicated unit. Keep the stable
// map reference here for the legacy consumers while page behavior is extracted.
const providerStore = window.VENOM_RENDERER.providerStore.create({
  builtinProviders: BUILTIN_PROVIDERS,
  electronAPI: window.electronAPI,
  persist,
  quotaSpentExpired: (value) => quotaSpentExpired(value),
  getCurrentPage: () => getCurrentPage(),
  renderProvidersPage: () => renderProvidersPage(),
  onProvidersChanged: (providerId) => window.dispatchEvent(new CustomEvent('providers-changed', { detail: { providerId } })),
});
const PROVIDERS = providerStore.providers;
const saveProviderConfig = (providerId) => providerStore.save(providerId);
const loadAllProviders = () => providerStore.loadAll();

// State
let activeProvider = null; // resolved to the first available provider in init()
let testResults = [];
let runTotal = null; // models covered by the current/last run; null = no run yet
let lastRun = null; // { done, total, stopped } — lets the summary be re-stated
let isTesting = false;
let abortTesting = false;
let runStartTime = null; // Date.now() when the current run began — for elapsed display

// DOM helpers
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ============================================
// Saving — every write goes through persist()
// ============================================
// Writes are small typed calls into main (venom.db). A failure is shown in the
// status bar, never swallowed. If saved data could not be read at startup,
// every write is refused for the rest of the session: the app is then showing
// defaults, and saving them would overwrite the real data.
let storeReadError = null;
const pendingSaves = new Set();
// Set the moment any persist() call is refused or fails, so init() can tell a
// startup write went wrong even though it awaited each one and moved on —
// without this, the final "Ready" status would overwrite the error persist()
// already put in the status bar.
let writeFailed = false;

// "Error invoking remote method 'save-settings': TypeError: …" → "…"
function ipcMessage(err) {
  return String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, '');
}

function failStartupRead(what, err) {
  console.error(`Could not read ${what} at startup:`, err);
  if (!storeReadError) storeReadError = `${what}: ${ipcMessage(err)}`;
  const banner = $('#store-error');
  if (banner) {
    banner.hidden = false;
    $('#store-error-text').textContent = `Saved data could not be read (${storeReadError}). Nothing will be saved this session — close VENOM Router and open it again.`;
  }
  setStatus('error', 'Saved data could not be read — changes are not being saved');
}

// Runs one write. Resolves with its result, or undefined when it was refused
// or failed (already reported).
async function persist(what, call) {
  if (storeReadError) {
    writeFailed = true;
    setStatus('error', `Couldn't ${what}: saved data could not be read at startup, so nothing is saved this session`);
    return undefined;
  }
  const job = Promise.resolve().then(call);
  pendingSaves.add(job);
  try {
    return await job;
  } catch (err) {
    writeFailed = true;
    console.error(`Couldn't ${what}:`, err);
    setStatus('error', `Couldn't ${what}: ${ipcMessage(err)}`);
    return undefined;
  } finally {
    pendingSaves.delete(job);
  }
}

// Close handshake (main's flush-pending, sent before the window closes and
// before an update installs): debounced writes go out now instead of being
// dropped, writes already in flight are waited for, then main is told.
async function flushPendingSaves() {
  const writes = [];
  if (saveSettingsTimer) writes.push(saveSettingsNow());
  if (saveTestTimer) writes.push(saveTestDefinition());
  if (window.CATALOG) writes.push(window.CATALOG.flush());
  await Promise.allSettled(writes);
  await Promise.allSettled([...pendingSaves]);
}

window.electronAPI.onFlushPending(async (token) => {
  try {
    await flushPendingSaves();
  } finally {
    window.electronAPI.flushDone(token);
  }
});

// ============================================
// Run history — uptime, regressions, scheduling
// ============================================
// Answers the question a router has to ask: not "does this model work right
// now" but "is it reliable". Keyed per provider, because the same model id can
// be solid on one router and flaky on another.
const MIN_RUNS_FOR_UPTIME = 2; // one data point is not a rate

// providerId::modelId -> [{ at, ok }] oldest first
let history = new Map();
// One entry per recorded run, oldest first — feeds the Overview panels.
let runLog = [];

function summariseRun(run) {
  const results = run.results || [];
  return {
    at: run.at,
    provider: run.provider,
    providerName: run.providerName || run.provider,
    total: results.length,
    passed: results.filter((r) => r.status === 'pass').length,
  };
}
let autoTestMinutes = 0; // 0 = off
let autoTestTimer = null;

function historyKey(providerId, modelId) {
  return `${providerId}::${modelId}`;
}

// A failed read throws to init() (startup) or to the Clear button's handler.
async function loadHistory() {
  history = new Map();
  runLog = [];
  const data = await window.electronAPI.readHistory();
  (data.runs || []).forEach(foldRun);
  capHistory();
}

// Every run gets a sequence number, so capping can drop whole runs from both
// indexes at once.
let runSeq = 0;
function foldRun(run) {
  runSeq += 1;
  const seq = runSeq;
  runLog.push({ ...summariseRun(run), seq });
  (run.results || []).forEach((r) => {
    const key = historyKey(run.provider, r.model);
    if (!history.has(key)) history.set(key, []);
    // `ms` is the response time that run measured, kept so the table can show a
    // median over the model's own runs. A failed run has no time and contributes
    // nothing: null is filtered out rather than counted as a zero.
    history.get(key).push({ at: run.at, ok: r.status === 'pass', seq,
      ms: Number.isFinite(r.time) ? r.time : null });
  });
}

// Same cap as main applies on disk (historyMaxRuns, at most 5000), so a long
// session doesn't grow memory without bound and uptime reads the same runs
// the disk keeps.
function historyCap() {
  const n = Number(settings.historyMaxRuns);
  return n > 0 ? Math.min(Math.floor(n), 5000) : 300;
}

function capHistory() {
  const excess = runLog.length - historyCap();
  if (excess <= 0) return;
  const cutoff = runLog[excess - 1].seq;
  runLog = runLog.slice(excess);
  history.forEach((list, key) => {
    const kept = list.filter((e) => e.seq > cutoff);
    if (kept.length) history.set(key, kept);
    else history.delete(key);
  });
}

function modelHistory(modelId) {
  return history.get(historyKey(activeProvider, modelId)) || [];
}

// The response times this model's earlier runs recorded, in ms. Failed runs and
// runs from before `ms` was kept contribute nothing, so the median is over real
// readings only.
function runTimesFor(modelId) {
  return modelHistory(modelId).map((e) => e.ms).filter((v) => Number.isFinite(v));
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

// Returns whether the run was saved (false when persist() refused it or the
// write failed — already reported by persist; the caller shows it too, since
// renderRunSummary's status would otherwise overwrite that report).
async function recordRun(providerId, providerName, results, runUid) {
  if (results.length === 0) return true;
  const run = {
    runUid,
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
  const saved = await persist('record the run', () => window.electronAPI.appendRun(run, settings.historyMaxRuns));
  // Fold into the in-memory index so the table reflects it immediately.
  foldRun(run);
  capHistory();
  renderQuickStats();
  // The Models page pins TIME values as its Speed: tell it the history grew, so
  // its rows re-read without waiting for a revisit.
  window.dispatchEvent(new CustomEvent('history-updated', { detail: { provider: providerId } }));
  return !!saved;
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
// The inputs are filled either way; a failed read then throws to init().
async function loadTestDefinition() {
  try {
    const data = await window.electronAPI.readConfig();
    const t = data.test || {};
    if (typeof t.prompt === 'string') testPrompt = t.prompt;
    // An empty string is a real choice (checking off), so only a missing key
    // falls back to the default.
    if (typeof t.expected === 'string') expectedAnswer = t.expected;
    if (Number.isFinite(t.autoMinutes)) autoTestMinutes = t.autoMinutes;
  } finally {
    $('#prompt-input').value = testPrompt;
    $('#expected-input').value = expectedAnswer;
    $('#auto-test-select').value = String(autoTestMinutes);
    applyAutoTestSchedule();
    updatePromptStats();
    updateExpectedChips();
    syncPromptPresetPills();
    syncTokenPresets();
    syncMatchMode();
  }
}

const PROMPT_PRESETS = {
  arithmetic: {
    prompt: 'What is 2+2? Answer in one word.',
    expected: '4, four',
  },
  capital: {
    prompt: 'What is the capital of France? Answer in one word.',
    expected: 'Paris',
  },
  logic: {
    prompt: 'Which is heavier: 1 kg of steel or 1 kg of feathers? Answer in one word or "same".',
    expected: 'same, equal, neither',
  },
  hello: {
    prompt: 'Say "hello" and nothing else.',
    expected: 'hello',
  },
};

function updatePromptStats() {
  const el = $('#prompt-stats');
  if (!el) return;
  const val = $('#prompt-input')?.value || '';
  const len = val.length;
  const estTokens = len === 0 ? 0 : Math.max(1, Math.round(len / 4));
  el.textContent = `${len} char${len === 1 ? '' : 's'} • ~${estTokens} token${estTokens === 1 ? '' : 's'}`;
}

function syncMatchMode() {
  const mode = (typeof settings !== 'undefined' && settings.matchMode) || 'boundary';
  $$('#match-mode-seg button').forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
}

function renderProbePreview() {
  const badgeEl = $('#live-probe-badge');
  const sampleBubble = $('#probe-sample-bubble');
  const matchRuleVal = $('#probe-match-rule-val');
  if (!badgeEl || !sampleBubble) return;

  const mode = (typeof settings !== 'undefined' && settings.matchMode) || 'boundary';
  const val = $('#expected-input')?.value || '';
  const alts = val.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

  if (matchRuleVal) {
    matchRuleVal.textContent = mode === 'exact' ? 'Exact Normalized' : mode === 'contains' ? 'Contains Substring' : mode === 'regex' ? 'Regex Pattern' : 'Word Boundary';
  }

  const sampleResponse = 'The answer is 4.';
  const sampleLow = sampleResponse.toLowerCase();

  let matched = false;
  let matchedWord = '';

  if (mode === 'exact') {
    const norm = sampleLow.replace(/[.!?,;:]+$/, '').trim();
    matched = alts.some((a) => norm === a);
    matchedWord = alts.find((a) => norm === a) || '';
  } else if (mode === 'contains') {
    matched = alts.some((a) => sampleLow.includes(a));
    matchedWord = alts.find((a) => sampleLow.includes(a)) || '';
  } else if (mode === 'regex') {
    try {
      matched = new RegExp(val.trim(), 'i').test(sampleResponse);
    } catch { matched = false; }
  } else {
    matched = alts.some((alt) => {
      if (/^[a-z0-9]+$/i.test(alt)) {
        return new RegExp(`(^|[^a-z0-9])${escapeRegex(alt)}([^a-z0-9]|$)`, 'i').test(sampleLow);
      }
      return sampleLow.includes(alt);
    });
    matchedWord = alts.find((alt) => sampleLow.includes(alt)) || '';
  }

  if (matched || alts.length === 0) {
    badgeEl.className = 'live-probe-badge pass';
    badgeEl.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg><span>Evaluation Passed</span>';
    if (matchedWord) {
      sampleBubble.innerHTML = `<span class="probe-text">The answer is </span><mark class="probe-matched-token">${escapeHtml(matchedWord)}</mark><span class="probe-text">.</span>`;
    } else {
      sampleBubble.innerHTML = `<span class="probe-text">${escapeHtml(sampleResponse)}</span>`;
    }
  } else {
    badgeEl.className = 'live-probe-badge fail';
    badgeEl.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg><span>Sample Mismatch</span>';
    sampleBubble.innerHTML = `<span class="probe-text mismatch">${escapeHtml(sampleResponse)}</span>`;
  }
}

function updateExpectedChips() {
  const list = $('#expected-chips-list');
  if (!list) return;
  const val = $('#expected-input')?.value || '';
  const alts = val
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const hintEl = $('#expected-chips-hint');
  const mode = (typeof settings !== 'undefined' && settings.matchMode) || 'boundary';

  if (alts.length === 0) {
    list.innerHTML = '<span class="chip-empty" style="color:var(--text-3);font-size:11px;font-style:italic;">Off (all answers pass)</span>';
    if (hintEl) hintEl.innerHTML = '<span style="color:var(--text-3)">No validation rules applied</span>';
    renderProbePreview();
    return;
  }
  list.innerHTML = alts
    .map((alt) => `<span class="chip-item">${escapeHtml(alt)}</span>`)
    .join('');

  if (hintEl) {
    if (mode === 'exact') {
      hintEl.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Strict normalized match (trimmed)';
    } else if (mode === 'contains') {
      hintEl.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Substring search (must contain any alternative)';
    } else if (mode === 'regex') {
      hintEl.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Regular expression pattern';
    } else {
      hintEl.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Word boundary &amp; case-insensitive (punctuations allowed)';
    }
  }
  renderProbePreview();
}

function syncPromptPresetPills() {
  const currentPrompt = ($('#prompt-input')?.value || '').trim();
  const currentExpected = ($('#expected-input')?.value || '').trim();
  $$('#prompt-presets .preset-pill').forEach((pill) => {
    const key = pill.dataset.preset;
    const p = PROMPT_PRESETS[key];
    const match = p && p.prompt.trim() === currentPrompt && p.expected.trim() === currentExpected;
    pill.classList.toggle('active', !!match);
  });
}

function syncTokenPresets(val) {
  const v = val !== undefined ? Number(val) : Number($('#set-max-tokens')?.value || (typeof settings !== 'undefined' && settings.maxOutputTokens) || 512);
  $$('#token-presets .token-preset-pill').forEach((pill) => {
    pill.classList.toggle('active', Number(pill.dataset.tokens) === v);
  });
}

const TEST_ROUTE_INFO = {
  chat: {
    method: 'POST',
    path: '/chat/completions',
    desc: 'Passes on expected answer',
    scope: 'Target: Configured providers with keys • Chat models only',
  },
  image: {
    method: 'POST',
    path: '/images/generations',
    desc: 'Falls back to chat if route is missing; passes on valid image',
    scope: 'Target: Configured providers • Image-capable models only',
  },
  video: {
    method: 'POST',
    path: '/videos',
    desc: 'Polls job until completion; falls back to chat if missing',
    scope: 'Target: Configured providers • Video-capable models only',
  },
  decision: {
    method: 'POST',
    path: '/decision',
    desc: 'Passes when model probability score ≥ threshold',
    scope: 'Target: Configured providers • Logprob / Decision models only',
  },
};

function syncTestRouteCard(kind) {
  const info = TEST_ROUTE_INFO[kind] || TEST_ROUTE_INFO.chat;
  const methodEl = $('#test-route-method');
  const pathEl = $('#test-route-path');
  const descEl = $('#test-route-desc');
  if (methodEl) methodEl.textContent = info.method;
  if (pathEl) pathEl.textContent = info.path;
  if (descEl) descEl.textContent = info.desc;
  const scopeEl = $('#test-route-scope');
  if (scopeEl && info.scope) {
    scopeEl.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg><span>${escapeHtml(info.scope)}</span>`;
  }
}

function saveTestDefinition() {
  clearTimeout(saveTestTimer);
  saveTestTimer = null;
  return persist('save the test prompt', () => window.electronAPI.saveTestDefinition({
    prompt: testPrompt, expected: expectedAnswer, autoMinutes: autoTestMinutes,
  }));
}

// Typing fires per keystroke; coalesce the writes.
let saveTestTimer = null;
function queueTestDefinitionSave() {
  clearTimeout(saveTestTimer);
  saveTestTimer = setTimeout(saveTestDefinition, 400);
}

$('#prompt-input').addEventListener('input', (e) => {
  testPrompt = e.target.value;
  queueTestDefinitionSave();
  updatePromptStats();
  syncPromptPresetPills();
});

$('#expected-input').addEventListener('input', (e) => {
  expectedAnswer = e.target.value;
  queueTestDefinitionSave();
  updateExpectedChips();
  syncPromptPresetPills();
  // Existing rows are re-judged against the new answer without re-running them.
  if (resultsTable && resultsTable.hasRows()) resultsTable.render();
  updateStats();
  renderRunSummary();
});

$('#btn-copy-prompt')?.addEventListener('click', async () => {
  const text = $('#prompt-input')?.value || '';
  try {
    await navigator.clipboard.writeText(text);
    const btn = $('#btn-copy-prompt');
    const span = btn?.querySelector('span');
    if (span) {
      const orig = span.textContent;
      span.textContent = 'Copied!';
      btn.style.color = 'var(--pass)';
      setTimeout(() => {
        span.textContent = orig;
        btn.style.color = '';
      }, 1500);
    }
  } catch (_) {}
});

$('#prompt-presets')?.addEventListener('click', (e) => {
  const pill = e.target.closest('.preset-pill');
  if (!pill) return;
  const p = PROMPT_PRESETS[pill.dataset.preset];
  if (!p) return;
  testPrompt = p.prompt;
  expectedAnswer = p.expected;
  $('#prompt-input').value = testPrompt;
  $('#expected-input').value = expectedAnswer;
  clearTimeout(saveTestTimer);
  saveTestDefinition();
  updatePromptStats();
  updateExpectedChips();
  syncPromptPresetPills();
  if (resultsTable && resultsTable.hasRows()) resultsTable.render();
  updateStats();
  renderRunSummary();
});

$('#token-presets')?.addEventListener('click', (e) => {
  const pill = e.target.closest('.token-preset-pill');
  if (!pill) return;
  const tokens = Number(pill.dataset.tokens);
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  $('#set-max-tokens').value = String(tokens);
  settings.maxOutputTokens = tokens;
  queueSettingsSave();
  syncTokenPresets(tokens);
});

$('#btn-reset-prompt').addEventListener('click', () => {
  testPrompt = DEFAULT_TEST_PROMPT;
  expectedAnswer = DEFAULT_EXPECTED;
  $('#prompt-input').value = testPrompt;
  $('#expected-input').value = expectedAnswer;
  clearTimeout(saveTestTimer);
  saveTestDefinition();
  updatePromptStats();
  updateExpectedChips();
  syncPromptPresetPills();
  if (resultsTable && resultsTable.hasRows()) resultsTable.render();
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
    // A checked asset is the verdict; an unchecked one (verification off, or the
    // host refused to say) falls back to "did it hand back a link at all".
    if (typeof result.assetVerified === 'boolean') return result.assetVerified;
    return result.assetInline || containsMediaUrl(result.response);
  }

  // A decision model is right when it rates the known-true probe as likely.
  if (model && isDecision(model)) {
    if (!result || result.status !== 'pass' || typeof result.decisionScore !== 'number') return null;
    return result.decisionScore >= settings.decisionThreshold;
  }

  const alts = expectedAnswer
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (alts.length === 0) return null;
  if (!result || result.status !== 'pass' || result.isEmpty) return null;

  const rawText = (result.response || '').trim();
  const text = rawText.toLowerCase();
  const mode = (typeof settings !== 'undefined' && settings.matchMode) || 'boundary';

  if (mode === 'exact') {
    const normalized = text.replace(/[.!?,;:]+$/, '').trim();
    return alts.some((alt) => normalized === alt || text === alt);
  }

  if (mode === 'contains') {
    return alts.some((alt) => text.includes(alt));
  }

  if (mode === 'regex') {
    try {
      return new RegExp(expectedAnswer.trim(), 'i').test(rawText);
    } catch {
      return false;
    }
  }

  return alts.some((alt) => {
    if (/^[a-z0-9]+$/i.test(alt)) {
      return new RegExp(`(^|[^a-z0-9])${escapeRegex(alt)}([^a-z0-9]|$)`, 'i').test(text);
    }
    return text.includes(alt);
  });
}

// ============================================
// Title bar
// ============================================
$('#btn-minimize').addEventListener('click', () => window.electronAPI.minimize());
$('#btn-maximize').addEventListener('click', () => window.electronAPI.maximize());
$('#btn-close').addEventListener('click', () => window.electronAPI.close());

// The detail unit owns the provider header and the API-key list UI.
const providerDetail = window.VENOM_RENDERER.providerDetail.create({
  $,
  $$,
  getProvider: (id) => PROVIDERS[id],
  getActiveProvider: () => activeProvider,
  getCurrentPage: () => getCurrentPage(),
  breadcrumbHTML,
  providerMark: (p) => providerMark(p),
  providerStatusHTML: (p) => providerStatusHTML(p),
  renderPageHeader: (page) => renderPageHeader(page),
  showPage: (page) => showPage(page),
  openProviderModal: (id) => openProviderModal(id),
  escapeHtml,
  toggleKeyActive: (keyId) => toggleKeyActive(keyId),
  removeKey: (keyId) => removeKey(keyId),
  copyKey: (keyId, button) => copyKey(keyId, button),
});
const renderProviderHead = () => providerDetail.renderHead();
const renderKeysList = () => providerDetail.renderKeys();

// ============================================
// Provider health — adopted from the unified discovery cycle, no requests of
// its own. Every sync pass hands one outcome per key to adoptProbeResults
// below, which writes the same verdicts the old per-key probe produced.
// States: 'ok' (a key authenticated), 'fail' (every key was refused or the host
// is unreachable), 'none' (no usable key to test with). Kept outside the DOM
// because the tab list is rebuilt on every render.
const HEALTH_TIMEOUT_MS = 15000;
// A dropped connection or a waking laptop fails every probe at once. A transient
// failure is re-checked after this delay and only a second one turns the row red.
const HEALTH_CONFIRM_MS = 10000;
const healthConfirming = new Set();
const providerHealth = new Map();
// The row's status strip keeps the verdicts the badge keeps only the last of:
// one entry per check, oldest first, capped at PROVIDER_TICKS. In memory like
// providerHealth itself — it is the same reading, kept over time, and it is
// written in exactly one place (setProviderHealth) so the strip and the badge
// can never disagree about what the last check said.
const PROVIDER_TICKS = 24;
const providerVerdicts = new Map();

function describeHealthFailure(res) {
  if (res.networkError) return res.timedOut ? 'No response' : 'Unreachable';
  if (res.status === 401 || res.status === 403) return `Key rejected (HTTP ${res.status})`;
  return `HTTP ${res.status}`;
}

function keyProbeResult(res) {
  return isHealthyResponse(res)
    ? { state: 'ok', text: `OK · ${res.elapsed} ms`, at: Date.now() }
    : { state: 'fail', text: describeHealthFailure(res), at: Date.now() };
}

// One discovery outcome mapped onto the same verdicts the old probe produced:
// a key that answered (2xx, or 429 — authenticated but busy) is healthy; a
// refused key is a verdict; anything else is confirmed before the row turns
// red, exactly like a transient probe failure was.
function discoverVerdict(o) {
  if (o.ok) return { ok: true, text: `OK · ${o.ms} ms` };
  const m = String((o.error && o.error.message) || o.error || '').match(/HTTP (\d{3})/);
  const status = m ? Number(m[1]) : 0;
  if ((status >= 200 && status < 300) || status === 429) return { ok: true, text: `OK · ${o.ms} ms` };
  if (status === 401 || status === 403) {
    return { ok: false, text: `Key rejected (HTTP ${status})`, transient: false, detail: `Key rejected (HTTP ${status})` };
  }
  if (status >= 500) {
    return { ok: false, text: `HTTP ${status}`, transient: true, detail: `HTTP ${status}` };
  }
  return { ok: false, text: 'Unreachable', transient: true, detail: 'Unreachable' };
}

// Health verdicts adopted from a unified discovery pass: one outcome per
// usable key, no extra requests. Provider verdict, confirm flow and key rows
// behave exactly as they did under the old probe.
function adoptProbeResults(p, outcomes) {
  if (!p) return;
  const list = Array.isArray(outcomes) ? outcomes : [];
  for (const o of list) {
    const k = (p.keys || []).find((x) => x && x.id === o.kid);
    if (!k) continue;
    const v = discoverVerdict(o);
    keyProbe.set(k.id, { state: v.ok ? 'ok' : 'fail', text: v.text, at: Date.now() });
  }
  const oks = list.filter((o) => discoverVerdict(o).ok);
  if (oks.length) {
    healthConfirming.delete(p.id);
    // G: single ok wording (Reachable) — matches the health line and KPI pill.
    setProviderHealth(p.id, { state: 'ok', detail: `Reachable · ${Math.min(...oks.map((o) => o.ms))} ms` });
    return;
  }
  if (!list.length) {
    // No usable key to ask — not a failure, same 'none' the old probe gave.
    setProviderHealth(p.id, { state: 'none', detail: 'No API key' });
    return;
  }
  const last = discoverVerdict(list[list.length - 1]);
  reportHealthFailure(p.id, last.detail, last.transient);
}

// Status badge shared by provider rows and key rows. The colour dot carries
// the verdict and the badge holds the reading: a latency when healthy
// ("● | 472 ms"), the code on a failure ("● | 401"). Under every badge, a
// two-word line says it in words ("Key working", "Key rejected"); the whole
// sentence stays in the tooltip.
// Detail strings come from describeHealthFailure / the probes above.
function splitStatus(text) {
  const t = String(text || '');
  const dot = t.split(' · ');
  if (dot.length === 2) return { label: dot[0], meta: dot[1] };
  const paren = t.match(/^(.*) \((HTTP \d+)\)$/);
  if (paren) return { label: paren[1], meta: paren[2] };
  const code = t.match(/^HTTP (\d+)$/);
  if (code) return { label: Number(code[1]) >= 500 ? 'Server error' : 'Request refused', meta: t };
  return { label: t, meta: '' };
}

// The line under every badge is exactly two words. Each detail string the
// probes can produce has its own; anything else (an unexpected exception's
// message) falls back to its state's, and the full text stays in the tooltip.
const STATUS_CAPTION = {
  Reachable: 'Provider online',
  OK: 'Key working',
  'Key rejected': 'Key rejected',
  'Quota used': 'Quota used',
  'No response': 'No response',
  Unreachable: 'Host unreachable',
  'Server error': 'Server error',
  'Request refused': 'Request refused',
  'Check failed': 'Check failed',
  'No active key': 'Keys disabled',
  'No API key': 'No keys',
  'Not connected — needs an API key': 'Not connected',
  'Checking connection…': 'Checking now',
  'Checking…': 'Checking now',
  'Testing…': 'Testing now',
  Unreadable: 'Key unreadable',
  'Not checked': 'Not checked',
  Disabled: 'Key disabled',
  'Key disabled': 'Key disabled',
};
const STATUS_CAPTION_FALLBACK = { ok: 'Working fine', fail: 'Check failed', none: 'Not checked', pending: 'Checking now', testing: 'Testing now' };

function statusCaption(state, label) {
  return STATUS_CAPTION[label] || STATUS_CAPTION_FALLBACK[state] || 'Not checked';
}

function statusPillHTML(state, text, title = '', { caption: withCaption = true } = {}) {
  const { label, meta } = splitStatus(text);
  const value = meta.replace(/^HTTP\s+/i, '');
  const lead = state === 'testing' ? '<span class="spinner"></span>' : '<span class="st-pill-dot"></span>';
  // The value slot is always there ("—" when there is no reading), so every
  // badge keeps the same width.
  const pill = `<span class="st-pill">${lead}<span class="st-pill-meta">${escapeHtml(value || (state === 'testing' || state === 'pending' ? '…' : '—'))}</span></span>`;
  const caption = withCaption ? `<span class="st-caption">${escapeHtml(statusCaption(state, label))}</span>` : '';
  // Words first, then the badge: in a key row they line up with the key's
  // name and its masked value beside them.
  return `<span class="st-status" data-state="${state}" title="${escapeHtml(title || text)}">${caption}${pill}</span>`;
}

// A 429 still proves the key authenticated — the provider is up, just busy.
function isHealthyResponse(res) {
  return (res.status >= 200 && res.status < 300) || res.status === 429;
}

// A refused key is a verdict; a timeout or 5xx may be the network blinking, so
// it is confirmed by a second pass before the row turns red.
function reportHealthFailure(id, detail, transient) {
  const current = providerHealth.get(id);
  if (!transient || healthConfirming.has(id) || (current && current.state === 'fail')) {
    healthConfirming.delete(id);
    setProviderHealth(id, { state: 'fail', detail });
    return;
  }
  healthConfirming.add(id);
  setTimeout(() => { if (window.CATALOG) window.CATALOG.syncAll({ reason: 'confirm', providerId: id }); }, HEALTH_CONFIRM_MS);
}

function setProviderHealth(id, { state, detail }) {
  const now = Date.now();
  const prev = providerHealth.get(id);
  providerHealth.set(id, { state, detail, checkedAt: now });
  // One tick for the strip, on the same call the badge updates on. The ring is
  // capped, so a provider checked every five minutes keeps two hours of
  // verdicts and no more.
  const ring = providerVerdicts.get(id) || [];
  ring.push({ state, detail, at: now });
  providerVerdicts.set(id, ring.slice(-PROVIDER_TICKS));
  // A Recheck the user pressed resolves into its verdict (see recheckProvider).
  if (recheckAct.get(id)?.state === 'running') setAct(recheckAct, id, state);
  if (getCurrentPage() === 'provider' && id === activeProvider) renderProviderHead();
  renderQuickStats();
  if (getCurrentPage() === 'providers') renderProvidersPage();
  // These two show only the state (a dot), and rebuilding them resets open
  // menus, so a probe that confirms the same state leaves them alone.
  if (!prev || prev.state !== state) {
    if (window.CATALOG) window.CATALOG.renderIfShown();
  }
}

// One background cycle for everything: provider status, key verdicts, roster
// and diff, every catalogSyncMinutes while live updates are on. The catalog
// owns the timer (scheduleTimer); this only arms the triggers. The first pass
// runs with the catalog's startup sync, so every page has a verdict to show.
const unifiedCycleMs = () => Math.max(1, Number(settings.catalogSyncMinutes) || 5) * 60 * 1000;
function startHealthMonitor() {
  // Coming back to the app after a while shouldn't show a stale verdict.
  // The connection coming back is exactly when red rows are most likely stale.
  window.addEventListener('online', () => { if (settings.liveUpdates && window.CATALOG) window.CATALOG.syncAll({ reason: 'reconnect' }); });
  window.addEventListener('online', renderSystemLamp);
  window.addEventListener('offline', renderSystemLamp);
  window.addEventListener('focus', () => {
    if (!settings.liveUpdates || !window.CATALOG) return;
    const stale = Date.now() - unifiedCycleMs() / 2;
    const staleIds = Object.keys(PROVIDERS).filter((id) => {
      const h = providerHealth.get(id);
      return !h || h.checkedAt < stale;
    });
    // One subset pass, not one per provider: syncAll already fans out.
    if (staleIds.length) window.CATALOG.syncAll({ reason: 'focus' });
  });
  renderLiveToggles();
}

// Resuming re-checks at once: whatever is on screen is as old as the pause.
function setLiveUpdates(on) {
  settings.liveUpdates = on;
  queueSettingsSave();
  if (window.CATALOG && window.CATALOG.scheduleTimer) window.CATALOG.scheduleTimer();
  renderLiveToggles();
  if (on && window.CATALOG) window.CATALOG.syncAll({ reason: 'manual' });
}

// The live switch is the orb between the Providers page's tabs; this keeps
// it (and anything else marked data-live-toggle) in step with the setting.
function liveToggleAttrs() {
  const on = settings.liveUpdates;
  const mins = Math.max(1, Number(settings.catalogSyncMinutes) || 5);
  const every = mins === 1 ? 'every minute' : `every ${mins} minutes`;
  return {
    on,
    title: on
      ? `Live updates on — provider health re-checked ${every}. Click to pause.`
      : 'Live updates paused — provider health is not re-checked in the background. Click to resume.',
  };
}

function renderLiveToggles() {
  const { on, title } = liveToggleAttrs();
  $$('[data-live-toggle]').forEach((btn) => {
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.title = title;
    btn.setAttribute('aria-label', title);
  });
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-live-toggle]')) setLiveUpdates(!settings.liveUpdates);
});

function switchProvider(providerId) {
  activeProvider = providerId;
  const p = PROVIDERS[activeProvider];
  providerModels.setSearch('');
  renderProviderHead();
  renderKeysList();
  renderModelsList();
  updateTestAllButton();
  updateStats();
  if (getCurrentPage() === 'provider') syncRoute();
}

// The provider whose run fills the results table. The table holds one
// provider's run at a time; opening another provider's page starts it empty.
let resultsProvider = null;

// The only way onto the provider page. A run in progress owns the table, so
// while one is going the page stays on its provider rather than showing that
// run's rows under another provider's name.
function openProviderPage(id) {
  if (!PROVIDERS[id]) return;
  const target = isTesting && resultsProvider && PROVIDERS[resultsProvider] ? resultsProvider : id;
  if (!isTesting && resultsProvider !== target) clearResults();
  resultsProvider = target;
  switchProvider(target);
  showPage('provider');
  if (target !== id) setStatus('running', `${PROVIDERS[target].name} is being tested — stop the run to open ${PROVIDERS[id].name}`);
}

// ============================================
// API Keys management
// ============================================
// Open padlock = the key is in use for runs; closed = held back. The icon shows
// the current state, and the tooltip spells out what clicking it will do.
// The page never holds a key: k.key is a venomkey:<id> placeholder that main
// swaps for the secret per request, and k.hint is the masked form main
// computed. Copy is the one way the full value leaves the app, and main
// writes it to the clipboard itself.
// A key flagged `locked` is ciphertext this machine can't open, so there is
// nothing to send — it is excluded from every run.
function usableKeys(p) {
  return p.keys.filter((k) => k.active && !k.locked);
}

// Provider actions are composed after the key view state is available.
let providerActions;
function copyKey(keyId, btn) { return providerActions.copyKey(keyId, btn); }
function toggleKeyActive(keyId) { return providerActions.toggleKeyActive(keyId); }
function removeKey(keyId) { return providerActions.removeKey(keyId); }
function refreshAfterKeyChange(pid) { return providerActions.refreshAfterKeyChange(pid); }
async function storeKey(pid, name, key) {
  const k = { id: `key_${Date.now()}`, name: name || `Key ${Date.now()}`, key, active: true };
  PROVIDERS[pid].keys.push(k);
  const saved = await saveProviderConfig(pid);
  return { k, saved };
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

  nameInput.value = '';
  keyInput.value = '';
  const pid = activeProvider;
  const { k, saved } = await storeKey(pid, name, key);
  renderKeysList();
  updateTestAllButton();
  // A failed save already left its error in the status bar (persist()); a
  // "done" here would overwrite it and hide that the key wasn't saved.
  if (saved) setStatus('done', `Key "${name}" added`);
  // The new key's quota and expiry are read now, as Connect does. Without
  // this its usage cells sat on the loading skeleton until the page reloaded.
  if (window.KEY_USAGE) KEY_USAGE.refresh(pid, k.id, { force: true });
}

// Provider discovery owns each provider's fetched roster and catalog sync.
const providerModels = window.VENOM_RENDERER.providerModels.create({
  $: (selector) => $(selector), $$: (selector) => $$(selector), electronAPI: window.electronAPI,
  getProviders: () => PROVIDERS, getActiveProvider: () => activeProvider,
  integratedProviders: () => window.INTEGRATED_PROVIDERS || {}, usableKeys,
  setStatus: (state, text) => setStatus(state, text),
  updateTestAllButton: () => updateTestAllButton(), updateStats: () => updateStats(),
  renderCostEstimate: () => renderCostEstimate(), classifyModel, isMedia,
  escapeHtml, kindLabels: KIND_LABELS,
  refreshActivity: () => {
    if (!window.ACTIVITY) return;
    if (window.ACTIVITY.refreshBell) window.ACTIVITY.refreshBell();
    if (window.ACTIVITY.renderIfShown) window.ACTIVITY.renderIfShown();
  },
});
const getProviderModels = (providerId) => providerModels.getModels(providerId);
const renderModelsList = () => providerModels.renderModelsList();
const getSelectedModels = () => providerModels.getSelectedModels();
const taggedApiRequest = (...args) => providerModels.taggedApiRequest(...args);
const discoverModels = (...args) => providerModels.discoverModels(...args);
const ingestProviderRoster = (...args) => providerModels.ingestProviderRoster(...args);
const tagAliasGroups = (...args) => providerModels.tagAliasGroups(...args);
const dedupeById = (...args) => providerModels.dedupeById(...args);
const formatContext = (...args) => providerModels.formatContext(...args);
const readContextWindow = (...args) => providerModels.readContextWindow(...args);
const readsVision = (...args) => providerModels.readsVision(...args);
const readsReasoning = (...args) => providerModels.readsReasoning(...args);
const getFreeGroupName = (...args) => providerModels.getFreeGroupName(...args);

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
// Models that reject reasoning_effort. Some gateways translate it into
// Anthropic's budgeted `thinking`, which newer Claude models refuse outright
// ("requires adaptive thinking"). Learned per model from that 400, because the
// provider's other models accept it and are better tested with it.
const noReasoningEffort = new Set();
const reasoningKey = (providerId, modelId) => `${providerId}::${modelId}`;
const REASONING_REJECTED = /thinking|reasoning[_ ]effort/i;

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
// Stateful key policy is composed here, never through shared mutable maps.
let runStatusText = '';
const keyPolicy = window.VENOM_RENDERER.policy.create({
  getProviders: () => PROVIDERS, getActiveProvider: () => activeProvider,
  isAborted: () => abortTesting, getRunStatus: () => runStatusText,
  usableKeys, saveProviderConfig, refreshAfterKeyChange, setStatus, sleep,
  getSettings: () => settings,
  getAdapter: (id) => (window.INTEGRATED_PROVIDERS || {})[id],
});
const {
  isRateLimit, isEntitlementDenial, readQuotaError, quotaSpentExpired, isKeySpent, isKeyFullySpent,
  isKeyPartiallySpent, isKeySpentFor, formatIn, spentHint, markKeySpent, clearKeySpent,
  keyNameById, rpmOf, keysFor, slotsUsed, budgetFor, learnRateLimit, hasFreeKeyBudget, pickKey,
  soonestKeyAvailable, waitForSlot, waitForAnyKey, coolKeyDown,
} = keyPolicy;

let requestSeq = 0;
// Every id handed out during a run, so Stop can kill sockets that are already in
// flight. Without this, hitting Stop still leaves the hedged requests
// running (and billing) until the 60s request timeout fires.
const inflightIds = new Set();
// Request-log tags by request id ({ attempt, hedgeIndex, testGroup, paramSwap }),
// set when the id is handed out and read when its request goes out, so the
// round and the hedge index travel with the id instead of through every
// tester's signature. Never cleared at the start of a run: a straggler from
// the previous run (a video poll, a delayed retry) still needs its captured
// tags to log under the run it actually belongs to. Bounded instead — a Map
// keeps insertion order, so the oldest entries are the first dropped.
const requestTags = new Map();
const REQUEST_TAGS_MAX = 2000;
// { runId, trigger } of the Route Test run in progress; null between runs.
let routeRun = null;

// The run and trigger are captured here, once, off the live routeRun — not
// re-read at send time. tags forwarded from an earlier captured id (a poll
// or a param-swap retry) already carry their originating request's runId and
// trigger, so those are kept rather than overwritten with whatever run is
// current by the time this later id is minted.
function nextRequestId(tags = null) {
  requestSeq += 1;
  const id = `req_${Date.now()}_${requestSeq}`;
  inflightIds.add(id);
  if (tags) {
    const runId = tags.runId !== undefined ? tags.runId : (routeRun ? routeRun.runId : undefined);
    const trigger = tags.trigger !== undefined ? tags.trigger : (routeRun ? routeRun.trigger : undefined);
    requestTags.set(id, { ...tags, runId, trigger });
    while (requestTags.size > REQUEST_TAGS_MAX) requestTags.delete(requestTags.keys().next().value);
  }
  return id;
}

// What a Route Test request carries into the request log. runId/trigger
// prefer the id's captured tags (from nextRequestId): the live routeRun is
// only a fallback for an id that was never tagged, so a straggling request
// from a run that has since finished (or a new one that has since started)
// still logs under the run it was actually part of.
function routeTestTags(requestId) {
  const t = (requestId && requestTags.get(requestId)) || {};
  return {
    source: 'route_test',
    runId: t.runId !== undefined ? t.runId : (routeRun ? routeRun.runId : undefined),
    trigger: t.trigger !== undefined ? t.trigger : (routeRun ? routeRun.trigger : undefined),
    attempt: t.attempt,
    hedgeIndex: t.hedgeIndex,
    testGroup: t.testGroup,
    paramSwap: t.paramSwap || undefined,
  };
}

// Cancelling an already-finished id is a no-op in the main process, so this can
// safely fire at every id from the current run. Only Stop calls it.
function cancelAllInflight() {
  inflightIds.forEach((id) => window.electronAPI.cancelApiRequest(id, 'stop'));
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

// ============================================
// Testers — one request, judged by the model's kind
// ============================================
// Every tester returns the same result shape (status, response, time, tokens,
// statusCode, retryAfter, keyId), so testModel's retry, rate-limit and
// entitlement handling applies to all of them unchanged.

// Request-kind implementations and response parsing live in the extracted units.
const testAttempts = window.VENOM_RENDERER.attempts.create({
  responses: window.VENOM_RENDERER.responses, policy: keyPolicy,
  getSettings: () => settings, getPrompt: () => testPrompt, isAborted: () => abortTesting,
  defaultPrompt: DEFAULT_TEST_PROMPT, isMedia, isDecision, kindLimits,
  request: (options) => window.electronAPI.apiRequest(options), routeTestTags,
  getRequestTags: (id) => requestTags.get(id), nextRequestId, sleep,
  tokenLimitField, swapTokenLimitField,
  omitReasoning: (pid, mid) => noReasoningEffort.has(reasoningKey(pid, mid)),
  disableReasoning: (pid, mid) => noReasoningEffort.add(reasoningKey(pid, mid)),
  reasoningRejected: (message) => REASONING_REJECTED.test(message),
  observeUsage: (pid, kid, headers) => { if (window.KEY_USAGE) window.KEY_USAGE.observe(pid, kid, headers); },
  getAdapter: (id) => (window.INTEGRATED_PROVIDERS || {})[id],
});
const { attemptOnce } = testAttempts;

const testRunner = window.VENOM_RENDERER.runner.create({
  responses: window.VENOM_RENDERER.responses, policy: keyPolicy, attemptOnce,
  getSettings: () => settings, isAborted: () => abortTesting,
  isMedia, isDecision, kindLimits, nextRequestId,
  cancelRequest: (id, reason) => window.electronAPI.cancelApiRequest(id, reason),
  onProgress: (model, result) => resultsTable.updateRow(model, result),
  getRunningResult: () => RUNNING_RESULT,
  newUlid, sleep, retryDelay,
});
const { testModel } = testRunner;

// ============================================
// Test all selected models
// ============================================
const RUNNING_RESULT = { status: 'running', time: null, tokens: null, response: '' };
const QUEUED_RESULT = { status: 'queued', time: null, tokens: null, response: '' };

// The one button is Test while idle and Stop while a run is going. Testing
// starts by fetching: the roster the run will use is the roster the provider
// publishes right now, and main maps it into the catalog on the way in — so a
// model that appeared since the last sync is testable, and the run's verdicts
// land on rows that already carry their score and context.
$('#btn-test-all').addEventListener('click', async () => {
  if (isTesting) {
    abortTesting = true;
    cancelAllInflight();
    setStatus('running', 'Stopping...');
    return;
  }
  try {
    await ingestProviderRoster();
  } catch (err) {
    setStatus('error', err.message || 'Could not fetch models');
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
  const model = getProviderModels().find((m) => m.id === btn.dataset.modelId);
  if (model) runTests([model], { reset: false });
});

// Failed results, plus rows a stopped run never reached (those aren't recorded
// in testResults at all, so they're read back off the table).
function retryableModels() {
  const ids = new Set(testResults.filter((r) => r.status === 'fail').map((r) => r.model));
  // Read off the backing data, not the DOM — a "failed only" filter or a sort
  // can leave skipped rows out of the table entirely.
  resultsTable.forEachRow((e) => {
    if (e.result.status === 'skipped') ids.add(e.model.id);
  });
  return getProviderModels().filter((m) => ids.has(m.id));
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
  resultsProvider = p.id;
  abortTesting = false;
  inflightIds.clear();
  // requestTags is intentionally not cleared here: a straggler from the run
  // that just ended still needs its captured tags (see requestTags above).
  // The run's id tags every request it sends and names its history run, so
  // the request log and the history agree on which run a request was part of.
  routeRun = { runId: newUlid(), trigger: scheduled ? 'scheduled' : 'manual' };
  keyPolicy.resetRun(reset);

  if (reset) {
    testResults = [];
    runTotal = list.length;
    // The reference facts the table reads are refreshed and fetched BEFORE the
    // first row is built, not per row: one sync, then one ingest for the whole
    // roster. Awaited so no row is ever rendered against an empty map and then
    // silently corrected — and the sync is forced, because a test run is the one
    // moment the reference has to be today's rather than the cache's.
    setStatus('running', 'Refreshing the reference...');
    runStatusText = 'Refreshing the reference...';
    updateTestAllButton();
    try {
      const facts = await loadTestFacts(p.id, list);
      if (facts && facts.ok === false) {
        console.warn('reference facts unavailable:', facts.code || facts.message);
      }
    } catch (err) {
      console.warn('reference facts unavailable:', err && err.message);
    }
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
  runStartTime = Date.now();
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
      // The verdict a run produces is also a health verdict: same request, same
      // key, same answer, and it is the answer the Models page's heart shows and
      // the p50 it draws. Written through catalog:health so main owns the
      // latency ring, and fire-and-forget so a refusal here — a model the roster
      // no longer holds — cannot fail a run that already passed.
      //
      // Only a real model verdict is written. A key that spent its quota, an
      // entitlement denial, a rate limit and a Stop are facts about the KEY and
      // the run, not about the model, and recording them as the model's health
      // would blame the model for the router's own state. A media model is not
      // written either: its `time` is seconds of generation, not the latency a
      // p50 column means, and mixing the two makes the number meaningless.
      const modelVerdict = !result.quotaSpent && !result.entitlementDenied && !result.allKeysCooling
        && !(result.statusCode === 429)
        && (result.status === 'pass' || result.status === 'fail')
        && !isMedia(model);
      if (modelVerdict) {
        window.electronAPI.catalogHealth(p.id, model.id, {
          status: result.status === 'pass' ? 'healthy' : 'error',
          note: result.response ? String(result.response).slice(0, 200) : null,
          httpStatus: result.statusCode ?? null,
          at: Date.now(),
          timeMs: result.time,
        }).catch(() => {});
      }
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

  // isTesting is already false here, so a new run may start while this one
  // is saved; it must keep its own routeRun.
  const finishedRun = routeRun;
  const saved = await recordRun(p.id, p.name, testResults, finishedRun.runId);
  if (routeRun === finishedRun) routeRun = null;
  lastRun = { done, total: list.length, stopped: abortTesting, changes: runRegressions(), saved };
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
  // An empty 200 is a pass on the wire, but "46 passed" where every answer was
  // empty is a different fact from 46 real answers. Said in the same breath.
  const emptyPasses = testResults.filter((r) => r.status === 'pass' && r.isEmpty).length;
  const emptyNote = emptyPasses ? ` · ${emptyPasses} answered empty` : '';

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

  let state;
  let message;
  if (lastRun.stopped) {
    state = 'idle';
    message = `Stopped — ${lastRun.done}/${lastRun.total} tested (${passed} passed, ${failed} failed)${answers}${emptyNote}${delta}`;
  } else if (failed === 0 && passed > 0 && emptyPasses === passed) {
    state = 'done'; message = `All ${passed} models answered empty${delta}`;
  } else if (failed === 0) { state = 'done'; message = `All ${passed} models passed${answers}${emptyNote}${delta}`; }
  else if (passed === 0) { state = 'error'; message = `All ${failed} models failed${delta}`; }
  else { state = c.broke.length ? 'error' : 'done'; message = `Done: ${passed} passed, ${failed} failed${answers}${emptyNote}${delta}`; }

  // A failed history write must stay visible: persist() already reported it,
  // but this status runs right after and would otherwise overwrite it.
  if (lastRun.saved === false) { state = 'error'; message += ' · run not saved'; }
  setStatus(state, message);
}

// ============================================
// Results table
// ============================================
// Table state, sort/filter, export and the response modal live in the results
// unit. Row HTML and reference facts stay here so catalog scoring stays local.
resultsTable = window.VENOM_RENDERER.results.create({
  escapeHtml, buildRowHtml, contextOf, scoreOf, costOf, latencyOf, uptimeOf, isCorrect,
  modelById, updateStats, setStatus,
  getTestResults: () => testResults,
  setTestResults: (rows) => { testResults = rows; },
  clearRunState: () => { runTotal = null; lastRun = null; },
  getActiveProviderMeta: () => PROVIDERS[activeProvider],
});
resultsTable.bind();
const {
  initResultsTable, addResultRow, updateResultRow, renderResultsTable, clearResults, tokensPerSecond,
} = resultsTable;

const ptLegend = $('#pt-legend');
if (ptLegend) {
  ptLegend.addEventListener('click', (e) => {
    if (e.target.closest('[data-pt-legend-toggle], .mc-legend-head')) {
      ptLegendOpen = !ptLegendOpen;
      renderPtLegend();
    }
  });
}

// SVG icons for badges
const ICONS = {
  vision: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
  think: `<span class="emoji-cap" aria-hidden="true">🧠</span>`,
  free: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 12V8H6a2 2 0 01-2-2V6a2 2 0 012-2h12"/><circle cx="16" cy="16" r="4"/><path d="M16 14v4M14 16h4"/></svg>`,
  timeout: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  tokens: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9 9h6M9 15h6"/><path d="M12 9v6"/></svg>`,
  image: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`,
  video: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="14" height="14" rx="2"/><path d="M22 8l-6 4 6 4V8z"/></svg>`,
  decision: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18"/><path d="M5 7h14"/><path d="M5 7l-3 7a3 3 0 006 0z"/><path d="M19 7l-3 7a3 3 0 006 0z"/></svg>`,
  retry: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 11-6.219-8.56"/><polyline points="22 2 22 8 16 8"/></svg>`,
};

function iconSpan(key, label, cls) {
  return `<span class="icon-badge ${cls}" title="${label}">${ICONS[key]}</span>`;
}

// Status badge as compact dot
function statusIconBadge(status, isEmpty) {
  if (status === 'pass' && !isEmpty) {
    return `<span class="status-dot-badge pass" title="Pass">✓</span>`;
  }
  if (status === 'pass' && isEmpty) {
    return `<span class="status-dot-badge empty" title="Empty response">∅</span>`;
  }
  if (status === 'fail') {
    return `<span class="status-dot-badge fail" title="Failed">✗</span>`;
  }
  if (status === 'queued') {
    return `<span class="status-dot-badge queued" title="Waiting its turn">⋯</span>`;
  }
  if (status === 'skipped') {
    return `<span class="status-dot-badge skipped" title="Not tested">—</span>`;
  }
  return `<span class="status-dot-badge running" title="Testing"><span class="spinner"></span></span>`;
}

// What ✓ and ✗ mean depends on the standard the model was judged by.
function correctnessTitles(model) {
  if (isDecision(model)) {
    const t = settings.decisionThreshold.toFixed(2);
    return [`Rated the probe at or above ${t}`, `Rated the probe below ${t}`];
  }
  if (isMedia(model)) return [`Returned a real ${model.kind}`, `The returned link does not serve a ${model.kind}`];
  return ['Matches the expected answer', 'Does not contain the expected answer'];
}

// ============================================
// Reference facts for the test table
// ============================================
// A provider's /models payload is a roster, not a spec sheet: what it publishes
// is its own choice, and a thin provider publishes little more than ids — which
// is why the CONTEXT and TYPE columns came out empty and hid themselves. The
// facts the row is missing already exist locally, because main holds the merged
// reference, so the table reads them instead of asking the provider twice.
//
// One ingest per roster, never one per row: `catalog:fetch-info` is the same
// merge behind a single row's button, and it runs a source sync plus a full
// ingest on every call. Thirty-two models would pay that thirty-two times over.
// The ingest reply already carries every scored row, so it is read once here.
let testFacts = new Map();   // model id -> the catalogue row main stored
let testFactsFor = null;     // the provider the map belongs to

function catalogRowFor(model) {
  if (!model) return null;
  const id = String(model.id || '');
  const fromFacts = testFacts.get(id);
  if (fromFacts) return fromFacts;
  if (typeof window !== 'undefined' && window.CATALOG && window.CATALOG.state && window.CATALOG.state.models) {
    const fromCat = window.CATALOG.state.models.get(`${activeProvider}::${id}`);
    if (fromCat) return fromCat;
  }
  return null;
}

async function loadTestFacts(providerId, models) {
  testFacts = new Map();
  // The cache is keyed by model object, so a re-test of the same objects would
  // otherwise answer from the previous run's reference rows.
  factsCache = new WeakMap();
  testFactsFor = providerId;
  const api = window.electronAPI;
  if (!models || !models.length || !api || typeof api.catalogIngest !== 'function') {
    return { ok: false, code: 'NO_CATALOG' };
  }

  // Refresh the reference FIRST, then read it. `catalog:ingest` alone answers from
  // whatever the cache holds, and that cache is only re-fetched once it is fifteen
  // minutes old — so a model that shipped this morning would be scored against
  // yesterday's sources and read as unrated. A test run is the moment the answer
  // has to be current, so the TTL is overridden here.
  //
  // A refresh that fails is not a reason to refuse to test: the cached sources are
  // still the best reference on the machine, and the run goes on against them with
  // the staleness left visible rather than hidden.
  let refresh = null;
  if (typeof api.catalogSources === 'function') {
    try {
      refresh = await api.catalogSources({ force: true });
      if (refresh && refresh.error) {
        console.warn('reference refresh failed, testing against the cached sources:', refresh.error);
      }
    } catch (err) {
      console.warn('reference refresh failed, testing against the cached sources:', err && err.message);
    }
  }

  // The Models page holds its own rows, read on a TTL of its own. A refresh that
  // this table forced would otherwise leave that page showing the score from
  // before it — the same model, two numbers, one screen apart. Reloading it here
  // is what keeps the two surfaces saying the same thing.
  if (refresh && window.CATALOG && typeof window.CATALOG.reload === 'function') {
    try {
      await window.CATALOG.reload();
    } catch (err) {
      console.warn('the Models page did not reload after the refresh:', err && err.message);
    }
  }

  // And the table already on screen is repainted from the new facts — but only
  // once the ingest has answered. Repainting before it would render every row
  // against an empty map and blank the table for a frame.
  const reply = await api.catalogIngest(providerId, models);
  if (reply && reply.ok === false) return reply;
  (reply && reply.rows ? reply.rows : []).forEach((row) => {
    testFacts.set(String(row.id), row);
  });
  if (resultsTable.hasRows()) {
    resultsTable.render();
    updateStats();
  }
  return { ...(reply || { ok: true, rows: [] }), refresh };
}

// The resolution rules live in provider-facts.js, because that file is pure and
// a test can evaluate it; this file touches window and document at load and
// cannot be. Keeping the rules there is what stops the table and its test from
// disagreeing about what silence means.
//
// The result is cached per model object because a sort calls the accessors once
// per comparison, and `testFacts` is cleared on every run so a stale row can
// never answer for a roster that has since changed.
let factsCache = new WeakMap();

function factsFor(model) {
  const cacheable = model && typeof model === 'object';
  if (cacheable && factsCache.has(model)) return factsCache.get(model);
  const facts = resolveFacts(model, catalogRowFor(model), readContextWindow(model),
    runTimesFor(model && model.id));
  if (cacheable) factsCache.set(model, facts);
  return facts;
}

function contextOf(model) { return factsFor(model).context; }
function scoreOf(model) { return factsFor(model).score; }
function scoreSourceOf(model) { return factsFor(model).scoreSource; }
function costOf(model) { return factsFor(model).cost; }
function capabilityRowFor(model) { return factsFor(model).capRow; }
function latencyOf(model) { return factsFor(model).latency; }
function latencySamplesOf(model) { return factsFor(model).latencySamples; }

const MODALITY_ICONS = {
  text: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  image: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
  audio: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5v14M7 5v14M2 9v6M22 9v6"/></svg>',
  video: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="14" height="14" rx="2"/><path d="m22 8-6 4 6 4V8z"/></svg>',
  pdf: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
};

// The modality tokens the model reads, drawn like the CAPS icons: one lit
// mark per supported input, coloured by token, and nothing for the rest.
// A supported input is the presence of a chip; `null` stays silence (no chip
// at all), so a provider that published no modality list never gains invented
// refusals.
const MODALITY_TONES = { text: 'tool', image: 'vision', audio: 'audio', video: 'video', pdf: 'files' };

function inputIconsHtml(model) {
  const inputs = resolveInputs(capabilityRowFor(model));
  const chips = inputs.filter(({ state }) => state === true).map(({ token }) => {
    const title = `Reads ${token}`;
    const tone = MODALITY_TONES[token] || 'tool';
    return `<span class="mc-cap-ico mc-cap-${tone}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">${MODALITY_ICONS[token] || ''}</span>`;
  });
  return chips.length ? `<div class="cell-model-inputs mc-caps">${chips.join('')}</div>` : '';
}

const CAP_ICONS_MAP = {
  tools: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
  reasoning: '<span class="emoji-cap" aria-hidden="true">🧠</span>',
  structured: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/></svg>',
  vision: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  imageGen: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/></svg>',
  audio: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/></svg>',
  video: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 13 5.22 3.48a.5.5 0 0 0 .78-.42V7.9a.5.5 0 0 0-.75-.43L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>',
  files: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13.23 20.25 21 12.3"/><path d="m16 6-8.41 8.59a2 2 0 0 0 0 2.82 2 2 0 0 0 2.83 0l8.41-8.59a4 4 0 0 0 0-5.65 4 4 0 0 0-5.65 0l-8.42 8.59a6 6 0 1 0 8.49 8.48"/></svg>',
  decision: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M5 7h14"/><path d="M5 7l-3 7a3 3 0 006 0z"/><path d="M19 7l-3 7a3 3 0 006 0z"/></svg>',
};

const FALLBACK_CAPABILITIES = [
  { id: 'tools', label: 'Tools', blurb: 'Function calling & external API integration', tone: 'tool' },
  { id: 'reasoning', label: 'Reasoning', blurb: 'Deep thinking & chain-of-thought processing', tone: 'reasoning' },
  { id: 'structured', label: 'Structured', blurb: 'Strict JSON schema & grammar-constrained output', tone: 'structured' },
  { id: 'vision', label: 'Vision', blurb: 'Image & visual comprehension', tone: 'vision' },
  { id: 'imageGen', label: 'Image Gen', blurb: 'Native image creation & editing', tone: 'imagegen' },
  { id: 'audio', label: 'Audio', blurb: 'Voice input & speech understanding', tone: 'audio' },
  { id: 'video', label: 'Video', blurb: 'Video sequence processing', tone: 'video' },
  { id: 'files', label: 'Files', blurb: 'File & document upload support', tone: 'files' },
  { id: 'decision', label: 'Decision', blurb: 'Typed yes/no rating of a known state, never prose', tone: 'decision' },
];

let ptLegendOpen = false;
try {
  localStorage.removeItem('venom_pt_legend_open');
} catch (_) {}

function ptLegendHTML(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const caps = (typeof CAT_CAPABILITIES !== 'undefined' && Array.isArray(CAT_CAPABILITIES) && CAT_CAPABILITIES.length)
    ? CAT_CAPABILITIES
    : (typeof window !== 'undefined' && Array.isArray(window.CAT_CAPABILITIES) && window.CAT_CAPABILITIES.length)
    ? window.CAT_CAPABILITIES
    : FALLBACK_CAPABILITIES;
  const counts = (typeof capabilityCounts === 'function') ? capabilityCounts(list) : {};
  const total = list.length;
  for (const cap of caps) {
    if (counts[cap.id] == null) counts[cap.id] = 0;
  }
  const chevron = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>';
  const topCaps = [...caps]
    .sort((a, b) => ((counts[b.id] || 0) - (counts[a.id] || 0)) || (caps.indexOf(a) - caps.indexOf(b)))
    .slice(0, 4);
  const topIcons = `<span class="mc-legend-top-caps">${topCaps.map((cap) => {
    const n = counts[cap.id] || 0;
    const isYes = n > 0;
    return `<span class="mc-cap-ico mc-cap-${cap.tone} ${isYes ? 'is-yes' : 'is-unknown'}" title="${escapeHtml(cap.label)} (${n} model${n === 1 ? '' : 's'})">${CAP_ICONS_MAP[cap.id] || ''}</span>`;
  }).join('')}</span>`;
  const toggle = `<button class="pv-legend-toggle mc-legend-toggle" type="button" data-pt-legend-toggle
    aria-expanded="${ptLegendOpen}" aria-controls="pt-legend-body"
    title="${ptLegendOpen ? 'Hide the legend' : 'Show the legend'}">
    <span>${ptLegendOpen ? 'Hide legend' : 'Show legend'}</span>${chevron}</button>`;
  const body = `<div class="pv-legend-body mc-legend-body mc-legend-grid" id="pt-legend-body"${ptLegendOpen ? '' : ' hidden'}>
    ${caps.map((cap) => {
      const n = counts[cap.id] || 0;
      return `<div class="pv-legend-item mc-legend-tile mc-cap-${cap.tone} ${n ? '' : 'empty'}" style="--c:var(--cap)">
        <span class="pv-legend-chip mc-legend-ico mc-cap-${cap.tone}">${CAP_ICONS_MAP[cap.id] || ''}</span>
        <div class="pv-legend-text">
          <div class="pv-legend-name">
            <span class="mc-legend-label">${escapeHtml(cap.label)}</span>
            <span class="pv-legend-count mc-legend-count${n ? '' : ' is-zero'}" title="${escapeHtml(`${n} of the ${total} model${total === 1 ? '' : 's'} on screen`)}">${n} model${n === 1 ? '' : 's'}</span>
          </div>
          <div class="pv-legend-desc mc-legend-blurb">${escapeHtml(cap.blurb)}</div>
        </div>
      </div>`;
    }).join('')}
  </div>`;
  return `<section class="pv-legend mc-legend ${ptLegendOpen ? '' : 'collapsed'}" aria-label="Model capabilities legend">
    <div class="pv-legend-head mc-legend-head">
      <span class="pv-legend-title">${topIcons}Model Capabilities Legend</span>
      ${toggle}
    </div>
    ${body}
  </section>`;
}

function renderPtLegend() {
  const container = $('#pt-legend');
  if (!container) return;
  const p = PROVIDERS[activeProvider];
  const provModels = (p && p.models) || getProviderModels() || [];
  const rows = provModels.map((m) => capabilityRowFor(m));
  container.innerHTML = ptLegendHTML(rows);
}

function capsIconsHtml(model) {
  if (typeof CAT_CAPABILITIES === 'undefined' || typeof capabilityState !== 'function') return NA;
  const row = capabilityRowFor(model);
  // Only a supported capability draws: the cell shows what the model does, so
  // an unsupported or unstated one is the absence of an icon rather than a
  // dimmed mark. The published "no" is still said — in the row's tooltip and in
  // the Models page detail panel, the only places the refusal lives.
  const cells = CAT_CAPABILITIES.map((cap) => {
    if (capabilityState(row, cap.id) !== true) return '';
    const tip = `${cap.label} — ${cap.blurb.toLowerCase()}`;
    const icon = CAP_ICONS_MAP[cap.id] || '';
    return `<span class="mc-cap-ico mc-cap-${cap.tone} is-yes" title="${escapeHtml(tip)}" aria-label="${escapeHtml(cap.label)}">${icon}</span>`;
  }).join('');
  if (!cells) return NA;
  return `<span class="mc-caps">${cells}</span>`;
}

function buildRowHtml(model, result, rowIndex = null) {
  const isRunning = result.status === 'running' || result.status === 'queued';
  const isFailed = result.status === 'fail';
  const badge = statusIconBadge(result.status, result.isEmpty);
  const indexNum = rowIndex || 1;

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

  const typeIcons = [];
  if (model.kind === 'image') typeIcons.push(iconSpan('image', 'Image generator', 'type-media'));
  if (model.kind === 'video') typeIcons.push(iconSpan('video', 'Video generator', 'type-media'));
  if (model.kind === 'decision') typeIcons.push(iconSpan('decision', 'Decision model', 'type-media'));
  // Vision and reasoning read the merged row, not the provider's own booleans.
  // `readsVision` answers false both when a provider refused vision and when it
  // published nothing, and only one of those may be drawn — so an unstated
  // capability draws no icon instead of a mark saying the model cannot do it.
  const factsRow = factsFor(model);
  if (factsRow.vision === true) typeIcons.push(iconSpan('vision', 'Vision', 'type-vision'));
  if (factsRow.reasoning === true) typeIcons.push(iconSpan('think', 'Reasoning', 'type-think'));
  if (!model.noPlans) {
    typeIcons.push(
      model.isFree
        ? iconSpan('free', 'Free', 'tier-free')
        : iconSpan('free', 'Free for Paid', 'tier-freepaid')
    );
  }
  const typeHtml = typeIcons.length ? typeIcons.join('') : NA;

  const ctxValue = contextOf(model);
  const ctxLabel = ctxValue != null ? formatContext(ctxValue) : '';
  const contextHtml = ctxLabel ? `<span class="val-ctx">${ctxLabel}</span>` : NA;

  const score = scoreOf(model);
  const scoreSrc = scoreSourceOf(model);
  // The number only: the tier (aa/est/local/proxy) lives in the tooltip, not
  // beside the value — a tag next to every score doubles the column's noise.
  const scoreTitle = scoreSrc === 'aa' ? 'Artificial Analysis intelligence index, measured'
    : scoreSrc === 'est' ? 'Estimated from correlated public signals'
      : scoreSrc === 'local' ? 'Estimated locally from the facts this model declares — no reference measured it'
        : scoreSrc === 'proxy' ? 'Inherited from the base route' : '';
  const scoreHtml = score == null ? NA
    : `<span class="score-num"${scoreTitle ? ` title="${scoreTitle}"` : ''}>${score}</span>`;

  const cost = costOf(model);
  const priceHtml = (cost.in == null && cost.out == null) ? NA
    : `<span class="p-in">${cost.in == null ? '—' : `$${fmtPrice(cost.in)}`}</span>`
      + `<span class="p-sep">/</span>`
      + `<span class="p-out">${cost.out == null ? '—' : `$${fmtPrice(cost.out)}`}</span>`;

  const capsHtml = capsIconsHtml(model);
  // The input modalities sit in the model cell: what a model reads is part of
  // what it IS, so it belongs beside the name rather than in a column of its own.
  const inputHtml = inputIconsHtml(model);

  const provider = PROVIDERS[activeProvider];
  const pMark = provider ? providerMark(provider, 'cell-model-logo') : '';
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
  // The cell clips by width and the title carries the whole answer on hover;
  // long answers also open the full-response modal on click.
  const responseTitle = escapeHtml(full);

  const extraRounds = (result.attempts || 1) - 1;
  const retriesHtml =
    extraRounds > 0
      ? ` <span class="retry-count" title="Retried ${extraRounds} time${extraRounds === 1 ? '' : 's'}; the time shown is the last attempt">↻${extraRounds}</span>`
      : '';

  const canRetry = !isRunning;
  const actionsHtml = canRetry
    ? `<button class="row-retry-btn" data-model-id="${escapeHtml(model.id)}" title="Retry this model" aria-label="Retry ${escapeHtml(model.id)}">${ICONS.retry}</button>`
    : '';

  return `
    <td class="cell-index">
      <span class="cell-row-num">${indexNum}</span>
    </td>
    <td class="cell-model">
      <div class="cell-model-line">
        ${pMark}
        <div class="cell-model-block">
          <span class="cell-model-name" title="${escapeHtml(model.id)}">${escapeHtml(model.id)}</span>
          ${inputHtml}
          ${keyLine ? `<span class="cell-model-sub">${keyLine}</span>` : ''}
        </div>
      </div>
    </td>
    <td class="cell-type ${typeIcons.length ? '' : 'cell-na'}">${typeHtml}</td>
    <td class="cell-context ${ctxLabel ? '' : 'cell-na'}">${contextHtml}</td>
    <td class="cell-score ${score == null ? 'cell-na' : ''}">
      <span class="score-wrap">${scoreHtml}</span>
    </td>
    <td class="cell-price ${(cost.in == null && cost.out == null) ? 'cell-na' : ''}">
      <span class="price-wrap">${priceHtml}</span>
    </td>
    <td class="cell-caps ${capsHtml === NA ? 'cell-na' : ''}">${capsHtml}</td>
    <td class="cell-time ${timeClass}">
      <span class="time-val ${timeClass}">${timeStr}${retriesHtml}</span>
    </td>
    <td class="cell-status">${badge}</td>
    <td class="cell-response ${truncated ? 'response-expandable' : ''}" title="${responseTitle}">${responseHtml}</td>
    <td class="cell-actions">${actionsHtml}</td>
  `;
}

// Generation speed. Only completion tokens count — prompt tokens aren't
// generated, so including them inflates the rate on a long prompt. This is
// end-to-end (the elapsed time includes connection and queueing), so treat it as
// a comparison between models on equal terms, not a raw decode rate.
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
  const total = runTotal ?? getSelectedModels().length;
  const passed = testResults.filter((r) => r.status === 'pass').length;
  const failed = testResults.filter((r) => r.status === 'fail').length;

  // Average latency measures speed, so only completed calls count. A 502 comes
  // back in ~0.3s and would otherwise drag the average down and make the
  // provider look faster than it actually is. A generator's time is seconds of
  // generation, not latency — the same rule the health writer applies — so it
  // sits this column out too.
  const times = testResults
    .filter((r) => r.status === 'pass' && r.time && !isMedia(modelById(r.model)))
    .map((r) => r.time);
  const avg = times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : null;

  // An empty 200 is recorded as a pass (the call succeeded), but "46 passed"
  // with thirty of them answering nothing reads as healthier than it is. The
  // count sits on the card so the number and the caveat arrive together.
  const emptyPasses = testResults.filter((r) => r.status === 'pass' && r.isEmpty).length;

  const fetched = getProviderModels().length;
  const finished = passed + failed;
  $('#pt-kpis').innerHTML = statCardsHTML([
    { label: 'Models', value: total, sub: fetched ? `/ ${fetched}` : '', icon: KPI_ICON.layers, tone: 'blue', subhead: 'SELECTED FOR RUN',
      meter: fetched ? total / fetched : 0,
      foot: fetched === 0 ? 'fetch models to begin' : runTotal != null ? 'in this run' : 'selected for the next run' },
    { label: 'Passed', value: passed, sub: finished ? `/ ${finished}` : '', icon: KPI_ICON.check, tone: 'pass', subhead: 'SUCCESSFUL CALLS',
      pill: finished ? `${Math.round((passed / finished) * 100)}% of finished` : undefined,
      meter: total ? passed / total : 0,
      foot: emptyPasses
        ? `${emptyPasses} returned no content`
        : finished ? `${Math.round((passed / finished) * 100)}% of finished models` : 'no results yet' },
    { label: 'Failed', value: failed, sub: finished ? `/ ${finished}` : '', icon: KPI_ICON.cross, tone: 'fail', subhead: 'UNSUCCESSFUL CALLS',
      pill: failed ? `${failed} Failed` : '0 Failed',
      meter: total ? failed / total : 0,
      attrs: failed || resultsTable.isFailedFilterActive() ? `data-filter-failed role="button" tabindex="0" aria-pressed="${resultsTable.isFailedFilterActive()}" title="Show only failed / empty responses"` : '',
      active: resultsTable.isFailedFilterActive(),
      foot: resultsTable.isFailedFilterActive() ? 'showing only failures — click to show all' : failed ? 'click to show only failures' : 'none failed' },
    { label: 'Average time', value: avg == null ? NA : avg < 1000 ? `${Math.round(avg)} ms` : `${(avg / 1000).toFixed(1)}s`, icon: KPI_ICON.clock,
      tone: 'cyan', subhead: 'RESPONSE LATENCY', foot: 'passed calls only' },
  ]);


  renderPtLegend();

  const retryBtn = $('#btn-retry-failed');
  if (retryBtn) retryBtn.disabled = isTesting || retryableModels().length === 0;
}

function showProgress(current, total) {
  $('#progress-container').style.display = '';
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  $('#progress-fill').style.width = `${pct}%`;
  $('#progress-count').textContent = `${current}/${total}`;
  const isDone = current === total;
  $('#progress-label').textContent = isDone ? 'Complete' : `Testing ${current}/${total}...`;

  // Live pass / fail mini-counters
  const passed = testResults.filter((r) => r.status === 'pass').length;
  const failed = testResults.filter((r) => r.status === 'fail').length;
  $('#progress-pass-count').textContent = passed;
  $('#progress-fail-count').textContent = failed;

  // Elapsed time
  const elapsed = runStartTime ? Math.round((Date.now() - runStartTime) / 1000) : 0;
  const mm = Math.floor(elapsed / 60);
  const ss = elapsed % 60;
  $('#progress-elapsed').textContent = elapsed > 0
    ? mm > 0 ? `${mm}m ${ss}s` : `${ss}s`
    : '';
}

function hideProgress() {
  setTimeout(() => { if (!isTesting) $('#progress-container').style.display = 'none'; }, 2000);
}

// Shared download helpers — results CSV/JSON uses the results unit; history
// export and any other one-shot save go through these.
function exportFilename(ext) {
  return resultsTable.exportFilename(ext);
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
const updates = window.VENOM_RENDERER.updates.create({ setStatus });
const { setupUpdateListeners } = updates;

// ============================================
// Add Key modal
// ============================================
// Set while the modal is an Integrated card's Connect: the key is checked with
// the provider before it is saved, and a working key moves the provider to the
// Connected tab.
let connectingProvider = null;

function openAddKeyModal(title = 'Add API Key', connectPid = null) {
  connectingProvider = connectPid;
  $('#add-key-title').textContent = title;
  const add = $('#modal-add');
  add.disabled = false;
  add.textContent = connectPid ? 'Connect' : 'Add Key';
  setKeyVerify(null);
  $('#add-key-modal').style.display = 'flex';
  setTimeout(() => $('#key-name-input').focus(), 100);
}

$('#btn-add-key').addEventListener('click', () => openAddKeyModal());

function closeAddKeyModal() {
  connectingProvider = null;
  $('#add-key-modal').style.display = 'none';
  $('#key-name-input').value = '';
  $('#key-value-input').value = '';
}

// state: null (hidden), 'fail' (the key was refused) or 'unverified' (the
// provider could not be reached, so the key can still be saved unchecked).
function setKeyVerify(state, text = '') {
  const el = $('#key-verify');
  el.hidden = !state;
  el.dataset.state = state || '';
  el.textContent = text;
  $('#modal-save-anyway').hidden = state !== 'unverified';
}

async function connectWithKey({ unverified = false } = {}) {
  const pid = connectingProvider;
  const p = PROVIDERS[pid];
  const name = $('#key-name-input').value.trim();
  const key = $('#key-value-input').value.trim();
  if (!key) {
    setKeyVerify('fail', 'Enter an API key.');
    return;
  }

  let res = null;
  if (!unverified) {
    const add = $('#modal-add');
    add.disabled = true;
    add.innerHTML = '<span class="spinner"></span> Checking key…';
    setKeyVerify(null);
    res = await probeKey(p, key);
    add.disabled = false;
    add.textContent = 'Connect';
    // Closed while the check ran: the user backed out, so nothing is saved.
    if (connectingProvider !== pid) return;
    if (!isHealthyResponse(res)) {
      if (res.status === 401 || res.status === 403) {
        setKeyVerify('fail', `${p.name} rejected this key (HTTP ${res.status}). Check it and try again.`);
      } else {
        setKeyVerify('unverified', `Could not verify the key — ${describeHealthFailure(res)}. ${p.name} may be down; you can save the key anyway.`);
      }
      return;
    }
  }

  const { k, saved } = await storeKey(pid, name, key);
  if (res) keyProbe.set(k.id, keyProbeResult(res));
  closeAddKeyModal();
  // A failed save already left its error in the status bar (persist()); a
  // "done" here would overwrite it and hide that the key wasn't saved.
  if (saved) setStatus('done', `${p.name} connected`);
  // Connected now: the provider is shown there, with its keys open.
  providerRoster.connectProvider(pid);
  pvExpanded.add(pid);
  refreshAfterKeyChange(pid);
  // New key: prove this provider at once with one unified pass.
  if (window.CATALOG) window.CATALOG.syncAll({ reason: 'manual', providerId: pid });
  if (window.KEY_USAGE) KEY_USAGE.refresh(pid, k.id, { force: true });
}

$('#modal-cancel').addEventListener('click', closeAddKeyModal);
$('#modal-cancel-btn').addEventListener('click', closeAddKeyModal);

$('#modal-add').addEventListener('click', () => {
  if (connectingProvider) {
    connectWithKey();
    return;
  }
  addKey();
  $('#add-key-modal').style.display = 'none';
});

$('#modal-save-anyway').addEventListener('click', () => connectWithKey({ unverified: true }));

// A new key is a new attempt; the last one's verdict no longer applies.
$('#key-value-input').addEventListener('input', () => setKeyVerify(null));

$('#add-key-modal').addEventListener('click', (e) => {
  if (e.target.id === 'add-key-modal') {
    connectingProvider = null;
    $('#add-key-modal').style.display = 'none';
  }
});

// ============================================
// Edit Provider modal
// ============================================
// Providers are integrated (built in): they can be renamed, pointed at another
// base URL or given a rate limit, never added or removed.
let editingProviderId = null;

function openProviderModal(id) {
  const p = PROVIDERS[id];
  if (!p) return;
  editingProviderId = id;
  $('#provider-name-input').value = p.name;
  $('#provider-url-input').value = p.baseUrl;
  $('#provider-rpm-input').value = p.rpm ?? '';
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
  const saved = await saveProviderConfig(id);
  renderProviderHead();
  // A failed save already left its error in the status bar (persist()); a
  // "done" here would overwrite it, and the caller keeps the modal open
  // (below) instead of hiding the failure behind a closed dialog.
  if (saved) setStatus('done', `Provider "${name}" updated`);
  return saved;
}

function closeAddProviderModal() {
  $('#add-provider-modal').style.display = 'none';
  $('#provider-name-input').value = '';
  $('#provider-url-input').value = '';
  $('#provider-rpm-input').value = '';
  editingProviderId = null;
}

$('#provider-modal-close').addEventListener('click', closeAddProviderModal);
$('#provider-modal-cancel').addEventListener('click', closeAddProviderModal);
$('#provider-modal-add').addEventListener('click', async () => {
  const rpmRaw = $('#provider-rpm-input').value.trim();
  const payload = {
    name: $('#provider-name-input').value,
    baseUrl: $('#provider-url-input').value,
    rpm: rpmRaw === '' ? null : Number(rpmRaw),
  };
  if (editingProviderId && await updateProvider(editingProviderId, payload)) closeAddProviderModal();
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
// Settings panel state is composed from the production factory below.
let settingsPanel = null;
let fillSettingsForm = () => {};
let bindSettingsForm = () => {};
let renderCostEstimate = () => {};
let prepareSettingsPage = () => {};
let openSettings = () => {};

function renderDecisionThreshold() {
  $('#decision-threshold-value').textContent = settings.decisionThreshold.toFixed(2);
}


// The Test section holds one probe per model kind; only the chosen kind's
// fields are shown, so the page stays as short as the chat-only one was.
$('#match-mode-seg')?.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (!b) return;
  settings.matchMode = b.dataset.mode;
  syncMatchMode();
  queueSettingsSave();
  updateExpectedChips();
});

$('#test-kind-seg').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-kind]');
  if (!btn) return;
  $$('#test-kind-seg button').forEach((b) => {
    const on = b === btn;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  $$('#sec-test .test-pane').forEach((pane) => { pane.hidden = pane.dataset.kind !== btn.dataset.kind; });
  syncTestRouteCard(btn.dataset.kind);
});


// Swatches for both the Appearance page and the header popover.
settingsPanel = window.VENOM_RENDERER.settingsPanel.create({
  getSettings: () => settings, queueSettingsSave, applyAppearance,
  hasResultRows: () => !!(resultsTable && resultsTable.hasRows()),
  renderResultsTable: () => { if (resultsTable) resultsTable.render(); },
  getSelectedModels: () => getSelectedModels(),
  getAutoTestMinutes: () => autoTestMinutes,
  getTestPrompt: () => testPrompt, getExpectedAnswer: () => expectedAnswer,
  renderDecisionThreshold, updatePromptStats, updateExpectedChips,
  syncPromptPresetPills, syncTokenPresets, showPage, syncRoute,
  getCurrentPage: () => getCurrentPage(), breadcrumbHTML, renderAppearancePickers,
  refreshLogInfo, renderAbout, renderSecuritySection,
  fillCatalogSettings: () => { if (window.CATALOG) window.CATALOG.fillSettings(); },
  renderCatalogSources, onCatalogRepaint: () => {
    if (window.CATALOG && window.CATALOG.renderIfShown) window.CATALOG.renderIfShown();
  },
});
({ fillSettingsForm, bindSettingsForm, renderCostEstimate, prepareSettingsPage, openSettings } = settingsPanel);

const SECTION_RESETTERS = {
  'sec-appearance': () => {
    appearance.reset();
  },
  'sec-test': () => {
    ['verifyAssets', 'decisionState', 'decisionQuestion', 'decisionThreshold', 'deadlineDecisionMs', 'maxOutputTokens', 'matchMode'].forEach((k) => {
      settings[k] = DEFAULT_SETTINGS[k];
    });
    testPrompt = DEFAULT_TEST_PROMPT;
    expectedAnswer = DEFAULT_EXPECTED;
    $('#prompt-input').value = testPrompt;
    $('#expected-input').value = expectedAnswer;
    clearTimeout(saveTestTimer);
    saveTestDefinition();
    renderDecisionThreshold();
    updatePromptStats();
    updateExpectedChips();
    syncPromptPresetPills();
    syncTokenPresets();
  },
  'sec-schedule': () => {
    ['scheduleSkipMedia', 'liveUpdates', 'notifyRegression', 'notifyRunComplete'].forEach((k) => {
      settings[k] = DEFAULT_SETTINGS[k];
    });
    autoTestMinutes = 0;
    $('#auto-test-select').value = '0';
    applyAutoTestSchedule();
    saveTestDefinition();
    renderLiveToggles();
  },
  'sec-speed': () => {
    ['timeGoodMs', 'timeOkMs', 'deadlineChatMs', 'deadlineImageMs', 'deadlineVideoMs', 'perModelBudgetMs', 'concurrency'].forEach((k) => {
      settings[k] = DEFAULT_SETTINGS[k];
    });
  },
  'sec-reliability': () => {
    ['hedgeEnabled', 'hedgeMax', 'hedgeStepMs', 'maxTestRetries', 'maxRateLimitWaits'].forEach((k) => {
      settings[k] = DEFAULT_SETTINGS[k];
    });
  },
  'sec-catalog': () => {
    ['catalogSyncMinutes', 'purgeWindowDays'].forEach((k) => {
      settings[k] = DEFAULT_SETTINGS[k];
    });
    if (window.CATALOG && window.CATALOG.fillSettings) window.CATALOG.fillSettings();
  },
  'sec-history': () => {
    ['historyMaxRuns', 'sparkRuns'].forEach((k) => {
      settings[k] = DEFAULT_SETTINGS[k];
    });
  },
  'sec-logs': () => {
    ['logLevel', 'logRetentionDays', 'bodyRetentionDays', 'statsRetentionMonths'].forEach((k) => {
      settings[k] = DEFAULT_SETTINGS[k];
    });
  },
  'sec-security': () => {
    settings.lockIdleMin = DEFAULT_SETTINGS.lockIdleMin;
    renderSecuritySection();
  },
  'sec-data': () => {
    settings = { ...DEFAULT_SETTINGS, openRouterApiKey: settings.openRouterApiKey };
    applyAppearance();
    renderAppearancePickers();
    if (window.CATALOG && window.CATALOG.scheduleTimer) window.CATALOG.scheduleTimer();
    renderLiveToggles();
  },
};

$('#btn-reset-appearance').addEventListener('click', () => {
  const activeBtn = $('#settings-nav .settings-nav-item.active');
  const targetId = activeBtn?.dataset?.section || 'sec-appearance';
  const resetter = SECTION_RESETTERS[targetId] || SECTION_RESETTERS['sec-appearance'];
  resetter();
  queueSettingsSave();
  fillSettingsForm();
  renderCostEstimate();
  if (resultsTable.hasRows()) resultsTable.render();
  const meta = SETTINGS_SECTIONS_META[targetId];
  setStatus('done', targetId === 'sec-test' ? 'Test prompt and expected answer restored to defaults' : targetId === 'sec-appearance' ? 'Appearance preferences restored to defaults' : `${meta ? meta.label : 'Settings'} reset to defaults`);
});


appearance.bindControls();

const openProfilePage = () => {
  const pop = document.getElementById('profile-pop');
  if (pop) pop.hidden = true;
  const btn = document.getElementById('btn-profile');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  showPage('profile');
};
['#profile-open-page-btn', '#profile-pop-card-btn', '#profile-view-security'].forEach((sel) => {
  const el = document.querySelector(sel);
  if (el) el.addEventListener('click', openProfilePage);
});
$('#btn-profile-page-lock')?.addEventListener('click', async () => {
  try {
    await window.electronAPI.authLock();
  } catch (err) {
    console.error('Could not lock the app:', err);
  }
  if (window.LOCK) window.LOCK.show('locked');
});
$('#btn-profile-page-signout')?.addEventListener('click', async () => {
  try {
    await window.electronAPI.authLock();
  } catch (err) {
    console.error('Could not lock the app:', err);
  }
  if (window.LOCK) window.LOCK.show('locked');
});
async function refreshLogInfo() {
  try {
    const info = await window.electronAPI.readLogInfo();
    const kb = info.size > 0 ? ` — ${(info.size / 1024).toFixed(0)} KB` : ' — empty';
    $('#log-path').textContent = info.path + kb;
  } catch (_) {}
}

function renderAbout() {
  $('#about-version').textContent = appVersion || '2.1.2';

  // 1. Providers KPI
  const provList = Object.values(PROVIDERS);
  const connectedCount = provList.filter((p) => p.keys && p.keys.length > 0).length;
  const provEl = $('#about-kpi-providers');
  if (provEl) provEl.textContent = `${connectedCount} / ${provList.length}`;

  // 2. Models tracked in Catalog KPI
  const modelsCount = window.CATALOG && window.CATALOG.visibleEntries
    ? window.CATALOG.visibleEntries().length
    : (provList.reduce((sum, p) => sum + (p.models || []).length, 0) || history.size || 0);
  const modelsEl = $('#about-kpi-models');
  if (modelsEl) modelsEl.textContent = String(modelsCount);

  // 3. Runs / Benchmarks recorded KPI
  const runs = [...history.values()].reduce((a, h) => a + h.length, 0);
  const runsEl = $('#about-kpi-runs');
  if (runsEl) runsEl.textContent = String(runs);

  // 4. Last catalog sync KPI
  const lastSyncEl = $('#about-kpi-synced');
  if (lastSyncEl) {
    let lastSync = 0;
    if (window.CATALOG && window.CATALOG.lastSyncAt) {
      lastSync = window.CATALOG.lastSyncAt();
    }
    if (!lastSync) {
      history.forEach((h) => {
        const at = h.length ? h[h.length - 1].at : 0;
        if (at > lastSync) lastSync = at;
      });
    }
    lastSyncEl.textContent = lastSync ? formatAgo(lastSync) : 'Never';
  }

  // Backward compatibility with legacy DOM placeholders if present
  const oldProv = $('#about-providers');
  if (oldProv) {
    oldProv.innerHTML = provList
      .map((p) => {
        const n = (p.models || []).length;
        return `<div class="about-provider"><span class="about-provider-name">${escapeHtml(p.name)}</span><span class="about-provider-meta">${n ? `${n} models` : 'not fetched'}</span></div>`;
      })
      .join('');
  }
  const oldStats = $('#about-stats');
  if (oldStats) {
    oldStats.innerHTML =
      `<div class="about-provider"><span class="about-provider-name">Models tracked</span><span class="about-provider-meta">${history.size}</span></div>` +
      `<div class="about-provider"><span class="about-provider-name">Results recorded</span><span class="about-provider-meta">${runs}</span></div>`;
  }
}

$('#btn-open-log').addEventListener('click', () => window.electronAPI.openRequestLog());
$('#btn-clear-log').addEventListener('click', async () => {
  await window.electronAPI.clearRequestLog();
  refreshLogInfo();
});
$('#btn-check-updates').addEventListener('click', () => {
  if (window.electronAPI?.updateAPI?.checkForUpdates) {
    window.electronAPI.updateAPI.checkForUpdates();
    $('#about-update-note').textContent = 'Contacting release channel…';
  } else {
    $('#about-update-note').textContent = 'Updater not available in development mode.';
    setTimeout(() => { $('#about-update-note').textContent = ''; }, 4000);
  }
});

// External link buttons on the About page
$$('#sec-about .about-link-pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    const url = btn.dataset.site;
    if (url && window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(url);
    }
  });
});

// Jump buttons on About KPI cards
$$('#sec-about .about-kpi-card[data-go]').forEach((card) => {
  card.addEventListener('click', () => {
    const page = card.dataset.go;
    if (page) showPage(page);
  });
});

// Settings is a page in the shell. Its form is refilled on every visit so it
// reflects changes made elsewhere (theme toggles, a history clear, the log file).
const SETTINGS_SECTIONS_META = {
  'sec-appearance': { label: 'Appearance', desc: 'Theme, accent colour and how dense the results table is' },
  'sec-test': { label: 'Test & Prompts', desc: 'The prompt and the pass rule for each kind of model' },
  'sec-schedule': { label: 'Schedule', desc: 'Automatic re-tests, health checks and alerts' },
  'sec-speed': { label: 'Speed & Timeouts', desc: 'Latency colours, and how long a model may take' },
  'sec-reliability': { label: 'Reliability', desc: 'Hedging, models tested at once, and retries' },
  'sec-catalog': { label: 'Models Catalog', desc: 'How the model pool syncs, and the sources its facts are scored against' },
  'sec-history': { label: 'History', desc: 'How many runs are kept, and exporting them' },
  'sec-logs': { label: 'Diagnostics & Logs', desc: 'What is logged about each request, and where' },
  'sec-security': { label: 'Security', desc: 'The owner password, and how long an idle session stays open' },
  'sec-data': { label: 'Data Directory', desc: 'Where your settings, keys and history are stored' },
  'sec-about': { label: 'About VENOM Router', desc: 'Version, providers and updates' }
};

function renderSettingsCrumbs(activeSectionLabel) {
  const el = $('#settings-crumbs');
  if (!el) return;
  el.innerHTML = breadcrumbHTML([
    { label: 'Overview', page: 'overview' },
    { label: 'Settings', page: 'settings' },
    { label: activeSectionLabel || 'Appearance' }
  ]);
}

// Settings › Catalog: the four upstream documents, one line each.
//
// The engine in main owns these; the page only reads its state and offers the one
// action that exists. `catalogSources({})` is report-only — four lines drawn from
// what is already on disk — so opening this section fetches nothing, and the first
// byte of upstream traffic is the owner pressing Sync sources. The key never
// travels: main answers `keyedAuthConfigured`, and the page says "key set" or
// "no OpenRouter key". Nothing here is a secret, a URL or a decrypted value.
const CATALOG_SOURCES_LABELS = {
  'models-dev-spec': 'models.dev', 'openrouter-public': 'OpenRouter models',
  'openrouter-keyed': 'OpenRouter benchmarks', lmarena: 'LMArena',
};

// Whatever the channel answered, said back to the owner.
//
// Two shapes arrive from `catalogSources`: main's resolved `{ ok: false, code,
// message }` — the contract, since a rejection loses its code on the way across
// `ipcMain.handle` — and a rejection from something that genuinely should not
// happen. A rejection's message is wrapped by Electron in
// `Error invoking remote method 'catalog:sources': Error: …`, which is about the
// plumbing, not about the app, so the wrapper is stripped before a person reads it
// — by `ipcMessage`, the helper the status bar has used for that since it existed
// (app.js:398), not by a second copy of it.
//
// A code's own words. SYNC_IN_PROGRESS is not a failure the owner caused: the four
// documents are already in flight from the other click, and saying so is the
// difference between "a sync is running" and a button that appears to do nothing.
const CATALOG_SOURCE_CODES = {
  SYNC_IN_PROGRESS: 'A sync is already running — the four sources are being fetched.',
  NOT_FOUND: 'The catalog could not find something it needed.',
};

function catalogSourceFailure(reply, err) {
  if (reply && reply.ok === false) {
    return CATALOG_SOURCE_CODES[reply.code] || `Sync failed (${reply.code || 'error'}): ${reply.message || 'no reason given'}`;
  }
  return `Sync failed: ${ipcMessage(err)}`;
}

// `notice` is the failure above, and it goes INSIDE the block: the redraw happens
// after a sync attempt, so a message written first would be painted over, and a
// message only in the console is the bug this exists to fix.
async function renderCatalogSources(notice) {
  const el = document.getElementById('catalog-sources-status');
  if (!el) return;
  const banner = notice
    ? `<div class="mc-sources-error" role="alert">${escapeHtml(notice)}</div>` : '';
  try {
    const s = await window.electronAPI.catalogSources({});
    if (s && s.ok === false) {
      el.innerHTML = banner + `<div class="mc-sources-error" role="alert">${escapeHtml(catalogSourceFailure(s, null))}</div>`;
      return;
    }
    // The two numbers are interpolated, not escaped — escapeHtml() is for strings.
    // Numbered anyway, so a shape that stops being a count cannot become markup.
    el.innerHTML = banner
      + `<div class="mc-sources-head">${Number(s.catalogCount) || 0} models in the reference · `
      + `${s.keyedAuthConfigured ? 'key set' : 'no OpenRouter key'}</div>`
      + (s.sources || []).map((row) => {
        const tone = row.error ? (row.stale ? 'warn' : 'fail') : 'ok';
        const when = row.fetchedAt ? new Date(row.fetchedAt).toLocaleString() : 'never';
        return `<div class="mc-source mc-source-${tone}" title="${escapeHtml(row.description || '')}">`
          + `<span>${escapeHtml(CATALOG_SOURCES_LABELS[row.id] || row.id)}</span>`
          + `<b>${Number(row.rowCount) || 0}</b><span>${escapeHtml(when)}</span>`
          + (row.error ? `<span class="mc-source-error">${escapeHtml(row.error)}</span>` : '')
          + '</div>';
      }).join('');
  } catch (err) {
    el.innerHTML = banner
      + `<div class="mc-sources-error" role="alert">${escapeHtml(`Sources unavailable: ${ipcMessage(err)}`)}</div>`;
  }
}

const syncSources = document.getElementById('btn-catalog-sync-sources');
if (syncSources) syncSources.addEventListener('click', async () => {
  syncSources.disabled = true;
  // A try/finally with no catch used to sit here: a rejected sync became an
  // unhandled rejection, the button re-enabled itself and the block redrew
  // unchanged — the owner's one control on this plane failing quietly. The failure
  // is caught, kept as words, and handed to the redraw that follows.
  let notice = null;
  try {
    const reply = await window.electronAPI.catalogSources({ force: true });
    if (reply && reply.ok === false) notice = catalogSourceFailure(reply, null);
  } catch (err) {
    notice = catalogSourceFailure(null, err);
  } finally {
    syncSources.disabled = false;
  }
  await renderCatalogSources(notice);
});

function switchSettingsSection(sectionId) {
  return settingsPanel ? settingsPanel.switchSection(sectionId) : undefined;
}

$('#btn-settings').addEventListener('click', openSettings);

// ============================================
// Security — the app lock from inside the app
// ============================================
// Three things the owner can do here, and the warning that says the shipped
// password is still in force. Main owns all of it; this section asks for status
// and shows what comes back.
let lockStatus = { locked: false, isDefault: true, idleMs: 0 };

function setChangeStatus(text, kind) {
  const el = $('#lock-change-status');
  if (!el) return;
  el.textContent = text || '';
  el.dataset.kind = kind || '';
}

async function refreshLockStatus() {
  try {
    const reply = await window.electronAPI.authStatus();
    if (reply && reply.ok) lockStatus = reply;
  } catch (err) {
    console.error('Could not read the app lock status:', err);
  }
  return lockStatus;
}

function renderSecuritySection() {
  const label = $('#lock-status-label');
  if (label) {
    label.textContent = lockStatus.locked
      ? 'locked'
      : lockStatus.isDefault ? 'open · shipped password' : 'open · password changed';
  }
  const warn = $('#lock-default-warning');
  if (warn) warn.hidden = !lockStatus.isDefault;
  const metaLock = $('#profile-meta-lock-status');
  if (metaLock) {
    metaLock.textContent = lockStatus.isDefault ? 'Shipped PIN' : 'Master PIN Active';
  }
  const kpiStatus = $('#profile-kpi-status');
  if (kpiStatus) {
    kpiStatus.textContent = lockStatus.locked ? 'Locked' : 'Active';
  }
  const idleInput = $('#set-lock-idle');
  if (idleInput && settings.lockIdleMin !== undefined) {
    idleInput.value = settings.lockIdleMin;
  }
  const idleKpi = $('#profile-kpi-idle');
  if (idleKpi && idleInput) {
    idleKpi.textContent = `${idleInput.value || settings.lockIdleMin || 60} min`;
  }
}

function renderProfileCrumbs() {
  const el = $('#profile-crumbs');
  if (!el) return;
  el.innerHTML = breadcrumbHTML([
    { label: 'Overview', page: 'overview' },
    { label: 'Profile & Security', icon: 'profile' }
  ]);
}

function renderProfilePage() {
  const idleInput = $('#set-lock-idle');
  if (idleInput && settings.lockIdleMin !== undefined) {
    idleInput.value = settings.lockIdleMin;
  }
  renderProfileCrumbs();
  primeLockStatus();
  const idleKpi = $('#profile-kpi-idle');
  if (idleKpi && idleInput) {
    idleKpi.textContent = `${idleInput.value || settings.lockIdleMin || 60} min`;
  }
}

// Read once at startup so the warning is right the first time Settings opens,
// and again on every visit (switchSettingsSection) in case it changed.
async function primeLockStatus() {
  await refreshLockStatus();
  renderSecuritySection();
}

$('#btn-lock-now-settings')?.addEventListener('click', async () => {
  try {
    await window.electronAPI.authLock();
  } catch (err) {
    console.error('Could not lock the app:', err);
  }
  if (window.LOCK) window.LOCK.show('locked');
});

$('#btn-lock-change')?.addEventListener('click', async () => {
  const current = $('#set-lock-current').value;
  const next = $('#set-lock-new').value;
  const confirm = $('#set-lock-confirm').value;
  if (!current || !next) {
    setChangeStatus('Fill in the current and the new password.', 'error');
    return;
  }
  // Caught here rather than in main: a mistyped confirmation is a typo, not a
  // rejected password, and main has no business knowing the field exists.
  if (next !== confirm) {
    setChangeStatus('The two new passwords do not match.', 'error');
    return;
  }
  const button = $('#btn-lock-change');
  button.disabled = true;
  setChangeStatus('Changing…', '');
  let reply;
  try {
    reply = await window.electronAPI.authChange(current, next);
  } catch (err) {
    button.disabled = false;
    setChangeStatus(`Could not change the password: ${err.message}`, 'error');
    return;
  }
  button.disabled = false;
  if (reply && reply.ok) {
    ['#set-lock-current', '#set-lock-new', '#set-lock-confirm'].forEach((sel) => { $(sel).value = ''; });
    setChangeStatus('Password changed.', 'ok');
    await refreshLockStatus();
    renderSecuritySection();
    return;
  }
  const code = reply && reply.code;
  if (code === 'THROTTLED') setChangeStatus(reply.message, 'warn');
  else if (code === 'WRONG_PASSWORD') setChangeStatus('The current password is not right.', 'error');
  else if (code === 'WEAK_PASSWORD') setChangeStatus(reply.message, 'error');
  else setChangeStatus((reply && reply.message) || 'Could not change the password.', 'error');
});

$('.page-settings').addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go && go.dataset.go) {
    showPage(go.dataset.go);
    return;
  }
});

$('.page-profile')?.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go && go.dataset.go) {
    showPage(go.dataset.go);
    return;
  }
});

$('#settings-nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.settings-nav-item');
  if (!btn) return;
  switchSettingsSection(btn.dataset.section);
});

$('.page-settings').addEventListener('wheel', (e) => {
  if (e.target.closest('.settings-categories-panel')) return;
  const body = document.querySelector('.settings-main-panel .settings-panel-body');
  if (body && !e.target.closest('.settings-panel-body')) {
    body.scrollTop += e.deltaY;
  }
}, { passive: true });

$('#btn-export-history').addEventListener('click', async () => {
  const data = await window.electronAPI.readHistory();
  downloadFile(JSON.stringify(data, null, 2), exportFilename('history.json'), 'application/json');
});

$('#btn-clear-history').addEventListener('click', async () => {
  const cleared = await persist('clear the run history', () => window.electronAPI.clearHistory());
  if (!cleared) return;
  try {
    await loadHistory();
  } catch (err) {
    setStatus('error', `Couldn't reload the run history: ${ipcMessage(err)}`);
    return;
  }
  if (resultsTable.hasRows()) resultsTable.render();
  setStatus('done', 'History cleared');
});

$('#btn-open-data').addEventListener('click', () => window.electronAPI.openDataFolder());

$('#btn-reset-settings').addEventListener('click', () => {
  // The OpenRouter key is a saved secret, not a setting: a reset keeps it.
  settings = { ...DEFAULT_SETTINGS, openRouterApiKey: settings.openRouterApiKey };
  applyAppearance();
  queueSettingsSave();
  fillSettingsForm();
  renderAppearancePickers();
  // Reset restores the defaults (live updates on): restart the unified cycle.
  if (window.CATALOG && window.CATALOG.scheduleTimer) window.CATALOG.scheduleTimer();
  renderLiveToggles();
  if (resultsTable.hasRows()) resultsTable.render();
  setStatus('done', 'Settings reset to defaults');
});


// App shell. Bound before init() so the nav responds while providers and
// history are still loading.
const pageRouter = window.VENOM_RENDERER.pageRouter.create({
  location, history: window.history, $: (selector) => $(selector),
  getProviders: () => PROVIDERS, getActiveProvider: () => activeProvider,
  showPage: (page) => showPage(page), openProviderPage: (id) => openProviderPage(id),
  switchSettingsSection: (section) => switchSettingsSection(section), logs: window.LOGS,
});
const PAGES = pageRouter.pages;
const getCurrentPage = () => pageRouter.getCurrentPage();
const applyRoute = () => pageRouter.applyRoute();
let shellController;

function syncRoute() { return pageRouter.syncRoute(); }

const PAGE_META = {
  overview: { title: 'Overview', desc: 'Routing health — providers, models and test activity at a glance.' },
  providers: { title: 'Providers', desc: 'Connect providers and manage their keys and accounts.' },
  catalog: { title: 'Models Catalog', desc: 'Every model your connected providers offer — the pool the router draws from, scored and ranked.' },
  activity: { title: 'Model Activity', desc: 'Every model arrival and departure across connected providers, newest first.' },
  database: { title: 'Database', desc: 'Read-only explorer for the local app and request databases.' },
  history: { title: 'Test History', desc: 'Every request this app has sent, and the runs they belong to.' },
  monitor: { title: 'Monitoring', desc: 'Requests, errors, latency and cost over time.' },
  router: { title: 'Venom Profiles', desc: 'Policy cards, per-profile dossiers and eligible targets for venom-lite, venom-pro and venom-max.' },
  profile: { title: 'Profile & Security', desc: 'Workspace administrator identity, session security and access controls.' },
  settings: { title: 'Settings', desc: 'Test prompt, scheduling, appearance and data.' },
};

function renderPageHeader(page) { return shellController.renderPageHeader(page); }
function showPage(page) { return shellController.showPage(page); }
function bindShell() { return shellController.bindShell(); }
function renderQuickStats() { return shellController.renderQuickStats(); }
function scoreClass(rate) { return shellController.scoreClass(rate); }
function formatAgo(ts) { return shellController.formatAgo(ts); }
function renderSystemLamp() { return shellController.renderSystemLamp(); }

// ============================================
// Breadcrumb — shared helper
// ============================================
// items: [{ label, page?, tab?, icon? }] — the last item is the current page.
// A crumb that stands for a page (`page`, or `icon` naming one) carries that
// page's own sidebar icon, cloned from the nav, so the two never drift apart.
// The trail starts at Overview, the app's first page.
function crumbIconHTML(page) {
  const svg = document.querySelector(`.shell-nav-item[data-page="${page}"] .shell-nav-icon`);
  if (!svg) return '';
  const icon = svg.cloneNode(true);
  icon.setAttribute('width', '13');
  icon.setAttribute('height', '13');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('class', 'crumb-icon');
  return icon.outerHTML;
}

function breadcrumbHTML(items) {
  const sep = '<svg class="crumb-sep" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>';
  return items.map((it, i) => {
    const last = i === items.length - 1;
    const iconPage = it.icon || it.page;
    const inner = (it.iconHTML || (iconPage ? crumbIconHTML(iconPage) : '')) + escapeHtml(it.label);
    if (last) return `<span class="crumb" aria-current="page">${inner}</span>`;
    const attrs = it.page ? `data-go="${it.page}"` : it.tab ? `data-tab="${it.tab}"` : '';
    return `<button class="crumb" type="button" ${attrs}>${inner}</button>${sep}`;
  }).join('');
}

// ============================================
// Providers page
// ============================================
// Connected = has at least one key. Integrated = every provider the app knows.

const PV_ICON = {
  // The copy mark and the tick that replaces it are both rendered into the
  // button; .copied swaps which one is shown (see .pv-icon-btn in styles.css).
  // A class change beats rewriting innerHTML: the button never reflows and a
  // second click mid-tick cannot lose the original icon.
  copy: '<svg class="pv-copy-mark" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><svg class="pv-copy-tick" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
  plug: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v4"/></svg>',
  check: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  keys: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/></svg>',
  plus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  refresh: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
  api: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  spark: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"/></svg>',
  layers: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/></svg>',
  gauge: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 14l4-4"/><path d="M3.3 19a10 10 0 1 1 17.4 0"/></svg>',
  flask: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v6.5L4.5 19a2 2 0 0 0 1.8 3h11.4a2 2 0 0 0 1.8-3L14 8.5V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/></svg>',
  // The health-check mark, shared with the Models page heart so one gesture
  // looks the same on both pages (see ICON.heart in catalog.js).
  heart: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/><path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27"/></svg>',
  empty: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v4"/><path d="M3 3l18 18"/></svg>',
};

// Turns a copy button into its tick for a moment, and says so in the title for
// anyone who reads the button rather than sees it. The timer is parked on the
// element so a second click restarts it — otherwise the first click's timer
// would clear the tick the second click had just turned on. The original title
// is remembered the first time, so a restart never saves "Copied" as it.
function markCopied(el) {
  const copyId = el.dataset.kxCopy || el.dataset.copy || null;
  if (copyId != null) pvCopied.set(copyId, Date.now() + 1200);
  const title = el.dataset.copyTitle || el.title;
  el.dataset.copyTitle = title;
  el.classList.add('copied');
  el.title = 'Copied';
  clearTimeout(Number(el.dataset.copyTimer));
  el.dataset.copyTimer = String(setTimeout(() => {
    el.classList.remove('copied');
    el.title = title;
    if (copyId != null && (pvCopied.get(copyId) || 0) <= Date.now()) pvCopied.delete(copyId);
  }, 1200));
}

// ============================================
// Providers page — key management panel (table rows and cards)
// ============================================
// Expanded providers are shared by both views, so opening one in the table and
// switching to cards keeps it open.
const pvExpanded = new Set();
const pvCopied = new Map(); // copyId -> expiresAt (ms); re-applied on render so the tick survives a rebuild
const keyProbe = new Map();   // keyId -> { state: 'testing'|'ok'|'fail', text, at }
let keyDeleteArmed = null;    // keyId awaiting a second click to delete

const KX_ICON = {
  chevron: '<svg class="kx-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
  test: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9z"/></svg>',
  trash: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>',
  alert: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  lock: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  unlock: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>',
  external: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>',
};

// ============================================
// Action feedback — Recheck and key Test
// ============================================
// A click is answered: a spinner while the probe runs, then the verdict's icon
// in its colour for a moment, then the button returns to rest. Background
// checks never touch this, so only what the user started animates.
const ACT_ICON = {
  ok: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  fail: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  none: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="6" y1="12" x2="18" y2="12"/></svg>',
};
const ACT_RESULT_MS = 2600;
// A probe that never reports back (transient failures are re-confirmed, which
// can take a while) must not leave a button spinning forever.
const ACT_RUNNING_MAX_MS = 45000;
// A refused local port answers in milliseconds; the spinner is held this long
// so the click still reads as "checked" rather than a flicker.
const ACT_MIN_RUNNING_MS = 650;
const recheckAct = new Map(); // id -> { state, timer, startedAt }
const keyTestAct = new Map();

function setAct(map, id, state) {
  const cur = map.get(id);
  clearTimeout(cur?.timer);
  if (state !== 'running' && cur?.state === 'running') {
    const wait = cur.startedAt + ACT_MIN_RUNNING_MS - Date.now();
    if (wait > 0) {
      map.set(id, { ...cur, timer: setTimeout(() => { setAct(map, id, state); rerenderProvidersIfShown(); }, wait) });
      return;
    }
  }
  const timer = setTimeout(() => {
    map.delete(id);
    rerenderProvidersIfShown();
  }, state === 'running' ? ACT_RUNNING_MAX_MS : ACT_RESULT_MS);
  map.set(id, { state, timer, startedAt: state === 'running' ? Date.now() : cur?.startedAt });
}

function rerenderProvidersIfShown() {
  if (getCurrentPage() === 'providers') renderProvidersPage();
}

// Button inner markup for an action in state `act` ('running' | 'ok' | 'fail'
// | 'none' | undefined for rest).
function actIconHTML(act, restIcon) {
  if (act === 'running') return '<span class="spinner act-spinner" aria-hidden="true"></span>';
  if (ACT_ICON[act]) return `<span class="act-result" aria-hidden="true">${ACT_ICON[act]}</span>`;
  return restIcon;
}

const RECHECK_LABEL = { running: 'Checking…', ok: 'Reachable', fail: 'Failed', none: 'No key' };

function recheckButtonHTML(p, variant) {
  const id = escapeHtml(p.id);
  const act = recheckAct.get(p.id)?.state;
  const attrs = `type="button" data-recheck="${id}"${act ? ` data-act="${act}"` : ''}${act === 'running' ? ' disabled aria-busy="true"' : ''}`;
  // The health check is a heart on both pages now (see ICON.heart in
  // catalog.js); the verdict still lands on the button itself.
  const title = act ? RECHECK_LABEL[act] : 'Recheck connection';
  if (variant === 'link') {
    return `<button class="pv-icon-btn" ${attrs} title="${title}" aria-label="${title}">${actIconHTML(act, PV_ICON.heart)}</button>`;
  }
  return `<button class="dt-icon-btn" ${attrs} title="${title}" aria-label="${title}">${actIconHTML(act, PV_ICON.heart)}</button>`;
}

function recheckProvider(id) { return providerActions.recheckProvider(id); }

const providerKeys = window.VENOM_RENDERER.providerKeys.create({
  $$,
  getProviders: () => PROVIDERS,
  getSettings: () => settings,
  getKeyDeleteArmed: () => keyDeleteArmed,
  pvCopied,
  keyProbe,
  keyTestAct,
  keyPolicy,
  isKeyFullySpent,
  isKeyPartiallySpent,
  spentHint,
  escapeHtml,
  formatAgo,
  formatIn,
  statusPillHTML,
  actIconHTML,
  KX_ICON,
  PV_ICON,
  scheduleInterval: (fn, ms) => setInterval(fn, ms),
  onCatalogChanged: (fn) => window.addEventListener('catalog-changed', fn),
  getCurrentPage: () => getCurrentPage(),
  renderProvidersPage: () => renderProvidersPage(),
  refreshAfterKeyChange,
});
const { keyStripHTML, keysPanelHTML, keyRowsHTML } = providerKeys;
let pvLegendCollapsed = true;
try { pvLegendCollapsed = localStorage.getItem('pvLegendCollapsed') !== '0'; } catch (_) {}
const providerView = window.VENOM_RENDERER.providerView.create({
  getProviders: () => PROVIDERS,
  getRunLog: () => runLog,
  getHistory: () => history,
  getExpanded: () => pvExpanded,
  getCopied: () => pvCopied,
  getLegendCollapsed: () => pvLegendCollapsed,
  getProviderHealth: () => providerHealth,
  getProviderVerdicts: () => providerVerdicts,
  getProviderTicks: () => PROVIDER_TICKS,
  usableKeys,
  rpmOf,
  escapeHtml,
  PV_ICON,
  KX_ICON,
  statusPillHTML,
  providerKeys,
  recheckButtonHTML,
  scoreClass,
  formatAgo,
});
const {
  isConnected, providerWebsite, websiteLinkHTML, providerHost, providerStats,
  providerCapabilities, providerTags, providerMark, providerHealthLine,
  closeRateLimitPop, providerStatusHTML, healthDotHTML, providerCardHTML, providerStatsHTML,
  PROVIDER_TYPES, PV_AUTH_GROUPS, providerAuthKinds, providerAuthGroup,
  providerTypes, typeStripe, providerLogoHTML, providerLegendHTML,
  pvGroupHeadHTML, providerDisplayModelsCount, providerBadgesHTML,
  pvStateBarHTML, providerRateHTML, pvLastRun, pvRowsHTML,
} = providerView;
providerActions = window.VENOM_RENDERER.providerActions.create({
  getProviders: () => PROVIDERS,
  getActiveProvider: () => activeProvider,
  getCurrentPage: () => getCurrentPage(),
  getKeyDeleteArmed: () => keyDeleteArmed,
  setKeyDeleteArmed: (value) => { keyDeleteArmed = value; },
  getExpanded: () => pvExpanded,
  keyProbe,
  keyTestAct,
  recheckAct,
  saveProviderConfig,
  renderKeysList,
  updateTestAllButton,
  renderProvidersPage: () => renderProvidersPage(),
  setStatus,
  isHealthyResponse,
  keyProbeResult,
  setAct,
  healthTimeoutMs: HEALTH_TIMEOUT_MS,
  actionMinRunningMs: ACT_MIN_RUNNING_MS,
  KX_ICON,
  escapeHtml,
});
const { probeKey, testKey, setKeyActive, deleteKey, togglePvExpanded } = providerActions;
// Stat cards — shared
// ============================================
// items: [{ label, value, sub?, foot, icon, meter? (0..1), tone? ('pass' | 'fail'), profile?, attrs?, active? }]
function solidBar(kind, pct) { return `<div class="stat-bar-solid bar-${kind}" style="width: ${Math.max(0, Math.min(100, pct))}%;"></div>`; }
function noBar() { return '<div class="stat-card-bar-wrap is-empty" aria-hidden="true"></div>'; }
function statCard({ tone, title, value, icon, subhead, subval, subvalHtml, bar, foot, pill, pillHtml, clickable, attrs, active }) {
  const isWrapped = bar && (bar.includes("stat-card-wave") || bar.includes("stat-bar-segmented") || bar.includes("stat-bar-spectrum") || bar.includes("stat-card-bar-wrap")); const barHtml = isWrapped ? bar : (bar ? `<div class="stat-card-bar-wrap">${bar}</div>` : "");
  const midHtml = (subhead || subval || subvalHtml || barHtml) ? `<div class="stat-card-mid"><div class="stat-card-mid-labels"><span class="stat-card-subhead">${escapeHtml(subhead || "")}</span><span class="stat-card-subval">${subvalHtml || escapeHtml(subval || "")}</span></div>${barHtml}</div>` : "";
  const pillMarkup = pillHtml || (pill ? `<span class="pill"><span class="dot" aria-hidden="true"></span>${escapeHtml(pill)}</span>` : "");
  return `<div class="stat-card ov-kpi stat-card-${tone || 'slate'}${clickable ? " clickable" : ""}${active ? " active" : ""}" ${attrs || ""}><div class="ambientAura" aria-hidden="true"></div><div class="stat-card-head"><span class="stat-card-title">${escapeHtml(title || "")}</span><div class="stat-card-head-right">${clickable ? `<span class="stat-card-arrow" aria-hidden="true">↗</span>` : ""}<span class="stat-card-badge">${icon || ""}</span></div></div><div class="stat-card-value">${escapeHtml(String(value != null ? value : ""))}</div>${midHtml}<div class="stat-card-foot"><span class="stat-card-foot-text">${escapeHtml(foot || "")}</span>${pillMarkup}</div></div>`;
}
function statCardsHTML(items) {
  const DEF_TONES = ['blue', 'green', 'amber', 'cyan'];
  return '<div class="page-stats-grid ov-kpis">' + items.map((it, idx) => { const tone = it.tone === 'pass' ? 'green' : it.tone === 'fail' ? 'amber' : (it.tone && ['slate', 'green', 'amber', 'blue', 'cyan'].includes(it.tone) ? it.tone : DEF_TONES[idx % DEF_TONES.length]); const title = it.title || it.label || '', value = it.value, subhead = it.subhead !== undefined ? it.subhead : '', subval = it.subval !== undefined ? it.subval : (it.sub || ''); const bar = it.bar || (it.meter != null ? solidBar(tone === 'green' ? 'green' : tone === 'amber' ? 'amber' : tone === 'cyan' ? 'cyan' : 'blue', Math.round(Math.max(0, Math.min(1, it.meter)) * 100)) : noBar()); return statCard({ tone, title, value, icon: it.icon || '', subhead, subval, subvalHtml: it.subvalHtml, bar, foot: it.foot || '', pill: it.pill !== undefined ? it.pill : '', pillHtml: it.pillHtml, clickable: Boolean(it.attrs || it.clickable), attrs: it.attrs, active: it.active }); }).join('') + '</div>';
}

// ============================================
// Data toolbar — shared
// ============================================
// Left: search, filter chips, sort. Right: table / cards switch. The markup is
// built once; bindDataToolbar() keeps `state` in step and calls onChange(key),
// so a keystroke in the search box re-renders the results, never the toolbar.
const DT_ICON = {
  search: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  nomatch: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="m8.5 8.5 5 5M13.5 8.5l-5 5"/></svg>',
};

// config: { placeholder, filterKey?, chipsLabel?, filters: [{ value, label, dot? }], statusFilter: { icon, label, key?, options: [{ value, label }] }, sorts: [{ value, label }], selects: [{ key, icon, label, options: [{ value, label }] }] }
function dataToolbarHTML(config, state) {
  const filterKey = config.filterKey || 'filter';
  const chips = (config.filters || []).map((f) => `
    <button class="dt-chip ${state[filterKey] === f.value ? 'active' : ''}" type="button" role="radio"
            aria-checked="${state[filterKey] === f.value}" data-dt-filter="${f.value}">
      ${f.dot ? `<span class="dt-chip-dot" style="--dot:${f.dot}"></span>` : ''}${escapeHtml(f.label)}
      <span class="dt-chip-count" data-dt-count="${f.value}">0</span>
    </button>`).join('');
  const sorts = (config.sorts || []).map((s) =>
    `<option value="${s.value}" ${state.sort === s.value ? 'selected' : ''}>${escapeHtml(s.label)}</option>`).join('');
  const sortSelectHtml = sorts ? `<div class="ui-select-wrap">
    <select class="ui-select-native" data-dt="sort" data-lead-icon="sort" data-ui-class="ui-select-toolbar" aria-label="Sort">
      ${sorts}
    </select>
  </div>` : '';

  const statusSel = config.statusFilter ? (() => {
    const key = (config.statusFilter && config.statusFilter.key) || 'status';
    const opts = config.statusFilter.options.map((o) =>
      `<option value="${o.value}" ${state[key] === o.value ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
    return `<div class="ui-select-wrap">
      <select class="ui-select-native" data-dt-status
              data-lead-icon="${escapeHtml(config.statusFilter.icon || 'server')}"
              data-ui-class="ui-select-toolbar"
              aria-label="${escapeHtml(config.statusFilter.label || 'Status')}">
        ${opts}
      </select>
    </div>`;
  })() : '';

  const extraSelects = (config.selects || []).map((s) => {
    const opts = s.options.map((o) =>
      `<option value="${escapeHtml(o.value)}" ${state[s.key] === o.value ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
    return `<div class="ui-select-wrap">
      <select class="ui-select-native" data-dt-select="${escapeHtml(s.key)}"
              data-lead-icon="${escapeHtml(s.icon || '')}"
              data-ui-class="ui-select-toolbar"
              aria-label="${escapeHtml(s.label || '')}">
        ${opts}
      </select>
    </div>`;
  }).join('');
  
  return `<div class="dt-toolbar">
    <div class="dt-left">
      <label class="dt-search"><span class="dt-search-icon" aria-hidden="true">${DT_ICON.search}</span>
        <input type="search" data-dt="search" placeholder="${escapeHtml(config.placeholder || 'Search…')}"
               value="${escapeHtml(state.search)}" autocomplete="off" spellcheck="false" aria-label="Search">
        <kbd>/</kbd>
      </label>
      ${sortSelectHtml}
      ${statusSel}
      ${extraSelects}
    </div>
    <div class="dt-right">
      ${chips ? `<div class="dt-chips" role="radiogroup" aria-label="${escapeHtml(config.chipsLabel || 'Filter')}">${chips}</div>` : ''}
      <div class="dt-actions"></div>
    </div>
  </div>`;
}

function syncDataToolbar(root, state, config = {}) {
  const filterKey = config.filterKey || 'filter';
  root.querySelectorAll('[data-dt-filter]').forEach((b) => {
    const on = b.dataset.dtFilter === state[filterKey];
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
  const sel = root.querySelector('[data-dt-status]');
  if (sel) {
    const key = (config.statusFilter && config.statusFilter.key) || 'status';
    sel.value = state[key];
  }
  root.querySelectorAll('[data-dt-select]').forEach((s) => {
    const key = s.dataset.dtSelect;
    if (key in state) s.value = state[key];
  });
}

function bindDataToolbar(root, state, onChange, config = {}) {
  const filterKey = config.filterKey || 'filter';
  const search = root.querySelector('[data-dt="search"]');
  if (search) {
    search.addEventListener('input', (e) => {
      state.search = e.target.value;
      onChange('search');
    });
  }
  const sort = root.querySelector('[data-dt="sort"]');
  if (sort) sort.addEventListener('change', (e) => { state.sort = e.target.value; onChange('sort'); });
  root.addEventListener('click', (e) => {
    const f = e.target.closest('[data-dt-filter]');
    if (f) { state[filterKey] = f.dataset.dtFilter; syncDataToolbar(root, state, config); onChange(filterKey); }
  });
  const statusSel = root.querySelector('[data-dt-status]');
  if (statusSel) {
    statusSel.addEventListener('change', (e) => {
      const key = (config.statusFilter && config.statusFilter.key) || 'status';
      state[key] = e.target.value;
      onChange(key);
    });
  }
  root.querySelectorAll('[data-dt-select]').forEach((s) => {
    s.addEventListener('change', (e) => {
      const key = s.dataset.dtSelect;
      state[key] = e.target.value;
      onChange(key);
    });
  });
}

// catalog.js still shares this classic-script media-query helper.
const COMPACT_LAYOUT = window.matchMedia('(max-width: 1100px)');
const providerRoster = window.VENOM_RENDERER.providerRoster.create({
  $,
  $$,
  compactLayout: COMPACT_LAYOUT,
  getProviders: () => PROVIDERS,
  getRunLog: () => runLog,
  getCurrentPage: () => getCurrentPage(),
  isConnected,
  usableKeys,
  providerHealthLine,
  providerStats,
  providerAuthKinds,
  providerAuthGroup,
  providerDisplayModelsCount,
  providerHost,
  providerLegendHTML,
  groupHeadHTML: (kind, count) => pvGroupHeadHTML(kind, count),
  providerCardHTML,
  providerRowsHTML: (groups, stats) => pvRowsHTML(groups, stats),
  dataToolbarHTML,
  bindDataToolbar,
  statCardsHTML,
  noMatchIcon: DT_ICON.nomatch,
  emptyIcon: PV_ICON.empty,
  plugIcon: PV_ICON.plug,
  authGroups: PV_AUTH_GROUPS,
  breadcrumbHTML,
  closeRateLimitPop,
  toggleExpanded: (id) => togglePvExpanded(id),
  clearExpanded: () => pvExpanded.clear(),
  setLegendCollapsed: (value) => { pvLegendCollapsed = value; },
  getLegendCollapsed: () => pvLegendCollapsed,
  testKey: (pid, kid) => testKey(pid, kid),
  setKeyActive: (pid, kid) => setKeyActive(pid, kid),
  deleteKey: (pid, kid) => deleteKey(pid, kid),
  getKey: (pid, kid) => PROVIDERS[pid]?.keys.find((key) => key.id === kid),
  markCopied,
  setStatus,
  showPage,
  switchProvider,
  openAddKeyModal,
  openProviderPage,
  recheckProvider,
});
const KPI_ICON = providerRoster.KPI_ICON;
const renderProvidersPage = () => providerRoster.render();
shellController = window.VENOM_RENDERER.shell.create({
  $, $$,
  pageRouter,
  pageMeta: PAGE_META,
  getProviders: () => PROVIDERS,
  getActiveProvider: () => activeProvider,
  getCurrentPage: () => getCurrentPage(),
  getRunHistory: () => history,
  getRunLog: () => runLog,
  getProviderHealth: () => providerHealth,
  renderProviderHead,
  resetProviderPage: () => {
    ptLegendOpen = false;
    renderProviderHead();
    updateStats();
    renderPtLegend();
  },
  renderProfilePage,
  prepareSettingsPage,
  providerRoster,
  syncRoute,
  toggleTheme,
  switchSettingsSection,
  escapeHtml,
});
bindShell();

async function init() {
  // Startup read gate: a read that fails is shown and blocks every write for
  // the session (see persist), instead of becoming defaults that a later save
  // would write over the real data.
  try { await loadSettings(); } catch (err) { failStartupRead('settings', err); }
  applyAppearance();
  preloadEmblems();
  bindSettingsForm();
  window.electronAPI.getDataPath().then((dir) => { $('#settings-path').textContent = dir; });
  try { await loadTestDefinition(); } catch (err) { failStartupRead('the test prompt', err); }
  try { await loadHistory(); } catch (err) { failStartupRead('run history', err); }
  try { await loadAllProviders(); } catch (err) { failStartupRead('providers', err); }
  if (!PROVIDERS[activeProvider]) {
    activeProvider = Object.keys(PROVIDERS)[0];
  }
  resultsProvider = activeProvider;
  renderProviderHead();
  renderKeysList();
  renderModelsList();
  if (!storeReadError && !writeFailed) setStatus('idle', 'Ready — add an API key to begin');
  // Request logging isn't critical: when its database couldn't be opened the
  // app runs on, and says so once.
  window.electronAPI.logsInfo()
    .then((info) => {
      if (info && info.enabled === false && !storeReadError && !writeFailed) setStatus('error', `Request logging is off: ${info.error}`);
    })
    .catch((err) => console.error('Could not read the request log status:', err));
  setupUpdateListeners();
  startHealthMonitor();
  renderQuickStats();
  // The lock's own state, so the Security section and its warning are correct
  // the first time they are opened rather than after a visit.
  primeLockStatus();
  // The catalogue needs the providers and their keys, so it starts last.
  if (window.CATALOG) window.CATALOG.init();
  // The bell paints its unread count once the data is readable.
  if (window.ACTIVITY) window.ACTIVITY.init();
  // Last, so the restored page renders with settings and providers in place.
  applyRoute();
}

// catalog.js loads after this file, and init() hands it the providers at its
// end. Started straight away, init's first IPC replies could land before the
// parser had run it, so `window.CATALOG` was still missing and the catalogue
// never started (no sync, no bindings).
// DOMContentLoaded fires only once every script on the page has run.
//
// THE LOCK GATE. Everything init() does reads the owner's data — providers,
// keys, history, the model pool — so none of it runs until the password is
// accepted. `authStatus` RESOLVES (see preload.js); the only way it rejects is a
// defect in main, and that must not be mistaken for "locked" or for "open":
// it is reported, and the app then opens, because a broken lock is a bug to
// see and fix, not a reason to sit on an empty screen forever.
async function start() {
  let status = null;
  try {
    status = await window.electronAPI.authStatus();
  } catch (err) {
    console.error('Could not read the app lock state; opening without it:', err);
  }
  if (window.LOCK) {
    window.LOCK.init(status || { locked: false, idleMs: 0 });
    if (status && status.locked) {
      const unlocked = await window.LOCK.waitForUnlock();
      if (!unlocked.ok) return;
    }
  }
  init().catch((err) => console.error('Startup failed:', err));
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
