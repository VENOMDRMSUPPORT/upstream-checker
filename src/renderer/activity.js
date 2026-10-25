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

  const compactLayout = (typeof COMPACT_LAYOUT !== 'undefined')
    ? COMPACT_LAYOUT
    : (typeof window !== 'undefined' && typeof window.matchMedia === 'function')
      ? window.matchMedia('(max-width: 1100px)')
      : { matches: false, addEventListener() {} };

  const isCompact = () => Boolean(compactLayout && compactLayout.matches);

  // The shared data toolbar owns search, chips and the provider select.
  // View mode (table / cards) switches automatically based on screen width.
  const acState = {
    search: '',
    filter: 'all',
    provider: 'all',
    limit: PAGE_LIMIT,
  };
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

  const AC_ICON = {
    plus: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    minus: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M5 12h14"/></svg>',
    copy: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    clock: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    check: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  };

  const getProvider = (pid) => {
    return (typeof PROVIDERS !== 'undefined' && PROVIDERS) ? PROVIDERS[pid] : null;
  };

  const providerName = (pid) => {
    const p = getProvider(pid);
    return (p && p.name) || String(pid || '');
  };

  const safeProviderMark = (p) => {
    if (typeof providerMark === 'function' && p) return providerMark(p);
    if (p && p.logo) return `<img src="${escapeHtml(p.logo)}" alt="">`;
    return `<span class="pv-dot" style="background:${escapeHtml((p && p.color) || 'var(--accent)')}"></span>`;
  };

  const getCatalogEntry = (pid, mid) => {
    try {
      if (window.CATALOG && window.CATALOG.state && window.CATALOG.state.models) {
        return window.CATALOG.state.models.get(`${pid}::${mid}`) || null;
      }
    } catch (_) {}
    return null;
  };

  const fmtTokens = (n) => {
    if (!Number.isFinite(Number(n))) return '';
    const num = Number(n);
    if (num >= 1e6) return `${(num / 1e6).toFixed(num >= 1e7 ? 0 : 1)}M`.replace(/\.0M$/, 'M');
    if (num >= 1e3) return `${Math.round(num / 1e3)}k`;
    return String(num);
  };

  const whenText = (at) => {
    if (!Number.isFinite(Number(at))) return { rel: '', abs: '' };
    const n = Number(at);
    const rel = (typeof formatAgo === 'function') ? formatAgo(n) : '';
    const abs = new Date(n).toLocaleString();
    return { rel, abs };
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
    const p = getProvider(ev.provider_id);
    const logoMark = p ? safeProviderMark(p) : '';
    return `<div class="ntf-item${compact ? ' compact' : ''}" data-ac-provider="${escapeHtml(ev.provider_id)}"
        role="button" tabindex="0" title="${escapeHtml(label)}${when.abs ? ` — ${escapeHtml(when.abs)}` : ''}">
      ${logoMark ? `<span class="pv-logo ntf-logo">${logoMark}</span>` : dot}
      <div class="ntf-text">
        <div class="ntf-line">${escapeHtml(providerName(ev.provider_id))} ${added ? 'added' : 'removed'} model
          <b>${escapeHtml(ev.name || ev.model_id)}</b>${window.PROFILE_BADGES && typeof window.PROFILE_BADGES.badgeFor === 'function' ? window.PROFILE_BADGES.badgeFor(ev.provider_id, ev.name, ev.model_id) : ''}</div>
        <div class="ntf-time">${dot} ${escapeHtml(when.rel || when.abs)}</div>
      </div>
      ${unread}
    </div>`;
  }

  function tableRowHTML(ev, idx) {
    const added = ev.kind === 'added';
    const p = getProvider(ev.provider_id);
    const pName = providerName(ev.provider_id);
    const mName = ev.name || ev.model_id;
    const when = whenText(ev.at);
    const unread = !ev.is_read;
    const catEntry = getCatalogEntry(ev.provider_id, ev.model_id);

    const kindBadge = added
      ? `<span class="ac-badge ac-badge-added" title="Model added to catalog"><span class="ac-badge-icon">${AC_ICON.plus}</span>Added</span>`
      : `<span class="ac-badge ac-badge-removed" title="Model removed from roster"><span class="ac-badge-icon">${AC_ICON.minus}</span>Removed</span>`;

    const profileBadge = (window.PROFILE_BADGES && typeof window.PROFILE_BADGES.badgeFor === 'function')
      ? window.PROFILE_BADGES.badgeFor(ev.provider_id, ev.name, ev.model_id)
      : '';

    return `<tr class="ac-row ${added ? 'is-added' : 'is-removed'} ${unread ? 'is-unread' : ''}" data-ac-id="${ev.id}">
      <td class="col-ac-idx">
        <div class="ac-idx-wrap" title="Row #${idx + 1} — Event ID: #${ev.id}">
          <span class="ac-idx-num">${idx + 1}</span>
          <span class="ac-idx-id">#${ev.id}</span>
        </div>
      </td>
      <td class="col-ac-kind">
        <div class="ac-kind-wrap">
          ${kindBadge}
        </div>
      </td>
      <td class="col-ac-provider">
        <div class="dt-provider ac-provider-cell" data-ac-open-provider="${escapeHtml(ev.provider_id)}" role="button" tabindex="0" title="Open provider: ${escapeHtml(pName)}">
          <span class="pv-logo">${safeProviderMark(p)}</span>
          <div class="ac-provider-text">
            <div class="dt-provider-name">${escapeHtml(pName)}</div>
            <div class="dt-provider-host">${escapeHtml((p && p.baseUrl) ? p.baseUrl : ev.provider_id)}</div>
          </div>
        </div>
      </td>
      <td class="col-ac-model">
        <div class="ac-model-cell">
          <div class="ac-model-title">
            <span class="ac-model-name">${escapeHtml(mName)}</span>
            ${profileBadge}
            ${catEntry ? '<span class="ac-tag ac-tag-catalog" title="Available in catalog">In Catalog</span>' : ''}
          </div>
          <div class="ac-model-sub">
            <code class="ac-code" title="${escapeHtml(ev.model_id)}">${escapeHtml(ev.model_id)}</code>
            <button class="ac-icon-btn" type="button" data-ac-copy="${escapeHtml(ev.model_id)}" title="Copy model ID" aria-label="Copy model ID">
              ${AC_ICON.copy}
            </button>
            ${catEntry && catEntry.context_tokens ? `<span class="ac-tag" title="Context size">${escapeHtml(fmtTokens(catEntry.context_tokens))} ctx</span>` : ''}
            ${catEntry && catEntry.score != null ? `<span class="ac-tag" title="Artificial Analysis score">Score: ${catEntry.score}</span>` : ''}
            ${catEntry && catEntry.pricing && (catEntry.pricing.input || catEntry.pricing.output) ? `<span class="ac-tag ac-tag-price" title="Price per 1M tokens in/out">$${catEntry.pricing.input || 0}/$${catEntry.pricing.output || 0}</span>` : ''}
          </div>
        </div>
      </td>
      <td class="col-ac-date">
        <div class="ac-date-cell" title="${escapeHtml(when.abs)}">
          <span class="ac-date-rel">${escapeHtml(when.rel || when.abs)}</span>
          <span class="ac-date-abs">${escapeHtml(when.abs)}</span>
        </div>
      </td>
      <td class="dt-actions-col">
        <div class="dt-row-actions ac-row-actions">
          ${unread ? `
            <button class="btn btn-ghost btn-mini ac-btn-mark-read" type="button" data-ac-mark-single="${ev.id}" title="Mark as read">
              ${AC_ICON.check}
              <span>Mark read</span>
            </button>
          ` : `
            <span class="ac-read-done" title="Already marked as read">
              ${AC_ICON.check}
              <span>Read</span>
            </span>
          `}
        </div>
      </td>
    </tr>`;
  }

  function tableHTML(rows) {
    return `<div class="dt-table-wrap ac-table-wrap"><table class="dt-table ac-table">
      <thead><tr>
        <th class="col-ac-idx" style="width: 52px; text-align: center;">#</th>
        <th class="col-ac-kind" style="width: 110px;">Change</th>
        <th class="col-ac-provider" style="min-width: 170px;">Provider</th>
        <th class="col-ac-model">Model</th>
        <th class="col-ac-date" style="width: 180px;">Date &amp; Time</th>
        <th class="dt-actions-col" style="width: 110px;">Actions</th>
      </tr></thead>
      <tbody>
        ${rows.map((ev, idx) => tableRowHTML(ev, idx)).join('')}
      </tbody>
    </table></div>`;
  }

  function cardHTML(ev) {
    const added = ev.kind === 'added';
    const p = getProvider(ev.provider_id);
    const pName = providerName(ev.provider_id);
    const mName = ev.name || ev.model_id;
    const when = whenText(ev.at);
    const unread = !ev.is_read;
    const catEntry = getCatalogEntry(ev.provider_id, ev.model_id);
    const pColor = (p && p.color) || 'var(--accent)';

    const kindBadge = added
      ? `<span class="ac-badge ac-badge-added"><span class="ac-badge-icon">${AC_ICON.plus}</span>Added</span>`
      : `<span class="ac-badge ac-badge-removed"><span class="ac-badge-icon">${AC_ICON.minus}</span>Removed</span>`;

    const profileBadge = (window.PROFILE_BADGES && typeof window.PROFILE_BADGES.badgeFor === 'function')
      ? window.PROFILE_BADGES.badgeFor(ev.provider_id, ev.name, ev.model_id)
      : '';

    return `<article class="pv-card ac-card ${added ? 'is-added' : 'is-removed'} ${unread ? 'is-unread' : ''}" data-ac-id="${ev.id}" style="--type-stripe:${escapeHtml(pColor)}">
      <div class="pv-watermark" aria-hidden="true">${safeProviderMark(p)}</div>
      <div class="pv-card-top ac-card-top">
        <div class="ac-card-provider" data-ac-open-provider="${escapeHtml(ev.provider_id)}" role="button" tabindex="0" title="Open provider: ${escapeHtml(pName)}">
          <span class="pv-logo">${safeProviderMark(p)}</span>
          <div class="ac-card-provider-text">
            <span class="ac-card-provider-name">${escapeHtml(pName)}</span>
            <span class="ac-card-provider-host">${escapeHtml((p && p.baseUrl) ? p.baseUrl : ev.provider_id)}</span>
          </div>
        </div>
        <div class="ac-card-kind-wrap">
          ${kindBadge}
          ${unread ? '<span class="ac-new-pill" title="Unread notification">NEW</span>' : ''}
        </div>
      </div>

      <div class="ac-card-main">
        <h3 class="pv-name ac-card-name" title="${escapeHtml(mName)}">
          <span>${escapeHtml(mName)}</span>
        </h3>
        <div class="ac-card-code-row">
          <code class="ac-code" title="${escapeHtml(ev.model_id)}">${escapeHtml(ev.model_id)}</code>
          <button class="ac-icon-btn" type="button" data-ac-copy="${escapeHtml(ev.model_id)}" title="Copy model ID" aria-label="Copy model ID">
            ${AC_ICON.copy}
          </button>
        </div>
        <div class="ac-card-chips">
          ${profileBadge}
          ${catEntry && catEntry.context_tokens ? `<span class="pv-badge pv-badge-models" title="Context size">${escapeHtml(fmtTokens(catEntry.context_tokens))} ctx</span>` : ''}
          ${catEntry && catEntry.score != null ? `<span class="pv-badge pv-badge-keys" title="Quality score">Score ${catEntry.score}</span>` : ''}
          ${catEntry && catEntry.family ? `<span class="pv-badge pv-badge-keys" title="Model family">${escapeHtml(catEntry.family)}</span>` : ''}
          ${catEntry && catEntry.pricing && (catEntry.pricing.input || catEntry.pricing.output) ? `<span class="pv-badge pv-badge-models" title="Pricing">$${catEntry.pricing.input || 0}/$${catEntry.pricing.output || 0}</span>` : ''}
        </div>
      </div>

      <div class="ac-card-footer">
        <div class="ac-card-time" title="${escapeHtml(when.abs)}">
          <span class="ac-card-time-icon">${AC_ICON.clock}</span>
          <span class="ac-date-rel">${escapeHtml(when.rel || when.abs)}</span>
          <span class="ac-time-dot">·</span>
          <span class="ac-date-abs">${escapeHtml(when.abs)}</span>
        </div>
      </div>

      <div class="pv-card-actions ac-card-actions">
        ${unread ? `
          <button class="btn btn-ghost btn-mini ac-btn-mark-read" type="button" data-ac-mark-single="${ev.id}" title="Mark as read">
            ${AC_ICON.check}
            <span>Mark read</span>
          </button>
        ` : `
          <span class="ac-read-done" title="Already marked as read">
            ${AC_ICON.check}
            <span>Read</span>
          </span>
        `}
        <button class="btn btn-ghost btn-mini ac-btn-copy" type="button" data-ac-copy="${escapeHtml(ev.model_id)}" title="Copy model ID">Copy ID</button>
      </div>
    </article>`;
  }

  function cardsHTML(rows) {
    return `<div class="pv-grid ac-grid" role="list" aria-label="Model changes">
      ${rows.map((ev) => cardHTML(ev)).join('')}
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
    const unreadPill = document.getElementById('notif-unread-count');
    if (unreadPill) {
      unreadPill.hidden = !(unread > 0);
      unreadPill.textContent = unread > 99 ? '99+' : String(unread);
    }
    renderTopActions(unread || 0);
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
    const { rows, unread } = await query({ limit: PANEL_LIMIT });
    const unreadPill = document.getElementById('notif-unread-count');
    if (unreadPill) {
      unreadPill.hidden = !(unread > 0);
      unreadPill.textContent = unread > 99 ? '99+' : String(unread);
    }
    list.innerHTML = rows.length
      ? rows.map((e) => itemHTML(e, true)).join('')
      : '<div class="ntf-empty"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="ntf-empty-icon" aria-hidden="true"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 01-3.4 0"/></svg><span>No model changes recorded yet</span></div>';
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

  function renderTopActions(unread) {
    const wrap = document.getElementById('ac-crumbs-actions');
    if (!wrap) return;
    if (unread > 0) {
      wrap.innerHTML = `<button class="btn btn-ghost btn-mini ac-top-mark-read" id="ac-page-mark-read" type="button" title="Mark all ${unread} changes as read">
        ${AC_ICON.check}
        <span>Mark all as read (${unread})</span>
      </button>`;
    } else {
      wrap.innerHTML = `<span class="ac-all-caught-up" title="All model changes have been read">
        ${AC_ICON.check}
        <span>All read</span>
      </span>`;
    }
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
    const kpi = (typeof KPI_ICON !== 'undefined') ? KPI_ICON : {};
    el.innerHTML = statCardsHTML([
      { label: 'Total changes', value: t.total, icon: kpi.layers || '', foot: 'arrivals and departures recorded' },
      { label: 'Added', value: t.added, icon: kpi.check || '', foot: 'models providers listed' },
      { label: 'Removed', value: t.removed, icon: kpi.cross || '', foot: 'models providers dropped' },
      { label: 'Unread', value: unread || 0, icon: kpi.clock || '', foot: unread ? 'awaiting review' : 'all caught up' },
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
    renderTopActions(reply.unread || 0);

    const hasMore = rows.length > acState.limit;
    const shown = rows.slice(0, acState.limit);
    if (!shown.length) {
      const empty = (reply.totals && reply.totals.total)
        ? ['No changes match these filters.', 'Try a different provider, change type or search.']
        : ['No model changes recorded yet.', 'Arrivals and departures appear here as providers add or remove models.'];
      results.innerHTML = `<div class="pv-empty"><h3>${empty[0]}</h3><p>${empty[1]}</p></div>`;
      return;
    }

    const view = isCompact() ? 'cards' : 'table';
    const content = view === 'table' ? tableHTML(shown) : cardsHTML(shown);
    results.innerHTML = content
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
      if (typeof getCurrentPage === 'function' && getCurrentPage() === 'activity') render();
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
        // 1. Copy model ID button
        const copyBtn = e.target.closest('[data-ac-copy]');
        if (copyBtn) {
          e.stopPropagation();
          const text = copyBtn.dataset.acCopy;
          if (text) {
            navigator.clipboard.writeText(text);
            if (typeof markCopied === 'function') markCopied(copyBtn);
          }
          return;
        }

        // 2. Mark single row as read button
        const markSingleBtn = e.target.closest('[data-ac-mark-single]');
        if (markSingleBtn) {
          e.stopPropagation();
          const id = Number(markSingleBtn.dataset.acMarkSingle);
          if (id && window.electronAPI && typeof window.electronAPI.catalogEventsRead === 'function') {
            window.electronAPI.catalogEventsRead({ ids: [id] }).then(() => {
              const row = markSingleBtn.closest('.ac-row, .ac-card');
              if (row) {
                row.classList.remove('is-unread');
                const cell = markSingleBtn.closest('.ac-row-actions') || markSingleBtn.parentElement;
                if (cell) {
                  cell.innerHTML = `<span class="ac-read-done" title="Already marked as read">
                    ${AC_ICON.check}
                    <span>Read</span>
                  </span>`;
                }
              }
              refreshBell();
            });
          }
          return;
        }

        // 3. Open provider details
        const provEl = e.target.closest('[data-ac-open-provider]');
        if (provEl) {
          e.stopPropagation();
          const pid = provEl.dataset.acOpenProvider;
          if (pid && typeof openProviderPage === 'function') openProviderPage(pid);
          return;
        }
      });

      body.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          const btn = e.target.closest('[data-ac-open-provider], [data-ac-copy], [data-ac-mark-single]');
          if (btn) {
            e.preventDefault();
            btn.click();
          }
        }
      });
    }

    const topActions = document.getElementById('ac-crumbs-actions');
    if (topActions) {
      topActions.addEventListener('click', (e) => {
        if (e.target.closest('#ac-page-mark-read')) {
          markAllRead();
        }
      });
    }

    const crumbs = document.getElementById('ac-crumbs');
    if (crumbs) crumbs.addEventListener('click', (e) => {
      const go = e.target.closest('[data-ac-go]');
      if (go && typeof showPage === 'function') showPage(go.dataset.acGo);
    });

    if (compactLayout && typeof compactLayout.addEventListener === 'function') {
      compactLayout.addEventListener('change', () => {
        renderIfShown();
      });
    }

    refreshBell();
  }

  window.ACTIVITY = { init, render, renderIfShown, refreshBell, state: acState };
})();
