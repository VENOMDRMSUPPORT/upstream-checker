// ============================================
// OpenRouter — integrated provider module
// Registers into window.INTEGRATED_PROVIDERS; loaded before app.js.
// ============================================
// Evidence: docs/integrations/OPENROUTER.md (limits documentation verified
// 2026-11-11, plus a live keyless probe of GET /api/v1/models the same
// day). OpenAI-compatible: GET /models, POST /chat/completions, Bearer key.
//
// No custom code: the standard contract is the whole integration. The
// free-tier facts in meta are the ones that shape routing: model ids
// ending in :free cost $0, capped per ACCOUNT (20 req/min, 50 req/day,
// rising to 1,000 req/day after $10 of lifetime credit purchases) — extra
// keys add nothing and failed attempts count.
window.INTEGRATED_PROVIDERS = window.INTEGRATED_PROVIDERS || {};

window.INTEGRATED_PROVIDERS.openrouter = {
  meta: {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    color: '#94a3b8',
    logo: '../assets/providers/openrouter.svg',
    modelsEndpoint: '/models',
    chatEndpoint: '/chat/completions',
    auth: ['apikey'],
    website: 'https://openrouter.ai',

    // A free tier exists (drives the Free Tier legend colour).
    freeTier: true,
    planNote: 'Free models (:free) · 20 req/min · 50 req/day per account',
    docsSource: 'OPENROUTER.md (verified 2026-11-11)',
    verifiedOn: '2026-11-11',

    rpm: 20,
    rateLimits: {
      source: 'https://openrouter.ai/docs/api-reference/limits',
      lines: [
        { label: ':free models', value: '20 req/min · 50 req/day per account' },
        { label: 'After $10 of credits, once', value: '20 req/min · 1,000 req/day' },
        { label: 'Accounting', value: 'Failed attempts count; extra keys do not raise the cap' },
      ],
    },
  },
};
