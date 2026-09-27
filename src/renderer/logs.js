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
    state.info = await window.api.logsInfo();
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

  // Replaced in the tasks that follow.
  async function renderRuns() { el('log-body').innerHTML = emptyState('Runs', 'Coming in the next task.'); }
  async function renderRequests() { el('log-body').innerHTML = emptyState('Requests', 'Coming in the next task.'); }
  async function renderCharts() { el('monitor-body').innerHTML = emptyState('Monitoring', 'Coming in the next task.'); }

  // `tab` is what syncRoute reads to build #/history/<sub>. Without it the
  // app would append the string "undefined" to the hash.
  window.LOGS = { render, renderMonitor, tab: () => state.tab };
}());
