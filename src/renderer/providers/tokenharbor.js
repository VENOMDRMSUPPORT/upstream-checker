// ============================================
// Token Harbor — integrated provider module
// Registers into window.INTEGRATED_PROVIDERS; loaded before app.js.
// meta is plain data (structuredClone-safe); fetchModels lives only here.
// ============================================
window.INTEGRATED_PROVIDERS = window.INTEGRATED_PROVIDERS || {};

// Virtual models route each request to real upstream models and bill for those,
// so their own zero price says nothing about what a call costs.
const TOKENHARBOR_VIRTUAL_OWNER = 'tokenharbor-virtual';

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
  },

  // Free models only. Token Harbor's /models carries per-model USD pricing, and
  // its free tier is the set priced at zero on both input and output (published
  // as `<model>:free` twins of the paid ids). A model with missing or partial
  // pricing is treated as paid: a test run must never spend the account's credit.
  async fetchModels({ apiKey, baseUrl, apiRequest, formatContext, getFreeGroupName }) {
    const result = await apiRequest({
      url: `${baseUrl}/models`,
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    });
    if (result.status !== 200) throw new Error(`HTTP ${result.status}`);
    const all = JSON.parse(result.body).data || [];

    const isZero = (v) => v !== null && v !== undefined && v !== '' && Number(v) === 0;
    const isFree = (m) =>
      m.owned_by !== TOKENHARBOR_VIRTUAL_OWNER &&
      isZero(m.pricing?.input_usd_per_1m) &&
      isZero(m.pricing?.output_usd_per_1m);

    return all
      .filter(isFree)
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
};
