// ============================================
// APINEX — integrated provider module
// Registers into window.INTEGRATED_PROVIDERS; loaded before app.js.
// meta is plain data (structuredClone-safe); fetchModels lives only here.
// ============================================
// Evidence: docs/integrations/APINEX.md (live probes 2026-10-11).
// OpenAI-compatible: GET /v1/models (36 ids), POST /v1/chat/completions,
// GET /v1/subscription (plan + token quota), GET /v1/balance (USD).
//
// The trap this module exists for: a free-tier key may call only the models
// the public models endpoint flags allowFree — anything else answers
// 402 "Insufficient balance", because allowFree-false ids draw on the key's
// USD balance. Subscription keys get the full roster. The roster itself
// changes (healthCheckedAt), so it is never hardcoded: the allowFree flags
// are fetched live at discovery.
window.INTEGRATED_PROVIDERS = window.INTEGRATED_PROVIDERS || {};

// Public (no-auth) web base. The /v1 base is the API; these live on the site.
const APINEX_WEB_BASE = 'https://apinex.bond';

window.INTEGRATED_PROVIDERS.apinex = {
  meta: {
    id: 'apinex',
    name: 'Apinex',
    baseUrl: 'https://api.apinex.bond/v1',
    // Passed to fetchModels by discoverModels (provider-models.js), same door
    // nara.js uses for its public pricing endpoints.
    pricingUrl: `${APINEX_WEB_BASE}/api/public/models`,
    color: '#22d3ee',
    logo: '../assets/providers/apinex.png',
    modelsEndpoint: '/models',
    chatEndpoint: '/chat/completions',

    // A free tier exists (drives the Free Tier legend colour).
    freeTier: true,
    // docs-sourced APINEX.md §0: FREE tier 10M tokens/day resetting 00:00 UTC;
    // subscription plans are a tokenLimit quota for the plan's days period.
    planNote: 'FREE tier · 10M tokens/day',
    docsSource: 'APINEX.md §0',

    // Worst case paces the run: a free key answers 5 requests/minute
    // (subscription keys get 30, and subscriberPriority true may make them
    // faster still). The badge tells the whole story.
    rpm: 5,
    rateLimits: {
      source: 'https://apinex.bond/api/public/rate-limits',
      lines: [
        { label: 'Free key', value: '5 requests/min · 10M tokens/day, resets 00:00 UTC' },
        { label: 'Subscription key', value: '30 requests/min · tokenLimit quota for the plan period' },
        { label: 'Subscribers', value: 'Priority queue over free keys' },
      ],
    },
  },

  // Discovery per key tier. The key's own /v1/models answers 36 ids either
  // way, so the tier is read from /v1/subscription and the allowFree flags
  // from the public models endpoint:
  //   free key          → only allowFree ids (25 today), tagged FREE
  //   subscription key  → the full roster, quota-based, none tagged FREE
  // The free set is decided per key because that is what the catalog must
  // show: a model tagged FREE on a subscription key would promise a price
  // that key does not pay, and one left untagged on a free key would hide
  // the only models that key can call.
  async fetchModels({ apiKey, baseUrl, pricingUrl, apiRequest, formatContext, getFreeGroupName }) {
    const auth = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
    const [rosterRes, subRes, publicRes] = await Promise.all([
      apiRequest({ url: `${baseUrl}/models`, method: 'GET', headers: auth, timeoutMs: 20000 }),
      apiRequest({ url: `${baseUrl}/subscription`, method: 'GET', headers: auth, timeoutMs: 20000 }),
      apiRequest({ url: pricingUrl, method: 'GET', headers: { 'Content-Type': 'application/json' }, timeoutMs: 20000 }),
    ]);
    if (rosterRes.status !== 200) {
      throw new Error(`Apinex /models HTTP ${rosterRes.status}: ${String(rosterRes.body || '').slice(0, 120)}`);
    }
    let roster;
    try { roster = JSON.parse(rosterRes.body).data; } catch (_) { roster = null; }
    if (!Array.isArray(roster)) throw new Error('Apinex /models answered without a model list');

    // The tier decides who is FREE. A subscription answer that cannot be read
    // must not silently upgrade the key to paid — treat it as free, the safe
    // side of the 402.
    let subscription = false;
    if (subRes.status === 200) {
      try { subscription = JSON.parse(subRes.body).mode === 'subscription'; } catch (_) { /* free */ }
    }

    // allowFree comes from the public endpoint and changes without notice, so
    // a fetch that fails leaves no fallback roster to guess from: a free key
    // shows nothing rather than being offered balance-consuming ids. A
    // subscription key never needed the flags and carries on.
    let allowFree = null;
    if (publicRes.status === 200) {
      try {
        const published = JSON.parse(publicRes.body).models || [];
        allowFree = new Set(published.filter((m) => m.allowFree === true).map((m) => m.id));
      } catch (_) { /* handled below */ }
    }
    if (!subscription && !(allowFree instanceof Set)) {
      throw new Error('Apinex public models endpoint unreachable — cannot tell which models a free key may call');
    }

    return roster
      .filter((m) => subscription || allowFree.has(m.id))
      .map((m) => {
        const ctx = m.context_window ?? m.context_length ?? null;
        return {
          id: m.id,
          name: m.display_name || m.id,
          isFree: !subscription,
          isFreeForPaid: false,
          noPlans: false,
          groupName: subscription ? 'MODELS' : getFreeGroupName('free'),
          hasVision: false,
          hasReasoning: false,
          context_window: ctx,
          contextLabel: formatContext(ctx),
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  },

  // GET /v1/subscription is the key's quota, verified live on both tiers
  // (APINEX.md §3/§8): token_limit / tokens_used / tokens_remaining, with
  // resets_at_utc (free: 00:00 UTC daily) and expires_at_utc (subscription:
  // the plan's last day). Balance USD is informational — the router's runs
  // spend tokens, not dollars — so it is not fetched.
  async fetchKeyUsage({ apiKey, baseUrl, apiRequest }) {
    const res = await apiRequest({
      url: `${baseUrl}/subscription`, method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeoutMs: 20000,
    });
    if (res.status !== 200) {
      throw new Error(`Apinex /subscription HTTP ${res.status}: ${String(res.body || '').slice(0, 120)}`);
    }
    let d;
    try { d = JSON.parse(res.body); } catch (_) { d = null; }
    if (!d || d.object !== 'subscription') throw new Error('Apinex answered without a subscription object');
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    const total = num(d.token_limit);
    const remaining = num(d.tokens_remaining);
    const at = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : null; };
    return {
      // A free key and a subscription key both report the same token-shaped
      // quota; a plan with unlimited would answer token_limit null, which
      // maps to "no quota published" rather than a zeroed bar.
      quota: total > 0 && remaining != null
        ? { total, remaining: Math.max(0, remaining), unit: 'tokens' }
        : null,
      // A subscription key expires with its plan; a free key instead renews
      // daily — its expiry field is null and the reset is the meaningful date.
      expiresAt: at(d.expires_at_utc) || at(d.resets_at_utc),
      window24h: null,
      plan: d.plan_label || d.plan || d.mode || null,
    };
  },
};
