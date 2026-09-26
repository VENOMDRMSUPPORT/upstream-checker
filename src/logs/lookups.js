// ============================================
// venom.db lookups for the request log
// ============================================
// The recorder names each request's provider and prices it. Both come from
// venom.db, on main's own connection and thread: the providers table is a
// handful of rows, read per record; prices are cached per (provider, model),
// and main drops the cache whenever write-catalog saves the model pool.
function createProviderLookup(db) {
  const all = db.prepare('SELECT id, name, base_url AS baseUrl FROM providers');
  return { list: () => all.all() };
}

// summary_json.pricing is { input, output, source } in USD per 1M tokens
// (src/renderer/catalog.js readPricing). Anything else is "unknown".
function readPrice(summaryJson) {
  let pricing;
  try {
    pricing = JSON.parse(summaryJson || '{}').pricing;
  } catch (_) {
    return null;
  }
  if (!pricing || typeof pricing !== 'object') return null;
  const { input, output } = pricing;
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return null;
  return { input, output };
}

function createPriceBook(db) {
  const one = db.prepare('SELECT summary_json FROM models WHERE provider_id = ? AND model_id = ?');
  const cache = new Map();
  return {
    get(providerId, modelId) {
      const key = `${providerId}\u0000${modelId}`;
      if (!cache.has(key)) {
        const row = one.get(providerId, modelId);
        cache.set(key, row ? readPrice(row.summary_json) : null);
      }
      return cache.get(key);
    },
    invalidate() {
      cache.clear();
    },
  };
}

module.exports = { createPriceBook, createProviderLookup };
