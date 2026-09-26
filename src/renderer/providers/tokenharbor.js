// ============================================
// Token Harbor — integrated provider module
// Registers into window.INTEGRATED_PROVIDERS; loaded before app.js.
// meta is plain data (structuredClone-safe); fetchModels lives only here.
// ============================================
window.INTEGRATED_PROVIDERS = window.INTEGRATED_PROVIDERS || {};

// Virtual models route each request to real upstream models and bill for those,
// so their own zero price says nothing about what a call costs.
const TOKENHARBOR_VIRTUAL_OWNER = 'tokenharbor-virtual';

const tokenharborIsZero = (v) => v !== null && v !== undefined && v !== '' && Number(v) === 0;
const tokenharborIsFree = (m) =>
  m.owned_by !== TOKENHARBOR_VIRTUAL_OWNER &&
  tokenharborIsZero(m.pricing?.input_usd_per_1m) &&
  tokenharborIsZero(m.pricing?.output_usd_per_1m);

// The free tier is a rolling 7-day allowance per key. Once it is spent, every
// free model answers 429 with code free_tier_limit_reached and a message that
// names the reset:
//   "You've used this period's free allowance. Your next rolling 7-day period
//    starts on 26 Sep 2026 at 06:42 UTC. Use the paid model ..."
// /models keeps answering 200, so only a completion can tell.
const TOKENHARBOR_QUOTA_CODE = 'free_tier_limit_reached';

function tokenharborResetAt(message) {
  const m = /starts on (\d{1,2} [A-Za-z]{3,9} \d{4}) at (\d{1,2}:\d{2}) UTC/.exec(message || '');
  const t = m ? Date.parse(`${m[1]} ${m[2]} UTC`) : NaN;
  return Number.isFinite(t) ? t : null;
}

// The key's free models: the explicit :free ids its /models prices at zero.
// Every one of them is served on the free allowance (checked 2026-09-26 on a
// spent key: all answered free_tier_limit_reached or 200, none billed). The
// public Models page lists fewer under Free, so it is not used to narrow this.
async function tokenharborKeyFree({ apiKey, baseUrl, apiRequest }) {
  const list = await apiRequest({
    url: `${baseUrl}/models`,
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    timeoutMs: 20000,
  });
  if (list.status !== 200) throw new Error(`HTTP ${list.status}`);
  return (JSON.parse(list.body).data || []).filter(tokenharborIsFree);
}

window.INTEGRATED_PROVIDERS.tokenharbor = {
  meta: {
    id: 'tokenharbor',
    name: 'Token Harbor',
    baseUrl: 'https://tokenharbor.ai/v1',
    color: '#e64980',
    logo: '../assets/providers/tokenharbor.svg',
    // A light mark drawn for dark surfaces; re-inked dark on the light theme.
    logoTone: 'mono',
    modelsEndpoint: '/models',
    chatEndpoint: '/chat/completions',

    // Offers free models or a free quota (drives the Free Tier legend colour).
    freeTier: true,

    // docs/api/rate-limits: free accounts get 60 requests/minute and 1,800/hour
    // per account, shared across all its keys and models (plus 100/minute and
    // 3,000/hour per IP); paid accounts (a Pass or a topped-up wallet) have no
    // request-rate limit, and concurrency is unlimited on every plan. Going
    // over answers 429 with Retry-After, which the run waits out. The app
    // paces per key, so two keys of one free account can still meet the
    // shared cap; the 429 path covers that.
    rpm: 60,
    // Shown by the Rate limit badge's info button, as documented.
    rateLimits: {
      source: 'https://tokenharbor.ai/docs/api/rate-limits',
      lines: [
        { label: 'Free account', value: '60 requests/min and 1,800/hour — per account, shared by all its keys and models' },
        { label: 'Per IP address', value: '100 requests/min and 3,000/hour' },
        { label: 'Image generation', value: '10 requests/min and 150/hour' },
        { label: 'Paid account', value: 'No request-rate limit (an active Pass or a topped-up wallet)' },
        { label: 'Concurrency', value: 'Unlimited on every plan' },
        { label: 'When exceeded', value: 'HTTP 429 with a Retry-After header' },
      ],
    },
  },

  // Free models only: the key's :free ids. Token Harbor's /models carries
  // per-model USD pricing, and a model with missing or partial pricing is
  // treated as paid: a test run must never spend the account's credit.
  async fetchModels({ apiKey, baseUrl, apiRequest, formatContext, getFreeGroupName }) {
    const free = await tokenharborKeyFree({ apiKey, baseUrl, apiRequest });
    return free
      .map((m) => ({
        id: m.id,
        name: m.label || m.id,
        isFree: true,
        isFreeForPaid: false,
        noPlans: false,
        groupName: getFreeGroupName('free'),
        hasVision: false,
        hasReasoning: false,
        context_window: m.context_length || null,
        contextLabel: formatContext(m.context_length),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  },

  // A failed request's error, read as "this key's allowance is spent":
  // { until, message } for the free-tier limit, null for anything else.
  readQuotaError({ code, message }) {
    if (code !== TOKENHARBOR_QUOTA_CODE) return null;
    return { until: tokenharborResetAt(message), message };
  },

  // Every chat answer carries the key's free allowance in its headers:
  //   x-th-free-used-pct  "0".."100"
  //   x-th-free-resets    ISO time the rolling 7-day period ends (per key)
  //   x-th-plan           "free", or the Pass the account is on
  // Read here into key-usage.js's shape, or null when they are absent.
  readUsageHeaders(headers) {
    if (!headers) return null;
    const used = Number(headers['x-th-free-used-pct']);
    const resets = Date.parse(headers['x-th-free-resets'] || '');
    if (!Number.isFinite(used) && !Number.isFinite(resets)) return null;
    return {
      quota: null,
      expiresAt: null,
      window24h: null,
      allowance: {
        label: 'Free allowance',
        usedPct: Number.isFinite(used) ? Math.max(0, Math.min(100, used)) : null,
        resetsAt: Number.isFinite(resets) ? resets : null,
      },
      plan: headers['x-th-plan'] || null,
    };
  },

  // There is no usage endpoint for API keys (the dashboard's /api/me/* needs a
  // web login), so the allowance is read off a one-token request to one of the
  // key's own free models (from its /models, never a fixed slug). A spent
  // allowance answers 429 free_tier_limit_reached with the same headers; that
  // is still a reading, with `probe` saying which model was refused.
  async fetchKeyUsage({ apiKey, baseUrl, apiRequest }) {
    const pick = (await tokenharborKeyFree({ apiKey, baseUrl, apiRequest })).map((m) => m.id).sort()[0];
    if (!pick) throw new Error('No free model on this key to read the allowance from');
    const res = await apiRequest({
      url: `${baseUrl}/chat/completions`,
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: pick, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      timeoutMs: 30000,
    });
    let err = {};
    try { err = JSON.parse(res.body).error || {}; } catch (_) {}
    const quota = res.status >= 400 ? this.readQuotaError({ code: err.code || err.type, message: err.message }) : null;
    let usage = this.readUsageHeaders(res.headers);
    // The spent answer (429) carries no x-th-* headers, only Retry-After: the
    // reading is then built from the refusal itself — all used, renewing at
    // the time the message names (or Retry-After from now).
    if (!usage && quota) {
      const retry = Number(res.headers && res.headers['retry-after']);
      usage = {
        quota: null,
        expiresAt: null,
        window24h: null,
        allowance: {
          label: 'Free allowance',
          usedPct: 100,
          resetsAt: quota.until || (Number.isFinite(retry) && retry > 0 ? Date.now() + retry * 1000 : null),
        },
        plan: null,
      };
    }
    if (!usage) {
      throw new Error(err.message || (res.networkError ? 'Unreachable' : `HTTP ${res.status}`));
    }
    if (quota) usage.probe = { model: pick, status: res.status, ...quota };
    return usage;
  },
};
