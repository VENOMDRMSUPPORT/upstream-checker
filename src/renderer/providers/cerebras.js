// ============================================
// Cerebras — integrated provider module
// Registers into window.INTEGRATED_PROVIDERS; loaded before app.js.
// ============================================
// Evidence: docs/integrations/CEREBRAS.md (provider documentation verified
// 2026-11-11). OpenAI-compatible: GET /models, POST /chat/completions,
// Bearer key from cloud.cerebras.ai.
//
// No custom code: the standard contract is the whole integration.
// NOT a free tier: Cerebras's own docs describe a one-time $5 trial credit
// behind a verified payment method, expiring after 30 days — so freeTier
// stays false and the catalog never tags its models FREE. The provider is
// here for its speed, labelled honestly.
window.INTEGRATED_PROVIDERS = window.INTEGRATED_PROVIDERS || {};

window.INTEGRATED_PROVIDERS.cerebras = {
  meta: {
    id: 'cerebras',
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    color: '#ff7847',
    logo: '../assets/providers/cerebras.svg',
    modelsEndpoint: '/models',
    chatEndpoint: '/chat/completions',
    auth: ['apikey'],
    website: 'https://cloud.cerebras.ai',

    freeTier: false,
    planNote: 'Trial · $5 credit once, card required, expires in 30 days — no renewing free tier',
    docsSource: 'CEREBRAS.md (verified 2026-11-11)',
    verifiedOn: '2026-11-11',

    rpm: 5,
    rateLimits: {
      source: 'https://inference-docs.cerebras.ai/support/rate-limits',
      lines: [
        { label: 'Trial', value: '5 req/min · 1M tokens/day while the $5 credit lasts' },
        { label: 'After the trial', value: 'Paid credits only — Cerebras offers no free tier that renews' },
      ],
    },
  },
};
