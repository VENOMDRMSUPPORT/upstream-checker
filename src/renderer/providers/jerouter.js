// ============================================
// JEROUTER — integrated provider module
// Registers into window.INTEGRATED_PROVIDERS; loaded before app.js.
// ============================================
// Jerouter is a paid-only, Telegram-bot-managed service ($3/month unlimited).
// Base API is OpenAI-compatible (GET /v1/models, POST /v1/chat/completions).
//
// Additional endpoints (documented for reference, not routed in core):
// - Image generation: POST /v1/images/generations with model=ig (1 gen/min)
// - Anthropic format: POST /v1/messages on base https://je.jerouter.web.id
// ============================================
window.INTEGRATED_PROVIDERS = window.INTEGRATED_PROVIDERS || {};

window.INTEGRATED_PROVIDERS.jerouter = {
  meta: {
    id: 'jerouter',
    name: 'Jerouter',
    baseUrl: 'https://je.jerouter.web.id/v1',
    color: '#f97316',
    logo: '../assets/providers/jerouter.png',
    logoTone: 'bright',
    modelsEndpoint: '/models',
    chatEndpoint: '/chat/completions',
    // Jerouter is a fixed-price monthly unlimited plan ($3/month):
    // usage is informational, no published per-key quota to pace runs against.
    billing: {
      plan: '$3 / month',
      interval: 'monthly',
      usage: 'unlimited',
      usageLabel: 'Monthly unlimited',
    },
    unlimitedUsage: {
      label: 'Monthly plan',
      range: '0 → ∞ tokens',
      detail: 'Unlimited model usage · $3 per month',
    },
  },

  // Bare modifiers name no base model, so there is nothing to resolve or benchmark.
  // Exclude them like Dark API does.
  excludeModel(model) {
    const id = String((model && model.id) || '').trim();
    return /^(unrestricted|uncensored|unsencored|abliterated|raw)$/i.test(id);
  },

  // Default discovery: GET /v1/models returns OpenAI-compatible data array.
};
