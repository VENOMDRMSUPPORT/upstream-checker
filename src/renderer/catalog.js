// ============================================
// Models Catalog — the merged reference, scored
// ============================================
// Every model each connected provider currently lists, kept current by a
// periodic sync. The rows are NOT this page's: main owns them. The adapters
// discover a provider's roster, catalog:ingest maps it through the reference
// merge and writes it to venom.db, and catalog:read hands back what was stored
// re-scored against today's reference. This file draws that and does the three
// things a row can ask for: a health probe, a re-read from the sources, a chat.
//
// Nothing here is written to the model pool — there is no pool document to
// write. Each mutating call is its own channel and its own answer, which is why
// every handler below tests `reply.ok === false` and never catches: err.code
// does not survive ipcMain.handle (src/catalog/ipc.js, the contract).
//
// Loaded after app.js and relies on its globals.

(function () {
  'use strict';

  const state = {
    // key -> the row catalog:read served. Keyed `${providerId}::${id}` because
    // that is the one identity a provider roster, a health write and a button
    // all agree on.
    models: new Map(),
    providers: [],   // the per-provider verdicts the read answered with
    roster: new Map(), // providerId -> the raw adapter list last discovered
    keyModels: {},   // keyId -> { count, at }, for the Providers page
    loaded: false,
    syncing: false,
    lastSyncAt: 0,
    syncNote: '',
    timer: null,
    expanded: new Set(),
    shell: false,
    // The capabilities legend starts closed by default. The toggle folds/unfolds it.
    legendOpen: true,
    pendingRender: null,
    healthBusy: new Set(), // keys whose health check is in flight
    healthAct: new Map(),  // key -> { tone, icon, label, timer } — the verdict shown on the heart itself
    fetching: new Set(),   // keys re-reading their model's facts from the sources
  };

  // The chat drawer: one open conversation with a single model. Nothing is
  // written to the catalogue, the run history or the request log — it is a
  // direct line to the model, so it is deliberately kept out of routing
  // evidence.
  const chat = {
    key: null,          // catalog key of the model being talked to
    messages: [],       // [{ role: 'user'|'assistant', content }]
    busy: false,        // a request is in flight
    opener: null,       // element to hand focus back to on close
  };

  const details = {
    key: null,          // catalog key of model currently viewed in sidebar drawer
    opener: null,       // element to restore focus to
  };

  const ui = {
    tab: 'connected',
    search: '',
    filter: 'all',
    costTab: 'all',
    sort: 'rank',
    provider: 'all',
    view: COMPACT_LAYOUT.matches ? 'cards' : 'table',
  };

  const keyOf = (pid, mid) => `${pid}::${mid}`;

  // ---- read ------------------------------------------------------------------

  // The connected set is the caller's: the renderer owns PROVIDERS and
  // isConnected, main filters what it is given against the providers it has.
  // An absent or empty set serves nothing — it never means "everything".
  function connectedIds() {
    return Object.values(PROVIDERS).filter(isConnected).map((p) => p.id);
  }

  const historyRuns = new Map();
  async function loadHistoryRuns() {
    try {
      if (window.electronAPI && typeof window.electronAPI.readHistory === 'function') {
        const data = await window.electronAPI.readHistory();
        historyRuns.clear();
        (data.runs || []).forEach((run) => {
          (run.results || []).forEach((r) => {
            const key = keyOf(run.provider, r.model);
            if (!historyRuns.has(key)) historyRuns.set(key, []);
            const ms = Number.isFinite(r.time) ? r.time : null;
            const cTokens = Number.isFinite(r.completionTokens) ? r.completionTokens : null;
            const tps = (cTokens && ms && ms > 0) ? Math.round((cTokens / (ms / 1000)) * 10) / 10 : null;
            historyRuns.get(key).push({
              at: run.at,
              ok: r.status === 'pass',
              status: r.status === 'pass' ? 'healthy' : 'error',
              note: r.status === 'pass' ? 'Test passed' : (r.error || 'Test failed'),
              ms,
              tokens: r.tokens,
              completionTokens: cTokens,
              tps,
            });
          });
        });
      }
    } catch (_) { /* ignore */ }
  }

  let loadPromise = null;
  function load() {
    if (state.loaded) return Promise.resolve(state.models);
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      loadHistoryRuns().catch(() => {});
      const reply = await window.electronAPI.catalogRead({ providerIds: connectedIds() });
      if (reply && reply.ok === false) {
        // The read answers its refusals as data; a rejected call here is a
        // genuine failure and is the only thing that shows the banner.
        failStartupRead('the model catalog', new Error(reply.message || reply.code));
        state.loaded = true;
        return state.models;
      }
      applyRead(reply);
      state.loaded = true;
      return state.models;
    })().catch((err) => {
      failStartupRead('the model catalog', err);
      state.loaded = true;
      return state.models;
    });
    return loadPromise;
  }

  /**
   * Drop what is held and read again.
   *
   * The reference is fetched on a TTL and re-scored when a fetch lands, so a page
   * still holding rows from before a refresh shows yesterday's number beside
   * today's. The test table forces a sync before every run; this is what it calls
   * afterwards, so the Models page and the test table cannot disagree about the
   * same model.
   */
  function reload() {
    state.loaded = false;
    loadPromise = null;
    return load().then(() => {
      renderIfShown();
      return state.models;
    });
  }

  function applyRead(reply) {
    if (!reply) return;
    state.models = new Map();
    for (const row of reply.rows || []) {
      // kind is the renderer's own classification (app.js classifyModel): the
      // engine stores the provider's facts and never a page decision, and the
      // three-button gate is a display rule.
      row.kind = classifyModel(row.providerId, row);
      row.key = keyOf(row.providerId, row.id);
      state.models.set(row.key, row);
    }
    state.providers = reply.providers || [];
    state.lastSyncAt = (reply.providers || []).reduce((m, p) => Math.max(m, p.lastSyncAt || 0), 0)
      || reply.lastSyncAt || 0;
    state.catalogCount = reply.catalogCount || 0;
    state.readStale = !!reply.stale;
    state.readWarning = reply.warning || null;
  }

  // The close handshake asks for the pending write. There is none — every
  // mutation is its own awaited channel — so this answers at once rather than
  // leaving app.js waiting on a timer that never exists.
  function flush() { return Promise.resolve(); }

  function entriesOf(pid) {
    return [...state.models.values()].filter((e) => e.providerId === pid);
  }

  // Per-key model counts for the Providers page: what this key sees, against
  // everything the provider's keys see together. Counted at discovery, because
  // the engine's roster is per provider and does not keep this.
  function keyModels(kid) { return state.keyModels[kid] || null; }

  function providerModelCount(pid) {
    if (!state.loaded) return null;
    return entriesOf(pid).length;
  }

  function forgetKey(kid) {
    if (state.keyModels[kid]) delete state.keyModels[kid];
  }

  function visibleEntries() {
    return [...state.models.values()].filter((e) => {
      const p = PROVIDERS[e.providerId];
      if (ui.tab === 'all') return !!p;
      return p && isConnected(p);
    });
  }

  // ---- model discovery / sync ----------------------------------------------

  // Asks every usable key, unions the answers, and applies the same
  // normalisation the Route Test page applies (dedupe, alias groups,
  // adapter exclusions). Returns null when no key answered, so a transient
  // outage never reads as "the provider removed everything".
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
        state.keyModels[k.id] = { count: new Set(list.filter((m) => !excluded(m)).map((m) => m.id)).size, at: Date.now() };
        list.forEach((m) => {
          const existing = byId.get(m.id);
          if (existing) {
            if (!existing.keyIds.includes(k.id)) existing.keyIds.push(k.id);
          } else {
            byId.set(m.id, { ...m, keyIds: [k.id] });
          }
        });
      } catch (_) { /* one bad key must not blank the catalogue the others returned */ }
    }
    if (!answered) return null;
    let list = tagAliasGroups(dedupeById([...byId.values()]));
    list = list.filter((m) => !excluded(m));
    // The raw list is kept as discovered: catalog:fetch-info takes the adapter
    // objects and main maps them, because the aliases an adapter declares are
    // the only way some rows reach the reference at all.
    state.roster.set(p.id, list);
    return list;
  }

  // One provider's pass: discover, hand main the roster, and take back what it
  // stored. Ingest is the only writer of the roster and it answers `{ ok:false,
  // code }` rather than rejecting, so the verdict is read off the reply.
  async function syncProvider(p) {
    const list = await discoverAll(p);
    if (!list) return { ok: false, added: [], removed: [], warning: 'no key answered' };
    const reply = await window.electronAPI.catalogIngest(p.id, list);
    if (reply && reply.ok === false) {
      return { ok: false, added: [], removed: [], warning: reply.message || reply.code };
    }
    // Merge the reply's rows in so the table shows what main stored, not what
    // the adapter said. A stale answer (a quarantined drop, a refused roster)
    // still carries rows, and they are the last-good ones.
    applyRows(p.id, reply.rows || []);
    return { ok: true, added: (reply.changes && reply.changes.added) || [],
      removed: (reply.changes && reply.changes.removed) || [],
      moved: (reply.changes && reply.changes.moved) || { appeared: 0, disappeared: 0 },
      stale: !!reply.stale, warning: reply.warning || null };
  }

  function applyRows(providerId, rows) {
    rows.forEach((row) => {
      row.providerId = providerId;
      row.kind = classifyModel(providerId, row);
      row.key = keyOf(providerId, row.id);
      state.models.set(row.key, row);
    });
  }

  // The per-provider fan-out. `state.syncing` is the renderer's own guard: main
  // has a per-provider door, but that stops two ingests of one provider, not
  // two discovery loops racing each other for the same provider.
  async function syncAll({ reason = 'timer', providerId = null } = {}) {
    if (!state.loaded) await load();
    if (state.syncing) return;
    const targets = Object.values(PROVIDERS).filter((p) => isConnected(p) && (!providerId || p.id === providerId));
    if (!targets.length) return;
    state.syncing = true;
    state.syncNote = `Syncing ${targets.length} provider${targets.length === 1 ? '' : 's'}…`;
    renderIfShown();
    const outcome = { added: [], removed: [], failed: [], moved: 0 };
    await Promise.all(targets.map(async (p) => {
      try {
        const r = await syncProvider(p);
        if (!r.ok) { outcome.failed.push(p.name); return; }
        outcome.added.push(...r.added);
        outcome.removed.push(...r.removed);
        outcome.moved += (r.moved.appeared || 0) + (r.moved.disappeared || 0);
      } catch (err) {
        outcome.failed.push(p.name);
      }
    }));
    state.syncing = false;
    state.lastSyncAt = Date.now();
    // The toast counts what MOVED, not the windows: `added` is a 7-day window
    // over every still-current model, so a toast built on it would say the same
    // thing on every tick.
    const bits = [];
    if (outcome.added.length) bits.push(`${outcome.added.length} new`);
    if (outcome.removed.length) bits.push(`${outcome.removed.length} removed`);
    if (outcome.failed.length) bits.push(`${outcome.failed.length} unreachable`);
    state.syncNote = bits.length ? bits.join(' · ') : 'Up to date';
    renderIfShown();
    return outcome;
  }

  function scheduleTimer() {
    clearInterval(state.timer);
    const minutes = Math.max(1, Number(settings.catalogSyncMinutes) || 5);
    state.timer = setInterval(() => syncAll({ reason: 'timer' }), minutes * 60 * 1000);
  }

  // ---- per-model actions: health, fetch information, chat -------------------

  // "The key has nothing left to spend", said many ways. A gateway can answer
  // 200 OK and still put one of these in the body, so the check reads the text
  // and the error field, not just the status line.
  const NO_CREDIT_RE = /no[ -]?credit|out of credit|insufficient|insufficient_quota|not enough (credit|balance|quota|funds)|balance|billing|payment required|free[_ -]?tier[_ -]?limit|quota (exceeded|exhausted|depleted)|exceeded (your |the )?(quota|limit|allowance)|spending limit|hard limit|recharge|top[ -]?up/i;
  const RATE_LIMIT_RE = /rate[ -]?limit|too many requests|throttl|\b429\b|requests per (minute|hour|day)|\brpm\b/i;
  const AUTH_RE = /unauthori[sz]ed|invalid api key|invalid key|forbidden|\b401\b|\b403\b|authentication|access denied/i;

  const HEALTH_META = {
    healthy: { label: 'Healthy', tone: 'ok', icon: 'pass' },
    'no-credits': { label: 'No credit', tone: 'fail', icon: 'fail' },
    'rate-limited': { label: 'Rate limited', tone: 'warn', icon: 'clock' },
    auth: { label: 'Key rejected', tone: 'fail', icon: 'fail' },
    unreachable: { label: 'Unreachable', tone: 'fail', icon: 'fail' },
    error: { label: 'Error', tone: 'fail', icon: 'fail' },
  };

  function classifyHealthText(text) {
    if (!text) return null;
    if (NO_CREDIT_RE.test(text)) return 'no-credits';
    if (RATE_LIMIT_RE.test(text)) return 'rate-limited';
    if (AUTH_RE.test(text)) return 'auth';
    return null;
  }

  // The provider and a usable key for a catalogue entry, or why there is none.
  function chatTarget(e) {
    const p = e && PROVIDERS[e.providerId];
    if (!p || !isConnected(p)) return { error: 'Provider is not connected' };
    const key = usableKeys(p)[0];
    if (!key) return { error: `No active key for ${p.name}` };
    return { p, key };
  }

  // A near-free probe. The output cap is small but not 1: a gateway that answers
  // 200 OK with the "no credit" reason written into the message text needs a few
  // tokens of room for that sentence to survive, or it would be cut to one word
  // and read as healthy. Twenty-four tokens is still a fraction of a cent.
  function healthRequestBody(e, p) {
    return {
      model: e.id,
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
      stream: false,
      [tokenLimitField(p.id)]: 24,
    };
  }

  // Reads one chat-completions response into a health verdict. A non-200 is
  // classified from its error; a 200 is only "healthy" once its body is shown
  // to be a real completion and not an error dressed up as one.
  function readHealth(res) {
    const at = Date.now();
    if (res.networkError || res.timedOut) {
      return { status: 'unreachable', note: res.error || 'No response', httpStatus: 0, at, timeMs: res.elapsed, tokens: null, tps: null };
    }
    let j = null;
    try { j = JSON.parse(res.body); } catch (_) { /* not JSON */ }
    const errMsg = j && j.error ? (j.error.message || j.error.code || j.error.type || String(j.error)) : '';
    let completionTokens = null;
    let tps = null;
    if (j && j.usage && Number.isFinite(j.usage.completion_tokens)) {
      completionTokens = j.usage.completion_tokens;
      if (res.elapsed && res.elapsed > 0 && completionTokens > 0) {
        tps = Math.round((completionTokens / (res.elapsed / 1000)) * 10) / 10;
      }
    }
    if (res.status !== 200) {
      const status = classifyHealthText(errMsg)
        || (res.status === 429 ? 'rate-limited' : res.status === 401 || res.status === 403 ? 'auth' : 'error');
      return { status, note: errMsg || `HTTP ${res.status}`, httpStatus: res.status, at, timeMs: res.elapsed, tokens: completionTokens, tps };
    }
    if (errMsg) {
      return { status: classifyHealthText(errMsg) || 'error', note: errMsg, httpStatus: 200, at, timeMs: res.elapsed, tokens: completionTokens, tps };
    }
    if (j && Array.isArray(j.choices) && j.choices.length) {
      let content = '';
      try { content = parseChatCompletion(res.body).content || ''; } catch (_) { /* unreadable */ }
      const cls = classifyHealthText(content);
      if (cls) return { status: cls, note: content.slice(0, 140), httpStatus: 200, at, timeMs: res.elapsed, tokens: completionTokens, tps };
      return { status: 'healthy', note: 'Responded normally', httpStatus: 200, at, timeMs: res.elapsed, tokens: completionTokens, tps };
    }
    return { status: 'error', note: '200 OK but an unreadable response', httpStatus: 200, at, timeMs: res.elapsed, tokens: completionTokens, tps };
  }

  async function healthCheck(key) {
    const e = state.models.get(key);
    if (!e) return;
    const t = chatTarget(e);
    if (t.error) { notify(t.error, 'fail'); return; }
    if (state.healthBusy.has(key)) return;
    state.healthBusy.add(key);
    renderRow(key);
    try {
      const res = await window.electronAPI.apiRequest({
        url: `${t.p.baseUrl}/chat/completions`,
        method: 'POST',
        headers: { Authorization: `Bearer ${t.key.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(healthRequestBody(e, t.p)),
        timeoutMs: 30000,
        requestId: `mc-health-${Date.now()}`,
      });
      const h = readHealth(res);
      // Main owns the verdict: it appends the latency sample and writes it
      // beside the row, and refuses a model that is not in the roster yet —
      // so a row the page invented is answered NOT_FOUND rather than stored.
      const reply = await window.electronAPI.catalogHealth(e.providerId, e.id, h);
      if (reply && reply.ok === false) {
        notify(`Health check refused: ${reply.message || reply.code}`, 'fail');
        return;
      }
      const prevChecks = ((e.health && e.health.checks) || []).slice();
      prevChecks.push({ at: h.at, status: h.status, note: h.note, ms: h.timeMs, tokens: h.tokens, tps: h.tps });
      const prevLatencies = ((e.health && e.health.latencies) || []).slice();
      if (Number.isFinite(h.timeMs)) prevLatencies.push({ at: h.at, ms: Math.round(h.timeMs) });
      e.health = {
        ...h,
        checks: prevChecks.slice(-30),
        latencies: prevLatencies.slice(-20),
      };
      const meta = HEALTH_META[h.status] || HEALTH_META.error;
      showHealthAct(key, meta);
      notify(`${e.name || e.id}: ${meta.label}${h.note && h.status !== 'healthy' ? ` — ${h.note}` : ''}`, meta.tone);
    } catch (err) {
      notify(`Health check failed: ${err.message || 'unknown error'}`, 'fail');
    } finally {
      state.healthBusy.delete(key);
      renderIfShown();
    }
  }

  // Fetch information: re-read this one model from the sources and say what
  // moved. The network pass behind it is TTL-gated in main, so a click seconds
  // after a sync re-merges from the cache in ~210 ms instead of paying five
  // megabytes — but the report is never gated.
  //
  // The verdict is one of four and each says a different thing:
  //   matched            the provider still publishes the same facts
  //   updated            which field moved, old -> new
  //   no-match           published, but the reference has never heard of it
  //   no-longer-listed   this roster does not name the model any more
  async function fetchInfo(key) {
    const e = state.models.get(key);
    const p = e && PROVIDERS[e.providerId];
    if (!e || !p || !isConnected(p)) return;
    if (state.fetching.has(key)) return;
    state.fetching.add(key);
    renderRow(key);
    try {
      // fetch-info takes the provider's raw adapter list, because the aliases
      // on it are provider facts main maps itself. If this session never
      // discovered the roster, discover it now rather than send an empty list
      // that would read as "the provider removed everything".
      let roster = state.roster.get(p.id);
      if (!roster) roster = await discoverAll(p);
      const reply = await window.electronAPI.catalogFetchInfo(p.id, e.id, roster || []);
      if (reply && reply.ok === false) {
        notify(`${e.name || e.id}: ${reply.message || reply.code}`, 'fail');
        return;
      }
      if (reply.after) applyRows(p.id, [reply.after]);
      else state.models.delete(key);
      const label = e.name || e.id;
      if (reply.outcome === 'no-longer-listed') {
        notify(`${label} is no longer listed by ${p.name}`, 'warn');
      } else if (reply.outcome === 'no-match') {
        notify(`${label}: published, but no entry in the sources knows this model`, 'warn');
      } else if (reply.outcome === 'updated') {
        const moved = (reply.changes || []).map((c) => `${c.field.replace(/_/g, ' ')} ${valueLabel(c.from)} → ${valueLabel(c.to)}`);
        const borrowed = (reply.borrowed || []).length
          ? ` · ${reply.borrowed.length} field${reply.borrowed.length === 1 ? '' : 's'} filled from the sources`
          : '';
        notify(`${label}: updated — ${moved.join('; ')}${borrowed}`, 'ok');
      } else {
        notify(`${label}: matched, no changes`, 'ok');
      }
    } catch (err) {
      notify(`Fetch information failed: ${err.message || 'unknown error'}`, 'fail');
    } finally {
      state.fetching.delete(key);
      renderIfShown();
    }
  }

  function valueLabel(v) {
    if (v === null || v === undefined || v === '') return '—';
    return String(v);
  }

  // The heart answers its own click: after the probe it wears the verdict
  // (tick, cross, or clock for a rate limit) in the badge's colour for a
  // moment, then returns to rest. The same hold-and-fade the providers'
  // Recheck button uses, so one gesture reads the same on both pages.
  const HEALTH_ACT_MS = 2600;
  function showHealthAct(key, meta) {
    const cur = state.healthAct.get(key);
    clearTimeout(cur?.timer);
    const timer = setTimeout(() => {
      state.healthAct.delete(key);
      renderRow(key);
    }, HEALTH_ACT_MS);
    state.healthAct.set(key, { tone: meta.tone, icon: meta.icon, label: meta.label, timer });
  }

  // Small status pill next to the model's name once it has been health-checked.
  function healthBadgeHTML(e) {
    const h = e.health;
    if (!h) return '';
    const meta = HEALTH_META[h.status] || HEALTH_META.error;
    const ago = h.at ? formatAgo(h.at) : '';
    const tip = `Health check${ago ? ` ${ago}` : ''}: ${h.note || meta.label}${h.httpStatus ? ` (HTTP ${h.httpStatus})` : ''}`;
    return `<span class="mc-health mc-health-${meta.tone}" title="${escapeHtml(tip)}">${ICON[meta.icon] || ''}${meta.label}</span>`;
  }

  // p50 over the kept latency ring, or null when nothing has been sampled yet.
  function latencyP50(e) {
    const samples = ((e.health && e.health.latencies) || []).map((s) => s.ms).filter((n) => Number.isFinite(n));
    if (!samples.length) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return { p50: sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2), n: samples.length };
  }

  // Speed resolution: the pinned TIME value from Route Test runs, as a median.
  // The table shows the median latency (same number as the TIME column); tok/s
  // stays in the tooltip when token counts were recorded. Only passed runs and
  // healthy checks count — a 502 that came back in 0.3s must never make a model
  // read as fast.
  function modelSpeed(e) {
    if (!e) return null;

    // 1. Check test runs recorded for this model in Route Test
    const runs = (historyRuns.get(e.key) || []).filter((r) => r.ok !== false);
    const validRunTps = runs.map((r) => r.tps).filter((v) => Number.isFinite(v) && v > 0);
    const validRunMs = runs.map((r) => r.ms).filter((v) => Number.isFinite(v) && v > 0);

    // 2. Check health checks (healthy ones only)
    const healthChecks = (e.health && Array.isArray(e.health.checks)) ? e.health.checks.filter((c) => c.status === 'healthy') : [];
    const validHealthTps = healthChecks.map((c) => c.tps).filter((v) => Number.isFinite(v) && v > 0);
    const validHealthMs = healthChecks.map((c) => c.ms).filter((v) => Number.isFinite(v) && v > 0);

    const allTps = [...validRunTps, ...validHealthTps];
    const allMs = [...validRunMs, ...validHealthMs];

    if (!allMs.length && !allTps.length) return null;

    let medMs = null;
    if (allMs.length > 0) {
      const sortedMs = allMs.slice().sort((a, b) => a - b);
      const midMs = Math.floor(sortedMs.length / 2);
      medMs = sortedMs.length % 2 ? sortedMs[midMs] : Math.round((sortedMs[midMs - 1] + sortedMs[midMs]) / 2);
    }
    let medTps = null;
    if (allTps.length > 0) {
      const sorted = allTps.slice().sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      medTps = sorted.length % 2 ? sorted[mid] : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10;
    }
    return { tps: medTps, ms: medMs, samples: allMs.length || allTps.length };
  }

  function speedCell(e, { compact = false } = {}) {
    const s = modelSpeed(e);
    if (!s) return '<span class="dt-muted">—</span>';
    // The cell pins the TIME-column median: the number a test run would show for
    // this model, in the same colours. tok/s is extra info for the tooltip.
    if (s.ms != null) {
      const tip = `Median test time: ${fmtMs(s.ms)} (${s.samples} sample${s.samples === 1 ? '' : 's'}${s.tps != null ? `, ${s.tps} tok/s` : ''})`;
      if (compact) {
        return `<span class="${timeClass(s.ms)}" title="${escapeHtml(tip)}">${fmtMs(s.ms)}</span>`;
      }
      return `<span class="${timeClass(s.ms)}" title="${escapeHtml(tip)}"><span class="mc-speed-val">${fmtMs(s.ms)}</span></span>`;
    }
    if (s.tps != null) {
      const cls = s.tps >= 60 ? 'time-fast' : s.tps >= 25 ? 'time-mid' : 'time-slow';
      const tip = `Generation speed: ${s.tps} tokens/sec (${s.samples} sample${s.samples === 1 ? '' : 's'})`;
      if (compact) {
        return `<span class="${cls}" title="${escapeHtml(tip)}">${s.tps} tok/s</span>`;
      }
      return `<span class="${cls}" title="${escapeHtml(tip)}"><span class="mc-speed-val">${s.tps}</span><span class="mc-speed-unit">tok/s</span></span>`;
    }
    return '<span class="dt-muted">—</span>';
  }

  function latencyCell(e) {
    return speedCell(e);
  }

  function healthBarHTML(e) {
    const TOTAL_TICKS = 24;
    const checks = [];

    // 1. Health checks ring or status
    if (e.health && Array.isArray(e.health.checks)) {
      checks.push(...e.health.checks);
    } else if (e.health && Array.isArray(e.health.latencies) && e.health.latencies.length) {
      e.health.latencies.forEach((l) => {
        checks.push({
          at: l.at,
          status: l.status || e.health.status || 'healthy',
          note: e.health.note,
          ms: l.ms,
        });
      });
    } else if (e.health && e.health.status) {
      checks.push({
        at: e.health.at,
        status: e.health.status,
        note: e.health.note,
        ms: latencyP50(e) ? latencyP50(e).p50 : null,
      });
    }

    // 2. Test runs from history
    const runs = historyRuns.get(e.key) || [];
    runs.forEach((r) => { checks.push(r); });

    // Deduplicate and sort oldest first (PAST -> NOW)
    const unique = [];
    const seen = new Set();
    checks.sort((a, b) => (a.at || 0) - (b.at || 0));
    for (const c of checks) {
      const stamp = `${c.at || 0}_${c.status}`;
      if (!seen.has(stamp)) {
        seen.add(stamp);
        unique.push(c);
      }
    }

    const recent = unique.slice(-TOTAL_TICKS);
    const emptyCount = TOTAL_TICKS - recent.length;

    const ticks = [];
    for (let i = 0; i < emptyCount; i++) {
      ticks.push('<span class="mc-health-tick empty" title="No check recorded"></span>');
    }

    let passCount = 0;
    for (const c of recent) {
      const isPass = c.status === 'healthy' || c.status === 'pass' || c.ok === true;
      const isWarn = c.status === 'warn';
      const stateCls = isPass ? 'pass' : isWarn ? 'warn' : 'fail';
      if (isPass) passCount++;

      const ago = c.at ? formatAgo(c.at) : '';
      const meta = HEALTH_META[c.status] || { label: c.status || (isPass ? 'Healthy' : 'Error') };
      const msText = c.ms ? fmtMs(c.ms) : '';
      const tpsText = c.tps ? `${c.tps} tok/s` : '';
      const perf = [msText, tpsText].filter(Boolean).join(' · ');
      const title = `${ago ? `${ago}: ` : ''}${meta.label || 'Check'}${c.note ? ` — ${c.note}` : ''}${perf ? ` (${perf})` : ''}`;

      ticks.push(`<span class="mc-health-tick ${stateCls}" title="${escapeHtml(title)}"></span>`);
    }

    const overallTitle = recent.length
      ? `${passCount}/${recent.length} checks healthy${recent.length ? ` · latest: ${(HEALTH_META[recent[recent.length - 1].status] || {}).label || 'Recorded'}` : ''}`
      : 'No checks recorded yet — click the heart icon in Actions to check health';

    return `<div class="mc-health-bar-wrap" role="img" aria-label="${escapeHtml(overallTitle)}" title="${escapeHtml(overallTitle)}">
      <div class="mc-health-ticks">${ticks.join('')}</div>
      <div class="mc-health-labels">
        <span class="mc-health-label">PAST</span>
        <span class="mc-health-label">NOW</span>
      </div>
    </div>`;
  }

  function healthCell(e) {
    return healthBarHTML(e);
  }

  // ---- toast notifications ---------------------------------------------------

  function notify(message, tone = 'info') {
    const root = document.getElementById('mc-toasts');
    if (!root) return;
    const icon = tone === 'ok' ? ICON.pass : tone === 'warn' ? ICON.clock : tone === 'fail' ? ICON.fail : ICON.box;
    const el = document.createElement('div');
    el.className = `mc-toast mc-toast-${tone}`;
    el.setAttribute('role', 'status');
    el.innerHTML = `<span class="mc-toast-ico">${icon}</span><span class="mc-toast-msg">${escapeHtml(message)}</span>`;
    root.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 240);
    }, 4200);
  }

  // ---- chat drawer -------------------------------------------------------------

  function chatEntry() { return chat.key ? state.models.get(chat.key) : null; }

  // Only chat models get the drawer: the endpoint is a chat completion, so an
  // image or decision model would answer nothing but an error.
  function chatable(e) { return !e.kind || e.kind === 'chat'; }

  function openChat(key, opener) {
    const e = state.models.get(key);
    if (!e || !chatable(e)) return;
    chat.key = key;
    chat.messages = [];
    chat.busy = false;
    chat.opener = opener || document.activeElement;
    const el = document.getElementById('mc-chat-drawer');
    if (!el) return;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('open'));
    renderChatHead();
    renderChatBody();
    const input = document.getElementById('mc-chat-input');
    if (input) { input.value = ''; autoGrowChatInput(); input.focus(); }
    updateChatSend();
    const t = chatTarget(e);
    if (t.error) notify(t.error, 'fail');
  }

  function closeChat() {
    const el = document.getElementById('mc-chat-drawer');
    if (!el || el.hidden) return;
    el.classList.remove('open');
    const opener = chat.opener;
    chat.key = null;
    chat.messages = [];
    chat.busy = false;
    chat.opener = null;
    const done = () => { el.hidden = true; };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) done();
    else setTimeout(done, 220);
    if (opener && document.contains(opener)) opener.focus();
  }

  function renderChatHead() {
    const e = chatEntry();
    if (!e) return;
    const p = PROVIDERS[e.providerId];
    const logo = document.getElementById('mc-chat-logo');
    if (logo) logo.innerHTML = p ? providerMark(p) : '';
    const title = document.getElementById('mc-chat-title');
    if (title) title.textContent = e.name || e.id;
    const sub = document.getElementById('mc-chat-sub');
    if (sub) sub.textContent = `${e.providerId}/${e.id}`;
  }

  function chatMsgHTML(m) {
    if (m.role === 'user') {
      return `<div class="mc-chat-msg user"><div class="mc-chat-bubble">${escapeHtml(m.content)}</div></div>`;
    }
    return `<div class="mc-chat-msg assistant${m.error ? ' is-error' : ''}"><span class="mc-chat-avatar">${ICON.box}</span><div class="mc-chat-bubble">${escapeHtml(m.content)}</div></div>`;
  }

  function renderChatBody() {
    const body = document.getElementById('mc-chat-body');
    if (!body) return;
    const e = chatEntry();
    if (!e) { body.innerHTML = ''; return; }
    if (!chat.messages.length) {
      body.innerHTML = `<div class="mc-chat-empty">
        <div class="mc-chat-empty-ico">${ICON.chat}</div>
        <h4>Talk to this model directly</h4>
        <p>Every turn is one real request on your own key, straight to <code>${escapeHtml(e.id)}</code> — no profile, no routing, no capability gate. Nothing here is recorded as routing evidence.</p>
      </div>`;
      return;
    }
    body.innerHTML = chat.messages.map(chatMsgHTML).join('')
      + (chat.busy ? `<div class="mc-chat-msg assistant"><span class="mc-chat-avatar">${ICON.box}</span><div class="mc-chat-bubble mc-chat-thinking"><span class="spinner"></span>Thinking…</div></div>` : '');
    body.scrollTop = body.scrollHeight;
  }

  function autoGrowChatInput() {
    const input = document.getElementById('mc-chat-input');
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }

  function updateChatSend() {
    const send = document.getElementById('mc-chat-send');
    const input = document.getElementById('mc-chat-input');
    if (send) send.disabled = chat.busy || !(input && input.value.trim());
  }

  // The assistant's text out of one response, with transport and provider
  // errors (including a 200 that is really an error) turned into a readable line.
  function extractChatReply(res) {
    if (res.networkError || res.timedOut) return { text: res.error || 'No response', error: true };
    let j = null;
    try { j = JSON.parse(res.body); } catch (_) { /* not JSON */ }
    const errMsg = j && j.error ? (j.error.message || j.error.code || String(j.error)) : '';
    if (res.status !== 200) return { text: errMsg || `HTTP ${res.status}`, error: true };
    if (errMsg) return { text: errMsg, error: true };
    let content = '';
    try { content = parseChatCompletion(res.body).content || ''; } catch (_) { /* unreadable */ }
    if (!content.trim()) return { text: 'No content returned by provider', error: true };
    return { text: content, error: false };
  }

  async function sendChat() {
    const e = chatEntry();
    const input = document.getElementById('mc-chat-input');
    if (!e || !input) return;
    const text = input.value.trim();
    if (!text || chat.busy) return;
    const t = chatTarget(e);
    if (t.error) { notify(t.error, 'fail'); return; }
    chat.messages.push({ role: 'user', content: text });
    input.value = '';
    autoGrowChatInput();
    chat.busy = true;
    updateChatSend();
    renderChatBody();
    try {
      const res = await window.electronAPI.apiRequest({
        url: `${t.p.baseUrl}/chat/completions`,
        method: 'POST',
        headers: { Authorization: `Bearer ${t.key.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: e.id,
          messages: chat.messages.map((m) => ({ role: m.role, content: m.content })),
          stream: false,
          [tokenLimitField(t.p.id)]: 2048,
        }),
        timeoutMs: Number(settings.deadlineChatMs) || 60000,
        requestId: `mc-chat-${Date.now()}`,
      });
      const reply = extractChatReply(res);
      chat.messages.push({ role: 'assistant', content: reply.text, error: reply.error });
    } catch (err) {
      chat.messages.push({ role: 'assistant', content: err.message || 'Request failed', error: true });
    } finally {
      chat.busy = false;
      updateChatSend();
      renderChatBody();
      const inp = document.getElementById('mc-chat-input');
      if (inp) inp.focus();
    }
  }

  function bindChatDrawer() {
    const el = document.getElementById('mc-chat-drawer');
    if (!el) return;
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-chat-close]')) { closeChat(); return; }
      if (ev.target.closest('#mc-chat-send')) { sendChat(); }
    });
    const input = document.getElementById('mc-chat-input');
    if (input) {
      input.addEventListener('input', () => { autoGrowChatInput(); updateChatSend(); });
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          sendChat();
        }
      });
    }
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !el.hidden) closeChat();
    });
  }

  // ---- model details drawer (mobile-sidebar style) -------------------------

  function openDetails(key, opener) {
    const e = state.models.get(key);
    if (!e) return;
    details.key = key;
    details.opener = opener || document.activeElement;
    const el = document.getElementById('mc-details-drawer');
    if (!el) return;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('open'));
    renderDetailsHead();
    renderDetailsBody();
    renderDetailsFoot();
    $$('.mc-row.is-selected, .mc-card.is-selected').forEach((r) => r.classList.remove('is-selected'));
    const row = document.querySelector(`.mc-row[data-mc-key="${CSS.escape(key)}"], .mc-card[data-mc-key="${CSS.escape(key)}"]`);
    if (row) row.classList.add('is-selected');
  }

  function closeDetails() {
    const el = document.getElementById('mc-details-drawer');
    if (!el || el.hidden) return;
    el.classList.remove('open');
    const opener = details.opener;
    details.key = null;
    details.opener = null;
    $$('.mc-row.is-selected, .mc-card.is-selected').forEach((r) => r.classList.remove('is-selected'));
    const done = () => { el.hidden = true; };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) done();
    else setTimeout(done, 220);
    if (opener && document.contains(opener)) opener.focus();
  }

  function renderDetailsHead() {
    const e = state.models.get(details.key);
    if (!e) return;
    const p = PROVIDERS[e.providerId];
    const logo = document.getElementById('mc-details-logo');
    if (logo) logo.innerHTML = p ? providerMark(p) : '';
    const title = document.getElementById('mc-details-title');
    if (title) title.textContent = e.name || e.id;
    const sub = document.getElementById('mc-details-sub');
    if (sub) sub.textContent = `${(p && p.name) || e.providerId} · ${e.id}${e.family ? ` · ${e.family}` : ''}`;
    const badgesEl = document.getElementById('mc-details-badges');
    if (badgesEl) badgesEl.innerHTML = badges(e) + healthBadgeHTML(e);
  }

  function renderDetailsBody() {
    const body = document.getElementById('mc-details-body');
    if (!body) return;
    const e = state.models.get(details.key);
    if (!e) { body.innerHTML = ''; return; }
    body.innerHTML = detailHTML(e);
  }

  function renderDetailsFoot() {
    const foot = document.getElementById('mc-details-foot');
    if (!foot) return;
    const e = state.models.get(details.key);
    if (!e) { foot.innerHTML = ''; return; }
    const key = escapeHtml(e.key);
    const canChat = chatable(e);
    foot.innerHTML = `
      ${canChat ? `<button class="btn btn-primary" type="button" data-mc-chat="${key}">
        ${ICON.chat} <span>Chat with model</span>
      </button>` : ''}
      <button class="btn btn-ghost" type="button" data-mc-health="${key}">
        ${ICON.heart} <span>Health Check</span>
      </button>
      <button class="btn btn-ghost" type="button" data-mc-fetch-info="${key}">
        ${ICON.redo} <span>Refresh facts</span>
      </button>
    `;
  }

  function bindDetailsDrawer() {
    const el = document.getElementById('mc-details-drawer');
    if (!el) return;
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-details-close]')) { closeDetails(); return; }
      const chatBtn = ev.target.closest('[data-mc-chat]');
      if (chatBtn) { openChat(chatBtn.dataset.mcChat, chatBtn); return; }
      const health = ev.target.closest('[data-mc-health]');
      if (health) { healthCheck(health.dataset.mcHealth); return; }
      const fetchInfoBtn = ev.target.closest('[data-mc-fetch-info]');
      if (fetchInfoBtn) { fetchInfo(fetchInfoBtn.dataset.mcFetchInfo); return; }
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !el.hidden) closeDetails();
    });
  }

  // ---- rendering -----------------------------------------------------------

  const ICON = {
    stop: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
    redo: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
    chevron: '<svg class="kx-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
    sync: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
    box: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
    plug: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v4"/></svg>',
    trophy: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 6h3v2a3 3 0 0 1-3 3M7 6H4v2a3 3 0 0 0 3 3"/></svg>',
    clock: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    eye: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    brain: '<span class="emoji-cap" aria-hidden="true">🧠</span>',
    pass: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    fail: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    empty: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/></svg>',
    chat: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    heart: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/><path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27"/></svg>',
    send: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
    close: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    search: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>',
    server: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/></svg>',
    funnel: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>',
  };

  // The eight capability icons, one per CAT_CAPABILITIES entry, so a tile in the
  // legend and a cell in the table are the same mark and the legend is a key for
  // the table rather than decoration next to it. `vision` and `reasoning` are
  // the symbols the model row already wore beside its name — kept verbatim, so a
  // meaning the owner learned on one surface is not re-taught on another.
  //
  // The intrinsic width is 12 in all eight and the size is set in CSS, so mixing
  // these with the rest of ICON cannot make one line of icons sit unevenly.
  const CAP_ICON = {
    tools: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
    reasoning: ICON.brain,
    structured: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/></svg>',
    vision: ICON.eye,
    imageGen: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/></svg>',
    audio: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/></svg>',
    video: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 13 5.22 3.48a.5.5 0 0 0 .78-.42V7.9a.5.5 0 0 0-.75-.43L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>',
    files: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13.23 20.25 21 12.3"/><path d="m16 6-8.41 8.59a2 2 0 0 0 0 2.82 2 2 0 0 0 2.83 0l8.41-8.59a4 4 0 0 0 0-5.65 4 4 0 0 0-5.65 0l-8.42 8.59a6 6 0 1 0 8.49 8.48"/></svg>',
    decision: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M5 7h14"/><path d="M5 7l-3 7a3 3 0 006 0z"/><path d="M19 7l-3 7a3 3 0 006 0z"/></svg>',
  };

  // The row field each capability is read from, so a value the reference filled
  // in is marked as borrowed wherever it is drawn — the same reason
  // `contextCell` and `priceCell` wrap theirs.
  const CAP_FIELD = {
    tools: 'tools',
    reasoning: 'reasoning',
    structured: 'structured',
    vision: 'input_modalities',
    imageGen: 'output_modalities',
    audio: 'input_modalities',
    video: 'output_modalities',
    files: 'attachment',
    decision: 'kind',
  };

  // Where each answer was read, in the owner's words rather than the code's.
  const CAP_ORIGIN = {
    published: 'published by the provider',
    modalities: 'from the modalities it published',
    kind: 'declared by the provider',
    silent: 'nobody published this',
  };

  const TOOLBAR = {
    placeholder: 'Search models, providers or ids…',
    filters: [
      { value: 'all', label: 'All' },
      { value: 'new', label: 'New', dot: 'var(--accent)' },
      { value: 'measured', label: 'Measured', dot: 'var(--pass)' },
      { value: 'estimated', label: 'Estimated', dot: '#a78bfa' },
      { value: 'unrated', label: 'Unrated', dot: 'var(--text-4)' },
    ],
    sorts: [
      { value: 'rank', label: 'Rank' },
      { value: 'context', label: 'Context' },
      { value: 'price', label: 'Price' },
      { value: 'speed', label: 'Speed' },
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
    if (ms == null) return 'dt-muted';
    if (ms < 2000) return 'time-fast';
    if (ms < 6000) return 'time-mid';
    return 'time-slow';
  }

  function fmtContext(n) {
    if (!Number.isFinite(n)) return '';
    if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`.replace(/\.0M$/, 'M');
    if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
    return String(n);
  }

  // Where the score came from, in words. Three answers and a fourth refusal:
  // measured (Artificial Analysis, passed through untouched), estimated (a
  // fit recomputed from the reference, weighted by its own R²), a proxy (a
  // base route borrowed for a variant), and Unrated when nothing matched.
  // Never a fourth value and never a guess.
  function scoreTip(e) {
    if (e.score == null) {
      return 'Unrated — no entry in the sources describes this model, so no score is given.';
    }
    if (e.score_source === 'aa') return 'measured — Artificial Analysis index, used as published';
    if (e.score_source === 'proxy') {
      const of = (e.quality_proxy_ids && e.quality_proxy_ids[0]) || e.matched_id || 'a base route';
      return `proxy of ${of} — this route was measured, that one was not`;
    }
    const basis = (e.score_basis || []).filter((b) => b !== 'proxy');
    return basis.length
      ? `estimated from ${basis.join(', ')} — a fit recomputed from the sources, not measured`
      : 'estimated from the sources';
  }

  function scoreCell(e) {
    if (e.score == null) return '<div class="mc-quality-cell"><span class="mc-quality-val dt-muted">—</span></div>';
    return `<div class="mc-quality-cell"><span class="mc-quality-val">${escapeHtml(String(e.score))}</span></div>`;
  }

  function scoreBar(score, cls = '') {
    if (score == null) return '<span class="dt-muted">—</span>';
    return `<div class="dt-rate ${cls}"><div class="dt-rate-bar"><span class="${scoreClass(score / 100)}" style="width:${Math.max(0, Math.min(100, score))}%"></span></div><b>${score}</b></div>`;
  }

  // A field the reference filled and the provider never published. Marked, with
  // a tooltip that says so — an unmarked borrow would read as the provider's
  // own claim, which is exactly what it is not.
  function borrowed(e, field, value) {
    const filled = e.filled_from_catalog || [];
    if (!filled.includes(field)) return value;
    return `<span class="mc-borrowed" title="${escapeHtml(`Not published by ${(PROVIDERS[e.providerId] || {}).name || e.providerId} — filled from the sources`)}">${value}</span>`;
  }

  function numCell(v) {
    return v == null ? '<span class="dt-muted" title="Nobody published this">—</span>' : escapeHtml(String(v));
  }

  function contextCell(e) {
    if (e.context_tokens == null) return '<span class="dt-muted">—</span>';
    return borrowed(e, 'context_tokens', `<span class="mc-ctx-val">${escapeHtml(fmtContext(e.context_tokens))}</span>`);
  }

  function outputCell(e) {
    if (e.output_tokens == null) return '<span class="dt-muted">—</span>';
    return borrowed(e, 'output_tokens', escapeHtml(fmtContext(e.output_tokens)));
  }

  function formatPriceNum(v) {
    if (v == null) return '—';
    if (v === 0) return '$0';
    if (v >= 10) return `$${v.toFixed(0)}`;
    if (v >= 1) {
      const s = v.toFixed(2);
      return `$${s.endsWith('.00') ? v.toFixed(0) : s}`;
    }
    if (v < 0.01) {
      return `$${v.toFixed(3).replace(/\.?0+$/, '')}`;
    }
    return `$${v.toFixed(2)}`;
  }

  function priceCell(e, { compact = false } = {}) {
    if (e.cost_in_per_m == null && e.cost_out_per_m == null) {
      return compact
        ? '<span class="dt-muted">—</span>'
        : '<div class="mc-pricing-cell"><span class="dt-muted" title="Nobody published a price for this model">—</span></div>';
    }
    const isFree = e.cost_kind === 'free' || (e.cost_in_per_m === 0 && e.cost_out_per_m === 0);
    if (compact) {
      if (isFree) return '<span class="mc-price-free"><span class="mc-cost-dot" style="--dot:var(--type-free)"></span>free</span>';
      const text = `${formatPriceNum(e.cost_in_per_m ?? 0)} / ${formatPriceNum(e.cost_out_per_m ?? 0)}`;
      return borrowed(e, 'cost_in_per_m', `<span class="mc-price-paid"><span class="mc-cost-dot" style="--dot:var(--type-apikey)"></span>${escapeHtml(text)}</span>`);
    }

    const inVal = isFree ? '$0' : formatPriceNum(e.cost_in_per_m ?? 0);
    const outVal = isFree ? '$0' : formatPriceNum(e.cost_out_per_m ?? 0);
    const planBadge = isFree ? 'Free plan' : 'Included plan';

    const box = `<div class="mc-pricing-cell">
      <div class="mc-pricing-box">
        <div class="mc-pricing-col">
          <span class="mc-pricing-lbl">IN</span>
          <span class="mc-pricing-val in-val">${escapeHtml(inVal)}</span>
        </div>
        <div class="mc-pricing-sep"></div>
        <div class="mc-pricing-col">
          <span class="mc-pricing-lbl">OUT</span>
          <span class="mc-pricing-val out-val">${escapeHtml(outVal)}</span>
        </div>
      </div>
      <div class="mc-pricing-plan-badge">${planBadge}</div>
    </div>`;

    return borrowed(e, 'cost_in_per_m', box);
  }

  // Eight capabilities, as icons. Three states, and the middle one is the whole
  // reason this is a separate function: `catalog-caps.js` answers true / false /
  // null, and null means nobody said. A published-yes is lit, a nobody-said is
  // dim, and a published-NO IS NOT DRAWN — a red cross on every row for every
  // capability a provider does not mention would say "does not" where the truth
  // is "has never been heard of". The row's detail panel still spells every one
  // of them out in words, so nothing is lost by not drawing it.
  function capsHTML(e) {
    // All 8 capabilities are drawn on every row: lit (is-yes) when supported,
    // and dimmed (is-unknown) when not supported or unknown, keeping icons
    // perfectly aligned in fixed positions across all rows.
    const cells = CAT_CAPABILITIES.map((cap) => {
      const value = capabilityState(e, cap.id);
      const isYes = value === true;
      const label = `${cap.label}: ${isYes ? 'yes' : 'no'}`;
      const tip = `${label} — ${cap.blurb.toLowerCase()}`;
      return `<span class="mc-cap-ico mc-cap-${cap.tone} ${isYes ? 'is-yes' : 'is-unknown'}"
        title="${escapeHtml(tip)}" aria-label="${escapeHtml(label)}">${CAP_ICON[cap.id]}</span>`;
    }).join('');
    return `<span class="mc-caps">${cells}</span>`;
  }

  // ---- the legend ---------------------------------------------------------

  // The legend is a key for the icons in the Caps column, so it draws the same
  // eight marks in the same order with the same colours, and adds the two things
  // the column cannot say: what each icon means, and how many of the rows on
  // screen carry it.
  //
  // The counts describe what is on screen, not the whole catalogue — so they are
  // taken from the filtered list, and the footer says so, or a search narrowed to
  // three models would read as "these three have tools" beside a number for a
  // thousand.
  function legendHTML(rows) {
    if (!rows.length) return '';
    const counts = capabilityCounts(rows);
    const total = rows.length;
    const chevron = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>';
    const topCaps = [...CAT_CAPABILITIES]
      .sort((a, b) => ((counts[b.id] || 0) - (counts[a.id] || 0)) || (CAT_CAPABILITIES.indexOf(a) - CAT_CAPABILITIES.indexOf(b)))
      .slice(0, 4);
    const topIcons = `<span class="mc-legend-top-caps">${topCaps.map((cap) => {
      const n = counts[cap.id] || 0;
      return `<span class="mc-cap-ico mc-cap-${cap.tone} is-yes" title="${escapeHtml(cap.label)} (${n} model${n === 1 ? '' : 's'})">${CAP_ICON[cap.id]}</span>`;
    }).join('')}</span>`;
    const toggle = `<button class="pv-legend-toggle mc-legend-toggle" type="button" data-mc-legend-toggle
      aria-expanded="${state.legendOpen}" aria-controls="mc-legend-body"
      title="${state.legendOpen ? 'Hide the legend' : 'Show the legend'}">
      <span>${state.legendOpen ? 'Hide legend' : 'Show legend'}</span>${chevron}</button>`;
    const body = `<div class="pv-legend-body mc-legend-body mc-legend-grid" id="mc-legend-body"${state.legendOpen ? '' : ' hidden'}>
      ${CAT_CAPABILITIES.map((cap) => {
        const n = counts[cap.id] || 0;
        return `<div class="pv-legend-item mc-legend-tile mc-cap-${cap.tone} ${n ? '' : 'empty'}" style="--c:var(--cap)">
          <span class="pv-legend-chip mc-legend-ico mc-cap-${cap.tone}">${CAP_ICON[cap.id]}</span>
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
    return `<section class="pv-legend mc-legend ${state.legendOpen ? '' : 'collapsed'}" aria-label="Model capabilities legend">
      <div class="pv-legend-head mc-legend-head">
        <span class="pv-legend-title">${topIcons}Model Capabilities Legend</span>
        ${toggle}
      </div>
      ${body}
    </section>`;
  }

  function healthCell(e) {
    if (!e.health) return '<span class="dt-muted">—</span>';
    const meta = HEALTH_META[e.health.status] || HEALTH_META.error;
    return `<span class="mc-health-dot mc-health-dot-${meta.tone}" title="${escapeHtml(e.health.note || meta.label)}">${ICON[meta.icon] || ''}</span>`;
  }

  function badges(e) {
    const out = [];
    if (e.isNew) out.push(`<span class="pv-tag mc-new" title="${escapeHtml(e.first_seen ? `First seen ${formatAgo(e.first_seen)}` : 'Newly listed')}">NEW</span>`);
    if (e.kind && e.kind !== 'chat') out.push(`<span class="pv-tag t-violet">${escapeHtml(e.kind)}</span>`);
    if (e.cost_kind === 'free') out.push('<span class="pv-tag t-green">free</span>');
    return out.join('');
  }

  // ---- the three actions ---------------------------------------------------

  // Order is health · fetch information · chat, the order they were asked in.
  // All three keep their own title and their own spinner; a non-chat model
  // keeps only Fetch information, because a health probe and a chat are both
  // chat completions and would only answer with an error.
  function actionButtons(e) {
    const key = escapeHtml(e.key);
    const label = escapeHtml(e.name || e.id);
    const healthBusy = state.healthBusy.has(e.key);
    // A finished check wears its verdict on the heart for a moment; while it
    // does, the button reads as the answer, not as the question.
    const act = state.healthAct.get(e.key);
    const healthRest = 'Health check — one minimal request, smart about 200-OK replies that actually say there\'s no credit';
    const healthTitle = act ? `${act.label} — ${healthRest}` : healthRest;
    const healthInner = healthBusy ? '<span class="spinner act-spinner" aria-hidden="true"></span>'
      : act ? `<span class="act-result" aria-hidden="true">${ICON[act.icon] || ICON.fail}</span>`
      : ICON.heart;
    const healthBtn = `<button class="dt-icon-btn" type="button" data-mc-health="${key}" title="${escapeHtml(healthTitle)}" aria-label="${act ? `${escapeHtml(act.label)} — health check ${label}` : `Health check ${label}`}"${act ? ` data-act="${act.tone}"` : ''} ${healthBusy ? 'disabled' : ''}>${healthInner}</button>`;

    const fetching = state.fetching.has(e.key);
    const fetchBtn = `<button class="dt-icon-btn" type="button" data-mc-fetch-info="${key}" title="Fetch this model's facts from the sources and tell me what changed" aria-label="Fetch information for ${label}" ${fetching ? 'disabled' : ''}>${fetching ? '<span class="spinner act-spinner" aria-hidden="true"></span>' : ICON.redo}</button>`;

    const chatBtn = `<button class="dt-icon-btn" type="button" data-mc-chat="${key}" title="Chat with this model" aria-label="Chat with ${label}">${ICON.chat}</button>`;
    return chatable(e) ? `${healthBtn}${fetchBtn}${chatBtn}` : fetchBtn;
  }

  function rowHTML(e, rank) {
    const p = PROVIDERS[e.providerId];
    const key = escapeHtml(e.key);
    const rankCell = rank ? `<span class="mc-rank ${rank <= 3 ? 'top' : ''}">#${rank}</span>` : '<span class="dt-muted">—</span>';
    const costLabel = e.cost_kind === 'free' ? ' · free' : '';
    const isSelected = details.key === e.key;
    return `<tr class="dt-row mc-row ${isSelected ? 'is-selected' : ''}" data-mc-key="${key}" data-mc-details="${key}" tabindex="0">
      <td class="dt-num col-rank">${rankCell}</td>
      <td><div class="dt-provider">
        <span class="pv-logo">${providerMark(p)}</span>
        <div><div class="dt-provider-name mc-name">${escapeHtml(e.name || e.id)}${badges(e)}${healthBadgeHTML(e)}</div>
        <div class="dt-provider-host mc-sub">${healthDotHTML(p)}${escapeHtml(p.name)}${e.name && e.name !== e.id ? ` · <code>${escapeHtml(e.id)}</code>` : ''}${e.family ? ` · ${escapeHtml(e.family)}` : ''}${costLabel}</div></div>
      </div></td>
      <td class="col-score" title="${escapeHtml(scoreTip(e))}">${scoreCell(e)}</td>
      <td class="col-ctx">${contextCell(e)}</td>
      <td class="col-price">${priceCell(e)}</td>
      <td class="col-caps">${capsHTML(e)}</td>
      <td class="dt-num col-speed">${speedCell(e)}</td>
      <td class="col-health">${healthCell(e)}</td>
      <td class="dt-actions-col"><div class="dt-row-actions">${actionButtons(e)}</div></td>
    </tr>`;
  }

  function cardHTML(e, rank) {
    const p = PROVIDERS[e.providerId];
    const key = escapeHtml(e.key);
    const isSelected = details.key === e.key;
    return `<article class="pv-card mc-card ${isSelected ? 'is-selected' : ''}" data-mc-key="${key}" style="--type-stripe:${escapeHtml(p.color || 'var(--accent)')}">
      <div class="pv-card-top">
        <span class="pv-logo">${providerMark(p)}</span>
        <span class="pv-host">${healthDotHTML(p)}${escapeHtml(p.name)}${e.context_tokens ? ` · ${escapeHtml(fmtContext(e.context_tokens))}` : ''}</span>
      </div>
      <h3 class="pv-name"><span>${escapeHtml(e.name || e.id)}</span></h3>
      <div class="mc-card-badges">${badges(e)}${healthBadgeHTML(e)}${rank ? `<span class="mc-rank ${rank <= 3 ? 'top' : ''}">#${rank}</span>` : ''}</div>
      <div class="pv-stats">
        <div class="pv-stat" title="${escapeHtml(scoreTip(e))}"><span class="pv-stat-label">Score</span><span class="pv-stat-value">${e.score == null ? '—' : e.score}</span></div>
        <div class="pv-stat"><span class="pv-stat-label">Context</span><span class="pv-stat-value">${e.context_tokens == null ? '—' : escapeHtml(fmtContext(e.context_tokens))}</span></div>
        <div class="pv-stat"><span class="pv-stat-label">Speed</span><span class="pv-stat-value">${speedCell(e, { compact: true })}</span></div>
        <div class="pv-stat"><span class="pv-stat-label">Price</span><span class="pv-stat-value">${priceCell(e, { compact: true })}</span></div>
      </div>
      <div class="mc-card-health">${healthBarHTML(e)}</div>
      <div class="mc-card-caps">${capsHTML(e)}</div>
      <div class="pv-card-actions">
        <button class="btn btn-ghost btn-mini" type="button" data-mc-details="${key}">Details</button>
        ${actionButtons(e)}
      </div>
    </article>`;
  }

  function detailHTML(e) {
    const p = PROVIDERS[e.providerId];
    const borrowedFields = e.filled_from_catalog || [];
    const row = (label, value) => `<div class="mc-compare-row"><span>${escapeHtml(label)}</span><span>${value}</span><span></span></div>`;
    const provRow = (label, field, fmt = valueLabel) => row(label, borrowedFields.includes(field)
      ? `<span class="mc-borrowed" title="Filled from the sources — not published by this provider">${escapeHtml(fmt(e[field]))}</span>`
      : `<span class="mc-note">${escapeHtml(fmt(e[field]))}</span>`);
    // Every capability in words, including the ones the column does not draw. A
    // published "no" is invisible in the Caps column by design, so this panel is
    // the only place it is said — and it says where each answer came from, so a
    // token found in a modality list never reads as a published flag.
    const capRow = (cap) => {
      const { value, from } = capabilityOrigin(e, cap.id);
      const word = value === null ? 'not published' : value ? 'yes' : 'no';
      const mark = `<span class="mc-cap-mark is-${value === null ? 'unknown' : value ? 'yes' : 'no'}">${CAP_ICON[cap.id]}</span>`;
      const field = CAP_FIELD[cap.id];
      const source = borrowedFields.includes(field)
        ? `<span class="mc-borrowed" title="Filled from the sources — not published by this provider">${escapeHtml(CAP_ORIGIN[from])}</span>`
        : escapeHtml(CAP_ORIGIN[from]);
      return row(cap.label, `${mark} ${word}<span class="mc-cap-from">${source}</span>`);
    };
    const capRows = CAT_CAPABILITIES.map(capRow).join('');
    const health = e.health;
    return `<div class="mc-detail-grid">
      <div class="mc-detail-main">
      <div class="mc-panel">
        <div class="mc-panel-head">Where this row comes from</div>
        <div class="mc-compare">
          <div class="mc-compare-row head"><span>Fact</span><span>Value</span><span></span></div>
          ${row('Provider', escapeHtml(p ? p.name : e.providerId))}
          ${row('Model id', `<code>${escapeHtml(e.id)}</code>`)}
          ${provRow('Context window', 'context_tokens', (v) => (v == null ? 'not published' : `${Number(v).toLocaleString()} tokens`))}
          ${provRow('Max output', 'output_tokens', (v) => (v == null ? 'not published' : `${Number(v).toLocaleString()} tokens`))}
          ${provRow('Input modalities', 'input_modalities')}
          ${provRow('Output modalities', 'output_modalities')}
          ${provRow('Price in / out, per 1M', 'cost_in_per_m', (v) => (v == null ? 'not published' : `$${v} / $${e.cost_out_per_m ?? '—'}`))}
          ${provRow('Released', 'release_date')}
          ${row('First seen', e.first_seen ? escapeHtml(formatAgo(e.first_seen)) : '<span class="dt-muted">—</span>')}
          ${health ? row('Last health check', escapeHtml(`${(HEALTH_META[health.status] || HEALTH_META.error).label} · ${formatAgo(health.at)}${health.note ? ` · ${health.note}` : ''}`))
            : row('Last health check', '<span class="dt-muted">never checked</span>')}
          ${row('Health history', healthBarHTML(e))}
        </div>
      </div>
        <div class="mc-panel">
          <div class="mc-panel-head">What this model can do</div>
          <div class="mc-compare">${capRows}</div>
        </div>
      </div>
      <div class="mc-side">
        <div class="mc-panel">
          <div class="mc-panel-head">Scoring</div>
          <div class="mc-compare">
            <div class="mc-compare-row head"><span></span><span></span><span></span></div>
            ${row('Score', e.score == null ? '<span class="dt-muted">Unrated</span>' : `<b>${e.score}</b>`)}
            ${row('Source', escapeHtml(e.score_source === 'aa' ? 'measured' : e.score_source === 'proxy' ? 'proxy' : e.score_source === 'est' ? 'estimated' : '—'))}
            ${row('Rank here', e.rank == null ? '<span class="dt-muted">—</span>' : `#${e.rank}`)}
            ${row('Rank in reference', e.catalog_rank == null ? '<span class="dt-muted">—</span>' : `#${e.catalog_rank}`)}
            ${row('Matched', e.matched_id ? `<code>${escapeHtml(e.matched_id)}</code>` : '<span class="dt-muted">no match</span>')}
            ${row('Artificial Analysis', e.aa_intelligence == null ? '<span class="dt-muted">—</span>' : escapeHtml(String(e.aa_intelligence)))}
            ${row('Arena Elo', e.lmarena_elo == null ? '<span class="dt-muted">—</span>' : escapeHtml(String(e.lmarena_elo)))}
            ${row('Arena rank', e.lmarena_rank == null ? '<span class="dt-muted">—</span>' : `#${e.lmarena_rank}`)}
          </div>
          ${borrowedFields.length ? `<p class="mc-note">${borrowedFields.length} field${borrowedFields.length === 1 ? '' : 's'} filled from the sources: ${escapeHtml(borrowedFields.map((f) => f.replace(/_/g, ' ')).join(', '))}.</p>` : ''}
        </div>
      </div>
    </div>`;
  }

  // ---- list / filter / sort ------------------------------------------------

  function isFreeModel(e) {
    return e.cost_kind === 'free' || (e.cost_in_per_m === 0 && e.cost_out_per_m === 0);
  }

  function filtered(list) {
    const q = ui.search.trim().toLowerCase();
    let out = list.filter((e) => {
      const p = PROVIDERS[e.providerId];
      if (ui.provider !== 'all' && e.providerId !== ui.provider) return false;

      // Price filter tabs: all / free / paid
      if (ui.costTab === 'free' && !isFreeModel(e)) return false;
      if (ui.costTab === 'paid' && isFreeModel(e)) return false;

      // Model filter dropdown
      if (ui.filter === 'connected') {
        if (!p || !isConnected(p)) return false;
      } else if (ui.filter === 'new') {
        if (!e.isNew) return false;
      } else if (ui.filter === 'measured') {
        if (e.score_source !== 'aa') return false;
      } else if (ui.filter === 'estimated') {
        if (e.score_source !== 'est' && e.score_source !== 'proxy') return false;
      } else if (ui.filter === 'unrated') {
        if (e.score != null) return false;
      } else if (ui.filter === 'chat') {
        if (e.kind && e.kind !== 'chat') return false;
      } else if (ui.filter === 'reasoning') {
        if (capabilityState(e, 'reasoning') !== true) return false;
      } else if (ui.filter === 'vision') {
        if (capabilityState(e, 'vision') !== true) return false;
      } else if (ui.filter === 'tools') {
        if (capabilityState(e, 'tools') !== true) return false;
      }

      if (q && !`${e.name || ''} ${e.id || ''} ${p ? p.name : ''} ${e.family || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
    // Rank models at the catalog level based on score descending (highest score = #1).
    // Equal scores share a dense rank. Unrated models have no rank.
    const ratedCatalog = [...state.models.values()]
      .filter((e) => e.score != null)
      .sort((a, b) => b.score - a.score || (a.name || a.id).localeCompare(b.name || b.id));

    const rank = new Map();
    let currentDenseRank = 0;
    let prevScoreVal = null;
    for (const e of ratedCatalog) {
      if (prevScoreVal == null || e.score !== prevScoreVal) {
        currentDenseRank += 1;
      }
      rank.set(e.key, currentDenseRank);
      e.rank = currentDenseRank;
      prevScoreVal = e.score;
    }

    const num = (v) => (v == null ? Infinity : v);
    const by = {
      rank: (a, b) => {
        const rA = rank.get(a.key) ?? Infinity;
        const rB = rank.get(b.key) ?? Infinity;
        if (rA !== rB) return rA - rB;
        if (a.score != null && b.score != null && a.score !== b.score) return b.score - a.score;
        if (a.score != null && b.score == null) return -1;
        if (a.score == null && b.score != null) return 1;
        return (a.name || a.id).localeCompare(b.name || b.id);
      },
      context: (a, b) => num(b.context_tokens) - num(a.context_tokens),
      price: (a, b) => num(a.cost_in_per_m) - num(b.cost_in_per_m),
      speed: (a, b) => {
        const sa = modelSpeed(a);
        const sb = modelSpeed(b);
        // Fastest TIME median first: lower ms wins. tok/s only breaks ties in
        // the (rare) ms-only-vs-tps-only case — this column is the pinned TIME.
        const ma = sa ? sa.ms : null;
        const mb = sb ? sb.ms : null;
        if (ma != null && mb != null && ma !== mb) return ma - mb;
        if (ma != null && mb == null) return -1;
        if (ma == null && mb != null) return 1;
        const va = sa ? sa.tps : null;
        const vb = sb ? sb.tps : null;
        return num(vb) - num(va);
      },
      latency: (a, b) => num(latencyP50(a) ? latencyP50(a).p50 : null) - num(latencyP50(b) ? latencyP50(b).p50 : null),
      newest: (a, b) => num(b.first_seen) - num(a.first_seen),
      name: (a, b) => (a.name || a.id).localeCompare(b.name || b.id),
      provider: (a, b) => (PROVIDERS[a.providerId] || {}).name.localeCompare((PROVIDERS[b.providerId] || {}).name) || (a.name || a.id).localeCompare(b.name || b.id),
    };
    out.sort(by[ui.sort] || by.rank);
    return { out, rank };
  }

  function renderKpis(list) {
    const connected = Object.values(PROVIDERS).filter(isConnected);
    const total = Object.keys(PROVIDERS).length;
    const rated = list.filter((e) => e.score != null).length;
    const measured = list.filter((e) => e.score_source === 'aa').length;
    const lastSync = state.lastSyncAt;
    $('#mc-kpis').innerHTML = statCardsHTML([
      { label: 'Models', value: list.length, icon: ICON.box, foot: 'listed by connected providers' },
      { label: 'Providers', value: connected.length, sub: `/ ${total}`, icon: ICON.plug,
        meter: total ? connected.length / total : 0, foot: 'connected' },
      { label: 'Rated', value: rated, sub: `/ ${list.length}`, icon: ICON.trophy,
        meter: list.length ? rated / list.length : 0,
        foot: rated ? `${measured} measured · ${rated - measured} estimated` : 'not rated in sources yet' },
      { label: 'Last sync', value: lastSync ? escapeHtml(formatAgo(lastSync)) : '—', icon: ICON.clock,
        foot: state.syncing ? 'syncing…' : `${state.syncNote || 'every'} · every ${Math.max(1, Number(settings.catalogSyncMinutes) || 5)} min` },
    ]);
  }

  function providerOptionsList() {
    const connected = Object.values(PROVIDERS).filter(isConnected);
    const list = (ui.tab === 'all' || !connected.length)
      ? Object.values(PROVIDERS).filter((p) => entriesOf(p.id).length > 0 || isConnected(p))
      : connected;
    const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name));
    return sorted.map((p) => ({ value: p.id, label: p.name }));
  }

  function catalogToolbarConfig() {
    return {
      placeholder: 'Search all models by name or ID...',
      filterKey: 'costTab',
      chipsLabel: 'Cost filter',
      filters: [
        { value: 'all', label: 'All', dot: 'var(--text-3)' },
        { value: 'free', label: 'Free', dot: 'var(--type-free)' },
        { value: 'paid', label: 'Paid', dot: 'var(--type-apikey)' },
      ],
      selects: [
        {
          key: 'provider',
          icon: 'server',
          label: 'All Providers',
          options: [
            { value: 'all', label: 'All Providers' },
            ...providerOptionsList(),
          ],
        },
        {
          key: 'filter',
          icon: 'funnel',
          label: 'All Models',
          options: [
            { value: 'all', label: 'All Models' },
            { value: 'connected', label: 'Connected Models' },
            { value: 'new', label: 'New Models' },
            { value: 'measured', label: 'Measured (AA)' },
            { value: 'estimated', label: 'Estimated' },
            { value: 'unrated', label: 'Unrated' },
            { value: 'chat', label: 'Chat Models' },
            { value: 'reasoning', label: 'Reasoning' },
            { value: 'vision', label: 'Vision' },
            { value: 'tools', label: 'Tool Calling' },
          ],
        },
      ],
    };
  }

  // A provider whose last attempt failed is said so in its own column, rather
  // than the whole table quietly looking older than it is. It travels with the
  // table, above it: the tabs count models, not attempts, and a provider that
  // did not answer has models in the tab count it never proved.
  function staleBanner(list) {
    return '';
  }

  function renderResults() {
    const list = visibleEntries();
    const q = ui.search.trim().toLowerCase();

    // Base candidate list before costTab to compute All / Free / Paid counts
    const baseList = list.filter((e) => {
      const p = PROVIDERS[e.providerId];
      if (ui.provider !== 'all' && e.providerId !== ui.provider) return false;
      if (q && !`${e.name || ''} ${e.id || ''} ${(PROVIDERS[e.providerId] || {}).name || ''} ${e.family || ''}`.toLowerCase().includes(q)) return false;
      if (ui.filter === 'connected') {
        if (!p || !isConnected(p)) return false;
      } else if (ui.filter === 'new') {
        if (!e.isNew) return false;
      } else if (ui.filter === 'measured') {
        if (e.score_source !== 'aa') return false;
      } else if (ui.filter === 'estimated') {
        if (e.score_source !== 'est' && e.score_source !== 'proxy') return false;
      } else if (ui.filter === 'unrated') {
        if (e.score != null) return false;
      } else if (ui.filter === 'chat') {
        if (e.kind && e.kind !== 'chat') return false;
      } else if (ui.filter === 'reasoning') {
        if (capabilityState(e, 'reasoning') !== true) return false;
      } else if (ui.filter === 'vision') {
        if (capabilityState(e, 'vision') !== true) return false;
      } else if (ui.filter === 'tools') {
        if (capabilityState(e, 'tools') !== true) return false;
      }
      return true;
    });

    let totalAll = baseList.length;
    let totalFree = 0;
    let totalPaid = 0;
    for (const e of baseList) {
      if (isFreeModel(e)) totalFree++;
      else totalPaid++;
    }

    const cAll = document.querySelector('#mc-toolbar [data-dt-count="all"], #mc-toolbar [data-cost-count="all"]');
    if (cAll) cAll.textContent = totalAll.toLocaleString();
    const cFree = document.querySelector('#mc-toolbar [data-dt-count="free"], #mc-toolbar [data-cost-count="free"]');
    if (cFree) cFree.textContent = totalFree.toLocaleString();
    const cPaid = document.querySelector('#mc-toolbar [data-dt-count="paid"], #mc-toolbar [data-cost-count="paid"]');
    if (cPaid) cPaid.textContent = totalPaid.toLocaleString();

    // The legend is drawn from the same filtered list the table is, so a search
    // that narrows to three models moves its numbers with it. It is written as
    // part of the results block rather than swapped in on its own: the section
    // below it is replaced on every paint, and two independent swaps into one
    // parent is how a legend ends up orphaned.
    const { out, rank } = filtered(list);
    const legendEl = $('#mc-legend');
    if (legendEl) legendEl.innerHTML = legendHTML(out);
    const results = $('#mc-results');
    // The stale line goes above the legend rather than below it: it is about the
    // roster, not about the icons, and a failure nobody can see is a failure the
    // owner is told about in the wrong place.
    const banner = staleBanner(list);
    if (!out.length) {
      results.innerHTML = `${banner}${legendHTML(out)}<div class="dt-nomatch">${DT_ICON.nomatch}<p>${state.catalogCount ? 'No models match.' : 'No models yet. Sync, and each connected provider’s roster arrives here with its scores.'}</p></div>`;
      return;
    }
    if (ui.view === 'cards') {
      results.innerHTML = `${banner}<div class="pv-grid mc-grid">${out.map((e) => cardHTML(e, rank.get(e.key))).join('')}</div>`;
      return;
    }
    results.innerHTML = `${banner}<div class="dt-table-wrap mc-table-wrap"><table class="dt-table mc-table">
      <thead><tr>
        <th class="col-rank">#</th><th>Model</th>
        <th class="col-score" title="Where the score comes from: measured from Artificial Analysis, estimated from the sources, or a proxy of a measured route. A model no source describes reads Unrated.">QUALITY</th>
        <th class="col-ctx" title="Context window, as published by the provider or filled from the sources">CONTEXT</th>
        <th class="col-price" title="Price per million tokens, in and out">PRICING</th>
        <th class="col-caps" title="What this model can do. Lit = the provider published it. Dimmed = nobody has, which is not a refusal; a published “no” is left out and is spelled out in the row’s details. The legend above names every icon.">Capabilities</th>
        <th class="col-speed" title="Generation speed in tokens per second (or median response time)">SPEED</th>
        <th class="col-health" title="Health check status and availability history">Health</th><th class="dt-actions-col">Actions</th>
      </tr></thead>
      <tbody>${out.map((e) => rowHTML(e, rank.get(e.key))).join('')}</tbody>
    </table></div>`;

    const tableEl = results.querySelector('.mc-table');
    if (tableEl) {
      const headerSortMap = [
        { sel: 'th.col-rank', sort: 'rank' },
        { sel: 'th:nth-child(2)', sort: 'name' },
        { sel: 'th.col-score', sort: 'rank' },
        { sel: 'th.col-ctx', sort: 'context' },
        { sel: 'th.col-price', sort: 'price' },
        { sel: 'th.col-speed', sort: 'speed' },
        { sel: 'th.col-lat', sort: 'speed' },
      ];
      headerSortMap.forEach(({ sel, sort }) => {
        const th = tableEl.querySelector(sel);
        if (th) {
          th.style.cursor = 'pointer';
          th.title = (th.title ? `${th.title} — ` : '') + 'Click to sort';
          th.addEventListener('click', () => {
            ui.sort = sort;
            renderResults();
          });
        }
      });
    }
  }

  // Re-render just one row (a health verdict landing) without rebuilding the
  // table around it.
  function renderRow(key) {
    if (currentPage !== 'catalog' || !state.shell) return;
    const e = state.models.get(key);
    if (!e) return renderIfShown();
    const rank = filtered(visibleEntries()).rank.get(key);
    if (ui.view === 'cards') {
      const card = document.querySelector(`.mc-card[data-mc-key="${CSS.escape(key)}"]`);
      if (!card) return renderIfShown();
      card.outerHTML = cardHTML(e, rank);
    } else {
      const row = document.querySelector(`tr.mc-row[data-mc-key="${CSS.escape(key)}"]`);
      if (!row) return renderIfShown();
      row.outerHTML = rowHTML(e, rank);
    }
    if (details.key === key) {
      renderDetailsHead();
      renderDetailsBody();
      renderDetailsFoot();
    }
  }

  function renderCrumbs() {
    const crumbs = $('#mc-crumbs');
    if (!crumbs) return;
    const items = [
      { label: 'Overview', page: 'overview' },
      { label: 'Models Catalog', tab: 'connected', icon: 'catalog' },
    ];
    if (ui.provider !== 'all') {
      items.push({ label: ui.tab === 'connected' ? 'Connected' : 'All Models', tab: ui.tab });
      items.push({ label: (PROVIDERS[ui.provider] || {}).name || ui.provider });
    } else {
      items.push({ label: ui.tab === 'connected' ? 'Connected' : 'All Models' });
    }
    crumbs.innerHTML = breadcrumbHTML(items);
  }

  function renderTabs() {
    const connectedModels = [...state.models.values()].filter((e) => {
      const p = PROVIDERS[e.providerId];
      return p && isConnected(p);
    });
    // Both counts are rows this page can actually open. "All Models" is not the
    // reference's size: that is what the sources hold, most of which no provider
    // here serves, and a tab promising twelve thousand models over a list that
    // answers with six is the kind of number that makes a page look broken.
    const connectedCount = connectedModels.length;
    const allCount = [...state.models.values()].filter((e) => !!PROVIDERS[e.providerId]).length;

    const countConnected = $('#mc-count-connected');
    if (countConnected) countConnected.textContent = connectedCount.toLocaleString();
    const countAll = $('#mc-count-all');
    if (countAll) countAll.textContent = allCount.toLocaleString();

    $$('.page-catalog .pv-tab').forEach((t) => {
      const on = t.dataset.tab === ui.tab;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
    });

    const syncOrb = $('.page-catalog [data-mc-sync]');
    if (syncOrb) syncOrb.classList.toggle('spin', state.syncing);
  }

  function open() {
    ui.tab = 'connected';
    ui.costTab = 'all';
    ui.filter = 'all';
    ui.provider = 'all';
    ui.search = '';
    state.legendOpen = true;
    state.shell = false;
    render();
  }

  function render() {
    if (!state.loaded) { load().then(render); return; }
    const body = $('#mc-body');
    if (!body) return;
    renderCrumbs();
    renderTabs();
    const connected = Object.values(PROVIDERS).filter(isConnected);
    if (!connected.length && ui.tab === 'connected') {
      state.shell = false;
      body.innerHTML = `<div class="pv-empty">
        <div class="pv-empty-icon">${ICON.empty}</div>
        <h3>No providers connected</h3>
        <p>Every model your connected providers offer appears here, scored against the sources. Connect one and its models show up within seconds, then stay in step with what the provider offers.</p>
        <button class="btn btn-primary" type="button" data-go="providers">${ICON.plug}Open Providers</button>
      </div>`;
      return;
    }
    if (!state.shell) {
      state.shell = true;
      const cfg = catalogToolbarConfig();
      body.innerHTML = `<div id="mc-kpis"></div>
        <div id="mc-legend"></div>
        <div id="mc-toolbar">${dataToolbarHTML(cfg, ui)}</div>
        <div id="mc-results"></div>`;
      const tb = $('#mc-toolbar');
      bindDataToolbar(tb, ui, (key) => {
        if (key === 'provider') renderCrumbs();
        renderResults();
      }, cfg);
    } else {
      // Providers may have connected or disconnected since the shell was built.
      const provSelect = $('#mc-toolbar [data-dt-select="provider"], #mc-toolbar [data-mc-provider]');
      if (provSelect) {
        if (ui.provider !== 'all' && !(PROVIDERS[ui.provider] && isConnected(PROVIDERS[ui.provider]))) ui.provider = 'all';
        const opts = [{ value: 'all', label: 'All Providers' }, ...providerOptionsList()];
        provSelect.innerHTML = opts.map(o => `<option value="${escapeHtml(o.value)}" ${ui.provider === o.value ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
        if (provSelect._uiTrigger) {
          const valEl = provSelect._uiTrigger.querySelector('.ui-select-value');
          if (valEl) valEl.textContent = provSelect.options[provSelect.selectedIndex]?.textContent || 'All Providers';
        }
      }
    }
    renderKpis(visibleEntries());
    renderResults();
  }

  function renderIfShown() {
    if (currentPage !== 'catalog') return;
    // Coalesce bursts (a health verdict plus its row redraw) into one paint.
    if (state.pendingRender) return;
    state.pendingRender = requestAnimationFrame(() => { state.pendingRender = null; render(); });
  }

  // ---- events --------------------------------------------------------------

  function bind() {
    const page = $('.page-catalog');
    if (!page) return;
    page.addEventListener('click', (ev) => {
      const tabTarget = ev.target.closest('.page-catalog [data-tab]');
      if (tabTarget) {
        ui.tab = tabTarget.dataset.tab;
        renderTabs();
        renderCrumbs();
        renderKpis(visibleEntries());
        renderResults();
        return;
      }
      const chatBtn = ev.target.closest('[data-mc-chat]');
      if (chatBtn) { ev.stopPropagation(); openChat(chatBtn.dataset.mcChat, chatBtn); return; }
      const health = ev.target.closest('[data-mc-health]');
      if (health) { ev.stopPropagation(); healthCheck(health.dataset.mcHealth); return; }
      const fetchInfoBtn = ev.target.closest('[data-mc-fetch-info]');
      if (fetchInfoBtn) { ev.stopPropagation(); fetchInfo(fetchInfoBtn.dataset.mcFetchInfo); return; }
      if (ev.target.closest('[data-mc-sync]')) { syncAll({ reason: 'manual' }); return; }
      // The legend is a key, not a filter: the button only folds the eight tiles
      // away. The counts are redrawn from whatever the table is showing, which is
      // why this re-renders rather than hiding a node.
      if (ev.target.closest('[data-mc-legend-toggle], .mc-legend-head')) {
        state.legendOpen = !state.legendOpen;
        renderIfShown();
        return;
      }
      const go = ev.target.closest('[data-go]');
      if (go) { showPage(go.dataset.go); return; }
      const detailsTarget = ev.target.closest('[data-mc-details]');
      if (detailsTarget) {
        if (ev.target.closest('button') && !detailsTarget.matches('button') && !detailsTarget.matches('tr')) return;
        const key = detailsTarget.dataset.mcDetails;
        if (details.key === key) closeDetails();
        else openDetails(key, detailsTarget);
        return;
      }
    });
    page.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const row = ev.target.closest('tr.mc-row');
      // Only the row itself opens details; a focused button keeps its own key handling.
      if (!row || ev.target !== row) return;
      ev.preventDefault();
      const key = row.dataset.mcKey;
      if (details.key === key) closeDetails();
      else openDetails(key, row);
    });

    // Keys added or removed on the Providers page: that provider's models
    // appear or vanish right away, and its roster is re-read.
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
    // Route Test pins TIME values as Speed: after a run lands, re-read the
    // history so the rows show it without waiting for a revisit.
    let historyTimer = null;
    window.addEventListener('history-updated', () => {
      clearTimeout(historyTimer);
      historyTimer = setTimeout(() => {
        loadHistoryRuns().then(() => renderIfShown()).catch(() => {});
      }, 400);
    });
    COMPACT_LAYOUT.addEventListener('change', (mq) => {
      ui.view = mq.matches ? 'cards' : 'table';
      renderIfShown();
    });
  }

  // ---- settings section ----------------------------------------------------

  function fillSettings() {
    const sync = $('#set-catalog-sync');
    if (sync) sync.value = Math.max(1, Number(settings.catalogSyncMinutes) || 5);
    renderOpenRouterKey();
  }

  // The key never comes back to the page: a saved one shows as "Saved" with an
  // empty field, and typing a new one replaces it. Main reads it at the point of
  // use and the page is only ever told whether one is set.
  const OR_PLACEHOLDER = 'sk-or-v1-… from openrouter.ai';
  function renderOpenRouterKey() {
    const saved = settings.openRouterApiKey === 'venomsecret:openRouterApiKey';
    const key = $('#set-openrouter-key');
    if (key) {
      key.value = '';
      key.placeholder = saved ? 'Saved — type a new key to replace it' : OR_PLACEHOLDER;
    }
    const badge = $('#openrouter-key-saved');
    if (badge) badge.hidden = !saved;
    const remove = $('#btn-openrouter-remove');
    if (remove) remove.hidden = !saved;
  }

  // Empty or unchanged text is not a change. New text goes to main, which
  // encrypts it; the page keeps only the placeholder. On failure the typed text
  // stays in the field so it can be retried.
  async function storeOpenRouterKey() {
    const key = $('#set-openrouter-key');
    const text = key ? key.value.trim() : '';
    if (!text || text === settings.openRouterApiKey) return;
    const res = await persist('save the OpenRouter key', () => window.electronAPI.saveSecret('openRouterApiKey', text));
    if (!res) return;
    settings.openRouterApiKey = res.placeholder;
    renderOpenRouterKey();
  }

  async function removeOpenRouterKey() {
    const res = await persist('remove the OpenRouter key', () => window.electronAPI.saveSecret('openRouterApiKey', ''));
    if (!res) return;
    settings.openRouterApiKey = '';
    renderOpenRouterKey();
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
    const key = $('#set-openrouter-key');
    if (key) key.addEventListener('change', storeOpenRouterKey);
    const removeKey = $('#btn-openrouter-remove');
    if (removeKey) removeKey.addEventListener('click', removeOpenRouterKey);
    const resync = $('#btn-catalog-resync');
    if (resync) resync.addEventListener('click', () => { syncAll({ reason: 'manual' }); renderIfShown(); });
  }

  // ---- init ----------------------------------------------------------------

  async function init() {
    await load();
    bind();
    bindChatDrawer();
    bindDetailsDrawer();
    bindSettings();
    scheduleTimer();
    // First pass right away so the page is populated on first visit. The
    // reference itself is not fetched here: catalog:sources stays report-only
    // until the owner asks for it, because five megabytes must never be spent
    // because a page opened.
    syncAll({ reason: 'startup' });
  }

  window.CATALOG = {
    init,
    flush,
    render,
    open,
    renderIfShown,
    syncAll,
    fillSettings,
    load,
    reload,
    visibleEntries,
    keyModels,
    providerModelCount,
    forgetKey,
    openDetails,
    closeDetails,
    state,
    ui,
  };
})();