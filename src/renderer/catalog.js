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

  const ui = {
    search: '',
    filter: 'all',
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

  let loadPromise = null;
  function load() {
    if (state.loaded) return Promise.resolve(state.models);
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
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
      return { status: 'unreachable', note: res.error || 'No response', httpStatus: 0, at, timeMs: res.elapsed };
    }
    let j = null;
    try { j = JSON.parse(res.body); } catch (_) { /* not JSON */ }
    const errMsg = j && j.error ? (j.error.message || j.error.code || j.error.type || String(j.error)) : '';
    if (res.status !== 200) {
      const status = classifyHealthText(errMsg)
        || (res.status === 429 ? 'rate-limited' : res.status === 401 || res.status === 403 ? 'auth' : 'error');
      return { status, note: errMsg || `HTTP ${res.status}`, httpStatus: res.status, at, timeMs: res.elapsed };
    }
    if (errMsg) {
      return { status: classifyHealthText(errMsg) || 'error', note: errMsg, httpStatus: 200, at, timeMs: res.elapsed };
    }
    if (j && Array.isArray(j.choices) && j.choices.length) {
      let content = '';
      try { content = parseChatCompletion(res.body).content || ''; } catch (_) { /* unreadable */ }
      const cls = classifyHealthText(content);
      if (cls) return { status: cls, note: content.slice(0, 140), httpStatus: 200, at, timeMs: res.elapsed };
      return { status: 'healthy', note: 'Responded normally', httpStatus: 200, at, timeMs: res.elapsed };
    }
    return { status: 'error', note: '200 OK but an unreadable response', httpStatus: 200, at, timeMs: res.elapsed };
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
      e.health = h;
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

  function latencyCell(e) {
    const l = latencyP50(e);
    if (!l) return '<span class="dt-muted">—</span>';
    return `<span class="${timeClass(l.p50)}" title="Median of ${l.n} health-check request${l.n === 1 ? '' : 's'}">${fmtMs(l.p50)}</span>`;
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
    brain: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4a3 3 0 0 0-3 3v10a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3z"/><path d="M9 9H7a3 3 0 0 0 0 6h2M15 9h2a3 3 0 0 1 0 6h-2"/></svg>',
    pass: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    fail: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    empty: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/></svg>',
    chat: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    heart: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/><path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27"/></svg>',
    send: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
    close: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
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
      { value: 'latency', label: 'Latency' },
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
    if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
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
    if (e.score == null) return '<span class="dt-muted">Unrated</span>';
    return scoreBar(e.score);
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
    return borrowed(e, 'context_tokens', escapeHtml(fmtContext(e.context_tokens)));
  }

  function outputCell(e) {
    if (e.output_tokens == null) return '<span class="dt-muted">—</span>';
    return borrowed(e, 'output_tokens', escapeHtml(fmtContext(e.output_tokens)));
  }

  function priceCell(e) {
    if (e.cost_in_per_m == null && e.cost_out_per_m == null) {
      return '<span class="dt-muted" title="Nobody published a price for this model">—</span>';
    }
    const f = (v) => (v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(3)).replace(/\.?0+$/, '');
    const free = e.cost_in_per_m === 0 && e.cost_out_per_m === 0;
    if (free) return '<span class="mc-price-free">free</span>';
    const text = `$${f(e.cost_in_per_m ?? 0)} / $${f(e.cost_out_per_m ?? 0)}`;
    return borrowed(e, 'cost_in_per_m', escapeHtml(text));
  }

  // Declared capabilities, three letters: T tools · J strict JSON · A file
  // input. Green = published yes, red = published no, grey = nobody said. A
  // grey letter is not a refusal: unknown stays unknown, which is why row.js
  // returns null rather than false.
  function capsHTML(e) {
    const one = (label, title, value) => {
      const st = value === true ? 'yes' : value === false ? 'no' : 'unknown';
      return `<span class="mc-cap mc-cap-${st}" title="${escapeHtml(`${title}: ${value === null || value === undefined ? 'not published' : value ? 'yes' : 'no'}`)}">${label}</span>`;
    };
    return `<span class="mc-caps">${one('T', 'Tool calling', e.tools)}${one('J', 'Strict JSON mode', e.structured)}${one('A', 'Accepts files', e.attachment)}</span>`;
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
    // null is "nobody said", so the icon only appears on a published yes.
    if (e.attachment === true) out.push(`<span class="icon-badge type-vision" title="Accepts images or files">${ICON.eye}</span>`);
    if (e.reasoning === true) out.push(`<span class="icon-badge type-think" title="Reasoning">${ICON.brain}</span>`);
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
    const open = state.expanded.has(e.key);
    const key = escapeHtml(e.key);
    const rankCell = rank ? `<span class="mc-rank ${rank <= 3 ? 'top' : ''}">#${rank}</span>` : '<span class="dt-muted">—</span>';
    const costLabel = e.cost_kind === 'free' ? ' · free' : '';
    return `<tr class="dt-row mc-row ${open ? 'open' : ''}" data-mc-key="${key}" data-kx-toggle="${key}" aria-expanded="${open}" tabindex="0">
      <td class="dt-num col-rank">${rankCell}</td>
      <td><div class="dt-provider">${ICON.chevron}
        <span class="pv-logo">${providerMark(p)}</span>
        <div><div class="dt-provider-name mc-name">${escapeHtml(e.name || e.id)}${badges(e)}${healthBadgeHTML(e)}</div>
        <div class="dt-provider-host mc-sub">${healthDotHTML(p)}${escapeHtml(p.name)}${e.name && e.name !== e.id ? ` · <code>${escapeHtml(e.id)}</code>` : ''}${e.family ? ` · ${escapeHtml(e.family)}` : ''}${costLabel}</div></div>
      </div></td>
      <td class="col-score" title="${escapeHtml(scoreTip(e))}">${scoreCell(e)}</td>
      <td class="dt-num col-ctx">${contextCell(e)}</td>
      <td class="dt-num col-out">${outputCell(e)}</td>
      <td class="dt-num col-price">${priceCell(e)}</td>
      <td class="col-caps">${capsHTML(e)}</td>
      <td class="dt-num col-lat">${latencyCell(e)}</td>
      <td class="col-health">${healthCell(e)}</td>
      <td class="dt-actions-col"><div class="dt-row-actions">${actionButtons(e)}</div></td>
    </tr>${open ? `<tr class="dt-detail mc-detail" data-mc-detail="${key}"><td colspan="10">${detailHTML(e)}</td></tr>` : ''}`;
  }

  function cardHTML(e, rank) {
    const p = PROVIDERS[e.providerId];
    const key = escapeHtml(e.key);
    const open = state.expanded.has(e.key);
    return `<article class="pv-card mc-card ${open ? 'open' : ''}" data-mc-key="${key}" style="--type-stripe:${escapeHtml(p.color || 'var(--accent)')}">
      <div class="pv-card-top">
        <span class="pv-logo">${providerMark(p)}</span>
        <span class="pv-host">${healthDotHTML(p)}${escapeHtml(p.name)}${e.context_tokens ? ` · ${escapeHtml(fmtContext(e.context_tokens))}` : ''}</span>
      </div>
      <h3 class="pv-name"><span>${escapeHtml(e.name || e.id)}</span></h3>
      <div class="mc-card-badges">${badges(e)}${healthBadgeHTML(e)}${rank ? `<span class="mc-rank ${rank <= 3 ? 'top' : ''}">#${rank}</span>` : ''}</div>
      <div class="pv-stats">
        <div class="pv-stat" title="${escapeHtml(scoreTip(e))}"><span class="pv-stat-label">Score</span><span class="pv-stat-value">${e.score == null ? '—' : e.score}</span></div>
        <div class="pv-stat"><span class="pv-stat-label">Context</span><span class="pv-stat-value">${e.context_tokens == null ? '—' : escapeHtml(fmtContext(e.context_tokens))}</span></div>
        <div class="pv-stat"><span class="pv-stat-label">Latency</span><span class="pv-stat-value">${fmtMs(latencyP50(e) ? latencyP50(e).p50 : null)}</span></div>
        <div class="pv-stat"><span class="pv-stat-label">Price</span><span class="pv-stat-value">${priceCell(e)}</span></div>
      </div>
      <div class="mc-card-caps">${capsHTML(e)}</div>
      <div class="pv-card-actions">
        <button class="btn btn-ghost btn-mini" type="button" data-kx-toggle="${key}">${open ? 'Hide details' : 'Details'}</button>
        ${actionButtons(e)}
      </div>
      ${open ? `<div class="mc-card-detail">${detailHTML(e)}</div>` : ''}
    </article>`;
  }

  function detailHTML(e) {
    const p = PROVIDERS[e.providerId];
    const borrowedFields = e.filled_from_catalog || [];
    const row = (label, value) => `<div class="mc-compare-row"><span>${escapeHtml(label)}</span><span>${value}</span><span></span></div>`;
    const provRow = (label, field, fmt = valueLabel) => row(label, borrowedFields.includes(field)
      ? `<span class="mc-borrowed" title="Filled from the sources — not published by this provider">${escapeHtml(fmt(e[field]))}</span>`
      : `<span class="mc-note">${escapeHtml(fmt(e[field]))}</span>`);
    const health = e.health;
    return `<div class="mc-detail-grid">
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
          ${provRow('Tool calling', 'tools', (v) => (v == null ? 'not published' : v ? 'yes' : 'no'))}
          ${provRow('Reasoning', 'reasoning', (v) => (v == null ? 'not published' : v ? 'yes' : 'no'))}
          ${provRow('Structured output', 'structured', (v) => (v == null ? 'not published' : v ? 'yes' : 'no'))}
          ${provRow('Accepts files', 'attachment', (v) => (v == null ? 'not published' : v ? 'yes' : 'no'))}
          ${provRow('Price in / out, per 1M', 'cost_in_per_m', (v) => (v == null ? 'not published' : `$${v} / $${e.cost_out_per_m ?? '—'}`))}
          ${provRow('Released', 'release_date')}
          ${row('First seen', e.first_seen ? escapeHtml(formatAgo(e.first_seen)) : '<span class="dt-muted">—</span>')}
          ${health ? row('Last health check', escapeHtml(`${(HEALTH_META[health.status] || HEALTH_META.error).label} · ${formatAgo(health.at)}${health.note ? ` · ${health.note}` : ''}`))
            : row('Last health check', '<span class="dt-muted">never checked</span>')}
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

  function filtered(list) {
    const q = ui.search.trim().toLowerCase();
    let out = list.filter((e) => {
      const p = PROVIDERS[e.providerId];
      if (ui.provider !== 'all' && e.providerId !== ui.provider) return false;
      if (q && !`${e.name} ${e.id} ${p ? p.name : ''} ${e.family || ''}`.toLowerCase().includes(q)) return false;
      if (ui.filter === 'new') return !!e.isNew;
      if (ui.filter === 'measured') return e.score_source === 'aa';
      if (ui.filter === 'estimated') return e.score_source === 'est' || e.score_source === 'proxy';
      if (ui.filter === 'unrated') return e.score == null;
      return true;
    });
    const rank = new Map();
    list.filter((e) => e.rank != null).sort((a, b) => a.rank - b.rank).forEach((e, i) => rank.set(e.key, i + 1));
    const num = (v) => (v == null ? Infinity : v);
    const by = {
      rank: (a, b) => num(a.rank) - num(b.rank) || (a.name || a.id).localeCompare(b.name || b.id),
      context: (a, b) => num(b.context_tokens) - num(a.context_tokens),
      price: (a, b) => num(a.cost_in_per_m) - num(b.cost_in_per_m),
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
        foot: rated ? `${measured} measured · ${rated - measured} estimated` : 'no entry in the sources describes these yet' },
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

  // A provider whose last attempt failed is said so in its own column, rather
  // than the whole table quietly looking older than it is.
  function staleBanner(list) {
    const bad = state.providers.filter((p) => !p.ok || p.stale);
    if (!bad.length) return '';
    const bits = bad.map((p) => p.ok
      ? `${escapeHtml((PROVIDERS[p.providerId] || {}).name || p.providerId)} is stale — ${escapeHtml(p.warning || 'the last attempt failed')}`
      : `${escapeHtml((PROVIDERS[p.providerId] || {}).name || p.providerId)}: ${escapeHtml(p.message || p.code)}`);
    return `<div class="mc-source-error" role="status">${bits.join(' · ')}</div>`;
  }

  function renderResults() {
    const list = visibleEntries();
    const q = ui.search.trim().toLowerCase();
    const searched = list.filter((e) => (ui.provider === 'all' || e.providerId === ui.provider)
      && (!q || `${e.name} ${e.id} ${(PROVIDERS[e.providerId] || {}).name || ''}`.toLowerCase().includes(q)));
    const count = { all: searched.length, new: 0, measured: 0, estimated: 0, unrated: 0 };
    searched.forEach((e) => {
      if (e.isNew) count.new += 1;
      if (e.score_source === 'aa') count.measured += 1;
      if (e.score_source === 'est' || e.score_source === 'proxy') count.estimated += 1;
      if (e.score == null) count.unrated += 1;
    });
    $$('#mc-toolbar [data-dt-count]').forEach((el) => { el.textContent = count[el.dataset.dtCount] ?? 0; });

    const { out, rank } = filtered(list);
    const results = $('#mc-results');
    if (!out.length) {
      results.innerHTML = `<div class="dt-nomatch">${DT_ICON.nomatch}<p>${state.catalogCount ? 'No models match.' : 'No models yet. Sync, and each connected provider’s roster arrives here with its scores.'}</p></div>`;
      return;
    }
    const banner = staleBanner(list);
    if (ui.view === 'cards') {
      results.innerHTML = `${banner}<div class="pv-grid mc-grid">${out.map((e) => cardHTML(e, rank.get(e.key))).join('')}</div>`;
      return;
    }
    results.innerHTML = `${banner}<div class="dt-table-wrap mc-table-wrap"><table class="dt-table mc-table">
      <thead><tr>
        <th class="col-rank">#</th><th>Model</th>
        <th class="col-score" title="Where the score comes from: measured from Artificial Analysis, estimated from the sources, or a proxy of a measured route. A model no source describes reads Unrated.">Score</th>
        <th class="col-ctx" title="Context window, as published by the provider or filled from the sources">Context</th>
        <th class="col-out" title="Maximum output tokens">Output</th>
        <th class="col-price" title="Price per million tokens, in and out">In / Out $</th>
        <th class="col-caps" title="Declared capabilities. Grey means nobody published it, not that it is absent.">Caps</th>
        <th class="col-lat" title="Median latency of this model’s health-check requests">Latency p50</th>
        <th class="col-health">Health</th><th class="dt-actions-col">Actions</th>
      </tr></thead>
      <tbody>${out.map((e) => rowHTML(e, rank.get(e.key))).join('')}</tbody>
    </table></div>`;
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
      return;
    }
    const row = document.querySelector(`tr.mc-row[data-mc-key="${CSS.escape(key)}"]`);
    if (!row) return renderIfShown();
    const detail = document.querySelector(`tr.mc-detail[data-mc-detail="${CSS.escape(key)}"]`);
    if (detail) detail.remove();
    row.outerHTML = rowHTML(e, rank);
  }

  function renderCrumbs() {
    const crumbs = $('#mc-crumbs');
    if (!crumbs) return;
    crumbs.innerHTML = `<span class="crumb">Models</span>${ui.provider !== 'all'
      ? `<span class="crumb-sep">/</span><span class="crumb">${escapeHtml((PROVIDERS[ui.provider] || {}).name || ui.provider)}</span>` : ''}`;
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
        <p>Every model your connected providers offer appears here, scored against the sources. Connect one and its models show up within seconds, then stay in step with what the provider offers.</p>
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
        `<button class="dt-icon-btn mc-sync-btn" type="button" data-mc-sync title="Re-read every connected provider's model list" aria-label="Sync now">${ICON.sync}</button>`);
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
    // Coalesce bursts (a health verdict plus its row redraw) into one paint.
    if (state.pendingRender) return;
    state.pendingRender = requestAnimationFrame(() => { state.pendingRender = null; render(); });
  }

  // ---- events --------------------------------------------------------------

  function bind() {
    const page = $('.page-catalog');
    if (!page) return;
    page.addEventListener('click', (ev) => {
      const chatBtn = ev.target.closest('[data-mc-chat]');
      if (chatBtn) { ev.stopPropagation(); openChat(chatBtn.dataset.mcChat, chatBtn); return; }
      const health = ev.target.closest('[data-mc-health]');
      if (health) { ev.stopPropagation(); healthCheck(health.dataset.mcHealth); return; }
      const fetchInfoBtn = ev.target.closest('[data-mc-fetch-info]');
      if (fetchInfoBtn) { ev.stopPropagation(); fetchInfo(fetchInfoBtn.dataset.mcFetchInfo); return; }
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
      // Only the row itself toggles; a focused button keeps its own key handling.
      if (!row || ev.target !== row) return;
      ev.preventDefault();
      const key = row.dataset.mcKey;
      if (state.expanded.has(key)) state.expanded.delete(key); else state.expanded.add(key);
      renderResults();
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
    renderIfShown,
    syncAll,
    fillSettings,
    load,
    visibleEntries,
    keyModels,
    providerModelCount,
    forgetKey,
    state,
    ui,
  };
})();