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
    rateLimits: {
      source: 'NaraRouter docs + /api/plans',
      lines: [
        { label: 'Free plan', value: '15 requests/min · 7M tokens/day, resets daily' },
        { label: 'Pay as you go', value: '30 requests/min (documented default)' },
        { label: 'Paid plans', value: 'Freemium 50/min · 25M/day → Ultra 60/min · 200M/day — raise the pace in Edit provider to match your plan' },
      ],
    },
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

  // TypeSafe /systemone decision protocol — lives here because the wire shape
  // is this provider family's API. app.js asks the adapter for the request
  // body (decisionProbe) and the parsed score (readDecisionAnswer); it never
  // hardcodes either. Experiential's native Jev speaks the same protocol, so
  // the two modules carry identical hooks.
  decisionProbe(model, { state, question }) {
    return {
      model: model.id,
      state,
      questions: { probe: { type: 'noul', instructions: question } },
    };
  },

  // One noul question is asked; its probability is the answer. Returns
  // { score, response } for the result row, or null when no probability came
  // back (object answer { noul } or a bare number).
  readDecisionAnswer(data) {
    const answer = data.answers?.probe;
    const score = Number(typeof answer === 'object' && answer !== null ? answer.noul : answer);
    if (answer == null || !Number.isFinite(score)) return null;
    return { score, response: `noul ${score.toFixed(2)}` };
  },

  // Discovery is driven entirely by NaraRouter's own data, so new models appear
  // with no code changes:
  //   - /api/pricing  → per-model `free_for_paid` flag (+ `free_min_balance`) and
  //     rich metadata (vision, reasoning, context). This is the source of truth
  //     the NaraRouter Models page uses, so it stays in sync.
  //   - /api/plans    → the genuinely-free tier = models of any plan priced at 0.
  // A model is shown if it is in the free tier OR flagged free_for_paid.
  //
  // IMPORTANT — `free_for_paid` without a documented rule means "the dashboard
  // may gate it on minimum balance": every such row carries the published
  // free_min_balance verbatim (shown in the tooltip), and the app never
  // invents a balance for a row that published none. A genuinely free row has
  // isFree with no gate, so FREE and FREE FOR PAID can never be confused.
  async fetchModels({ pricingUrl, plansUrl, apiRequest, formatContext, getFreeGroupName }) {
    const [pricingResult, plansResult] = await Promise.all([
      apiRequest({ url: pricingUrl, method: 'GET', headers: { 'Content-Type': 'application/json' } }),
      apiRequest({ url: plansUrl, method: 'GET', headers: { 'Content-Type': 'application/json' } }),
    ]);

    if (pricingResult.status !== 200) throw new Error(`HTTP ${pricingResult.status}`);
    const priced = JSON.parse(pricingResult.body).data || [];

    // Free tier: union of models across any plan that costs nothing per day.
    // A paid plan's own models are NOT free for the plans beneath it — the
    // genuinely-free set is exactly the zero-price plans' models.
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
        // Decision models (Jev) are chat-capable in the same way: /systemone is
        // the scored route, so the row kind reads "decision", not "chat".
        const supportsDecisions = m.supports_decisions === true || /^jev(\b|-)/i.test(m.alias || '');
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
          supports_decisions: supportsDecisions,
          supports_vision: m.supports_vision,
          supports_image_generation: m.supports_image_generation,
          supports_video_generation: m.supports_video_generation,
          reasoning: m.reasoning,
          hasVision: !!m.supports_vision,
          hasReasoning: !!m.reasoning,
          context_window: m.max_context_tokens,
          contextLabel: formatContext(m.max_context_tokens),
          // The published minimum balance that unlocks this row's free use —
          // or null when the provider published none. Shown verbatim in the
          // row tooltip; never defaulted, because a made-up gate would refuse
          // a model the provider serves.
          freeMinBalance: m.free_min_balance,
        };
      })
      .sort((a, b) => {
        if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
        return a.id.localeCompare(b.id);
      });
  },
};
