// ============================================
// MIRAI API — integrated provider module
// Registers into window.INTEGRATED_PROVIDERS; loaded before app.js.
// ============================================
window.INTEGRATED_PROVIDERS = window.INTEGRATED_PROVIDERS || {};

window.INTEGRATED_PROVIDERS.mirai = {
  meta: {
    id: 'mirai',
    name: 'Mirai API',
    baseUrl: 'https://api.miraiapi.com/v1',
    color: '#f97316',
    logo: '../assets/providers/mirai.svg',
    modelsEndpoint: '/models',
    chatEndpoint: '/chat/completions',
  },

  // Mirai is OpenAI-compatible, so app.js's default discovery handles the fetch.
  // What is unusual here is that its keys unlock different catalogues — one key
  // returns the Chinese models, another the Claude and GPT ones. That isn't a
  // provider quirk to special-case: discovery asks every active key and records
  // which ones served each model, and a test is then sent on a key that actually
  // has it. Asking for claude-opus-5 with the Chinese-models key would 404 and
  // record a working model as broken.
};
