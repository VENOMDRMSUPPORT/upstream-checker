// ============================================
// Groq — integrated provider module
// Registers into window.INTEGRATED_PROVIDERS; loaded before app.js.
// ============================================
// Evidence: docs/integrations/GROQ.md (provider documentation verified
// 2026-11-11). OpenAI-compatible: GET /models, POST /chat/completions,
// Bearer key from console.groq.com.
//
// No custom code: the standard contract is the whole integration, and the
// shared default discovery asks every active key and records which keys
// served each model. The free-tier facts live in meta so the drawer and
// the catalog legend tell the truth: Free Plan limits are per model and
// apply to the whole organization, so every key shares one pool.
window.INTEGRATED_PROVIDERS = window.INTEGRATED_PROVIDERS || {};

window.INTEGRATED_PROVIDERS.groq = {
  meta: {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    color: '#f55036',
    logo: '../assets/providers/groq.svg',
    modelsEndpoint: '/models',
    chatEndpoint: '/chat/completions',
    auth: ['apikey'],
    website: 'https://console.groq.com',

    // A free tier exists (drives the Free Tier legend colour).
    freeTier: true,
    planNote: 'Free Plan · per-model limits, one pool per organization',
    docsSource: 'GROQ.md (verified 2026-11-11)',
    verifiedOn: '2026-11-11',

    rpm: 30,
    rateLimits: {
      source: 'https://console.groq.com/docs/rate-limits',
      lines: [
        { label: 'Small models', value: '30 req/min · 14,400 req/day · 500K tokens/day' },
        { label: 'Large models', value: '30 req/min · 1,000 req/day · 200K tokens/day' },
        { label: 'Pool', value: 'Limits apply to the whole organization — every key shares them' },
      ],
    },
  },
};
