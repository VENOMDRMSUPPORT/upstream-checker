// ============================================
// NEXUM ROUTER — integrated provider module
// Registers into window.INTEGRATED_PROVIDERS; loaded before app.js.
// ============================================
window.INTEGRATED_PROVIDERS = window.INTEGRATED_PROVIDERS || {};

window.INTEGRATED_PROVIDERS.nexum = {
  meta: {
    id: 'nexum',
    name: 'Nexum Router',
    baseUrl: 'https://dialagram.me/router/v1',
    color: '#10b981',
    logo: '../assets/providers/nexum.svg',
    modelsEndpoint: '/models',
    chatEndpoint: '/chat/completions',
  },

  // Nexum is OpenAI-compatible and its /models response already carries a context
  // window, so app.js's default discovery handles the fetch. What it can't do on
  // its own is tell a chat model from an image or video generator — Nexum mixes
  // all three behind the same endpoint (qwen-image answers a chat request with a
  // markdown image link). classify() below tags them so each is judged by the
  // right standard instead of being asked what 2+2 is.
  //
  // This is name matching, not metadata: the /models payload doesn't say. If a
  // model is tagged wrong, the badge in the sidebar shows what the app decided,
  // and adding a pattern here fixes it.
  classify(model) {
    const id = String(model.id || '').toLowerCase();

    // Video first — some video model names also contain image-ish words.
    if (/\b(wan|veo|sora|kling|runway|luma|hailuo|seedance|pika)\b|video|t2v|i2v/.test(id)) {
      return 'video';
    }
    if (/image|flux|dall-?e|stable-?diffusion|\bsd-?[0-9]|midjourney|seedream|imagen|recraft|ideogram|t2i/.test(id)) {
      return 'image';
    }
    return 'chat';
  },
};
