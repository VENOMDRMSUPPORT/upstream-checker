// ============================================
// Key usage — quota, expiry and request history per API key
// ============================================
// Provider-agnostic. A provider module opts in with fetchKeyUsage (and, for
// the request log, fetchKeyHistory) and returns the normalized shapes below;
// nothing here knows any provider. The quota and expiry sit in the key row on
// the Connected tab; the rest opens in a drawer from the right.
//
//   fetchKeyUsage   → { quota: { total, remaining, unit } | null,
//                       expiresAt: ms | null,
//                       window24h: { requests, successRate, errorRate } | null,
//                       allowance?: { label, usedPct, resetsAt } — a
//                         percentage-only allowance that renews (instead of
//                         a quota with amounts),
//                       plan?: string,
//                       probe?: { model, status, until, message } — the
//                         reading came from a request refused for a spent
//                         allowance }
//   readUsageHeaders(headers) → the same shape, from any response's headers,
//                       so a run keeps the reading current for free.
//   fetchKeyHistory → { page, pageSize, total, totalPages,
//                       items: [{ at, model, ok, status, inputTokens,
//                                 outputTokens, totalTokens, cost }] }
//
// Loaded after app.js and uses its globals (PROVIDERS, escapeHtml,
// providerLogoHTML, formatAgo, refreshAfterKeyChange, and the spent-quota
// helpers isKeySpent / isKeySpentFor / markKeySpent / clearKeySpent).
window.KEY_USAGE = (() => {
  // Opening a provider's keys refreshes usage older than this; Test, Recheck
  // and the drawer always fetch.
  const STALE_MS = 5 * 60 * 1000;
  const HISTORY_PAGE_SIZE = 20;

  const cache = new Map(); // key id -> { state: 'loading'|'ok'|'fail', usage, error, at }
  const inflight = new Map(); // key id -> promise
  const drawer = { pid: null, kid: null, page: 1, history: null, opener: null };

  const ICON = {
    refresh: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
    close: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    panel: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>',
    prev: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
    next: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
    alert: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12.5"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  };

  const compactFmt = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
  const fullFmt = new Intl.NumberFormat('en');
  const compact = (n) => (n == null ? '—' : compactFmt.format(n));
  const full = (n) => (n == null ? '—' : fullFmt.format(n));
  const pct = (r) => (r == null ? '—' : `${Math.round(r * 1000) / 10}%`);

  function adapterOf(p) {
    return (p && (window.INTEGRATED_PROVIDERS || {})[p.id]) || null;
  }

  function supports(p) {
    return Boolean((adapterOf(p) && adapterOf(p).fetchKeyUsage) || p?.unlimitedUsage);
  }

  function localUsage(p) {
    if (!p?.unlimitedUsage) return null;
    return {
      unlimited: true,
      label: p.unlimitedUsage.label || 'Unlimited plan',
      range: p.unlimitedUsage.range || '0 → ∞ tokens',
      detail: p.unlimitedUsage.detail || 'Unlimited usage',
    };
  }

  function findKey(pid, kid) {
    const p = PROVIDERS[pid];
    return { p, k: p && p.keys.find((x) => x.id === kid) };
  }

  function rerender(pid, kid) {
    refreshAfterKeyChange(pid);
    if (drawer.kid === kid) renderDrawer();
  }

  // ---------- Fetching ----------

  function refresh(pid, kid, { force = false } = {}) {
    const { p, k } = findKey(pid, kid);
    if (!supports(p) || !k || k.locked) return Promise.resolve();
    if (p.unlimitedUsage) {
      cache.set(kid, { state: 'ok', usage: localUsage(p), at: Date.now() });
      rerender(pid, kid);
      return Promise.resolve();
    }
    if (inflight.has(kid)) return inflight.get(kid);
    const cur = cache.get(kid);
    if (!force && cur && cur.state === 'ok' && Date.now() - cur.at < STALE_MS) return Promise.resolve();

    // The last reading stays on screen while the new one loads.
    cache.set(kid, { ...cur, state: 'loading' });
    rerender(pid, kid);
    const job = (async () => {
      try {
        const usage = await adapterOf(p).fetchKeyUsage({ apiKey: k.key, baseUrl: p.baseUrl, apiRequest: window.electronAPI.apiRequest });
        cache.set(kid, { state: 'ok', usage, at: Date.now() });
        reconcileSpent(pid, kid, usage);
      } catch (err) {
        cache.set(kid, { state: 'fail', usage: cur && cur.usage, error: err.message, at: Date.now() });
      } finally {
        inflight.delete(kid);
        rerender(pid, kid);
      }
    })();
    inflight.set(kid, job);
    return job;
  }

  // A reading also settles app.js's spent-quota state for the key: an
  // allowance under 100% means it has renewed (lift a stale "Quota used"),
  // and a request refused for a spent allowance records that model as spent.
  function reconcileSpent(pid, kid, usage) {
    const { k } = findKey(pid, kid);
    if (!k || !usage) return;
    const a = usage.allowance;
    if (a && a.usedPct != null && a.usedPct < 100 && isKeySpent(k)) {
      clearKeySpent(pid, kid);
    } else if (usage.probe && !isKeySpentFor(k, usage.probe.model)) {
      markKeySpent(pid, kid, { until: usage.probe.until || (a && a.resetsAt), status: usage.probe.status, message: usage.probe.message }, usage.probe.model);
    }
  }

  // Passive reading: any response on this key whose headers the module can
  // read (a test run's requests) updates its usage without asking again.
  let observeTimer = null;
  const observed = new Set();
  function observe(pid, kid, headers) {
    const p = PROVIDERS[pid];
    const adapter = adapterOf(p);
    if (!adapter || !adapter.readUsageHeaders || !headers) return;
    const usage = adapter.readUsageHeaders(headers);
    if (!usage) return;
    cache.set(kid, { state: 'ok', usage, at: Date.now() });
    reconcileSpent(pid, kid, usage);
    // A run answers many requests a second: redraw once they settle.
    observed.add(pid);
    clearTimeout(observeTimer);
    observeTimer = setTimeout(() => {
      observed.forEach((id) => refreshAfterKeyChange(id));
      observed.clear();
      if (drawer.kid) renderDrawer();
    }, 600);
  }

  function refreshProvider(pid, opts) {
    const p = PROVIDERS[pid];
    if (!supports(p)) return;
    p.keys.forEach((k) => refresh(pid, k.id, opts));
  }

  function forget(kid) {
    cache.delete(kid);
    if (drawer.kid === kid) closeDrawer();
  }

  async function loadHistory(page) {
    const { pid, kid } = drawer;
    const { p, k } = findKey(pid, kid);
    if (!p || !k || !adapterOf(p).fetchKeyHistory) return;
    drawer.page = page;
    drawer.history = { state: 'loading', data: drawer.history && drawer.history.data };
    renderDrawer();
    try {
      const data = await adapterOf(p).fetchKeyHistory({
        apiKey: k.key, baseUrl: p.baseUrl, apiRequest: window.electronAPI.apiRequest, page, pageSize: HISTORY_PAGE_SIZE,
      });
      // The drawer may have moved to another key while this page loaded.
      if (drawer.kid !== kid || drawer.page !== page) return;
      drawer.history = { state: 'ok', data };
    } catch (err) {
      if (drawer.kid !== kid || drawer.page !== page) return;
      drawer.history = { state: 'fail', error: err.message, data: drawer.history && drawer.history.data };
    }
    renderDrawer();
  }

  // ---------- Readings ----------

  // How much is left: green above a quarter, amber above a tenth, red below.
  function quotaTone(left) {
    if (left > 0.25) return '';
    return left > 0.1 ? 'low' : 'bad';
  }

  // "38 min", "7h", "1d 21h" within the week (when the hours still matter),
  // then whole days.
  function untilText(ms) {
    const m = Math.round(ms / 60000);
    if (m < 60) return `${Math.max(1, m)} min`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    if (d < 7) return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
    return `${Math.round(h / 24)} days`;
  }

  // Expired and the last day read red, the last three days amber.
  function expiryState(expiresAt) {
    const ms = expiresAt - Date.now();
    if (ms <= 0) return { tone: 'bad', label: 'Expired', ms };
    if (ms < 86400000) return { tone: 'bad', label: `in ${untilText(ms)}`, ms };
    if (ms < 3 * 86400000) return { tone: 'low', label: `in ${untilText(ms)}`, ms };
    return { tone: '', label: `in ${untilText(ms)}`, ms };
  }

  const dateText = (ts) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fullDate = (ts) => new Date(ts).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' });

  // ---------- Key row cells ----------

  function openAttrs(p, k, label) {
    return `type="button" data-ku-open="${escapeHtml(p.id)}|${escapeHtml(k.id)}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"`;
  }

  // Quota under the provider's pass-rate column: a bar of what is left, and
  // the amount. The cell opens the usage drawer.
  function quotaCellHTML(p, k) {
    if (!supports(p) || k.locked) return '';
    const c = cache.get(k.id);
    const u = c && c.usage;
    if (!u) {
      if (!c || c.state === 'loading') return '<div class="ku-cell ku-skel" aria-label="Loading usage"><span></span><span></span></div>';
      return `<button class="ku-cell ku-cell-fail" ${openAttrs(p, k, `Usage unavailable: ${c.error} — open details`)}>${ICON.alert}<span>Usage unavailable</span></button>`;
    }
    if (u.unlimited) {
      const tip = `${u.detail} — no quota or rate limit is reported by this provider`;
      return `<button class="ku-cell ku-cell-unlimited" ${openAttrs(p, k, tip)}>
        <span class="ku-unlimited-line"><span class="ku-unlimited-track"><span class="ku-unlimited-start">0</span><span class="ku-unlimited-fill"></span><span class="ku-unlimited-end">∞</span></span></span>
        <span class="ku-sub">${escapeHtml(u.range)}</span>
      </button>`;
    }
    if (u.allowance && u.allowance.usedPct != null) {
      const a = u.allowance;
      const left = (100 - a.usedPct) / 100;
      const tip = `${a.label}: ${a.usedPct}% used${a.resetsAt ? `, renews ${fullDate(a.resetsAt)}` : ''} — open usage details`;
      return `<button class="ku-cell${c.state === 'loading' ? ' is-loading' : ''}" ${openAttrs(p, k, tip)}>
        <span class="ku-quota-line"><span class="dt-rate-bar"><span class="${quotaTone(left)}" style="width:${Math.max(0, Math.min(100, left * 100))}%"></span></span><b>${a.usedPct}%</b></span>
        <span class="ku-sub">${escapeHtml(a.label)} <span class="dt-muted">used</span></span>
      </button>`;
    }
    if (!u.quota) return `<button class="ku-cell" ${openAttrs(p, k, 'Open usage details')}><span class="dt-muted">No quota</span></button>`;
    const { total, remaining, unit } = u.quota;
    const left = remaining / total;
    const width = Math.max(0, Math.min(100, left * 100));
    const tip = `${full(remaining)} of ${full(total)} ${unit} left (${pct(left)}) — open usage details`;
    return `<button class="ku-cell${c.state === 'loading' ? ' is-loading' : ''}" ${openAttrs(p, k, tip)}>
      <span class="ku-quota-line"><span class="dt-rate-bar"><span class="${quotaTone(left)}" style="width:${width}%"></span></span><b>${pct(left)}</b></span>
      <span class="ku-sub">${compact(remaining)} <span class="dt-muted">/ ${compact(total)} left</span></span>
    </button>`;
  }

  // Expiry under the provider's last-run column.
  function expiryCellHTML(p, k) {
    if (!supports(p) || k.locked) return '';
    const c = cache.get(k.id);
    const u = c && c.usage;
    if (!u) return !c || c.state === 'loading' ? '<div class="ku-cell ku-skel"><span></span></div>' : '';
    // A renewing allowance shows when it renews instead of an expiry.
    if (!u.expiresAt && u.allowance && u.allowance.resetsAt) {
      const at = u.allowance.resetsAt;
      return `<span class="ku-expiry" title="${escapeHtml(`${u.allowance.label} renews ${fullDate(at)}`)}">
        <b>Resets in ${escapeHtml(untilText(at - Date.now()))}</b><span class="ku-sub">${escapeHtml(dateText(at))}</span>
      </span>`;
    }
    if (!u.expiresAt) return '<span class="dt-muted" title="This key does not expire">No expiry</span>';
    const e = expiryState(u.expiresAt);
    return `<span class="ku-expiry" data-tone="${e.tone}" title="${escapeHtml(`${e.ms <= 0 ? 'Expired' : 'Expires'} ${fullDate(u.expiresAt)}`)}">
      <b>${escapeHtml(e.label)}</b><span class="ku-sub">${escapeHtml(dateText(u.expiresAt))}</span>
    </span>`;
  }

  // The card view's key rows have no columns: both readings on one line.
  function inlineHTML(p, k) {
    if (!supports(p) || k.locked) return '';
    const c = cache.get(k.id);
    const u = c && c.usage;
    if (!u) {
      if (!c || c.state === 'loading') return '<div class="ku-inline ku-skel"><span></span></div>';
      return `<button class="ku-inline ku-cell-fail" ${openAttrs(p, k, `Usage unavailable: ${c.error}`)}>${ICON.alert}Usage unavailable</button>`;
    }
    const parts = [];
    if (u.unlimited) {
      parts.push(`<span class="ku-inline-unlimited"><span class="ku-unlimited-track"><span class="ku-unlimited-start">0</span><span class="ku-unlimited-fill"></span><span class="ku-unlimited-end">∞</span></span><span class="ku-inline-num">${escapeHtml(u.range)}</span></span>`);
      return `<button class="ku-inline" ${openAttrs(p, k, `${u.detail} — open usage details`)}>${parts.join('')}${ICON.panel}</button>`;
    }
    const a = u.allowance;
    if (a && a.usedPct != null) {
      const left = (100 - a.usedPct) / 100;
      parts.push(`<span class="ku-inline-quota"><span class="dt-rate-bar"><span class="${quotaTone(left)}" style="width:${Math.max(0, Math.min(100, left * 100))}%"></span></span><span class="ku-inline-num">${a.usedPct}% <span class="dt-muted">of ${escapeHtml(a.label.toLowerCase())} used</span></span></span>`);
    }
    if (a && a.resetsAt && !u.expiresAt) {
      parts.push(`<span class="ku-expiry"><b>Resets in ${escapeHtml(untilText(a.resetsAt - Date.now()))}</b></span>`);
    }
    if (u.quota) {
      const left = u.quota.remaining / u.quota.total;
      parts.push(`<span class="ku-inline-quota"><span class="dt-rate-bar"><span class="${quotaTone(left)}" style="width:${Math.max(0, Math.min(100, left * 100))}%"></span></span><span class="ku-inline-num">${compact(u.quota.remaining)} <span class="dt-muted">/ ${compact(u.quota.total)} left</span></span></span>`);
    }
    if (u.expiresAt) {
      const e = expiryState(u.expiresAt);
      parts.push(`<span class="ku-expiry" data-tone="${e.tone}"><b>${e.ms <= 0 ? 'Expired' : `Expires ${escapeHtml(e.label)}`}</b></span>`);
    }
    return `<button class="ku-inline" ${openAttrs(p, k, 'Open usage details')}>${parts.join('<span class="ku-dot" aria-hidden="true"></span>')}${ICON.panel}</button>`;
  }

  // ---------- Drawer ----------

  function openDrawer(pid, kid, opener) {
    const { p, k } = findKey(pid, kid);
    if (!supports(p) || !k) return;
    Object.assign(drawer, { pid, kid, page: 1, history: null, opener: opener || document.activeElement });
    const el = document.getElementById('ku-drawer');
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('open'));
    renderDrawer();
    document.getElementById('ku-close').focus();
    refresh(pid, kid, { force: true });
    if (adapterOf(p).fetchKeyHistory) loadHistory(1);
  }

  function closeDrawer() {
    const el = document.getElementById('ku-drawer');
    if (!el || el.hidden) return;
    el.classList.remove('open');
    const opener = drawer.opener;
    Object.assign(drawer, { pid: null, kid: null, history: null, opener: null });
    const done = () => { el.hidden = true; };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) done();
    else setTimeout(done, 220);
    if (opener && document.contains(opener)) opener.focus();
  }

  function statHTML(label, value, sub, tone = '') {
    return `<div class="ku-stat"${tone ? ` data-tone="${tone}"` : ''}><span class="ku-stat-label">${label}</span><span class="ku-stat-value">${value}</span>${sub ? `<span class="ku-stat-sub">${sub}</span>` : ''}</div>`;
  }

  function quotaSectionHTML(u) {
    if (!u.quota) return '';
    const { total, remaining, unit } = u.quota;
    const left = remaining / total;
    return `<section class="ku-section">
      <h4 class="ku-section-title">Quota</h4>
      <div class="ku-quota-hero">
        <span class="ku-quota-big" title="${full(remaining)} ${unit}">${compact(remaining)}</span>
        <span class="ku-quota-of">of ${compact(total)} ${escapeHtml(unit)} left</span>
        <span class="ku-quota-pct" data-tone="${quotaTone(left)}">${pct(left)}</span>
      </div>
      <div class="dt-rate-bar ku-bar-lg"><span class="${quotaTone(left)}" style="width:${Math.max(0, Math.min(100, left * 100))}%"></span></div>
      <div class="ku-stats">
        ${statHTML('Used', compact(total - remaining), `${full(total - remaining)} ${escapeHtml(unit)}`)}
        ${statHTML('Remaining', compact(remaining), `${full(remaining)} ${escapeHtml(unit)}`)}
        ${statHTML('Total', compact(total), `${full(total)} ${escapeHtml(unit)}`)}
      </div>
    </section>`;
  }

  function unlimitedSectionHTML(u) {
    if (!u.unlimited) return '';
    return `<section class="ku-section">
      <h4 class="ku-section-title">${escapeHtml(u.label)}</h4>
      <div class="ku-unlimited-hero">
        <span class="ku-unlimited-hero-value">0 → ∞</span>
        <span class="ku-quota-of">tokens · unlimited model usage</span>
      </div>
      <div class="ku-unlimited-track ku-unlimited-track-lg"><span class="ku-unlimited-start">0</span><span class="ku-unlimited-fill"></span><span class="ku-unlimited-end">∞ tokens</span></div>
      <p class="ku-unlimited-note">${escapeHtml(u.detail)}. This provider does not expose a consumable quota or request-rate cap.</p>
    </section>`;
  }

  function allowanceSectionHTML(u) {
    const a = u.allowance;
    if (!a || a.usedPct == null) return '';
    const left = (100 - a.usedPct) / 100;
    return `<section class="ku-section">
      <h4 class="ku-section-title">${escapeHtml(a.label)}</h4>
      <div class="ku-quota-hero">
        <span class="ku-quota-big">${a.usedPct}%</span>
        <span class="ku-quota-of">used${u.plan ? ` · ${escapeHtml(u.plan)} plan` : ''}</span>
        <span class="ku-quota-pct" data-tone="${quotaTone(left)}">${Math.round(left * 100)}% left</span>
      </div>
      <div class="dt-rate-bar ku-bar-lg"><span class="${quotaTone(left)}" style="width:${Math.max(0, Math.min(100, left * 100))}%"></span></div>
      ${a.resetsAt ? `<div class="ku-expiry-hero" style="margin-top:14px">
        <span class="ku-expiry-big">Resets in ${escapeHtml(untilText(a.resetsAt - Date.now()))}</span>
        <span class="ku-expiry-date">${escapeHtml(fullDate(a.resetsAt))}</span>
      </div>` : ''}
    </section>`;
  }

  function expirySectionHTML(u) {
    if (!u.expiresAt) return '';
    const e = expiryState(u.expiresAt);
    return `<section class="ku-section">
      <h4 class="ku-section-title">Expiry</h4>
      <div class="ku-expiry-hero" data-tone="${e.tone}">
        <span class="ku-expiry-big">${e.ms <= 0 ? 'Expired' : `Expires ${escapeHtml(e.label)}`}</span>
        <span class="ku-expiry-date">${escapeHtml(fullDate(u.expiresAt))}</span>
      </div>
    </section>`;
  }

  function windowSectionHTML(u) {
    const w = u.window24h;
    if (!w) return '';
    const none = w.requests === 0;
    const successTone = none || w.successRate == null ? '' : w.successRate >= 0.95 ? 'good' : w.successRate >= 0.8 ? 'low' : 'bad';
    return `<section class="ku-section">
      <h4 class="ku-section-title">Last 24 hours</h4>
      <div class="ku-stats">
        ${statHTML('Requests', full(w.requests))}
        ${statHTML('Success rate', none ? '—' : pct(w.successRate), '', successTone)}
        ${statHTML('Error rate', none ? '—' : pct(w.errorRate), '', !none && w.errorRate > 0.05 ? 'bad' : '')}
      </div>
    </section>`;
  }

  function historySectionHTML(p) {
    if (!adapterOf(p).fetchKeyHistory) return '';
    const h = drawer.history;
    const data = h && h.data;
    let body;
    if (!data) {
      body = h && h.state === 'fail'
        ? `<div class="ku-empty ku-cell-fail">${ICON.alert}Could not load the request history: ${escapeHtml(h.error)}</div>`
        : '<div class="ku-table-skel">' + '<span></span>'.repeat(6) + '</div>';
    } else if (!data.items.length) {
      body = '<div class="ku-empty">No requests on this key yet.</div>';
    } else {
      const rows = data.items.map((it) => `<tr>
          <td title="${it.at ? escapeHtml(fullDate(it.at)) : ''}">${it.at ? escapeHtml(formatAgo(it.at)) : '—'}</td>
          <td class="ku-model" title="${escapeHtml(it.model)}">${escapeHtml(it.model)}</td>
          <td><span class="ku-status" data-ok="${it.ok}" title="${escapeHtml(it.status)}">${it.ok ? 'OK' : escapeHtml(it.status || 'Failed')}</span></td>
          <td class="dt-num" title="${full(it.inputTokens)} in · ${full(it.outputTokens)} out">${compact(it.inputTokens)} <span class="dt-muted">→</span> ${compact(it.outputTokens)}</td>
          <td class="dt-num" title="${full(it.cost)} quota">${full(it.cost)}</td>
        </tr>`).join('');
      const busy = h.state === 'loading';
      body = `<div class="ku-table-wrap${busy ? ' is-loading' : ''}">
          <table class="ku-table">
            <thead><tr><th>Time</th><th>Model</th><th>Status</th><th class="dt-num" title="Input → output tokens">Tokens</th><th class="dt-num" title="Quota charged">Quota</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${h.state === 'fail' ? `<div class="ku-empty ku-cell-fail">${ICON.alert}${escapeHtml(h.error)}</div>` : ''}
        <div class="ku-pager">
          <span class="ku-pager-info">Page ${data.page} of ${data.totalPages} <span class="dt-muted">· ${full(data.total)} requests</span></span>
          <span class="ku-pager-btns">
            <button class="ku-icon-btn" type="button" data-ku-page="${data.page - 1}" ${data.page <= 1 || busy ? 'disabled' : ''} title="Previous page" aria-label="Previous page">${ICON.prev}</button>
            <button class="ku-icon-btn" type="button" data-ku-page="${data.page + 1}" ${data.page >= data.totalPages || busy ? 'disabled' : ''} title="Next page" aria-label="Next page">${ICON.next}</button>
          </span>
        </div>`;
    }
    return `<section class="ku-section">
      <h4 class="ku-section-title">Request history</h4>
      ${body}
    </section>`;
  }

  function renderDrawer() {
    const { p, k } = findKey(drawer.pid, drawer.kid);
    const head = document.getElementById('ku-head-id');
    const bodyEl = document.getElementById('ku-body');
    if (!p || !k || !head) return;
    const c = cache.get(k.id);
    const loading = !c || c.state === 'loading' || (drawer.history && drawer.history.state === 'loading');
    head.innerHTML = `${providerLogoHTML(p)}
      <div class="ku-head-text">
        <h3 id="ku-title">${escapeHtml(k.name)}</h3>
        <span class="ku-head-sub">${escapeHtml(p.name)} · <code>${escapeHtml(k.hint || '')}</code></span>
      </div>`;
    const refreshBtn = document.getElementById('ku-refresh');
    refreshBtn.disabled = loading;
    refreshBtn.classList.toggle('is-spinning', loading);

    const u = c && c.usage;
    let usageHTML;
    if (!u) {
      usageHTML = c && c.state === 'fail'
        ? `<div class="ku-empty ku-cell-fail">${ICON.alert}Could not read this key's usage: ${escapeHtml(c.error)}</div>`
        : '<div class="ku-hero-skel"><span></span><span></span><span></span></div>';
    } else {
      usageHTML = (c.state === 'fail' ? `<div class="ku-empty ku-cell-fail">${ICON.alert}Showing the last reading — refresh failed: ${escapeHtml(c.error)}</div>` : '') +
        unlimitedSectionHTML(u) + allowanceSectionHTML(u) + quotaSectionHTML(u) + expirySectionHTML(u) + windowSectionHTML(u);
    }
    const updated = c && c.at && c.state !== 'loading'
      ? `<div class="ku-updated">Updated <span data-ago="${c.at}">${escapeHtml(formatAgo(c.at))}</span></div>`
      : '';
    bodyEl.innerHTML = usageHTML + historySectionHTML(p) + updated;
  }

  // ---------- Wiring ----------

  function bind() {
    const el = document.getElementById('ku-drawer');
    if (!el) return;
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-ku-close]')) { closeDrawer(); return; }
      if (e.target.closest('#ku-refresh')) {
        refresh(drawer.pid, drawer.kid, { force: true });
        loadHistory(drawer.page);
        return;
      }
      const page = e.target.closest('[data-ku-page]');
      if (page && !page.disabled) loadHistory(Number(page.dataset.kuPage));
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el.hidden) closeDrawer();
    });
    // Any key row's usage cell, wherever it is rendered.
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ku-open]');
      if (!btn) return;
      e.stopPropagation();
      const [pid, kid] = btn.dataset.kuOpen.split('|');
      openDrawer(pid, kid, btn);
    }, true);
  }

  bind();

  return { supports, refresh, refreshProvider, forget, observe, quotaCellHTML, expiryCellHTML, inlineHTML, openDrawer, closeDrawer };
})();
