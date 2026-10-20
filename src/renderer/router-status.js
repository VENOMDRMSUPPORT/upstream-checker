// ============================================
// Venom Profiles — routing dossiers page
// ============================================
// Reads the router plane built in main (src/router, wired in src/main.js)
// through the resolving channel router:profiles (per-profile target lists,
// gateway state and fleet totals), with router:status as the fallback.
// Measured outcomes come from the request log (venom-logs.db) filtered to
// routed requests only (source venom-router); with fewer than 5 logged
// requests a profile reports insufficient evidence instead of a rate.
//
// Nothing here carries a secret: profiles hold counts and pool metadata,
// log rows are scrubbed at write time, and every dynamic string is escaped
// before innerHTML.
(function () {
  'use strict';

  const MIN_EVIDENCE = 5;

  const rtState = { profiles: null, outcomes: null, loading: false, error: null, shell: false,
    query: '', colQuery: { lite: '', pro: '', max: '' }, excluded: new Set() };

  const esc = (value) => (typeof escapeHtml === 'function'
    ? escapeHtml(value)
    : String(value == null ? '' : value)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'));

  function api() {
    return (window.electronAPI && typeof window.electronAPI.routerProfiles === 'function'
      && typeof window.electronAPI.routerStatus === 'function')
      ? window.electronAPI
      : null;
  }

  function buildShell() {
    const crumbs = document.getElementById('rt-crumbs');
    if (crumbs) {
      crumbs.innerHTML = typeof breadcrumbHTML === 'function'
        ? breadcrumbHTML([{ label: 'Overview', page: 'overview' }, { label: 'Venom Profiles' }])
        : '<span class="crumb" aria-current="page">Venom Profiles</span>';
    }
    const refresh = document.getElementById('rt-refresh');
    if (refresh && !refresh.dataset.rtBound) {
      refresh.dataset.rtBound = '1';
      refresh.addEventListener('click', () => refreshNow());
    }
    rtState.shell = true;
  }

  // ---- static dossier copy (policy text lives here, data comes over IPC) ----

  const DOSSIERS = [
    { key: 'lite', pill: '⚡ Venom Lite | ⚡ Free Tier Only',
      tagline: '"For simple, frequent, and latency-sensitive requests."',
      mode: 'Fast / lightweight', strategy: 'Zero-Cost Priority',
      steps: [
        'Free-tier & subscription quota first (zero marginal cost priority)',
        'Lowest observed latency (TTFT) & highest token throughput',
        'Automatic plain-text tool-call rescue enabled',
      ] },
    { key: 'pro', pill: '⚖️ Venom Pro | ⚖️ Balanced Pareto',
      tagline: '"For everyday professional work where quality and efficiency must balance."',
      mode: 'Balanced / Cascade', strategy: 'Cost / Quality Tradeoff',
      steps: [
        'Free and paid providers both admitted — Pro is the mixed Cascade rung',
        'Starts on Efficient Workhorse tier; auto-escalates to Capable Pareto tier on tool error',
        '30-minute session stickiness with Compact Context Handoff on model switch',
      ] },
    { key: 'max', pill: '🧭 Venom Max | 🧠 Verified VQ First',
      tagline: '"For complex, multi-step work where the strongest verified evidence matters most."',
      mode: 'Deep reasoning / complex', strategy: 'Highest Benchmark Score',
      steps: [
        'Verified frontier quality evidence required (AA / LMArena top percentile)',
        'Multi-account parallel deliberation (3 diverse frontier routes) + Lead Analyst synthesis',
        'High reasoning effort enforced with automatic failover across healthy keys',
      ] },
  ];

  const POLICY = {
    lite: { label: 'LITE POLICY', desc: 'Zero marginal cost · Verified models', foot: '● Free tier', tone: 'lite' },
    pro: { label: 'PRO POLICY', desc: 'Balanced latency & intelligence', foot: '● Balanced', tone: 'pro' },
    max: { label: 'MAX POLICY', desc: 'Peak capability & reasoning', foot: '● Maximum', tone: 'max' },
  };

  // ---- measured outcomes (real log rows, routed requests only) ----

  function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }

  function formatLatency(ms) {
    if (ms == null) return '—';
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
  }

  function profileRows(allRows, eligible) {
    const ids = new Set();
    for (const target of eligible || []) {
      if (target.modelId) ids.add(String(target.modelId));
      if (target.providerId && target.modelId) ids.add(`${target.providerId}/${target.modelId}`);
    }
    return (allRows || []).filter((row) => ids.has(String(row.model_requested || ''))
      || (row.provider_id && ids.has(`${row.provider_id}/${row.model_requested || ''}`)));
  }

  function summarizeOutcome(rows) {
    const n = rows.length;
    if (n < MIN_EVIDENCE) return { n, insufficient: true, noRoute: 0 };
    const first = rows.filter((r) => (r.attempt || 1) === 1);
    const firstOk = first.filter((r) => r.status === 'ok').length;
    const failover = rows.filter((r) => (r.attempt || 1) > 1 || r.is_hedge === 1).length;
    const latencies = rows.filter((r) => r.status === 'ok' && Number.isFinite(r.latency_ms)).map((r) => r.latency_ms);
    const noRoute = rows.filter((r) => /no venom-\S* route has a live key/i.test(String(r.error_message || ''))).length;
    return {
      n,
      insufficient: false,
      firstTarget: first.length ? Math.round((firstOk / first.length) * 100) : null,
      failoverRate: Math.round((failover / n) * 100),
      medianMs: median(latencies),
      noRoute,
    };
  }

  async function loadOutcomes(bridge, profiles) {
    if (!bridge || typeof bridge.logsList !== 'function' || !profiles) return null;
    let reply;
    try {
      reply = await bridge.logsList({ source: ['venom-router'] }, null, 200, 'time');
    } catch (_) {
      return null;
    }
    const rows = (reply && reply.rows) || [];
    return {
      lite: summarizeOutcome(profileRows(rows, profiles.lite && profiles.lite.eligible)),
      pro: summarizeOutcome(profileRows(rows, profiles.pro && profiles.pro.eligible)),
      max: summarizeOutcome(profileRows(rows, profiles.max && profiles.max.eligible)),
    };
  }

  // ---- icons & rendering ----

  const ICONS = {
    lite: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    pro: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/></svg>',
    max: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>',
    fleet: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>',
  };

  function outcomeCells(summary) {
    const cell = (label, value) => `<div class="vp-outcome"><div class="vp-outcome-lbl">${label}</div>`
      + `<div class="vp-outcome-num">${value}</div></div>`;
    if (!summary || summary.insufficient) {
      const n = summary ? summary.n : 0;
      return `<div class="vp-outcomes">`
        + cell('FIRST-TARGET SUCCESS', '—')
        + cell('FAILOVER RATE', '—')
        + cell('MEDIAN TIME TO ANSWER', '—')
        + `</div><div class="vp-no-route"><span>Insufficient evidence</span><strong>n=${esc(String(n))}</strong></div>`;
    }
    const pct = (v) => (v == null ? '—' : `${v}%`);
    return `<div class="vp-outcomes">`
      + cell('FIRST-TARGET SUCCESS', esc(pct(summary.firstTarget)))
      + cell('FAILOVER RATE', esc(pct(summary.failoverRate)))
      + cell('MEDIAN TIME TO ANSWER', esc(formatLatency(summary.medianMs)))
      + `</div><div class="vp-no-route"><span>No eligible target</span><strong>${esc(String(summary.noRoute))}</strong></div>`;
  }

  function targetKey(target) {
    return `${target.providerId || ''}/${target.modelId || ''}`;
  }

  function targetItem(target, query, colQuery) {
    const name = target.displayName || target.modelId || 'unknown';
    const hay = `${target.modelId || ''} ${target.displayName || ''} ${target.providerId || ''}`.toLowerCase();
    const hide = (query && !hay.includes(query)) || (colQuery && !hay.includes(colQuery));
    const excluded = rtState.excluded.has(targetKey(target));
    const score = Number.isFinite(target.score) ? (Math.round(target.score * 10) / 10) : '—';
    const keys = target.activeKeys != null ? target.activeKeys : 0;
    return `<li class="vp-target${excluded ? ' is-excluded' : ''}" data-search="${esc(hay)}"${hide ? ' hidden' : ''}>`
      + `<div class="vp-target-main"><div class="vp-target-name">${esc(name)}`
      + ` <span class="vp-provider-pill">${esc(target.providerId || '')}</span></div>`
      + `<div class="vp-target-sub"><span class="vp-vq-dot" aria-hidden="true"></span>`
      + `VQ ${esc(String(score))} · ${esc(String(keys))} keys</div></div>`
      + `<button class="btn btn-ghost vp-exclude" type="button" data-provider="${esc(target.providerId || '')}"`
      + ` data-model="${esc(target.modelId || '')}" title="${excluded ? 'Include this model again' : 'Exclude this model from this profile'}">`
      + `${excluded ? 'Include' : 'Exclude'}</button>`
      + `</li>`;
  }

  function dossier(def, profile, rosterTotal, outcome) {
    const eligibleAll = (profile && profile.eligible) || [];
    const candidates = (profile && profile.candidates != null) ? profile.candidates : eligibleAll.length;
    const visible = eligibleAll.filter((t) => !rtState.excluded.has(targetKey(t)));
    const count = visible.length;
    const pct = candidates > 0 ? Math.min(100, Math.round((count / candidates) * 100)) : 0;
    const query = rtState.query;
    const colQuery = (rtState.colQuery && rtState.colQuery[def.key]) || '';
    const matchRow = (t) => {
      const hay = `${t.modelId || ''} ${t.displayName || ''} ${t.providerId || ''}`.toLowerCase();
      return (!query || hay.includes(query)) && (!colQuery || hay.includes(colQuery));
    };
    const shown = visible.filter(matchRow).length;
    const items = visible.map((t) => targetItem(t, query, colQuery)).join('');
    return `<section class="ov-panel vp-dossier" data-vp-dossier="${def.key}" data-profile="${def.key}">`
      + `<div class="ov-panel-head vp-dossier-head"><span class="vp-pill">${esc(def.pill)}</span></div>`
      + `<div class="vp-dossier-body">`
      + `<p class="vp-tagline">${esc(def.tagline)}</p>`
      + `<div class="vp-box"><div class="vp-box-title">ELIGIBLE TARGET POOL</div>`
      + `<div class="vp-pool-line"><strong>${esc(String(count))} / ${esc(String(candidates))} eligible</strong></div>`
      + `<div class="vp-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>`
      + `<div class="vp-meta">Mode: ${esc(def.mode)}<br>Strategy: ${esc(def.strategy)}</div></div>`
      + `<div class="vp-box"><div class="vp-box-title">MEASURED OUTCOMES · ROUTED REQUESTS ONLY</div>`
      + outcomeCells(outcome) + `</div>`
      + `<div class="vp-box"><div class="vp-box-title">SELECTION ORDER · PRIORITY WATERFALL</div>`
      + `<ol class="vp-steps">${def.steps.map((s, i) => `<li class="vp-step"><span class="vp-step-num">${i + 1}</span><span>${esc(s)}</span></li>`).join('')}</ol></div>`
      + `<div class="vp-box"><div class="vp-box-title">ELIGIBLE TARGETS · ${esc(String(shown))} SHOWN</div>`
      + `<div class="vp-roster-head"><div class="dt-search vp-col-search">`
      + `<span class="dt-search-icon" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg></span>`
      + `<input class="prompt-input dt-search-input vp-col-search-input" data-profile-search="${def.key}" type="search"`
      + ` placeholder="Search models or providers..." aria-label="Search models or providers in ${esc(def.key)}" value="${esc(colQuery)}">`
      + `</div><span class="pill">All (${esc(String(eligibleAll.length))})</span>`
      + `<span class="pill">Eligible (${esc(String(count))})</span></div>`
      + (visible.length
        ? `<ul class="vp-targets">${items}</ul>${shown === 0 ? '<div class="vp-empty">No targets match this search.</div>' : ''}`
        : '<div class="vp-empty">No eligible targets in this profile yet.</div>')
      + `</div></div></section>`;
  }

  function renderBody() {
    const body = document.getElementById('rt-body');
    if (!body) return;
    if (!api()) {
      body.innerHTML = '<div class="ov-empty"><div class="ov-empty-title">Router status is unavailable in this window.</div></div>';
      return;
    }
    if (rtState.loading && !rtState.profiles) {
      body.innerHTML = '<div class="ov-empty"><div class="spinner"></div><div class="ov-empty-title">Reading Venom Profiles…</div></div>';
      return;
    }
    if (rtState.error && !rtState.profiles) {
      body.innerHTML = `<div class="ov-empty"><div class="ov-empty-title">Could not read Venom Profiles: ${esc(rtState.error)}</div></div>`;
      return;
    }
    const reply = rtState.profiles || {};
    const profiles = reply.profiles || { lite: { eligible: [] }, pro: { eligible: [] }, max: { eligible: [] } };
    const fleet = reply.fleet || {};
    const gateway = reply.gateway || {};
    const rosterTotal = (reply.pools && reply.pools.total) || 0;
    const liteCount = (profiles.lite || {}).eligible ? profiles.lite.eligible.length : 0;
    const proCount = (profiles.pro || {}).eligible ? profiles.pro.eligible.length : 0;
    const maxCount = (profiles.max || {}).eligible ? profiles.max.eligible.length : 0;
    const active = fleet.active != null ? fleet.active : '—';
    const total = fleet.total != null ? fleet.total : '—';
    const gatewayPill = gateway.listening
      ? `Listening · 127.0.0.1:${esc(String(gateway.port || ''))}`
      : 'Inactive';

    const kpisData = [
      {
        label: POLICY.lite.label,
        value: `${liteCount} Eligible`,
        foot: POLICY.lite.desc,
        pill: POLICY.lite.foot,
        tone: 'green',
        icon: ICONS.lite,
      },
      {
        label: POLICY.pro.label,
        value: `${proCount} Eligible`,
        foot: POLICY.pro.desc,
        pill: POLICY.pro.foot,
        tone: 'blue',
        icon: ICONS.pro,
      },
      {
        label: POLICY.max.label,
        value: `${maxCount} Eligible`,
        foot: POLICY.max.desc,
        pill: POLICY.max.foot,
        tone: 'amber',
        icon: ICONS.max,
      },
      {
        label: 'FLEET TARGETS',
        value: `${esc(String(active))}/${esc(String(total))}`,
        foot: `${esc(String(active))} active · ${esc(String(fleet.disabled != null ? fleet.disabled : '—'))} disabled · ${esc(String(fleet.liveKeys != null ? fleet.liveKeys : '—'))} keys · ${esc(String(fleet.cooldowns != null ? fleet.cooldowns : '—'))} cooldowns`,
        pill: gatewayPill,
        tone: 'slate',
        icon: ICONS.fleet,
      },
    ];

    const cardsHtml = typeof statCardsHTML === 'function'
      ? statCardsHTML(kpisData)
      : '<div class="page-stats-grid ov-kpis">' + kpisData.map((k) => `
          <div class="stat-card ov-kpi stat-card-${k.tone}">
            <div class="ambientAura" aria-hidden="true"></div>
            <div class="stat-card-head"><span class="stat-card-title">${esc(k.label)}</span>
            <div class="stat-card-head-right"><span class="stat-card-badge">${k.icon || ''}</span></div></div>
            <div class="stat-card-value">${esc(k.value)}</div>
            <div class="stat-card-foot"><span class="stat-card-foot-text">${esc(k.foot)}</span>
            <span class="pill"><span class="dot" aria-hidden="true"></span>${esc(k.pill)}</span></div>
          </div>`).join('') + '</div>';

    const search = `<div class="dt-toolbar">`
      + `<div class="dt-search">`
      + `<span class="dt-search-icon" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg></span>`
      + `<input id="vp-search" class="prompt-input dt-search-input" type="search" placeholder="Search targets across all profiles by model name" aria-label="Search targets across all profiles by model name" value="${esc(rtState.query)}">`
      + `</div>`
      + `</div>`;

    const outcomes = rtState.outcomes || {};
    const dossiers = '<div class="vp-dossiers">'
      + DOSSIERS.map((def) => dossier(def, profiles[def.key], rosterTotal, outcomes[def.key])).join('')
      + '</div>';

    body.innerHTML = cardsHtml + search + dossiers;
    const input = document.getElementById('vp-search');
    if (input && !input.dataset.vpBound) {
      input.dataset.vpBound = '1';
      input.addEventListener('input', () => {
        rtState.query = String(input.value || '').toLowerCase();
        filterTargets();
      });
    }
    if (typeof document.querySelectorAll === 'function') {
      const colInputs = document.querySelectorAll('.vp-col-search-input');
      for (const col of colInputs || []) {
        if (!col || !col.dataset || col.dataset.vpColBound) continue;
        col.dataset.vpColBound = '1';
        col.addEventListener('input', () => {
          const key = col.getAttribute ? col.getAttribute('data-profile-search') : null;
          if (key && rtState.colQuery) rtState.colQuery[key] = String(col.value || '').toLowerCase();
          filterTargets();
        });
      }
    }
    if (body && !body.dataset.vpExcludeBound && typeof body.addEventListener === 'function') {
      body.dataset.vpExcludeBound = '1';
      body.addEventListener('click', (ev) => {
        const btn = ev && ev.target && ev.target.closest ? ev.target.closest('.vp-exclude') : null;
        if (!btn || !btn.dataset) return;
        const id = `${btn.dataset.provider || ''}/${btn.dataset.model || ''}`;
        if (rtState.excluded.has(id)) rtState.excluded.delete(id);
        else rtState.excluded.add(id);
        renderBody();
      });
    }
    if (document.activeElement !== input && rtState.query && input) {
      input.focus();
      try {
        const end = input.value.length;
        input.setSelectionRange(end, end);
      } catch (_) { /* caret placement is best-effort */ }
    }
  }

  function filterTargets() {
    const query = rtState.query;
    const items = document.querySelectorAll ? document.querySelectorAll('.vp-target') : [];
    for (const item of items) {
      const hay = (item.getAttribute && item.getAttribute('data-search')) || '';
      const col = item.closest && item.closest('[data-profile]')
        ? item.closest('[data-profile]').getAttribute('data-profile') : null;
      const colQuery = (col && rtState.colQuery && rtState.colQuery[col]) || '';
      const hide = (Boolean(query) && !hay.includes(query)) || (Boolean(colQuery) && !hay.includes(colQuery));
      if (item.hidden !== undefined) item.hidden = hide;
    }
  }

  function legacyProfiles(status) {
    const tiers = (status && status.tiers) || {};
    const blank = { eligible: [], candidates: 0 };
    const fill = (count) => ({ eligible: Array.from({ length: count || 0 }, () => ({})),
      candidates: count || 0 });
    return {
      ok: true,
      gateway: { listening: Boolean(status && status.gateway), port: status && status.port },
      fleet: { active: status && status.pool ? status.pool.keys : null,
        total: status && status.pool ? status.pool.keys : null, disabled: 0,
        liveKeys: status && status.pool ? status.pool.keys : null,
        cooldowns: status && status.pool && status.pool.cooldowns ? status.pool.cooldowns.length : 0 },
      pools: (status && status.pools) || { total: 0, scored: 0, unscored: 0 },
      pool: (status && status.pool) || null,
      profiles: {
        lite: tiers.lite != null ? fill(tiers.lite) : blank,
        pro: tiers.proEfficient != null || tiers.proCapable != null
          ? { eligible: [...Array(tiers.proEfficient || 0).fill({}), ...Array(tiers.proCapable || 0).fill({})],
            candidates: (tiers.proEfficient || 0) + (tiers.proCapable || 0) }
          : blank,
        max: tiers.max != null ? fill(tiers.max) : blank,
      },
    };
  }

  async function refreshNow() {
    const bridge = api();
    if (!bridge) { renderBody(); return { ok: false }; }
    rtState.loading = true;
    const btn = document.getElementById('rt-refresh');
    if (btn && btn.classList) btn.classList.add('loading');
    renderBody();
    try {
      if (typeof bridge.routerRefresh === 'function') await bridge.routerRefresh();
      let reply = null;
      if (typeof bridge.routerProfiles === 'function') {
        try {
          reply = await bridge.routerProfiles();
        } catch (err) {
          // Old main, new renderer (dev hot-reload): the channel does not
          // exist yet. Fall through to the status fallback below instead of
          // failing the page; a real refusal still surfaces as an error.
          if (!/no handler registered/i.test(String((err && err.message) || err))) throw err;
          reply = null;
        }
      }
      if (!reply || reply.ok === false || !reply.profiles) {
        const status = await bridge.routerStatus();
        if (status && status.ok === false) {
          rtState.error = status.message || 'status refused';
        } else {
          rtState.profiles = legacyProfiles(status);
          rtState.error = null;
        }
      } else {
        rtState.profiles = reply;
        rtState.error = null;
      }
      if (rtState.profiles && rtState.profiles.profiles) {
        rtState.outcomes = await loadOutcomes(bridge, rtState.profiles.profiles);
      }
      if (window.PROFILE_BADGES && typeof window.PROFILE_BADGES.warm === 'function') {
        try { await window.PROFILE_BADGES.warm(); } catch (_) { /* badges stay empty */ }
      }
    } catch (err) {
      rtState.error = (err && err.message) || String(err);
    }
    rtState.loading = false;
    if (btn && btn.classList) btn.classList.remove('loading');
    renderBody();
    return { ok: !rtState.error };
  }

  async function render() {
    if (!rtState.shell) buildShell();
    if (!rtState.profiles && !rtState.loading) await refreshNow();
    else renderBody();
  }

  window.ROUTER = { state: rtState, render, refresh: refreshNow };
})();
