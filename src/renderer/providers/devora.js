// ============================================
// DEVORA — integrated provider module
// Registers into window.INTEGRATED_PROVIDERS; loaded before app.js.
// ============================================
// HeX-verified 2026-10-13: base https://api.devora.my.id/v1 is
// OpenAI-compatible (GET /v1/models, POST /v1/chat/completions).
// GET /v1/models with key = 200, 1 model:
//   devora-01/deepseek/deepseek-v4.1-flash (DeepSeek V4.1 Flash,
//   ctx 1000000, caps reasoning+tools,
//   pricing credits_per_million in 400 / out 1000).
// No-auth GET /v1/models = 401 invalid_api_key (HeX-verified).
// POST chat that model max_tokens 2 = 200 with usage (HeX-verified).
// Site devora.my.id = 200 landing, no favicon (HeX-verified).
// User-reported (UNVERIFIED): event unlimited, 7 days left.
//
// Default discovery handles this provider: app.js readContextWindow reads
// context_length (1000000), readsReasoning/readsTools read caps
// reasoning+tools. credits_per_million pricing is NOT read by
// src/catalog/row.js readPricing, but under the event-unlimited plan
// (user-reported) per-token pricing is informational, same as
// jerouter.js/nexum.js which carry no fetchModels — so no custom
// fetchModels here. Add one only if live /models shows a field the
// default misreads into a wrong (not merely unknown) value.
// ============================================
window.INTEGRATED_PROVIDERS = window.INTEGRATED_PROVIDERS || {};

window.INTEGRATED_PROVIDERS.devora = {
  meta: {
    id: 'devora',
    name: 'Devora',
    baseUrl: 'https://api.devora.my.id/v1',
    color: '#12b3a4',
    logo: '../assets/providers/devora.svg',
    logoTone: 'bright',
    // Free event plan (user-reported, UNVERIFIED — drives the Free Tier legend colour).
    freeTier: true,
    // docs-sourced DEVORA.md §0: Event unlimited plan (user-reported).
    planNote: 'Event unlimited · free',
    // docs-sourced DEVORA.md §0
    docsSource: 'DEVORA.md §0',
    modelsEndpoint: '/models',
    chatEndpoint: '/chat/completions',
    // User-reported (UNVERIFIED) event unlimited plan: usage is
    // informational, no published per-key quota to pace runs against.
    // Mirrors jerouter.js/nexum.js billing + unlimitedUsage shape.
    billing: {
      plan: 'Event unlimited',
      interval: 'event',
      usage: 'unlimited',
      usageLabel: 'Event unlimited',
    },
    unlimitedUsage: {
      label: 'Event plan',
      range: '0 → ∞ tokens',
      detail: 'Unlimited model usage · event plan (user-reported, 7 days left)',
    },
  },

  // Default discovery: GET /v1/models returns OpenAI-compatible data array.
};
