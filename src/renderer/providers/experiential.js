// ============================================
// Experiential Labs — integrated provider module
// Registers into window.INTEGRATED_PROVIDERS; loaded before app.js.
// meta is plain data (structuredClone-safe); fetchModels lives only here.
// ============================================
window.INTEGRATED_PROVIDERS = window.INTEGRATED_PROVIDERS || {};

window.INTEGRATED_PROVIDERS.experiential = {
  meta: {
    id: 'experiential',
    name: 'Experiential Labs',
    baseUrl: 'https://api.experientiallabs.ai/v1',
    // Public, keyless catalog: per-model metadata plus the live promotions list.
    pricingUrl: 'https://api.experientiallabs.ai/api/models',
    color: '#ededed',
    logo: '../assets/providers/experiential.svg',
    // A light mark drawn for dark surfaces; re-inked dark on the light theme.
    logoTone: 'mono',
    modelsEndpoint: '/models',
    chatEndpoint: '/chat/completions',
    // Native decision models (TypeSafe Jev) answer here, never on chat.
    decisionEndpoint: '/systemone',

    // Offers free models or a free quota (drives the Free Tier legend colour).
    freeTier: true,
  },

  // Free models only. The catalog's `promotions` array is the source of truth:
  // a promotion with `free: true` gives its slugs a free daily allowance.
  // Price is NOT a signal here — hundreds of catalog rows carry a 0 price that
  // means "unpriced", and `badge_style: 'free'` also appears on percent-off
  // promotions (e.g. deepseek-v4-flash at 50% off).
  // A model whose every deployment is a native decision model
  // (`capabilities.supports_decisions`, e.g. TypeSafe Jev) is flagged
  // `supports_decisions` so the app tests it on meta.decisionEndpoint instead of
  // chat. Model grants are per key (set by the org admin), and /v1/models is the
  // list of slugs this key is granted — decision models included — so a free
  // model missing from it would only ever answer 403 model_not_granted.
  async fetchModels({ apiKey, baseUrl, pricingUrl, apiRequest, formatContext, getFreeGroupName }) {
    const getJson = async (url, headers = {}) => {
      const res = await apiRequest({ url, method: 'GET', headers: { 'Content-Type': 'application/json', ...headers } });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      return JSON.parse(res.body);
    };

    const [callable, catalog] = await Promise.all([
      getJson(`${baseUrl}/models`, { Authorization: `Bearer ${apiKey}` }),
      getJson(`${pricingUrl}?limit=1`),
    ]);

    // The gateway accepts OpenRouter-style spellings of a slug (`<vendor>/<slug>`,
    // `<slug>:free`), so match on the bare slug and keep the key's own spelling.
    const bareSlug = (id) => id.replace(/^[^/]+\//, '').replace(/:free$/, '');
    const callableBySlug = new Map((callable.data || []).map((m) => [bareSlug(m.id), m.id]));

    const promoSlugs = [...new Set(
      (catalog.promotions || [])
        .filter((p) => p.free === true && !p.display_only)
        .flatMap((p) => p.slugs || []),
    )];

    const details = await Promise.all(
      promoSlugs.map(async (slug) => {
        try {
          return { slug, ...(await getJson(`${pricingUrl}/${encodeURIComponent(slug)}`)) };
        } catch {
          // Metadata is cosmetic; the slug itself is still a verified free model.
          return { slug, model: {}, providers: [] };
        }
      }),
    );

    const notCallable = [];
    const models = [];
    for (const { slug, model: m = {}, providers = [] } of details) {
      const decisionOnly = providers.length > 0 && providers.every((p) => p.capabilities?.supports_decisions);
      if (!callableBySlug.has(slug)) { notCallable.push(slug); continue; }

      const context = m.context_window || null;
      models.push({
        id: callableBySlug.get(slug),
        supports_decisions: decisionOnly,
        name: m.display_name || slug,
        isFree: true,
        isFreeForPaid: false,
        noPlans: false,
        groupName: getFreeGroupName('free'),
        hasVision: (m.input_modalities || []).includes('image'),
        hasReasoning: !!m.supported_params?.reasoning,
        context_window: context,
        contextLabel: formatContext(context),
      });
    }

    if (notCallable.length) {
      console.warn(`[experiential] free models not granted to this key (grant them on the platform's API keys page): ${notCallable.join(', ')}`);
    }

    return models.sort((a, b) => a.id.localeCompare(b.id));
  },
};
