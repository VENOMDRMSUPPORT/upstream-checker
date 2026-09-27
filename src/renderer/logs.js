// ============================================
// Log pages — Runs, Requests and Monitoring
// ============================================
// Reads the request log sub-project B records in venom-logs.db, through the
// read-only logs-* channels. Nothing here writes a log row; the only calls
// that change anything are the export and the clear in Settings.
//
// Loaded after app.js (which owns showPage) and after logs-format.js, whose
// top-level functions this file calls by name.

(function () {
  'use strict';

  const state = {
    tab: 'runs',              // 'runs' | 'requests'
    filters: { range: '24h', source: [], providerId: [], model: '', status: [], text: '', runId: '' },
    sort: 'time',
    cursor: null,
    rows: [],
    providerNames: {},
    facets: null,
    facetsRange: null,
    info: null,
    stale: null,              // an error message, when a read failed
    routeRead: false,
    monitor: { range: '24h', bucket: 'hour', groupBy: 'none' },
  };

  const el = (id) => document.getElementById(id);

  // The existing route grammar, unchanged: #/history/requests. No new parser,
  // no pushState, no popstate — the hash is a deep link restored on reload,
  // not browser history.
  function tabFromRoute() {
    const parts = (location.hash || '').split('/');
    return parts[2] === 'requests' ? 'requests' : 'runs';
  }

  // Every view asks this first. When the log database could not be opened the
  // app is fine and only these pages have nothing to show, so they say so
  // calmly instead of raising an error.
  async function loadInfo() {
    state.info = await window.electronAPI.logsInfo();
    return state.info;
  }

  function emptyState(title, detail) {
    return `<div class="log-empty"><p class="log-empty-title">${title}</p><p class="log-empty-detail">${detail}</p></div>`;
  }

  function loggingOffMarkup() {
    const why = state.info && state.info.error ? logEscape(state.info.error) : 'Logging is turned off.';
    return emptyState('No request log', `${why} Turn request logging on in Settings to start recording.`);
  }

  async function render() {
    if (!state.routeRead) {
      state.tab = tabFromRoute();
      state.routeRead = true;
    }
    await loadInfo();
    renderTabs();
    if (!state.info.enabled) {
      el('log-filters').innerHTML = '';
      el('log-body').innerHTML = loggingOffMarkup();
      return;
    }
    if (state.tab === 'runs') await renderRuns();
    else await renderRequests();
  }

  async function renderMonitor(note) {
    await loadInfo();
    if (!state.info.enabled) {
      el('monitor-filters').innerHTML = '';
      el('monitor-body').innerHTML = loggingOffMarkup();
      return;
    }
    await renderCharts(note);
  }

  function renderTabs() {
    document.querySelectorAll('.log-tab').forEach((b) => {
      const on = b.dataset.tab === state.tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  document.addEventListener('click', (e) => {
    const tab = e.target.closest('.log-tab');
    if (!tab) return;
    if (state.tab === tab.dataset.tab) return;
    state.tab = tab.dataset.tab;
    state.cursor = null;
    state.rows = [];
    if (typeof syncRoute === 'function') syncRoute();
    render();
  });

  // ---- filters -------------------------------------------------------

  // The range always has a value and can only be widened, never cleared. That
  // is what keeps query.js's rule — a non-time sort needs a bounded range —
  // invisible to the reader rather than an error they can trigger.
  function queryFilters() {
    const { from, to } = rangePreset(state.filters.range);
    const f = { from, to };
    if (state.filters.source.length) f.source = state.filters.source;
    if (state.filters.providerId.length) f.providerId = state.filters.providerId;
    if (state.filters.status.length) f.status = state.filters.status;
    if (state.filters.model) f.model = state.filters.model;
    if (state.filters.runId) f.runId = state.filters.runId;
    if (state.filters.text) f.text = state.filters.text;
    return f;
  }

  // facets reads usage_hourly, which buckets to whole hours, so a provider
  // first used minutes ago may not be in the dropdown until its roll-up row
  // exists. That is expected, not staleness: the dropdown is a convenience,
  // and a provider missing from it never hides a row, because the table is
  // filtered by what was picked.
  async function loadFacets() {
    const { from, to } = rangePreset(state.filters.range);
    const key = `${from}|${to}`;
    if (state.facetsRange === key && state.facets) return state.facets;
    state.facets = await window.electronAPI.logsFacets({ from, to });
    state.facetsRange = key;
    return state.facets;
  }

  const RANGE_LABELS = { '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days' };

  function renderFilters(facets) {
    const opt = (v, label, sel) => `<option value="${logEscape(v)}"${String(sel) === String(v) ? ' selected' : ''}>${logEscape(label)}</option>`;
    const chip = state.filters.runId
      ? `<span class="log-chip">Run ${logEscape(state.filters.runId)}<button class="log-chip-x" type="button" id="log-clear-run" aria-label="Clear the run filter">&times;</button></span>`
      : '';
    el('log-filters').innerHTML = `
      <select class="prompt-input narrow" id="log-range">
        ${Object.entries(RANGE_LABELS).map(([k, l]) => opt(k, l, state.filters.range)).join('')}
      </select>
      <select class="prompt-input narrow" id="log-provider">
        ${opt('', 'Every provider', state.filters.providerId[0] || '')}
        ${facets.providers.map((p) => opt(p.id, providerLabel(p.id, p.name), state.filters.providerId[0] || '')).join('')}
      </select>
      <select class="prompt-input narrow" id="log-model">
        ${opt('', 'Every model', state.filters.model)}
        ${facets.models.map((m) => opt(m, m, state.filters.model)).join('')}
      </select>
      <select class="prompt-input narrow" id="log-source">
        ${opt('', 'Every source', state.filters.source[0] || '')}
        ${facets.sources.map((s) => opt(s, s, state.filters.source[0] || '')).join('')}
      </select>
      <select class="prompt-input narrow" id="log-status">
        ${opt('', 'Any outcome', state.filters.status[0] || '')}
        ${['ok', 'error', 'cancelled'].map((s) => opt(s, s, state.filters.status[0] || '')).join('')}
      </select>
      <input class="prompt-input" id="log-text" placeholder="Search id, run or error" value="${logEscape(state.filters.text)}">
      ${chip}
      <button class="btn btn-ghost" type="button" id="log-export">Export CSV</button>`;
  }

  function reload() {
    state.cursor = null;
    state.rows = [];
    render();
  }

  let textTimer = null;

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || !t.id || !el('log-filters') || !el('log-filters').contains(t)) return;
    const list = (v) => (v ? [v] : []);
    if (t.id === 'log-range') { state.filters.range = t.value; state.facets = null; state.facetsRange = null; }
    else if (t.id === 'log-provider') state.filters.providerId = list(t.value);
    else if (t.id === 'log-model') state.filters.model = t.value;
    else if (t.id === 'log-source') state.filters.source = list(t.value);
    else if (t.id === 'log-status') state.filters.status = list(t.value);
    else return;
    reload();
  });

  document.addEventListener('input', (e) => {
    if (!e.target || e.target.id !== 'log-text') return;
    clearTimeout(textTimer);
    const value = e.target.value;
    textTimer = setTimeout(() => {
      state.filters.text = value;
      reload();
    }, 300);
  });

  // ---- the requests table --------------------------------------------

  const COLUMNS = [
    { label: 'Time', sort: 'time' },
    { label: 'Source' },
    { label: 'Provider' },
    { label: 'Model' },
    { label: 'Outcome' },
    { label: 'Latency', sort: 'latency' },
    { label: 'TTFT', sort: 'ttft' },
    { label: 'Tokens' },
    { label: 'Cost', sort: 'cost' },
  ];

  function headerCell(col) {
    if (!col.sort) return `<th>${col.label}</th>`;
    const on = state.sort === col.sort;
    // A second click on a sorted column goes back to time order rather than
    // reversing: every sort is descending (query.js, SORT_COLUMNS).
    return `<th><button class="log-sort${on ? ' active' : ''}" type="button" data-sort="${col.sort}">${col.label}${on ? ' ↓' : ''}</button></th>`;
  }

  async function renderRequests() {
    const facets = await loadFacets();
    renderFilters(facets);
    const names = {};
    facets.providers.forEach((p) => { names[normalizeProvider(p.id)] = p.name; });
    state.providerNames = names;
    let page;
    try {
      page = await window.electronAPI.logsList(queryFilters(), state.cursor, 100, state.sort);
      state.stale = null;
    } catch (err) {
      // B's rule: an error propagates rather than becoming an empty result.
      // Keep what is on screen and say it is not current.
      state.stale = err && err.message ? err.message : String(err);
      renderStaleBanner();
      return;
    }
    state.rows = state.cursor ? state.rows.concat(page.rows) : page.rows;
    state.cursor = page.nextCursor;
    if (!state.rows.length) {
      el('log-body').innerHTML = emptyState('No requests in this range', 'Widen the range, or clear a filter.');
      return;
    }
    el('log-body').innerHTML = `<div class="log-scroll"><table class="log-table">
      <thead><tr>${COLUMNS.map(headerCell).join('')}</tr></thead>
      <tbody id="log-rows">${rowsMarkup()}</tbody></table></div>
      ${state.cursor ? '<button class="btn btn-ghost" type="button" id="log-more">Show more</button>' : ''}`;
  }

  // Split out so the live tail can redraw the body alone and leave the
  // header, the filter bar and the scroll position where they are.
  function rowsMarkup() {
    return state.rows.map((row) => {
      const vm = toViewModel(row, state.providerNames);
      return `<tr class="log-row" data-id="${vm.id}">
        <td>${vm.when}</td><td>${vm.source}</td><td>${vm.provider}</td><td>${vm.model}</td>
        <td><span class="log-pill ${vm.tone}">${vm.errorClass || vm.status}</span></td>
        <td>${vm.latency}</td><td>${vm.ttft}</td><td>${vm.tokens}</td><td>${vm.cost}</td>
      </tr>`;
    }).join('');
  }

  function renderRequestRows() {
    const tbody = el('log-rows');
    if (tbody) tbody.innerHTML = rowsMarkup();
  }

  function renderStaleBanner() {
    const note = `<div class="log-stale">These rows are not current: ${logEscape(state.stale)}<button class="btn btn-ghost" type="button" id="log-retry">Try again</button></div>`;
    const body = el('log-body');
    const existing = body.querySelector('.log-stale');
    if (existing) existing.outerHTML = note;
    else body.insertAdjacentHTML('afterbegin', note);
  }

  document.addEventListener('click', (e) => {
    const sortBtn = e.target.closest('.log-sort');
    if (sortBtn) {
      state.sort = state.sort === sortBtn.dataset.sort ? 'time' : sortBtn.dataset.sort;
      // The cursor shape differs per sort, and page() ignores one of the
      // wrong shape, which would quietly restart the list at page one.
      state.cursor = null;
      state.rows = [];
      renderRequests();
      return;
    }
    // "Show more" belongs to whichever tab drew it. Calling renderRequests()
    // unconditionally would send the Runs tab's {startedAt, runId} cursor
    // into logsList, which ignores a cursor of the wrong shape while
    // state.rows keeps concatenating run rows onto request rows.
    if (e.target.closest('#log-more')) {
      if (state.tab === 'runs') renderRuns();
      else renderRequests();
      return;
    }
    if (e.target.closest('#log-retry')) {
      state.stale = null;
      reload();
      return;
    }
    if (e.target.closest('#log-clear-run')) {
      state.filters.runId = '';
      reload();
      return;
    }
    if (e.target.closest('#log-export')) {
      exportCurrent();
      return;
    }
    const row = e.target.closest('.log-row');
    if (row) openDrawer(Number(row.dataset.id));
  });

  async function exportCurrent() {
    const btn = el('log-export');
    if (btn) { btn.disabled = true; btn.textContent = 'Exporting…'; }
    try {
      // Main opens the save dialog and writes the file; it always pages in
      // time order, whatever this view is sorted by.
      const out = await window.electronAPI.logsExport(queryFilters(), 'csv');
      if (btn) btn.textContent = out && out.saved ? `Exported ${out.rows}` : 'Export CSV';
    } catch (err) {
      state.stale = err && err.message ? err.message : String(err);
      renderStaleBanner();
    } finally {
      if (btn) {
        btn.disabled = false;
        setTimeout(() => { if (el('log-export')) el('log-export').textContent = 'Export CSV'; }, 2000);
      }
    }
  }

  // ---- the request drawer --------------------------------------------

  // A second drawer element, #log-drawer. key-usage.js's #ku-drawer is a
  // singleton whose ids and handlers belong to key usage; only its generic
  // .ku-drawer / .ku-scrim / .ku-panel CSS is shared. Nothing in
  // key-usage.js is touched.
  function closeDrawer() {
    el('log-drawer').hidden = true;
    document.removeEventListener('keydown', onDrawerKey);
    syncTail();
  }

  function onDrawerKey(e) {
    if (e.key === 'Escape') closeDrawer();
  }

  async function openDrawer(id) {
    const drawer = el('log-drawer');
    const body = el('log-drawer-body');
    body.innerHTML = '<p class="log-empty-detail">Loading…</p>';
    drawer.hidden = false;
    document.addEventListener('keydown', onDrawerKey);
    syncTail();
    let row;
    try {
      row = await window.electronAPI.logsGet(id);
    } catch (err) {
      body.innerHTML = emptyState('That request could not be read', logEscape(err && err.message ? err.message : String(err)));
      return;
    }
    if (!row) {
      body.innerHTML = emptyState('That request is gone', 'It was purged after the retention window passed.');
      return;
    }
    body.innerHTML = drawerMarkup(row);
    if (row.run_id) renderChain(row);
  }

  function field(label, value) {
    return `<div class="log-field"><span class="log-field-label">${label}</span><span class="log-field-value">${value}</span></div>`;
  }

  function drawerMarkup(row) {
    const vm = toViewModel(row, state.providerNames);
    const price = row.price_json ? `<h4>Price used</h4><pre class="log-code">${logEscape(row.price_json)}</pre>` : '';
    const bodies = row.body
      ? `<h4>Request</h4><pre class="log-code">${logEscape(row.body.request_body || '—')}</pre>
         <h4>Response</h4><pre class="log-code">${logEscape(row.body.response_body || '—')}</pre>
         ${row.body.truncated ? '<p class="log-empty-detail">Clipped at 8 KB.</p>' : ''}`
      : bodyMissingNote(row);
    return `
      <div class="log-detail">
        ${field('When', vm.when)}
        ${field('Outcome', `<span class="log-pill ${vm.tone}">${vm.errorClass || vm.status}</span>`)}
        ${vm.errorMessage ? field('Error', vm.errorMessage) : ''}
        ${field('Provider', vm.provider)}
        ${field('Model', vm.model)}
        ${field('Endpoint', `${logEscape(row.method)} ${logEscape(row.endpoint)}`)}
        ${field('Latency', vm.latency)}
        ${field('First token', vm.ttft)}
        ${field('Tokens in / out', `${formatTokens(row.input_tokens)} / ${formatTokens(row.output_tokens)}`)}
        ${field('Cost', vm.cost)}
        ${price}
      </div>
      <div class="log-chain" id="log-chain"></div>
      <h4>Bodies</h4>${bodies}`;
  }

  // has_body = 0 means the body was never kept, or it aged out. The row's own
  // age says which, so the reader is not left guessing.
  function bodyMissingNote(row) {
    const days = (Date.now() - row.created_at) / 86400000;
    return days > 7
      ? '<p class="log-empty-detail">The bodies for this request have passed their retention window.</p>'
      : '<p class="log-empty-detail">No bodies were kept for this request. Change what is kept in Settings.</p>';
  }

  // The attempts that belong together. attempt and hedgeIndex alone cannot
  // separate the non-stream attempt from the SSE-recovery attempt: both
  // carry attempt 1 and hedge index 0. is_stream and the endpoint can.
  //
  // No API addition is needed — the runId filter already exists and every row
  // carries meta_json.
  async function renderChain(row) {
    const host = el('log-chain');
    if (!host) return;
    let page;
    try {
      page = await window.electronAPI.logsList({ runId: row.run_id }, null, 200);
    } catch {
      return;   // the chain is a nicety; its absence must not break the drawer
    }
    const group = metaOf(row).testGroup || null;
    const siblings = page.rows.filter((r) => (metaOf(r).testGroup || null) === group);
    if (siblings.length < 2) return;
    host.innerHTML = `<h4>Attempts in this run</h4><ul class="log-chain-list">${siblings.map((r) => {
      const vm = toViewModel(r, state.providerNames);
      const kind = r.is_stream ? 'stream' : 'non-stream';
      const hedge = r.is_hedge ? ' · hedge' : '';
      const here = r.id === row.id ? ' current' : '';
      return `<li class="log-chain-item${here}" data-id="${r.id}">
        <span class="log-pill ${vm.tone}">${vm.errorClass || vm.status}</span>
        attempt ${Number(r.attempt) || 1} · ${kind}${hedge} · ${vm.latency}</li>`;
    }).join('')}</ul>`;
  }

  function metaOf(row) {
    if (!row.meta_json) return {};
    try { return JSON.parse(row.meta_json) || {}; } catch { return {}; }
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest('#log-drawer-close') || e.target.closest('#log-drawer-scrim')) {
      closeDrawer();
      return;
    }
    const chainItem = e.target.closest('.log-chain-item');
    if (chainItem && !chainItem.classList.contains('current')) openDrawer(Number(chainItem.dataset.id));
  });

  // Replaced by the live tail. It exists now because opening and closing the
  // drawer already has to tell the tail to stop and start.
  function syncTail() {}

  // ---- the runs table --------------------------------------------------

  async function renderRuns() {
    const facets = await loadFacets();
    renderFilters(facets);
    const names = {};
    facets.providers.forEach((p) => { names[normalizeProvider(p.id)] = p.name; });
    state.providerNames = names;
    let page;
    try {
      page = await window.electronAPI.logsRuns(queryFilters(), state.cursor, 50);
      state.stale = null;
    } catch (err) {
      state.stale = err && err.message ? err.message : String(err);
      renderStaleBanner();
      return;
    }
    state.rows = state.cursor ? state.rows.concat(page.rows) : page.rows;
    state.cursor = page.nextCursor;
    if (!state.rows.length) {
      el('log-body').innerHTML = emptyState('No runs in this range', 'A Route Test or a benchmark creates a run. Widen the range, or clear a filter.');
      return;
    }
    const body = state.rows.map((r) => {
      // The table shows the average latency, which is what the SQL can
      // produce; the expanded row shows the true median from the run summary.
      const attempted = r.requests - (r.cancelled || 0);
      const rate = attempted > 0 ? r.ok / attempted : null;
      return `<tr class="log-run" data-run="${logEscape(r.run_id)}">
        <td>${formatWhen(r.started_at)}</td>
        <td>${logEscape(r.source)}</td>
        <td>${r.requests}</td>
        <td>${passRateText(rate)}</td>
        <td>${r.models}</td>
        <td>${formatDuration(r.avg_latency_ms)}</td>
        <td>${formatCost(r.cost_micros)}</td>
      </tr>`;
    }).join('');
    el('log-body').innerHTML = `<div class="log-scroll"><table class="log-table">
      <thead><tr><th>Started</th><th>Source</th><th>Requests</th><th>Passed</th><th>Models</th>
      <th>Avg latency</th><th>Cost</th></tr></thead>
      <tbody>${body}</tbody></table></div>
      ${state.cursor ? '<button class="btn btn-ghost" type="button" id="log-more">Show more</button>' : ''}`;
  }

  async function expandRun(tr, runId) {
    const existing = tr.nextElementSibling;
    if (existing && existing.classList.contains('log-run-detail')) { existing.remove(); return; }
    const cells = tr.children.length;
    tr.insertAdjacentHTML('afterend', `<tr class="log-run-detail"><td colspan="${cells}">Loading…</td></tr>`);
    const host = tr.nextElementSibling.firstElementChild;
    let s;
    try {
      s = await window.electronAPI.logsRunSummary(runId);
    } catch (err) {
      host.textContent = `That run could not be read: ${err && err.message ? err.message : err}`;
      return;
    }
    const errors = Object.entries(s.errorsByClass).filter(([, n]) => n > 0)
      .map(([cls, n]) => `${logEscape(cls)} ${n}`).join(' · ') || 'none';
    host.innerHTML = `<div class="log-detail">
      ${field('Requests', `${s.count} · ${s.ok} passed · ${s.cancelled} cancelled`)}
      ${field('Pass rate', passRateText(s.passRate))}
      ${field('Median latency', formatDuration(s.medianLatencyMs))}
      ${field('Median first token', formatDuration(s.medianTtftMs))}
      ${field('Cost', formatCost(s.costMicros))}
      ${field('Models', logEscape(s.models.join(', ')) || '—')}
      ${field('Errors', errors)}
      </div>
      <button class="btn btn-ghost" type="button" data-see-requests="${logEscape(runId)}">See its requests</button>`;
  }

  document.addEventListener('click', (e) => {
    const see = e.target.closest('[data-see-requests]');
    if (see) {
      // A filter change inside the page, not a navigation.
      state.filters.runId = see.dataset.seeRequests;
      state.tab = 'requests';
      state.cursor = null;
      state.rows = [];
      if (typeof syncRoute === 'function') syncRoute();
      render();
      return;
    }
    const runRow = e.target.closest('.log-run');
    if (runRow) expandRun(runRow, runRow.dataset.run);
  });
  // ---- monitoring ------------------------------------------------------

  const MONITOR_GROUPS = {
    none: 'No grouping', source: 'By source', provider: 'By provider',
    model: 'By model', error_class: 'By error class',
  };
  const MONITOR_BUCKETS = { hour: 'By hour', day: 'By day' };
  // Grouping by model over a year costs about 1.4 s on the main thread. So a
  // grouped view offers the three short ranges only; the long ones are
  // available ungrouped, where the roll-ups collapse to one row an hour.
  const MONITOR_RANGES_GROUPED = ['24h', '7d', '30d'];
  const MONITOR_RANGES_PLAIN = ['24h', '7d', '30d', '90d', '12m'];
  const MONITOR_RANGE_LABELS = {
    '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days',
    '90d': 'Last 90 days', '12m': 'Last 12 months',
  };

  function monitorRangeKeys() {
    return state.monitor.groupBy === 'none' ? MONITOR_RANGES_PLAIN : MONITOR_RANGES_GROUPED;
  }

  function renderMonitorFilters(note) {
    const keys = monitorRangeKeys();
    const opt = (v, label, sel) => `<option value="${logEscape(v)}"${sel === v ? ' selected' : ''}>${logEscape(label)}</option>`;
    el('monitor-filters').innerHTML = `
      <select class="prompt-input narrow" id="monitor-range">
        ${keys.map((k) => opt(k, MONITOR_RANGE_LABELS[k], state.monitor.range)).join('')}
      </select>
      <select class="prompt-input narrow" id="monitor-bucket">
        ${Object.entries(MONITOR_BUCKETS).map(([k, l]) => opt(k, l, state.monitor.bucket)).join('')}
      </select>
      <select class="prompt-input narrow" id="monitor-group">
        ${Object.entries(MONITOR_GROUPS).map(([k, l]) => opt(k, l, state.monitor.groupBy)).join('')}
      </select>
      ${note ? `<span class="log-note">${note}</span>` : ''}`;
  }

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || !t.id || !el('monitor-filters') || !el('monitor-filters').contains(t)) return;
    let note = '';
    if (t.id === 'monitor-range') state.monitor.range = t.value;
    else if (t.id === 'monitor-bucket') state.monitor.bucket = t.value;
    else if (t.id === 'monitor-group') {
      state.monitor.groupBy = t.value;
      // A long range with a grouping is the slow combination; fall back and
      // say so rather than freezing the window.
      if (!monitorRangeKeys().includes(state.monitor.range)) {
        state.monitor.range = '30d';
        note = 'Grouped charts go back 30 days. Choose no grouping for longer.';
      }
    } else return;
    renderMonitor(note);
  });

  async function renderCharts(note) {
    renderMonitorFilters(note);
    const { from, to } = rangePreset(state.monitor.range);
    let stats;
    try {
      stats = await window.electronAPI.logsStats({ from, to }, state.monitor.bucket, state.monitor.groupBy);
    } catch (err) {
      el('monitor-body').innerHTML = emptyState('Monitoring could not be read', logEscape(err && err.message ? err.message : String(err)));
      return;
    }
    if (!stats.series.length) {
      el('monitor-body').innerHTML = emptyState('Nothing recorded in this range', 'Widen the range, or send a request.');
      return;
    }
    // Grouping by error class is a different series shape. stats() emits
    // { bucket, group, count } for it — no requests, no avgLatencyMs, no
    // costMicros — so the three normal charts would all flatten to zero. It
    // gets one chart of its own instead.
    el('monitor-body').innerHTML = state.monitor.groupBy === 'error_class'
      ? `${totalsMarkup(stats.totals)}
         ${chartMarkup('Errors by class', stats.series, (p) => p.count)}`
      : `${totalsMarkup(stats.totals)}
         ${chartMarkup('Requests', stats.series, (p) => p.requests)}
         ${chartMarkup('Average latency', stats.series, (p) => p.avgLatencyMs)}
         ${chartMarkup('Cost', stats.series, (p) => (p.costMicros || 0) / 1e6)}`;
  }

  function totalsMarkup(t) {
    const tile = (label, value) => `<div class="log-tile"><span class="log-tile-value">${value}</span><span class="log-tile-label">${label}</span></div>`;
    return `<div class="log-tiles">
      ${tile('Requests', formatTokens(t.requests))}
      ${tile('Passed', passRateText(Number.isFinite(t.okPct) ? t.okPct / 100 : null))}
      ${tile('Average latency', formatDuration(t.avgLatencyMs))}
      ${tile('p95 latency', formatDuration(t.p95LatencyMs))}
      ${tile('Tokens', formatTokens(t.tokens))}
      ${tile('Cost', formatCost(t.costMicros))}
    </div>`;
  }

  // Hand-drawn, on currentColor, the way key-usage.js and catalog.js already
  // draw their series. No charting dependency is added.
  function chartMarkup(title, series, pick) {
    const groups = new Map();
    series.forEach((p) => {
      const key = p.group === undefined || p.group === null ? 'all' : normalizeProvider(p.group);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push([p.bucket, Number(pick(p)) || 0]);
    });
    const all = [...groups.values()].flat();
    const max = Math.max(1, ...all.map(([, v]) => v));
    const buckets = [...new Set(all.map(([b]) => b))].sort((a, b) => (a > b ? 1 : -1));
    const x = (b) => (buckets.indexOf(b) / Math.max(1, buckets.length - 1)) * 100;
    const y = (v) => 40 - (v / max) * 38;
    const lines = [...groups.entries()].map(([, pts], i) => {
      const sorted = pts.slice().sort((a, b) => (a[0] > b[0] ? 1 : -1));
      // One point draws nothing as a polyline, so it gets a dot.
      if (sorted.length === 1) {
        return `<circle class="log-series s${i % 6}" cx="${x(sorted[0][0]).toFixed(2)}" cy="${y(sorted[0][1]).toFixed(2)}" r="1.2" fill="currentColor"/>`;
      }
      const d = sorted.map(([b, v]) => `${x(b).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
      return `<polyline class="log-series s${i % 6}" points="${d}" fill="none" stroke="currentColor" stroke-width="0.6"/>`;
    }).join('');
    const legend = groups.size > 1
      ? `<ul class="log-legend">${[...groups.keys()].map((k, i) => `<li class="log-series s${i % 6}">${k === 'unknown' ? 'Unknown provider' : logEscape(k)}</li>`).join('')}</ul>`
      : '';
    return `<section class="log-chart"><h4>${title}</h4>
      <svg viewBox="0 0 100 42" preserveAspectRatio="none" role="img" aria-label="${title}">${lines}</svg>
      <div class="log-chart-axis"><span>${bucketLabel(buckets[0])}</span><span>${bucketLabel(buckets[buckets.length - 1])}</span></div>
      ${legend}</section>`;
  }

  // A day bucket is already a local date string; an hour bucket is a time.
  function bucketLabel(b) {
    return typeof b === 'string' ? logEscape(b) : formatWhen(b);
  }

  // `tab` is what syncRoute reads to build #/history/<sub>. Without it the
  // app would append the string "undefined" to the hash.
  window.LOGS = { render, renderMonitor, tab: () => state.tab };
}());
