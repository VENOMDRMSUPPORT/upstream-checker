// ============================================
// MUSE AI (muse.ai) — integrated provider module
// Registers into window.INTEGRATED_PROVIDERS; loaded before app.js.
// ============================================
// Muse is served by a local bridge (MuseBridge) that drives the muse.ai
// web client in a real browser: it signs in with the account's own
// credentials, keeps the session alive, and exposes an OpenAI-compatible
// API on 127.0.0.1. The app talks to the bridge like any other provider —
// the only thing that is different is where the usage comes from.
//
//   base URL:   http://127.0.0.1:8787          (the bridge's default)
//   models:     GET  /v1/models                 -> muse, muse-agent
//   chat:       POST /v1/chat/completions        -> OpenAI-compatible
//   usage:      GET  /admin/usage               -> plan + weekly % + tokens
//
// The bridge owns the login, the session and the refresh. The app owns the
// key (the bridge's own API key, entered once) and the request log.
//
// Verified live on 2026-10-20 against a running bridge:
//   /health        -> { ok: true, browser: "up", loggedIn: true }
//   /v1/models     -> muse, muse-agent
//   /admin/usage   -> plan "Muse مجاني", weekly 2%, 1B tokens left
//   chat round-trip -> 200, reply in ~20s
//
// The credential the bridge uses never reaches this file's caller: the app
// sends the bridge's API key as a normal key, and main swaps the real value
// in for the bridge's own origin.
window.INTEGRATED_PROVIDERS = window.INTEGRATED_PROVIDERS || {};

(function () {
  // The bridge's usage answer, mapped into the app's allowance shape. The
  // bridge reports a percentage used and the tokens left — never a count of
  // what was spent, so an absent reading is "not published", never zero.
  function usageFrom(data) {
    if (!data || typeof data !== 'object') return { quota: null, expiresAt: null, window24h: null };

    const tier = data.tier && typeof data.tier === 'object' ? data.tier : {};
    const plan = tier.name || data.plan || '';
    const out = { quota: null, expiresAt: null, window24h: null };
    if (plan) out.plan = plan;

    const weekly = data.weekly && typeof data.weekly === 'object' ? data.weekly : null;
    const tokens = data.tokens && typeof data.tokens === 'object' ? data.tokens : null;

    const allowances = [];
    if (weekly && Number.isFinite(Number(weekly.percent))) {
      const resetsAt = Number(weekly.resetsAt);
      allowances.push({
        label: plan ? `${plan} · weekly limit` : 'Weekly limit',
        usedPct: Number(weekly.percent),
        resetsAt: Number.isFinite(resetsAt) && resetsAt > 0
          ? (resetsAt > 1e11 ? resetsAt : resetsAt * 1000)
          : null,
      });
    }
    if (tokens && Number.isFinite(Number(tokens.percent))) {
      allowances.push({
        label: tokens.left ? `Additional tokens (${tokens.left} left)` : 'Additional tokens',
        usedPct: Number(tokens.percent),
        resetsAt: null,
      });
    }
    if (allowances.length) {
      out.allowance = allowances[0];
      out.allowances = allowances;
    }
    return out;
  }

  window.INTEGRATED_PROVIDERS.muse = {
    meta: {
      id: 'muse',
      name: 'Muse AI',
      // The bridge's default address. The user can change it in the
      // provider's edit dialog if the bridge runs elsewhere.
      baseUrl: 'http://127.0.0.1:8787',
      color: '#016fea',
      logo: '../assets/providers/muse.png',
      modelsEndpoint: '/v1/models',
      chatEndpoint: '/v1/chat/completions',
      // A normal key, like every other provider: the bridge's own API key,
      // entered once and stored encrypted.
      auth: ['apikey'],
      planNote: 'Served by the MuseBridge on 127.0.0.1:8787 · the account and the allowance come from the bridge',
      docsSource: 'MUSE.md §0',
      website: 'https://muse.ai',
    },

    // The account's usage comes from the bridge, not from a provider API.
    async fetchKeyUsage({ baseUrl, apiRequest } = {}) {
      const url = `${String(baseUrl || 'http://127.0.0.1:8787').replace(/\/$/, '')}/admin/usage`;
      const res = await apiRequest({ url, method: 'GET', timeoutMs: 20000 });
      if (!res || res.status < 200 || res.status >= 300) {
        throw new Error(`The bridge did not answer (HTTP ${res && res.status})`);
      }
      let data;
      try {
        data = JSON.parse(res.body);
      } catch (_) {
        throw new Error('The bridge answered with something this app cannot read');
      }
      return usageFrom(data);
    },

    // The bridge reports an exhausted allowance as a 402 with the reset time.
    readQuotaError({ code, status, message } = {}) {
      const text = String(message || '');
      if (status === 402 || /quota exhausted|insufficient_quota|subscription quota/i.test(text)) {
        return { until: null, message: text || "The account's allowance is used up" };
      }
      if (code && /quota/i.test(String(code)) && !/rate_limit/i.test(String(code))) {
        return { until: null, message: text || "The account's allowance is used up" };
      }
      return null;
    },
  };
})();
