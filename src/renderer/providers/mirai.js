// ============================================
// MIRAI API — integrated provider module
// Registers into window.INTEGRATED_PROVIDERS; loaded before app.js.
// ============================================
window.INTEGRATED_PROVIDERS = window.INTEGRATED_PROVIDERS || {};

window.INTEGRATED_PROVIDERS.mirai = {
  meta: {
    id: 'mirai',
    name: 'Mirai API',
    baseUrl: 'https://api.miraiapi.com/v1',
    color: '#f97316',
    logo: '../assets/providers/mirai.svg',
    modelsEndpoint: '/models',
    chatEndpoint: '/chat/completions',
  },

  // Mirai is OpenAI-compatible, so app.js's default discovery handles the fetch.
  // What is unusual here is that its keys unlock different catalogues — one key
  // returns the Chinese models, another the Claude and GPT ones. That isn't a
  // provider quirk to special-case: discovery asks every active key and records
  // which ones served each model, and a test is then sent on a key that actually
  // has it. Asking for claude-opus-5 with the Chinese-models key would 404 and
  // record a working model as broken.
};

// ---- Key usage: quota, expiry, the last 24 hours and request history ----
// Mirai's usage API is a small session. POST /api/usage/check with the key
// answers the usage and sets a mirai_usage_session cookie (7 days);
// /api/usage/refresh and /api/usage/history then take the cookie instead of
// the key. An unknown key gets 404 "invalid api key", a lapsed session 401
// "usage session expired". Quota is tokens weighted by each model's ratio
// (packages are sold as quota_tokens), so it is reported in tokens.
(() => {
  const COOKIE = 'mirai_usage_session';
  // Session cookie per key, in memory only: it stands in for the key, so it
  // is never written to disk and is gone when the app closes.
  const sessions = new Map();

  const usageBase = (baseUrl) => `${new URL(baseUrl).origin}/api/usage`;

  function readJson(res) {
    try { return JSON.parse(res.body); } catch (_) { return null; }
  }

  function failure(res, body) {
    const text = body && body.message
      ? body.message
      : res.networkError ? (res.timedOut ? 'No response' : 'Unreachable') : `HTTP ${res.status}`;
    const err = new Error(text.charAt(0).toUpperCase() + text.slice(1));
    err.status = res.status;
    return err;
  }

  // The session value from Set-Cookie: a string when one is set, null when it
  // is cleared (Max-Age=0 with an empty value), undefined when not mentioned.
  function sessionFrom(res) {
    const raw = res.headers && res.headers['set-cookie'];
    for (const line of Array.isArray(raw) ? raw : raw ? [raw] : []) {
      const m = new RegExp(`^${COOKIE}=([^;]*)`).exec(line);
      if (m) return m[1] || null;
    }
    return undefined;
  }

  function post(ctx, path, payload, session) {
    const headers = { 'Content-Type': 'application/json' };
    if (session) headers.Cookie = `${COOKIE}=${session}`;
    return ctx.apiRequest({
      url: `${usageBase(ctx.baseUrl)}${path}`,
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      timeoutMs: 15000,
    });
  }

  // Signs in with the key; answers the usage and keeps the session it sets.
  async function login(ctx) {
    const res = await post(ctx, '/check', { api_key: ctx.apiKey });
    const body = readJson(res);
    if (res.status !== 200 || !body || !body.success) {
      sessions.delete(ctx.apiKey);
      throw failure(res, body);
    }
    const s = sessionFrom(res);
    if (s) sessions.set(ctx.apiKey, s);
    return body.data;
  }

  // A call on the session, signing in again once if it has lapsed.
  async function onSession(ctx, path, payload) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!sessions.has(ctx.apiKey)) await login(ctx);
      const session = sessions.get(ctx.apiKey);
      if (!session) throw new Error('Mirai did not open a usage session');
      const res = await post(ctx, path, payload, session);
      const body = readJson(res);
      if (res.status === 401) {
        sessions.delete(ctx.apiKey);
        continue;
      }
      if (res.status !== 200 || !body || !body.success) throw failure(res, body);
      const renewed = sessionFrom(res);
      if (renewed) sessions.set(ctx.apiKey, renewed);
      return body.data;
    }
    throw new Error('Usage session expired');
  }

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

  function normalizeUsage(d) {
    const total = num(d.quota_total);
    const remaining = num(d.quota_remaining);
    const requests = num(d.requests_24h);
    return {
      quota: total > 0 && remaining != null ? { total, remaining: Math.max(0, remaining), unit: 'tokens' } : null,
      expiresAt: num(d.expires_at) > 0 ? num(d.expires_at) * 1000 : null,
      window24h: requests == null ? null : {
        requests,
        successRate: num(d.success_rate_24h),
        errorRate: num(d.error_rate_24h),
      },
    };
  }

  function normalizeHistory(d) {
    return {
      page: num(d.page) || 1,
      pageSize: num(d.page_size) || 20,
      total: num(d.total) || 0,
      totalPages: num(d.total_pages) || 1,
      items: (Array.isArray(d.items) ? d.items : []).map((it) => ({
        at: num(it.created_at) ? num(it.created_at) * 1000 : null,
        model: String(it.model || ''),
        ok: it.status === 'success',
        status: String(it.status || ''),
        inputTokens: num(it.prompt_tokens),
        outputTokens: num(it.completion_tokens),
        totalTokens: num(it.total_tokens),
        cost: num(it.quota),
      })),
    };
  }

  Object.assign(window.INTEGRATED_PROVIDERS.mirai, {
    async fetchKeyUsage({ apiKey, baseUrl, apiRequest }) {
      const ctx = { apiKey, baseUrl, apiRequest };
      const data = sessions.has(apiKey) ? await onSession(ctx, '/refresh', {}) : await login(ctx);
      return normalizeUsage(data || {});
    },

    async fetchKeyHistory({ apiKey, baseUrl, apiRequest, page = 1, pageSize = 20 }) {
      const data = await onSession({ apiKey, baseUrl, apiRequest }, '/history', { page, page_size: pageSize });
      return normalizeHistory(data || {});
    },
  });
})();
