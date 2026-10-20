// ============================================
// KIOSAPI — integrated provider module
// Registers into window.INTEGRATED_PROVIDERS; loaded before app.js.
// ============================================
// Evidence: docs/integrations/KIOSAPI.md (live probes 2026-10-11).
// OpenAI-compatible: GET /v1/models (26 ids on a free key, 38 on a funded
// one), POST /v1/chat/completions, billing endpoints under
// /v1/dashboard/billing/*.
//
// No custom fetchModels: the roster already differs per key and the shared
// default discovery asks every active key and records which ones served each
// model (keyIds), so a free key and a funded key merge into one honest list
// without a special case. A model a key cannot call simply is not in that
// key's roster — the 503 model_not_found trap (KIOSAPI.md §5/§6) never
// fires on a key that was never offered the id.
//
// No fetchKeyUsage: the only billing answers are sentinel limits
// (soft/hard/system_hard_limit_usd all 100000000) and access_until 0
// (KIOSAPI.md §8) — no real quota, reset or expiry exists to show, so the
// key rows honestly report "No quota published". Plan, name and email sit
// behind /api/user/*, which takes a web session and refuses an API key.
window.INTEGRATED_PROVIDERS = window.INTEGRATED_PROVIDERS || {};

window.INTEGRATED_PROVIDERS.kiosapi = {
  meta: {
    id: 'kiosapi',
    name: 'KiosAPI',
    baseUrl: 'https://kiosapi.com/v1',
    color: '#a78bfa',
    logo: '../assets/providers/kiosapi.png',
    modelsEndpoint: '/models',
    chatEndpoint: '/chat/completions',

    // A free key calls 26 models with no balance (KIOSAPI.md §5) — a real
    // free tier, so the Providers legend shows the Free Tier dot.
    freeTier: true,
    // KIOSAPI.md §0: consumption is limited (sentinel limits + per-key
    // usage numbers) but no plan, reset or quota is exposed via the API.
    planNote: 'Limited consumption · quota not published',
    docsSource: 'KIOSAPI.md §0',
  },
};
