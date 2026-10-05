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
    // Unlimited usage: no request quota is published, so there is nothing to
    // fetch per key and nothing to pace runs against.
    unlimitedUsage: {
      label: 'Unlimited plan',
      range: '0 → ∞ tokens',
      detail: 'Unlimited model usage · no published request quota',
    },
  },

  // Dark API's uncensored routes are named `<base>-unrestricted`, and every one
  // of those is resolvable: the base is a model the reference carries, or a model
  // this provider serves under its full name, and the row inherits that model's
  // facts as a labelled `proxy`.
  //
  // The bare `unrestricted` is none of those. It names no base at all — it is the
  // modifier with the model left off — so there is nothing to look up, nothing to
  // inherit, and no reference row it could ever borrow from. It is not a model
  // this app can measure; it is a route that has to be excluded rather than shown
  // as a row of dashes that reads like a failure of the data.
  excludeModel(model) {
    const id = String((model && model.id) || '').trim();
    return /^(unrestricted|uncensored|unsencored|abliterated|raw)$/i.test(id);
  },

  // No custom fetchModels: Dark API is a plain OpenAI-compatible provider with no
  // free / free-for-paid tiers, so app.js's default discovery (GET /models → show
  // every model) is used. Provider-specific discovery only lives here when a
  // provider needs it (see nara.js for the plan/pricing-aware example).
};
