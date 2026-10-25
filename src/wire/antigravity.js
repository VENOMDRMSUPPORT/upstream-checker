// ============================================
// Wire — Antigravity's own protocol
// ============================================
// Antigravity does not speak OpenAI. Behind it is Google's Cloud Code Assist
// service: a Gemini-shaped request inside an envelope, and an answer that
// comes back wrapped in one as well. This module is the only place that knows
// that.
//
// The translation lives in main rather than in the renderer for one reason:
// the app's own routing gateway (src/router) forwards requests to upstreams
// from main, and it has to speak the same protocol as the page does. One
// implementation, two callers — and a change to the protocol is one change.
//
// The routes the app uses:
//   v1internal:fetchAvailableModels  — the roster and, with it, the quota
//   v1internal:generateContent       — a chat answer
//   v1internal:streamGenerateContent — the same, as a stream
//   v1internal:loadCodeAssist        — which project the account is on
const crypto = require('crypto');

const API_VERSION = 'v1internal';
// The client the Antigravity IDE presents itself as. The service checks it.
const USER_AGENT = 'antigravity/1.11.5 windows/amd64';
const API_CLIENT = 'google-cloud-sdk vscode_cloudshelleditor/0.1';
const CLIENT_METADATA = '{"ideType":"ANTIGRAVITY","platform":"WINDOWS","pluginType":"GEMINI"}';
// Every consumer account is billed to this project unless its own answer says
// otherwise.
const DEFAULT_PROJECT = 'aicode-consumers';
// The service wants an instruction; the long identity Antigravity itself sends
// makes the models answer with warnings, so this one is deliberately short.
const SYSTEM_INSTRUCTION = 'You are a helpful AI assistant.';

function headers(apiKey) {
  const out = {
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    'X-Goog-Api-Client': API_CLIENT,
    'Client-Metadata': CLIENT_METADATA,
  };
  if (apiKey) out.Authorization = `Bearer ${apiKey}`;
  return out;
}

function requestId() {
  return `agent-${crypto.randomUUID().replace(/-/g, '')}`;
}

// The text of a message: a string, or the parts of a multimodal one.
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

function parseArgs(value) {
  if (value == null) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
  } catch (_) {
    return { value: String(value) };
  }
}

// An OpenAI conversation in Gemini's shape: the turns as contents, the
// instruction apart. A tool answer goes back as a function response and an
// assistant turn that called a tool goes back as a function call, so a
// conversation with tools survives the round trip.
function toContents(messages) {
  const contents = [];
  const system = [];
  (Array.isArray(messages) ? messages : []).forEach((message) => {
    if (!message || typeof message !== 'object') return;
    const role = String(message.role || 'user');
    const body = textOf(message.content);
    if (role === 'system' || role === 'developer') {
      if (body) system.push(body);
      return;
    }
    if (role === 'tool') {
      contents.push({
        role: 'function',
        parts: [{ functionResponse: { name: message.name || 'tool', response: { result: body } } }],
      });
      return;
    }
    if (role === 'assistant') {
      const parts = [];
      if (body) parts.push({ text: body });
      (Array.isArray(message.tool_calls) ? message.tool_calls : []).forEach((call) => {
        const fn = call && call.function ? call.function : {};
        parts.push({ functionCall: { name: fn.name || 'tool', args: parseArgs(fn.arguments) } });
      });
      if (parts.length) contents.push({ role: 'model', parts });
      return;
    }
    contents.push({ role: 'user', parts: [{ text: body }] });
  });
  return { contents, system };
}

function generationConfig(payload) {
  const config = {};
  const limit = Number(payload.max_completion_tokens || payload.max_tokens) || 0;
  if (limit > 0) config.maxOutputTokens = limit;
  if (payload.temperature != null && Number.isFinite(Number(payload.temperature))) {
    config.temperature = Number(payload.temperature);
  }
  if (payload.top_p != null && Number.isFinite(Number(payload.top_p))) {
    config.topP = Number(payload.top_p);
  }
  return config;
}

// The chat request. The body is the OpenAI one the app already builds, so
// the page and the gateway send the same thing.
function buildChat({ baseUrl, model, payload, project, apiKey } = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const { contents, system } = toContents(p.messages);
  const stream = p.stream === true;
  const body = {
    project: String(project || DEFAULT_PROJECT),
    model: String(model || p.model || ''),
    request: {
      contents,
      systemInstruction: { parts: [{ text: system.length ? system.join('\n\n') : SYSTEM_INSTRUCTION }] },
      generationConfig: generationConfig(p),
    },
    requestType: 'agent',
    userAgent: 'antigravity',
    requestId: requestId(),
  };
  const url = stream
    ? `${String(baseUrl).replace(/\/+$/, '')}/${API_VERSION}:streamGenerateContent?alt=sse`
    : `${String(baseUrl).replace(/\/+$/, '')}/${API_VERSION}:generateContent`;
  return { url, method: 'POST', headers: headers(apiKey), body, stream };
}

// The roster and the quota come from one route.
function buildModels({ baseUrl, apiKey } = {}) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/${API_VERSION}:fetchAvailableModels`;
  return { url, method: 'POST', headers: headers(apiKey), body: {} };
}

// The account's own project, so a request is billed to the right one.
function buildProject({ baseUrl, apiKey } = {}) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/${API_VERSION}:loadCodeAssist`;
  return { url, method: 'POST', headers: headers(apiKey), body: { metadata: { ideType: 'ANTIGRAVITY' } } };
}

// The grouped limits: the weekly allowance and the five-hour one, per model
// group. This is the endpoint the Antigravity app itself reads.
function buildQuotaSummary({ baseUrl, apiKey, project } = {}) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/${API_VERSION}:retrieveUserQuotaSummary`;
  const body = {};
  if (project) body.project = String(project);
  return { url, method: 'POST', headers: headers(apiKey), body };
}

function readUsage(response) {
  const usage = (response && response.usageMetadata) || {};
  const prompt = Number(usage.promptTokenCount) || 0;
  const completion = Number(usage.candidatesTokenCount || usage.completionTokenCount) || 0;
  const total = Number(usage.totalTokenCount) || (prompt + completion);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

// One Gemini answer: the text, the thinking that came with it, and the
// tokens it cost.
function readAnswer(response) {
  const answer = response && typeof response === 'object' ? response : {};
  const candidate = (Array.isArray(answer.candidates) ? answer.candidates[0] : null) || {};
  const parts = (candidate.content && Array.isArray(candidate.content.parts)) ? candidate.content.parts : [];
  let content = '';
  let reasoning = '';
  parts.forEach((part) => {
    if (!part || typeof part !== 'object') return;
    const value = typeof part.text === 'string' ? part.text : '';
    if (!value) return;
    if (part.thought === true) reasoning += value;
    else content += value;
  });
  return {
    content,
    reasoning,
    usage: readUsage(answer),
    finishReason: String(candidate.finishReason || candidate.stopReason || ''),
    blocked: String((answer.promptFeedback && answer.promptFeedback.blockReason) || ''),
  };
}

// The service wraps its answer: { "response": { … } }.
function unwrap(data) {
  if (!data || typeof data !== 'object') return {};
  if (data.response && typeof data.response === 'object') return data.response;
  return data;
}

function parseChat(body) {
  let data;
  try {
    data = JSON.parse(String(body || ''));
  } catch (_) {
    return { content: '', reasoning: '', usage: readUsage({}), finishReason: '', error: 'The answer was not readable' };
  }
  const answer = readAnswer(unwrap(data));
  if (!answer.content && !answer.reasoning && data && data.error) {
    const message = data.error.message || data.error.status || 'The service refused the request';
    return { ...answer, error: message };
  }
  return answer;
}

// A stream arrives as server-sent events, one answer per line, each holding
// the part that was new. Some answers come as a plain array instead.
function parseChatStream(body) {
  const raw = String(body || '');
  let content = '';
  let reasoning = '';
  let usage = readUsage({});
  let finishReason = '';
  const answers = [];
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('data:')) {
      const piece = trimmed.slice(5).trim();
      if (!piece || piece === '[DONE]') return;
      try { answers.push(JSON.parse(piece)); } catch (_) { /* a keep-alive */ }
      return;
    }
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { answers.push(JSON.parse(trimmed)); } catch (_) { /* not an answer */ }
    }
  });
  if (!answers.length) {
    // A stream that arrived as one array of answers.
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) answers.push(...parsed);
    } catch (_) { /* nothing to read */ }
  }
  answers.forEach((data) => {
    const answer = readAnswer(unwrap(data));
    if (answer.content) content += answer.content;
    if (answer.reasoning) reasoning += answer.reasoning;
    if (answer.usage && (answer.usage.total_tokens || answer.usage.prompt_tokens)) usage = answer.usage;
    if (answer.finishReason) finishReason = answer.finishReason;
  });
  return { content, reasoning, usage, finishReason };
}

// The roster, in the app's own words: an id, a name, what the model can do,
// and how much of the day's allowance is left.
function parseModels(body) {
  let data;
  try {
    data = JSON.parse(String(body || ''));
  } catch (_) {
    return { models: [], deprecated: {}, error: 'The roster was not readable' };
  }
  const source = data && data.models && typeof data.models === 'object' ? data.models : {};
  const models = Object.keys(source)
    // The service keeps a few models for itself — the chat previews and the
    // tab experiments. They are not models a person picks.
    .filter((id) => !isInternalModel(id))
    .map((id) => {
      const entry = source[id] || {};
      const quota = entry.quotaInfo && typeof entry.quotaInfo === 'object' ? entry.quotaInfo : {};
      const resetAt = Date.parse(quota.resetTime || '') || null;
      const remaining = Number.isFinite(Number(quota.remainingFraction)) ? Number(quota.remainingFraction) : null;
      return {
        id,
        name: String(entry.displayName || id),
        thinking: entry.supportsThinking === true,
        vision: entry.supportsImages === true,
        recommended: entry.recommended === true,
        context: Number(entry.maxTokens) || null,
        maxOutputTokens: Number(entry.maxOutputTokens) || null,
        quota: remaining == null && !resetAt ? null : { remaining, resetAt },
      };
    }).sort((a, b) => a.id.localeCompare(b.id));
  // The service says which models are on their way out, and what replaces
  // them. The Antigravity app does not offer them, so the app does not
  // either — but the answer is kept, because it is the honest reason a
  // model is missing.
  const deprecated = {};
  const old = data && data.deprecatedModelIds && typeof data.deprecatedModelIds === 'object'
    ? data.deprecatedModelIds : {};
  Object.keys(old).forEach((id) => {
    const info = old[id] && typeof old[id] === 'object' ? old[id] : {};
    deprecated[id] = {
      replacement: info.newModelId ? String(info.newModelId) : null,
      reason: info.reasonCode ? String(info.reasonCode) : null,
    };
  });
  return { models, deprecated, serverTime: data && data.serverTime ? String(data.serverTime) : null };
}

// The models the service keeps for itself: the chat previews and the tab
// experiments are not models a person picks.
function isInternalModel(id) {
  return /^(chat_|tab_)/i.test(String(id || ''));
}

// The quota on its own: what is left of the day's allowance, per model.
function parseQuota(body) {
  const parsed = parseModels(body);
  return {
    models: parsed.models
      .filter((m) => m.quota)
      .map((m) => ({ id: m.id, name: m.name, remaining: m.quota.remaining, resetAt: m.quota.resetAt })),
    serverTime: parsed.serverTime,
  };
}

// The grouped limits the Antigravity app shows: a weekly allowance and a
// five-hour one, per group of models.
function parseQuotaSummary(body) {
  let data;
  try {
    data = JSON.parse(String(body || ''));
  } catch (_) {
    return { groups: [], error: 'The limits were not readable' };
  }
  const raw = data && Array.isArray(data.groups) ? data.groups : [];
  const groups = raw.map((group) => {
    if (!group || typeof group !== 'object') return null;
    const buckets = (Array.isArray(group.buckets) ? group.buckets : []).map((bucket) => {
      if (!bucket || typeof bucket !== 'object') return null;
      const fraction = Number(bucket.remainingFraction);
      if (!Number.isFinite(fraction)) return null;
      const resetAt = Date.parse(bucket.resetTime || '') || null;
      return {
        label: String(bucket.displayName || bucket.bucketId || 'Limit'),
        window: String(bucket.window || bucket.bucketId || ''),
        remainingPct: Math.round(fraction * 1000) / 10,
        usedPct: Math.round((1 - fraction) * 1000) / 10,
        resetAt,
        note: bucket.description ? String(bucket.description) : null,
      };
    }).filter(Boolean);
    if (!buckets.length) return null;
    return {
      name: String(group.displayName || 'Models'),
      description: group.description ? String(group.description) : null,
      windows: buckets,
    };
  }).filter(Boolean);
  return { groups };
}

// Which plan the account is on, and on which project.
//
// The service reports two tiers: the Cloud Code Assist one (always
// "free-tier" for a consumer account) and the Google One subscription the
// account actually holds. The subscription is the one a person recognises,
// so it wins.
function tierFromName(raw) {
  const lower = String(raw || '').trim().toLowerCase();
  if (!lower) return '';
  if (lower.includes('ultra') || lower.includes('helium')) return 'ULTRA';
  if (lower.includes('free') || lower.includes('starter')) return 'FREE';
  if (lower.includes('pro') || lower.includes('premium') || lower.includes('advanced')) return 'PRO';
  return '';
}

const TIER_LABEL = { FREE: 'Free', PRO: 'Pro', ULTRA: 'Ultra' };

function parseProject(body) {
  let data;
  try {
    data = JSON.parse(String(body || ''));
  } catch (_) {
    return { project: null, tier: 'FREE', tierLabel: 'Free' };
  }
  const tierFields = (value) => {
    if (!value) return { name: '', id: '' };
    if (typeof value === 'string') return { name: value, id: value };
    if (typeof value === 'object') return { name: String(value.name || ''), id: String(value.id || '') };
    return { name: '', id: '' };
  };
  const paid = tierFields(data.paidTier);
  const current = tierFields(data.currentTier);
  const allowed = Array.isArray(data.allowedTiers) ? data.allowedTiers : [];
  const freeAllowed = allowed.map((t) => tierFields(t)).find((t) => /free/i.test(t.id || '') || /free/i.test(t.name || ''));
  // The subscription first, then the API tier, then the allowed list, then
  // the safe answer: no subscription.
  const raw = paid.id || paid.name || current.id || current.name || (freeAllowed ? freeAllowed.id : '') || 'free-tier';
  const tier = tierFromName(raw) || 'FREE';
  const project = typeof data.cloudaicompanionProject === 'string' && data.cloudaicompanionProject
    ? data.cloudaicompanionProject : null;
  return {
    project,
    tier,
    tierLabel: TIER_LABEL[tier] || 'Free',
    tierName: paid.name || current.name || TIER_LABEL[tier] || 'Free',
    apiTier: current.id || current.name || null,
    paidTier: paid.id || paid.name || null,
  };
}

// The upstream streams in its own shape; the gateway's clients speak OpenAI.
// This turns one into the other, line by line, without waiting for the end.
function createStreamTranslator({ model = '' } = {}) {
  let buffer = '';
  const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const make = (delta, finish) => JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish || null }],
  });
  const pending = [];
  const take = (line) => {
    const trimmed = String(line || '').trim();
    if (!trimmed || trimmed.startsWith(':')) return;
    if (!trimmed.startsWith('data:')) return;
    const piece = trimmed.slice(5).trim();
    if (!piece || piece === '[DONE]') return;
    let data;
    try { data = JSON.parse(piece); } catch (_) { return; }
    const answer = readAnswer(unwrap(data));
    if (answer.content) pending.push(`data: ${make({ content: answer.content })}\n\n`);
    if (answer.reasoning) pending.push(`data: ${make({ reasoning_content: answer.reasoning })}\n\n`);
  };
  return {
    // What arrived from the wire, turned into what the client understands.
    push(text) {
      buffer += String(text || '');
      const out = [];
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        take(line);
        out.push(...pending.splice(0));
      }
      return out;
    },
    // The end of the stream: the last piece of the answer may still be in
    // the buffer, and the client is told the story is over.
    flush() {
      if (buffer.trim()) { take(buffer); buffer = ''; }
      const out = pending.splice(0);
      out.push(`data: ${make({}, 'stop')}\n\n`);
      out.push('data: [DONE]\n\n');
      return out;
    },
  };
}

// What an account is: the project its requests are billed to, and the plan
// it is on. The answer comes from the service itself, over the app's own
// client, so no secret travels through the request log.
async function discoverAccount({ baseUrl, apiKey, http } = {}) {
  if (!http || !baseUrl) return null;
  const spec = buildProject({ baseUrl, apiKey });
  let res;
  try {
    res = await http.request({
      url: spec.url,
      method: spec.method,
      headers: spec.headers,
      body: JSON.stringify(spec.body),
      timeoutMs: 20000,
    });
  } catch (_) {
    return null;
  }
  if (!res || res.networkError || res.status < 200 || res.status >= 300) return null;
  return parseProject(res.body);
}

module.exports = {
  id: 'antigravity',
  buildChat,
  buildModels,
  buildProject,
  buildQuotaSummary,
  parseChat,
  parseChatStream,
  parseModels,
  parseQuota,
  parseQuotaSummary,
  parseProject,
  isInternalModel,
  discoverAccount,
  createStreamTranslator,
  DEFAULT_PROJECT,
};
