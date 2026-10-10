// ============================================
// Model activity — the notification center
// ============================================
// Roster arrivals and departures, written by the catalog ingest flow into
// roster_events. Two faces share one query: the header bell (unread count +
// recent panel) and the Model Activity page (filterable history with times).
//
// Everything provider- or model-sourced is escaped before it reaches innerHTML
// (provider names are owner-editable). Timestamps render relative with the
// absolute time in the tooltip.
(function () {
  'use strict';

  const PAGE_LIMIT = 100;
  const PAGE_STEP = 100;
  const PANEL_LIMIT = 15;

  // The shared data toolbar owns search, chips and the provider select (see
  // dataToolbarHTML/bindDataToolbar in app.js): the toolbar is built once and
  // keystrokes re-render the results, never the toolbar.
  const acState = { search: '', filter: 'all', provider: 'all', limit: PAGE_LIMIT };
  let acShell = false;
  const AC_TOOLBAR = {
    placeholder: 'Search models or providers…',
    filters: [
      { value: 'all', label: 'All changes' },
      { value: 'added', label: 'Added', dot: 'var(--pass)' },
      { value: 'removed', label: 'Removed', dot: 'var(--fail)' },
    ],
    selects: [{ key: 'provider', icon: 'server', label: 'Providers', options: [{ value: 'all', label: 'All providers' }] }],
  };

  const providerName = (pid) => {
    const p = (typeof PROVIDERS !== 'undefined' && PROVIDERS) ? PROVIDERS[pid] : null;
    return (p && p.name) || String(pid || '');
  };

  const whenText = (at) => {
    if (!Number.isFinite(Number(at))) return '';
    const n = Number(at);
    const rel = (typeof formatAgo === 'function') ? formatAgo(n) : '';
    return { rel, abs: new Date(n).toLocaleString() };
  };

  function itemHTML(ev, compact) {
    const added = ev.kind === 'added';
    const dot = added
      ? '<span class="status-dot-badge pass" title="Added">✓</span>'
      : '<span class="status-dot-badge fail" title="Removed">✕</span>';
    const verb = added ? 'added model' : 'removed model';
    const when = whenText(ev.at);
    const unread = !ev.is_read ? '<span class="ntf-dot" title="Unread"></span>' : '';
    const label = `${providerName(ev.provider_id)} ${verb} ${ev.name || ev.model_id}`;
    return `<div class="ntf-item${compact ? ' compact' : ''}" data-ac-provider="${escapeHtml(ev.provider_id)}"
        role="button" tabindex="0" title="${escapeHtml(label)}${when.abs ? ` — ${escapeHtml(when.abs)}` : ''}">
      ${dot}
      <div class="ntf-text">
        <div class="ntf-line">${escapeHtml(providerName(ev.provider_id))} ${added ? 'added' : 'removed'} model
          <b>${escapeHtml(ev.name || ev.model_id)}</b></div>
        <div class="ntf-time">${escapeHtml(when.rel || when.abs)}</div>
      </div>
      ${unread}
    </div>`;
  }

  async function query(opts) {
    if (!window.electronAPI || typeof window.electronAPI.catalogEvents !== 'function') {
      return { rows: [], unread: 0, counts: null, totals: null };
    }
    try {
      const reply = await window.electronAPI.catalogEvents(opts || {});
      if (reply && reply.ok === false) return { rows: [], unread: 0, counts: null, totals: null };
      return { rows: (reply && reply.rows) || [], unread: (reply && reply.unread) || 0,
        counts: (reply && reply.counts) || null, totals: (reply && reply.totals) || null };
    } catch (_) {
      return { rows: [], unread: 0, counts: null, totals: null };
    }
  }

  // ---- bell ---------------------------------------------------------------

  async function refreshBell() {
    const badge = document.getElementById('notif-badge');
    const button = document.getElementById('btn-notifications');
    if (!badge || !button) return;
    const { unread } = await query({ limit: 1 });
    badge.hidden = !(unread > 0);
    badge.textContent = unread > 99 ? '99+' : String(unread);
    button.setAttribute('aria-label', unread > 0 ? `${unread} unread notifications` : 'Notifications');
  }

  function setPanel(open) {
    const pop = document.getElementById('notif-pop');
    const button = document.getElementById('btn-notifications');
    if (!pop || !button) return;
    pop.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    // One header popup at a time: opening this one closes the others, whose
    // own outside-click closers never fire through a stopped toggle click.
    if (open) closeOtherHeaderPops();
    if (open) renderPanel();
  }

  // Direct DOM contract (hidden + aria-expanded), shared with profile.js and
  // the accent toggle, which do the same for this popup. No cross-file calls:
  // profile.js must keep working before app.js loads.
  function closeOtherHeaderPops() {
    const pairs = [['profile-pop', 'btn-profile'], ['accent-pop', 'btn-accent']];
    for (const [popId, btnId] of pairs) {
      const other = document.getElementById(popId);
      if (other && !other.hidden) {
        other.hidden = true;
        const btn = document.getElementById(btnId);
        if (btn) btn.setAttribute('aria-expanded', 'false');
      }
    }
  }

  const isPanelOpen = () => {
    const pop = document.getElementById('notif-pop');
    return !!pop && !pop.hidden;
  };

  async function renderPanel() {
    const list = document.getElementById('notif-list');
    if (!list) return;
    const { rows } = await query({ limit: PANEL_LIMIT });
    list.innerHTML = rows.length
      ? rows.map((e) => itemHTML(e, true)).join('')
      : '<div class="ntf-empty">No model changes recorded yet.</div>';
  }

  async function markAllRead() {
    try {
      if (window.electronAPI && typeof window.electronAPI.catalogEventsRead === 'function') {
        await window.electronAPI.catalogEventsRead({ all: true, before: Date.now() });
      }
    } catch (_) { /* the badge refresh below says what stuck */ }
    await refreshBell();
    if (isPanelOpen()) renderPanel();
    renderIfShown();
  }

  // ---- page -----------------------------------------------------------------
  // Same skeleton as every data page: crumbs bar, stat cards, shared toolbar,
  // results. The shell (toolbar + bindings) is built once; renders refresh
  // the provider options, the cards, the chip counts and the rows.

  function providerOptions() {
    const connected = (typeof PROVIDERS !== 'undefined' && PROVIDERS)
      ? Object.values(PROVIDERS).filter((p) => {
        try {
          return (typeof isConnected === 'function') ? isConnected(p) : true;
        } catch (_) {
          return true;
        }
      }).sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)))
      : [];
    return [{ value: 'all', label: 'All providers' }]
      .concat(connected.map((p) => ({ value: p.id, label: p.name || p.id })));
  }

  function buildShell() {
    const crumbs = document.getElementById('ac-crumbs');
    if (crumbs) {
      crumbs.innerHTML = typeof breadcrumbHTML === 'function'
        ? breadcrumbHTML([{ label: 'Overview', page: 'overview' }, { label: 'Model Activity' }])
        : '<span class="crumb" aria-current="page">Model Activity</span>';
    }
    const body = document.getElementById('ac-body');
    if (!body) return false;
    body.innerHTML = '<div id="ac-kpis"></div>'
      + `<div id="ac-toolbar">${typeof dataToolbarHTML === 'function' ? dataToolbarHTML(AC_TOOLBAR, acState) : ''}</div>`
      + '<div id="ac-results"></div>';
    const bar = document.getElementById('ac-toolbar');
    if (bar && typeof bindDataToolbar === 'function') {
      bindDataToolbar(bar, acState, (key) => {
        if (key !== 'search') acState.limit = PAGE_LIMIT;
        renderResults();
      });
    }
    acShell = true;
    return true;
  }

  function refreshProviderOptions() {
    const sel = document.querySelector('#ac-toolbar [data-dt-select="provider"]');
    if (!sel) return;
    const opts = providerOptions();
    sel.innerHTML = opts.map((o) => `<option value="${escapeHtml(o.value)}"${acState.provider === o.value ? ' selected' : ''}>`
      + `${escapeHtml(o.label)}</option>`).join('');
    if (!opts.some((o) => o.value === acState.provider)) acState.provider = 'all';
    sel.value = acState.provider;
    if (sel._uiTrigger) {
      const valEl = sel._uiTrigger.querySelector('.ui-select-value');
      if (valEl) valEl.textContent = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : 'All providers';
    }
  }

  function renderKpis(totals, unread) {
    const el = document.getElementById('ac-kpis');
    if (!el || typeof statCardsHTML === 'undefined') return;
    const t = totals || { added: 0, removed: 0, total: 0 };
    el.innerHTML = statCardsHTML([
      { label: 'Total changes', value: t.total, icon: KPI_ICON.layers, foot: 'arrivals and departures recorded' },
      { label: 'Added', value: t.added, icon: KPI_ICON.check, foot: 'models providers listed' },
      { label: 'Removed', value: t.removed, icon: KPI_ICON.cross, foot: 'models providers dropped' },
      { label: 'Unread', value: unread || 0, icon: KPI_ICON.clock, foot: unread ? 'awaiting review' : 'all caught up' },
    ]);
  }

  function renderChipCounts(counts) {
    const c = counts || { added: 0, removed: 0, total: 0 };
    document.querySelectorAll('#ac-toolbar [data-dt-count]').forEach((el) => {
      const k = el.dataset.dtCount;
      el.textContent = k === 'all' ? c.total : (c[k] ?? 0);
    });
  }

  async function renderResults() {
    const results = document.getElementById('ac-results');
    if (!results) return;
    refreshProviderOptions();
    // One more than shown: a full answer means older rows may exist.
    const reply = await query({
      providerId: acState.provider !== 'all' ? acState.provider : null,
      kind: acState.filter !== 'all' ? acState.filter : null,
      search: acState.search || null,
      limit: acState.limit + 1,
    });
    const rows = reply.rows || [];
    renderKpis(reply.totals, reply.unread);
    renderChipCounts(reply.counts);
    const hasMore = rows.length > acState.limit;
    const shown = rows.slice(0, acState.limit);
    if (!shown.length) {
      const empty = (reply.totals && reply.totals.total)
        ? ['No changes match these filters.', 'Try a different provider, change type or search.']
        : ['No model changes recorded yet.', 'Arrivals and departures appear here as providers add or remove models.'];
      results.innerHTML = `<div class="pv-empty"><h3>${empty[0]}</h3><p>${empty[1]}</p></div>`;
      return;
    }
    results.innerHTML = `<div class="ac-list" role="list" aria-label="Model changes">`
      + shown.map((e) => itemHTML(e, false)).join('') + '</div>'
      + (hasMore ? '<div class="ac-more"><button class="btn btn-ghost" id="ac-more" type="button">Show more</button></div>' : '');
    const more = document.getElementById('ac-more');
    if (more) more.addEventListener('click', () => { acState.limit += PAGE_STEP; renderResults(); });
  }

  async function render() {
    if (!acShell && !buildShell()) return;
    const bar = document.getElementById('ac-toolbar');
    if (bar && typeof syncDataToolbar === 'function') syncDataToolbar(bar, acState, AC_TOOLBAR);
    await renderResults();
  }

  function renderIfShown() {
    try {
      if (typeof currentPage !== 'undefined' && currentPage === 'activity') render();
    } catch (_) { /* a page that is gone needs nothing */ }
  }

  // ---- wiring -----------------------------------------------------------------

  function init() {
    const button = document.getElementById('btn-notifications');
    const pop = document.getElementById('notif-pop');
    if (button && pop) {
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = pop.hidden;
        setPanel(open);
      });
      pop.addEventListener('click', (e) => e.stopPropagation());
      document.addEventListener('click', (e) => {
        if (!pop.hidden && !e.target.closest('.hdr-notif-wrap')) setPanel(false);
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !pop.hidden) {
          setPanel(false);
          button.focus();
        }
      });
      const mark = document.getElementById('notif-mark-read');
      if (mark) mark.addEventListener('click', markAllRead);
      const all = document.getElementById('notif-view-all');
      if (all) all.addEventListener('click', () => {
        setPanel(false);
        if (typeof showPage === 'function') showPage('activity');
      });
      pop.addEventListener('click', (e) => {
        const item = e.target.closest('[data-ac-provider]');
        if (!item) return;
        const pid = item.dataset.acProvider;
        setPanel(false);
        if (pid && typeof openProviderPage === 'function') openProviderPage(pid);
      });
    }

    const body = document.getElementById('ac-body');
    if (body) {
      body.addEventListener('click', (e) => {
        const item = e.target.closest('[data-ac-provider]');
        if (!item || !item.dataset.acProvider || typeof openProviderPage !== 'function') return;
        openProviderPage(item.dataset.acProvider);
      });
      body.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('[data-ac-provider]')) {
          e.preventDefault();
          const pid = e.target.closest('[data-ac-provider]').dataset.acProvider;
          if (pid && typeof openProviderPage === 'function') openProviderPage(pid);
        }
      });
    }
    const crumbs = document.getElementById('ac-crumbs');
    if (crumbs) crumbs.addEventListener('click', (e) => {
      const go = e.target.closest('[data-ac-go]');
      if (go && typeof showPage === 'function') showPage(go.dataset.acGo);
    });

    refreshBell();
  }

  window.ACTIVITY = { init, render, renderIfShown, refreshBell };
})();
