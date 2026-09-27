// ============================================
// Log pages — pure formatting and mapping
// ============================================
// Plain top-level functions, no IIFE and no globals touched at evaluation
// time, so test/renderer/logs-format.test.js can read this file and evaluate
// it the way test/renderer-ulid.test.js does with ulid.js. Everything here
// takes values and returns values: no DOM, no IPC, no state.

// The three short ranges are offered everywhere. The two long ones are
// Monitoring's alone, and only when nothing is grouped: the request list
// cannot sort by an unindexed column over them, and a grouped chart over a
// year costs about 1.4 s on the main thread.
const LOGS_RANGES = {
  '24h': 24 * 3600000,
  '7d': 7 * 24 * 3600000,
  '30d': 30 * 24 * 3600000,
  '90d': 90 * 24 * 3600000,
  '12m': 365 * 24 * 3600000,
};

// Model ids, provider names and error messages are a provider's own text and
// all of them land in innerHTML. Everything that reaches the page goes
// through here first — in a renderer the alternative is script execution, not
// an ugly row.
//
// NOT named escapeHtml: app.js already declares a global of that name that
// app.js and profiles.js both call, and a classic script loaded after app.js
// would silently replace it — turning its `if (!str) return ''` into the
// literal "null" for every falsy argument, app-wide.
function logEscape(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// The log rolls an unknown provider up as '' in usage_hourly and stores it as
// NULL on the row. One token for both, so a chart series and a table row for
// the same traffic line up. Display side only: facets filter out '', so
// "unknown" is never offered as a filter.
function normalizeProvider(id) {
  return id === null || id === undefined || id === '' ? 'unknown' : id;
}

function providerLabel(id, name) {
  if (normalizeProvider(id) === 'unknown') return 'Unknown provider';
  return name || id;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60000);
  return `${m} m ${Math.round((ms - m * 60000) / 1000)} s`;
}

function formatCost(micros) {
  if (!Number.isFinite(micros)) return '—';
  if (micros === 0) return '$0';
  const dollars = micros / 1e6;
  if (dollars < 0.0001) return '<$0.0001';
  if (dollars < 1) return `$${dollars.toFixed(4)}`;
  return `$${dollars.toFixed(2)}`;
}

function formatTokens(n) {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US');
}

// Both halves are local. Taking the date from toISOString() while the time
// came from toTimeString() showed yesterday's date beside today's time for
// every row logged between midnight and the UTC offset — and disagreed with
// localDay() in query.js, which buckets the day charts.
function logPad(n) {
  return String(n).padStart(2, '0');
}

function formatWhen(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const time = `${logPad(d.getHours())}:${logPad(d.getMinutes())}:${logPad(d.getSeconds())}`;
  if (new Date(now).toDateString() === d.toDateString()) return time;
  return `${d.getFullYear()}-${logPad(d.getMonth() + 1)}-${logPad(d.getDate())} ${time}`;
}

// pass = it worked; warn = the provider said no for a reason that is not a
// fault (rate limit, quota, blocked); fail = it broke; muted = nobody waited
// for an answer.
function statusTone(row) {
  if (row.status === 'ok') return 'pass';
  if (row.status === 'cancelled') return 'muted';
  if (row.error_class === 'blocked' || row.error_class === 'rate_limit' || row.error_class === 'quota') return 'warn';
  return 'fail';
}

function passRateText(rate) {
  if (!Number.isFinite(rate)) return '—';
  return `${Math.round(rate * 100)}%`;
}

function rangePreset(key, now = Date.now()) {
  const span = LOGS_RANGES[key];
  if (!span) throw new RangeError(`Unknown range "${key}"`);
  // `to` is exclusive everywhere in the query API, so it must pass now.
  return { from: now - span, to: now + 1 };
}

function toViewModel(row, providerNames = {}) {
  const pid = normalizeProvider(row.provider_id);
  const tokens = (Number.isFinite(row.input_tokens) ? row.input_tokens : 0)
    + (Number.isFinite(row.output_tokens) ? row.output_tokens : 0);
  const anyTokens = Number.isFinite(row.input_tokens) || Number.isFinite(row.output_tokens);
  // Every string here is escaped once, at the boundary, so no caller has to
  // remember to do it.
  return {
    id: row.id,
    when: formatWhen(row.created_at),
    source: logEscape(row.source),
    provider: logEscape(providerLabel(row.provider_id, row.provider_name || providerNames[pid] || null)),
    model: logEscape(row.model_returned || row.model_requested || '—'),
    status: logEscape(row.status),
    errorClass: row.error_class ? logEscape(row.error_class) : null,
    errorMessage: row.error_message ? logEscape(row.error_message) : null,
    latency: formatDuration(row.latency_ms),
    ttft: row.is_stream ? formatDuration(row.ttft_ms) : '—',
    tokens: anyTokens ? formatTokens(tokens) : '—',
    cost: formatCost(row.cost_micros),
    tone: statusTone(row),
    hasBody: !!row.has_body,
  };
}
