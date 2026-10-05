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
  const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)');
  // The element the drawer was opened from, so focus goes back where it was.
  let drawerOpener = null;
  // The pending hide of the closing drawer, so a reopen can cancel it.
  let closeTimer = null;

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

  const LOG_ICONS = {
    runs: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    requests: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
    pass: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    latency: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 14 10"/></svg>',
    cost: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  };

  function emptyState(title, detail) {
    return `<div class="log-empty log-empty-card">
      <div class="log-empty-badge">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      </div>
      <p class="log-empty-title">${title}</p>
      <p class="log-empty-detail">${detail}</p>
    </div>`;
  }

  function loggingOffMarkup() {
    const why = state.info && state.info.error ? logEscape(state.info.error) : 'Logging is turned off.';
    return emptyState('No request log', `${why} Turn request logging on in Settings to start recording.`);
  }

  function renderCrumbs() {
    const crumbsEl = el('log-crumbs');
    if (!crumbsEl || typeof breadcrumbHTML !== 'function') return;
    const items = [
      { label: 'Overview', page: 'overview' },
      { label: 'Test History', page: 'history', icon: 'history' },
      { label: state.tab === 'runs' ? 'Runs' : 'Requests' },
    ];
    if (state.filters.runId) {
      items.push({ label: `Run ${state.filters.runId.slice(0, 8)}…` });
    }
    crumbsEl.innerHTML = breadcrumbHTML(items);
  }

  function updateTabCounts() {
    const runsCountEl = el('log-count-runs');
    const reqsCountEl = el('log-count-requests');
    if (runsCountEl) {
      if (state.tab === 'runs' && state.rows) {
        runsCountEl.textContent = state.rows.length + (state.cursor ? '+' : '');
      }
    }
    if (reqsCountEl) {
      if (state.info && state.info.rows != null) {
        reqsCountEl.textContent = formatTokens(state.info.rows);
      } else if (state.tab === 'requests' && state.rows) {
        reqsCountEl.textContent = state.rows.length + (state.cursor ? '+' : '');
      }
    }
  }

  function renderStats() {
    const container = el('log-stats');
    if (!container) return;
    if (!state.info || !state.info.enabled || !state.rows || !state.rows.length) {
      container.innerHTML = '';
      return;
    }
    const isRuns = state.tab === 'runs';
    let totalCount, passRate, avgLat, costMicros;
    if (isRuns) {
      totalCount = state.rows.length;
      const totalAttempts = state.rows.reduce((sum, r) => sum + (r.requests - (r.cancelled || 0) - (r.blocked || 0)), 0);
      const totalOk = state.rows.reduce((sum, r) => sum + (r.ok || 0), 0);
      passRate = totalAttempts > 0 ? totalOk / totalAttempts : null;
      avgLat = totalAttempts > 0 ? Math.round(state.rows.reduce((sum, r) => sum + ((r.avg_latency_ms || 0) * ((r.requests - (r.cancelled || 0) - (r.blocked || 0)) || 1)), 0) / totalAttempts) : 0;
      costMicros = state.rows.reduce((sum, r) => sum + (r.cost_micros || 0), 0);
    } else {
      totalCount = state.rows.length;
      const okCount = state.rows.filter((r) => r.status === 'ok').length;
      const nonMuted = state.rows.filter((r) => r.status !== 'cancelled').length;
      passRate = nonMuted > 0 ? okCount / nonMuted : null;
      const validLats = state.rows.map((r) => r.latency_ms).filter((n) => Number.isFinite(n) && n > 0);
      avgLat = validLats.length ? Math.round(validLats.reduce((a, b) => a + b, 0) / validLats.length) : 0;
      costMicros = state.rows.reduce((sum, r) => sum + (r.cost_micros || 0), 0);
    }

    const rangeLabel = RANGE_LABELS[state.filters.range] || 'Selected range';
    if (typeof statCardsHTML === 'function') {
      container.innerHTML = statCardsHTML([
        {
          label: isRuns ? 'Total Runs' : 'Total Requests',
          value: formatTokens(totalCount),
          icon: isRuns ? LOG_ICONS.runs : LOG_ICONS.requests,
          foot: rangeLabel,
        },
        {
          label: 'Success Rate',
          value: passRateText(passRate),
          icon: LOG_ICONS.pass,
          meter: passRate,
          tone: passRate !== null && passRate >= 0.9 ? 'pass' : (passRate !== null && passRate < 0.5 ? 'fail' : null),
          foot: isRuns ? 'across tested runs' : 'successful outcomes',
        },
        {
          label: 'Average Latency',
          value: formatDuration(avgLat),
          icon: LOG_ICONS.latency,
          foot: 'mean response duration',
        },
        {
          label: 'Total Spend',
          value: formatCost(costMicros),
          icon: LOG_ICONS.cost,
          foot: 'accumulated token cost',
        },
      ]);
    }
  }

  async function render() {
    if (!state.routeRead) {
      state.tab = tabFromRoute();
      state.routeRead = true;
    }
    await loadInfo();
    renderTabs();
    renderCrumbs();
    if (!state.info.enabled) {
      el('log-filters').innerHTML = '';
      el('log-body').innerHTML = loggingOffMarkup();
      const stats = el('log-stats');
      if (stats) stats.innerHTML = '';
      syncTail();
      return;
    }
    if (state.tab === 'runs') await renderRuns();
    else await renderRequests();
    renderStats();
    updateTabCounts();
    syncTail();
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

  // Rewriting the whole bar while someone is typing in it replaces the input
  // under their cursor: the focus goes to the body and every keystroke after
  // the debounce is lost. The bar is still rebuilt on every render — putting
  // the focus and the caret back is what makes that safe.
  function renderFilters(facets, { keepFocus = true } = {}) {
    const active = document.activeElement;
    const host = el('log-filters');
    const restore = keepFocus && active && host && host.contains(active) && active.id
      ? { id: active.id, start: active.selectionStart, end: active.selectionEnd }
      : null;
    buildFilters(facets);
    if (!restore) return;
    const back = el(restore.id);
    if (!back) return;
    back.focus();
    if (restore.start !== null && restore.start !== undefined && back.setSelectionRange) {
      try { back.setSelectionRange(restore.start, restore.end); } catch { /* not a text input */ }
    }
  }

  function buildFilters(facets) {
    const opt = (v, label, sel) => `<option value="${logEscape(v)}"${String(sel) === String(v) ? ' selected' : ''}>${logEscape(label)}</option>`;
    // A run listing groups rows, so a row filter such as status would corrupt
    // its counters — query.js ignores it. Showing a control that does nothing
    // is worse than not showing it. Export writes requests, not runs.
    const runsTab = state.tab === 'runs';
    const chip = state.filters.runId
      ? `<span class="log-chip">Run ${logEscape(state.filters.runId)}<button class="log-chip-x" type="button" id="log-clear-run" aria-label="Clear the run filter">&times;</button></span>`
      : '';
    el('log-filters').innerHTML = `
      <div class="dt-toolbar log-dt-toolbar">
        <div class="dt-left">
          <label class="dt-search">
            <span class="dt-search-icon" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg></span>
            <input type="search" data-dt="search" id="log-text" placeholder="${runsTab ? 'Search run id…' : 'Search id, run or error…'}" value="${logEscape(state.filters.text)}" autocomplete="off" spellcheck="false" aria-label="Search">
            <kbd>/</kbd>
          </label>
          <div class="ui-select-wrap">
            <select class="ui-select-native" id="log-range" data-lead-icon="clock" data-ui-class="ui-select-toolbar" aria-label="Time range">
              ${Object.entries(RANGE_LABELS).map(([k, l]) => opt(k, l, state.filters.range)).join('')}
            </select>
          </div>
          <div class="ui-select-wrap">
            <select class="ui-select-native" id="log-provider" data-lead-icon="server" data-ui-class="ui-select-toolbar" aria-label="Provider">
              ${opt('', 'Every provider', state.filters.providerId[0] || '')}
              ${facets.providers.map((p) => opt(p.id, providerLabel(p.id, p.name), state.filters.providerId[0] || '')).join('')}
            </select>
          </div>
          <div class="ui-select-wrap">
            <select class="ui-select-native" id="log-model" data-lead-icon="cpu" data-ui-class="ui-select-toolbar" aria-label="Model">
              ${opt('', 'Every model', state.filters.model)}
              ${facets.models.map((m) => opt(m, m, state.filters.model)).join('')}
            </select>
          </div>
          <div class="ui-select-wrap">
            <select class="ui-select-native" id="log-source" data-lead-icon="funnel" data-ui-class="ui-select-toolbar" aria-label="Source">
              ${opt('', 'Every source', state.filters.source[0] || '')}
              ${facets.sources.map((s) => opt(s, s, state.filters.source[0] || '')).join('')}
            </select>
          </div>
          ${runsTab ? '' : `<div class="ui-select-wrap">
            <select class="ui-select-native" id="log-status" data-lead-icon="funnel" data-ui-class="ui-select-toolbar" aria-label="Outcome">
              ${opt('', 'Any outcome', state.filters.status[0] || '')}
              ${['ok', 'error', 'cancelled'].map((v) => opt(v, v, state.filters.status[0] || '')).join('')}
            </select>
          </div>`}
        </div>
        <div class="dt-right">
          ${chip}
          ${runsTab ? '' : '<button class="btn btn-ghost log-export-btn" type="button" id="log-export"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Export CSV</button>'}
        </div>
      </div>`;
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
    { label: 'Time', sort: 'time', cls: 'col-time' },
    { label: 'Source', cls: 'col-source' },
    { label: 'Provider', cls: 'col-provider' },
    { label: 'Model', cls: 'col-model' },
    { label: 'Outcome', cls: 'col-outcome' },
    { label: 'Latency', sort: 'latency', cls: 'col-latency dt-num' },
    { label: 'TTFT', sort: 'ttft', cls: 'col-ttft dt-num' },
    { label: 'Tokens', cls: 'col-tokens dt-num' },
    { label: 'Cost', sort: 'cost', cls: 'col-cost dt-num' },
  ];

  function headerCell(col) {
    const cls = col.cls ? ` class="${col.cls}"` : '';
    if (!col.sort) return `<th${cls}>${col.label}</th>`;
    const on = state.sort === col.sort;
    // A second click on a sorted column goes back to time order rather than
    // reversing: every sort is descending (query.js, SORT_COLUMNS).
    return `<th${cls}><button class="log-sort${on ? ' active' : ''}" type="button" data-sort="${col.sort}">${col.label}${on ? ' ↓' : ''}</button></th>`;
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
      renderStats();
      updateTabCounts();
      return;
    }
    el('log-body').innerHTML = `
      <section class="dt-table-wrap log-table-wrap">
        <div class="ov-panel-head log-table-head">
          <div class="log-table-title-wrap">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
            <span class="log-table-title">Logged Requests</span>
            <span class="log-table-count-pill">${state.rows.length} loaded</span>
          </div>
          <div class="log-table-head-meta">Click a request to inspect payloads &amp; headers</div>
        </div>
        <table class="dt-table log-table">
          <thead><tr>${COLUMNS.map(headerCell).join('')}</tr></thead>
          <tbody id="log-rows">${rowsMarkup()}</tbody></table>
        ${state.cursor ? '<div class="log-table-footer"><button class="btn btn-ghost" type="button" id="log-more">Show more</button></div>' : ''}
      </section>`;
    renderStats();
    updateTabCounts();
  }

  // Split out so the live tail can redraw the body alone and leave the
  // header, the filter bar and the scroll position where they are.
  function rowsMarkup() {
    return state.rows.map((row) => {
      const vm = toViewModel(row, state.providerNames);
      return `<tr class="log-row" data-id="${vm.id}">
        <td class="col-time">${vm.when}</td>
        <td class="col-source">${vm.source}</td>
        <td class="col-provider"><strong>${vm.provider}</strong></td>
        <td class="col-model">${vm.model}</td>
        <td class="col-outcome"><span class="log-pill ${vm.tone}">${vm.errorClass || vm.status}</span></td>
        <td class="col-latency dt-num">${vm.latency}</td>
        <td class="col-ttft dt-num">${vm.ttft}</td>
        <td class="col-tokens dt-num">${vm.tokens}</td>
        <td class="col-cost dt-num">${vm.cost}</td>
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
      renderRequests().then(syncTail);
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
    if (row) openDrawer(Number(row.dataset.id), row);
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
  // The shared CSS slides .ku-panel in on the `open` class and leaves it at
  // translateX(100%) without it. Clearing `hidden` alone left the panel off
  // screen behind a transparent scrim that swallowed the next click: the
  // drawer was never actually visible. key-usage.js:317 does the same two
  // steps.
  function closeDrawer() {
    const drawer = el('log-drawer');
    if (!drawer || drawer.hidden) return;
    drawer.classList.remove('open');
    const done = () => {
      closeTimer = null;
      drawer.hidden = true;
      // Only now is the drawer really closed. tailWanted() reads
      // drawer.hidden, so syncing before this point would switch the tail off
      // and leave nothing to switch it back on.
      syncTail();
    };
    if (REDUCED_MOTION.matches) done();
    else closeTimer = setTimeout(done, 200);
    document.removeEventListener('keydown', onDrawerKey);
    if (drawerOpener && document.contains(drawerOpener)) drawerOpener.focus();
    drawerOpener = null;
  }

  function onDrawerKey(e) {
    if (e.key === 'Escape') closeDrawer();
  }

  async function openDrawer(id, opener = null) {
    const drawer = el('log-drawer');
    const body = el('log-drawer-body');
    // Reopening inside the close animation: without this the pending timer
    // fires mid-load and hides the drawer that was just opened.
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    body.innerHTML = '<p class="log-empty-detail">Loading…</p>';
    if (drawer.hidden) drawerOpener = opener || document.activeElement;
    drawer.hidden = false;
    // The class has to land on a later frame than `hidden`, or the browser
    // has nothing to transition from.
    requestAnimationFrame(() => drawer.classList.add('open'));
    const close = el('log-drawer-close');
    if (close) close.focus();
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

  // ---- the live tail ---------------------------------------------------

  // Only on Requests, only in time order, only while the page is on screen
  // and the window focused. A tail is polled by afterId and never by
  // nextCursor: the cursor orders by created_at, so a request logged a
  // millisecond out of clock order would be skipped for good.
  const TAIL_MS = 2000;
  let tailTimer = null;

  function tailWanted() {
    const page = document.querySelector('.shell-page[data-page="history"]');
    const drawer = el('log-drawer');
    return !!(state.info && state.info.enabled)
      && state.tab === 'requests'
      && state.sort === 'time'
      && !state.filters.runId          // a finished run does not grow
      && !document.hidden
      && document.hasFocus()
      && !!page && !page.hidden
      && !!drawer && drawer.hidden;
  }

  function syncTail() {
    const want = tailWanted();
    if (want && !tailTimer) tailTimer = setInterval(pollTail, TAIL_MS);
    if (!want && tailTimer) {
      clearInterval(tailTimer);
      tailTimer = null;
    }
  }

  async function pollTail() {
    if (!state.rows.length) return;
    const highest = state.rows.reduce((max, r) => (r.id > max ? r.id : max), 0);
    if (!highest) return;
    let page;
    try {
      // queryFilters() is recomputed each tick, so `from` slides with the
      // clock — which is what a tail wants.
      page = await window.electronAPI.logsList({ ...queryFilters(), afterId: highest }, null, 50);
    } catch {
      return;   // a failed poll is not worth a banner; the next one may work
    }
    if (!page.rows.length) return;
    state.rows = page.rows.concat(state.rows);
    renderRequestRows();
  }

  ['visibilitychange'].forEach((ev) => document.addEventListener(ev, syncTail));
  ['focus', 'blur'].forEach((ev) => window.addEventListener(ev, syncTail));

  // ---- the runs table --------------------------------------------------

  function runsTrendChartHTML(rows) {
    if (!rows || !rows.length) return '';
    const recent = rows.slice(0, 24).reverse();
    const maxLat = Math.max(1, ...recent.map((r) => r.avg_latency_ms || 0));

    const bars = recent.map((r) => {
      const attempted = r.requests - (r.cancelled || 0) - (r.blocked || 0);
      const rate = attempted > 0 ? r.ok / attempted : null;
      const heightPct = Math.max(16, Math.min(100, Math.round(((r.avg_latency_ms || 0) / maxLat) * 100)));
      let toneClass = 'pass';
      if (rate === null || rate < 0.5) toneClass = 'fail';
      else if (rate < 0.95) toneClass = 'warn';
      const timeStr = formatWhen(r.started_at);
      const title = `${timeStr} · ${r.requests} reqs · ${passRateText(rate)} pass · ${formatDuration(r.avg_latency_ms)} · ${formatCost(r.cost_micros)}`;
      return `<div class="log-trend-bar-wrap" data-trend-run="${logEscape(r.run_id)}" title="${logEscape(title)}">
        <div class="log-trend-bar ${toneClass}" style="height: ${heightPct}%;"></div>
        <span class="log-trend-label">${timeStr.split(' ')[1] || timeStr.slice(-5)}</span>
      </div>`;
    }).join('');

    return `<div class="ov-panel log-trend-panel">
      <div class="ov-panel-head log-trend-head">
        <div class="log-trend-title">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          <span>Run Activity &amp; Latency Timeline</span>
        </div>
        <div class="log-trend-legend">
          <span class="log-trend-dot pass"></span><span>100% Passed</span>
          <span class="log-trend-dot warn"></span><span>Partial</span>
          <span class="log-trend-dot fail"></span><span>Errors</span>
        </div>
      </div>
      <div class="log-trend-body">
        <div class="log-trend-bars">
          ${bars}
        </div>
      </div>
    </div>`;
  }

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
      el('log-body').innerHTML = emptyState('No runs in this range', 'A Route Test or a health check creates a run. Widen the range, or clear a filter.');
      renderStats();
      updateTabCounts();
      return;
    }
    const body = state.rows.map((r) => {
      // The table shows the average latency, which is what the SQL can
      // produce; the expanded row shows the true median from the run summary.
      //
      // The denominator is the same `attempted` summarizeRun() uses —
      // requests minus cancelled minus blocked — so the rate here and the one
      // in the expanded row can never disagree.
      const attempted = r.requests - (r.cancelled || 0) - (r.blocked || 0);
      const rate = attempted > 0 ? r.ok / attempted : null;
      return `<tr class="log-run" data-run="${logEscape(r.run_id)}">
        <td class="col-started">${formatWhen(r.started_at)}</td>
        <td class="col-source">${logEscape(r.source)}</td>
        <td class="col-requests dt-num">${r.requests}</td>
        <td class="col-passed">${passRateText(rate)}</td>
        <td class="col-models dt-num">${r.models}</td>
        <td class="col-latency dt-num">${formatDuration(r.avg_latency_ms)}</td>
        <td class="col-cost dt-num">${formatCost(r.cost_micros)}</td>
      </tr>`;
    }).join('');
    el('log-body').innerHTML = `
      ${runsTrendChartHTML(state.rows)}
      <section class="dt-table-wrap log-table-wrap">
        <div class="ov-panel-head log-table-head">
          <div class="log-table-title-wrap">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <span class="log-table-title">Test Runs</span>
            <span class="log-table-count-pill">${state.rows.length} loaded</span>
          </div>
          <div class="log-table-head-meta">Click a run to inspect summary &amp; percentiles</div>
        </div>
        <table class="dt-table log-table">
          <thead><tr><th class="col-started">Started</th><th class="col-source">Source</th><th class="col-requests dt-num">Requests</th><th class="col-passed">Passed</th><th class="col-models dt-num">Models</th>
          <th class="col-latency dt-num">Avg latency</th><th class="col-cost dt-num">Cost</th></tr></thead>
          <tbody>${body}</tbody></table>
        ${state.cursor ? '<div class="log-table-footer"><button class="btn btn-ghost" type="button" id="log-more">Show more</button></div>' : ''}
      </section>`;
    renderStats();
    updateTabCounts();
  }

  async function expandRun(tr, runId) {
    // runs() clips its counters to the range; runSummary() reads the whole
    // run. When the two differ the reader is told, rather than left to
    // wonder which number is wrong.
    const listed = state.rows.find((r) => r.run_id === runId);
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
    const clipped = !!listed && listed.requests !== s.count;
    const errors = Object.entries(s.errorsByClass).filter(([, n]) => n > 0)
      .map(([cls, n]) => `${logEscape(cls)} ${n}`).join(' · ') || 'none';
    const rateText = passRateText(s.passRate);
    const ratePct = s.passRate != null ? Math.round(s.passRate * 100) : 0;

    host.innerHTML = `
      <div class="log-run-card">
        <div class="log-run-card-header">
          <div class="log-run-card-title">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <span>Run Summary: <code>${logEscape(runId)}</code></span>
          </div>
          <button class="btn btn-accent btn-sm log-run-action" type="button" data-see-requests="${logEscape(runId)}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
            See its requests
          </button>
        </div>
        <div class="log-run-kpis">
          <div class="log-run-kpi">
            <span class="log-run-kpi-label">Requests</span>
            <span class="log-run-kpi-val">${s.count}</span>
            <span class="log-run-kpi-sub">${s.ok} passed · ${s.cancelled} cancelled</span>
          </div>
          <div class="log-run-kpi">
            <span class="log-run-kpi-label">Pass rate</span>
            <span class="log-run-kpi-val ${s.passRate >= 0.9 ? 'tone-pass' : (s.passRate < 0.5 ? 'tone-fail' : '')}">${rateText}</span>
            <div class="log-run-progress"><div class="log-run-progress-bar" style="width: ${ratePct}%;"></div></div>
          </div>
          <div class="log-run-kpi">
            <span class="log-run-kpi-label">Median latency</span>
            <span class="log-run-kpi-val">${formatDuration(s.medianLatencyMs)}</span>
            <span class="log-run-kpi-sub">50th percentile</span>
          </div>
          <div class="log-run-kpi">
            <span class="log-run-kpi-label">Median first token</span>
            <span class="log-run-kpi-val">${formatDuration(s.medianTtftMs)}</span>
            <span class="log-run-kpi-sub">TTFT response</span>
          </div>
          <div class="log-run-kpi">
            <span class="log-run-kpi-label">Cost</span>
            <span class="log-run-kpi-val">${formatCost(s.costMicros)}</span>
            <span class="log-run-kpi-sub">Run spend</span>
          </div>
        </div>
        ${clipped ? '<div class="log-run-clipped"><span class="log-note">The row above counts the whole run; the table counts only the part inside the chosen range.</span></div>' : ''}
        <div class="log-run-meta-grid">
          <div class="log-run-meta-item">
            <span class="log-run-meta-key">Models</span>
            <span class="log-run-meta-value">${logEscape(s.models.join(', ')) || '—'}</span>
          </div>
          <div class="log-run-meta-item">
            <span class="log-run-meta-key">Errors</span>
            <span class="log-run-meta-value">${errors}</span>
          </div>
        </div>
      </div>
    `;
  }

  document.addEventListener('click', (e) => {
    const trendBar = e.target.closest('[data-trend-run]');
    if (trendBar) {
      const runId = trendBar.dataset.trendRun;
      const targetRow = document.querySelector(`.log-run[data-run="${runId}"]`);
      if (targetRow) {
        targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
        targetRow.click();
      }
      return;
    }
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
    const crumbs = typeof breadcrumbHTML === 'function' ? breadcrumbHTML([
      { label: 'Overview', page: 'overview' },
      { label: 'Monitoring', icon: 'monitor' },
    ]) : '';
    const crumbsEl = document.getElementById('monitor-crumbs');
    if (crumbsEl) crumbsEl.innerHTML = crumbs;
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
    if (t.id === 'monitor-range') {
      state.monitor.range = t.value;
      // The mirror of the bucket guard below: a day bucket over 24 hours is
      // one point either way round.
      if (t.value === '24h' && state.monitor.bucket === 'day') {
        state.monitor.bucket = 'hour';
        note = 'Switched to hourly: a day has one point over 24 hours.';
      }
    }
    else if (t.id === 'monitor-bucket') {
      state.monitor.bucket = t.value;
      // A day bucket over 24 hours is one point, which reads as broken.
      if (t.value === 'day' && state.monitor.range === '24h') {
        state.monitor.range = '30d';
        note = 'Daily charts start at 30 days.';
      }
    }
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
         ${requestsChart(stats.series)}
         ${latencyChart(stats.series)}
         ${chartMarkup('Cost', stats.series, (p) => (p.costMicros || 0) / 1e6)}`;
  }

  // The spec asks for requests split into what worked and what did not, and
  // for latency beside its approximate p95. Both are two series over the same
  // buckets, so they are built by pairing the one series chartMarkup draws.
  function pairSeries(series, aPick, bPick, aName, bName) {
    return series.flatMap((p) => ([
      { bucket: p.bucket, group: aName, value: aPick(p) },
      { bucket: p.bucket, group: bName, value: bPick(p) },
    ]));
  }

  function requestsChart(series) {
    // A grouped range already uses `group` for the grouping, so the split is
    // only drawn when nothing else is grouped.
    if (state.monitor.groupBy !== 'none') return chartMarkup('Requests', series, (p) => p.requests);
    const paired = pairSeries(series,
      (p) => p.ok || 0,
      (p) => Math.max(0, (p.requests || 0) - (p.ok || 0) - (p.cancelled || 0) - (p.blocked || 0)),
      'passed', 'failed');
    return chartMarkup('Requests', paired, (p) => p.value);
  }

  function latencyChart(series) {
    if (state.monitor.groupBy !== 'none') return chartMarkup('Average latency', series, (p) => p.avgLatencyMs);
    const paired = pairSeries(series, (p) => p.avgLatencyMs || 0, (p) => p.p95LatencyMs || 0, 'average', 'p95');
    return chartMarkup('Latency', paired, (p) => p.value);
  }

  function totalsMarkup(t) {
    const passFrac = Number.isFinite(t.okPct) ? t.okPct / 100 : null;
    if (typeof statCardsHTML === 'function') {
      return statCardsHTML([
        {
          label: 'Requests',
          value: formatTokens(t.requests),
          icon: LOG_ICONS.requests,
          foot: 'total recorded',
        },
        {
          label: 'Passed',
          value: passRateText(passFrac),
          meter: passFrac,
          tone: passFrac !== null && passFrac >= 0.9 ? 'pass' : (passFrac !== null && passFrac < 0.5 ? 'fail' : null),
          icon: LOG_ICONS.pass,
          foot: 'success rate',
        },
        {
          label: 'Average latency',
          value: formatDuration(t.avgLatencyMs),
          icon: LOG_ICONS.latency,
          foot: 'mean response time',
        },
        {
          label: 'p95 latency',
          value: formatDuration(t.p95LatencyMs),
          icon: LOG_ICONS.latency,
          foot: '95th percentile',
        },
        {
          label: 'Tokens',
          value: formatTokens((t.inputTokens || 0) + (t.outputTokens || 0)),
          icon: LOG_ICONS.runs,
          foot: 'input + output',
        },
        {
          label: 'Cost',
          value: formatCost(t.costMicros),
          icon: LOG_ICONS.cost,
          foot: 'total spend',
        },
      ]);
    }
    const tile = (label, value, foot) => `<div class="ov-kpi">
      <span class="ov-kpi-label">${label}</span>
      <span class="ov-kpi-value">${value}</span>
      ${foot ? `<span class="ov-kpi-foot">${foot}</span>` : ''}
    </div>`;
    return `<div class="ov-kpis">
      ${tile('Requests', formatTokens(t.requests), 'total recorded')}
      ${tile('Passed', passRateText(passFrac), 'success rate')}
      ${tile('Average latency', formatDuration(t.avgLatencyMs), 'mean response time')}
      ${tile('p95 latency', formatDuration(t.p95LatencyMs), '95th percentile')}
      ${tile('Tokens', formatTokens((t.inputTokens || 0) + (t.outputTokens || 0)), 'input + output')}
      ${tile('Cost', formatCost(t.costMicros), 'total spend')}
    </div>`;
  }

  // Hand-drawn, on currentColor, the way key-usage.js and catalog.js already
  // draw their series. No charting dependency is added.
  function chartMarkup(title, series, pick) {
    const groups = new Map();
    // normalizeProvider only means anything when the grouping IS the
    // provider; a model id of '' is not an unknown provider.
    const byProvider = state.monitor.groupBy === 'provider';
    series.forEach((p) => {
      let key;
      if (p.group === undefined || p.group === null) key = 'all';
      else if (byProvider) key = normalizeProvider(p.group);
      else key = p.group === '' ? 'unknown' : p.group;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push([p.bucket, Number(pick(p)) || 0]);
    });
    const all = [...groups.values()].flat();
    const max = Math.max(1, ...all.map(([, v]) => v));
    const buckets = [...new Set(all.map(([b]) => b))].sort((a, b) => (a > b ? 1 : -1));
    // A Map, not indexOf: a 12-month hourly range is ~8760 buckets, and one
    // linear scan per point is 38 million comparisons on the main thread.
    const at = new Map(buckets.map((b, i) => [b, i]));
    const x = (b) => (at.get(b) / Math.max(1, buckets.length - 1)) * 680 + 10;
    const y = (v) => 108 - (v / max) * 94;

    const defs = `
      <defs>
        ${[...groups.keys()].map((_, i) => `
          <linearGradient id="chart-grad-${i}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--chart-series-${i % 6})" stop-opacity="0.30" />
            <stop offset="80%" stop-color="var(--chart-series-${i % 6})" stop-opacity="0.04" />
            <stop offset="100%" stop-color="var(--chart-series-${i % 6})" stop-opacity="0.00" />
          </linearGradient>
        `).join('')}
      </defs>
    `;

    const gridLines = `
      <line class="log-grid-line" x1="0" y1="14" x2="700" y2="14" stroke="currentColor" stroke-dasharray="4,4" stroke-width="0.8" opacity="0.14" />
      <line class="log-grid-line" x1="0" y1="61" x2="700" y2="61" stroke="currentColor" stroke-dasharray="4,4" stroke-width="0.8" opacity="0.14" />
      <line class="log-grid-line" x1="0" y1="108" x2="700" y2="108" stroke="currentColor" stroke-width="1" opacity="0.25" />
    `;

    const areas = [...groups.entries()].map(([, pts], i) => {
      const sorted = pts.slice().sort((a, b) => (a[0] > b[0] ? 1 : -1));
      if (sorted.length < 2) return '';
      const firstX = x(sorted[0][0]).toFixed(1);
      const lastX = x(sorted[sorted.length - 1][0]).toFixed(1);
      const linePts = sorted.map(([b, v]) => `${x(b).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
      const polyPts = `${linePts} ${lastX},108 ${firstX},108`;
      return `<polygon class="log-series-area" points="${polyPts}" fill="url(#chart-grad-${i})" />`;
    }).join('');

    const lines = [...groups.entries()].map(([, pts], i) => {
      const sorted = pts.slice().sort((a, b) => (a[0] > b[0] ? 1 : -1));
      // One point draws nothing as a polyline, so it gets a dot.
      if (sorted.length === 1) {
        return `<circle class="log-series s${i % 6}" cx="${x(sorted[0][0]).toFixed(1)}" cy="${y(sorted[0][1]).toFixed(1)}" r="4.5" fill="currentColor"/>`;
      }
      const d = sorted.map(([b, v]) => `${x(b).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
      return `<polyline class="log-series s${i % 6}" points="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
    }).join('');

    // A single series still gets a legend when it is the unknown group: a
    // chart of nothing but unlabelled traffic is the case Review Focus 5 is
    // about.
    const keys = [...groups.keys()];
    const label = (k) => (k === 'unknown' ? (byProvider ? 'Unknown provider' : 'Unknown') : logEscape(k));
    const legend = keys.length > 1 || keys[0] === 'unknown'
      ? `<ul class="log-legend">${keys.map((k, i) => `<li class="log-series s${i % 6}"><span class="log-legend-dot s${i % 6}"></span><span>${label(k)}</span></li>`).join('')}</ul>`
      : '';

    let chartIcon = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>';
    if (title.toLowerCase().includes('latency')) {
      chartIcon = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 14 10"/></svg>';
    } else if (title.toLowerCase().includes('cost')) {
      chartIcon = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>';
    } else if (title.toLowerCase().includes('error')) {
      chartIcon = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
    }

    return `<section class="ov-panel log-chart-panel">
      <div class="ov-panel-head log-chart-head">
        <div class="log-chart-head-info">
          <span class="log-chart-icon">${chartIcon}</span>
          <span class="log-chart-title">${title}</span>
        </div>
        <div class="log-chart-peak"><span class="log-peak-label">Peak</span> <span class="log-peak-value">${formatTokens(max)}</span></div>
      </div>
      <div class="log-chart-canvas-wrap">
        <svg viewBox="0 0 700 120" preserveAspectRatio="none" role="img" aria-label="${title}" class="log-chart-svg">
          ${defs}
          ${gridLines}
          ${areas}
          ${lines}
        </svg>
        <div class="log-chart-axis">
          <span>${bucketLabel(buckets[0])}</span>
          <span>${bucketLabel(buckets[buckets.length - 1])}</span>
        </div>
        ${legend}
      </div>
    </section>`;
  }

  // A day bucket is already a local date string; an hour bucket is a time.
  function bucketLabel(b) {
    return typeof b === 'string' ? logEscape(b) : formatWhen(b);
  }

  // ---- Settings: log health and clearing -------------------------------

  function formatBytes(n) {
    if (!Number.isFinite(n)) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  // Called when the Logs settings section opens. With logging off it says so
  // rather than showing zeroes, which would read as "empty" instead of "not
  // running".
  async function renderHealth() {
    const pathEl = el('logs-db-path');
    const host = el('logs-db-health');
    if (!host) return;
    let info;
    try {
      info = await window.electronAPI.logsInfo();
    } catch (err) {
      host.innerHTML = `<span class="log-health-item">Could not be read: ${logEscape(err && err.message ? err.message : String(err))}</span>`;
      return;
    }
    if (pathEl) pathEl.textContent = info.path || '—';
    const clearBtn = el('btn-clear-logs-db');
    if (!info.enabled) {
      if (clearBtn) clearBtn.disabled = true;
      host.innerHTML = `<span class="log-health-item">Logging is off${info.error ? `: ${logEscape(info.error)}` : '.'}</span>`;
      return;
    }
    if (clearBtn) clearBtn.disabled = false;
    const item = (label, value) => `<span class="log-health-item"><b>${value}</b> ${label}</span>`;
    host.innerHTML = [
      item('requests', formatTokens(info.rows)),
      item('on disk', formatBytes(info.sizeBytes)),
      info.oldestAt ? item('oldest', formatWhen(info.oldestAt)) : '',
      info.droppedRows ? item('dropped', formatTokens(info.droppedRows)) : '',
      info.lastPurgeAt ? item('last purge', formatWhen(info.lastPurgeAt)) : '',
    ].filter(Boolean).join('');
  }

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('#btn-clear-logs-db');
    if (!btn) return;
    let info = null;
    try { info = await window.electronAPI.logsInfo(); } catch { /* the confirm still asks */ }
    const many = info && Number.isFinite(info.rows) ? formatTokens(info.rows) : 'every';
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete ${many} recorded requests, their bodies and their summaries? This cannot be undone.`)) return;
    const label = btn.textContent;
    btn.disabled = true;
    // The call walks the table in chunks and vacuums afterwards, which takes
    // seconds on a large database. Saying nothing would read as a dead button.
    btn.textContent = 'Clearing…';
    try {
      await window.electronAPI.logsClear({});
    } catch (err) {
      btn.textContent = `Failed: ${err && err.message ? err.message : err}`;
      setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 4000);
      return;
    }
    btn.textContent = label;
    btn.disabled = false;
    await renderHealth();
    // Whatever the log pages are showing is now gone.
    state.cursor = null;
    state.rows = [];
  });

  document.addEventListener('click', async (e) => {
    const refreshBtn = e.target.closest('#log-refresh');
    if (!refreshBtn) return;
    refreshBtn.classList.add('spinning');
    state.facets = null;
    state.facetsRange = null;
    state.cursor = null;
    state.rows = [];
    try {
      await loadInfo();
      await render();
    } finally {
      setTimeout(() => refreshBtn.classList.remove('spinning'), 500);
    }
  });

  // `tab` is what syncRoute reads to build #/history/<sub>. Without it the
  // app would append the string "undefined" to the hash. `health` is called
  // by app.js when the Logs settings section opens.
  window.LOGS = { render, renderMonitor, tab: () => state.tab, health: renderHealth, sync: syncTail };
}());
