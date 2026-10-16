// Shared provider presentation and card/row markup.
window.VENOM_RENDERER = window.VENOM_RENDERER || {};
window.VENOM_RENDERER.providerView = {
  create(deps) {
    'use strict';
    const {
      getProviders, getRunLog, getHistory, getExpanded, getCopied,
      getLegendCollapsed, getProviderHealth, getProviderVerdicts,
      getProviderTicks, usableKeys, rpmOf, escapeHtml, PV_ICON,
      KX_ICON, statusPillHTML, providerKeys, recheckButtonHTML,
      scoreClass, formatAgo,
    } = deps;
    const PROVIDERS = getProviders();
    const pvExpanded = getExpanded();
    const pvCopied = getCopied();
    const providerHealth = getProviderHealth();
    const providerVerdicts = getProviderVerdicts();
    const PROVIDER_TICKS = getProviderTicks();
    const { keyRowsHTML, keysPanelHTML, keyStripHTML } = providerKeys;
function isConnected(p) {
  return p.keys.length > 0;
}

// The provider's site link: console/keys/website meta when the module gives
// one (verified 2026-10-12: no module under src/renderer/providers/ defines
// any of them — read-only grep), otherwise the registrable part of the API
// host. Local and bare-IP endpoints have none. Do not invent console URLs;
// the fallback is the provider's website domain, not its console.
function providerWebsite(p) {
  if (p.consoleUrl) return p.consoleUrl;
  if (p.keysUrl) return p.keysUrl;
  if (p.website) return p.website;
  try {
    const host = new URL(p.baseUrl).hostname;
    if (host === 'localhost' || /^[\d.]+$/.test(host) || host.includes(':')) return null;
    return `https://${providerHost(p)}`;
  } catch (_) {
    return null;
  }
}

function websiteLinkHTML(p) {
  const url = providerWebsite(p);
  if (!url) return '';
  return `<button class="pv-site" type="button" data-site="${escapeHtml(url)}" title="Open website ${escapeHtml(url.replace(/^https?:\/\//, ''))}" aria-label="Open the ${escapeHtml(p.name)} website">` +
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg></button>';
}

function providerHost(p) {
  try {
    return new URL(p.baseUrl).hostname.replace(/^(api|router|www)\./, '');
  } catch (_) {
    return 'custom';
  }
}

// Numbers for a card, all from real state: keys, models with recorded runs,
// and the all-time pass rate of this provider's runs.
function providerStats(p) {
  const prefix = `${p.id}::`;
  let models = 0;
  getHistory().forEach((_, key) => { if (key.startsWith(prefix)) models += 1; });
  const runs = getRunLog().filter((r) => r.provider === p.id);
  const total = runs.reduce((n, r) => n + r.total, 0);
  const passed = runs.reduce((n, r) => n + r.passed, 0);
  return {
    keys: p.keys.length,
    activeKeys: usableKeys(p).length,
    models,
    rate: total ? Math.round((passed / total) * 100) : null,
    runs: runs.length,
  };
}

// The same four capabilities on every card, lit when the provider module has
// them and dimmed when it doesn't, so cards line up and can be compared at a
// glance. The tooltip says what each one means for the models and runs.
function providerCapabilities(p) {
  const adapter = (window.INTEGRATED_PROVIDERS || {})[p.id];
  const rpm = rpmOf(p);
  return [
    {
      label: 'OpenAI API', icon: PV_ICON.api, tone: 'accent', on: true,
      tip: 'OpenAI API: models are listed from /models and tested on /chat/completions.',
    },
    {
      label: 'Filtered', icon: PV_ICON.spark, tone: 'green', on: Boolean(adapter && adapter.fetchModels),
      tip: (on) => on
        ? "Filtered: the model list follows this provider's own rules (free-only models, plan tiers, access grants) instead of everything /models returns."
        : 'Not filtered: every model /models returns is listed.',
    },
    // The plan slot. A module that publishes its own billing plan names it
    // here ("$5.50 / week") instead of the generic "Plans" — one slot, not
    // two, so every card keeps the same four badges and the 2x2 grid holds.
    p.billing ? {
      label: p.billing.plan, icon: PV_ICON.layers, tone: 'amber', on: true,
      tip: `${p.billing.usageLabel || 'Provider plan'}: ${p.billing.plan}.${p.plansUrl ? ' Each key sees the models of its own plan.' : ''}`,
    } : {
      label: 'Plans', icon: PV_ICON.layers, tone: 'amber', on: Boolean(p.plansUrl),
      tip: (on) => on
        ? 'Plans: each key sees the models of its own plan, so two keys here can list different models.'
        : 'No plans: every key sees the same models.',
    },
    {
      label: p.unlimitedUsage ? 'Unlimited' : 'Rate limit', icon: PV_ICON.gauge, tone: p.unlimitedUsage ? 'green' : 'violet', on: p.unlimitedUsage || rpm > 0,
      tip: p.unlimitedUsage
        ? 'Unlimited usage: this provider publishes no request-rate limit. Runs are not paced.'
        : rpm > 0
          ? `Rate limit: ${rpm} requests per minute. Test runs are paced to stay under it.`
          : 'No published rate limit: test runs are not paced.',
    },
  ];
}

function providerTags(p) {
  return providerCapabilities(p).map((c) => {
    const tip = typeof c.tip === 'function' ? c.tip(c.on) : c.tip;
    // Rate limit carries an info button: the full picture needs more room
    // than a tooltip.
    const info = (c.label === 'Rate limit' || c.label === 'Unlimited')
      ? `<button class="pv-cap-info" type="button" data-rl-info="${escapeHtml(p.id)}" title="Usage and rate details" aria-label="Usage and rate details for ${escapeHtml(p.name)}" aria-haspopup="dialog">${RL_ICON.info}</button>`
      : '';
    return `<span class="pv-tag pv-cap t-${c.tone}${c.on ? '' : ' is-off'}" title="${escapeHtml(tip)}">${c.icon}${c.label}${info}</span>`;
  }).join('');
}

// ---------- Rate limit details (the badge's info button) ----------
// What the app does (its pace, and what happens on a 429) comes from app
// state; what the provider publishes comes from the module's meta.rateLimits
// ({ source?, lines: [{ label, value }] }).
const RL_ICON = {
  info: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><line x1="12" y1="11" x2="12" y2="16.5"/><line x1="12" y1="7.5" x2="12.01" y2="7.5"/></svg>',
  close: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  link: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>',
};

let rlPopOpener = null;

function rateLimitPopHTML(p) {
  const rpm = rpmOf(p);
  const doc = p.rateLimits || null;
  const pace = p.unlimitedUsage
    ? `<p class="rl-pace"><b>Unlimited</b> — no request-rate limit is published for the ${escapeHtml(p.unlimitedUsage.label || 'plan').toLowerCase()}.</p>`
    : rpm
      ? `<p class="rl-pace"><b>${rpm} requests/min</b> per key — runs are paced to stay under it.</p>`
      : '<p class="rl-pace"><b>Not paced</b> — this provider publishes no rate limit.</p>';
  const lines = doc && Array.isArray(doc.lines) && doc.lines.length
    ? `<h5 class="rl-sub">Published limits</h5><dl class="rl-list">${doc.lines.map((l) => `<dt>${escapeHtml(l.label)}</dt><dd>${escapeHtml(l.value)}</dd>`).join('')}</dl>`
    : '';
  const source = doc && doc.source
    ? `<button class="rl-source" type="button" data-rl-site="${escapeHtml(doc.source)}">${RL_ICON.link}${escapeHtml(doc.source.replace(/^https?:\/\//, ''))}</button>`
    : '';
  return `<div class="rl-head">
      <span class="rl-title">Rate limit · ${escapeHtml(p.name)}</span>
      <button class="rl-close" type="button" data-rl-close title="Close" aria-label="Close">${RL_ICON.close}</button>
    </div>
    ${pace}
    ${lines}
    <h5 class="rl-sub">Usage</h5>
    <p class="rl-note">${p.unlimitedUsage ? `${escapeHtml(p.unlimitedUsage.range)} · ${escapeHtml(p.unlimitedUsage.detail)}.` : 'This provider does not expose a normalized usage reading here.'}</p>
    ${p.unlimitedUsage ? '' : '<h5 class="rl-sub">If the provider refuses (HTTP 429)</h5><p class="rl-note">The run waits for its Retry-After (or a full minute), lowers that key\'s pace to what it actually allowed, and moves on to another key if there is one. Being throttled is never recorded as the model failing.</p>'}
    ${source}`;
}

function openRateLimitPop(btn) {
  const p = PROVIDERS[btn.dataset.rlInfo];
  if (!p) return;
  let pop = document.getElementById('rl-pop');
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'rl-pop';
    pop.className = 'rl-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Rate limit details');
    document.body.appendChild(pop);
    pop.addEventListener('click', (e) => {
      const site = e.target.closest('[data-rl-site]');
      if (site) window.electronAPI.openExternal(site.dataset.rlSite);
      if (e.target.closest('[data-rl-close]')) closeRateLimitPop();
    });
  }
  pop.innerHTML = rateLimitPopHTML(p);
  pop.hidden = false;
  // Below the button, kept inside the window; above it when there's no room.
  const r = btn.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
  const below = r.bottom + 8;
  const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 8) : below;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  rlPopOpener = btn;
  btn.setAttribute('aria-expanded', 'true');
  pop.querySelector('.rl-close').focus();
}

function closeRateLimitPop() {
  const pop = document.getElementById('rl-pop');
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  if (rlPopOpener && document.contains(rlPopOpener)) {
    rlPopOpener.setAttribute('aria-expanded', 'false');
    rlPopOpener.focus();
  }
  rlPopOpener = null;
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-rl-info]');
  if (btn) {
    e.stopPropagation();
    const pop = document.getElementById('rl-pop');
    if (pop && !pop.hidden && rlPopOpener === btn) closeRateLimitPop();
    else openRateLimitPop(btn);
    return;
  }
  if (!e.target.closest('#rl-pop')) closeRateLimitPop();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRateLimitPop(); });
window.addEventListener('resize', closeRateLimitPop);
document.addEventListener('scroll', closeRateLimitPop, true);

function providerMark(p, cls = '') {
  // logoTone (module meta) says how a mark drawn for a dark surface is re-inked
  // on the light theme: 'mono' goes to the text colour, 'bright' is deepened.
  const tone = p.logoTone ? ` data-tone="${escapeHtml(p.logoTone)}"` : '';
  return p.logo
    ? `<img src="${escapeHtml(p.logo)}" alt="" class="${cls}"${tone}>`
    : `<span class="pv-dot ${cls}" style="background:${escapeHtml(p.color || 'var(--accent)')}"></span>`;
}

function providerHealthLine(p) {
  if (!isConnected(p)) return { state: 'none', text: 'Not connected — needs an API key' };
  const h = providerHealth.get(p.id);
  if (!h) return { state: 'pending', text: 'Checking connection…' };
  if (h.state === 'ok') return { state: 'ok', text: h.detail };
  if (h.state === 'none') return { state: 'none', text: 'No active key' };
  return { state: h.state, text: h.detail };
}

function providerStatusHTML(p) {
  const health = providerHealthLine(p);
  const h = providerHealth.get(p.id);
  const title = h ? `${health.text} — checked ${new Date(h.checkedAt).toLocaleTimeString()}` : health.text;
  // A provider's badge stands alone: the words are for its keys, where they
  // tell one key's problem from another's.
  return statusPillHTML(health.state, health.text, title, { caption: false });
}

// Inline dot beside a provider's name on the Catalog and Profiles pages, so a
// provider going down shows there too without opening Providers.
function healthDotHTML(p) {
  if (!p) return '';
  const h = providerHealthLine(p);
  return `<span class="pv-health pv-health-inline" data-health="${h.state}" title="${escapeHtml(h.text)}"></span>`;
}

// Integrated cards are a catalogue of what can be connected: who the provider
// is and a Connect button, nothing operational. Keys, models, pass rate and
// health belong to the Connected tab, which a provider moves to once it has a
// working key.
function providerCardHTML(p, mode) {
  const connected = isConnected(p);
  const id = escapeHtml(p.id);
  const open = mode === 'connected' && pvExpanded.has(p.id);
  const primary = mode === 'connected'
    ? `<button class="btn ${open ? 'btn-ghost' : 'btn-primary'} pv-primary" type="button" data-kx-toggle="${id}" aria-expanded="${open}">${PV_ICON.keys}${open ? 'Hide keys' : 'Manage keys'}</button>`
    : connected
      ? `<button class="btn btn-primary pv-primary" type="button" data-show-connected="${id}">${PV_ICON.keys}Manage keys</button>`
      : `<button class="btn btn-primary pv-primary" type="button" data-connect="${id}">${PV_ICON.plug}Connect</button>`;
  const actions = mode === 'connected'
    ? `<button class="pv-link" type="button" data-connect="${id}">${PV_ICON.plus}Add key</button>
       <span class="pv-link-group">
         ${recheckButtonHTML(p, 'link')}
         <button class="pv-icon-btn" type="button" data-manage="${id}" title="Test models" aria-label="Test ${escapeHtml(p.name)} models">${PV_ICON.flask}</button>
       </span>`
    : connected
      ? ''
      : '<span class="pv-hint">Bring an API key to start testing.</span>';
  const stats = mode === 'connected' ? providerStatsHTML(p) : '';

  const types = providerTypes(p);
  return `<article class="pv-card ${connected ? 'is-connected' : ''} ${open ? 'open' : ''}" data-provider="${id}" style="--type-stripe:${typeStripe(types)}">
    <div class="pv-watermark" data-provider="${id}" aria-hidden="true">${providerMark(p)}</div>
    <div class="pv-card-top">
      ${providerLogoHTML(p)}
      <span class="pv-host">${escapeHtml(providerHost(p))}</span>
    </div>
    <h3 class="pv-name"><span>${escapeHtml(p.name)}</span>${websiteLinkHTML(p)}</h3>
    <div class="pv-url">
      <code title="${escapeHtml(p.baseUrl)}">${escapeHtml(p.baseUrl)}</code>
      <button class="pv-icon-btn${(pvCopied.get(p.baseUrl) || 0) > Date.now() ? ' copied' : ''}" type="button" data-copy="${escapeHtml(p.baseUrl)}" title="${(pvCopied.get(p.baseUrl) || 0) > Date.now() ? 'Copied' : 'Copy base URL'}" aria-label="Copy base URL">${PV_ICON.copy}</button>
    </div>
    <div class="pv-tags pv-caps">${providerTags(p)}</div>
    ${stats}
    ${open ? keysPanelHTML(p) : ''}
    ${primary}
    <div class="pv-card-actions${mode === 'connected' ? '' : ' is-centered'}">${actions}</div>
    ${mode === 'connected' ? `<div class="pv-stats-strip">${keyStripHTML(p)}</div>` : ''}
  </article>`;
}

function providerStatsHTML(p) {
  const s = providerStats(p);
  return `<div class="pv-stats">
      <div class="pv-stat"><span class="pv-stat-label">Keys</span>
        <span class="pv-stat-value ${s.keys ? '' : 'dim'}">${s.keys ? String(s.keys) : '0'}</span></div>
      <div class="pv-stat"><span class="pv-stat-label">Models</span>
        <span class="pv-stat-value ${s.models ? '' : 'dim'}">${s.models || '—'}</span></div>
      <div class="pv-stat"><span class="pv-stat-label">Pass rate</span>
        <span class="pv-stat-value ${s.rate == null ? 'dim' : ''}">${s.rate == null ? '—' : `${s.rate}%`}</span></div>
      <div class="pv-stats-foot">${providerStatusHTML(p)}</div>
    </div>`;
}


// ============================================
// Provider types — legend and markers
// ============================================
// Auth kind comes from the module (meta.auth, default an API key); freeTier is
// a module flag. A provider can carry more than one type.
const PROVIDER_TYPES = {
  oauth: { label: 'OAuth 2.0', desc: 'Signs in through an OAuth authorization flow', color: 'var(--type-oauth)' },
  apikey: { label: 'API Key', desc: 'Authenticates with a provider API key', color: 'var(--type-apikey)' },
  free: { label: 'Free Tier', desc: 'Includes free models or a free quota', color: 'var(--type-free)' },
  none: { label: 'No Auth', desc: 'Open to use — nothing to connect', color: 'var(--type-none)' },
};

// The Providers list is grouped by how a provider authenticates, OAuth first.
// A provider that offers both is filed once, under its first declared kind,
// but either filter finds it.
const PV_AUTH_GROUPS = ['oauth', 'apikey'];

function providerAuthKinds(p) {
  const kinds = providerTypes(p).filter((t) => PV_AUTH_GROUPS.includes(t));
  return kinds.length ? kinds : ['apikey'];
}

function providerAuthGroup(p) {
  return providerAuthKinds(p)[0];
}

function providerTypes(p) {
  const types = Array.isArray(p.auth) && p.auth.length ? [...p.auth] : ['apikey'];
  if (p.freeTier) types.push('free');
  return types.filter((t) => PROVIDER_TYPES[t]);
}

function typeStripe(types, dir = '90deg') {
  if (types.length === 1) return PROVIDER_TYPES[types[0]].color;
  const step = 100 / types.length;
  return `linear-gradient(${dir}, ${types.map((t, i) => `${PROVIDER_TYPES[t].color} ${i * step}% ${(i + 1) * step}%`).join(', ')})`;
}

// Logo tile on the Providers page, with the provider's type dots on a rail
// across the bottom edge, read against the legend above the list.
function providerLogoHTML(p) {
  const types = providerTypes(p);
  const rail = `<span class="pv-logo-types" title="${types.map((t) => PROVIDER_TYPES[t].label).join(' · ')}">`
    + types.map((t) => `<i style="--c:${PROVIDER_TYPES[t].color}"></i>`).join('') + '</span>';
  return `<span class="pv-logo has-types">${providerMark(p)}${rail}</span>`;
}

function providerLegendHTML(list) {
  const counts = Object.fromEntries(Object.keys(PROVIDER_TYPES).map((t) => [t, 0]));
  list.forEach((p) => providerTypes(p).forEach((t) => { counts[t] += 1; }));
  const chevron = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>';
  return `<div class="pv-legend ${getLegendCollapsed() ? 'collapsed' : ''}">
    <div class="pv-legend-head" data-legend-toggle>
      <span class="pv-legend-title"><span class="pv-legend-dots">${Object.values(PROVIDER_TYPES).map((t) => `<i style="--c:${t.color}"></i>`).join('')}</span>Provider types</span>
      <button class="pv-legend-toggle" type="button" data-legend-toggle aria-expanded="${!getLegendCollapsed()}">
        <span>${getLegendCollapsed() ? 'Show legend' : 'Hide legend'}</span>${chevron}
      </button>
    </div>
    <div class="pv-legend-body">
      ${Object.entries(PROVIDER_TYPES).map(([k, t]) => `
        <div class="pv-legend-item ${counts[k] ? '' : 'empty'}" style="--c:${t.color}">
          <span class="pv-legend-chip"><i></i></span>
          <div class="pv-legend-text">
            <div class="pv-legend-name">${t.label}<span class="pv-legend-count${counts[k] ? '' : ' is-zero'}">${counts[k]} provider${counts[k] === 1 ? '' : 's'}</span></div>
            <div class="pv-legend-desc">${t.desc}</div>
          </div>
        </div>`).join('')}
    </div>
    <div class="pv-legend-foot">${list.length} providers total — categories overlap (auth + free tier)</div>
  </div>`;
}


// A group's divider: a framed tag (its kind in the legend colour, how many
// providers) and a hairline running to the edge.
function pvGroupHeadHTML(kind, n) {
  const t = PROVIDER_TYPES[kind];
  return `<div class="pv-group-head" style="--c:${t.color}" role="presentation">
    <span class="pv-group-tag">
      <span class="pv-group-dot" aria-hidden="true"></span>
      <span class="pv-group-label">${escapeHtml(t.label)}</span>
      <span class="pv-group-count">${n} provider${n === 1 ? '' : 's'}</span>
    </span>
    <span class="pv-group-rule" aria-hidden="true"></span>
  </div>`;
}

const PV_BADGE_ICON = {
  key: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3"/></svg>',
  account: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  model: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
};

function providerDisplayModelsCount(p) {
  return window.CATALOG && typeof window.CATALOG.providerVisibleCount === 'function'
    ? window.CATALOG.providerVisibleCount(p.id)
    : null;
}

function providerBadgesHTML(p, s) {
  const isOAuth = providerAuthKinds(p).includes('oauth');
  const totalKeys = s?.keys ?? p.keys?.length ?? 0;
  const activeKeys = s?.activeKeys ?? usableKeys(p).length;

  // F: surface active/total (e.g. 2/3 Active) when some keys are switched off;
  // all-active keeps the short noun so first paint is unchanged.
  let keyLabel;
  if (isOAuth) {
    if (totalKeys === 0) keyLabel = '0 accounts';
    else if (activeKeys === totalKeys) keyLabel = totalKeys === 1 ? '1 account' : `${totalKeys} accounts`;
    else keyLabel = `${activeKeys}/${totalKeys} Active`;
  } else {
    if (totalKeys === 0) keyLabel = '0 keys';
    else if (activeKeys === totalKeys) keyLabel = totalKeys === 1 ? '1 key' : `${totalKeys} keys`;
    else keyLabel = `${activeKeys}/${totalKeys} Active`;
  }

  const keyTitle = isOAuth
    ? `${totalKeys} connected account${totalKeys === 1 ? '' : 's'}`
    : `${activeKeys} of ${totalKeys} key${totalKeys === 1 ? '' : 's'} active`;

  const keyIcon = isOAuth ? PV_BADGE_ICON.account : PV_BADGE_ICON.key;
  // Dim when nothing is usable (no keys, or every key switched off) — reuses is-empty, no new CSS.
  const keyClass = `pv-badge pv-badge-keys ${isOAuth ? 'is-oauth' : ''} ${totalKeys === 0 || activeKeys === 0 ? 'is-empty' : ''}`;

  const modelsCount = providerDisplayModelsCount(p);
  const modelLabel = modelsCount == null
    ? '<span class="dt-muted">—</span> models'
    : escapeHtml(modelsCount === 1 ? '1 model' : `${modelsCount} models`);
  const modelTitle = modelsCount == null
    ? '— models available'
    : `${modelsCount} model${modelsCount === 1 ? '' : 's'} available`;
  const modelClass = `pv-badge pv-badge-models ${modelsCount === 0 || modelsCount == null ? 'is-empty' : ''}`;
  const modelIcon = PV_BADGE_ICON.model;

  return `<div class="dt-provider-badges" role="group" aria-label="Provider configuration status">
    <span class="${keyClass}" title="${escapeHtml(keyTitle)}">${keyIcon}<span class="pv-badge-text">${escapeHtml(keyLabel)}</span></span>
    <span class="${modelClass}" title="${escapeHtml(modelTitle)}">${modelIcon}<span class="pv-badge-text">${modelLabel}</span></span>
  </div>`;
}

// Provider status strip: one tick per verdict of the last PROVIDER_TICKS
// checks, oldest on the left, drawn under the row's action buttons and exactly
// as wide as them (the stack stretches it to the buttons' width). Green = that
// check authenticated, red = it was refused, grey = no verdict — nothing has
// been checked yet, or the provider has no usable key. The empty slots are
// deliberate: a strip that drew only what it had would come out a different
// width on every provider, and could never show "not checked yet" at all.
//
// Unlike the solid bar this replaces, the strip carries something the badge
// beside it does not — how the provider has been behaving — so it is labelled
// (role="img") rather than hidden from assistive technology.
function pvStateBarHTML(p) {
  const ring = providerVerdicts.get(p.id) || [];
  const empty = PROVIDER_TICKS - ring.length;
  const ticks = [];
  for (let i = 0; i < empty; i++) {
    ticks.push('<span class="pv-state-tick is-empty" title="No check recorded"></span>');
  }
  for (const v of ring) {
    const tone = v.state === 'ok' ? 'ok' : v.state === 'fail' ? 'fail' : 'none';
    const what = v.detail || (tone === 'ok' ? 'Reachable' : tone === 'fail' ? 'Check failed' : 'No active key');
    const at = new Date(v.at).toLocaleTimeString();
    ticks.push(`<span class="pv-state-tick" data-state="${tone}" title="${escapeHtml(`${at} — ${what}`)}"></span>`);
  }
  const healthy = ring.filter((v) => v.state === 'ok').length;
  const summary = ring.length
    ? `Last ${ring.length} check${ring.length === 1 ? '' : 's'}: ${healthy} healthy — oldest on the left, latest on the right`
    : 'No checks recorded yet';
  return `<span class="pv-state-bar" role="img" title="${escapeHtml(summary)}" aria-label="${escapeHtml(summary)}">${ticks.join('')}</span>`;
}

function providerRateHTML(s) {
  if (s?.rate == null) {
    return '<div class="dt-rate is-empty" title="No test runs recorded yet"><div class="dt-rate-bar" aria-hidden="true"><span style="width:0%"></span></div><b class="dt-muted">—</b></div>';
  }
  const runs = s.runs || 0;
  const tip = `${runs} run${runs === 1 ? '' : 's'}`;
  const tone = typeof scoreClass === 'function' ? scoreClass(s.rate / 100) : '';
  const width = Math.max(0, Math.min(100, s.rate));
  return `<div class="dt-rate" title="${escapeHtml(tip)}"><div class="dt-rate-bar"><span class="${tone}" style="width:${width}%"></span></div><b>${s.rate}%</b></div>`;
}

// Connected providers as a list of row cards, one per provider with a gap
// between them, on one column grid shared with each provider's key rows, and
// grouped by auth kind under a divider each. The whole row opens its keys;
// there is no separate key button.
function pvLastRun(p) {
  for (let i = getRunLog().length - 1; i >= 0; i--) {
    if (getRunLog()[i].provider === p.id) return getRunLog()[i].at;
  }
  return 0;
}

function pvRowsHTML(groups, stats) {
  const rows = groups.map((x) => pvGroupHeadHTML(x.g, x.items.length) + x.items.map((p) => {
    const s = stats.get(p.id);
    const last = pvLastRun(p);
    const id = escapeHtml(p.id);
    const open = pvExpanded.has(p.id);
    return `<div class="pv-rowcard ${open ? 'open' : ''}" role="listitem">
      <div class="pv-row ${open ? 'open' : ''}" data-kx-toggle="${id}" role="button" aria-expanded="${open}" tabindex="0">
        <div class="pv-cell col-provider"><div class="dt-provider">${KX_ICON.chevron}
          ${providerLogoHTML(p)}
          <div><div class="dt-provider-name">${escapeHtml(p.name)}${websiteLinkHTML(p)}</div>${providerBadgesHTML(p, s)}</div>
        </div></div>
        <div class="pv-cell col-status"><div class="pv-status-stack">${providerStatusHTML(p)}</div></div>
        <div class="pv-cell col-rate">${providerRateHTML(s)}</div>
        <div class="pv-cell col-last">${last ? `<span title="${escapeHtml(new Date(last).toLocaleString())}">LAST: ${escapeHtml(formatAgo(last))}</span>` : '<span class="dt-muted">LAST: never</span>'}</div>
        <div class="pv-cell col-actions">
          <div class="pv-actions-stack">
            <div class="dt-row-actions">
              <button class="dt-icon-btn" type="button" data-connect="${id}" title="Add key" aria-label="Add key">${PV_ICON.plus}</button>
              ${recheckButtonHTML(p)}
              <button class="dt-icon-btn dt-icon-go" type="button" data-manage="${id}" title="Test models" aria-label="Test ${escapeHtml(p.name)} models">${PV_ICON.flask}</button>
            </div>
            ${pvStateBarHTML(p)}
          </div>
        </div>
      </div>${open ? `<div class="pv-rowcard-keys">${keyRowsHTML(p)}</div>` : ''}
    </div>`;
  }).join('')).join('');
  return `<div class="pv-rows" role="list" aria-label="Connected providers">
    ${rows}
  </div>`;
}

    return {
      isConnected, providerWebsite, websiteLinkHTML, providerHost, providerStats,
      providerCapabilities, providerTags, providerMark, providerHealthLine,
      closeRateLimitPop,
      providerStatusHTML, healthDotHTML, providerCardHTML, providerStatsHTML,
      PROVIDER_TYPES, PV_AUTH_GROUPS, providerAuthKinds, providerAuthGroup,
      providerTypes, typeStripe, providerLogoHTML, providerLegendHTML,
      pvGroupHeadHTML, providerDisplayModelsCount, providerBadgesHTML,
      pvStateBarHTML, providerRateHTML, pvLastRun, pvRowsHTML,
    };
  },
};
