// ============================================
// Google AI Studio — integrated provider module
// Registers into window.INTEGRATED_PROVIDERS; loaded before app.js.
// ============================================
// Evidence: docs/integrations/GOOGLEAISTUDIO.md (Gemini API documentation
// and terms verified 2026-11-11). This is the Gemini API key from AI
// Studio, spoken to through Google's OpenAI-compatible layer (labelled
// beta by Google): GET /models, POST /chat/completions, the API key as
// Bearer. It is NOT the Google AI Pro subscription and NOT Antigravity —
// subscription quota windows live on the account plane, not on this key.
//
// No custom code: the standard contract is the whole integration. The
// free-tier facts in meta carry the two things a user must see before
// routing real work here: limits are per project (the AI Studio console
// is authoritative), and on the unpaid tier Google may use submitted
// content to improve its products (Gemini API terms).
window.INTEGRATED_PROVIDERS = window.INTEGRATED_PROVIDERS || {};

window.INTEGRATED_PROVIDERS.googleaistudio = {
  meta: {
    id: 'googleaistudio',
    name: 'Google AI Studio',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    color: '#4285f4',
    logo: '../assets/providers/googleaistudio.svg',
    modelsEndpoint: '/models',
    chatEndpoint: '/chat/completions',
    auth: ['apikey'],
    website: 'https://aistudio.google.com',

    // A free tier exists (drives the Free Tier legend colour).
    freeTier: true,
    planNote: 'Free tier · per-project limits — the AI Studio console is authoritative',
    docsSource: 'GOOGLEAISTUDIO.md (verified 2026-11-11)',
    verifiedOn: '2026-11-11',

    rpm: 10,
    rateLimits: {
      source: 'https://aistudio.google.com/rate-limit',
      lines: [
        { label: 'Flash models', value: 'About 10–15 req/min · about 1,500 req/day per project' },
        { label: 'Reset', value: 'Daily quota resets at midnight Pacific' },
        { label: 'Privacy', value: 'On the free tier Google may use submitted content to improve its products (Gemini API terms); the paid tier is exempt' },
      ],
    },
  },
};
