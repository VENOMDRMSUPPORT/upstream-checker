// ============================================
// venom.db lookups for the request log
// ============================================
// The recorder names each request's provider and prices it. Both come from
// venom.db, on main's own connection and thread: the providers table is a
// handful of rows, read per record; prices are cached per (provider, model),
// and main drops the cache whenever a roster is ingested.
//
// Prices come from roster_snapshot.summary_json, the engine's own table: a
// provider row stored under cost_in_per_m / cost_out_per_m, in USD per 1M
// tokens. The old `models` table is gone (migration v3), so pointing this at
// it would have left every logged request with a null cost and no error.
function createProviderLookup(db) {
  const all = db.prepare('SELECT id, name, base_url AS baseUrl FROM providers');
  return { list: () => all.all() };
}

// A stored row's own fields. A row whose price was BORROWED from the reference
// is stored with it blanked (providerRowSnapshot re-blanks every borrowed
// field), so it reads as unknown here rather than as a wrong number — the same
// rule the Models page draws from.
function readPrice(summaryJson) {
  let row;
  try {
    row = JSON.parse(summaryJson || '{}');
  } catch (_) {
    return null;
  }
  if (!row || typeof row !== 'object') return null;
  const { cost_in_per_m: input, cost_out_per_m: output } = row;
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return null;
  return { input, output };
}

function createPriceBook(db) {
  const one = db.prepare('SELECT summary_json FROM roster_snapshot WHERE provider_id = ? AND model_id = ?');
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
