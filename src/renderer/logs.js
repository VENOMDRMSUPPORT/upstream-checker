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

  async function renderMonitor() {
    await loadInfo();
    if (!state.info.enabled) {
      el('monitor-filters').innerHTML = '';
      el('monitor-body').innerHTML = loggingOffMarkup();
      return;
    }
    await renderCharts();
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

  // Replaced in the task that adds the drawer. It exists now because the
  // row-click handler above is live the moment this task is committed, and a
  // bare call would throw on the first click.
  function openDrawer() {}

  // Replaced in the tasks that follow.
  async function renderRuns() { el('log-body').innerHTML = emptyState('Runs', 'Coming in the next task.'); }
  async function renderCharts() { el('monitor-body').innerHTML = emptyState('Monitoring', 'Coming in the next task.'); }

  // `tab` is what syncRoute reads to build #/history/<sub>. Without it the
  // app would append the string "undefined" to the hash.
  window.LOGS = { render, renderMonitor, tab: () => state.tab };
}());
