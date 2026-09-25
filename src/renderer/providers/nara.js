// ============================================
// NARA Router — integrated provider module
// Registers into window.INTEGRATED_PROVIDERS; loaded before app.js.
// meta is plain data (structuredClone-safe); fetchModels lives only here.
// ============================================
window.INTEGRATED_PROVIDERS = window.INTEGRATED_PROVIDERS || {};

window.INTEGRATED_PROVIDERS.nara = {
  meta: {
    id: 'nara',
    name: 'NARA Router',
    baseUrl: 'https://router.bynara.id/v1',
    plansUrl: 'https://router.bynara.id/api/plans',
    pricingUrl: 'https://router.bynara.id/api/pricing',
    // NaraRouter's documented default for pay-as-you-go. Editable per provider,
    // since a paid plan raises it — the app paces against this rather than
    // discovering the cap by being refused.
    rpm: 30,
    color: '#00d4ff',
    logo: '../assets/providers/nara.svg',
    // Light brand colours; deepened on the light theme to hold contrast.
    logoTone: 'bright',
    modelsEndpoint: '/models',
    plansEndpoint: '/api/plans',
    chatEndpoint: '/chat/completions',
    // NaraRouter relays Experiential's TypeSafe Jev, which refuses chat and
    // answers only on the decision route.
    decisionEndpoint: '/systemone',

    // Offers free models or a free quota (drives the Free Tier legend colour).
    freeTier: true,
  },

  // Discovery is driven entirely by NaraRouter's own data, so new models appear
  // with no code changes:
  //   - /api/pricing  → per-model `free_for_paid` flag (+ `free_min_balance`) and
  //     rich metadata (vision, reasoning, context). This is the source of truth
  //     the NaraRouter Models page uses, so it stays in sync.
  //   - /api/plans    → the genuinely-free tier = models of any plan priced at 0.
  // A model is shown if it is in the free tier OR flagged free_for_paid.
  async fetchModels({ pricingUrl, plansUrl, apiRequest, formatContext, getFreeGroupName }) {
    const [pricingResult, plansResult] = await Promise.all([
      apiRequest({ url: pricingUrl, method: 'GET', headers: { 'Content-Type': 'application/json' } }),
      apiRequest({ url: plansUrl, method: 'GET', headers: { 'Content-Type': 'application/json' } }),
    ]);

    if (pricingResult.status !== 200) throw new Error(`HTTP ${pricingResult.status}`);
    const priced = JSON.parse(pricingResult.body).data || [];

    // Free tier: union of models across any plan that costs nothing per day.
    const freeIds = new Set();
    if (plansResult.status === 200) {
      JSON.parse(plansResult.body).data?.forEach((plan) => {
        if (Number(plan.price_daily_idr) === 0) (plan.models || []).forEach((id) => freeIds.add(id));
      });
    }

    return priced
      .filter((m) => freeIds.has(m.alias) || m.free_for_paid === true)
      .map((m) => {
        const isFree = freeIds.has(m.alias);
        const isFreeForPaid = !isFree && m.free_for_paid === true;
        return {
          id: m.alias,
          name: m.display_name || m.alias,
          isFree,
          isFreeForPaid,
          noPlans: false,
          groupName: getFreeGroupName(isFree ? 'free' : 'freemium'),
          // Kept as the provider reported them; app.js reads the capability set
          // off these rather than guessing from the model's name. NaraRouter is
          // one of the few that says outright which models generate media.
          // /api/pricing has no decision flag and lists Jev as a plain text
          // model, so the family is recognised by its alias.
          supports_decisions: /^jev(\b|-)/i.test(m.alias),
          supports_vision: m.supports_vision,
          supports_image_generation: m.supports_image_generation,
          supports_video_generation: m.supports_video_generation,
          reasoning: m.reasoning,
          hasVision: !!m.supports_vision,
          hasReasoning: !!m.reasoning,
          context_window: m.max_context_tokens,
          contextLabel: formatContext(m.max_context_tokens),
          freeMinBalance: m.free_min_balance,
        };
      })
      .sort((a, b) => {
        if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
        return a.id.localeCompare(b.id);
      });
  },
};
