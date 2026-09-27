// ============================================
// Request classification — pure, no I/O
// ============================================
// Turns what api-request saw (the request as the renderer sent it, the reply,
// how it ended) into the logged fields: endpoint, model, stream flag, usage,
// cost, status and error class. It runs after the reply went out but still on
// the main thread, so a big body is never parsed whole: JSON only up to
// 1 MB, streams and bigger bodies only at their two ends.
const QUOTA_CODES = new Set(['insufficient_quota', 'quota_exceeded', 'billing_hard_limit_reached']);
const JSON_PARSE_LIMIT = 1024 * 1024;
const SCAN_WINDOW = 64 * 1024;
// The model the caller asked for (from the request body): the brief's cap.
const MODEL_MAX = 200;
// The model a reply reports back: generous, because the recorder scrubs
// secrets from it and clips to the DB's real limit afterward — this only
// guards against a runaway body, not the stored length.
const RETURNED_MODEL_MAX = 4096;
// Inclusive upper edges (ms) of lb0..lb12; lb13 holds everything above.
const LATENCY_EDGES = [100, 250, 500, 1000, 2000, 3000, 5000, 8000, 12000, 20000, 30000, 60000, 120000];

const clipped = (s, max) => (typeof s === 'string' && s !== '' ? s.slice(0, max) : null);
const tokens = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

// URL origin + path. The query string is dropped: it can hold a key.
function endpointOf(url) {
  const text = String(url ?? '');
  try {
    const u = new URL(text);
    if (u.protocol === 'http:' || u.protocol === 'https:') return (u.origin + u.pathname).slice(0, 500);
  } catch (_) {
    // Not a URL: stored as given, minus anything after ? or #.
  }
  return text.split(/[?#]/)[0].slice(0, 500);
}

function bodyText(body) {
  if (body === undefined || body === null || body === '') return null;
  return typeof body === 'string' ? body : JSON.stringify(body);
}

function parseObject(text) {
  if (typeof text !== 'string' || text.length > JSON_PARSE_LIMIT) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (_) {
    return null;
  }
}

function modelRequested(requestText) {
  const o = parseObject(requestText);
  return o ? clipped(typeof o.model === 'string' ? o.model : null, MODEL_MAX) : null;
}

function isStreamRequest(requestText, contentType) {
  const o = parseObject(requestText);
  return (!!o && o.stream === true) || /text\/event-stream/i.test(contentType || '');
}

// OpenAI's prompt_tokens already includes cached tokens. Anthropic reports
// cache reads and writes beside input_tokens, so they are added to it.
function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  if ('prompt_tokens' in u || 'completion_tokens' in u) {
    return {
      input: tokens(u.prompt_tokens),
      output: tokens(u.completion_tokens),
      cached: tokens(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens),
      cacheWrite: null,
      reasoning: tokens(u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens),
    };
  }
  if ('input_tokens' in u || 'output_tokens' in u || 'cache_read_input_tokens' in u) {
    const base = tokens(u.input_tokens);
    const read = tokens(u.cache_read_input_tokens);
    const write = tokens(u.cache_creation_input_tokens);
    const input = base === null && read === null && write === null ? null : (base || 0) + (read || 0) + (write || 0);
    return { input, output: tokens(u.output_tokens), cached: read, cacheWrite: write, reasoning: null };
  }
  return null;
}

// The data: lines of an event stream, as objects. A long stream is read only
// at its two ends: the first window (Anthropic's message_start, the model)
// and the last (the final usage chunk). The line each window cuts is dropped.
function sseEvents(text) {
  const windows = text.length <= 4 * SCAN_WINDOW ? [text] : [text.slice(0, SCAN_WINDOW), text.slice(-SCAN_WINDOW)];
  const events = [];
  windows.forEach((part, i) => {
    const lines = part.split('\n');
    if (windows.length > 1) {
      if (i === 0) lines.pop();
      else lines.shift();
    }
    lines.forEach((line) => {
      const t = line.trim();
      if (!t.startsWith('data:')) return;
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      try {
        const ev = JSON.parse(payload);
        if (ev && typeof ev === 'object') events.push(ev);
      } catch (_) {
        // A keep-alive or a line that isn't JSON.
      }
    });
  });
  return events;
}

function readStream(text) {
  let model = null;
  let usage = null; // OpenAI: the last chunk that carried usage
  let started = null; // Anthropic: message_start.message.usage (input side)
  let delta = null; // Anthropic: message_delta.usage (output so far)
  sseEvents(text).forEach((ev) => {
    if (ev.type === 'message_start' && ev.message && typeof ev.message === 'object') {
      if (typeof ev.message.model === 'string') model = ev.message.model;
      if (ev.message.usage && typeof ev.message.usage === 'object') started = ev.message.usage;
      return;
    }
    if (typeof ev.model === 'string' && ev.model) model = ev.model;
    if (ev.usage && typeof ev.usage === 'object') {
      if (ev.type === 'message_delta') delta = ev.usage;
      else usage = ev.usage;
    }
  });
  const raw = started || delta ? { ...(started || {}), ...(delta || {}) } : usage;
  return { usage: normalizeUsage(raw), model: clipped(model, RETURNED_MODEL_MAX) };
}

// The object literal that starts at text[start] (a '{'), parsed, or null.
function objectAt(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '{') {
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch (_) {
          return null;
        }
      }
    }
  }
  return null;
}

const MODEL_FIELD = new RegExp(`"model"\\s*:\\s*"((?:[^"\\\\]|\\\\.){1,${RETURNED_MODEL_MAX}})"`);

// A JSON reply too big to parse whole: usage from the last "usage" object in
// the tail, the model from the head (where OpenAI and Anthropic put it).
function readLargeJson(text) {
  const tail = text.slice(-SCAN_WINDOW);
  const at = tail.lastIndexOf('"usage"');
  const brace = at >= 0 ? tail.indexOf('{', at) : -1;
  const usage = brace >= 0 ? normalizeUsage(objectAt(tail, brace)) : null;
  const m = MODEL_FIELD.exec(text.slice(0, SCAN_WINDOW));
  let model = null;
  if (m) {
    try {
      model = JSON.parse(`"${m[1]}"`);
    } catch (_) {
      model = null;
    }
  }
  return { usage, model: clipped(model, RETURNED_MODEL_MAX) };
}

function readResponse(text, contentType) {
  if (typeof text !== 'string' || text === '') return { usage: null, model: null };
  if (/text\/event-stream/i.test(contentType || '') || /^\s*(?:data|event):/.test(text.slice(0, 64))) return readStream(text);
  if (text.length > JSON_PARSE_LIMIT) return readLargeJson(text);
  const o = parseObject(text);
  if (!o) return { usage: null, model: null };
  return { usage: normalizeUsage(o.usage), model: clipped(typeof o.model === 'string' ? o.model : null, RETURNED_MODEL_MAX) };
}

// Prices are USD per 1M tokens, so tokens × price is already micro-USD.
function computeCost(usage, price) {
  const validPrice = !!price
    && Number.isFinite(price.input) && price.input >= 0
    && Number.isFinite(price.output) && price.output >= 0;
  if (!usage || !validPrice || (usage.input === null && usage.output === null)) return { costMicros: null, priceJson: null };
  return {
    costMicros: Math.round((usage.input || 0) * price.input + (usage.output || 0) * price.output),
    priceJson: JSON.stringify({ input: price.input, output: price.output }),
  };
}

// outcome comes from src/api-request.js: end | cancelled | timeout | error | aborted | blocked.
// quota is an optional pre-computed flag (see extractError): a caller that
// already knows the body's error.code/error.type matched a quota code can
// pass it straight through instead of relying on errorCode alone, since a
// quota code can live in error.type while error.code holds an HTTP status.
function classifyStatus({ outcome, httpStatus = null, cancelReason = null, errorCode = null, quota = false } = {}) {
  if (outcome === 'blocked') return { status: 'blocked', errorClass: 'blocked' };
  if (outcome === 'cancelled') {
    // The adaptive per-kind deadline gave up on it: a timeout, not a choice.
    return cancelReason === 'deadline' ? { status: 'timeout', errorClass: 'timeout' } : { status: 'cancelled', errorClass: null };
  }
  if (outcome === 'timeout') return { status: 'timeout', errorClass: 'timeout' };
  if (outcome === 'error' || outcome === 'aborted') return { status: 'error', errorClass: 'network' };
  if (outcome !== 'end' || !Number.isInteger(httpStatus)) return { status: 'error', errorClass: 'other' };
  if (httpStatus >= 200 && httpStatus < 300) return { status: 'ok', errorClass: null };
  // A spent quota is named in the body, whatever the status line says.
  if (quota || (errorCode !== null && QUOTA_CODES.has(String(errorCode)))) return { status: 'error', errorClass: 'quota' };
  if (httpStatus === 401 || httpStatus === 403) return { status: 'error', errorClass: 'auth' };
  if (httpStatus === 402) return { status: 'error', errorClass: 'quota' };
  if (httpStatus === 429) return { status: 'error', errorClass: 'rate_limit' };
  if (httpStatus >= 400 && httpStatus < 500) return { status: 'error', errorClass: 'bad_request' };
  if (httpStatus >= 500 && httpStatus < 600) return { status: 'error', errorClass: 'server' };
  return { status: 'error', errorClass: 'other' };
}

// The message the renderer's failFromResponse shows: error.message (or a
// string error), else message, else detail, else the body's first 200
// characters. code is error.code, falling through to error.type when code is
// missing or empty (some providers put the quota code in .type and leave
// .code as an empty string or the HTTP status). quota is true when either
// field named a quota code, even if the other one is what got stored as code.
function extractError(text) {
  const src = typeof text === 'string' ? text : '';
  const d = parseObject(src);
  let message = null;
  let code = null;
  let quota = false;
  if (d) {
    const e = d.error;
    if (typeof e === 'string') message = e;
    else if (e && typeof e === 'object' && typeof e.message === 'string') message = e.message;
    if (!message && typeof d.message === 'string') message = d.message;
    if (!message && typeof d.detail === 'string') message = d.detail;
    if (e && typeof e === 'object') {
      const rawCode = typeof e.code === 'string' || typeof e.code === 'number' ? String(e.code) : null;
      const rawType = typeof e.type === 'string' || typeof e.type === 'number' ? String(e.type) : null;
      // Not clipped here: the recorder clips error_code to 100 once, after
      // scrubbing, on the way into the row (see recorder.js).
      code = rawCode || rawType;
      quota = (rawCode !== null && QUOTA_CODES.has(rawCode)) || (rawType !== null && QUOTA_CODES.has(rawType));
    }
  }
  return { code, message: message || src.slice(0, 200) || null, quota };
}

function latencyBucket(ms) {
  const i = LATENCY_EDGES.findIndex((edge) => ms <= edge);
  return i === -1 ? LATENCY_EDGES.length : i;
}

// Approximate p95: the upper edge of the first bucket whose running count
// reaches ceil(0.95 × total). Past the last edge it can only say "≥ 120 s".
function approxP95(buckets, total) {
  if (!Number.isFinite(total) || total <= 0) return null;
  const target = Math.ceil(0.95 * total);
  const top = { ms: LATENCY_EDGES[LATENCY_EDGES.length - 1], overflow: true };
  let seen = 0;
  for (let i = 0; i < buckets.length; i += 1) {
    seen += buckets[i] || 0;
    if (seen >= target) return i < LATENCY_EDGES.length ? { ms: LATENCY_EDGES[i], overflow: false } : top;
  }
  return top;
}

module.exports = {
  endpointOf, bodyText, modelRequested, isStreamRequest, normalizeUsage, readResponse,
  computeCost, classifyStatus, extractError, latencyBucket, approxP95,
  LATENCY_EDGES, JSON_PARSE_LIMIT, QUOTA_CODES,
};
