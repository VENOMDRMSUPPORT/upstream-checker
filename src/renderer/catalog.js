// ============================================
// Model Pool — live model inventory + benchmark leaderboard
// ============================================
// Every model each connected provider currently lists, kept current by a
// periodic sync: a model the provider adds shows up on the next pass (and is
// benchmarked automatically if that option is on); a model the provider drops
// disappears at once; a provider that is disconnected takes its models with
// it. Each model carries the result of the quick benchmark (benchmark.js) and,
// where the model is known to the Artificial Analysis leaderboard, that global
// score alongside ours, so the two can be compared.
//
// Loaded after app.js and benchmark.js and relies on their globals.

(function () {
  'use strict';

  const B = window.BENCHMARK;
  const REMOVED_KEEP_MS = 14 * 24 * 60 * 60 * 1000;   // purge dropped models after two weeks
  const LEADERBOARD_TTL_MS = 24 * 60 * 60 * 1000;      // live leaderboard refresh cadence
  const HISTORY_CAP = 20;

  const state = {
    data: null,            // catalog.json contents
    loaded: false,
    syncing: false,
    lastSyncAt: 0,
    syncNote: '',
    timer: null,
    queue: [],             // model keys waiting for a benchmark
    running: null,         // key being benchmarked
    abort: null,
    progress: new Map(),   // key -> { done, total, note }
    expanded: new Set(),
    shell: false,
    pendingRender: null,
  };

  const ui = {
    search: '',
    filter: 'all',
    sort: 'rank',
    provider: 'all',
    view: COMPACT_LAYOUT.matches ? 'cards' : 'table',
  };

  const keyOf = (pid, mid) => `${pid}::${mid}`;

  // ---- persistence ---------------------------------------------------------

  // One read, shared by every caller that races to it at startup, so nobody
  // ends up holding a detached copy of the catalogue.
  let loadPromise = null;
  function load() {
    if (state.loaded) return Promise.resolve(state.data);
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      try {
        state.data = await window.electronAPI.readCatalog();
      } catch (err) {
        // Shown empty for this session and never saved: the read gate makes
        // persist() refuse every write.
        failStartupRead('model pool', err);
        state.data = null;
      }
      if (!state.data || typeof state.data !== 'object') state.data = { version: 1, models: {}, lastSync: {}, leaderboard: null };
      if (!state.data.models) state.data.models = {};
      if (!state.data.lastSync) state.data.lastSync = {};
      // keyId -> { count, at }: models each key sees on its own. Keys of one
      // provider can be granted different models (plans, per-key grants).
      if (!state.data.keyModels) state.data.keyModels = {};
      state.loaded = true;
      return state.data;
    })();
    return loadPromise;
  }

  // Main writes only the rows that changed. It refuses to empty a non-empty
  // pool unless reset is set, which only the Clear and Reset buttons do; the
  // flag sticks until the debounced write goes out, because another save()
  // can land inside the window.
  let saveTimer = null;
  let saveReset = false;
  function save({ reset = false } = {}) {
    saveReset = saveReset || reset === true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 300);
  }

  function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const opts = { reset: saveReset };
    saveReset = false;
    // The profiles are a pure function of the catalogue; tell them it moved.
    window.dispatchEvent(new CustomEvent('catalog-changed'));
    return persist('save the model pool', () => window.electronAPI.writeCatalog(state.data, opts));
  }

  // ---- model discovery / sync ----------------------------------------------

  function entriesOf(pid) {
    return Object.values(state.data.models).filter((e) => e.providerId === pid);
  }

  // Per-key model counts for the Providers page: what this key sees, against
  // everything the provider's keys see together.
  function keyModels(kid) {
    return (state.loaded && state.data.keyModels && state.data.keyModels[kid]) || null;
  }

  function providerModelCount(pid) {
    if (!state.loaded) return null;
    return entriesOf(pid).filter((e) => !e.removedAt).length;
  }

  function forgetKey(kid) {
    if (state.loaded && state.data.keyModels && state.data.keyModels[kid]) {
      delete state.data.keyModels[kid];
      save();
    }
  }

  function visibleEntries() {
    return Object.values(state.data.models).filter((e) => {
      if (e.removedAt) return false;
      const p = PROVIDERS[e.providerId];
      return p && isConnected(p);
    });
  }

  // Best-effort price per million tokens from whatever the provider's model
  // object carries. Per-token fields are scaled up; a free-tier model is 0.
  function readPricing(m) {
    const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
    const pr = m.pricing || {};
    let input = num(pr.input_usd_per_1m) ?? num(pr.input_per_1m) ?? num(m.input_price_per_1m) ?? num(m.price_input);
    let output = num(pr.output_usd_per_1m) ?? num(pr.output_per_1m) ?? num(m.output_price_per_1m) ?? num(m.price_output);
    if (input == null && num(pr.prompt) != null) input = num(pr.prompt) * 1e6;          // OpenRouter-style, per token
    if (output == null && num(pr.completion) != null) output = num(pr.completion) * 1e6;
    if (input == null && num(m.input_cost_per_token) != null) input = num(m.input_cost_per_token) * 1e6;
    if (output == null && num(m.output_cost_per_token) != null) output = num(m.output_cost_per_token) * 1e6;
    if (input == null && num(pr.input) != null) input = num(pr.input);
    if (output == null && num(pr.output) != null) output = num(pr.output);
    if (input == null && output == null) {
      if (m.isFree) return { input: 0, output: 0, source: 'free tier' };
      return null;
    }
    return { input: input ?? 0, output: output ?? input ?? 0, source: 'provider' };
  }

  function readsTools(m) {
    if (m.supports_tools != null) return !!m.supports_tools;
    if (m.supports_function_calling != null) return !!m.supports_function_calling;
    if (m.tool_call != null) return !!m.tool_call;
    if (Array.isArray(m.capabilities)) return m.capabilities.includes('tools') || m.capabilities.includes('function_calling');
    if (Array.isArray(m.supported_parameters)) return m.supported_parameters.includes('tools');
    return null; // unknown until probed
  }

  function summarizeModel(p, m) {
    return {
      pricing: readPricing(m),
      declaresTools: readsTools(m),
      maxOutput: m.max_output_tokens ?? m.max_completion_tokens ?? m.top_provider?.max_completion_tokens ?? m.limit?.output ?? null,
      name: m.name || m.id,
      kind: m.kind || 'chat',
      hasVision: !!m.hasVision,
      hasReasoning: !!m.hasReasoning,
      isFree: !!m.isFree,
      isFreeForPaid: !!m.isFreeForPaid,
      contextLabel: m.contextLabel || (m.context_window ? formatContext(m.context_window) : ''),
      contextWindow: m.context_window || null,
      keyIds: Array.isArray(m.keyIds) ? m.keyIds.slice() : [],
      ownedBy: m.owned_by || m.ownedBy || '',
    };
  }

  // Asks every usable key, unions the answers, and applies the same
  // normalisation the Route Test page applies (dedupe, alias groups,
  // adapter exclusions, kind). Returns null when no key answered, so a
  // transient outage never reads as "the provider removed everything".
  async function discoverAll(p) {
    const keys = usableKeys(p);
    if (!keys.length) return null;
    const byId = new Map();
    let answered = 0;
    const adapter = (window.INTEGRATED_PROVIDERS || {})[p.id];
    const excluded = (m) => !!(adapter && typeof adapter.excludeModel === 'function' && adapter.excludeModel(m));
    for (const k of keys) {
      try {
        const list = await discoverModels(p, k.key);
        answered += 1;
        // Counted the way the catalogue counts, so a key's number and the
        // provider's total are comparable.
        state.data.keyModels[k.id] = { count: new Set(list.filter((m) => !excluded(m)).map((m) => m.id)).size, at: Date.now() };
        list.forEach((m) => {
          const existing = byId.get(m.id);
          if (existing) {
            if (!existing.keyIds.includes(k.id)) existing.keyIds.push(k.id);
          } else {
            byId.set(m.id, { ...m, keyIds: [k.id] });
          }
        });
      } catch (_) { /* one bad key must not blank the catalogue */ }
    }
    if (!answered) return null;
    let list = tagAliasGroups(dedupeById([...byId.values()]));
    list = list.filter((m) => !excluded(m));
    list.forEach((m) => { m.kind = classifyModel(p.id, m); });
    return list;
  }

  async function syncProvider(p) {
    const list = await discoverAll(p);
    if (!list) return { ok: false, added: [], removed: [] };
    const now = Date.now();
    const hadBaseline = !!state.data.lastSync[p.id];
    const seen = new Set();
    const added = [];
    const removed = [];
    list.forEach((m) => {
      const key = keyOf(p.id, m.id);
      seen.add(key);
      const meta = summarizeModel(p, m);
      let e = state.data.models[key];
      if (!e) {
        e = { key, providerId: p.id, id: m.id, firstSeen: now, lastSeen: now, removedAt: null,
              isNew: hadBaseline, bench: null, history: [], ...meta };
        state.data.models[key] = e;
        if (hadBaseline) added.push(e);
      } else {
        const reappeared = !!e.removedAt;
        Object.assign(e, meta, { lastSeen: now, removedAt: null });
        if (reappeared) { e.isNew = true; added.push(e); }
      }
    });
    entriesOf(p.id).forEach((e) => {
      if (!seen.has(e.key) && !e.removedAt) { e.removedAt = now; removed.push(e); }
    });
    // Old removals fall out of the file entirely.
    entriesOf(p.id).forEach((e) => {
      if (e.removedAt && now - e.removedAt > REMOVED_KEEP_MS) delete state.data.models[e.key];
    });
    state.data.lastSync[p.id] = now;
    return { ok: true, added, removed };
  }

  async function syncAll({ reason = 'timer', providerId = null } = {}) {
    if (!state.loaded) await load();
    if (state.syncing) return;
    const targets = Object.values(PROVIDERS).filter((p) => isConnected(p) && (!providerId || p.id === providerId));
    state.syncing = true;
    state.syncNote = `Syncing ${targets.length} provider${targets.length === 1 ? '' : 's'}…`;
    renderIfShown();
    const outcome = { added: [], removed: [], failed: [] };
    await Promise.all(targets.map(async (p) => {
      try {
        const r = await syncProvider(p);
        if (!r.ok) outcome.failed.push(p.name);
        outcome.added.push(...r.added);
        outcome.removed.push(...r.removed);
      } catch (err) {
        outcome.failed.push(p.name);
      }
    }));
    // A disconnected provider's records stay (its keys may come back) but its
    // models are hidden by visibleEntries(); a removed model's benchmark queue
    // slot is dropped so nothing is spent on a model that is gone.
    state.queue = state.queue.filter((k) => { const e = state.data.models[k]; return e && !e.removedAt; });
    state.syncing = false;
    state.lastSyncAt = Date.now();
    const bits = [];
    if (outcome.added.length) bits.push(`${outcome.added.length} new`);
    if (outcome.removed.length) bits.push(`${outcome.removed.length} removed`);
    if (outcome.failed.length) bits.push(`${outcome.failed.length} unreachable`);
    state.syncNote = bits.length ? bits.join(' · ') : 'Up to date';
    save();
    if (settings.catalogAutoBench && outcome.added.length) {
      outcome.added.forEach((e) => enqueue(e.key, { silent: true }));
    }
    renderIfShown();
    maybeRefreshLeaderboard();
    return outcome;
  }

  function scheduleTimer() {
    clearInterval(state.timer);
    const minutes = Math.max(1, Number(settings.catalogSyncMinutes) || 5);
    state.timer = setInterval(() => syncAll({ reason: 'timer' }), minutes * 60 * 1000);
  }

  // ---- derived facts used by the router profiles ---------------------------

  // Models that are the same thing behind different providers share a family:
  // the global leaderboard's base slug when the id matches one, else the id
  // with provider noise and effort suffixes stripped.
  function familyKey(e) {
    const g = globalFor(e);
    if (g && g.confidence !== 'approx') return B.baseOf(B.normalizeId(g.entry.slug));
    return B.baseOf(B.normalizeId(e.id));
  }

  // Reliability of this model on this provider from every verdict recorded
  // about it: Route Test runs (history.json) and benchmark runs. Recent
  // evidence is what a router cares about, so a window is applied.
  function reliability(e, windowMs = 7 * 86400000) {
    const since = Date.now() - windowMs;
    const events = [];
    const key = `${e.providerId}::${e.id}`;
    (typeof history !== 'undefined' && history.get(key) ? history.get(key) : []).forEach((h) => { if (h.at >= since) events.push({ at: h.at, ok: !!h.ok }); });
    (e.history || []).forEach((h) => { if (h.at >= since) events.push({ at: h.at, ok: h.composite != null }); });
    if (e.bench && e.bench.at >= since) {
      // Each request in the benchmark is a verdict on the provider too.
      const errs = e.bench.items.filter((it) => it.status !== 'ok').length;
      const oks = e.bench.items.length - errs;
      for (let i = 0; i < oks; i++) events.push({ at: e.bench.at, ok: true });
      for (let i = 0; i < errs; i++) events.push({ at: e.bench.at, ok: false });
    }
    events.sort((a, b) => a.at - b.at);
    const n = events.length;
    const okCount = events.filter((ev) => ev.ok).length;
    let streak = 0;
    for (let i = n - 1; i >= 0 && !events[i].ok; i--) streak += 1;
    const lastFail = events.filter((ev) => !ev.ok).map((ev) => ev.at).pop() || null;
    return { rate: n ? okCount / n : null, n, streak, lastFail };
  }

  // Run-to-run spread of the composite: a model that scores 90 then 60 is not
  // one a router should trust with the top profile.
  function stability(e) {
    const vals = (e.history || []).map((h) => h.composite).filter((v) => typeof v === 'number');
    if (vals.length < 2) return { spread: null, n: vals.length };
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
    return { spread: Math.round(sd * 10) / 10, n: vals.length, mean: Math.round(mean) };
  }

  const CAPS_TTL_MS = 14 * 86400000;
  function capsStale(e) {
    if (!e.caps || e.caps.version !== B.CAPS_VERSION || Date.now() - (e.caps.at || 0) > CAPS_TTL_MS) return true;
    // An answer the provider never gave (rate limit, outage) is worth asking again.
    return [e.caps.tools, e.caps.json, e.caps.longContext].some((p) => p && p.supported === null);
  }

  // ---- benchmark queue -----------------------------------------------------

  // The suite is a chat suite; a generator or a decision model would only
  // fail it. Those stay in the catalogue with no benchmark.
  function benchmarkable(e) {
    return !e.kind || e.kind === 'chat';
  }

  function enqueue(key, { silent = false } = {}) {
    const e = state.data.models[key];
    if (!e || e.removedAt || !benchmarkable(e)) return;
    // A model that is running and hasn't been stopped is already in hand; one
    // that was just stopped may be queued again and runs once the abort settles.
    if (state.queue.includes(key) || capsRunning.has(key)) return;
    if (state.running === key && state.progress.has(key)) return;
    state.queue.push(key);
    state.progress.set(key, { done: 0, total: B.TASKS.length + 2, note: 'Queued' });
    if (!silent) renderRow(key);
    pump();
  }

  function dequeue(key) {
    state.queue = state.queue.filter((k) => k !== key);
    state.progress.delete(key);
    if (state.running === key && state.abort) state.abort.abort();
    renderRow(key);
  }

  async function pump() {
    if (state.running || !state.queue.length) return;
    const key = state.queue.shift();
    const e = state.data.models[key];
    const p = e && PROVIDERS[e.providerId];
    if (!e || !p || !isConnected(p)) { state.progress.delete(key); return pump(); }
    state.running = key;
    state.abort = new AbortController();
    state.progress.set(key, { done: 0, total: B.TASKS.length + 2, note: 'Starting' });
    renderRow(key);
    try {
      const result = await B.run(p, { id: e.id, keyIds: e.keyIds, hasReasoning: e.hasReasoning }, {
        signal: state.abort.signal,
        onProgress: (pr) => { state.progress.set(key, pr); renderRow(key); },
      });
      e.bench = result;
      e.isNew = false;
      e.history = [...(e.history || []), { at: result.at, composite: result.composite, tier: result.tier,
        quality: result.quality, latencyMs: result.latencyMs, ttftMs: result.ttftMs }].slice(-HISTORY_CAP);
      e.benchError = null;
      save();
      // Capability probes ride along once per model (and again when stale):
      // three requests that decide which router profiles it can serve.
      if (capsStale(e)) {
        state.progress.set(key, { done: B.TASKS.length + 2, total: B.TASKS.length + 2, note: 'Probing capabilities' });
        renderRow(key);
        try {
          e.caps = await B.probeCapabilities(p, { id: e.id, keyIds: e.keyIds, contextWindow: e.contextWindow }, {
            signal: state.abort.signal,
            onProgress: (pr) => { state.progress.set(key, { done: B.TASKS.length + 2, total: B.TASKS.length + 2, note: pr.note }); renderRow(key); },
          });
        } catch (err) {
          if (/cancel/i.test(err.message || '')) throw err;
          e.capsError = err.message || 'Capability probe failed';
        }
      }
    } catch (err) {
      if (!/cancel/i.test(err.message || '')) e.benchError = err.message || 'Benchmark failed';
    } finally {
      state.progress.delete(key);
      state.running = null;
      state.abort = null;
      save();
      renderIfShown();
      pump();
    }
  }

  // Capability probes on their own (three requests), outside the benchmark
  // queue so they never wait behind it.
  const capsRunning = new Set();
  async function probeCaps(key) {
    const e = state.data.models[key];
    const p = e && PROVIDERS[e.providerId];
    if (!e || !p || !isConnected(p) || capsRunning.has(key) || state.progress.has(key)) return;
    capsRunning.add(key);
    state.progress.set(key, { done: 0, total: 3, note: 'Probing capabilities' });
    renderRow(key);
    try {
      e.caps = await B.probeCapabilities(p, { id: e.id, keyIds: e.keyIds, contextWindow: e.contextWindow }, {
        onProgress: (pr) => { state.progress.set(key, { done: 0, total: 3, note: pr.note }); renderRow(key); },
      });
      e.capsError = null;
    } catch (err) {
      e.capsError = err.message || 'Capability probe failed';
    } finally {
      capsRunning.delete(key);
      state.progress.delete(key);
      save();
      renderIfShown();
    }
  }

  // ---- global leaderboard --------------------------------------------------

  function leaderboard() {
    const live = state.data && state.data.leaderboard;
    if (live && Array.isArray(live.models) && live.models.length) return live;
    return window.LEADERBOARD_SNAPSHOT || { source: 'none', models: [] };
  }

  function apiKeyPresent() {
    return typeof settings.aaApiKey === 'string' && settings.aaApiKey.trim().length > 8;
  }

  async function refreshLeaderboard({ force = false } = {}) {
    if (!apiKeyPresent()) return { ok: false, error: 'No Artificial Analysis API key set' };
    const live = state.data.leaderboard;
    if (!force && live && Date.now() - (live.at || 0) < LEADERBOARD_TTL_MS) return { ok: true, cached: true };
    const r = await window.electronAPI.apiRequest({
      url: 'https://artificialanalysis.ai/api/v2/data/llms/models',
      method: 'GET',
      headers: { 'x-api-key': settings.aaApiKey.trim(), Accept: 'application/json' },
      timeoutMs: 30000,
    });
    if (r.status !== 200) {
      const why = r.status === 401 ? 'Invalid API key' : r.status === 429 ? 'Rate limited (1,000 requests/day)' : r.error || `HTTP ${r.status}`;
      state.data.leaderboardError = { at: Date.now(), error: why };
      save();
      return { ok: false, error: why };
    }
    let body;
    try { body = JSON.parse(r.body); } catch (_) { return { ok: false, error: 'Unreadable response' }; }
    const models = (body.data || []).map((m) => ({
      name: m.name,
      slug: m.slug,
      creator: m.model_creator?.name || '',
      index: m.evaluations?.artificial_analysis_intelligence_index ?? null,
      codingIndex: m.evaluations?.artificial_analysis_coding_index ?? null,
      mathIndex: m.evaluations?.artificial_analysis_math_index ?? null,
      tps: m.median_output_tokens_per_second ?? null,
      ttft: m.median_time_to_first_token_seconds ?? null,
      priceBlended: m.pricing?.price_1m_blended_3_to_1 ?? null,
    })).filter((m) => m.slug);
    if (!models.length) return { ok: false, error: 'Empty leaderboard' };
    state.data.leaderboard = { source: 'artificialanalysis.ai (live API)', at: Date.now(), models };
    state.data.leaderboardError = null;
    save();
    renderIfShown();
    return { ok: true, count: models.length };
  }

  function maybeRefreshLeaderboard() {
    if (!apiKeyPresent()) return;
    refreshLeaderboard().catch(() => {});
  }

  const globalCache = new Map(); // key -> { entry, confidence } | null
  let globalCacheStamp = null;

  function globalFor(e) {
    const lb = leaderboard();
    const stamp = `${lb.source}:${lb.at || lb.capturedAt}:${lb.models.length}`;
    if (globalCacheStamp !== stamp) { globalCache.clear(); globalCacheStamp = stamp; }
    const ck = `${e.id}|${e.hasReasoning ? 1 : 0}`;
    if (!globalCache.has(ck)) globalCache.set(ck, B.matchGlobal(e.id, lb.models, { hasReasoning: e.hasReasoning }));
    return globalCache.get(ck);
  }

  function globalRank(entry) {
    const lb = leaderboard();
    const ranked = lb.models.filter((m) => m.index != null).sort((a, b) => b.index - a.index);
    const ix = ranked.findIndex((m) => m.slug === entry.slug);
    return { rank: ix < 0 ? null : ix + 1, of: ranked.length };
  }

  // Correlation between our composite and the global index over every model
  // with both — the number that says whether our benchmark ranks like the
  // world does.
  function validity(list) {
    const pairs = [];
    list.forEach((e) => {
      if (!e.bench) return;
      const g = globalFor(e);
      if (g && g.entry.index != null && e.bench.quality != null) pairs.push([e.bench.quality, g.entry.index]);
    });
    const rho = B.rankCorrelation(pairs);
    return { rho, n: pairs.length, ...B.agreementLabel(rho) };
  }

  // ---- ranking -------------------------------------------------------------

  function ranked(list) {
    // Composite first, intelligence as the tie-breaker, then latency. An
    // incomplete run has no composite and holds no rank.
    const bench = list.filter((e) => e.bench && e.bench.composite != null)
      .sort((a, b) => b.bench.composite - a.bench.composite || (b.bench.quality ?? 0) - (a.bench.quality ?? 0) || (a.bench.latencyMs || 1e9) - (b.bench.latencyMs || 1e9));
    const rank = new Map();
    bench.forEach((e, i) => rank.set(e.key, i + 1));
    return rank;
  }

  // ---- rendering -----------------------------------------------------------

  const ICON = {
    play: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 4 20 12 6 20 6 4"/></svg>',
    stop: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
    redo: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
    chevron: '<svg class="kx-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
    sync: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
    box: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>',
    plug: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v4"/></svg>',
    flag: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 22V4a1 1 0 0 1 1-1h13l-3 5 3 5H5"/></svg>',
    trophy: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 6h3v2a3 3 0 0 1-3 3M7 6H4v2a3 3 0 0 0 3 3"/></svg>',
    globe: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
    clock: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    eye: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    brain: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4a3 3 0 0 0-3 3v10a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3z"/><path d="M9 9H7a3 3 0 0 0 0 6h2M15 9h2a3 3 0 0 1 0 6h-2"/></svg>',
    pass: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    fail: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    empty: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5"/></svg>',
  };

  const TOOLBAR = {
    placeholder: 'Search models, providers or ids…',
    filters: [
      { value: 'all', label: 'All' },
      { value: 'new', label: 'New', dot: 'var(--accent)' },
      { value: 'benchmarked', label: 'Benchmarked', dot: 'var(--pass)' },
      { value: 'untested', label: 'Untested', dot: 'var(--text-4)' },
      { value: 'global', label: 'On global board', dot: '#a78bfa' },
    ],
    sorts: [
      { value: 'rank', label: 'Rank' },
      { value: 'quality', label: 'Intelligence' },
      { value: 'latency', label: 'Latency' },
      { value: 'ttft', label: 'Time to first token' },
      { value: 'tps', label: 'Tokens / s' },
      { value: 'global', label: 'Global index' },
      { value: 'newest', label: 'Newest' },
      { value: 'name', label: 'Name' },
      { value: 'provider', label: 'Provider' },
    ],
  };

  function fmtMs(ms) {
    if (ms == null) return '—';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  }

  function timeClass(ms) {
    if (ms == null) return '';
    if (ms <= settings.timeGoodMs) return 'time-fast';
    if (ms <= settings.timeOkMs) return 'time-medium';
    return 'time-slow';
  }

  function tierBadge(tier, { big = false } = {}) {
    if (!tier) return `<span class="mc-tier mc-tier-none ${big ? 'big' : ''}">—</span>`;
    const t = B.TIERS.find((x) => x.id === tier);
    return `<span class="mc-tier mc-tier-${tier} ${big ? 'big' : ''}" title="${escapeHtml(t ? t.label : '')}">${tier}</span>`;
  }

  function scoreBar(score, cls = '') {
    if (score == null) return '<span class="dt-muted">—</span>';
    return `<div class="dt-rate ${cls}"><div class="dt-rate-bar"><span class="${scoreClass(score / 100)}" style="width:${score}%"></span></div><b>${score}</b></div>`;
  }

  function catCell(e, cat) {
    if (!e.bench) return '<span class="dt-muted">—</span>';
    const c = e.bench.categories[cat];
    if (!c || c.score == null) return '<span class="dt-muted" title="No task in this category was answered">—</span>';
    const unanswered = c.total - c.answered;
    const pts = ` · ${c.points}/${c.maxPoints} points (hard ×2, expert ×3)${unanswered ? ` · ${unanswered} not answered (provider error), excluded` : ''}`;
    return `<span class="mc-cat ${scoreClass(c.score / 100)}" title="${c.passed} of ${c.answered} answered correct${pts}">${c.score}</span>`;
  }

  function badges(e) {
    const out = [];
    if (e.isNew) out.push('<span class="pv-tag mc-new">NEW</span>');
    if (e.bench && e.bench.suite !== B.SUITE_VERSION) out.push(`<span class="pv-tag t-amber" title="Scored with an older task suite (v${e.bench.suite}); re-run to compare fairly with v${B.SUITE_VERSION} results">old suite</span>`);
    if (e.kind && e.kind !== 'chat') out.push(`<span class="pv-tag t-violet">${escapeHtml(e.kind)}</span>`);
    if (e.hasVision) out.push(`<span class="icon-badge type-vision" title="Vision">${ICON.eye}</span>`);
    if (e.hasReasoning) out.push(`<span class="icon-badge type-think" title="Reasoning">${ICON.brain}</span>`);
    if (e.isFree) out.push('<span class="pv-tag t-green">free</span>');
    else if (e.isFreeForPaid) out.push('<span class="pv-tag t-amber">free for paid</span>');
    out.push(capsBadges(e));
    return out.join('');
  }

  // Probed capabilities as three small letters: T tools · J JSON mode · L long
  // context. Green = works, red = refused or failed, grey = not probed yet.
  function capsBadges(e) {
    const c = e.caps;
    const one = (label, title, probe) => {
      const st = !c ? 'unknown' : probe && probe.supported === true ? 'yes' : probe && probe.supported === false ? 'no' : 'unknown';
      const note = probe && probe.note ? ` — ${probe.note}` : c ? '' : ' — not probed yet (runs with the benchmark)';
      return `<span class="mc-cap mc-cap-${st}" title="${escapeHtml(title + note)}">${label}</span>`;
    };
    return `<span class="mc-caps">${one('T', 'Tool calling', c && c.tools)}${one('J', 'Strict JSON mode', c && c.json)}${one('L', 'Long context (5.5k-token needle)', c && c.longContext)}</span>`;
  }

  function priceLabel(e) {
    const p = e.pricing;
    if (!p) return null;
    if (p.input === 0 && p.output === 0) return 'free';
    const f = (v) => (v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(3)).replace(/\.?0+$/, '');
    return `$${f(p.input)} / $${f(p.output)} per 1M`;
  }

  function globalCell(e) {
    const g = globalFor(e);
    if (!g) return '<span class="dt-muted" title="Not on the Artificial Analysis leaderboard">—</span>';
    const idx = g.entry.index;
    const approx = g.confidence === 'exact' ? '' : '≈';
    let agree = '';
    if (e.bench) {
      const cmp = B.compareTiers(e.bench.tier, B.expectedTierFromIndex(idx));
      if (cmp) agree = `<span class="mc-agree mc-agree-${cmp.verdict}" title="${escapeHtml(cmp.text)}">${cmp.verdict === 'match' ? '✓' : cmp.delta > 0 ? '↑' : '↓'}</span>`;
    }
    return `<span class="mc-global" title="${escapeHtml(g.entry.name)} — Intelligence Index ${idx ?? '—'} (${g.confidence} match)">${approx}${idx ?? '—'} ${tierBadge(B.expectedTierFromIndex(idx))}${agree}</span>`;
  }

  function actionButtons(e) {
    const key = escapeHtml(e.key);
    if (!benchmarkable(e)) return `<span class="dt-muted mc-na" title="The benchmark is a chat suite; ${escapeHtml(e.kind)} models are not scored">n/a</span>`;
    const pr = state.progress.get(e.key);
    if (pr) {
      return `<button class="dt-icon-btn mc-stop" type="button" data-mc-stop="${key}" title="Stop" aria-label="Stop benchmark">${ICON.stop}</button>`;
    }
    const label = e.bench ? 'Re-run benchmark' : 'Run benchmark';
    return `<button class="dt-icon-btn primary" type="button" data-mc-run="${key}" title="${label}" aria-label="${label}">${e.bench ? ICON.redo : ICON.play}</button>`;
  }

  function progressHTML(e) {
    const pr = state.progress.get(e.key);
    if (!pr) return '';
    const pct = pr.total ? Math.round((pr.done / pr.total) * 100) : 0;
    return `<div class="mc-progress" title="${escapeHtml(pr.note || '')}"><span class="spinner"></span><span class="mc-progress-bar"><span style="width:${pct}%"></span></span><span class="mc-progress-note">${escapeHtml(pr.note || '')}</span></div>`;
  }

  function rowHTML(e, rank) {
    const p = PROVIDERS[e.providerId];
    const b = e.bench;
    const open = state.expanded.has(e.key);
    const key = escapeHtml(e.key);
    const running = state.progress.has(e.key);
    const rankCell = rank ? `<span class="mc-rank ${rank <= 3 ? 'top' : ''}">#${rank}</span>` : '<span class="dt-muted">—</span>';
    return `<tr class="dt-row mc-row ${open ? 'open' : ''} ${running ? 'running' : ''}" data-mc-key="${key}" data-kx-toggle="${key}" aria-expanded="${open}" tabindex="0">
      <td class="dt-num col-rank">${rankCell}</td>
      <td><div class="dt-provider">${ICON.chevron}
        <span class="pv-logo">${providerMark(p)}</span>
        <div><div class="dt-provider-name mc-name">${escapeHtml(e.name || e.id)}${badges(e)}</div>
        <div class="dt-provider-host mc-sub">${healthDotHTML(p)}${escapeHtml(p.name)}${e.name && e.name !== e.id ? ` · <code>${escapeHtml(e.id)}</code>` : ''}${e.contextLabel ? ` · ${escapeHtml(e.contextLabel)}` : ''}${priceLabel(e) ? ` · ${escapeHtml(priceLabel(e))}` : ''}</div>
        ${progressHTML(e)}${e.benchError && !running ? `<div class="mc-error">${escapeHtml(e.benchError)}</div>` : ''}</div>
      </div></td>
      <td class="col-tier">${b && b.incomplete ? '<span class="mc-tier mc-tier-none" title="Incomplete run — too many requests failed; re-run">!</span>' : tierBadge(b ? b.tier : null)}</td>
      <td class="col-score">${scoreBar(b ? b.composite : null)}</td>
      <td class="dt-num col-iq">${b && b.quality != null ? `<span class="mc-cat ${scoreClass(b.quality / 100)}" title="Intelligence: ${b.items.filter((it) => it.ok).length} of ${b.answered} answered tasks correct, weighted by difficulty">${b.quality}</span>` : '<span class="dt-muted">—</span>'}</td>
      <td class="dt-num col-cat">${catCell(e, 'reasoning')}</td>
      <td class="dt-num col-cat">${catCell(e, 'coding')}</td>
      <td class="dt-num col-cat">${catCell(e, 'instruction')}</td>
      <td class="dt-num col-cat col-lang">${catCell(e, 'language')}</td>
      <td class="dt-num col-lat"><span class="${timeClass(b ? b.latencyMs : null)}">${b ? fmtMs(b.latencyMs) : '<span class="dt-muted">—</span>'}</span></td>
      <td class="dt-num col-ttft">${b && b.ttftMs != null ? fmtMs(b.ttftMs) : '<span class="dt-muted">—</span>'}</td>
      <td class="dt-num col-tps">${b && b.tps != null ? b.tps : '<span class="dt-muted">—</span>'}</td>
      <td class="col-global">${globalCell(e)}</td>
      <td class="dt-actions-col"><div class="dt-row-actions">${actionButtons(e)}</div></td>
    </tr>${open ? `<tr class="dt-detail mc-detail" data-mc-detail="${key}"><td colspan="14">${detailHTML(e)}</td></tr>` : ''}`;
  }

  function cardHTML(e, rank) {
    const p = PROVIDERS[e.providerId];
    const b = e.bench;
    const key = escapeHtml(e.key);
    const open = state.expanded.has(e.key);
    return `<article class="pv-card mc-card ${open ? 'open' : ''}" data-mc-key="${key}" style="--type-stripe:${escapeHtml(p.color || 'var(--accent)')}">
      <div class="pv-card-top">
        <span class="pv-logo">${providerMark(p)}</span>
        <span class="pv-host">${healthDotHTML(p)}${escapeHtml(p.name)}${e.contextLabel ? ` · ${escapeHtml(e.contextLabel)}` : ''}</span>
        ${tierBadge(b ? b.tier : null, { big: true })}
      </div>
      <h3 class="pv-name"><span>${escapeHtml(e.name || e.id)}</span></h3>
      <div class="mc-card-badges">${badges(e)}${rank ? `<span class="mc-rank ${rank <= 3 ? 'top' : ''}">#${rank}</span>` : ''}</div>
      ${progressHTML(e)}${e.benchError && !state.progress.has(e.key) ? `<div class="mc-error">${escapeHtml(e.benchError)}</div>` : ''}
      <div class="pv-stats">
        <div class="pv-stat"><span class="pv-stat-label">Score</span><span class="pv-stat-value">${b ? (b.composite ?? '!') : '—'}</span></div>
        <div class="pv-stat"><span class="pv-stat-label">IQ</span><span class="pv-stat-value">${b && b.quality != null ? b.quality : '—'}</span></div>
        <div class="pv-stat"><span class="pv-stat-label">Latency</span><span class="pv-stat-value ${timeClass(b ? b.latencyMs : null)}">${b ? fmtMs(b.latencyMs) : '—'}</span></div>
        <div class="pv-stat"><span class="pv-stat-label">TTFT</span><span class="pv-stat-value">${b && b.ttftMs != null ? fmtMs(b.ttftMs) : '—'}</span></div>
        <div class="pv-stat"><span class="pv-stat-label">Global</span><span class="pv-stat-value">${globalCell(e)}</span></div>
      </div>
      <div class="pv-card-actions">
        <button class="btn btn-ghost btn-mini" type="button" data-kx-toggle="${key}">${open ? 'Hide details' : 'Details'}</button>
        ${actionButtons(e)}
      </div>
      ${open ? `<div class="mc-card-detail">${detailHTML(e)}</div>` : ''}
    </article>`;
  }

  function historyBars(e) {
    const h = e.history || [];
    if (h.length < 2) return '';
    return `<div class="mc-hist" title="Composite score over the last ${h.length} runs">${h.map((r) => `<span class="${r.composite == null ? 'bad' : scoreClass(r.composite / 100)}" style="height:${Math.max(8, r.composite ?? 0)}%" title="${new Date(r.at).toLocaleString()} — ${r.composite ?? 'incomplete'}${r.tier ? ` (${r.tier})` : ''}"></span>`).join('')}</div>`;
  }

  function detailHTML(e) {
    const b = e.bench;
    const g = globalFor(e);
    const lb = leaderboard();
    if (!b) {
      const cta = benchmarkable(e)
        ? `<p class="mc-muted">Not benchmarked yet. The suite is ${B.TASKS.length} short graded tasks plus two latency probes — ${B.TASKS.length + 2} requests, a few seconds, a fraction of a cent.</p>
           <button class="btn btn-primary" type="button" data-mc-run="${escapeHtml(e.key)}">${ICON.play} Run benchmark</button>`
        : `<p class="mc-muted">This is a ${escapeHtml(e.kind)} model. The benchmark is a chat suite, so it is listed here but not scored — test it from Route Test.</p>`;
      return `<div class="mc-detail-grid">
        <div class="mc-panel"><div class="mc-panel-head">Benchmark</div>${cta}</div>
        <div class="mc-side">${globalPanelHTML(e, g, lb)}${readinessPanelHTML(e)}</div>
      </div>`;
    }
    const rows = b.items.map((it) => `<tr>
        <td><span class="mc-cat-tag">${escapeHtml(B.CATEGORIES[it.category]?.short || it.category)}</span>${it.tier === 'expert' ? '<span class="mc-cat-tag mc-expert" title="Worth triple">expert</span>' : it.hard ? '<span class="mc-cat-tag mc-hard" title="Worth double">hard</span>' : ''} ${escapeHtml(it.label)}</td>
        <td class="mc-verdict ${it.ok ? 'ok' : 'no'}">${it.ok ? ICON.pass : ICON.fail} ${it.ok ? 'pass' : it.status === 'ok' ? 'wrong' : escapeHtml(it.status)}</td>
        <td class="dt-num">${fmtMs(it.time)}</td>
        <td class="mc-reply" title="${escapeHtml(it.reply || '')}">${escapeHtml((it.reply || '').slice(0, 90))}</td>
      </tr>`).join('');
    const probeList = Array.isArray(b.probes)
      ? b.probes.map((pr, i) => ({ label: `Latency probe ${i + 1}`, ...pr, note: `first token ${fmtMs(pr.ttft)}` }))
      : [
        b.probes.latency && { label: 'Latency probe', ...b.probes.latency, note: `first token ${fmtMs(b.probes.latency.ttft)}` },
        b.probes.throughput && { label: 'Throughput probe', ...b.probes.throughput, note: `${b.probes.throughput.tokens || 0} tokens · first token ${fmtMs(b.probes.throughput.ttft)} · ${b.tps ?? '—'} tok/s` },
      ].filter(Boolean);
    const probes = probeList.map((pr) => `<tr><td><span class="mc-cat-tag">Speed</span> ${escapeHtml(pr.label)}</td><td class="mc-verdict ${pr.status === 'ok' ? 'ok' : 'no'}">${pr.status === 'ok' ? ICON.pass : ICON.fail} ${escapeHtml(pr.status)}</td><td class="dt-num">${fmtMs(pr.time)}</td><td class="mc-reply">${escapeHtml(pr.status === 'ok' ? pr.note : (pr.error || ''))}</td></tr>`).join('');
    return `<div class="mc-detail-grid">
      <div class="mc-panel mc-panel-wide">
        <div class="mc-panel-head">Benchmark run <span class="mc-muted">${new Date(b.at).toLocaleString()} · suite v${b.suite}</span>${historyBars(e)}</div>
        ${b.incomplete ? `<div class="mc-verdict-line mc-agree-diverge">Incomplete: only ${b.answered} of ${b.items.length} tasks got an answer from the provider, so no score is given. Re-run when the provider is stable.</div>` : ''}
        <div class="mc-breakdown">
          ${metric('Composite', b.composite, `${Math.round(B.WEIGHTS.quality * 100)}% intelligence · ${Math.round(B.WEIGHTS.speed * 100)}% speed · ${Math.round(B.WEIGHTS.reliability * 100)}% reliability`)}
          ${metric('Intelligence', b.quality, `${b.items.filter((it) => it.ok).length} of ${b.answered ?? b.items.length} answered correct (${b.items.filter((it) => it.ok && it.tier === 'expert').length}/${b.items.filter((it) => it.tier === 'expert').length} expert, ${b.items.filter((it) => it.ok && it.tier === 'hard').length}/${b.items.filter((it) => it.tier === 'hard').length} hard)`)}
          ${metric('Speed', b.speed, `latency ${fmtMs(b.latencyMs)} · first token ${fmtMs(b.ttftMs)} · ${b.tps ?? '—'} tok/s`)}
          ${metric('Reliability', b.reliability, `${b.items.length - (b.answered ?? b.items.length)} task${b.items.length - (b.answered ?? b.items.length) === 1 ? '' : 's'} failed at the provider (excluded from intelligence)`)}
        </div>
        <table class="mc-items"><thead><tr><th>Task</th><th>Result</th><th>Time</th><th>Reply</th></tr></thead><tbody>${rows}${probes}</tbody></table>
      </div>
      <div class="mc-side">${globalPanelHTML(e, g, lb)}${readinessPanelHTML(e)}</div>
    </div>`;
  }

  function metric(label, value, sub) {
    return `<div class="mc-metric"><span class="mc-metric-label">${escapeHtml(label)}</span><span class="mc-metric-value ${scoreClass((value ?? 0) / 100)}">${value ?? '—'}</span><span class="mc-metric-sub">${escapeHtml(sub)}</span></div>`;
  }

  // What the router profiles read off this model, in one place, so a model's
  // absence from a profile can be traced to a fact rather than a mystery.
  function readinessPanelHTML(e) {
    const r = reliability(e);
    const s = stability(e);
    const c = e.caps;
    const capLine = (label, probe) => {
      if (!c) return `<div class="mc-compare-row"><span>${label}</span><span class="dt-muted">not probed</span><span></span></div>`;
      const st = probe.supported === true ? '<b class="mc-ok">yes</b>' : probe.supported === false ? '<b class="mc-no">no</b>' : '<span class="dt-muted">unknown</span>';
      return `<div class="mc-compare-row"><span>${label}</span><span>${st}</span><span class="mc-note" title="${escapeHtml(probe.note || '')}">${escapeHtml((probe.note || '').slice(0, 42))}</span></div>`;
    };
    const rate = r.rate == null ? '<span class="dt-muted">no evidence</span>' : `<b class="${r.rate >= 0.97 ? 'mc-ok' : r.rate >= 0.9 ? '' : 'mc-no'}">${Math.round(r.rate * 100)}%</b>`;
    const prof = window.PROFILES ? window.PROFILES.membershipOf(e) : null;
    return `<div class="mc-panel">
      <div class="mc-panel-head">Router readiness <span class="mc-muted">what the profiles see</span></div>
      <div class="mc-compare">
        <div class="mc-compare-row head"><span>Capability</span><span>Result</span><span>Note</span></div>
        ${capLine('Tool calling', c && c.tools)}
        ${capLine('JSON mode', c && c.json)}
        ${capLine('Long context', c && c.longContext)}
        <div class="mc-compare-row"><span>Long-prompt latency</span><span>${c && c.longLatencyMs ? fmtMs(c.longLatencyMs) : '<span class="dt-muted">—</span>'}</span><span></span></div>
        <div class="mc-compare-row"><span>Price (in / out, 1M)</span><span>${priceLabel(e) ? escapeHtml(priceLabel(e)) : '<span class="dt-muted">unknown</span>'}</span><span class="mc-note">${e.pricing ? escapeHtml(e.pricing.source) : ''}</span></div>
        <div class="mc-compare-row"><span>Reliability 7d</span><span>${rate}</span><span class="mc-note">${r.n} verdict${r.n === 1 ? '' : 's'}${r.streak ? ` · ${r.streak} failing in a row` : ''}</span></div>
        <div class="mc-compare-row"><span>Stability</span><span>${s.spread == null ? '<span class="dt-muted">need 2 runs</span>' : `<b class="${s.spread <= 6 ? 'mc-ok' : s.spread <= 12 ? '' : 'mc-no'}">±${s.spread}</b>`}</span><span class="mc-note">${s.n} benchmark run${s.n === 1 ? '' : 's'}</span></div>
        <div class="mc-compare-row"><span>Family</span><span class="mc-note"><code>${escapeHtml(familyKey(e))}</code></span><span></span></div>
        ${prof ? `<div class="mc-compare-row"><span>Profiles</span><span>${prof.length ? prof.map((m) => `<span class="pf-chip pf-${m.profile}">${escapeHtml(m.profile)} #${m.rank}</span>`).join(' ') : '<span class="dt-muted">none yet</span>'}</span><span></span></div>` : ''}
      </div>
      ${e.capsError ? `<p class="mc-error">${escapeHtml(e.capsError)}</p>` : ''}
      <div class="settings-actions" style="margin-top:10px">
        <button class="btn btn-ghost btn-mini" type="button" data-mc-caps="${escapeHtml(e.key)}">${c ? 'Re-probe capabilities' : 'Probe capabilities'}</button>
      </div>
    </div>`;
  }

  function globalPanelHTML(e, g, lb) {
    const src = escapeHtml(lb.source || 'snapshot');
    const when = lb.at ? formatAgo(lb.at) : lb.capturedAt ? `snapshot ${escapeHtml(lb.capturedAt)}` : '';
    if (!g) {
      return `<div class="mc-panel"><div class="mc-panel-head">Global reference</div>
        <p class="mc-muted">No entry on the Artificial Analysis leaderboard matches <code>${escapeHtml(e.id)}</code>. Renamed or provider-specific models don't appear there.</p>
        <p class="mc-source">Source: ${src}${when ? ` · ${when}` : ''}</p></div>`;
    }
    const ent = g.entry;
    const r = globalRank(ent);
    const expected = B.expectedTierFromIndex(ent.index);
    const cmp = e.bench ? B.compareTiers(e.bench.tier, expected) : null;
    const ttftSec = Number.isFinite(Number(ent.ttft)) && ent.ttft !== null ? `${Number(ent.ttft).toFixed(2)}s` : '—';
    const ours = e.bench;
    return `<div class="mc-panel">
      <div class="mc-panel-head">Global reference <span class="mc-muted">${g.confidence === 'exact' ? 'exact match' : g.confidence === 'family' ? 'same family' : 'approximate match'}</span></div>
      <div class="mc-global-name">${escapeHtml(ent.name)} <span class="mc-muted">by ${escapeHtml(ent.creator || '—')}</span></div>
      <div class="mc-compare">
        <div class="mc-compare-row head"><span></span><span>Global</span><span>Ours</span></div>
        <div class="mc-compare-row"><span>Intelligence</span><span>${ent.index ?? '—'} <small>index</small> ${tierBadge(expected)}</span><span>${ours ? `${ours.quality} <small>/100</small> ${tierBadge(ours.tier)}` : '—'}</span></div>
        <div class="mc-compare-row"><span>Rank</span><span>${r.rank ? `#${r.rank} <small>of ${r.of}</small>` : '—'}</span><span>${ours ? `#${ranked(visibleEntries()).get(e.key) || '—'} <small>of ${visibleEntries().filter((x) => x.bench).length}</small>` : '—'}</span></div>
        <div class="mc-compare-row"><span>First token</span><span>${ttftSec}</span><span>${ours && ours.ttftMs != null ? fmtMs(ours.ttftMs) : '—'}</span></div>
        <div class="mc-compare-row"><span>Tokens / s</span><span>${ent.tps ?? '—'}</span><span>${ours && ours.tps != null ? ours.tps : '—'}</span></div>
      </div>
      ${cmp ? `<div class="mc-verdict-line mc-agree-${cmp.verdict}">${cmp.verdict === 'match' ? ICON.pass : ''} ${escapeHtml(cmp.text)}</div>` : '<p class="mc-muted">Run the benchmark to compare.</p>'}
      <p class="mc-source">Source: ${src}${when ? ` · ${when}` : ''}. Global speed is measured on a 1k-token prompt; ours on a short one, so compare tiers, not raw seconds.</p>
    </div>`;
  }

  // ---- list / filter / sort ------------------------------------------------

  function filtered(list) {
    const q = ui.search.trim().toLowerCase();
    let out = list.filter((e) => {
      const p = PROVIDERS[e.providerId];
      if (ui.provider !== 'all' && e.providerId !== ui.provider) return false;
      if (q && !`${e.name} ${e.id} ${p.name} ${e.ownedBy}`.toLowerCase().includes(q)) return false;
      if (ui.filter === 'new') return !!e.isNew;
      if (ui.filter === 'benchmarked') return !!e.bench;
      if (ui.filter === 'untested') return !e.bench;
      if (ui.filter === 'global') return !!globalFor(e);
      return true;
    });
    const rank = ranked(list);
    const num = (v) => (v == null ? Infinity : v);
    const by = {
      rank: (a, b) => (rank.get(a.key) || 1e9) - (rank.get(b.key) || 1e9) || a.name.localeCompare(b.name),
      quality: (a, b) => (b.bench?.quality ?? -1) - (a.bench?.quality ?? -1),
      latency: (a, b) => num(a.bench?.latencyMs) - num(b.bench?.latencyMs),
      ttft: (a, b) => num(a.bench?.ttftMs) - num(b.bench?.ttftMs),
      tps: (a, b) => (b.bench?.tps ?? -1) - (a.bench?.tps ?? -1),
      global: (a, b) => (globalFor(b)?.entry.index ?? -1) - (globalFor(a)?.entry.index ?? -1),
      newest: (a, b) => b.firstSeen - a.firstSeen,
      name: (a, b) => (a.name || a.id).localeCompare(b.name || b.id),
      provider: (a, b) => PROVIDERS[a.providerId].name.localeCompare(PROVIDERS[b.providerId].name) || a.name.localeCompare(b.name),
    };
    out.sort(by[ui.sort] || by.rank);
    return { out, rank };
  }

  function renderKpis(list) {
    const connected = Object.values(PROVIDERS).filter(isConnected);
    const benched = list.filter((e) => e.bench).length;
    const fresh = list.filter((e) => e.isNew).length;
    const v = validity(list);
    const removedRecently = Object.values(state.data.models).filter((e) => e.removedAt && Date.now() - e.removedAt < 7 * 86400000).length;
    const lastSync = Object.values(state.data.lastSync).reduce((m, t) => Math.max(m, t || 0), 0);
    $('#mc-kpis').innerHTML = statCardsHTML([
      { label: 'Models', value: list.length, icon: ICON.box, foot: removedRecently ? `${removedRecently} removed this week` : 'listed by connected providers' },
      { label: 'Providers', value: connected.length, sub: `/ ${Object.keys(PROVIDERS).length}`, icon: ICON.plug,
        meter: Object.keys(PROVIDERS).length ? connected.length / Object.keys(PROVIDERS).length : 0, foot: 'connected' },
      { label: 'Benchmarked', value: benched, sub: `/ ${list.length}`, icon: ICON.trophy, meter: list.length ? benched / list.length : 0,
        foot: state.running ? 'running…' : state.queue.length ? `${state.queue.length} queued` : benched ? 'ranked below' : 'press ▶ on a model to start' },
      { label: 'New models', value: fresh, icon: ICON.flag, foot: fresh ? 'since the last baseline' : 'nothing new since baseline' },
      { label: 'Validity vs global', value: v.rho == null ? '—' : v.rho.toFixed(2), icon: ICON.globe,
        meter: v.rho == null ? null : Math.max(0, v.rho), foot: v.n >= 3 ? `${v.label} (ρ, ${v.n} models)` : `needs 3+ benchmarked models on the global board (${v.n})` },
      { label: 'Last sync', value: lastSync ? escapeHtml(formatAgo(lastSync)) : '—', icon: ICON.clock,
        foot: state.syncing ? 'syncing…' : `${state.syncNote || 'every'} · every ${Math.max(1, Number(settings.catalogSyncMinutes) || 5)} min` },
    ]);
  }

  function providerSelectHTML() {
    const ps = Object.values(PROVIDERS).filter(isConnected).sort((a, b) => a.name.localeCompare(b.name));
    return `<label class="dt-select mc-provider-select">Provider<select data-mc-provider aria-label="Provider">
      <option value="all" ${ui.provider === 'all' ? 'selected' : ''}>All</option>
      ${ps.map((p) => `<option value="${escapeHtml(p.id)}" ${ui.provider === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
    </select></label>`;
  }

  function renderResults() {
    const list = visibleEntries();
    const q = ui.search.trim().toLowerCase();
    const searched = list.filter((e) => (ui.provider === 'all' || e.providerId === ui.provider) && (!q || `${e.name} ${e.id} ${PROVIDERS[e.providerId].name}`.toLowerCase().includes(q)));
    const count = { all: searched.length, new: 0, benchmarked: 0, untested: 0, global: 0 };
    searched.forEach((e) => {
      if (e.isNew) count.new += 1;
      if (e.bench) count.benchmarked += 1; else count.untested += 1;
      if (globalFor(e)) count.global += 1;
    });
    $$('#mc-toolbar [data-dt-count]').forEach((el) => { el.textContent = count[el.dataset.dtCount] ?? 0; });

    const { out, rank } = filtered(list);
    const results = $('#mc-results');
    if (!out.length) {
      results.innerHTML = `<div class="dt-nomatch">${DT_ICON.nomatch}<p>No models match.</p></div>`;
      return;
    }
    if (ui.view === 'cards') {
      results.innerHTML = `<div class="pv-grid mc-grid">${out.map((e) => cardHTML(e, rank.get(e.key))).join('')}</div>`;
      return;
    }
    results.innerHTML = `<div class="dt-table-wrap mc-table-wrap"><table class="dt-table mc-table">
      <thead><tr>
        <th class="col-rank">#</th><th>Model</th><th class="col-tier">Tier</th><th class="col-score">Score</th>
        <th class="col-iq" title="Intelligence: weighted share of answered tasks solved (easy ×1, hard ×2, expert ×3). Provider errors are excluded, not counted as wrong.">IQ</th>
        <th class="col-cat" title="Reasoning & math score (0–100, hard tasks count double)">Reason</th><th class="col-cat" title="Coding score (0–100, hard tasks count double)">Code</th><th class="col-cat" title="Instruction following score (0–100, hard tasks count double)">Instruct</th><th class="col-cat col-lang" title="Arabic comprehension and instruction following">Arabic</th>
        <th class="col-lat" title="Median response time across the graded tasks">Latency</th><th class="col-ttft" title="Time to first token (streamed probe)">TTFT</th><th class="col-tps" title="Output tokens per second">Tok/s</th>
        <th class="col-global" title="Artificial Analysis Intelligence Index and the tier it maps to">Global</th><th class="dt-actions-col">Run</th>
      </tr></thead>
      <tbody>${out.map((e) => rowHTML(e, rank.get(e.key))).join('')}</tbody>
    </table></div>`;
  }

  // Re-render just one row (progress ticks) without rebuilding the table.
  function renderRow(key) {
    if (currentPage !== 'catalog' || !state.shell) return;
    const e = state.data.models[key];
    if (!e) return;
    const rank = ranked(visibleEntries()).get(key);
    if (ui.view === 'cards') {
      const card = document.querySelector(`.mc-card[data-mc-key="${CSS.escape(key)}"]`);
      if (!card) return renderIfShown();
      card.outerHTML = cardHTML(e, rank);
      return;
    }
    const row = document.querySelector(`tr.mc-row[data-mc-key="${CSS.escape(key)}"]`);
    if (!row) return renderIfShown();
    const detail = document.querySelector(`tr.mc-detail[data-mc-detail="${CSS.escape(key)}"]`);
    if (detail) detail.remove();
    row.outerHTML = rowHTML(e, rank);
  }

  function renderCrumbs() {
    $('#mc-crumbs').innerHTML = breadcrumbHTML([
      { label: 'Overview', page: 'overview' },
      { label: 'Model Pool', icon: 'catalog' },
    ]);
  }

  function render() {
    if (!state.loaded) { load().then(render); return; }
    const body = $('#mc-body');
    if (!body) return;
    renderCrumbs();
    const connected = Object.values(PROVIDERS).filter(isConnected);
    if (!connected.length) {
      state.shell = false;
      body.innerHTML = `<div class="pv-empty">
        <div class="pv-empty-icon">${ICON.empty}</div>
        <h3>No providers connected</h3>
        <p>The model pool lists the models of every provider that has an API key. Connect one and its models appear here within seconds, then stay in step with what the provider offers.</p>
        <button class="btn btn-primary" type="button" data-go="providers">${ICON.plug}Open Providers</button>
      </div>`;
      return;
    }
    if (!state.shell) {
      state.shell = true;
      body.innerHTML = `<div id="mc-kpis"></div>
        <div id="mc-toolbar">${dataToolbarHTML(TOOLBAR, ui)}</div>
        <div id="mc-results"></div>`;
      const tb = $('#mc-toolbar');
      bindDataToolbar(tb, ui, () => renderResults());
      tb.querySelector('.dt-left').insertAdjacentHTML('beforeend', providerSelectHTML());
      tb.querySelector('.dt-actions').insertAdjacentHTML('afterbegin',
        `<button class="dt-icon-btn mc-sync-btn" type="button" data-mc-sync title="Sync now" aria-label="Sync now">${ICON.sync}</button>`);
      tb.querySelector('[data-mc-provider]').addEventListener('change', (ev) => { ui.provider = ev.target.value; renderResults(); });
    } else {
      // Providers may have connected or disconnected since the shell was built.
      const sel = $('#mc-toolbar .mc-provider-select');
      if (sel) {
        if (ui.provider !== 'all' && !(PROVIDERS[ui.provider] && isConnected(PROVIDERS[ui.provider]))) ui.provider = 'all';
        sel.outerHTML = providerSelectHTML();
        $('#mc-toolbar [data-mc-provider]').addEventListener('change', (ev) => { ui.provider = ev.target.value; renderResults(); });
      }
    }
    const syncBtn = $('#mc-toolbar [data-mc-sync]');
    if (syncBtn) syncBtn.classList.toggle('spin', state.syncing);
    renderKpis(visibleEntries());
    renderResults();
  }

  function renderIfShown() {
    if (currentPage !== 'catalog') return;
    // Coalesce bursts (progress ticks from two lanes) into one paint.
    if (state.pendingRender) return;
    state.pendingRender = requestAnimationFrame(() => { state.pendingRender = null; render(); });
  }

  // ---- events --------------------------------------------------------------

  function bind() {
    const page = $('.page-catalog');
    if (!page) return;
    page.addEventListener('click', (ev) => {
      const run = ev.target.closest('[data-mc-run]');
      if (run) { ev.stopPropagation(); enqueue(run.dataset.mcRun); return; }
      const stop = ev.target.closest('[data-mc-stop]');
      if (stop) { ev.stopPropagation(); dequeue(stop.dataset.mcStop); return; }
      const caps = ev.target.closest('[data-mc-caps]');
      if (caps) { ev.stopPropagation(); probeCaps(caps.dataset.mcCaps); return; }
      if (ev.target.closest('[data-mc-sync]')) { syncAll({ reason: 'manual' }); return; }
      const go = ev.target.closest('[data-go]');
      if (go) { showPage(go.dataset.go); return; }
      const tog = ev.target.closest('[data-kx-toggle]');
      if (tog) {
        // Clicks on links or inputs inside a row shouldn't toggle it.
        if (ev.target.closest('button') && !tog.matches('button')) return;
        const key = tog.dataset.kxToggle;
        if (state.expanded.has(key)) state.expanded.delete(key); else state.expanded.add(key);
        renderResults();
      }
    });
    page.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const row = ev.target.closest('tr.mc-row');
      // Only the row itself toggles; a focused Run/Stop button keeps its own key handling.
      if (!row || ev.target !== row) return;
      ev.preventDefault();
      const key = row.dataset.mcKey;
      if (state.expanded.has(key)) state.expanded.delete(key); else state.expanded.add(key);
      renderResults();
    });

    // Keys added or removed on the Providers page: that provider's models
    // appear or vanish right away, and its catalogue is re-read.
    let providerTimer = null;
    window.addEventListener('providers-changed', (ev) => {
      clearTimeout(providerTimer);
      renderIfShown();
      providerTimer = setTimeout(() => syncAll({ reason: 'providers', providerId: ev.detail?.providerId || null }), 1500);
    });
    window.addEventListener('focus', () => {
      const minutes = Math.max(1, Number(settings.catalogSyncMinutes) || 5);
      if (Date.now() - state.lastSyncAt > minutes * 60 * 1000) syncAll({ reason: 'focus' });
    });
    window.addEventListener('online', () => syncAll({ reason: 'online' }));
    COMPACT_LAYOUT.addEventListener('change', (mq) => {
      ui.view = mq.matches ? 'cards' : 'table';
      renderIfShown();
    });
  }

  // ---- settings section ----------------------------------------------------

  function fillSettings() {
    const sync = $('#set-catalog-sync');
    if (sync) sync.value = Math.max(1, Number(settings.catalogSyncMinutes) || 5);
    const auto = $('#set-catalog-autobench');
    if (auto) auto.checked = !!settings.catalogAutoBench;
    renderAaKey();
    renderLeaderboardStatus();
  }

  // The key never comes back to the page: a saved one shows as "Saved" with an
  // empty field, and typing a new one replaces it.
  const AA_PLACEHOLDER = 'aa_… (free key from artificialanalysis.ai)';
  function renderAaKey() {
    const saved = settings.aaApiKey === 'venomsecret:aaApiKey';
    const key = $('#set-aa-key');
    if (key) {
      key.value = '';
      key.placeholder = saved ? 'Saved — type a new key to replace it' : AA_PLACEHOLDER;
    }
    const badge = $('#aa-key-saved');
    if (badge) badge.hidden = !saved;
    const remove = $('#btn-aa-remove');
    if (remove) remove.hidden = !saved;
  }

  // Empty or unchanged text is not a change. New text goes to main, which
  // encrypts it; the page keeps only the placeholder. On failure the typed
  // text stays in the field so it can be retried.
  async function storeAaKey() {
    const key = $('#set-aa-key');
    const text = key ? key.value.trim() : '';
    if (!text || text === settings.aaApiKey) return;
    const res = await persist('save the Artificial Analysis key', () => window.electronAPI.saveSecret('aaApiKey', text));
    if (!res) return;
    settings.aaApiKey = res.placeholder;
    renderAaKey();
  }

  async function removeAaKey() {
    const res = await persist('remove the Artificial Analysis key', () => window.electronAPI.saveSecret('aaApiKey', ''));
    if (!res) return;
    settings.aaApiKey = '';
    renderAaKey();
    renderLeaderboardStatus();
  }

  function renderLeaderboardStatus() {
    const el = $('#aa-status');
    if (!el) return;
    if (!state.loaded) { load().then(renderLeaderboardStatus); return; }
    const lb = leaderboard();
    const err = state.data.leaderboardError;
    const live = state.data.leaderboard;
    const parts = [`${lb.models.length} models`];
    if (live) parts.push(`live · refreshed ${formatAgo(live.at)}`);
    else parts.push(`bundled snapshot · ${window.LEADERBOARD_SNAPSHOT?.capturedAt || ''}`);
    if (err) parts.push(`last refresh failed: ${err.error}`);
    el.textContent = parts.join(' · ');
  }

  function bindSettings() {
    const sec = $('#sec-catalog');
    if (sec) sec.addEventListener('click', (ev) => {
      const site = ev.target.closest('[data-site]');
      if (site) window.electronAPI.openExternal(site.dataset.site);
    });
    const sync = $('#set-catalog-sync');
    if (sync) sync.addEventListener('change', () => {
      const v = Math.max(1, Math.min(120, Math.round(Number(sync.value) || 5)));
      sync.value = v;
      settings.catalogSyncMinutes = v;
      queueSettingsSave();
      scheduleTimer();
    });
    const auto = $('#set-catalog-autobench');
    if (auto) auto.addEventListener('change', () => { settings.catalogAutoBench = auto.checked; queueSettingsSave(); });
    const key = $('#set-aa-key');
    if (key) key.addEventListener('change', storeAaKey);
    const removeKey = $('#btn-aa-remove');
    if (removeKey) removeKey.addEventListener('click', removeAaKey);
    const refresh = $('#btn-aa-refresh');
    if (refresh) refresh.addEventListener('click', async () => {
      await storeAaKey();
      refresh.disabled = true;
      const el = $('#aa-status');
      if (el) el.textContent = 'Refreshing…';
      try {
        const r = await refreshLeaderboard({ force: true });
        if (!r.ok && el) el.textContent = `Refresh failed: ${r.error}`;
        else renderLeaderboardStatus();
      } finally {
        refresh.disabled = false;
      }
    });
    const clear = $('#btn-catalog-clear-bench');
    if (clear) clear.addEventListener('click', () => {
      if (!state.loaded) return;
      Object.values(state.data.models).forEach((e) => { e.bench = null; e.history = []; e.benchError = null; });
      save({ reset: true });
      renderIfShown();
      setStatus('done', 'Benchmark results cleared');
    });
    const reset = $('#btn-catalog-reset');
    if (reset) reset.addEventListener('click', () => {
      if (!state.loaded) return;
      state.data.models = {};
      state.data.lastSync = {};
      save({ reset: true });
      renderIfShown();
      syncAll({ reason: 'reset' });
      setStatus('done', 'Model pool reset — re-syncing');
    });
  }

  // ---- init ----------------------------------------------------------------

  async function init() {
    await load();
    bind();
    bindSettings();
    scheduleTimer();
    // First pass right away so the page is populated on first visit.
    syncAll({ reason: 'startup' });
  }

  window.CATALOG = {
    init,
    render,
    renderIfShown,
    syncAll,
    enqueue,
    fillSettings,
    refreshLeaderboard,
    load,
    visibleEntries,
    keyModels,
    providerModelCount,
    forgetKey,
    globalFor,
    familyKey,
    reliability,
    stability,
    capsStale,
    save,
    state,
    ui,
  };
})();
