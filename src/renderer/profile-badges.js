// ============================================
// Venom Profiles — shared profile badges
// ============================================
// One fixed color identity per routing profile, reused by the Profiles
// page, the Models Catalog, the Model Activity feed and Monitoring.
// Classification reads the router:profiles payload (never secrets): a
// model found in a profile pool wears that profile's badge.
//
// Standalone classic script (no dependencies, no DOM at load). Consumers
// call warm() on page render and badgeHTML() in their row templates;
// every entry point degrades to an empty string when profiles are
// unavailable, so a missing channel never breaks a page.
(function () {
  'use strict';

  const SHORT = { lite: 'LITE', pro: 'PRO', max: 'MAX', fleet: 'FLEET' };

  // Pure: index a profiles payload for sync lookups. Keys cover the shapes
  // each consumer holds: provider/model, bare model id, upstream id.
  function indexProfiles(profiles) {
    const map = new Map();
    const add = (key, profile) => {
      if (key && !map.has(key)) map.set(String(key).toLowerCase(), profile);
    };
    for (const name of ['lite', 'pro', 'max']) {
      const list = (profiles && profiles[name] && profiles[name].eligible) || [];
      for (const target of list) {
        if (!target) continue;
        const provider = target.providerId || '';
        const model = target.modelId || '';
        add(`${provider}/${model}`, name);
        add(model, name);
        add(target.upstreamId, name);
      }
    }
    return map;
  }

  // Pure: first profile hit across the candidate keys, or null.
  function classify(candidates, index) {
    if (!index) return null;
    for (const candidate of candidates || []) {
      if (!candidate) continue;
      const hit = index.get(String(candidate).toLowerCase());
      if (hit) return hit;
    }
    return null;
  }

  function badgeHTML(profile, extra) {
    if (!profile || !SHORT[profile]) return '';
    const label = extra ? `${SHORT[profile]} · ${extra}` : SHORT[profile];
    return `<span class="vp-badge vp-badge--${profile}">${label}</span>`;
  }

  const state = { index: null, warmed: false, pending: null };

  function warm() {
    if (state.pending) return state.pending;
    const bridge = window.electronAPI;
    if (!bridge || typeof bridge.routerProfiles !== 'function') {
      state.warmed = true;
      return Promise.resolve(null);
    }
    state.pending = Promise.resolve()
      .then(() => bridge.routerProfiles())
      .then((reply) => {
        if (reply && reply.ok !== false && reply.profiles) {
          state.index = indexProfiles(reply.profiles);
        }
        state.warmed = true;
        return reply;
      })
      .catch(() => {
        state.warmed = true;
        return null;
      });
    return state.pending;
  }

  // Sync lookup for row templates: empty string until warm() resolves.
  // Kicks a fire-and-forget warm on first use so later renders fill in.
  function badgeFor(providerId, ...names) {
    if (!state.index && !state.pending) {
      try { warm(); } catch (_) { /* badges stay empty */ }
    }
    if (!state.index) return '';
    const profile = classify([`${providerId || ''}/${names[0] || ''}`, ...names], state.index);
    return badgeHTML(profile);
  }

  window.PROFILE_BADGES = { indexProfiles, classify, badgeHTML, badgeFor, warm,
    get ready() { return state.warmed; } };
})();
