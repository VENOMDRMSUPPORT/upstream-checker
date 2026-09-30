"use strict";

// Small pure helpers shared by the engine and the provider modules.
// Rule of the codebase: unknown stays `null`, never coerced to `false` or `0`.

function asNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** OpenRouter prices are per token; the app stores prices per million tokens. */
function perMillion(value) {
  const n = asNumber(value);
  return n == null ? null : n * 1_000_000;
}

/** Join lists / comma strings into one deduplicated, comma-separated string. */
function uniqueJoin(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    if (!value) continue;
    const items = Array.isArray(value) ? value : String(value).split(",");
    for (const item of items) {
      const token = String(item).trim();
      if (!token) continue;
      const key = token.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(token);
    }
  }
  return out.join(", ");
}

/** Unix seconds or milliseconds → "YYYY-MM-DD", or "" when unparsable. */
function unixToDate(value) {
  const n = asNumber(value);
  if (n == null) return "";
  const ms = n > 1e12 ? n : n * 1000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function boolOrNull(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function hasParam(params, name) {
  return Array.isArray(params) && params.includes(name);
}

function listHas(list, token) {
  const needle = String(token).toLowerCase();
  return (Array.isArray(list) ? list : String(list || "").split(",")).some(
    (item) => String(item).trim().toLowerCase() === needle,
  );
}

/** "openai/gpt-5" → "openai"; no slash → "". */
function providerOf(id) {
  const text = String(id || "");
  const slash = text.indexOf("/");
  return slash === -1 ? "" : text.slice(0, slash);
}

function median(values) {
  const sorted = values.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function monthsSince(date) {
  const t = Date.parse(date || "");
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (Date.now() - t) / (1000 * 3600 * 24 * 30.4));
}

module.exports = {
  asNumber,
  perMillion,
  uniqueJoin,
  unixToDate,
  boolOrNull,
  hasParam,
  listHas,
  providerOf,
  median,
  clamp,
  monthsSince,
};
