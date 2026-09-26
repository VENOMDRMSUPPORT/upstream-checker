// ============================================
// Request record — what one finished request becomes in the log
// ============================================
// src/api-request.js calls record(done) in setImmediate, after the renderer
// already has its reply, so none of this sits on the reply path.
// buildRecord is pure apart from the two lookups it is handed.
//
// done.substitutions holds the real secrets main swapped in. They are used
// here to scrub the stored text and nowhere else: never copied into the row,
// the body or meta_json.
const { ulid } = require('../db/ulid');
const C = require('./classify');
const { scrub } = require('./scrub');

const SOURCES = new Set(['route_test', 'benchmark', 'health', 'key_check', 'key_usage', 'discovery', 'pricing', 'leaderboard', 'other']);
const CANCEL_REASONS = new Set(['hedge_lost', 'stop', 'deadline']);
const TRIGGERS = new Set(['manual', 'scheduled']);
const BODY_MAX = 8192;
const REDACTED_HEADERS = /^(authorization|x-api-key|api-key|cookie)$/i;

const shortString = (v, max) => (typeof v === 'string' && v !== '' && v.length <= max ? v : null);
const whole = (v) => (Number.isFinite(v) ? Math.round(v) : null);

function clip(text) {
  if (typeof text !== 'string') return { text: null, clipped: false };
  return text.length > BODY_MAX ? { text: text.slice(0, BODY_MAX), clipped: true } : { text, clipped: false };
}

function redactHeaders(headers) {
  const out = {};
  Object.entries(headers && typeof headers === 'object' ? headers : {}).forEach(([name, value]) => {
    out[name] = REDACTED_HEADERS.test(name) ? '[redacted]' : value;
  });
  return out;
}

// Only these keys ever reach meta_json, each checked for type and size.
function metaOf(args, cancelReason) {
  const m = {};
  const requestId = shortString(args.requestId, 100);
  if (requestId) m.requestId = requestId;
  if (Number.isFinite(args.timeoutMs) && args.timeoutMs > 0) m.timeoutMs = Math.round(args.timeoutMs);
  if (CANCEL_REASONS.has(cancelReason)) m.cancelReason = cancelReason;
  if (TRIGGERS.has(args.trigger)) m.trigger = args.trigger;
  if (Number.isInteger(args.hedgeIndex) && args.hedgeIndex >= 0) m.hedgeIndex = args.hedgeIndex;
  const testGroup = shortString(args.testGroup, 64);
  if (testGroup) m.testGroup = testGroup;
  if (args.paramSwap === true) m.paramSwap = true;
  return Object.keys(m).length ? JSON.stringify(m) : null;
}

function originOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch (_) {
    return null;
  }
}

// The key's own provider when a key was substituted (or refused); otherwise
// the one provider whose base URL has this origin (several → unknown).
function whoFor(refs, url, providers) {
  const list = Array.isArray(providers) ? providers : [];
  const all = Array.isArray(refs) ? refs : [];
  const key = all.find((r) => r && r.kind === 'key');
  const secret = all.find((r) => r && r.kind === 'secret');
  let providerId = key && key.providerId ? key.providerId : null;
  if (!providerId) {
    const origin = originOf(url);
    const matches = origin ? list.filter((p) => originOf(p.baseUrl) === origin) : [];
    providerId = matches.length === 1 ? matches[0].id : null;
  }
  const named = providerId ? list.find((p) => p.id === providerId) : null;
  let keyId = null;
  if (key) keyId = String(key.id).slice(0, 100);
  else if (secret) keyId = `secret:${String(secret.id).slice(0, 64)}`;
  return { providerId, providerName: named ? named.name : null, keyId };
}

// Failed = anything but ok and cancelled. An unknown setting reads as Failed only.
function keepsBody(logLevel, status) {
  if (logLevel === 'all') return true;
  if (logLevel === 'off') return false;
  return status !== 'ok' && status !== 'cancelled';
}

function buildRecord(done, { prices = null, providers = [], logLevel = 'errors', newUid = ulid } = {}) {
  const args = done.args && typeof done.args === 'object' ? done.args : {};
  const subs = Array.isArray(done.substitutions) ? done.substitutions : [];
  const clean = (text) => (typeof text === 'string' ? scrub(text, subs) : null);
  const requestText = C.bodyText(args.body);
  const responseText = typeof done.responseText === 'string' ? done.responseText : '';
  const answered = done.outcome === 'end';
  const ok2xx = answered && done.httpStatus >= 200 && done.httpStatus < 300;
  const parsed = C.readResponse(responseText, done.contentType);
  // Scrubbed before extractError clips it to 200 characters, so a secret cut
  // in half at the clip can't slip past the scrubber.
  const err = answered && !ok2xx ? C.extractError(clean(responseText) || '') : { code: null, message: done.error || null };
  const { status, errorClass } = C.classifyStatus({
    outcome: done.outcome, httpStatus: done.httpStatus, cancelReason: done.cancelReason, errorCode: err.code, quota: err.quota,
  });
  const isStream = C.isStreamRequest(requestText, done.contentType);
  const who = whoFor(done.refs, args.url, providers);
  const modelRequested = C.modelRequested(requestText);
  const price = prices && who.providerId && modelRequested ? prices.get(who.providerId, modelRequested) : null;
  const usage = parsed.usage;
  const cost = C.computeCost(usage, price);
  const failed = status !== 'ok' && status !== 'cancelled';
  const message = failed ? clean(err.message) : null;
  const code = failed ? clean(err.code) : null;
  const modelReturned = clean(parsed.model);

  const row = {
    request_uid: newUid(),
    created_at: Number.isFinite(done.startedAt) ? done.startedAt : Date.now(),
    source: SOURCES.has(args.source) ? args.source : 'other',
    run_id: shortString(args.runId, 64),
    attempt: Number.isInteger(args.attempt) && args.attempt > 0 ? args.attempt : 1,
    is_hedge: Number.isInteger(args.hedgeIndex) && args.hedgeIndex > 0 ? 1 : 0,
    provider_id: who.providerId,
    provider_name: who.providerName,
    key_id: who.keyId,
    method: String(args.method || 'GET').toUpperCase().slice(0, 16),
    endpoint: C.endpointOf(args.url),
    model_requested: modelRequested,
    model_returned: modelReturned ? modelReturned.slice(0, 200) : null,
    is_stream: isStream ? 1 : 0,
    status,
    http_status: Number.isInteger(done.httpStatus) ? done.httpStatus : null,
    error_class: errorClass,
    error_code: code ? code.slice(0, 100) : null,
    error_message: message ? message.slice(0, 500) : null,
    latency_ms: whole(done.elapsed),
    ttft_ms: isStream ? whole(done.firstTokenMs) : null,
    first_byte_ms: whole(done.firstByteMs),
    input_tokens: usage ? usage.input : null,
    output_tokens: usage ? usage.output : null,
    cached_tokens: usage ? usage.cached : null,
    cache_write_tokens: usage ? usage.cacheWrite : null,
    reasoning_tokens: usage ? usage.reasoning : null,
    usage_source: usage ? 'reported' : 'none',
    cost_micros: cost.costMicros,
    price_json: cost.priceJson,
    meta_json: metaOf(args, done.cancelReason),
    user_id: null,
    token_id: null,
    subscription_id: null,
    client_ip: null,
  };
  if (!keepsBody(logLevel, status)) return { row, body: null };

  const request = clip(requestText);
  const response = clip(responseText ? clean(responseText) : null);
  return {
    row,
    body: {
      request_headers_json: JSON.stringify(redactHeaders(args.headers)),
      request_body: request.text,
      response_body: response.text,
      truncated: request.clipped || response.clipped ? 1 : 0,
    },
  };
}

function createRecorder({ writer, prices = null, providers = { list: () => [] }, getLogLevel = () => 'errors' }) {
  return {
    record(done) {
      let built;
      try {
        built = buildRecord(done, { prices, providers: providers.list(), logLevel: getLogLevel() });
      } catch (err) {
        // Lost like a batch that can't be written: counted, never thrown.
        writer.noteDropped(1, err);
        return;
      }
      writer.add(built.row, built.body);
    },
  };
}

module.exports = { buildRecord, createRecorder, redactHeaders };
