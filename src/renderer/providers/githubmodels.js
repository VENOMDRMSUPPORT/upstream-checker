// ============================================
// GitHub Models — integrated provider module
// Registers into window.INTEGRATED_PROVIDERS; loaded before app.js.
// ============================================
// Evidence: docs/integrations/GITHUBMODELS.md (GitHub documentation
// verified 2026-11-11). OpenAI-compatible: GET /models,
// POST /chat/completions, a GitHub personal access token as Bearer.
//
// No custom code: the standard contract is the whole integration. Limits
// are per account AND per model (Low 15/min · 150/day, High 10/min ·
// 50/day) and GitHub's terms restrict the free tier to prototyping. One
// secondary source claims the service was retired in July 2026; that is
// uncorroborated and recorded openly in GITHUBMODELS.md — the first
// connect with a real token settles it, and removing this file removes
// the provider if it ever comes to that.
window.INTEGRATED_PROVIDERS = window.INTEGRATED_PROVIDERS || {};

window.INTEGRATED_PROVIDERS.githubmodels = {
  meta: {
    id: 'githubmodels',
    name: 'GitHub Models',
    baseUrl: 'https://models.github.ai/inference',
    color: '#8250df',
    logo: '../assets/providers/githubmodels.svg',
    modelsEndpoint: '/models',
    chatEndpoint: '/chat/completions',
    auth: ['apikey'],
    website: 'https://github.com/marketplace/models',

    // A free tier exists (drives the Free Tier legend colour).
    freeTier: true,
    planNote: 'Free prototyping tier · per-model limits, GitHub account token',
    docsSource: 'GITHUBMODELS.md (verified 2026-11-11)',
    verifiedOn: '2026-11-11',

    rpm: 10,
    rateLimits: {
      source: 'https://docs.github.com/en/github-models',
      lines: [
        { label: 'Low models', value: '15 req/min · 150 req/day' },
        { label: 'High models', value: '10 req/min · 50 req/day · 8K input / 4K output tokens per request' },
        { label: 'Scope', value: 'Per GitHub account and per model; prototyping use only under GitHub’s terms' },
      ],
    },
  },
};
