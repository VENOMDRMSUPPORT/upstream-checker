// ============================================
// GitHub Models — integrated provider module
// Registers into window.INTEGRATED_PROVIDERS; loaded before app.js.
// ============================================
// Evidence: docs/integrations/GITHUBMODELS.md (GitHub documentation
// verified 2026-11-11). OpenAI-compatible: GET /models,
// POST /chat/completions, a GitHub personal access token as Bearer.
//
// The standard contract is the integration; the custom code is the
// key-usage reading at the bottom, from the rate-limit headers the
// inference endpoint returns. Limits are per account AND per model
// (Low 15/min · 150/day, High 10/min · 50/day) and GitHub's terms
// restrict the free tier to prototyping. One secondary source claims
// the service was retired in July 2026; that is uncorroborated and
// recorded openly in GITHUBMODELS.md — the first connect with a real
// token settles it, and removing this file removes the provider if it
// ever comes to that.
window.INTEGRATED_PROVIDERS = window.INTEGRATED_PROVIDERS || {};

window.INTEGRATED_PROVIDERS.githubmodels = {
  meta: {
    id: 'githubmodels',
    name: 'GitHub Models',
    baseUrl: 'https://models.github.ai/inference',
    color: '#8250df',
    logo: '../assets/providers/githubmodels.svg',
    modelsEndpoint: '/models',
    chatEndpoint: '/chat/completions',
    auth: ['apikey'],
    website: 'https://github.com/marketplace/models',

    // A free tier exists (drives the Free Tier legend colour).
    freeTier: true,
    planNote: 'Free prototyping tier · per-model limits, GitHub account token',
    docsSource: 'GITHUBMODELS.md (verified 2026-11-11)',
    verifiedOn: '2026-11-11',

    rpm: 10,
    rateLimits: {
      source: 'https://docs.github.com/en/github-models',
      lines: [
        { label: 'Low models', value: '15 req/min · 150 req/day' },
        { label: 'High models', value: '10 req/min · 50 req/day · 8K input / 4K output tokens per request' },
        { label: 'Scope', value: 'Per GitHub account and per model; prototyping use only under GitHub’s terms' },
      ],
    },
  },

  // The inference endpoint is Azure-backed and documents the standard
  // rate-limit headers (x-ratelimit-limit / x-ratelimit-remaining /
  // x-ratelimit-reset, the reset an epoch). NOT verified live — no token
  // was available on 2026-11-11 — so the parser is defensive: it accepts
  // the per-token spellings too, and returns null rather than inventing a
  // reading when the headers are absent. The first real connect settles
  // the dialect, exactly like the retirement question in meta.
  readUsageHeaders(headers) {
    if (!headers) return null;
    const h = {};
    Object.entries(headers).forEach(([k, v]) => { h[String(k).toLowerCase()] = v; });
    const limit = Number(h['x-ratelimit-limit'] ?? h['x-ratelimit-limit-tokens']);
    const remaining = Number(h['x-ratelimit-remaining'] ?? h['x-ratelimit-remaining-tokens']);
    if (!Number.isFinite(limit) || !Number.isFinite(remaining) || limit <= 0) return null;
    return {
      quota: null,
      expiresAt: null,
      window24h: null,
      allowance: {
        label: 'Rate window',
        usedPct: Math.max(0, Math.min(100, ((limit - remaining) / limit) * 100)),
        resetsAt: githubmodelsResetMs(h['x-ratelimit-reset']),
      },
      plan: null,
    };
  },

  // No usage endpoint: probe with a one-token chat on one of the key's own
  // models and read the answer's headers (the TokenHarbor pattern).
  async fetchKeyUsage({ apiKey, baseUrl, apiRequest }) {
    const auth = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
    const modelsRes = await apiRequest({ url: `${baseUrl}/models`, method: 'GET', headers: auth, timeoutMs: 20000 });
    const fromModels = this.readUsageHeaders(modelsRes.headers);
    if (fromModels) return fromModels;
    let ids = [];
    try {
      const parsed = JSON.parse(modelsRes.body || '{}');
      ids = (parsed.data || []).map((m) => m && m.id).filter(Boolean);
    } catch (_) { ids = []; }
    if (!ids.length) throw new Error('GitHub Models answered /models without a model to probe with');
    let lastError = null;
    for (const pick of ids.slice(0, 3)) {
      const res = await apiRequest({
        url: `${baseUrl}/chat/completions`, method: 'POST', headers: auth,
        body: JSON.stringify({ model: pick, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
        timeoutMs: 30000,
      });
      const usage = this.readUsageHeaders(res.headers);
      if (usage) return usage;
      lastError = `HTTP ${res.status}`;
    }
    throw new Error(`GitHub Models published no rate-limit headers on the probe (${lastError || 'no response'})`);
  },
};

// x-ratelimit-reset arrives as an epoch (seconds, sometimes ms); a bare
// small number or a duration string reads as a duration from now.
function githubmodelsResetMs(value) {
  if (value == null) return null;
  const n = Number(value);
  if (Number.isFinite(n)) {
    if (n > 1e12) return Math.round(n); // already ms epoch
    if (n > 1e9) return Math.round(n * 1000); // seconds epoch
    return Date.now() + n * 1000; // seconds from now
  }
  const text = String(value).trim();
  const part = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = false;
  let m;
  while ((m = part.exec(text)) !== null) {
    matched = true;
    const v = Number(m[1]);
    total += m[2] === 'ms' ? v : m[2] === 's' ? v * 1000 : m[2] === 'm' ? v * 60000 : v * 3600000;
  }
  return matched ? Date.now() + total : null;
}
