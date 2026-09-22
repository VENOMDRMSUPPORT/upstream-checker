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
    color: '#00d4ff',
    modelsEndpoint: '/models',
    plansEndpoint: '/api/plans',
    chatEndpoint: '/chat/completions',
  },

  // Plan-aware discovery: keep only free / free-for-paid models.
  async fetchModels({ apiKey, baseUrl, plansUrl, apiRequest, formatContext, getFreeGroupName }) {
    const [modelsResult, plansResult] = await Promise.all([
      apiRequest({
        url: `${baseUrl}/models`,
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      }),
      apiRequest({
        url: plansUrl,
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }),
    ]);

    if (modelsResult.status !== 200) throw new Error(`HTTP ${modelsResult.status}`);
    const rawModels = JSON.parse(modelsResult.body).data || [];

    const planModels = {};
    if (plansResult.status === 200) {
      JSON.parse(plansResult.body).data?.forEach((plan) => {
        planModels[plan.code] = { name: plan.name, models: plan.models || [] };
      });
    }

    const freeIds = new Set(planModels['free']?.models || []);
    const freemiumIds = new Set(planModels['freemium']?.models || []);
    const allowedIds = new Set([...freeIds, ...freemiumIds]);

    return rawModels
      .filter((m) => allowedIds.has(m.id))
      .map((m) => {
        const isFree = freeIds.has(m.id);
        const isFreeForPaid = !isFree && freemiumIds.has(m.id);
        return {
          ...m,
          isFree,
          isFreeForPaid,
          noPlans: false,
          groupName: getFreeGroupName(isFree ? 'free' : 'freemium'),
          hasVision: !!m.vision,
          hasReasoning: !!m.reasoning,
          contextLabel: formatContext(m.context_window),
        };
      })
      .sort((a, b) => {
        if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
        return a.id.localeCompare(b.id);
      });
  },
};
