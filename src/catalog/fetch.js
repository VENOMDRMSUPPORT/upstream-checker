'use strict';

// The one JSON fetch helper for every upstream call the catalog makes. Sends
// `accept: application/json`, aborts after the timeout, throws on a non-2xx, and
// retries exactly once on any failure — timeout, network, non-2xx, bad JSON —
// after a short delay. A transient blip on a public API must not read as "the
// source is gone" when trying again a moment later would have worked.

const DEFAULT_TIMEOUT_MS = 20000;
const RETRY_DELAY_MS = 400;
const DEFAULT_CACHE_TTL_MS = 60000;

function friendlyMessage(error, timeoutMs) {
  if (error.name === 'AbortError') return `timed out after ${Math.round(timeoutMs / 1000)}s`;
  return error.message;
}

function createFetcher({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryDelayMs = RETRY_DELAY_MS,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref && t.unref(); }),
} = {}) {
  async function fetchOnce(url, headers, limitMs) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), limitMs);
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/json', ...headers },
        signal: ac.signal,
      });
      const text = await response.text();
      // Read the body before the status check: an answer of any status proves
      // the host is up, which is what the reachability layer needed, and the
      // error text a 4xx carries is the only useful thing to report.
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchJson(url, headers = {}, limitMs = timeoutMs) {
    try {
      return await fetchOnce(url, headers, limitMs);
    } catch (firstError) {
      await sleep(retryDelayMs);
      try {
        return await fetchOnce(url, headers, limitMs);
      } catch (secondError) {
        throw new Error(`${friendlyMessage(secondError, limitMs)} (retried once)`);
      }
    }
  }

  const cache = new Map(); // url -> { at, promise }

  // Deduplicated by URL only. Sound for these documents: three are unauthenticated
  // and the fourth always carries the same single key. A failed fetch is evicted
  // immediately so the next caller retries instead of inheriting the rejection.
  function fetchJsonCached(url, headers = {}, ttlMs = cacheTtlMs) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
    const promise = fetchJson(url, headers);
    promise.catch(() => cache.delete(url));
    cache.set(url, { at: Date.now(), promise });
    return promise;
  }

  return { fetchJson, fetchJsonCached };
}

module.exports = {
  createFetcher,
  DEFAULT_TIMEOUT_MS, RETRY_DELAY_MS, DEFAULT_CACHE_TTL_MS,
};
