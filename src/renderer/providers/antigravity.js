// ============================================
// ANTIGRAVITY — integrated provider module
// Registers into window.INTEGRATED_PROVIDERS; loaded before app.js.
// meta is plain data (structuredClone-safe); the rest lives only here.
// ============================================
// Evidence: docs/integrations/ANTIGRAVITY.md.
//
// Antigravity is the entitlement the Google Antigravity IDE carries. The
// sign-in is a plain Google account, and the API behind it is the Cloud Code
// Assist service — which does not speak OpenAI. The app's wire speaks it
// instead (src/wire/antigravity.js): this module says which of the service's
// own routes the app needs, and the wire carries them.
//
// One Google account is one key. The access token is the credential the API
// is called with and the renewal token beside it is what keeps it alive, so
// several accounts are several keys — each with its own quota — and the
// router may use them one after another.
//
// The sign-in is declared, not scripted: main owns the OAuth client and the
// addresses it talks to (src/oauth/profiles.js), so the page only says which
// profile to use.
window.INTEGRATED_PROVIDERS = window.INTEGRATED_PROVIDERS || {};

// The service's front door. The daily host serves the roster, the quota and
// the chat; the other two are the same service behind another name, and the
// provider's base URL can be pointed at either of them.
const ANTIGRAVITY_BASE = 'https://daily-cloudcode-pa.googleapis.com';

// The family a model belongs to. The service groups its limits by family,
// and a family the account has no group for is a family it cannot call.
function familyOf(id) {
  const name = String(id || '').toLowerCase();
  if (name.startsWith('gemini')) return 'gemini';
  if (name.startsWith('claude')) return 'claude';
  if (name.startsWith('gpt')) return 'gpt';
  if (name.startsWith('image') || name.startsWith('imagen')) return 'image';
  return '';
}

// The families the account has an allowance for, read from the grouped
// limits. An answer that cannot be read leaves every family allowed: a
// missing answer is not an answer.
async function accountFamilies({ baseUrl, apiKey, apiRequest, wire }) {
  try {
    const spec = await wire.build('antigravity', 'quota-summary', { baseUrl, apiKey });
    const res = await apiRequest({
      url: spec.url, method: spec.method, headers: spec.headers,
      body: JSON.stringify(spec.body), timeoutMs: 30000,
    });
    if (res.status !== 200) return null;
    const parsed = await wire.parse('antigravity', 'quota-summary', res.body);
    const groups = (parsed && Array.isArray(parsed.groups)) ? parsed.groups : [];
    if (!groups.length) return null;
    const families = new Set();
    groups.forEach((group) => {
      const name = String(group.name || '').toLowerCase();
      if (name.includes('gemini')) families.add('gemini');
      if (name.includes('claude')) families.add('claude');
      if (name.includes('gpt')) families.add('gpt');
    });
    return families.size ? families : null;
  } catch (_) {
    return null;
  }
}

// A model of a family the account has no allowance for is not shown. A model
// of a family the service does not group (an image model, say) is shown.
function familyAllowed(id, families) {
  if (!families) return true;
  const family = familyOf(id);
  if (!family) return true;
  return families.has(family);
}

window.INTEGRATED_PROVIDERS.antigravity = {
  meta: {
    id: 'antigravity',
    name: 'Antigravity',
    baseUrl: ANTIGRAVITY_BASE,
    color: '#5b8def',
    logo: '../assets/providers/antigravity.svg',
    // Its own routes, not OpenAI's.
    modelsEndpoint: '/v1internal:fetchAvailableModels',
    chatEndpoint: '/v1internal:generateContent',
    // The account is the key: there is no key to paste.
    auth: ['oauth'],
    oauth: { kind: 'loopback', profile: 'antigravity' },
    // Every account is on the same footing: the day's allowance is counted
    // per model, and the account's own tier is what the badge shows.
    planNote: 'Free tier · daily allowance per model',
    docsSource: 'ANTIGRAVITY.md §0',
    // The service is slow to answer a first request while it warms up, and
    // the roster is read once a minute at most.
    rpm: 5,
    rateLimits: {
      source: 'docs/integrations/ANTIGRAVITY.md',
      lines: [
        { label: 'Allowance', value: 'A daily allowance per model, read from the service with the account' },
        { label: 'Sign-in', value: 'A Google account; several accounts may be connected at once' },
        { label: 'Token', value: 'Renews itself an hour before it expires' },
      ],
    },
  },

  // The roster and the quota come from one route: the service answers with
  // the models the account may call and, for each, how much of the day's
  // allowance is left.
  //
  // The list is the official app's list and not the service's raw answer:
  // a model the service has retired (it says so, and says what replaces it)
  // and the models the service keeps for itself are not models a person
  // picks, and a model family the account has no allowance for is not a
  // model the account can call.
  async fetchModels({ apiKey, baseUrl, apiRequest, wire, formatContext, getFreeGroupName }) {
    const spec = await wire.build('antigravity', 'models', { baseUrl, apiKey });
    const res = await apiRequest({
      url: spec.url, method: spec.method, headers: spec.headers,
      body: JSON.stringify(spec.body), timeoutMs: 30000,
    });
    if (res.status !== 200) {
      throw new Error(`Antigravity answered HTTP ${res.status}: ${String(res.body || '').slice(0, 160)}`);
    }
    const parsed = await wire.parse('antigravity', 'models', res.body);
    if (!parsed || !Array.isArray(parsed.models)) {
      throw new Error('Antigravity answered without a model list');
    }
    // The families the account has an allowance for. The service groups its
    // limits by family ("Gemini Models", "Claude and GPT models"), and a
    // family it does not mention is a family the account cannot call.
    const families = await accountFamilies({ baseUrl, apiKey, apiRequest, wire });
    const deprecated = parsed.deprecated || {};
    return parsed.models
      .filter((m) => !deprecated[m.id])
      .filter((m) => familyAllowed(m.id, families))
      .map((m) => {
        const ctx = m.context || null;
        return {
          id: m.id,
          name: m.name || m.id,
          // The allowance is the account's, not a plan's: every model is
          // reachable and every model is counted.
          isFree: true,
          isFreeForPaid: false,
          noPlans: false,
          groupName: getFreeGroupName('free'),
          hasVision: !!m.vision,
          hasReasoning: !!m.thinking,
          context_window: ctx,
          contextLabel: formatContext(ctx),
          maxOutputTokens: m.maxOutputTokens || null,
        };
      });
  },

  // The allowance, read the way the Antigravity app reads it: the grouped
  // limits — a weekly one and a five-hour one — per group of models.
  async fetchKeyUsage({ apiKey, baseUrl, apiRequest, wire, account }) {
    const spec = await wire.build('antigravity', 'quota-summary', { baseUrl, apiKey });
    const res = await apiRequest({
      url: spec.url, method: spec.method, headers: spec.headers,
      body: JSON.stringify(spec.body), timeoutMs: 30000,
    });
    if (res.status !== 200) {
      throw new Error(`Antigravity answered HTTP ${res.status}: ${String(res.body || '').slice(0, 160)}`);
    }
    const parsed = await wire.parse('antigravity', 'quota-summary', res.body);
    const groups = (parsed && Array.isArray(parsed.groups)) ? parsed.groups : [];
    const allowances = [];
    groups.forEach((group) => {
      (group.windows || []).forEach((window) => {
        allowances.push({
          // The drawer reads this as a heading: the group, and the window
          // inside it.
          label: `${group.name} · ${window.label}`,
          group: group.name,
          window: window.window || window.label,
          usedPct: window.usedPct,
          resetsAt: window.resetAt || null,
        });
      });
    });
    // The bar on the account row is the tightest limit of them all: the one
    // closest to being spent is the one that says the most.
    const tightest = allowances.slice().sort((a, b) => b.usedPct - a.usedPct)[0] || null;
    return {
      // The service publishes a fraction of an allowance, not an amount of
      // anything, so there is no quota bar: the allowances below are it.
      quota: null,
      expiresAt: null,
      window24h: null,
      plan: (account && account.tier) || 'Antigravity',
      allowance: tightest,
      allowances,
    };
  },

  // The service says an allowance is spent in its own words. A request
  // refused for one model's allowance is that model's problem, not the
  // account's: the run moves on to the next model.
  readQuotaError(info) {
    const message = String((info && info.message) || '');
    const status = Number(info && info.status) || 0;
    if (!/quota|allowance|rate limit|resource[_ ]exhausted/i.test(message)) return null;
    const until = /reset[^0-9]{0,20}(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?)/i.exec(message);
    const resetAt = until ? Date.parse(until[1].replace(' ', 'T')) : NaN;
    return {
      until: Number.isFinite(resetAt) ? resetAt : null,
      message: status ? `The allowance for this model is spent (HTTP ${status}).` : 'The allowance for this model is spent.',
    };
  },

  // The service does not speak OpenAI: the request is built by the app's
  // wire and the answer read by it too. The page's own OpenAI body is what
  // goes in, so the run, the log and the gateway all see the same thing.
  async buildChatRequest({ baseUrl, model, payload, project, apiKey, wire }) {
    return wire.build('antigravity', 'chat', { baseUrl, model, payload, project, apiKey });
  },

  async parseChatResponse({ body, stream, wire }) {
    const answer = await wire.parse('antigravity', 'chat', body, { stream });
    return answer || { content: '', usage: {} };
  },
};
