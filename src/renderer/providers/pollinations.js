// ============================================
// Pollinations — integrated provider module
// Registers into window.INTEGRATED_PROVIDERS; loaded before app.js.
// ============================================
// Evidence: docs/integrations/POLLINATIONS.md (provider material verified
// 2026-11-11, plus live keyless probes: GET gen.pollinations.ai/v1/models
// answered in OpenAI shape). OpenAI-compatible: GET /models,
// POST /chat/completions, Bearer key (sk_).
//
// No custom code: the standard contract is the whole integration.
// Pollinations used to be the keyless provider; that lane is legacy now
// (one anonymous-tier model, intermittent 402s). The current API is keyed
// and priced in Pollen (1 Pollen = $1); the free value is Quest Pollen —
// small one-off rewards for creating a key and trying each model type.
window.INTEGRATED_PROVIDERS = window.INTEGRATED_PROVIDERS || {};

window.INTEGRATED_PROVIDERS.pollinations = {
  meta: {
    id: 'pollinations',
    name: 'Pollinations',
    baseUrl: 'https://gen.pollinations.ai/v1',
    color: '#fbbf24',
    logo: '../assets/providers/pollinations.svg',
    modelsEndpoint: '/models',
    chatEndpoint: '/chat/completions',
    auth: ['apikey'],
    website: 'https://pollinations.ai',

    // Free starter credit exists (drives the Free Tier legend colour).
    freeTier: true,
    planNote: 'Quest Pollen free credit · models priced in Pollen (1 Pollen = $1)',
    docsSource: 'POLLINATIONS.md (verified 2026-11-11)',
    verifiedOn: '2026-11-11',

    rateLimits: {
      source: 'https://gen.pollinations.ai',
      lines: [
        { label: 'Getting started', value: 'Free Quest Pollen (about 3 Pollen) for creating a key and trying each model type — no card' },
        { label: 'Pricing', value: 'Each model is priced in Pollen per token; the catalog endpoint lists current prices' },
        { label: 'Legacy lane', value: 'The keyless text.pollinations.ai endpoint is legacy and shrinking — this entry uses the keyed API' },
      ],
    },
  },
};
