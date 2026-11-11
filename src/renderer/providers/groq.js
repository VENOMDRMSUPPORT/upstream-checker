// ============================================
// Groq — integrated provider module
// Registers into window.INTEGRATED_PROVIDERS; loaded before app.js.
// ============================================
// Evidence: docs/integrations/GROQ.md (provider documentation verified
// 2026-11-11). OpenAI-compatible: GET /models, POST /chat/completions,
// Bearer key from console.groq.com.
//
// The standard contract is the integration (the shared default discovery
// asks every active key and records which keys served each model); the
// custom code is the key-usage reading at the bottom — Groq publishes no
// usage endpoint, but every chat answer carries the key's rate window in
// its headers. The free-tier facts live in meta so the drawer and
// the catalog legend tell the truth: Free Plan limits are per model and
// apply to the whole organization, so every key shares one pool.
window.INTEGRATED_PROVIDERS = window.INTEGRATED_PROVIDERS || {};

window.INTEGRATED_PROVIDERS.groq = {
  meta: {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    color: '#f55036',
    logo: '../assets/providers/groq.svg',
    modelsEndpoint: '/models',
    chatEndpoint: '/chat/completions',
    auth: ['apikey'],
    website: 'https://console.groq.com',

    // A free tier exists (drives the Free Tier legend colour).
    freeTier: true,
    planNote: 'Free Plan · per-model limits, one pool per organization',
    docsSource: 'GROQ.md (verified 2026-11-11)',
    verifiedOn: '2026-11-11',

    rpm: 30,
    rateLimits: {
      source: 'https://console.groq.com/docs/rate-limits',
      lines: [
        { label: 'Small models', value: '30 req/min · 14,400 req/day · 500K tokens/day' },
        { label: 'Large models', value: '30 req/min · 1,000 req/day · 200K tokens/day' },
        { label: 'Pool', value: 'Limits apply to the whole organization — every key shares them' },
      ],
    },
  },

  // Every chat answer carries the key's current rate window (verified live
  // 2026-11-11 on a free key, one-token chat):
  //   x-ratelimit-limit-tokens     "8000"      x-ratelimit-limit-requests     "1000"
  //   x-ratelimit-remaining-tokens "7927"      x-ratelimit-remaining-requests "999"
  //   x-ratelimit-reset-tokens     "547ms"     x-ratelimit-reset-requests     "1m26.4s"
  // Resets are durations, not timestamps. GET /models carries NONE of these
  // headers (verified the same day), so a reading needs a chat response —
  // fetchKeyUsage probes with a one-token call, and readUsageHeaders keeps
  // the reading current for free off any run's responses. Tokens are the
  // binding constraint for chat, so the allowance is read from them.
  readUsageHeaders(headers) {
    if (!headers) return null;
    const h = {};
    Object.entries(headers).forEach(([k, v]) => { h[String(k).toLowerCase()] = v; });
    const limit = Number(h['x-ratelimit-limit-tokens']);
    const remaining = Number(h['x-ratelimit-remaining-tokens']);
    if (!Number.isFinite(limit) || !Number.isFinite(remaining) || limit <= 0) return null;
    const resetMs = groqResetMs(h['x-ratelimit-reset-tokens']) ?? groqResetMs(h['x-ratelimit-reset-requests']);
    return {
      quota: null,
      expiresAt: null,
      window24h: null,
      allowance: {
        label: 'Rate window',
        usedPct: Math.max(0, Math.min(100, ((limit - remaining) / limit) * 100)),
        resetsAt: resetMs != null ? Date.now() + resetMs : null,
      },
      plan: null,
    };
  },

  async fetchKeyUsage({ apiKey, baseUrl, apiRequest }) {
    const auth = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
    const modelsRes = await apiRequest({ url: `${baseUrl}/models`, method: 'GET', headers: auth, timeoutMs: 20000 });
    // A future Groq may publish the window on /models too; read it if so.
    const fromModels = this.readUsageHeaders(modelsRes.headers);
    if (fromModels) return fromModels;
    let ids = [];
    try {
      const parsed = JSON.parse(modelsRes.body || '{}');
      ids = (parsed.data || []).map((m) => m && m.id).filter(Boolean);
    } catch (_) { ids = []; }
    if (!ids.length) throw new Error('Groq answered /models without a model to probe with');
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
    throw new Error(`Groq published no rate-limit headers on the probe (${lastError || 'no response'})`);
  },
};

// Groq reset headers are Go-style durations ("547ms", "1m26.4s", "2s");
// a bare number reads as seconds. Returns ms, or null when unreadable.
function groqResetMs(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text) * 1000;
  const part = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = false;
  let m;
  while ((m = part.exec(text)) !== null) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : m[2] === 'm' ? n * 60000 : n * 3600000;
  }
  return matched ? total : null;
}
