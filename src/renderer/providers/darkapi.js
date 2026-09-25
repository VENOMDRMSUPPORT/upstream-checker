// ============================================
// DARK API — integrated provider module
// Registers into window.INTEGRATED_PROVIDERS; loaded before app.js.
// ============================================
window.INTEGRATED_PROVIDERS = window.INTEGRATED_PROVIDERS || {};

window.INTEGRATED_PROVIDERS.darkapi = {
  meta: {
    id: 'darkapi',
    name: 'Dark API',
    baseUrl: 'https://darkapi.dev/v1',
    color: '#00e0a4',
    logo: '../assets/providers/darkapi.svg',
    // Light brand colours; deepened on the light theme to hold contrast.
    logoTone: 'bright',
    modelsEndpoint: '/models',
    chatEndpoint: '/chat/completions',
  },

  // No custom fetchModels: Dark API is a plain OpenAI-compatible provider with no
  // free / free-for-paid tiers, so app.js's default discovery (GET /models → show
  // every model) is used. Provider-specific discovery only lives here when a
  // provider needs it (see nara.js for the plan/pricing-aware example).
};
