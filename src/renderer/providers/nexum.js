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
  // Checked against the live endpoint: /v1/models returns
  //   id, object, created, owned_by, display_name,
  //   context_window, context_length, max_input_tokens, limit
  // and nothing else. qwen-image and wan-2.0 are byte-for-byte shaped like the
  // chat models — same owned_by, same context window. /api/models, /api/pricing
  // and /api/plans are all 404. There is no modality field to read, so name
  // matching is not a shortcut here, it is the only signal available.
  //
  // Both id and display_name are matched, since the display name is often the
  // clearer of the two ("Qwen Image 3.0 Pro", "WAN 2.0").
  classify(model) {
    const id = `${model.id || ''} ${model.display_name || ''}`.toLowerCase();

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
