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
// outright is believed over it.

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
  deadlineDecisionMs: 60000,

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

  // Generators. Each is sent to its dedicated endpoint first (/images/generations,
  // /videos) and falls back to chat on a provider that has no such route. A
  // returned link proves little on its own — verifyAssets fetches its headers and
  // passes the model only when the link really serves an image or a video.
  imagePrompt: 'A single red circle centred on a plain white background.',
  videoPrompt: 'A single red circle slowly moving across a plain white background.',
  videoPollMs: 5000,
  verifyAssets: true,

  // Decision models answer a typed question with a probability. The probe is a
  // statement whose truth is not in doubt, so a healthy model scores it high and
  // anything under the threshold is a wrong answer — the decision twin of 2+2.
  decisionState: 'The statement under review: 2 + 2 = 4.',
  decisionQuestion: 'Is the statement under review mathematically correct?',
  decisionThreshold: 0.7,

  historyMaxRuns: 300,
  sparkRuns: 12,

  notifyRegression: true,
  notifyRunComplete: false,

  // Generators are unselected by default, but once selected they would join
  // every scheduled run — generating images on a timer, unattended.
  scheduleSkipMedia: true,

  // Live provider health. Each probe is one GET /models per provider, so the
  // cadence trades freshness against quota. liveUpdates pauses the monitor
  // entirely (the breadcrumb toggle); a manual re-check still works.
  healthIntervalMin: 2,
  liveUpdates: true,

  // Appearance. Every colour in the stylesheet comes from a custom property, so
  // a theme is a block of overrides rather than a second stylesheet.
  // 'vercel' (Dark) or 'daylight' (Light). followSystem overrides it with the
  // OS setting. accent is one of ACCENTS' ids.
  theme: 'vercel',
  followSystem: false,
  accent: 'emerald',
  density: 'normal',

  // The app lock. Minutes of inactivity before the window asks for the password
  // again; it always asks on launch. main reads this row for its own copy of the
  // limit (src/main.js idleLimitMs), so a change here is re-read on every save.
  lockIdleMin: 60,

  // Turns off transitions and animated flourishes. The stylesheet honours it on
  // the lock screen through html[data-motion="reduced"]; the OS's own
  // prefers-reduced-motion is honoured as well and is not overridable from here.
  reduceMotion: false,

  // Request bodies in the request log: off | errors (Failed only) | all. The
  // metadata of every request is recorded whatever this says. Main reads it
  // from the saved settings row: a row without it (a new install) means
  // Failed only, and a value already saved is never changed.
  logLevel: 'errors',
  // Mirrors LOG_DEFAULTS in src/logs/settings.js, which main reads back from
  // the same row. Without them here the retention inputs open empty.
  logRetentionDays: 90,
  bodyRetentionDays: 7,
  statsRetentionMonths: 12,

  // Models Catalog. The pool re-reads every connected provider's model
  // list on this cadence. openRouterApiKey is optional and unlocks the fourth
  // upstream document (the Artificial Analysis indices); without it fewer
  // models are measured and more are estimated, and nothing breaks.
  catalogSyncMinutes: 5,
  openRouterApiKey: '',

  // Models tested at the same time. 1 is the original behaviour. Raising it is
  // the only thing that actually shortens a run — widening the hedge spends more
  // requests on one model without lowering that model's own latency.
  concurrency: 1,
};

const THEMES = [
  { id: 'daylight', name: 'Light' },
  { id: 'vercel', name: 'Dark' },
];

// The brand pack's five, each with an emblem drawn in its colour (see
// scripts/generate-icons.js). hex is the swatch; the stylesheet's [data-accent]
// rules carry the same colour and the shades derived from it.
const ACCENTS = [
  { id: 'emerald', name: 'Emerald', hex: '#10b981' },
  { id: 'cyan', name: 'Cyan', hex: '#06b6d4' },
  { id: 'violet', name: 'Violet', hex: '#8b5cf6' },
  { id: 'crimson', name: 'Crimson', hex: '#f43f5e' },
  { id: 'amber', name: 'Amber', hex: '#f59e0b' },
];

// Accents saved before the brand pack, and the one they became. 'blue' had no
// counterpart: cyan is the nearest hue.
const LEGACY_ACCENTS = { green: 'emerald', rose: 'crimson', blue: 'cyan' };

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

function effectiveTheme() {
  if (settings.followSystem) return systemDark.matches ? 'vercel' : 'daylight';
  return settings.theme;
}

function accentLabel() {
  return (ACCENTS.find((a) => a.id === settings.accent) || ACCENTS[0]).name;
}

function applyAppearance() {
  const el = document.documentElement;
  const theme = effectiveTheme();
  el.setAttribute('data-theme', theme);
  el.setAttribute('data-density', settings.density);
  el.setAttribute('data-accent', settings.accent);
  // The lock screen's motion switch. It reads this attribute in CSS and in
  // lock.js, so flipping the setting takes effect without a reload — and the
  // OS's own prefers-reduced-motion is honoured on top of it, in both places.
  el.setAttribute('data-motion', settings.reduceMotion ? 'reduced' : 'normal');
  queueBrandIcon(settings.accent);

  const toggle = document.getElementById('btn-theme-toggle');
  if (toggle) {
    const label = theme === 'daylight' ? 'Switch to dark mode' : 'Switch to light mode';
    toggle.title = label;
    toggle.setAttribute('aria-label', label);
  }
}

// The taskbar icon follows the accent: main sets the window icon to that
// accent's emblem. Debounced, because a quick run through the swatches would
// otherwise set it once per click; an unchanged accent is not sent again.
const brandIcon = { id: null, timer: null };

function queueBrandIcon(id) {
  if (!window.electronAPI?.setWindowIcon || id === brandIcon.id) return;
  brandIcon.id = id;
  clearTimeout(brandIcon.timer);
  brandIcon.timer = setTimeout(() => window.electronAPI.setWindowIcon(id), 150);
}

// Every emblem, once, so picking an accent swaps the picture at once instead of
// showing a gap while the file loads.
function preloadEmblems() {
  ACCENTS.forEach((a) => {
    ['', '-light'].forEach((suffix) => { new Image().src = `../assets/brand/emblem-${a.id}${suffix}.png`; });
  });
}

// Windows switching light/dark while the app is open.
systemDark.addEventListener('change', () => {
  if (!settings.followSystem) return;
  applyAppearance();
  if (currentPage === 'settings') renderAppearancePickers();
});

// Header toggle flips the mode actually on screen; an explicit choice ends
// following the system.
function toggleTheme() {
  settings.theme = effectiveTheme() === 'daylight' ? 'vercel' : 'daylight';
  settings.followSystem = false;
  applyAppearance();
  queueSettingsSave();
  if (currentPage === 'settings') renderAppearancePickers();
}

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
let modelFilter = ''; // models panel search box, lowercased
let testResults = [];
let runTotal = null; // models covered by the current/last run; null = no run yet
let lastRun = null; // { done, total, stopped } — lets the summary be re-stated
let isTesting = false;
let abortTesting = false;
let runStartTime = null; // Date.now() when the current run began — for elapsed display
let updateInfo = null;
let isUpdateDownloading = false;
let isUpdateReady = false;

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
// Providers — each saved on its own (save-provider)
// ============================================
// The provider as save-provider takes it. A key's `key` is what the user
// typed, the key's placeholder, or '' for a key main holds but can't read
// here (locked); main keeps the stored secret for the last two.
function providerPayload(id) {
  const p = PROVIDERS[id];
  return {
    id,
    name: p.name,
    baseUrl: p.baseUrl,
    rpm: p.rpm ?? null,
    keys: p.keys.map((k) => ({ id: k.id, name: k.name, key: k.key || '', active: k.active !== false, quotaSpent: k.quotaSpent || null })),
  };
}

// Main answers with each key as a placeholder and a hint. The objects are
// updated in place — the Connect flow still holds the one storeKey created —
// so a key typed a moment ago doesn't stay in the page. Name, active and
// quotaSpent stay the renderer's: a later edit may already be on its way.
function adoptSavedKeys(p, saved) {
  const fresh = new Map(saved.keys.map((k) => [k.id, k]));
  p.keys.forEach((k) => {
    const s = fresh.get(k.id);
    if (!s) return;
    k.key = s.key;
    k.hint = s.hint;
    k.locked = s.locked;
    // A save payload never carries a quotaSpent: the key's live refusal state
    // stays the renderer's, so a save (rekey, toggle, TTL cleanup…) never
    // wipes it by omitting it. Only adopt an explicit one.
    if (Object.hasOwn(s, 'quotaSpent')) k.quotaSpent = s.quotaSpent || null;
  });
}

// Returns whether the save actually landed (persist()'s result, truthy on
// success, undefined when refused or failed — already reported by persist).
// Callers that show their own "done" status must skip it when this is false,
// or the save's error in the status bar gets overwritten by a false success.
async function saveProviderConfig(providerId) {
  const p = PROVIDERS[providerId];
  if (!p) return false;
  const saved = await persist(`save ${p.name}`, () => window.electronAPI.saveProvider(providerPayload(providerId)));
  if (saved) adoptSavedKeys(p, saved);
  // Every save is a user edit to keys or the base URL, so the verdict is stale.
  checkProviderHealth(providerId);
  if (currentPage === 'providers') renderProvidersPage();
  // The Models Catalog shows a provider's models only while it has a key.
  window.dispatchEvent(new CustomEvent('providers-changed', { detail: { providerId } }));
  return !!saved;
}

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
  let stored = {};
  let readError = null;
  try {
    stored = (await window.electronAPI.readConfig()).providers || {};
  } catch (err) {
    readError = err;
  }
  const norm = (u) => (u || '').trim().replace(/\/+$/, '').toLowerCase();

  PROVIDERS = {};

  // Built-ins: code template with the stored name/baseUrl/keys overlaid (the
  // store wins). A newly-shipped built-in the store doesn't have yet is seeded
  // below so its name and baseUrl are visible and editable.
  const missing = [];
  Object.values(BUILTIN_PROVIDERS).forEach((def) => {
    const p = makeRuntimeProvider(def);
    const s = stored[def.id];
    if (s) {
      if (s.name) p.name = s.name;
      if (s.baseUrl) p.baseUrl = s.baseUrl;
      // null is "not set", which a provider seeded before its module declared a
      // limit carries; it falls back to the module's documented rpm.
      if (s.rpm != null) p.rpm = s.rpm;
      p.keys = s.keys || [];
    } else {
      missing.push(def.id);
    }
    PROVIDERS[def.id] = p;
  });
  // A refusal that named no reset is one model's answer on one day, not a fact
  // about the key. It TTLs out of the renderer (isKeySpent / quotaSpentExpired)
  // but the store has no such clock, so a record older than the TTL is dropped
  // here on load — otherwise it would outlive its meaning in the DB.
  Object.values(PROVIDERS).forEach((p) => {
    (p.keys || []).forEach((k) => {
      if (k && k.quotaSpent && quotaSpentExpired(k.quotaSpent)) {
        delete k.quotaSpent;
        window.electronAPI.saveProvider(providerPayload(p.id)).then(
          (saved) => { if (saved) adoptSavedKeys(p, saved); },
        ).catch(() => {});
      }
    });
  });

  // Nothing below may write when the store could not be read: PROVIDERS is
  // then the bare templates, without a single key. init() shows the error.
  if (readError) throw readError;

  // Seeded one at a time, so seeding never rewrites another provider.
  for (const id of missing) {
    await persist(`add ${PROVIDERS[id].name}`, () => window.electronAPI.saveProvider(providerPayload(id)));
  }

  // The app only runs its integrated providers. A custom provider left by an
  // older version is merged in main into the built-in with the same baseUrl
  // (keys move over, duplicates are dropped by value — by ciphertext for keys
  // this machine can't read); one with no built-in twin and no keys is
  // removed. One that still holds keys stays in the store untouched, so no key
  // is ever thrown away, but it is not loaded.
  for (const [id, s] of Object.entries(stored)) {
    if (!s.custom || PROVIDERS[id]) continue;
    const builtin = Object.values(PROVIDERS).find((p) => !p.custom && norm(p.baseUrl) === norm(s.baseUrl));
    if (builtin) {
      const merged = await persist(`merge ${s.name || id} into ${builtin.name}`, () => window.electronAPI.mergeProvider(id, builtin.id));
      if (merged) builtin.keys = merged.keys;
    } else if (!(s.keys || []).length) {
      await persist(`remove ${s.name || id}`, () => window.electronAPI.deleteProvider(id));
    } else {
      console.warn(`Custom provider "${s.name || id}" still holds keys; kept in the store, not loaded.`);
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
// Provider page — header
// ============================================
// The page shows one provider (activeProvider). Its trail, health and title are
// drawn here; the keys, models and stats each have their own renderer.
function renderProviderHead() {
  const p = PROVIDERS[activeProvider];
  if (!p) return;
  $('#pt-crumbs').innerHTML = breadcrumbHTML([
    { label: 'Overview', page: 'overview' },
    { label: 'Providers', page: 'providers' },
    { label: p.name, iconHTML: `<span class="crumb-mark">${providerMark(p)}</span>` },
  ]);
  const healthEl = $('#pt-health');
  if (healthEl) healthEl.innerHTML = providerStatusHTML(p);
  if (currentPage === 'provider') renderPageHeader('provider');
}

$('.page-provider').addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) showPage(go.dataset.go);
});
$('#pt-edit').addEventListener('click', () => openProviderModal(activeProvider));

// ============================================
// Provider health — a silent background probe of each provider's key
// ============================================
// States: 'ok' (a key authenticated), 'fail' (every key was refused or the host
// is unreachable), 'none' (no usable key to test with). Kept outside the DOM
// because the tab list is rebuilt on every render.
const healthIntervalMs = () => Math.max(1, settings.healthIntervalMin) * 60 * 1000;
const HEALTH_TIMEOUT_MS = 15000;
// A dropped connection or a waking laptop fails every probe at once. A transient
// failure is re-checked after this delay and only a second one turns the row red.
const HEALTH_CONFIRM_MS = 10000;
const healthConfirming = new Set();
const providerHealth = new Map();
const healthInFlight = new Set();
const healthRecheck = new Set();
let healthTimer = null;

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

async function checkProviderHealth(id) {
  const p = PROVIDERS[id];
  if (!p) return;
  // A key edited mid-probe must not be answered by the probe of the old keys.
  if (healthInFlight.has(id)) {
    healthRecheck.add(id);
    return;
  }
  const keys = usableKeys(p);
  if (keys.length === 0) {
    setProviderHealth(id, { state: 'none', detail: 'No API key' });
    return;
  }

  healthInFlight.add(id);
  try {
    // Every active key is probed, in parallel, so each key row carries its own
    // verdict instead of "Not tested". A manual test already running is left alone.
    const results = await Promise.all(keys.map(async (k) => {
      let res;
      try {
        res = await window.electronAPI.apiRequest({
          url: `${p.baseUrl}${p.modelsEndpoint || '/models'}`,
          method: 'GET',
          headers: { Authorization: `Bearer ${k.key}`, 'Content-Type': 'application/json' },
          timeoutMs: HEALTH_TIMEOUT_MS,
          source: 'health',
        });
      } catch (err) {
        res = { status: 0, networkError: true, error: err.message };
      }
      if (keyProbe.get(k.id)?.state !== 'testing') keyProbe.set(k.id, keyProbeResult(res));
      return res;
    }));
    const healthy = results.find(isHealthyResponse);
    if (healthy) {
      healthConfirming.delete(id);
      setProviderHealth(id, { state: 'ok', detail: `Connected · ${healthy.elapsed} ms` });
      return;
    }
    const last = results[results.length - 1];
    const transient = results.some((res) => res.networkError || res.status >= 500);
    reportHealthFailure(id, describeHealthFailure(last), transient);
  } catch (err) {
    reportHealthFailure(id, err.message || 'Check failed', true);
  } finally {
    healthInFlight.delete(id);
    if (healthRecheck.delete(id)) checkProviderHealth(id);
  }
}

// A refused key is a verdict; a timeout or 5xx may be the network blinking, so
// it is confirmed by a second probe before the row turns red.
function reportHealthFailure(id, detail, transient) {
  const current = providerHealth.get(id);
  if (!transient || healthConfirming.has(id) || (current && current.state === 'fail')) {
    healthConfirming.delete(id);
    setProviderHealth(id, { state: 'fail', detail });
    return;
  }
  healthConfirming.add(id);
  setTimeout(() => checkProviderHealth(id), HEALTH_CONFIRM_MS);
}

function setProviderHealth(id, { state, detail }) {
  const prev = providerHealth.get(id);
  providerHealth.set(id, { state, detail, checkedAt: Date.now() });
  // A Recheck the user pressed resolves into its verdict (see recheckProvider).
  if (recheckAct.get(id)?.state === 'running') setAct(recheckAct, id, state);
  if (currentPage === 'provider' && id === activeProvider) renderProviderHead();
  renderQuickStats();
  if (currentPage === 'providers') renderProvidersPage();
  // These two show only the state (a dot), and rebuilding them resets open
  // menus, so a probe that confirms the same state leaves them alone.
  if (!prev || prev.state !== state) {
    if (window.CATALOG) window.CATALOG.renderIfShown();
  }
}

function checkAllProvidersHealth() {
  // Sequential per provider would let one slow host delay the rest; each
  // provider already walks its own keys one at a time.
  Object.keys(PROVIDERS).forEach((id) => { checkProviderHealth(id); });
}

// The first pass always runs so every page has a verdict to show; after that
// the timer, focus and reconnect probes all stop while live updates are paused.
function startHealthMonitor() {
  checkAllProvidersHealth();
  scheduleHealthMonitor();
  // Coming back to the app after a while shouldn't show a stale verdict.
  // The connection coming back is exactly when red rows are most likely stale.
  window.addEventListener('online', () => { if (settings.liveUpdates) checkAllProvidersHealth(); });
  window.addEventListener('online', renderSystemLamp);
  window.addEventListener('offline', renderSystemLamp);
  window.addEventListener('focus', () => {
    if (!settings.liveUpdates) return;
    const stale = Date.now() - healthIntervalMs() / 2;
    Object.keys(PROVIDERS).forEach((id) => {
      const h = providerHealth.get(id);
      if (!h || h.checkedAt < stale) checkProviderHealth(id);
    });
  });
}

function scheduleHealthMonitor() {
  clearInterval(healthTimer);
  healthTimer = settings.liveUpdates ? setInterval(checkAllProvidersHealth, healthIntervalMs()) : null;
  renderLiveToggles();
}

// Resuming re-checks at once: whatever is on screen is as old as the pause.
function setLiveUpdates(on) {
  settings.liveUpdates = on;
  queueSettingsSave();
  scheduleHealthMonitor();
  if (on) checkAllProvidersHealth();
}

// The live switch is the orb between the Providers page's tabs; this keeps
// it (and anything else marked data-live-toggle) in step with the setting.
function liveToggleAttrs() {
  const on = settings.liveUpdates;
  const every = settings.healthIntervalMin === 1 ? 'every minute' : `every ${settings.healthIntervalMin} minutes`;
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
  models = p.models || [];
  modelFilter = '';
  const search = $('#models-search');
  if (search) search.value = '';
  renderProviderHead();
  renderKeysList();
  renderModelsList();
  updateTestAllButton();
  updateStats();
  if (currentPage === 'provider') syncRoute();
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
  $('#pt-key-count').textContent = String(p.keys.length);

  if (p.keys.length === 0) {
    container.innerHTML = `
      <div class="models-empty">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" opacity="0.5" aria-hidden="true">
          <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
        </svg>
        <span>No keys yet</span>
        <span class="models-empty-hint">Add a key to fetch and test this provider's models.</span>
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
          // No hint and not locked means the save that should have produced
          // one never landed: the key still sits here as plaintext, unsaved.
          k.locked ? 'Encrypted for another machine — re-add it' : (k.hint ? escapeHtml(k.hint) : 'not saved')
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

// The page never holds a key: k.key is a venomkey:<id> placeholder that main
// swaps for the secret per request, and k.hint is the masked form main
// computed. Copy is the one way the full value leaves the app, and main
// writes it to the clipboard itself.
// A key flagged `locked` is ciphertext this machine can't open, so there is
// nothing to send — it is excluded from every run.
function usableKeys(p) {
  return p.keys.filter((k) => k.active && !k.locked);
}

async function copyKey(keyId, btn) {
  const key = PROVIDERS[activeProvider].keys.find((k) => k.id === keyId);
  if (!key || key.locked) return;
  try {
    await window.electronAPI.copyKey(keyId);
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

// Returns { k, saved }: saved is false when saveProviderConfig's persist()
// failed — the key stays in the page (still plaintext, no hint) so the key
// rows can show it as "not saved" instead of quietly losing it.
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

// ============================================
// Fetch models from provider — only models for the key's plan
// ============================================
function getFreeGroupName(code) {
  if (code === 'free') return 'FREE';
  if (code === 'freemium' || code === 'freemium-max') return 'FREE FOR PAID';
  return code;
}

// The apiRequest handed to a provider module, tagged for the request log with
// what its caller is doing. A module's own pricing and plans pages (Nara,
// Experiential) are tagged 'pricing', whoever asked for them.
function taggedApiRequest(source, p) {
  const pricingPages = [p && p.pricingUrl, p && p.plansUrl].filter(Boolean);
  return (opts) => window.electronAPI.apiRequest({
    ...opts,
    source: pricingPages.some((u) => String(opts.url || '').startsWith(u)) ? 'pricing' : source,
  });
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
      apiRequest: taggedApiRequest('discovery', p),
      formatContext,
      getFreeGroupName,
    });
  }

  // Plain OpenAI-compatible provider: show all models, no plan filtering
  const modelsResult = await window.electronAPI.apiRequest({
    url: `${p.baseUrl}/models`,
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    source: 'discovery',
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

    models.forEach((m) => { m.kind = classifyModel(p.id, m); });

    p.models = [...models];
    // Chat models start selected. Generators don't: each one costs a real image
    // or video generation and a minute of wall clock, so including them in every
    // run — especially a scheduled one — has to be a decision, not a default.
    p.selected = new Set(models.filter((m) => !isMedia(m)).map((m) => m.id));

    renderModelsList();

    // Fetch and catalog are one step (spec section 6): the roster that was just
    // read is the roster main stores, so the Models page's rows, scores and
    // ranks come from the same pass the list below is drawn from — not from a
    // document this app no longer has.
    let catalogNote = '';
    try {
      await ingestProviderRoster();
      catalogNote = ' · catalog updated';
    } catch (err) {
      // The list is still worth showing: the fetch succeeded and the refusal is
      // about the catalog's bookkeeping, not about what the provider lists.
      catalogNote = ` · catalog not updated: ${err.message}`;
    }

    const keyNote = activeKeys.length > 1 ? ` across ${activeKeys.length} keys` : '';
    if (p.plansUrl) {
      const freeCount = models.filter((m) => m.isFree).length;
      const freeForPaidCount = models.filter((m) => m.isFreeForPaid).length;
      setStatus('done', `Fetched ${models.length} models${keyNote} (${freeCount} free + ${freeForPaidCount} free for paid)${catalogNote}`);
    } else if (failures.length) {
      setStatus('error', `Fetched ${models.length} models${keyNote} — ${failures.join('; ')}${catalogNote}`);
    } else {
      setStatus('done', `Fetched ${models.length} models${keyNote}${catalogNote}`);
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

// Hand the fetched roster to main and take back what it stored. The adapter
// objects go as they are — main maps them through src/catalog/row.js, and the
// aliases an adapter declares are the only way some rows reach the reference at
// all, so pre-mapping here would throw them away.
//
// `ingest` is the only writer of a provider's roster, and it is one flight per
// provider: the timer, a Fetch models click and a fetch-information click that
// overlap cost one upstream read and one write, not three.
//
// Its refusals arrive as `{ ok: false, code }` rather than as a rejection, so
// the verdict is read off the reply and never from a catch.
async function ingestProviderRoster() {
  const p = PROVIDERS[activeProvider];
  if (!p) throw new Error('No provider selected');
  const reply = await window.electronAPI.catalogIngest(p.id, p.models || []);
  if (reply && reply.ok === false) {
    throw new Error(catalogIngestFailure(reply));
  }
  if (reply && reply.rows && reply.rows.length) {
    // The Models page reads its own rows from catalog:read, so this only has to
    // say what moved — the answer is a status line, not a redraw of a list this
    // page does not own. `moved` is the edge, not the windows: `added` counts
    // everything new inside seven days, which would repeat on every click.
    const moved = (reply.changes && reply.changes.moved) || { appeared: 0, disappeared: 0 };
    const bits = [];
    if (moved.appeared) bits.push(`${moved.appeared} new`);
    if (moved.disappeared) bits.push(`${moved.disappeared} removed`);
    const scored = reply.rows.filter((r) => r.score != null).length;
    const detail = bits.length ? ` — ${bits.join(' · ')}` : '';
    setStatus('done', `Catalog updated: ${reply.rows.length} models, ${scored} scored${detail}`);
    if (reply.warning) setStatus('warn', reply.warning);
  }
  return reply;
}

// A code's own words, as the owner should read them. SYNC_IN_PROGRESS is not a
// failure they caused: the same provider is already being ingested, and saying
// so is the difference between a refusal and a button that appears to do
// nothing. Every catalog:* channel resolves, so this reads the reply and never
// catches.
const CATALOG_INGEST_CODES = {
  INVALID_PROVIDER_PAYLOAD: 'The provider answered with a model list this app cannot read, so nothing was changed.',
  NOT_FOUND: 'That provider is no longer in the database, so nothing was fetched.',
  SUSPICIOUS_PROVIDER_DROP: 'The model count dropped sharply and is being held until it repeats — the last good list is still shown.',
  SYNC_IN_PROGRESS: 'That provider is already being re-read; try again in a moment.',
};

function catalogIngestFailure(reply) {
  return CATALOG_INGEST_CODES[reply.code]
    || `The catalog refused this roster (${reply.code || 'no code given'})${reply.message ? `: ${reply.message}` : ''}`;
}

// A router often exposes the same upstream model twice: once bare and once under
// a tier prefix ("deepseek-v4.1-flash" and "dark-free/deepseek-v4.1-flash"). They
// are separate entries with separate ids, so they can't be deduped — but they are
// the same model, and counting them as two distorts uptime and makes the list
// read as twice the catalogue it is.
//
// The bare name is recorded as an alias group so the models list can say so. They are
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
// decide how to render "unknown" (the table shows NA, the models list shows nothing
// rather than a stray dash under every model name).
function formatContext(ctx) {
  if (!ctx) return '';
  if (ctx >= 1000000) return `${Math.round(ctx / 1000000)}M`;
  if (ctx >= 1000) return `${Math.round(ctx / 1000)}K`;
  return String(ctx);
}

// ============================================
// Render the models list
// ============================================
// The models matching the models panel search box. Filtering is display-only — it
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
        <span class="models-empty-hint">${PROVIDERS[activeProvider].keys.length ? 'Fetch models to list what this provider offers.' : 'Add an API key, then fetch models.'}</span>
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
    // No group label here — the panel header already reads "Models <n>".
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
  const id = escapeHtml(m.id);
  const selected = PROVIDERS[activeProvider]?.selected.has(m.id);
  return `
    <div class="model-item ${selected ? 'selected' : ''}" data-model-id="${id}">
      <div class="model-checkbox"></div>
      <div class="model-info">
        <span class="model-name" title="${id}">${id}</span>
        ${KIND_LABELS[m.kind] ? `<span class="model-kind">${KIND_LABELS[m.kind]}</span>` : ''}
        ${m.contextLabel ? `<span class="model-context">${m.contextLabel}</span>` : ''}
      </div>
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
    'not granted',
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

// A key whose allowance is used up — a free tier's weekly allowance, a prepaid
// quota. A models-endpoint check can't see it (it keeps answering 200), so it
// is learned from the provider's error — the module's readQuotaError, else the
// standard codes below — and kept on the key as `quotaSpent` (so it survives a
// restart) until the reset time the error named.
//
// It is recorded per model, not for the whole key: one key can draw on more
// than one allowance. Token Harbor's free models share the free-tier allowance,
// but a campaign model carries its own, so with the free tier spent
// qwen3.8-flash:free still answers 200. `quotaSpent.models` lists the models
// that were refused; only those sit the key out, every other model is still
// tried on it (once), and one that is refused joins the list.
const QUOTA_ERROR_CODES = new Set(['insufficient_quota', 'quota_exceeded']);

function readQuotaError(provider, r) {
  const adapter = (window.INTEGRATED_PROVIDERS || {})[provider.id];
  const info = { status: r.statusCode, code: r.errorCode, message: r.response };
  const own = adapter && adapter.readQuotaError ? adapter.readQuotaError(info) : null;
  if (own) return own;
  return QUOTA_ERROR_CODES.has(r.errorCode) ? { until: null, message: r.response } : null;
}

// A refusal that named no reset time is one model's answer on one day, not a
// fact about the key. Without an expiry it would sit on the key forever —
// Dark API's generic path (readQuotaError) never sets `until`, so a single
// exhausted route would read as a dead key for every restart after it.
const QUOTA_SPENT_TTL_MS = 24 * 60 * 60 * 1000;

function quotaSpentExpired(s) {
  return !s.until && s.at != null && Date.now() - s.at > QUOTA_SPENT_TTL_MS;
}

// The key has a spent allowance that has not reset yet (for some models).
function isKeySpent(k) {
  const s = k && k.quotaSpent;
  if (!s || quotaSpentExpired(s)) return false;
  return !s.until || s.until > Date.now();
}

// The whole key is spent: no model list, so every model sits it out.
function isKeyFullySpent(k) {
  return isKeySpent(k) && !(Array.isArray(k.quotaSpent.models) && k.quotaSpent.models.length > 0);
}

// Only the listed models were refused; the key still serves everything else.
// This is what the run already does (keysFor filters just these out) — the
// badge used to claim otherwise.
function isKeyPartiallySpent(k) {
  return isKeySpent(k) && !isKeyFullySpent(k);
}

// The key was refused this model for a spent allowance, and it hasn't reset.
function isKeySpentFor(k, modelId) {
  return isKeySpent(k) && Array.isArray(k.quotaSpent.models) && k.quotaSpent.models.includes(modelId);
}

// "5h 12m", "2d 3h", "40m" — time left until a future moment.
function formatIn(ts) {
  const m = Math.max(1, Math.round((ts - Date.now()) / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

function spentHint(k) {
  const s = k.quotaSpent;
  const reset = s.until ? `resets ${new Date(s.until).toLocaleString()} (in ${formatIn(s.until)})` : 'no reset time given (cleared after 24h)';
  const models = Array.isArray(s.models) && s.models.length ? s.models : null;
  return models
    ? `Quota used up for ${models.length} model${models.length === 1 ? '' : 's'} — ${reset}. Those are skipped on this key until then; other models are still tried.\n\n${models.join('\n')}`
    : `Quota used up — ${reset}.`;
}

// Records that the key was refused `modelId` for a spent allowance. Models
// refused earlier in the same period stay listed.
async function markKeySpent(pid, kid, quota, modelId) {
  const k = PROVIDERS[pid] && PROVIDERS[pid].keys.find((x) => x.id === kid);
  if (!k) return;
  const models = isKeySpent(k) && Array.isArray(k.quotaSpent.models) ? [...k.quotaSpent.models] : [];
  if (modelId && !models.includes(modelId)) models.push(modelId);
  k.quotaSpent = { until: quota.until || null, status: quota.status || null, message: quota.message || '', at: Date.now(), models };
  await saveProviderConfig(pid);
  refreshAfterKeyChange(pid);
}

async function clearKeySpent(pid, kid) {
  const k = PROVIDERS[pid] && PROVIDERS[pid].keys.find((x) => x.id === kid);
  if (!k || !k.quotaSpent) return;
  delete k.quotaSpent;
  await saveProviderConfig(pid);
  refreshAfterKeyChange(pid);
}

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
  // A key already refused this model for a spent quota sits out while another
  // can serve it. When every key is, the full list comes back and testModel
  // reports that.
  const unspent = keys.filter((k) => !isKeySpentFor(k, model.id));
  if (unspent.length > 0) keys = unspent;
  const permitted = keys.filter((k) => !deniedPairs.has(denialKey(k.id, model.id)));
  // If every key has been refused, hand back the full list so the caller still
  // gets a real error to report rather than "no key available".
  return permitted.length > 0 ? permitted : keys;
}

function slotsUsed(keyId, now) {
  return (keyRequestTimes.get(keyId) || []).filter((t) => now - t < 60000).length;
}

// The configured RPM is a starting guess — it comes from a provider's published
// figure, and a particular key's plan may allow less. Being refused is the only
// reliable measurement of what a key is really permitted, so a refusal narrows
// the budget for that key to below what it had just spent.
const learnedRpm = new Map(); // keyId -> the ceiling this key actually enforces

function budgetFor(provider, keyId) {
  const configured = rpmOf(provider);
  const learned = learnedRpm.get(keyId);
  if (!configured) return learned || 0;
  return learned ? Math.min(configured, learned) : configured;
}

// Called when the provider says the per-minute limit was reached. Whatever we
// managed to send in the preceding minute was over the line, so the new ceiling
// sits below it — and never below one, or the key would be unusable.
function learnRateLimit(keyId) {
  const sent = slotsUsed(keyId, Date.now());
  const next = Math.max(1, Math.floor((sent || 1) * 0.75));
  const prev = learnedRpm.get(keyId);
  if (!prev || next < prev) {
    learnedRpm.set(keyId, next);
    console.info(`Rate limit learned for key ${keyId}: ${next}/min (was sending ${sent})`);
  }
}

// Round-robin over the eligible keys, but a key with a free slot in its own
// minute beats one that is merely not cooling off. Without that preference the
// rotation would stop on a key that has spent its budget and wait there while a
// second key sat idle — which is the whole reason a second key is worth having.
function pickKey(provider, model) {
  const keys = keysFor(provider, model);
  if (keys.length === 0) return null;
  const now = Date.now();

  let free = null;  // usable right now
  let ready = null; // not cooling, but at its per-minute cap

  for (let i = 0; i < keys.length; i++) {
    const k = keys[(keyCursor + i) % keys.length];
    if ((keyCooldownUntil.get(k.id) || 0) > now) continue;
    const budget = budgetFor(provider, k.id);
    if (!budget || slotsUsed(k.id, now) < budget) { free = k; break; }
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
  const rpm = budgetFor(provider, key.id);
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

// Token count from whichever usage dialect came back: chat's prompt/completion,
// the images API's input/output, or a bare total.
function usageTokens(u = {}) {
  if (Number.isFinite(u.total_tokens)) return u.total_tokens;
  return (u.prompt_tokens || u.input_tokens || 0) + (u.completion_tokens || u.output_tokens || 0);
}

// A non-200 reply as a failed result. Some gateways send `error` as a string.
function failFromResponse(result, keyId) {
  let errMsg = `HTTP ${result.status}`;
  let errorCode = null; // machine-readable error.code (or .type), when the body has one
  try {
    const d = JSON.parse(result.body);
    errMsg = (typeof d.error === 'string' ? d.error : d.error?.message) || d.message || errMsg;
    if (d.error && typeof d.error === 'object') errorCode = d.error.code || d.error.type || null;
  } catch (_) {}
  const ra = parseInt(result.headers?.['retry-after'], 10);
  return { status: 'fail', response: errMsg, time: result.elapsed, tokens: 0, statusCode: result.status,
           retryAfter: isNaN(ra) ? 0 : ra, keyId, errorCode };
}

// A cancelled hedge loser or a transport failure, or null when a real HTTP
// reply came back. The handler resolves these so the message and the elapsed
// time survive the trip across IPC.
function transportFailure(result, keyId) {
  if (result.cancelled) return { status: 'fail', response: 'cancelled', time: result.elapsed || 0, tokens: 0, cancelled: true, keyId };
  if (result.networkError) {
    return { status: 'fail', response: result.error || 'Request failed', time: result.elapsed || 0,
             tokens: 0, networkError: true, timedOut: !!result.timedOut, keyId };
  }
  return null;
}

function authHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
}

// Providers found to have no dedicated image or video route this session. Many
// routers serve generators through /chat/completions only; once a provider says
// so, its generators go straight to chat instead of paying a 404 every time.
const mediaViaChat = new Set();
const mediaRouteKey = (providerId, kind) => `${providerId}|${kind}`;

// Whether a failed generation call means "this route does not exist here" (fall
// back to chat) rather than "this model failed" (report it). A 404 that names
// the model is a missing model, not a missing route.
function isMissingRoute(result, errMsg) {
  const routeWords = /endpoint|route|path|url|not supported|unsupported|not implemented/i;
  if (result.status === 405 || result.status === 501) return true;
  if (result.status === 404) return !/model/i.test(errMsg) || routeWords.test(errMsg);
  return result.status === 400 && routeWords.test(errMsg);
}

// First link to an asset anywhere in a JSON reply. Field names differ per
// gateway (url, video_url, output[0], data[0].url...), so keys that mention a
// url are searched before the rest.
function findAssetUrl(node, depth = 0) {
  if (node == null || depth > 5) return null;
  if (typeof node === 'string') return /^(https?:\/\/|data:(image|video)\/)/i.test(node) ? node : null;
  if (Array.isArray(node)) {
    for (const v of node) {
      const u = findAssetUrl(v, depth + 1);
      if (u) return u;
    }
    return null;
  }
  if (typeof node === 'object') {
    const entries = Object.entries(node).sort(([a], [b]) => /url/i.test(b) - /url/i.test(a));
    for (const [, v] of entries) {
      const u = findAssetUrl(v, depth + 1);
      if (u) return u;
    }
  }
  return null;
}

// The asset link inside a chat reply, markdown image syntax included.
function extractMediaUrl(text) {
  const m = /(https?:\/\/[^\s)"'<>\]]+|data:(?:image|video)\/[^\s)"'<>]+)/i.exec(text || '');
  return m ? m[1] : null;
}

// Asks the host what a link serves without downloading it: HEAD first, then a
// one-byte ranged GET for hosts (signed CDN links, mostly) that refuse HEAD.
// true/false is a verdict; null means the host would not say, and the caller
// falls back to the link itself.
async function verifyAsset(url, kind, headers = {}, requestId = null) {
  if (!settings.verifyAssets || !url) return null;
  const want = kind === 'video' ? 'video/' : 'image/';
  if (/^data:/i.test(url)) return url.slice(5).toLowerCase().startsWith(want);
  for (const [method, extra] of [['HEAD', {}], ['GET', { Range: 'bytes=0-0' }]]) {
    let res;
    try {
      // Logged under the attempt that produced the link (requestId's tags).
      res = await window.electronAPI.apiRequest({ url, method, headers: { ...headers, ...extra }, timeoutMs: 20000, ...routeTestTags(requestId) });
    } catch (_) {
      continue;
    }
    if (res.networkError || res.cancelled) continue;
    if ([403, 405, 501].includes(res.status)) continue;
    if (res.status >= 400) return false; // a dead link is not a working generator
    const type = String(res.headers?.['content-type'] || '').toLowerCase();
    if (!type || type.startsWith('application/octet-stream')) return null;
    return type.startsWith(want);
  }
  return null;
}

// Result fields for a generated asset: what the response column shows and, when
// the check could be made, whether the link really serves that kind of media.
async function assetResult(url, kind, headers, requestId = null) {
  const verified = await verifyAsset(url, kind, headers, requestId);
  const shown = /^data:/i.test(url) ? `Inline ${kind} · ${Math.round((url.length * 3) / 4 / 1024)} KB` : url;
  return typeof verified === 'boolean' ? { response: shown, assetVerified: verified } : { response: shown };
}

async function attemptImage(model, provider, key, requestId) {
  const { deadline } = kindLimits('image');
  const res = await window.electronAPI.apiRequest({
    url: `${provider.baseUrl}${provider.imageEndpoint || '/images/generations'}`,
    method: 'POST',
    headers: authHeaders(key.key),
    body: JSON.stringify({ model: model.id, prompt: settings.imagePrompt, n: 1 }),
    requestId,
    timeoutMs: deadline,
    ...routeTestTags(requestId),
  });
  const lost = transportFailure(res, key.id);
  if (lost) return lost;
  if (res.status !== 200) {
    const f = failFromResponse(res, key.id);
    return isMissingRoute(res, f.response) ? { routeMissing: true } : f;
  }

  const data = JSON.parse(res.body);
  const item = data.data?.[0] || {};
  const base = { keyId: key.id, status: 'pass', isEmpty: false, time: res.elapsed, tokens: usageTokens(data.usage) };
  if (item.b64_json) {
    return { ...base, response: `Inline image · ${Math.round((item.b64_json.length * 3) / 4 / 1024)} KB`, assetInline: true };
  }
  const url = item.url || findAssetUrl(data);
  if (!url) return { ...buildEmptyResult(data.usage || {}, res.elapsed), response: 'No image returned by provider', keyId: key.id };
  return { ...base, ...(await assetResult(url, 'image', undefined, requestId)) };
}

const JOB_DONE = new Set(['completed', 'succeeded', 'success', 'done', 'finished', 'ready']);
const JOB_FAILED = new Set(['failed', 'error', 'cancelled', 'canceled', 'rejected', 'expired']);

// Video is asynchronous: the create call returns a job, which is polled until it
// finishes. A gateway that answers synchronously with the asset skips the polling.
async function attemptVideo(model, provider, key, requestId) {
  const { deadline } = kindLimits('video');
  const endpoint = `${provider.baseUrl}${provider.videoEndpoint || '/videos'}`;
  const started = Date.now();
  const res = await window.electronAPI.apiRequest({
    url: endpoint,
    method: 'POST',
    headers: authHeaders(key.key),
    body: JSON.stringify({ model: model.id, prompt: settings.videoPrompt }),
    requestId,
    timeoutMs: deadline,
    ...routeTestTags(requestId),
  });
  const lost = transportFailure(res, key.id);
  if (lost) return lost;
  if (res.status < 200 || res.status >= 300) {
    const f = failFromResponse(res, key.id);
    return isMissingRoute(res, f.response) ? { routeMissing: true } : f;
  }

  let job = JSON.parse(res.body);
  const elapsed = () => Date.now() - started;
  const fail = (response, extra = {}) => ({ status: 'fail', response, time: elapsed(), tokens: 0, keyId: key.id, ...extra });

  while (true) {
    const state = String(job.status || '').toLowerCase();
    if (JOB_FAILED.has(state)) {
      return fail(`Video job ${state}${job.error ? `: ${job.error.message || job.error}` : ''}`);
    }
    const url = findAssetUrl(job);
    const done = JOB_DONE.has(state);
    if (done || (url && !state)) {
      const pass = { keyId: key.id, status: 'pass', isEmpty: false, time: elapsed(), tokens: usageTokens(job.usage) };
      if (url) return { ...pass, ...(await assetResult(url, 'video', undefined, requestId)) };
      // Finished without a link: the OpenAI shape serves the file from the job.
      const contentUrl = `${endpoint}/${encodeURIComponent(job.id)}/content`;
      const verified = await verifyAsset(contentUrl, 'video', { Authorization: `Bearer ${key.key}` }, requestId);
      return { ...pass, response: `Video ready · job ${job.id}`, ...(typeof verified === 'boolean' ? { assetVerified: verified } : {}) };
    }
    if (!job.id) return fail('Video job returned neither an id nor an asset');
    if (abortTesting) return fail('Aborted', { cancelled: true });
    if (elapsed() >= deadline) return fail(`Timed out while the video was ${state || 'pending'}`, { statusCode: 0, timedOut: true });

    await sleep(Math.max(1000, settings.videoPollMs));
    // A poll belongs to the same attempt: it carries the create call's tags.
    const pollId = nextRequestId(requestTags.get(requestId) || null);
    const poll = await window.electronAPI.apiRequest({
      url: `${endpoint}/${encodeURIComponent(job.id)}`,
      method: 'GET',
      headers: authHeaders(key.key),
      requestId: pollId,
      timeoutMs: 30000,
      ...routeTestTags(pollId),
    });
    if (poll.cancelled) return fail('cancelled', { cancelled: true });
    if (poll.networkError) continue; // one lost poll is not a failed job
    if (poll.status !== 200) return { ...failFromResponse(poll, key.id), time: elapsed() };
    job = JSON.parse(poll.body);
  }
}

// A decision model scores a typed question against a state. The wire protocol —
// body shape and answer parsing — belongs to the provider module (see the
// decision hooks in src/renderer/providers/*.js); this only drives the request
// and hands the score on for judging against decisionThreshold.
async function attemptDecision(model, provider, key, requestId) {
  const adapter = (window.INTEGRATED_PROVIDERS || {})[provider.id];
  if (!provider.decisionEndpoint || !adapter || !adapter.decisionProbe || !adapter.readDecisionAnswer) {
    return { status: 'fail', response: `${provider.name} declares no decision endpoint`, time: 0, tokens: 0, keyId: key.id };
  }
  const { deadline } = kindLimits('decision');
  const body = adapter.decisionProbe(model, { state: settings.decisionState, question: settings.decisionQuestion });
  const res = await window.electronAPI.apiRequest({
    url: `${provider.baseUrl}${provider.decisionEndpoint}`,
    method: 'POST',
    headers: authHeaders(key.key),
    body: JSON.stringify(body),
    requestId,
    timeoutMs: deadline,
    ...routeTestTags(requestId),
  });
  const lost = transportFailure(res, key.id);
  if (lost) return lost;
  if (res.status !== 200) return failFromResponse(res, key.id);

  const data = JSON.parse(res.body);
  const answered = adapter.readDecisionAnswer(data);
  if (!answered) {
    return { ...buildEmptyResult(data.usage || {}, res.elapsed), response: 'No probability returned by provider', keyId: key.id };
  }
  return {
    keyId: key.id,
    status: 'pass',
    isEmpty: false,
    response: answered.response,
    decisionScore: answered.score,
    time: res.elapsed,
    tokens: usageTokens(data.usage),
  };
}

// One single request. Returns a pass (content), an empty pass, or a fail carrying
// statusCode/retryAfter so the caller can decide whether to retry.
async function attemptOnce(model, provider, stream, requestId) {
  const key = pickKey(provider, model);
  if (!key) return { status: 'fail', response: 'All keys are rate limited', time: 0, tokens: 0, allKeysCooling: true };
  await waitForSlot(provider, key);
  if (abortTesting) return { status: 'fail', response: 'Aborted', time: 0, tokens: 0, cancelled: true };

  try {
    if (isDecision(model)) return await attemptDecision(model, provider, key, requestId);
    if (isMedia(model) && !mediaViaChat.has(mediaRouteKey(provider.id, model.kind))) {
      const tester = model.kind === 'video' ? attemptVideo : attemptImage;
      const r = await tester(model, provider, key, requestId);
      if (!r.routeMissing) return r;
      mediaViaChat.add(mediaRouteKey(provider.id, model.kind));
    }
  } catch (err) {
    return { status: 'fail', response: err.error || err.message || 'Request failed', time: err.elapsed || 0, tokens: 0,
             cancelled: !!err.cancelled, networkError: !err.cancelled, keyId: key.id };
  }
  return attemptChat(model, provider, stream, requestId, key);
}

// Chat completion — also the fallback route for a generator whose provider has
// no dedicated image or video endpoint.
async function attemptChat(model, provider, stream, requestId, key) {
  const apiKey = key.key;
  const baseUrl = provider.baseUrl;
  // reasoning_effort:'low' is sent to every model — it is a no-op on non-reasoning
  // models and clamps safely, but it makes reasoning-heavy models think briefly
  // instead of burning time on a deep chain for a trivial prompt. ('minimal' is
  // NOT safe — some models return empty under it — so 'low' is the floor.)
  const media = isMedia(model);
  const payload = {
    model: model.id,
    messages: [{
      role: 'user',
      content: model.kind === 'video' ? settings.videoPrompt : media ? settings.imagePrompt : testPrompt || DEFAULT_TEST_PROMPT,
    }],
    stream: !!stream,
  };
  // Newer OpenAI-compatible gateways rejected max_tokens in favour of
  // max_completion_tokens. Which one a provider accepts is learned from its own
  // 400 and remembered, so the swap costs one request per provider, once.
  payload[tokenLimitField(provider.id)] = settings.maxOutputTokens;
  // reasoning_effort steers a reasoning model away from a deep chain on a trivial
  // prompt. It means nothing to a generator, so it isn't sent to one.
  if (!media && !noReasoningEffort.has(reasoningKey(provider.id, model.id))) {
    payload.reasoning_effort = 'low';
  }

  try {
    const { deadline } = kindLimits(model.kind);
    const result = await window.electronAPI.apiRequest({
      url: `${baseUrl}/chat/completions`,
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      requestId,
      timeoutMs: deadline,
      ...routeTestTags(requestId),
    });

    // A cancelled hedge loser (raceAttempts skips those) or a transport failure.
    const lost = transportFailure(result, key.id);
    if (lost) return lost;

    // Usage some providers send on every answer (Token Harbor's allowance
    // headers) keeps the key's reading current without asking for it.
    if (window.KEY_USAGE) KEY_USAGE.observe(provider.id, key.id, result.headers);

    if (result.status === 200) {
      const parsed = stream ? parseStreamedCompletion(result.body) : parseChatCompletion(result.body);
      const usage = parsed.usage || {};
      if (!parsed.content) return { ...buildEmptyResult(usage, result.elapsed), keyId: key.id };
      const pass = {
        keyId: key.id,
        status: 'pass',
        response: parsed.content,
        isEmpty: false,
        time: result.elapsed,
        tokens: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
      };
      // A generator answering over chat still has to hand back a real asset.
      if (media) {
        const verified = await verifyAsset(extractMediaUrl(parsed.content), model.kind, {}, requestId);
        if (typeof verified === 'boolean') pass.assetVerified = verified;
      }
      return pass;
    }

    const failed = failFromResponse(result, key.id);
    const errMsg = failed.response;

    // "Unsupported parameter: max_tokens" and friends — switch the field and go
    // again rather than reporting a working model as broken.
    // A re-send after a rejected parameter is the same attempt, marked as one.
    const swapId = () => nextRequestId({ ...requestTags.get(requestId), paramSwap: true });
    if (result.status === 400 && /max_tokens|max_completion_tokens/i.test(errMsg)) {
      const swapped = swapTokenLimitField(provider.id);
      if (swapped) return attemptOnce(model, provider, stream, swapId());
    }
    if (result.status === 400 && payload.reasoning_effort && REASONING_REJECTED.test(errMsg)) {
      noReasoningEffort.add(reasoningKey(provider.id, model.id));
      return attemptOnce(model, provider, stream, swapId());
    }
    return failed;
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
function raceAttempts(model, provider, stream, count, tags = {}) {
  return new Promise((resolve) => {
    const ids = [];
    let pending = count;
    let best = null;
    let settled = false;
    const cancelRest = () => ids.forEach((id) => window.electronAPI.cancelApiRequest(id, 'hedge_lost'));

    for (let i = 0; i < count; i++) {
      const id = nextRequestId({ ...tags, hedgeIndex: i });
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
function adaptiveNonStream(model, provider, tags = {}) {
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

    // Why the attempts still running are cut, for the request log: a winner
    // makes them hedge losers, Stop is the user's, and the per-kind deadline
    // is recorded as a timeout.
    const cancelAll = (reason) => ids.forEach((id) => window.electronAPI.cancelApiRequest(id, reason));
    const finish = (r, reason = 'hedge_lost') => {
      if (settled) return;
      settled = true;
      clearTimeout(stepTimer);
      clearTimeout(deadlineTimer);
      cancelAll(reason);
      resolve(r);
    };

    // An extra attempt is only worth firing if a key can take it right now.
    // Hedging exists to get an answer sooner; queueing behind a per-minute cap to
    // send one does the opposite, and spends a slot the models still waiting need.
    const budgetFree = () =>
      keysFor(provider, model).some((k) => {
        const budget = budgetFor(provider, k.id);
        return !budget || slotsUsed(k.id, Date.now()) < budget;
      });

    const launch = (escalation = false) => {
      if (settled || stop || abortTesting || launched >= maxAttempts) return;
      if (escalation && !budgetFree()) {
        // No room to widen; check again after the usual interval.
        stepTimer = setTimeout(() => launch(true), settings.hedgeStepMs);
        return;
      }
      launched += 1;
      inflight += 1;
      const id = nextRequestId({ ...tags, hedgeIndex: launched - 1 });
      ids.push(id);
      attemptOnce(model, provider, false, id).then((r) => {
        inflight -= 1;
        if (settled) return;
        // Stop was pressed. Every attempt comes back `cancelled`, which sets
        // neither `stop` nor `best` — without this the promise would hang until
        // the 75s deadline and "Stopping..." would sit there for over a minute.
        if (abortTesting) return finish(best || { status: 'fail', response: 'Aborted', time: 0, tokens: 0 }, 'stop');
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
      if (!stop && launched < maxAttempts) stepTimer = setTimeout(() => launch(true), settings.hedgeStepMs);
    };

    deadlineTimer = setTimeout(
      () => finish(best || { status: 'fail', response: 'Timed out', time: deadline, tokens: 0, statusCode: 0, timedOut: true }, 'deadline'),
      deadline
    );

    launch();
  });
}

// ============================================
// Test a single model — adaptive hedge, handles reasoning, empty, rate limits
// ============================================
async function testModel(model, provider) {
  // One id per testModel call, so the log pages can draw its retry chain.
  const testGroup = newUlid();
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

    // Every key that could serve this model was already refused it for a spent
    // quota: say so, and when the first one resets, without sending anything.
    const candidates = keysFor(provider, model);
    if (candidates.length > 0 && candidates.every((k) => isKeySpentFor(k, model.id))) {
      const resets = candidates.map((k) => k.quotaSpent.until).filter(Boolean);
      const next = resets.length ? Math.min(...resets) : null;
      return done({
        status: 'fail', time: 0, tokens: 0, quotaSpent: true,
        response: `Quota used up for this model${next ? ` — resets ${new Date(next).toLocaleString()} (in ${formatIn(next)})` : ''}`,
      });
    }
    rounds += 1;

    const r = await adaptiveNonStream(model, provider, { testGroup, attempt: rounds });

    // A key that serves a model it had been refused has quota again (reset
    // early, topped up). Serving another model says nothing: that one may
    // draw on a different allowance.
    if (r.status === 'pass' && r.keyId && isKeySpentFor(provider.keys.find((k) => k.id === r.keyId), model.id)) {
      clearKeySpent(provider.id, r.keyId);
    }

    if (r.status === 'pass' && !r.isEmpty) return done(r);

    if (r.status === 'pass' && r.isEmpty) {
      // Generators and decision models don't stream text, so the SSE recovery
      // below would just buy a second generation (or decision) for nothing.
      if (isMedia(model) || isDecision(model)) return done(r);
      // Empty on the non-streaming endpoint: some models (byNara event-stream)
      // deliver content only over SSE — try streaming.
      if (abortTesting) return done(r);
      const streamed = await raceAttempts(model, provider, true, STREAM_HEDGE, { testGroup, attempt: rounds });
      if (streamed.status === 'pass' && !streamed.isEmpty) return done(streamed);
      // Both empty. Empty can be flaky, so retry the whole model once.
      if (!emptyRetried && !abortTesting) {
        emptyRetried = true;
        await sleep(500);
        continue;
      }
      return done(r);
    }

    // The key's quota for this model is spent. It is remembered (until the
    // reset) so later runs don't ask again, and this model moves on to another
    // key if there is one. Checked before the entitlement rule below, which
    // would forget it at the end of the run.
    const quota = r.status === 'fail' && r.keyId ? readQuotaError(provider, r) : null;
    if (quota && !abortTesting) {
      await markKeySpent(provider.id, r.keyId, { ...quota, status: r.statusCode }, model.id);
      if (keysFor(provider, model).some((k) => !isKeySpentFor(k, model.id))) continue;
      return done({ ...r, quotaSpent: true });
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
      if (r.keyId) {
        if (isRateLimit(r)) learnRateLimit(r.keyId);
        coolKeyDown(r.keyId, r);
      }
      continue;
    }
    if (isRateLimit(r)) {
      return done({
        ...r,
        response: `Still rate limited after ${rateLimitWaits} window${rateLimitWaits === 1 ? '' : 's'} — ${r.response}`,
      });
    }

    // A failure. Retry on transient errors (5xx/network) with backoff — except for
    // a decision call: it carries no idempotency guarantee, so a lost reply may
    // already have been served and billed, and a retry would pay for it twice.
    const retryable =
      !isDecision(model) && ((r.statusCode && RETRYABLE_STATUS.has(r.statusCode)) || r.networkError);
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
  resultsProvider = p.id;
  abortTesting = false;
  inflightIds.clear();
  // requestTags is intentionally not cleared here: a straggler from the run
  // that just ended still needs its captured tags (see requestTags above).
  // The run's id tags every request it sends and names its history run, so
  // the request log and the history agree on which run a request was part of.
  routeRun = { runId: newUlid(), trigger: scheduled ? 'scheduled' : 'manual' };
  keyCooldownUntil.clear();
  if (reset) learnedRpm.clear();
  if (reset) deniedPairs.clear();

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
    message = `Stopped — ${lastRun.done}/${lastRun.total} tested (${passed} passed, ${failed} failed)${answers}${delta}`;
  } else if (failed === 0) { state = 'done'; message = `All ${passed} models passed${answers}${delta}`; }
  else if (passed === 0) { state = 'error'; message = `All ${failed} models failed${delta}`; }
  else { state = c.broke.length ? 'error' : 'done'; message = `Done: ${passed} passed, ${failed} failed${answers}${delta}`; }

  // A failed history write must stay visible: persist() already reported it,
  // but this status runs right after and would otherwise overwrite it.
  if (lastRun.saved === false) { state = 'error'; message += ' · run not saved'; }
  setStatus(state, message);
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
  tr.innerHTML = buildRowHtml(model, result, tableRows.length);
  tbody.appendChild(tr);
  syncColumnVisibility();
}

const SORTERS = {
  status: (e) => ({ fail: 0, skipped: 1, queued: 2, running: 3, pass: e.result.isEmpty ? 4 : 5 })[e.result.status] ?? 6,
  model: (e) => e.model.id.toLowerCase(),
  context: (e) => contextOf(e.model) ?? -1,
  score: (e) => scoreOf(e.model),
  price: (e) => { const c = costOf(e.model); return c.in == null ? c.out : c.in; },
  latency: (e) => latencyOf(e.model),
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
      ({ model, result }, index) =>
        `<tr class="${rowClassFor(result)}" data-model-id="${escapeHtml(model.id)}">${buildRowHtml(model, result, index + 1)}</tr>`
    )
    .join('');
  syncColumnVisibility();
}

// Every provider shows the same columns, always. A column with no answers shows
// em-dashes, never folds away — so a thin provider reads the same table as a
// rich one. (TYPE stays hidden by CSS; it is not one of the table's columns.)
function syncColumnVisibility() {
  const table = $('#results-table');
  if (!table) return;
  table.classList.remove('hide-type', 'hide-context', 'hide-score', 'hide-price', 'hide-caps');
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

function toggleFailedFilter() {
  showFailedOnly = !showFailedOnly;
  updateStats();
  renderResultsTable();
}
$('#pt-kpis').addEventListener('click', (e) => {
  if (e.target.closest('[data-filter-failed]')) toggleFailedFilter();
});
$('#pt-kpis').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('[data-filter-failed]')) {
    e.preventDefault();
    toggleFailedFilter();
  }
});

const ptLegend = $('#pt-legend');
if (ptLegend) {
  ptLegend.addEventListener('click', (e) => {
    if (e.target.closest('[data-pt-legend-toggle], .mc-legend-head')) {
      ptLegendOpen = !ptLegendOpen;
      renderPtLegend();
    }
  });
}

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
  const idx = tableRows.findIndex((e) => e.model.id === model.id);
  tr.className = rowClassFor(result);
  tr.innerHTML = buildRowHtml(model, result, idx >= 0 ? idx + 1 : null);
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
  if (tableRows.length > 0) {
    renderResultsTable();
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
  const provModels = (p && p.models) || models || [];
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
  const indexNum = rowIndex || (tableRows.findIndex((e) => e.model.id === model.id) + 1) || 1;

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
  const total = runTotal ?? getSelectedModels().length;
  const passed = testResults.filter((r) => r.status === 'pass').length;
  const failed = testResults.filter((r) => r.status === 'fail').length;

  // Average latency measures speed, so only completed calls count. A 502 comes
  // back in ~0.3s and would otherwise drag the average down and make the
  // provider look faster than it actually is.
  const times = testResults.filter((r) => r.status === 'pass' && r.time).map((r) => r.time);
  const avg = times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : null;

  const fetched = models.length;
  const finished = passed + failed;
  $('#pt-kpis').innerHTML = statCardsHTML([
    { label: 'Models', value: total, sub: fetched ? `/ ${fetched}` : '', icon: KPI_ICON.layers,
      meter: fetched ? total / fetched : 0,
      foot: fetched === 0 ? 'fetch models to begin' : runTotal != null ? 'in this run' : 'selected for the next run' },
    { label: 'Passed', value: passed, sub: finished ? `/ ${finished}` : '', icon: KPI_ICON.check, tone: 'pass',
      meter: total ? passed / total : 0,
      foot: finished ? `${Math.round((passed / finished) * 100)}% of finished models` : 'no results yet' },
    { label: 'Failed', value: failed, sub: finished ? `/ ${finished}` : '', icon: KPI_ICON.cross, tone: 'fail',
      meter: total ? failed / total : 0,
      // The card doubles as the filter: it narrows the table to failures and back.
      attrs: failed || showFailedOnly
        ? `data-filter-failed role="button" tabindex="0" aria-pressed="${showFailedOnly}" title="Show only failed / empty responses"`
        : '',
      active: showFailedOnly,
      foot: showFailedOnly ? 'showing only failures — click to show all' : failed ? 'click to show only failures' : 'none failed' },
    { label: 'Average time', value: avg == null ? NA : avg < 1000 ? `${Math.round(avg)} ms` : `${(avg / 1000).toFixed(1)}s`, icon: KPI_ICON.clock,
      foot: 'passed calls only' },
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

function clearResults() {
  testResults = [];
  runTotal = null;
  lastRun = null;
  tableRows = [];
  sortKey = null;
  sortDir = 1;
  showFailedOnly = false;
  $$('#results-table th').forEach((el) => el.classList.remove('sort-asc', 'sort-desc'));
  $('#results-empty').style.display = '';
  $('#results-table').style.display = 'none';
  $('#results-body').innerHTML = '';
  updateStats();
  setStatus('idle', 'Ready');
  $('#progress-container').style.display = 'none';
}
$('#btn-clear-results').addEventListener('click', clearResults);

// Fixed names meant every export after the first landed as "(1)", "(2)" with no
// way to tell which provider or run it came from.
function exportFilename(ext) {
  const p = PROVIDERS[activeProvider];
  const slug = (p ? p.name : 'results').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `venom-router-${slug}-${stamp}.${ext}`;
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

  // A release is published before its notes are written, so an app that checks in
  // that window receives an empty body. Rather than a blank panel, say which case
  // it is: nothing arrived, or something arrived that parsed to nothing.
  const notesEl = $('#update-modal-notes');
  const raw = Array.isArray(info.releaseNotes)
    ? info.releaseNotes.map((n) => (typeof n === 'string' ? n : n?.note || '')).join(String.fromCharCode(10))
    : info.releaseNotes || '';

  if (raw.trim()) {
    const list = buildReleaseNotes(raw);
    // Both shapes the notes can arrive in reduce to a list. If even that comes
    // out empty, the text itself goes straight into the panel: never a second
    // framed, scrolling box inside the first.
    if (list.childElementCount > 0) notesEl.replaceChildren(list);
    else notesEl.textContent = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  } else {
    notesEl.textContent = 'Release notes were not published yet — see the release page on GitHub.';
  }

  $('#update-progress').style.display = 'none';
  $('#update-modal-download-btn').style.display = '';
  $('#update-modal-download-btn').disabled = false;
  $('#update-modal-download-btn').innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download Update`;
  $('#update-modal-install-btn').style.display = 'none';
  $('#update-modal-later-btn').style.display = '';
  $('#update-modal-later-btn').textContent = 'Remind Later';
  $('#update-modal-title').textContent = 'Update Available';
  $('#update-ready-note').hidden = true;

  $('#update-modal').style.display = 'flex';
}

function hideUpdateModal() {
  $('#update-modal').style.display = 'none';
  updateInfo = null;
}

// Release notes come from GitHub, so they are remote text rendered inside the
// app. They arrive in one of two shapes: the release body in Markdown (what
// main.js fetches from the API), or GitHub's own HTML rendering of it (what
// electron-updater reads from the releases feed, used when the API is out of
// reach). Both are reduced to the same items, a heading or an entry, and every
// item is built as DOM nodes with textContent: markup in a release can only
// ever be read as characters, never run.
function buildReleaseNotes(notes) {
  const items = /<(h[1-6]|ul|ol|li|p)\b[^>]*>/i.test(notes) ? notesFromHtml(notes) : notesFromMarkdown(notes);
  const list = document.createElement('ul');
  items.forEach((item) => {
    const li = document.createElement('li');
    if (item.heading) {
      li.className = `notes-heading ${item.level <= 2 ? 'notes-version' : 'notes-section'}`;
      li.textContent = item.text;
    } else {
      appendInlineMarkdown(li, item.text);
    }
    if (li.textContent.trim()) list.appendChild(li);
  });
  return list;
}

// Markdown: headings and bullets, with a bullet's wrapped lines joined back to
// it (the CHANGELOG wraps at 80 columns, and a line-by-line reading used to
// keep only the first line of every entry).
function notesFromMarkdown(md) {
  const items = [];
  let open = null;
  md.split(/\r?\n/).forEach((raw) => {
    const line = raw.trim();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    if (heading) {
      open = null;
      items.push({ heading: true, level: heading[1].length, text: heading[2].replace(/[*_`]/g, '') });
    } else if (bullet) {
      open = { text: bullet[1] };
      items.push(open);
    } else if (!line || line === '---' || /^\[[^\]]+\]:\s/.test(line)) {
      open = null;
    } else if (open) {
      open.text += ` ${line}`;
    } else {
      // A plain paragraph still says something; keep it as an entry.
      open = { text: line };
      items.push(open);
    }
  });
  return items;
}

// HTML: parsed into an inert document (DOMParser runs no scripts and loads
// nothing), then only headings and list items are read, as text, in order.
function notesFromHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const items = [];
  doc.body.querySelectorAll('h1, h2, h3, h4, h5, h6, li, p').forEach((el) => {
    // A paragraph inside a list item is part of that item.
    if (el.tagName === 'P' && el.closest('li')) return;
    const text = el.tagName === 'LI' ? inlineMarkdownOf(el) : el.textContent;
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    if (/^H[1-6]$/.test(el.tagName)) items.push({ heading: true, level: Number(el.tagName[1]), text: clean });
    else items.push({ text: clean });
  });
  return items;
}

// An HTML list item back to the small Markdown subset rendered below, so both
// shapes show bold and code the same way.
function inlineMarkdownOf(el) {
  let out = '';
  el.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) out += n.textContent;
    else if (n.nodeType === Node.ELEMENT_NODE) {
      if (/^(UL|OL)$/.test(n.tagName)) return; // nested lists are their own items
      const inner = inlineMarkdownOf(n);
      if (n.tagName === 'STRONG' || n.tagName === 'B') out += `**${inner}**`;
      else if (n.tagName === 'CODE') out += `\`${n.textContent}\``;
      else if (n.tagName === 'BR') out += ' ';
      else out += inner;
    }
  });
  return out;
}

// **bold**, *em* and `code` as elements; everything else as plain text.
function appendInlineMarkdown(parent, text) {
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    const tok = m[0];
    const el = document.createElement(tok.startsWith('**') ? 'strong' : tok.startsWith('`') ? 'code' : 'em');
    el.textContent = tok.startsWith('**') ? tok.slice(2, -2) : tok.slice(1, -1);
    parent.append(el);
    last = m.index + tok.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

function showDownloadProgress(percent) {
  $('#update-progress').style.display = '';
  $('#update-progress-bar').style.width = `${percent}%`;
  $('#update-progress-percent').textContent = `${percent}%`;
}

// The ready state is shown as the modal, not only as the badge: a download
// started from the badge never opened it, and the badge alone gave no hint that
// one more click was needed.
function showUpdateReady() {
  $('#update-modal-title').textContent = 'Update Ready';
  $('#update-ready-note').hidden = false;
  $('#update-progress').style.display = 'none';
  $('#update-modal-download-btn').style.display = 'none';
  $('#update-modal-later-btn').style.display = '';
  $('#update-modal-later-btn').textContent = 'Later';
  const install = $('#update-modal-install-btn');
  install.style.display = '';
  install.disabled = false;
  $('#update-modal').style.display = 'flex';
}

function installUpdateNow() {
  const install = $('#update-modal-install-btn');
  install.disabled = true;
  install.innerHTML = '<span class="spinner"></span> Restarting…';
  $('#update-modal-later-btn').style.display = 'none';
  window.electronAPI.updateAPI.installUpdate();
}

function setUpdateBadgeLabel(text) {
  const badge = $('#update-badge');
  badge.title = text;
  badge.setAttribute('aria-label', text);
}

function setupUpdateListeners() {
  if (!window.electronAPI || !window.electronAPI.updateAPI) return;
  const updateAPI = window.electronAPI.updateAPI;

  updateAPI.onUpdateChecking(() => console.log('Checking for updates...'));

  updateAPI.onUpdateAvailable((info) => {
    if (!isUpdateDownloading && !isUpdateReady) {
      const badge = $('#update-badge');
      badge.hidden = false;
      setUpdateBadgeLabel(`Update v${info.version} available — click to download`);
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
      $('#update-badge').classList.remove('update-downloading');
      setUpdateBadgeLabel('Update download failed — click to retry');
    }
  });

  updateAPI.onDownloadProgress((progress) => {
    showDownloadProgress(progress.percent);
    // The download may have been started from the modal, so the badge is put
    // into its downloading state here too.
    const badge = $('#update-badge');
    badge.classList.add('update-downloading');
    badge.style.setProperty('--progress', progress.percent);
    setUpdateBadgeLabel(`Downloading update… ${progress.percent}%`);
  });

  updateAPI.onUpdateDownloaded(() => {
    isUpdateDownloading = false;
    isUpdateReady = true;
    const badge = $('#update-badge');
    badge.classList.remove('update-downloading');
    badge.classList.add('update-ready');
    setUpdateBadgeLabel('Update ready — click to restart and install');
    showUpdateReady();
  });

  // Badge click handler
  $('#update-badge')?.addEventListener('click', () => {
    if (isUpdateReady) {
      showUpdateReady();
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

  $('#update-modal-install-btn')?.addEventListener('click', installUpdateNow);

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
  providersTab = 'connected';
  pvShell = null;
  pvExpanded.add(pid);
  refreshAfterKeyChange(pid);
  checkProviderHealth(pid);
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
// Each control binds a settings key to an input, converting where the stored
// unit and the displayed one differ (milliseconds stored, seconds shown).
const SETTING_INPUTS = [
  ['#set-max-tokens', 'maxOutputTokens', 'int'],
  ['#set-image-prompt', 'imagePrompt', 'text'],
  ['#set-video-prompt', 'videoPrompt', 'text'],
  ['#set-video-poll', 'videoPollMs', 'sec'],
  ['#set-verify-assets', 'verifyAssets', 'bool'],
  ['#set-decision-state', 'decisionState', 'text'],
  ['#set-decision-question', 'decisionQuestion', 'text'],
  ['#set-decision-threshold', 'decisionThreshold', 'ratio'],
  ['#set-deadline-decision', 'deadlineDecisionMs', 'sec'],
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
  ['#set-log-level', 'logLevel', 'text'],
  ['#set-log-retention', 'logRetentionDays', 'int'],
  ['#set-body-retention', 'bodyRetentionDays', 'int'],
  ['#set-stats-retention', 'statsRetentionMonths', 'int'],
  ['#set-concurrency', 'concurrency', 'int'],
  ['#set-health-interval', 'healthIntervalMin', 'int'],
  // Appearance switches that were in the markup and bound to nothing until now:
  // the setting was saved once and never read again, so flipping it changed
  // nothing at all. The lock screen's canvas is what reads it now.
  ['#set-reduce-motion', 'reduceMotion', 'bool'],
  // The app lock's idle limit. main keeps its own copy and re-reads this row on
  // every save (src/main.js idleLimitMs), so a change applies without a restart.
  ['#set-lock-idle', 'lockIdleMin', 'int'],
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
  renderDecisionThreshold();
  renderCostEstimate();
}

function renderDecisionThreshold() {
  $('#decision-threshold-value').textContent = settings.decisionThreshold.toFixed(2);
}

// The Test section holds one probe per model kind; only the chosen kind's
// fields are shown, so the page stays as short as the chat-only one was.
$('#test-kind-seg').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-kind]');
  if (!btn) return;
  $$('#test-kind-seg button').forEach((b) => {
    const on = b === btn;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  $$('#sec-test .test-pane').forEach((pane) => { pane.hidden = pane.dataset.kind !== btn.dataset.kind; });
});

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
        // The idle limit has a floor the app relies on: a saved 0 would mean
        // "never lock by idle" in src/auth, and the field offers no way to ask
        // for that. Clamping here keeps the stored row inside the range the
        // stepper shows.
        if (key === 'lockIdleMin') settings[key] = Math.min(480, Math.max(5, Math.round(n)));
        else settings[key] = kind === 'sec' ? Math.round(n * 1000) : kind === 'ratio' ? n : Math.round(n);
      }
      if (key === 'decisionThreshold') renderDecisionThreshold();
      if (key === 'healthIntervalMin') scheduleHealthMonitor();
      // Appearance keys repaint immediately; the rest of the row is a stored
      // value main reads on its next save-settings.
      if (key === 'reduceMotion') applyAppearance();
      queueSettingsSave();
      renderCostEstimate();
      // Colour bands and sparkline length change what is already on screen.
      if (tableRows.length > 0) renderResultsTable();
      // The catalog pins TIME as its Speed with the same colours: repaint it too.
      if (window.CATALOG && window.CATALOG.renderIfShown) window.CATALOG.renderIfShown();
    });
  });
}

// Hedging, retries and the schedule all multiply together, and the product is
// invisible while you are turning one knob. Saying it out loud is the difference
// between settings you can change and settings you can reason about.
// The run-cost note describes the settings that multiply requests, so it shows
// only beside them — and only once there is a selection to cost.
const COST_SECTIONS = ['sec-test', 'sec-schedule', 'sec-speed', 'sec-reliability'];

function renderCostEstimate() {
  const el = $('#settings-estimate');
  if (!el) return;
  const models = getSelectedModels().length;
  const section = document.querySelector('.settings-nav-item.active')?.dataset.section;
  el.hidden = models === 0 || !COST_SECTIONS.includes(section);
  if (models === 0) return;
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

// Swatches for both the Appearance page and the header popover.
function accentSwatchesHTML(cls, role) {
  return ACCENTS.map((a) => {
    const on = a.id === settings.accent;
    return `<button class="${cls} ${on ? 'active' : ''}" type="button" role="${role}" aria-checked="${on}"
             data-accent-id="${a.id}" title="${a.name}" aria-label="${a.name}"
             style="background:${a.hex};color:${a.hex}"></button>`;
  }).join('');
}

function renderAppearancePickers() {
  const theme = effectiveTheme();
  $$('#mode-grid .mode-card').forEach((card) => {
    const on = card.dataset.themeId === theme;
    card.classList.toggle('active', on);
    card.setAttribute('aria-checked', String(on));
  });
  $('#mode-grid').classList.toggle('following', settings.followSystem);
  $('#set-follow-system').checked = settings.followSystem;

  $('#accent-row').innerHTML = accentSwatchesHTML('accent-swatch', 'radio');
  $('#accent-name').textContent = accentLabel();

  $$('#density-seg button').forEach((b) => {
    const on = b.dataset.value === settings.density;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
}

function saveAppearance() {
  applyAppearance();
  queueSettingsSave();
  renderAppearancePickers();
  if (!$('#accent-pop').hidden) renderAccentPop();
}

$('#mode-grid').addEventListener('click', (e) => {
  const card = e.target.closest('.mode-card');
  if (!card) return;
  settings.theme = card.dataset.themeId;
  settings.followSystem = false;
  saveAppearance();
});

$('#set-follow-system').addEventListener('change', (e) => {
  settings.followSystem = e.target.checked;
  // Turning it off keeps the mode that is on screen rather than jumping back.
  if (!settings.followSystem) settings.theme = systemDark.matches ? 'vercel' : 'daylight';
  saveAppearance();
});

$('#density-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-value]');
  if (!b) return;
  settings.density = b.dataset.value;
  saveAppearance();
  if (tableRows.length > 0) renderResultsTable();
});

$('#btn-reset-appearance').addEventListener('click', () => {
  ['theme', 'followSystem', 'accent', 'density'].forEach((k) => { settings[k] = DEFAULT_SETTINGS[k]; });
  saveAppearance();
  if (tableRows.length > 0) renderResultsTable();
});

function setAccent(id) {
  if (!ACCENTS.some((a) => a.id === id)) return;
  settings.accent = id;
  saveAppearance();
}

function bindAccentSwatches(container) {
  container.addEventListener('click', (e) => {
    const sw = e.target.closest('[data-accent-id]');
    if (sw) setAccent(sw.dataset.accentId);
  });
}
bindAccentSwatches($('#accent-row'));

// Header accent picker. Built from ACCENTS, like the Settings row, so the two
// always offer the same colours.
function renderAccentPop() {
  $('#accent-pop-swatches').innerHTML = accentSwatchesHTML('hdr-swatch', 'menuitemradio');
}

function setAccentPopOpen(open) {
  $('#accent-pop').hidden = !open;
  $('#btn-accent').setAttribute('aria-expanded', String(open));
  if (open) renderAccentPop();
}

$('#btn-accent').addEventListener('click', (e) => {
  e.stopPropagation();
  setAccentPopOpen($('#accent-pop').hidden);
});
// Picking re-renders the swatches, detaching the clicked node; stopped here so
// the outside-click check below doesn't read it as a click outside and close
// the popover mid-comparison.
$('#accent-pop').addEventListener('click', (e) => e.stopPropagation());
bindAccentSwatches($('#accent-pop-swatches'));
document.addEventListener('click', (e) => {
  if (!$('#accent-pop').hidden && !e.target.closest('.hdr-accent')) setAccentPopOpen(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#accent-pop').hidden) {
    setAccentPopOpen(false);
    $('#btn-accent').focus();
  }
});

async function refreshLogInfo() {
  try {
    const info = await window.electronAPI.readLogInfo();
    const kb = info.size > 0 ? ` — ${(info.size / 1024).toFixed(0)} KB` : ' — empty';
    $('#log-path').textContent = info.path + kb;
  } catch (_) {}
}

function renderAbout() {
  $('#about-version').textContent = appVersion || '—';

  $('#about-providers').innerHTML = Object.values(PROVIDERS)
    .map((p) => {
      const n = (p.models || []).length;
      return `<div class="about-provider">
        <span class="about-provider-name">${escapeHtml(p.name)}</span>
        <span class="about-provider-meta">${n ? `${n} models` : 'not fetched'}</span>
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
  const targetId = sectionId || 'sec-appearance';
  const btn = $(`#settings-nav .settings-nav-item[data-section="${targetId}"]`);
  if (!btn) return;
  $$('#settings-nav .settings-nav-item').forEach((b) => {
    const on = b === btn;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  $$('.settings-section').forEach((sec) => { sec.hidden = sec.id !== targetId; });
  // The log's own numbers are read when its section opens, never in the
  // background.
  if (targetId === 'sec-logs' && window.LOGS) window.LOGS.health();
  // Same for the four sources: a report of what is on disk, drawn on entry, and
  // the only network call behind this section is the button's own.
  if (targetId === 'sec-catalog') renderCatalogSources();
  // The lock's own state is read on entry so the warning and the status line
  // reflect a password changed in another window, or a session that expired.
  if (targetId === 'sec-security') renderSecuritySection();

  // The page scrolls, not the card. A tab picked while scrolled down opens at
  // its own top, with the categories still stuck in place above the fold.
  const page = $('.page-settings');
  const grid = $('.settings-layout-grid');
  if (page && grid && !page.hidden) {
    const stick = parseFloat(getComputedStyle(page).paddingTop) || 0;
    const offset = grid.getBoundingClientRect().top - page.getBoundingClientRect().top;
    if (offset < stick) page.scrollTop += offset - stick;
  }

  const meta = SETTINGS_SECTIONS_META[targetId] || { label: 'Settings', desc: 'Configure application options' };
  const titleEl = $('#settings-main-head-title');
  const descEl = $('#settings-main-head-desc');
  if (titleEl) titleEl.textContent = meta.label;
  if (descEl) descEl.textContent = meta.desc;
  // The card's icon is the tab's own nav icon, so the two can't drift apart.
  const iconBox = $('#settings-main-head-icon');
  const navIcon = btn.querySelector('.settings-nav-icon');
  if (iconBox) iconBox.replaceChildren(...(navIcon ? [navIcon.cloneNode(true)] : []));

  renderSettingsCrumbs(meta.label);
  renderCostEstimate();
  if (currentPage === 'settings') syncRoute();
}

function prepareSettingsPage() {
  fillSettingsForm();
  renderAppearancePickers();
  refreshLogInfo();
  renderAbout();
  renderSecuritySection();
  if (window.CATALOG) window.CATALOG.fillSettings();
  const activeBtn = $('#settings-nav .settings-nav-item.active') || $('#settings-nav .settings-nav-item');
  if (activeBtn) {
    switchSettingsSection(activeBtn.dataset.section);
  } else {
    switchSettingsSection('sec-appearance');
  }
}

function openSettings() {
  showPage('settings');
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
  if (tableRows.length > 0) renderResultsTable();
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
  scheduleHealthMonitor();
  if (tableRows.length > 0) renderResultsTable();
  setStatus('done', 'Settings reset to defaults');
});


// App shell. Bound before init() so the nav responds while providers and
// history are still loading.
const PAGES = ['overview', 'providers', 'provider', 'catalog', 'database', 'history', 'monitor', 'settings'];
let currentPage = 'overview';

// Routes live in the URL hash (the page is loaded from file://, so real paths
// can't be used) and survive a reload: #/provider/<providerId>, #/settings/<section>.
function parseRoute() {
  const [page, sub] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  return { page: PAGES.includes(page) ? page : 'overview', sub: sub || '' };
}

function syncRoute() {
  let hash = `#/${currentPage}`;
  if (currentPage === 'provider' && activeProvider) hash += `/${encodeURIComponent(activeProvider)}`;
  if (currentPage === 'settings') {
    const btn = $('#settings-nav .settings-nav-item.active');
    if (btn) hash += `/${btn.dataset.section.replace(/^sec-/, '')}`;
  }
  // Test History's sub-route is its open tab. state.tab is closed over inside
  // the logs.js IIFE, so the module exposes a getter for it; without one this
  // would append the string "undefined". Monitoring has no sub-route.
  if (currentPage === 'history' && window.LOGS) hash += `/${window.LOGS.tab()}`;
  // replaceState: no hashchange event and no history stack to walk back through.
  // window. is required: the run-history Map above shadows the global `history`.
  if (location.hash !== hash) window.history.replaceState(null, '', hash);
}

function applyRoute() {
  const { page, sub } = parseRoute();
  // The provider page needs a provider; without one it is the Providers page.
  if (page === 'provider') {
    if (sub && PROVIDERS[sub]) openProviderPage(sub);
    else showPage('providers');
    return;
  }
  showPage(page);
  if (page === 'settings' && sub) switchSettingsSection(`sec-${sub}`);
}

const PAGE_META = {
  overview: { title: 'Overview', desc: 'Routing health — providers, models and test activity at a glance.' },
  providers: { title: 'Providers', desc: 'Connect providers and manage their keys and accounts.' },
  catalog: { title: 'Models Catalog', desc: 'Every model your connected providers offer — the pool the router draws from, scored and ranked.' },
  database: { title: 'Database', desc: 'Read-only explorer for the local app and request databases.' },
  history: { title: 'Test History', desc: 'Every request this app has sent, and the runs they belong to.' },
  monitor: { title: 'Monitoring', desc: 'Requests, errors, latency and cost over time.' },
  settings: { title: 'Settings', desc: 'Test prompt, scheduling, appearance and data.' },
};

// The header's icon is the page's own nav icon, so the two can't drift apart.
function renderPageHeader(page) {
  // The provider page is a child of Providers: it wears that page's icon, and
  // its title is the provider it shows.
  const p = page === 'provider' ? PROVIDERS[activeProvider] : null;
  const meta = p
    ? { title: p.name, desc: `Test the models ${p.name} offers, and manage its keys.` }
    : PAGE_META[page];
  $('#shell-page-title').textContent = meta.title;
  $('#shell-page-desc').textContent = meta.desc;
  const navPage = page === 'provider' ? 'providers' : page;
  const icon = document.querySelector(`.shell-nav-item[data-page="${navPage}"] .shell-nav-icon`);
  const box = $('#shell-page-icon');
  box.replaceChildren();
  if (icon) box.appendChild(icon.cloneNode(true));
  document.title = `${meta.title} — VENOM Router`;
}

function showPage(page) {
  if (!PAGES.includes(page)) return;
  currentPage = page;
  $$('.shell-page').forEach((el) => { el.hidden = el.dataset.page !== page; });
  $$('.shell-nav-item[data-page]').forEach((el) => {
    const on = el.dataset.page === (page === 'provider' ? 'providers' : page);
    el.classList.toggle('active', on);
    if (on) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
  renderPageHeader(page);
  if (page === 'provider') {
    renderProviderHead();
    updateStats();
    renderPtLegend();
  }
  if (page === 'settings') prepareSettingsPage();
  if (page === 'catalog' && window.CATALOG) (window.CATALOG.open ? window.CATALOG.open() : window.CATALOG.render());
  if (page === 'database' && window.DATABASE) window.DATABASE.render();
  if (page === 'history' && window.LOGS) window.LOGS.render();
  if (page === 'monitor' && window.LOGS) window.LOGS.renderMonitor();
  // Leaving Test History has to stop its live tail; nothing else tells it the
  // page is gone, and it would keep querying the log every two seconds.
  if (page !== 'history' && window.LOGS) window.LOGS.sync();
  // The Providers page always opens on what is already connected.
  if (page === 'providers') {
    providersTab = 'connected';
    pvShell = null;
    pvState.view = COMPACT_LAYOUT.matches ? 'cards' : 'table';
    renderProvidersPage();
  }
  syncRoute();
}

// ============================================
// Sidebar ambience — moving stars and the signature heart
// ============================================
// A second, living layer over the sidebar's painted starfield (which stays as
// it is): a few faint stars that twinkle while they rise slowly, and now and
// then a shooting star. Positions come from a fixed seed, so the sky is the
// same every launch. Everything sits under the content, at low opacity.
function mountSidebarStars() {
  const nav = document.querySelector('.shell-nav');
  if (!nav || nav.querySelector('.shell-stars')) return;
  let seed = 20260926;
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const sky = document.createElement('div');
  sky.className = 'shell-stars';
  sky.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 16; i++) {
    const star = document.createElement('span');
    star.className = 'shell-star';
    const size = (1 + rand() * 1.4).toFixed(2);
    star.style.cssText = [
      `left:${(8 + rand() * 84).toFixed(1)}%`,
      `bottom:${(4 + rand() * 88).toFixed(1)}%`,
      `--size:${size}px`,
      `--rise:${(-18 - rand() * 26).toFixed(0)}px`,
      `--drift:${(16 + rand() * 14).toFixed(1)}s`,
      `--twinkle:${(2.4 + rand() * 2.8).toFixed(2)}s`,
      `--delay:${(-rand() * 20).toFixed(2)}s`,
      `--peak:${(0.35 + rand() * 0.45).toFixed(2)}`,
    ].join(';');
    if (rand() < 0.4) star.classList.add('tinted');
    star.appendChild(document.createElement('i'));
    sky.appendChild(star);
  }
  const meteor = document.createElement('span');
  meteor.className = 'shell-meteor';
  sky.appendChild(meteor);
  nav.prepend(sky);
}

// The heart answers a click: a big beat, and a burst of small hearts and
// sparks that fly out and fade. Reduced motion keeps only a gentle beat.
function bindSignatureHeart() {
  const heart = document.querySelector('.shell-heart');
  if (!heart) return;
  heart.setAttribute('tabindex', '0');
  heart.setAttribute('role', 'button');
  heart.setAttribute('aria-label', 'Crafted with love');
  const mini = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-10-9.3C.3 8.4 2.1 4.5 5.9 4.1c2.3-.2 4.3 1 5.4 2.9h1.4c1.1-1.9 3.1-3.1 5.4-2.9 3.8.4 5.6 4.3 3.9 7.6C19.5 16.4 12 21 12 21z"/></svg>';
  const burst = () => {
    heart.classList.remove('pop');
    void heart.getBoundingClientRect(); // restart the animation on a quick second click
    heart.classList.add('pop');
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const r = heart.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const n = 12;
    for (let i = 0; i < n; i++) {
      const p = document.createElement('span');
      const isHeart = i % 3 !== 2;
      p.className = `heart-particle${isHeart ? '' : ' spark'}`;
      if (isHeart) p.innerHTML = mini;
      // Spread over the upper half-circle, so the burst rises out of the footer.
      const angle = Math.PI + (Math.PI * (i + 0.5)) / n + (Math.random() - 0.5) * 0.35;
      const dist = 34 + Math.random() * 38;
      p.style.cssText = [
        `left:${cx}px`, `top:${cy}px`,
        `--dx:${(Math.cos(angle) * dist).toFixed(1)}px`,
        `--dy:${(Math.sin(angle) * dist).toFixed(1)}px`,
        `--rot:${((Math.random() - 0.5) * 70).toFixed(0)}deg`,
        `--scale:${(0.55 + Math.random() * 0.6).toFixed(2)}`,
        `--dur:${(750 + Math.random() * 450).toFixed(0)}ms`,
      ].join(';');
      p.addEventListener('animationend', () => p.remove(), { once: true });
      document.body.appendChild(p);
    }
  };
  heart.addEventListener('click', burst);
  heart.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); burst(); } });
  heart.addEventListener('animationend', (e) => { if (e.animationName === 'shell-heart-pop') heart.classList.remove('pop'); });
}

function bindShell() {
  mountSidebarStars();
  bindSignatureHeart();
  const shell = $('#shell');
  renderPageHeader(currentPage);
  $('#btn-theme-toggle').addEventListener('click', toggleTheme);
  // Empty-state buttons on the Overview lead to where runs happen.
  $('.page-overview').addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) showPage(go.dataset.go);
  });
  // The status strip leads to where provider health is shown per provider.
  $('#shell-status').addEventListener('click', () => showPage('providers'));
  $$('.shell-nav-item[data-page]').forEach((el) => {
    el.addEventListener('click', () => showPage(el.dataset.page));
  });

  // Collapsed nav (narrow window): a drawer opened from the top bar's menu button.
  const menuBtn = $('#shell-menu-btn');
  const setNavOpen = (open) => {
    shell.classList.toggle('nav-open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
    menuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  };
  menuBtn.addEventListener('click', () => setNavOpen(!shell.classList.contains('nav-open')));
  $('#shell-nav-close').addEventListener('click', () => setNavOpen(false));
  $('#shell-backdrop').addEventListener('click', () => setNavOpen(false));
  shell.querySelectorAll('.shell-nav-item:not(:disabled)').forEach((el) => {
    el.addEventListener('click', () => setNavOpen(false));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && shell.classList.contains('nav-open')) setNavOpen(false);
  });
  // Widening past the breakpoint turns the drawer back into a rail; a drawer
  // left "open" would reappear with its backdrop the next time it narrows.
  window.matchMedia('(max-width: 1100px)').addEventListener('change', (mq) => {
    if (!mq.matches) setNavOpen(false);
  });

  // "2h ago" goes stale.
  setInterval(renderQuickStats, 60000);
}

function formatAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Quick Stats (nav) and the Overview KPIs come from real state: configured
// providers, the health probes, and the run history.
function renderQuickStats() {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  let last = 0;
  history.forEach((runs) => {
    const at = runs.length ? runs[runs.length - 1].at : 0;
    if (at > last) last = at;
  });
  const ids = Object.keys(PROVIDERS);
  const lastText = last ? formatAgo(last) : 'Never';
  set('stat-providers', ids.length);
  set('stat-models', history.size);
  set('stat-last-check', lastText);
  set('ov-providers', ids.length);
  set('ov-models', history.size);
  set('ov-last', lastText);
  const states = ids.map((id) => (providerHealth.get(id) || {}).state);
  const testable = states.filter((st) => st && st !== 'none').length;
  set('ov-online', testable ? `${states.filter((st) => st === 'ok').length}/${testable}` : '—');
  renderSystemLamp();
  renderOverviewPanels();
}

function scoreClass(rate) {
  if (rate >= 0.9) return '';
  return rate >= 0.6 ? 'low' : 'bad';
}

// Overview: daily pass rate for the last 14 days, and the latest runs.
function renderOverviewPanels() {
  const trend = document.getElementById('ov-trend');
  const activity = document.getElementById('ov-activity');
  if (!trend || !activity) return;

  if (runLog.length === 0) {
    const empty = '<div class="ov-empty">No test runs recorded yet.' +
      '<button class="btn btn-ghost" type="button" data-go="providers">Open Providers</button></div>';
    trend.innerHTML = empty;
    activity.innerHTML = empty;
    $('#ov-trend-meta').textContent = '';
    $('#ov-activity-meta').textContent = '';
    return;
  }

  const DAY = 86400000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = [];
  for (let d = 13; d >= 0; d--) days.push({ start: today.getTime() - d * DAY, passed: 0, total: 0, runs: 0 });
  runLog.forEach((r) => {
    const idx = Math.floor((r.at - days[0].start) / DAY);
    if (idx < 0 || idx > 13) return;
    days[idx].passed += r.passed;
    days[idx].total += r.total;
    days[idx].runs += 1;
  });
  const fmt = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  trend.innerHTML = '<div class="ov-trend-bars">' + days.map((d) => {
    if (d.total === 0) return `<div class="ov-trend-bar empty" title="${fmt(d.start)} · no runs"><span></span></div>`;
    const rate = d.passed / d.total;
    const pct = Math.round(rate * 100);
    return `<div class="ov-trend-bar ${scoreClass(rate)}" title="${fmt(d.start)} · ${pct}% pass · ${d.runs} run${d.runs === 1 ? '' : 's'}">` +
      `<span style="height:${Math.max(4, pct)}%"></span></div>`;
  }).join('') + '</div>' +
    `<div class="ov-trend-axis"><span>${fmt(days[0].start)}</span><span>Today</span></div>`;
  const totals = days.reduce((a, d) => ({ p: a.p + d.passed, t: a.t + d.total }), { p: 0, t: 0 });
  $('#ov-trend-meta').innerHTML = totals.t ? `<b>${Math.round((totals.p / totals.t) * 100)}%</b> overall` : 'No runs in this window';

  const recent = runLog.slice(-6).reverse();
  activity.innerHTML = recent.map((r) => {
    const rate = r.total ? r.passed / r.total : 0;
    return `<div class="ov-activity-row">
      <span class="ov-activity-name">${escapeHtml(r.providerName)}</span>
      <span class="ov-activity-score ${scoreClass(rate)}">${r.passed}/${r.total}</span>
      <span class="ov-activity-when">${formatAgo(r.at)}</span>
    </div>`;
  }).join('');
  $('#ov-activity-meta').textContent = `${runLog.length} total`;
}

// Overall system status strip in the nav, summarised from the health probes:
// green when every testable provider answers, red when any doesn't. The detail
// lives in the tooltip.
// Providers without a key are left out: they can't be down, only unconfigured.
function renderSystemLamp() {
  const box = document.getElementById('shell-status');
  if (!box) return;
  const ids = Object.keys(PROVIDERS);
  const states = ids.map((id) => (providerHealth.get(id) || {}).state || 'pending');
  const failed = ids.filter((_, i) => states[i] === 'fail').map((id) => PROVIDERS[id].name);
  const checked = states.filter((st) => st === 'ok' || st === 'fail').length;
  const testable = states.filter((st) => st !== 'none').length;

  let state;
  let text;
  if (!navigator.onLine) {
    state = 'fail';
    text = 'Offline — no network connection';
  } else if (ids.length === 0 || testable === 0) {
    state = 'idle';
    text = 'No provider keys configured';
  } else if (checked < testable) {
    state = 'pending';
    text = `Checking providers… ${checked}/${testable}`;
  } else if (failed.length === 0) {
    state = 'ok';
    text = `All ${testable} providers online`;
  } else if (failed.length === testable) {
    state = 'fail';
    text = 'All providers unreachable';
  } else {
    state = 'fail';
    text = failed.length === 1 ? `${failed[0]} is unreachable` : `${failed.length} providers unreachable`;
  }
  box.dataset.state = state;
  const label = state === 'ok' ? 'All systems operational' : text;
  box.title = failed.length > 1 ? `${label}: ${failed.join(', ')}` : label;
  box.setAttribute('aria-label', box.title);
}

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
let providersTab = 'connected';

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
  const title = el.dataset.copyTitle || el.title;
  el.dataset.copyTitle = title;
  el.classList.add('copied');
  el.title = 'Copied';
  clearTimeout(Number(el.dataset.copyTimer));
  el.dataset.copyTimer = String(setTimeout(() => {
    el.classList.remove('copied');
    el.title = title;
  }, 1200));
}

function isConnected(p) {
  return p.keys.length > 0;
}

// The provider's own site: meta.website if the module gives one, otherwise the
// registrable part of the API host. Local and bare-IP endpoints have none.
function providerWebsite(p) {
  if (p.website) return p.website;
  try {
    const host = new URL(p.baseUrl).hostname;
    if (host === 'localhost' || /^[\d.]+$/.test(host) || host.includes(':')) return null;
    return `https://${providerHost(p)}`;
  } catch (_) {
    return null;
  }
}

function websiteLinkHTML(p) {
  const url = providerWebsite(p);
  if (!url) return '';
  return `<button class="pv-site" type="button" data-site="${escapeHtml(url)}" title="Open ${escapeHtml(url.replace(/^https?:\/\//, ''))}" aria-label="Open the ${escapeHtml(p.name)} website">` +
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg></button>';
}

function providerHost(p) {
  try {
    return new URL(p.baseUrl).hostname.replace(/^(api|router|www)\./, '');
  } catch (_) {
    return 'custom';
  }
}

// Numbers for a card, all from real state: keys, models with recorded runs,
// and the all-time pass rate of this provider's runs.
function providerStats(p) {
  const prefix = `${p.id}::`;
  let models = 0;
  history.forEach((_, key) => { if (key.startsWith(prefix)) models += 1; });
  const runs = runLog.filter((r) => r.provider === p.id);
  const total = runs.reduce((n, r) => n + r.total, 0);
  const passed = runs.reduce((n, r) => n + r.passed, 0);
  return {
    keys: p.keys.length,
    activeKeys: usableKeys(p).length,
    models,
    rate: total ? Math.round((passed / total) * 100) : null,
    runs: runs.length,
  };
}

// The same four capabilities on every card, lit when the provider module has
// them and dimmed when it doesn't, so cards line up and can be compared at a
// glance. The tooltip says what each one means for the models and runs.
function providerCapabilities(p) {
  const adapter = (window.INTEGRATED_PROVIDERS || {})[p.id];
  const rpm = rpmOf(p);
  return [
    {
      label: 'OpenAI API', icon: PV_ICON.api, tone: 'accent', on: true,
      tip: 'OpenAI API: models are listed from /models and tested on /chat/completions.',
    },
    {
      label: 'Filtered', icon: PV_ICON.spark, tone: 'green', on: Boolean(adapter && adapter.fetchModels),
      tip: (on) => on
        ? "Filtered: the model list follows this provider's own rules (free-only models, plan tiers, access grants) instead of everything /models returns."
        : 'Not filtered: every model /models returns is listed.',
    },
    // The plan slot. A module that publishes its own billing plan names it
    // here ("$5.50 / week") instead of the generic "Plans" — one slot, not
    // two, so every card keeps the same four badges and the 2x2 grid holds.
    p.billing ? {
      label: p.billing.plan, icon: PV_ICON.layers, tone: 'amber', on: true,
      tip: `${p.billing.usageLabel || 'Provider plan'}: ${p.billing.plan}.${p.plansUrl ? ' Each key sees the models of its own plan.' : ''}`,
    } : {
      label: 'Plans', icon: PV_ICON.layers, tone: 'amber', on: Boolean(p.plansUrl),
      tip: (on) => on
        ? 'Plans: each key sees the models of its own plan, so two keys here can list different models.'
        : 'No plans: every key sees the same models.',
    },
    {
      label: p.unlimitedUsage ? 'Unlimited' : 'Rate limit', icon: PV_ICON.gauge, tone: p.unlimitedUsage ? 'green' : 'violet', on: p.unlimitedUsage || rpm > 0,
      tip: p.unlimitedUsage
        ? 'Unlimited usage: this provider publishes no request-rate limit. Runs are not paced.'
        : rpm > 0
          ? `Rate limit: ${rpm} requests per minute. Test runs are paced to stay under it.`
          : 'No published rate limit: test runs are not paced.',
    },
  ];
}

function providerTags(p) {
  return providerCapabilities(p).map((c) => {
    const tip = typeof c.tip === 'function' ? c.tip(c.on) : c.tip;
    // Rate limit carries an info button: the full picture needs more room
    // than a tooltip.
    const info = (c.label === 'Rate limit' || c.label === 'Unlimited')
      ? `<button class="pv-cap-info" type="button" data-rl-info="${escapeHtml(p.id)}" title="Usage and rate details" aria-label="Usage and rate details for ${escapeHtml(p.name)}" aria-haspopup="dialog">${RL_ICON.info}</button>`
      : '';
    return `<span class="pv-tag pv-cap t-${c.tone}${c.on ? '' : ' is-off'}" title="${escapeHtml(tip)}">${c.icon}${c.label}${info}</span>`;
  }).join('');
}

// ---------- Rate limit details (the badge's info button) ----------
// What the app does (its pace, and what happens on a 429) comes from app
// state; what the provider publishes comes from the module's meta.rateLimits
// ({ source?, lines: [{ label, value }] }).
const RL_ICON = {
  info: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><line x1="12" y1="11" x2="12" y2="16.5"/><line x1="12" y1="7.5" x2="12.01" y2="7.5"/></svg>',
  close: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  link: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>',
};

let rlPopOpener = null;

function rateLimitPopHTML(p) {
  const rpm = rpmOf(p);
  const doc = p.rateLimits || null;
  const pace = p.unlimitedUsage
    ? `<p class="rl-pace"><b>Unlimited</b> — no request-rate limit is published for the ${escapeHtml(p.unlimitedUsage.label || 'plan').toLowerCase()}.</p>`
    : rpm
      ? `<p class="rl-pace"><b>${rpm} requests/min</b> per key — runs are paced to stay under it.</p>`
      : '<p class="rl-pace"><b>Not paced</b> — this provider publishes no rate limit.</p>';
  const lines = doc && Array.isArray(doc.lines) && doc.lines.length
    ? `<h5 class="rl-sub">Published limits</h5><dl class="rl-list">${doc.lines.map((l) => `<dt>${escapeHtml(l.label)}</dt><dd>${escapeHtml(l.value)}</dd>`).join('')}</dl>`
    : '';
  const source = doc && doc.source
    ? `<button class="rl-source" type="button" data-rl-site="${escapeHtml(doc.source)}">${RL_ICON.link}${escapeHtml(doc.source.replace(/^https?:\/\//, ''))}</button>`
    : '';
  return `<div class="rl-head">
      <span class="rl-title">Rate limit · ${escapeHtml(p.name)}</span>
      <button class="rl-close" type="button" data-rl-close title="Close" aria-label="Close">${RL_ICON.close}</button>
    </div>
    ${pace}
    ${lines}
    <h5 class="rl-sub">Usage</h5>
    <p class="rl-note">${p.unlimitedUsage ? `${escapeHtml(p.unlimitedUsage.range)} · ${escapeHtml(p.unlimitedUsage.detail)}.` : 'This provider does not expose a normalized usage reading here.'}</p>
    ${p.unlimitedUsage ? '' : '<h5 class="rl-sub">If the provider refuses (HTTP 429)</h5><p class="rl-note">The run waits for its Retry-After (or a full minute), lowers that key\'s pace to what it actually allowed, and moves on to another key if there is one. Being throttled is never recorded as the model failing.</p>'}
    ${source}`;
}

function openRateLimitPop(btn) {
  const p = PROVIDERS[btn.dataset.rlInfo];
  if (!p) return;
  let pop = document.getElementById('rl-pop');
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'rl-pop';
    pop.className = 'rl-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Rate limit details');
    document.body.appendChild(pop);
    pop.addEventListener('click', (e) => {
      const site = e.target.closest('[data-rl-site]');
      if (site) window.electronAPI.openExternal(site.dataset.rlSite);
      if (e.target.closest('[data-rl-close]')) closeRateLimitPop();
    });
  }
  pop.innerHTML = rateLimitPopHTML(p);
  pop.hidden = false;
  // Below the button, kept inside the window; above it when there's no room.
  const r = btn.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
  const below = r.bottom + 8;
  const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 8) : below;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  rlPopOpener = btn;
  btn.setAttribute('aria-expanded', 'true');
  pop.querySelector('.rl-close').focus();
}

function closeRateLimitPop() {
  const pop = document.getElementById('rl-pop');
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  if (rlPopOpener && document.contains(rlPopOpener)) {
    rlPopOpener.setAttribute('aria-expanded', 'false');
    rlPopOpener.focus();
  }
  rlPopOpener = null;
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-rl-info]');
  if (btn) {
    e.stopPropagation();
    const pop = document.getElementById('rl-pop');
    if (pop && !pop.hidden && rlPopOpener === btn) closeRateLimitPop();
    else openRateLimitPop(btn);
    return;
  }
  if (!e.target.closest('#rl-pop')) closeRateLimitPop();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRateLimitPop(); });
window.addEventListener('resize', closeRateLimitPop);
document.addEventListener('scroll', closeRateLimitPop, true);

function providerMark(p, cls = '') {
  // logoTone (module meta) says how a mark drawn for a dark surface is re-inked
  // on the light theme: 'mono' goes to the text colour, 'bright' is deepened.
  const tone = p.logoTone ? ` data-tone="${escapeHtml(p.logoTone)}"` : '';
  return p.logo
    ? `<img src="${escapeHtml(p.logo)}" alt="" class="${cls}"${tone}>`
    : `<span class="pv-dot ${cls}" style="background:${escapeHtml(p.color || 'var(--accent)')}"></span>`;
}

function providerHealthLine(p) {
  if (!isConnected(p)) return { state: 'none', text: 'Not connected — needs an API key' };
  const h = providerHealth.get(p.id);
  if (!h) return { state: 'pending', text: 'Checking connection…' };
  if (h.state === 'ok') return { state: 'ok', text: h.detail.replace('Connected', 'Reachable') };
  if (h.state === 'none') return { state: 'none', text: 'No active key' };
  return { state: h.state, text: h.detail };
}

function providerStatusHTML(p) {
  const health = providerHealthLine(p);
  const h = providerHealth.get(p.id);
  const title = h ? `${health.text} — checked ${new Date(h.checkedAt).toLocaleTimeString()}` : health.text;
  // A provider's badge stands alone: the words are for its keys, where they
  // tell one key's problem from another's.
  return statusPillHTML(health.state, health.text, title, { caption: false });
}

// Inline dot beside a provider's name on the Catalog and Profiles pages, so a
// provider going down shows there too without opening Providers.
function healthDotHTML(p) {
  if (!p) return '';
  const h = providerHealthLine(p);
  return `<span class="pv-health pv-health-inline" data-health="${h.state}" title="${escapeHtml(h.text)}"></span>`;
}

// Integrated cards are a catalogue of what can be connected: who the provider
// is and a Connect button, nothing operational. Keys, models, pass rate and
// health belong to the Connected tab, which a provider moves to once it has a
// working key.
function providerCardHTML(p, mode) {
  const connected = isConnected(p);
  const id = escapeHtml(p.id);
  const open = mode === 'connected' && pvExpanded.has(p.id);
  const primary = mode === 'connected'
    ? `<button class="btn ${open ? 'btn-ghost' : 'btn-primary'} pv-primary" type="button" data-kx-toggle="${id}" aria-expanded="${open}">${PV_ICON.keys}${open ? 'Hide keys' : 'Manage keys'}</button>`
    : connected
      ? `<button class="btn pv-primary pv-primary-done" type="button" disabled aria-disabled="true" title="${escapeHtml(p.name)} is already connected">${PV_ICON.check}Already connected</button>`
      : `<button class="btn btn-primary pv-primary" type="button" data-connect="${id}">${PV_ICON.plug}Connect</button>`;
  const actions = mode === 'connected'
    ? `<button class="pv-link" type="button" data-connect="${id}">${PV_ICON.plus}Add key</button>
       <span class="pv-link-group">
         ${recheckButtonHTML(p, 'link')}
         <button class="pv-icon-btn" type="button" data-manage="${id}" title="Test models" aria-label="Test ${escapeHtml(p.name)} models">${PV_ICON.flask}</button>
       </span>`
    : connected
      ? ''
      : '<span class="pv-hint">Bring an API key to start testing.</span>';
  const stats = mode === 'connected' ? providerStatsHTML(p) : '';

  const types = providerTypes(p);
  return `<article class="pv-card ${connected ? 'is-connected' : ''} ${open ? 'open' : ''}" data-provider="${id}" style="--type-stripe:${typeStripe(types)}">
    <div class="pv-watermark" data-provider="${id}" aria-hidden="true">${providerMark(p)}</div>
    <div class="pv-card-top">
      ${providerLogoHTML(p)}
      <span class="pv-host">${escapeHtml(providerHost(p))}</span>
    </div>
    <h3 class="pv-name"><span>${escapeHtml(p.name)}</span>${websiteLinkHTML(p)}</h3>
    <div class="pv-url">
      <code title="${escapeHtml(p.baseUrl)}">${escapeHtml(p.baseUrl)}</code>
      <button class="pv-icon-btn" type="button" data-copy="${escapeHtml(p.baseUrl)}" title="Copy base URL" aria-label="Copy base URL">${PV_ICON.copy}</button>
    </div>
    <div class="pv-tags pv-caps">${providerTags(p)}</div>
    ${stats}
    ${open ? keysPanelHTML(p) : ''}
    ${primary}
    <div class="pv-card-actions${mode === 'connected' ? '' : ' is-centered'}">${actions}</div>
  </article>`;
}

function providerStatsHTML(p) {
  const s = providerStats(p);
  return `<div class="pv-stats">
      <div class="pv-stat"><span class="pv-stat-label">Keys</span>
        <span class="pv-stat-value ${s.keys ? '' : 'dim'}">${s.keys ? String(s.keys) : '0'}</span></div>
      <div class="pv-stat"><span class="pv-stat-label">Models</span>
        <span class="pv-stat-value ${s.models ? '' : 'dim'}">${s.models || '—'}</span></div>
      <div class="pv-stat"><span class="pv-stat-label">Pass rate</span>
        <span class="pv-stat-value ${s.rate == null ? 'dim' : ''}">${s.rate == null ? '—' : `${s.rate}%`}</span></div>
      <div class="pv-stats-foot">${providerStatusHTML(p)}</div>
      ${isConnected(p) ? `<div class="pv-stats-strip">${keyStripHTML(p)}</div>` : ''}
    </div>`;
}


// ============================================
// Provider types — legend and markers
// ============================================
// Auth kind comes from the module (meta.auth, default an API key); freeTier is
// a module flag. A provider can carry more than one type.
const PROVIDER_TYPES = {
  oauth: { label: 'OAuth 2.0', desc: 'Signs in through an OAuth authorization flow', color: 'var(--type-oauth)' },
  apikey: { label: 'API Key', desc: 'Authenticates with a provider API key', color: 'var(--type-apikey)' },
  free: { label: 'Free Tier', desc: 'Includes free models or a free quota', color: 'var(--type-free)' },
  none: { label: 'No Auth', desc: 'Open to use — nothing to connect', color: 'var(--type-none)' },
};

// The Providers list is grouped by how a provider authenticates, OAuth first.
// A provider that offers both is filed once, under its first declared kind,
// but either filter finds it.
const PV_AUTH_GROUPS = ['oauth', 'apikey'];

function providerAuthKinds(p) {
  const kinds = providerTypes(p).filter((t) => PV_AUTH_GROUPS.includes(t));
  return kinds.length ? kinds : ['apikey'];
}

function providerAuthGroup(p) {
  return providerAuthKinds(p)[0];
}

function providerTypes(p) {
  const types = Array.isArray(p.auth) && p.auth.length ? [...p.auth] : ['apikey'];
  if (p.freeTier) types.push('free');
  return types.filter((t) => PROVIDER_TYPES[t]);
}

function typeStripe(types, dir = '90deg') {
  if (types.length === 1) return PROVIDER_TYPES[types[0]].color;
  const step = 100 / types.length;
  return `linear-gradient(${dir}, ${types.map((t, i) => `${PROVIDER_TYPES[t].color} ${i * step}% ${(i + 1) * step}%`).join(', ')})`;
}

// Logo tile on the Providers page, with the provider's type dots on a rail
// across the bottom edge, read against the legend above the list.
function providerLogoHTML(p) {
  const types = providerTypes(p);
  const rail = `<span class="pv-logo-types" title="${types.map((t) => PROVIDER_TYPES[t].label).join(' · ')}">`
    + types.map((t) => `<i style="--c:${PROVIDER_TYPES[t].color}"></i>`).join('') + '</span>';
  return `<span class="pv-logo has-types">${providerMark(p)}${rail}</span>`;
}

let pvLegendCollapsed = true;
try { pvLegendCollapsed = localStorage.getItem('pvLegendCollapsed') !== '0'; } catch (_) {}

function providerLegendHTML(list) {
  const counts = Object.fromEntries(Object.keys(PROVIDER_TYPES).map((t) => [t, 0]));
  list.forEach((p) => providerTypes(p).forEach((t) => { counts[t] += 1; }));
  const chevron = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>';
  return `<div class="pv-legend ${pvLegendCollapsed ? 'collapsed' : ''}">
    <div class="pv-legend-head" data-legend-toggle>
      <span class="pv-legend-title"><span class="pv-legend-dots">${Object.values(PROVIDER_TYPES).map((t) => `<i style="--c:${t.color}"></i>`).join('')}</span>Provider types</span>
      <button class="pv-legend-toggle" type="button" data-legend-toggle aria-expanded="${!pvLegendCollapsed}">
        <span>${pvLegendCollapsed ? 'Show legend' : 'Hide legend'}</span>${chevron}
      </button>
    </div>
    <div class="pv-legend-body">
      ${Object.entries(PROVIDER_TYPES).map(([k, t]) => `
        <div class="pv-legend-item ${counts[k] ? '' : 'empty'}" style="--c:${t.color}">
          <span class="pv-legend-chip"><i></i></span>
          <div class="pv-legend-text">
            <div class="pv-legend-name">${t.label}<span class="pv-legend-count${counts[k] ? '' : ' is-zero'}">${counts[k]} provider${counts[k] === 1 ? '' : 's'}</span></div>
            <div class="pv-legend-desc">${t.desc}</div>
          </div>
        </div>`).join('')}
    </div>
  </div>`;
}


// ============================================
// Providers page — key management panel (table rows and cards)
// ============================================
// Expanded providers are shared by both views, so opening one in the table and
// switching to cards keeps it open.
const pvExpanded = new Set();
const keyProbe = new Map();   // keyId -> { state: 'testing'|'ok'|'fail', text, at }
let keyDeleteArmed = null;    // keyId awaiting a second click to delete
let keyDeleteTimer = null;

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
  if (currentPage === 'providers') renderProvidersPage();
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

function recheckProvider(id) {
  if (recheckAct.get(id)?.state === 'running') return;
  setAct(recheckAct, id, 'running');
  if (currentPage === 'providers') renderProvidersPage();
  checkProviderHealth(id);
  if (window.KEY_USAGE) KEY_USAGE.refreshProvider(id, { force: true });
}

// What state a key is in, most important first. A per-model refusal (the
// quotaSpent.models list) does not make the key spent: other models still run
// on it, so it reads as active with the affected models named in the hint.
function keyState(k) {
  if (k.locked) return { id: 'locked', label: 'Locked', hint: 'Encrypted for another machine — re-add it' };
  if (!k.active) return { id: 'off', label: 'Off', hint: 'Switched off — not used in runs' };
  if (isKeyFullySpent(k)) return { id: 'spent', label: 'Quota used', hint: spentHint(k) };
  const partialHint = isKeyPartiallySpent(k) ? `${spentHint(k)}\n\nOther models still run on this key.` : null;
  const cool = keyCooldownUntil.get(k.id) || 0;
  if (cool > Date.now()) return { id: 'cooling', label: 'Cooling down', hint: `Rate limited — free again in ${Math.ceil((cool - Date.now()) / 1000)} s` };
  const probe = keyProbe.get(k.id);
  if (probe && probe.state === 'testing') return { id: 'testing', label: 'Testing…', hint: 'Testing connection to endpoint…' };
  if (probe && probe.state === 'fail') return { id: 'fail', label: 'Failing', hint: probe.text };
  if (partialHint) return { id: 'active', label: 'Active', hint: partialHint };
  return { id: 'active', label: 'Active', hint: 'In use by test runs' };
}

// key_<timestamp> ids carry the moment the key was added.
function keyAddedLabel(k) {
  const ts = Number(String(k.id).replace(/^key_/, ''));
  if (!Number.isFinite(ts) || ts < 1e12) return '';
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Models this key sees on its own. The catalogue re-discovers every key on its
// sync, through the provider's own discovery and filters, so its number is the
// one runs use; the Check page's last discovery is the fallback.
function keyModelCount(p, k) {
  const km = window.CATALOG && window.CATALOG.keyModels(k.id);
  if (km) return km;
  if (!p.models || !p.models.length) return null;
  return { count: p.models.filter((m) => Array.isArray(m.keyIds) && m.keyIds.includes(k.id)).length, at: null };
}

const KX_META_ICON = {
  models: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2 3 7l9 5 9-5-9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/></svg>',
  clock: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
};

// "18 of 21 models" when a key sees less than its provider's keys see
// together — the case worth noticing; otherwise just the count.
function keyModelsHTML(p, k) {
  const km = keyModelCount(p, k);
  if (!km) return '';
  const total = p.keys.length > 1 && window.CATALOG ? window.CATALOG.providerModelCount(p.id) : null;
  const partial = total != null && km.count < total;
  const text = partial ? `${km.count} of ${total} models` : `${km.count} model${km.count === 1 ? '' : 's'}`;
  const title = (partial ? `This key sees ${km.count} of the ${total} models this provider's keys offer` : 'Models this key can use')
    + (km.at ? ` — listed ${new Date(km.at).toLocaleTimeString()}` : '');
  return `<span class="kx-meta-item${partial ? ' partial' : ''}" title="${escapeHtml(title)}">${KX_META_ICON.models}${escapeHtml(text)}</span>`;
}

// When this key was last checked, by the background monitor or a Test. The
// relative time is kept current in place by refreshAgoLabels().
function keyCheckedHTML(probe) {
  if (!probe || !probe.at || probe.state === 'testing') return '';
  return `<span class="kx-meta-item" title="Last checked ${escapeHtml(new Date(probe.at).toLocaleString())}">${KX_META_ICON.clock}Checked <span data-ago="${probe.at}">${escapeHtml(formatAgo(probe.at))}</span></span>`;
}

// When a spent key's quota comes back: its own cell in the list view (under
// the provider's last-run column) and a meta item in the card view. The
// countdown is kept current by refreshAgoLabels(). A per-model refusal leaves
// this cell empty — naming one exhausted model next to every other exhausted
// fact is the test table's job, not the key row's.
function keyResetHTML(k, { inline = false } = {}) {
  if (!isKeyFullySpent(k) || !k.active) return '';
  const until = k.quotaSpent.until;
  const title = escapeHtml(spentHint(k));
  if (inline) {
    return `<span class="kx-meta kx-reset" title="${title}"><span class="kx-meta-item">${KX_META_ICON.clock}<span>${until ? `Resets in <span data-in="${until}">${escapeHtml(formatIn(until))}</span>` : 'No reset time'}</span></span></span>`;
  }
  if (!until) return `<span class="ku-expiry" data-tone="low" title="${title}"><b>No reset time</b></span>`;
  const when = new Date(until).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `<span class="ku-expiry" data-tone="low" title="${title}"><b>Resets in <span data-in="${until}">${escapeHtml(formatIn(until))}</span></b><span class="ku-sub">${escapeHtml(when)}</span></span>`;
}

function refreshAgoLabels() {
  $$('[data-ago]').forEach((el) => { el.textContent = formatAgo(Number(el.dataset.ago)); });
  // A reset that has come round lifts the key: redraw so its state follows.
  let lapsed = false;
  $$('[data-in]').forEach((el) => {
    const t = Number(el.dataset.in);
    if (t <= Date.now()) lapsed = true;
    else el.textContent = formatIn(t);
  });
  if (lapsed) {
    Object.keys(PROVIDERS).forEach((pid) => refreshAfterKeyChange(pid));
  }
}
setInterval(refreshAgoLabels, 30000);
// A catalogue sync brings fresh per-key model counts.
window.addEventListener('catalog-changed', () => { if (currentPage === 'providers') renderProvidersPage(); });

function keyStripHTML(p) {
  if (!p.keys.length) return '';
  return `<div class="kx-strip" aria-label="Key states">${p.keys.map((k) => {
    const st = keyState(k);
    return `<span class="kx-seg" data-state="${st.id}" title="${escapeHtml(k.name)} — ${escapeHtml(st.label)}"></span>`;
  }).join('')}</div>`;
}

// Everything one key shows, rendered once and laid out twice: as a stacked
// row in the card view's panel, and as a row on the provider's own column
// grid in the list view (keyRowsHTML).
function keyParts(p, k, i) {
  const pid = escapeHtml(p.id);
  const st = keyState(k);
  const kid = escapeHtml(k.id);
  const probe = keyProbe.get(k.id);
  const added = keyAddedLabel(k);
  const isTesting = probe && probe.state === 'testing';
  // The Test button's own feedback: spinning while this test runs, then the
  // verdict for a moment (background probes leave it at rest).
  const testAct = isTesting ? 'running' : keyTestAct.get(k.id)?.state;
  const testTitle = { running: 'Testing…', ok: 'Key works', fail: 'Key failed' }[testAct] || 'Test key';
  // The background check covers every active key, so an unprobed active key
  // is only waiting for it — unless live updates are paused.
  let probeHTML;
  if (isTesting) {
    probeHTML = statusPillHTML('pending', 'Testing…');
  } else if (!k.active) {
    probeHTML = statusPillHTML('none', 'Disabled', 'Switched-off keys are excluded from routing and background checks');
  } else if (isKeyFullySpent(k)) {
    // The models check may still say OK; the spent quota is what decides
    // whether this key can serve, so it takes the badge, with the refusal's
    // status. The reset has its own cell (keyResetHTML).
    const s = k.quotaSpent;
    probeHTML = statusPillHTML('spent', `Quota used · ${s.status ? `HTTP ${s.status}` : '—'}`, `${spentHint(k)}${s.message ? `\n\n${s.message}` : ''}`);
  } else if (probe) {
    const at = probe.at ? `Checked ${new Date(probe.at).toLocaleTimeString()}` : '';
    probeHTML = statusPillHTML(probe.state, probe.text, at);
  } else if (k.locked) {
    probeHTML = statusPillHTML('none', 'Unreadable', 'Encrypted on another machine — re-add the key');
  } else {
    probeHTML = settings.liveUpdates
      ? statusPillHTML('pending', 'Checking…')
      : statusPillHTML('none', 'Not checked', 'Live updates are paused — press Test to check this key');
  }
  const armed = keyDeleteArmed === k.id;
  const isUnlocked = k.active && !k.locked;
  const lockTitle = k.locked
    ? 'Unreadable on this machine'
    : (k.active ? 'In use — click to disable' : 'Disabled — click to enable');
  const lockAria = isUnlocked ? 'Disable key' : 'Enable key';
  const hint = `${st.hint}${added ? ` · added ${added}` : ''}`;
  return {
    st,
    added,
    probe,
    index: `<span class="kx-index" title="${escapeHtml(hint)}">#${i + 1}</span>`,
    // No state badge: the index chip's colour already says it. A key that is
    // switched off, or can't be read here, carries a clear icon by its name.
    name: `<span class="kx-name-line"><span class="kx-name" title="${escapeHtml(hint)}">${escapeHtml(k.name)}</span>${
      k.locked
        ? `<span class="kx-flag warn" title="Unreadable on this machine — the key was encrypted elsewhere; re-add it">${KX_ICON.alert}</span>`
        : !k.active
          ? `<span class="kx-flag" title="Disabled by the admin — this key is not used in runs">${KX_ICON.lock}</span>`
          : ''
    }</span>`,
    // No hint and not locked means the save that should have produced one
    // never landed: the key still sits here as plaintext, unsaved.
    secret: `<div class="kx-secret">
        <code>${k.locked ? 'encrypted' : (k.hint ? escapeHtml(k.hint) : 'not saved')}</code>
        ${k.locked ? '' : `<button class="pv-icon-btn" type="button" data-kx-copy="${pid}|${kid}" title="Copy key" aria-label="Copy key">${PV_ICON.copy}</button>`}
      </div>`,
    probeHTML,
    actions: `<button class="kx-btn icon-only kx-test-btn" type="button" data-kx-test="${pid}|${kid}"${testAct ? ` data-act="${testAct}"` : ''} ${k.locked || isTesting ? 'disabled' : ''}${isTesting ? ' aria-busy="true"' : ''} title="${testTitle}" aria-label="${testTitle}">${actIconHTML(testAct, KX_ICON.test)}</button>
        <button class="kx-btn icon-only kx-lock-btn ${isUnlocked ? 'is-unlocked active' : 'is-locked'}" type="button" data-kx-active="${pid}|${kid}" ${k.locked ? 'disabled' : ''}
                title="${lockTitle}" aria-label="${lockAria}">${isUnlocked ? KX_ICON.unlock : KX_ICON.lock}</button>
        <button class="kx-btn icon-only danger ${armed ? 'armed' : ''}" type="button" data-kx-del="${pid}|${kid}" title="${armed ? 'Click again to delete' : 'Delete key'}" aria-label="Delete key">${KX_ICON.trash}${armed ? 'Confirm' : ''}</button>`,
  };
}

function keysPanelHTML(p) {
  const rows = p.keys.map((k, i) => {
    const kp = keyParts(p, k, i);
    return `<div class="kx-row" data-state="${kp.st.id}">
      <div class="kx-id">
        ${kp.index}
        <div class="kx-id-text">
          ${kp.name}
          <span class="kx-meta">${kp.added ? `<span class="kx-meta-item">Added ${escapeHtml(kp.added)}</span>` : ''}${keyModelsHTML(p, k)}${keyCheckedHTML(kp.probe)}</span>
          ${keyResetHTML(k, { inline: true })}
          ${window.KEY_USAGE ? KEY_USAGE.inlineHTML(p, k) : ''}
        </div>
      </div>
      ${kp.secret}
      <div class="kx-probe-cell">${kp.probeHTML}</div>
      <div class="kx-actions">${kp.actions}</div>
    </div>`;
  }).join('');
  return `<div class="kx-panel" aria-label="API keys"><div class="kx-list">${rows}</div></div>`;
}

// An open provider's keys, inside its row card and on the same column grid as
// the provider row, so each value sits under the provider's own: identity
// under the name, the check under the status, the key's state under the key
// count, its model count under the models, and its buttons, with when it was
// last checked framed beneath them, under the provider's buttons.
function keyRowsHTML(p) {
  return p.keys.map((k, i) => {
    const kp = keyParts(p, k, i);
    const kmHTML = keyModelsHTML(p, k);
    // When the key was last checked sits under its buttons, framed to their
    // width, so the check and the controls that act on it read as one block.
    const checked = kp.probe && kp.probe.at && kp.probe.state !== 'testing'
      ? `<span class="kx-checked-frame" title="Last checked ${escapeHtml(new Date(kp.probe.at).toLocaleString())}">${KX_META_ICON.clock}<span data-ago="${kp.probe.at}">${escapeHtml(formatAgo(kp.probe.at))}</span></span>`
      : '<span class="kx-checked-frame is-empty" title="Not checked yet">not checked</span>';
    const last = i === p.keys.length - 1;
    return `<div class="pv-krow${last ? ' last' : ''}" data-state="${kp.st.id}">
      <div class="pv-cell col-provider"><div class="dt-key">
        ${kp.index}
        <div class="dt-key-text">${kp.name}${kp.secret}${kmHTML ? `<span class="kx-meta">${kmHTML}</span>` : ''}</div>
      </div></div>
      <div class="pv-cell col-status">${kp.probeHTML}</div>
      <div class="pv-cell col-rate">${window.KEY_USAGE ? KEY_USAGE.quotaCellHTML(p, k) : ''}</div>
      <div class="pv-cell col-last">${keyResetHTML(k) || (window.KEY_USAGE ? KEY_USAGE.expiryCellHTML(p, k) : '')}</div>
      <div class="pv-cell col-actions"><div class="kx-actions-stack"><div class="dt-row-actions">${kp.actions}</div>${checked}</div></div>
    </div>`;
  }).join('');
}

// A group's divider: a framed tag (its kind in the legend colour, how many
// providers) and a hairline running to the edge.
function pvGroupHeadHTML(kind, n) {
  const t = PROVIDER_TYPES[kind];
  return `<div class="pv-group-head" style="--c:${t.color}" role="presentation">
    <span class="pv-group-tag">
      <span class="pv-group-dot" aria-hidden="true"></span>
      <span class="pv-group-label">${escapeHtml(t.label)}</span>
      <span class="pv-group-count">${n} provider${n === 1 ? '' : 's'}</span>
    </span>
    <span class="pv-group-rule" aria-hidden="true"></span>
  </div>`;
}

const PV_BADGE_ICON = {
  key: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3"/></svg>',
  account: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  model: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
};

function providerBadgesHTML(p, s) {
  const isOAuth = providerAuthKinds(p).includes('oauth');
  const totalKeys = s?.keys ?? p.keys?.length ?? 0;
  const activeKeys = s?.activeKeys ?? usableKeys(p).length;

  let keyLabel;
  if (isOAuth) {
    keyLabel = totalKeys === 1 ? '1 account' : `${totalKeys} accounts`;
  } else {
    if (totalKeys === 0) keyLabel = '0 keys';
    else keyLabel = totalKeys === 1 ? '1 key' : `${totalKeys} keys`;
  }

  const keyTitle = isOAuth
    ? `${totalKeys} connected account${totalKeys === 1 ? '' : 's'}`
    : `${activeKeys} of ${totalKeys} key${totalKeys === 1 ? '' : 's'} active`;

  const keyIcon = isOAuth ? PV_BADGE_ICON.account : PV_BADGE_ICON.key;
  const keyClass = `pv-badge pv-badge-keys ${isOAuth ? 'is-oauth' : ''} ${totalKeys === 0 ? 'is-empty' : ''}`;

  const modelsCount = Math.max(
    (window.CATALOG && typeof window.CATALOG.providerModelCount === 'function' ? window.CATALOG.providerModelCount(p.id) : 0) || 0,
    (Array.isArray(p.models) ? p.models.length : 0),
    s?.models || 0
  );

  const modelLabel = modelsCount === 1 ? '1 model' : `${modelsCount} models`;
  const modelTitle = `${modelsCount} model${modelsCount === 1 ? '' : 's'} available`;
  const modelClass = `pv-badge pv-badge-models ${modelsCount === 0 ? 'is-empty' : ''}`;
  const modelIcon = PV_BADGE_ICON.model;

  return `<div class="dt-provider-badges" role="group" aria-label="Provider configuration status">
    <span class="${keyClass}" title="${escapeHtml(keyTitle)}">${keyIcon}<span class="pv-badge-text">${escapeHtml(keyLabel)}</span></span>
    <span class="${modelClass}" title="${escapeHtml(modelTitle)}">${modelIcon}<span class="pv-badge-text">${escapeHtml(modelLabel)}</span></span>
  </div>`;
}

function pvSparklineHTML(p) {
  const TOTAL_TICKS = 20;
  const runs = runLog.filter((r) => r.provider === p.id);
  const recent = runs.slice(-TOTAL_TICKS);
  const emptyCount = TOTAL_TICKS - recent.length;

  const ticks = [];
  for (let i = 0; i < emptyCount; i++) {
    ticks.push('<span class="pv-tick empty" title="No test recorded"></span>');
  }
  for (const r of recent) {
    let state = 'pass';
    if (r.total > 0 && r.passed === 0) state = 'fail';
    else if (r.passed < r.total) state = 'warn';
    const ago = r.at ? formatAgo(r.at) : '';
    const title = `${ago ? `${ago}: ` : ''}${r.passed}/${r.total} passed`;
    ticks.push(`<span class="pv-tick ${state}" title="${escapeHtml(title)}"></span>`);
  }

  const tip = runs.length
    ? `${runs.length} test run${runs.length === 1 ? '' : 's'} recorded`
    : 'No test runs yet';

  return `<div class="pv-sparkline" role="img" aria-label="${escapeHtml(tip)}" title="${escapeHtml(tip)}">${ticks.join('')}</div>`;
}

// Connected providers as a list of row cards, one per provider with a gap
// between them, on one column grid shared with each provider's key rows, and
// grouped by auth kind under a divider each. The whole row opens its keys;
// there is no separate key button.
function pvRowsHTML(groups, stats) {
  const rows = groups.map((x) => pvGroupHeadHTML(x.g, x.items.length) + x.items.map((p) => {
    const s = stats.get(p.id);
    const last = pvLastRun(p);
    const id = escapeHtml(p.id);
    const open = pvExpanded.has(p.id);
    return `<div class="pv-rowcard ${open ? 'open' : ''}" role="listitem">
      <div class="pv-row ${open ? 'open' : ''}" data-kx-toggle="${id}" aria-expanded="${open}" tabindex="0">
        <div class="pv-cell col-provider"><div class="dt-provider">${KX_ICON.chevron}
          ${providerLogoHTML(p)}
          <div><div class="dt-provider-name">${escapeHtml(p.name)}${websiteLinkHTML(p)}</div>${providerBadgesHTML(p, s)}</div>
        </div></div>
        <div class="pv-cell col-status">${providerStatusHTML(p)}</div>
        <div class="pv-cell col-rate"></div>
        <div class="pv-cell col-last">${last ? escapeHtml(formatAgo(last)) : '<span class="dt-muted">never</span>'}</div>
        <div class="pv-cell col-actions"><div class="pv-actions-stack">
          <div class="dt-row-actions">
            <button class="dt-icon-btn" type="button" data-connect="${id}" title="Add key" aria-label="Add key">${PV_ICON.plus}</button>
            ${recheckButtonHTML(p)}
            <button class="dt-icon-btn dt-icon-go" type="button" data-manage="${id}" title="Test models" aria-label="Test ${escapeHtml(p.name)} models">${PV_ICON.flask}</button>
          </div>
          ${pvSparklineHTML(p)}
        </div></div>
      </div>${open ? `<div class="pv-rowcard-keys">${keyRowsHTML(p)}</div>` : ''}
    </div>`;
  }).join('')).join('');
  return `<div class="pv-rows" role="list" aria-label="Connected providers">
    ${rows}
  </div>`;
}

function refreshAfterKeyChange(pid) {
  if (pid === activeProvider) {
    renderKeysList();
    updateTestAllButton();
  }
  if (currentPage === 'providers') renderProvidersPage();
}

// Checks one key with the provider: a GET on its models endpoint, unless the
// module declares meta.keyCheck because that endpoint answers without a key
// and so says nothing about one. Never rejects: a failure comes back as a
// response.
async function probeKey(p, apiKey) {
  const check = p.keyCheck || { endpoint: p.modelsEndpoint || '/models' };
  try {
    return await window.electronAPI.apiRequest({
      url: `${p.baseUrl}${check.endpoint}`,
      method: check.method || 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: check.body ? JSON.stringify(check.body) : undefined,
      timeoutMs: HEALTH_TIMEOUT_MS,
      source: 'key_check',
    });
  } catch (err) {
    return { status: 0, networkError: true, error: err.message };
  }
}

async function testKey(pid, kid) {
  const p = PROVIDERS[pid];
  const k = p && p.keys.find((x) => x.id === kid);
  if (!k || k.locked) return;
  const startedAt = Date.now();
  keyProbe.set(kid, { state: 'testing', text: 'Testing…', at: startedAt });
  refreshAfterKeyChange(pid);
  const res = await probeKey(p, k.key);
  // A models check can't see a spent quota. A module that reports usage is
  // read here, while the spinner still runs; the reading also settles the
  // key's spent-quota state (key-usage.js reconcileSpent).
  if (window.KEY_USAGE && isHealthyResponse(res)) await KEY_USAGE.refresh(pid, kid, { force: true });
  // Same minimum spinner time as Recheck, so an instant answer still reads.
  const hold = startedAt + ACT_MIN_RUNNING_MS - Date.now();
  if (hold > 0) await new Promise((r) => setTimeout(r, hold));
  const result = keyProbeResult(res);
  keyProbe.set(kid, result);
  setAct(keyTestAct, kid, result.state);
  refreshAfterKeyChange(pid);
}

async function setKeyActive(pid, kid) {
  const p = PROVIDERS[pid];
  const k = p && p.keys.find((x) => x.id === kid);
  if (!k || k.locked) return;
  k.active = !k.active;
  if (!k.active) {
    keyProbe.delete(kid);
    if (window.KEY_USAGE) KEY_USAGE.forget(kid);
  }
  await saveProviderConfig(pid);
  refreshAfterKeyChange(pid);
}

// Two clicks to delete: the first arms the button for a few seconds.
async function deleteKey(pid, kid) {
  if (keyDeleteArmed !== kid) {
    keyDeleteArmed = kid;
    clearTimeout(keyDeleteTimer);
    keyDeleteTimer = setTimeout(() => { keyDeleteArmed = null; refreshAfterKeyChange(pid); }, 3500);
    refreshAfterKeyChange(pid);
    return;
  }
  clearTimeout(keyDeleteTimer);
  keyDeleteArmed = null;
  const p = PROVIDERS[pid];
  p.keys = p.keys.filter((x) => x.id !== kid);
  keyProbe.delete(kid);
  if (window.KEY_USAGE) KEY_USAGE.forget(kid);
  if (window.CATALOG) window.CATALOG.forgetKey(kid);
  if (!p.keys.length) pvExpanded.delete(pid);
  await saveProviderConfig(pid);
  refreshAfterKeyChange(pid);
}

// Accordion: opening one provider closes whichever was open.
function togglePvExpanded(pid) {
  const wasOpen = pvExpanded.has(pid);
  pvExpanded.clear();
  if (!wasOpen) pvExpanded.add(pid);
  if (currentPage === 'providers') renderProvidersPage();
  // Opening a provider's keys brings their usage up to date (if it is stale).
  if (!wasOpen && window.KEY_USAGE) KEY_USAGE.refreshProvider(pid);
}

// ============================================
// Stat cards — shared
// ============================================
// items: [{ label, value, sub?, foot, icon, meter? (0..1), tone? ('pass' | 'fail'),
//          profile? ('lite' | 'pro' | 'max'), attrs? (raw attributes for a card
//          that acts as a button), active? }]
function statCardsHTML(items) {
  return '<div class="ov-kpis">' + items.map((it) => `
    <div class="ov-kpi${it.tone ? ` tone-${it.tone}` : ''}${it.profile ? ` kpi-profile kpi-profile-${it.profile}` : ''}${it.attrs ? ' is-action' : ''}${it.active ? ' active' : ''}" ${it.attrs || ''}>
      <span class="kpi-icon" aria-hidden="true">${it.icon || ''}</span>
      <span class="ov-kpi-label">${escapeHtml(it.label)}</span>
      <span class="ov-kpi-value">${it.value}${it.sub ? `<span class="kpi-value-sub">${it.sub}</span>` : ''}</span>
      ${it.meter == null ? '' : `<span class="kpi-meter"><span style="width:${Math.round(Math.max(0, Math.min(1, it.meter)) * 100)}%"></span></span>`}
      <span class="ov-kpi-foot">${escapeHtml(it.foot || '')}</span>
    </div>`).join('') + '</div>';
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

// The list at full width, cards once the window is narrow enough for the nav
// to fold into a drawer — the same breakpoint, so the page and the chrome
// change shape together. There is no manual switch: the window decides.
const COMPACT_LAYOUT = window.matchMedia('(max-width: 1100px)');

// ============================================
// Providers page — Connected view
// ============================================
const pvState = {
  search: '',
  filter: 'all',
  status: 'all',
  sort: 'name',
  view: COMPACT_LAYOUT.matches ? 'cards' : 'table',
};
let pvShell = null; // which tab the body skeleton was built for

const PV_TOOLBAR = {
  placeholder: 'Search providers, hosts or URLs…',
  statusFilter: {
    icon: 'server',
    label: 'Provider Status',
    options: [
      { value: 'all',     label: 'All Providers' },
      { value: 'ok',      label: 'Connected' },
      { value: 'fail',    label: 'Down' },
      { value: 'pending', label: 'Pending' },
      { value: 'none',    label: 'No Active Key' },
    ],
  },
  filters: [
    { value: 'all',    label: 'All' },
    { value: 'oauth',  label: 'OAuth',   dot: 'var(--type-oauth)' },
    { value: 'apikey', label: 'API Key', dot: 'var(--type-apikey)' },
  ],
  sorts: [
    { value: 'name',   label: 'Name' },
    { value: 'rate',   label: 'Pass rate' },
    { value: 'models', label: 'Models' },
    { value: 'recent', label: 'Last run' },
  ],
};

const KPI_ICON = {
  plug: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v4"/></svg>',
  key: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/></svg>',
  pulse: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>',
  target: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></svg>',
  layers: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/></svg>',
  check: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  cross: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  clock: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
};

function pvLastRun(p) {
  for (let i = runLog.length - 1; i >= 0; i--) if (runLog[i].provider === p.id) return runLog[i].at;
  return 0;
}

function pvHealthState(p) {
  return providerHealthLine(p).state;
}

function renderConnectedKpis(connected, all) {
  const keys = connected.reduce((n, p) => n + p.keys.length, 0);
  const active = connected.reduce((n, p) => n + usableKeys(p).length, 0);
  const reachable = connected.filter((p) => pvHealthState(p) === 'ok').length;
  let passed = 0;
  let total = 0;
  runLog.forEach((r) => {
    if (connected.some((p) => p.id === r.provider)) { passed += r.passed; total += r.total; }
  });
  const rate = total ? passed / total : null;
  $('#pv-kpis').innerHTML = statCardsHTML([
    { label: 'Connected', value: connected.length, sub: `/ ${all.length}`, icon: KPI_ICON.plug,
      meter: all.length ? connected.length / all.length : 0, foot: 'of the integrated providers' },
    { label: 'Active keys', value: active, sub: `/ ${keys}`, icon: KPI_ICON.key,
      meter: keys ? active / keys : 0, foot: keys - active ? `${keys - active} switched off` : 'all keys in use' },
    { label: 'Reachable', value: reachable, sub: `/ ${connected.length}`, icon: KPI_ICON.pulse,
      meter: connected.length ? reachable / connected.length : 0, foot: 'answered the health check' },
    { label: 'Pass rate', value: rate == null ? '—' : `${Math.round(rate * 100)}%`, icon: KPI_ICON.target,
      meter: rate, foot: total ? `${total.toLocaleString()} results recorded` : 'no runs recorded yet' },
  ]);
}

function pvFilterState(p) {
  const h = providerHealth.get(p.id);
  if (!h) return 'pending';
  return h.state;
}

function pvFiltered(connected) {
  const q = pvState.search.trim().toLowerCase();
  let list = connected.filter((p) => {
    if (q && !`${p.name} ${providerHost(p)} ${p.baseUrl}`.toLowerCase().includes(q)) return false;
    if (pvState.filter !== 'all' && !providerAuthKinds(p).includes(pvState.filter)) return false;
    if (pvState.status !== 'all' && pvFilterState(p) !== pvState.status) return false;
    return true;
  });
  const stats = new Map(list.map((p) => [p.id, providerStats(p)]));
  const by = {
    name: (a, b) => a.name.localeCompare(b.name),
    rate: (a, b) => (stats.get(b.id).rate ?? -1) - (stats.get(a.id).rate ?? -1),
    models: (a, b) => stats.get(b.id).models - stats.get(a.id).models,
    recent: (a, b) => pvLastRun(b) - pvLastRun(a),
  };
  list = list.sort(by[pvState.sort] || by.name);
  return { list, stats };
}


function renderConnectedResults(connected) {
  const results = $('#pv-results');
  // Filter counts reflect the search and status filter, so a chip never promises rows it hides.
  const q = pvState.search.trim().toLowerCase();
  const searched = connected.filter((p) => {
    if (q && !`${p.name} ${providerHost(p)} ${p.baseUrl}`.toLowerCase().includes(q)) return false;
    if (pvState.status !== 'all' && pvFilterState(p) !== pvState.status) return false;
    return true;
  });
  const count = { all: searched.length };
  PV_AUTH_GROUPS.forEach((g) => { count[g] = searched.filter((p) => providerAuthKinds(p).includes(g)).length; });
  $$('#pv-toolbar [data-dt-count]').forEach((el) => { el.textContent = count[el.dataset.dtCount] ?? 0; });

  const { list, stats } = pvFiltered(connected);
  if (list.length === 0) {
    results.innerHTML = `<div class="dt-nomatch"><span class="dt-nomatch-icon" aria-hidden="true">${DT_ICON.nomatch}</span><strong>No providers match</strong>
      Try a different search or filter.
      <button class="btn btn-ghost" type="button" data-dt-clear>Clear search and filters</button></div>`;
    return;
  }
  // One group per auth kind, each under its own divider; a kind with no
  // provider (OAuth, today) shows no group at all.
  const groups = PV_AUTH_GROUPS
    .map((g) => ({ g, items: list.filter((p) => (pvState.filter === 'all' ? providerAuthGroup(p) === g : g === pvState.filter)) }))
    .filter((x) => x.items.length);
  results.innerHTML = pvState.view === 'table'
    ? pvRowsHTML(groups, stats)
    : groups.map((x) => pvGroupHeadHTML(x.g, x.items.length) + `<div class="pv-grid">${x.items.map((p) => providerCardHTML(p, 'connected')).join('')}</div>`).join('');
}

function renderProvidersPage() {
  const body = document.getElementById('pv-body');
  if (!body) return;
  const all = Object.values(PROVIDERS);
  const connected = all.filter(isConnected);
  $('#pv-count-connected').textContent = connected.length;
  $('#pv-count-integrated').textContent = all.length;
  $$('.pv-tab').forEach((t) => {
    const on = t.dataset.tab === providersTab;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });
  $('#pv-crumbs').innerHTML = breadcrumbHTML([
    { label: 'Overview', page: 'overview' },
    { label: 'Providers', tab: 'connected', icon: 'providers' },
    { label: providersTab === 'connected' ? 'Connected' : 'Integrated' },
  ]);

  // Grouped by auth kind under the same dividers as the Connected tab, in a
  // denser grid: this tab is a catalogue that grows with every provider added.
  if (providersTab === 'integrated') {
    pvShell = 'integrated';
    const groups = PV_AUTH_GROUPS
      .map((g) => ({ g, items: all.filter((p) => providerAuthGroup(p) === g) }))
      .filter((x) => x.items.length);
    body.innerHTML = providerLegendHTML(all) + groups.map((x) => pvGroupHeadHTML(x.g, x.items.length) +
      `<div class="pv-grid pv-grid-compact">${x.items.map((p) => providerCardHTML(p, 'integrated')).join('')}</div>`).join('');
    return;
  }
  if (connected.length === 0) {
    pvShell = 'empty';
    body.innerHTML = `<div class="pv-empty">
      <div class="pv-empty-icon">${PV_ICON.empty}</div>
      <h3>No providers connected yet</h3>
      <p>Connect an integrated provider with an API key and it will show up here, with its keys, health and test history in one place.</p>
      <button class="btn btn-primary" type="button" data-tab="integrated">${PV_ICON.plug}Browse integrated providers</button>
    </div>`;
    return;
  }
  // Build the skeleton (stats, toolbar, results) once per visit to the tab; later
  // calls only refresh the stats and the results, so typing isn't interrupted.
  if (pvShell !== 'connected') {
    pvShell = 'connected';
    body.innerHTML = `<div id="pv-kpis"></div><div id="pv-legend"></div><div id="pv-toolbar">${dataToolbarHTML(PV_TOOLBAR, pvState)}</div><div id="pv-results"></div>`;
    bindDataToolbar($('#pv-toolbar'), pvState, () => renderConnectedResults(Object.values(PROVIDERS).filter(isConnected)));
  }
  renderConnectedKpis(connected, all);
  $('#pv-legend').innerHTML = providerLegendHTML(connected);
  renderConnectedResults(connected);
}

// Crossing the breakpoint changes the whole page's shape, so the Providers
// page starts over in it: Connected tab, every provider (All), no search, the
// legend folded and every provider closed. The sort order is kept.
COMPACT_LAYOUT.addEventListener('change', (e) => {
  pvState.view = e.matches ? 'cards' : 'table';
  Object.assign(pvState, { search: '', filter: 'all' });
  providersTab = 'connected';
  pvExpanded.clear();
  pvLegendCollapsed = true;
  try { localStorage.setItem('pvLegendCollapsed', '1'); } catch (_) {}
  pvShell = null; // rebuild the toolbar too, so the search box is emptied
  if (currentPage === 'providers') renderProvidersPage();
});

document.querySelector('.page-providers').addEventListener('keydown', (e) => {
  const row = e.target.closest && e.target.closest('.pv-row[data-kx-toggle]');
  if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    togglePvExpanded(row.dataset.kxToggle);
  }
});

// "/" jumps to the search box on pages that have one.
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
  const input = document.querySelector('.shell-page:not([hidden]) [data-dt="search"]');
  if (input) { e.preventDefault(); input.focus(); }
});

$('.page-providers').addEventListener('click', async (e) => {
  const site = e.target.closest('[data-site]');
  if (site) {
    window.electronAPI.openExternal(site.dataset.site);
    return;
  }
  const kx = e.target.closest('[data-kx-test], [data-kx-active], [data-kx-del], [data-kx-copy]');
  if (kx) {
    if (kx.disabled) return;
    const [pid, kid] = (kx.dataset.kxTest || kx.dataset.kxActive || kx.dataset.kxDel || kx.dataset.kxCopy).split('|');
    if (kx.dataset.kxTest) testKey(pid, kid);
    else if (kx.dataset.kxActive) setKeyActive(pid, kid);
    else if (kx.dataset.kxDel) deleteKey(pid, kid);
    else {
      const k = PROVIDERS[pid]?.keys.find((x) => x.id === kid);
      if (k && !k.locked) {
        try {
          await window.electronAPI.copyKey(kid);
          markCopied(kx);
        } catch (err) {
          setStatus('error', 'Could not copy the key to the clipboard');
        }
      }
    }
    return;
  }
  // A row (or its keys button, or a card's Manage keys) opens the key panel;
  // other buttons inside the row keep their own meaning.
  const toggle = e.target.closest('[data-kx-toggle]');
  if (toggle && (toggle.tagName === 'BUTTON' || !e.target.closest('button, a, input, .kx-panel'))) {
    togglePvExpanded(toggle.dataset.kxToggle);
    return;
  }
  // The whole legend header toggles it; the button inside stays the keyboard
  // and screen-reader control, and carries the state.
  if (e.target.closest('[data-legend-toggle]')) {
    pvLegendCollapsed = !pvLegendCollapsed;
    try { localStorage.setItem('pvLegendCollapsed', pvLegendCollapsed ? '1' : '0'); } catch (_) {}
    $$('.pv-legend').forEach((lg) => {
      lg.classList.toggle('collapsed', pvLegendCollapsed);
      const t = lg.querySelector('.pv-legend-toggle');
      t.setAttribute('aria-expanded', String(!pvLegendCollapsed));
      t.querySelector('span').textContent = pvLegendCollapsed ? 'Show legend' : 'Hide legend';
    });
    return;
  }
  if (e.target.closest('[data-dt-clear]')) {
    Object.assign(pvState, { search: '', filter: 'all' });
    pvShell = null;
    renderProvidersPage();
    return;
  }
  const el = e.target.closest('[data-tab], [data-go], [data-connect], [data-manage], [data-recheck], [data-copy]');
  if (!el || el.disabled) return;
  const d = el.dataset;
  if (d.tab) { providersTab = d.tab; pvShell = null; renderProvidersPage(); return; }
  if (d.go) { showPage(d.go); return; }
  if (d.connect) {
    switchProvider(d.connect);
    const name = PROVIDERS[d.connect].name;
    if (providersTab === 'integrated') openAddKeyModal(`Connect ${name}`, d.connect);
    else openAddKeyModal(`Add key to ${name}`);
    return;
  }
  if (d.manage) { openProviderPage(d.manage); return; }
  if (d.recheck) { recheckProvider(d.recheck); return; }
  if (d.copy) {
    try {
      await navigator.clipboard.writeText(d.copy);
      markCopied(el);
    } catch (_) {
      setStatus('error', 'Could not copy to the clipboard');
    }
  }
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
