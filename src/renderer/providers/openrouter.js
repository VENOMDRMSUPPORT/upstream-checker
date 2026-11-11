// ============================================
// OpenRouter — integrated provider module
// Registers into window.INTEGRATED_PROVIDERS; loaded before app.js.
// ============================================
// Evidence: docs/integrations/OPENROUTER.md (limits documentation verified
// 2026-11-11, plus a live keyless probe of GET /api/v1/models the same
// day). OpenAI-compatible: GET /models, POST /chat/completions, Bearer key.
//
// The standard contract is the integration; the one piece of custom code
// is fetchKeyUsage below, reading the key's own usage from GET /auth/key.
// The free-tier facts in meta are the ones that shape routing: model ids
// ending in :free cost $0, capped per ACCOUNT (20 req/min, 50 req/day,
// rising to 1,000 req/day after $10 of lifetime credit purchases) — extra
// keys add nothing and failed attempts count.
window.INTEGRATED_PROVIDERS = window.INTEGRATED_PROVIDERS || {};

window.INTEGRATED_PROVIDERS.openrouter = {
  meta: {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    color: '#94a3b8',
    logo: '../assets/providers/openrouter.svg',
    modelsEndpoint: '/models',
    chatEndpoint: '/chat/completions',
    auth: ['apikey'],
    website: 'https://openrouter.ai',

    // A free tier exists (drives the Free Tier legend colour).
    freeTier: true,
    planNote: 'Free models (:free) · 20 req/min · 50 req/day per account',
    docsSource: 'OPENROUTER.md (verified 2026-11-11)',
    verifiedOn: '2026-11-11',

    rpm: 20,
    rateLimits: {
      source: 'https://openrouter.ai/docs/api-reference/limits',
      lines: [
        { label: ':free models', value: '20 req/min · 50 req/day per account' },
        { label: 'After $10 of credits, once', value: '20 req/min · 1,000 req/day' },
        { label: 'Accounting', value: 'Failed attempts count; extra keys do not raise the cap' },
      ],
    },
  },

  // GET /auth/key is the key's own account reading, verified live
  // 2026-11-11 on a free-tier key: { data: { usage: 0.1557 (USD, lifetime),
  // limit: null, is_free_tier: true } }. A key with a credit limit reports
  // limit + limit_remaining, which maps onto the quota bar in USD; a key
  // without one has no quota to draw — the plan label is the reading.
  async fetchKeyUsage({ apiKey, baseUrl, apiRequest }) {
    const res = await apiRequest({
      url: `${baseUrl}/auth/key`, method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeoutMs: 20000,
    });
    if (res.status !== 200) {
      throw new Error(`OpenRouter /auth/key HTTP ${res.status}: ${String(res.body || '').slice(0, 120)}`);
    }
    let d;
    try { d = JSON.parse(res.body); } catch (_) { d = null; }
    const data = d && d.data;
    if (!data || typeof data !== 'object') throw new Error('OpenRouter answered without a key object');
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    const total = num(data.limit);
    const used = num(data.usage);
    const remaining = num(data.limit_remaining) ?? (total != null && used != null ? total - used : null);
    return {
      quota: total > 0 && remaining != null
        ? { total, remaining: Math.max(0, remaining), unit: 'USD' }
        : null,
      expiresAt: null,
      window24h: null,
      plan: data.is_free_tier ? 'Free tier' : null,
    };
  },
};
