// ============================================
// Catalog providers — the generic adapter
// Registers into window.INTEGRATED_PROVIDERS; loaded before app.js.
// ============================================
// Most OpenAI-compatible providers need no code at all: a base URL, a
// Bearer key and the standard /models + /chat/completions pair are the
// whole integration, and the shared default discovery already asks every
// active key and records which keys served each model. Those providers
// live here as DATA — one entry each in FREE_CATALOG below — instead of
// one hand-written module per provider. A provider graduates to its own
// module only when it genuinely needs one (a custom fetchModels, a usage
// hook, a non-OpenAI wire, an OAuth sign-in).
//
// Every entry's free-tier facts were verified against the provider's own
// documentation on the entry's verifiedOn date (the full evidence cards
// live with the production-readiness goal: PROVIDER-WAVE1-CARDS.md, and
// each provider has a page under docs/integrations/). Facts age: a stale
// verifiedOn is a prompt to re-check, not a detail to hide.
//
// Wave 1 (2026-11-11): Groq, Cerebras, Google AI Studio, OpenRouter,
// GitHub Models, Pollinations.

window.INTEGRATED_PROVIDERS = window.INTEGRATED_PROVIDERS || {};

const FREE_CATALOG = [
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    color: '#f55036',
    logo: '../assets/providers/groq.svg',
    website: 'https://console.groq.com',
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
  {
    // NOT a free tier: Cerebras's own docs describe a one-time $5 trial
    // credit behind a verified payment method, expiring after 30 days.
    // freeTier stays false so the catalog never tags its models FREE.
    id: 'cerebras',
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    color: '#ff7847',
    logo: '../assets/providers/cerebras.svg',
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
  {
    id: 'googleaistudio',
    name: 'Google AI Studio',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    color: '#4285f4',
    logo: '../assets/providers/googleaistudio.svg',
    website: 'https://aistudio.google.com',
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
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    color: '#94a3b8',
    logo: '../assets/providers/openrouter.svg',
    website: 'https://openrouter.ai',
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
  {
    id: 'githubmodels',
    name: 'GitHub Models',
    baseUrl: 'https://models.github.ai/inference',
    color: '#8250df',
    logo: '../assets/providers/githubmodels.svg',
    website: 'https://github.com/marketplace/models',
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
  {
    id: 'pollinations',
    name: 'Pollinations',
    baseUrl: 'https://gen.pollinations.ai/v1',
    color: '#fbbf24',
    logo: '../assets/providers/pollinations.svg',
    website: 'https://pollinations.ai',
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
];

for (const entry of FREE_CATALOG) {
  window.INTEGRATED_PROVIDERS[entry.id] = {
    meta: {
      modelsEndpoint: '/models',
      chatEndpoint: '/chat/completions',
      auth: ['apikey'],
      ...entry,
    },
  };
}
