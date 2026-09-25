// ============================================
// INCEPTION LABS — integrated provider module
// Registers into window.INTEGRATED_PROVIDERS; loaded before app.js.
// ============================================
window.INTEGRATED_PROVIDERS = window.INTEGRATED_PROVIDERS || {};

window.INTEGRATED_PROVIDERS.inception = {
  meta: {
    id: 'inception',
    name: 'Inception Labs',
    baseUrl: 'https://api.inceptionlabs.ai/v1',
    color: '#f9f6ef',
    logo: '../assets/providers/inception.svg',
    // A light mark drawn for dark surfaces; re-inked dark on the light theme.
    logoTone: 'mono',
    modelsEndpoint: '/models',
    chatEndpoint: '/chat/completions',

    // Documented: 1,000 requests/minute on Free, 3,000 on Pay As You Go. Far
    // above anything a test run does, but stating it means a large catalogue
    // still gets paced correctly rather than relying on the cap being distant.
    rpm: 1000,

    // A Free plan exists (drives the Free Tier legend colour).
    freeTier: true,

    // Inception's own examples use max_completion_tokens. Declaring it here
    // skips the one rejected request the app would otherwise spend learning it.
    tokenLimitField: 'max_completion_tokens',
  },

  // Mercury is a family of diffusion LLMs, and not all of them speak
  // /chat/completions: Mercury Edit serves /fim/completions and
  // /edit/completions instead. If one ever appears in the chat model list,
  // testing it here would report a working model as broken — same failure the
  // image and video generators cause elsewhere, for the same reason.
  excludeModel(model) {
    return /\bedit\b|\bfim\b/i.test(`${model.id || ''} ${model.display_name || ''}`);
  },
};
