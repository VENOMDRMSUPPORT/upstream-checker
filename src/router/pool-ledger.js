'use strict';

// Pool window ledger (tier design §2.1, build step 2): how much of
// each quota pool's rolling windows the router itself has spent,
// derived from the request log — the log is the store, nothing new is
// persisted. A pool is the set of keys sharing one quota_pool_id; a
// key without one is a pool of its own, so a pool's usage is the sum
// over its keys, counted once however many keys the pool holds.
//
// The ledger reports raw provider tokens exactly as the log recorded
// them. Providers that meter differently stay reconcilable through
// their own channels: percentage pools (Antigravity) publish the
// remaining percentage via key-usage, and weighted billing (ApiNex —
// the public roster's per-model weight multiplies raw tokens,
// verified live 2026-11-11 when two identical calls deducted exactly
// weight × raw) is a conversion at display time, not a ledger change.
//
// Pure and synchronous: the reader is injected (in the app it is the
// logs query's keyWindowUsage over venom-logs.db), so the ledger is
// unit-testable without a database. Nothing here picks keys — the
// pool-aware picker (build step 3) consumes these numbers.

const HOUR_MS = 60 * 60 * 1000;
const POOL_WINDOWS = Object.freeze({
  '5h': 5 * HOUR_MS,
  '24h': 24 * HOUR_MS,
  '7d': 7 * 24 * HOUR_MS,
});

function poolIdOf(key) {
  if (!key) return '';
  return String(key.quotaPoolId || key.quota_pool_id || key.id || '');
}

function emptyWindow() {
  return { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, byModel: {} };
}

function addRow(window, row) {
  const input = row.inputTokens || 0;
  const output = row.outputTokens || 0;
  window.requests += row.requests || 0;
  window.inputTokens += input;
  window.outputTokens += output;
  window.totalTokens += input + output;
  const modelId = row.modelId || '';
  if (!modelId) return;
  const m = window.byModel[modelId]
    || (window.byModel[modelId] = { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  m.requests += row.requests || 0;
  m.inputTokens += input;
  m.outputTokens += output;
  m.totalTokens += input + output;
}

function createPoolLedger({ keys = [], readWindowUsage, windows = POOL_WINDOWS, now = Date.now } = {}) {
  if (typeof readWindowUsage !== 'function') {
    throw new TypeError('createPoolLedger needs a readWindowUsage(keyIds, sinceMs) reader');
  }
  let keyList = [];
  let keyIds = [];
  let poolOfKey = new Map();
  function setKeys(next) {
    keyList = (Array.isArray(next) ? next : []).filter((k) => k && k.id);
    keyIds = keyList.map((k) => String(k.id));
    poolOfKey = new Map(keyList.map((k) => [String(k.id), poolIdOf(k)]));
  }
  setKeys(keys);
  const entries = Object.entries(windows || {});
  const windowEntries = entries.length ? entries : Object.entries(POOL_WINDOWS);

  // One reader call per window (the SQL side aggregates), then the
  // per-key rows are grouped into pools.
  function snapshot() {
    const at = now();
    const pools = new Map();
    for (const k of keyList) {
      const poolId = poolIdOf(k);
      if (!pools.has(poolId)) {
        pools.set(poolId, {
          poolId,
          keyIds: keyList.filter((x) => poolIdOf(x) === poolId).map((x) => String(x.id)),
          windows: Object.fromEntries(windowEntries.map(([name]) => [name, emptyWindow()])),
        });
      }
    }
    for (const [name, spanMs] of windowEntries) {
      const rows = readWindowUsage(keyIds.slice(), at - spanMs) || [];
      for (const row of rows) {
        const pool = pools.get(poolOfKey.get(String(row.keyId || '')));
        if (pool) addRow(pool.windows[name], row);
      }
    }
    return { at, pools: [...pools.values()] };
  }

  return {
    snapshot,
    refresh: setKeys,
    get poolIds() { return [...new Set(keyList.map(poolIdOf))]; },
  };
}

// Rank pools for one window, fullest first — the data behind §2.2
// rule 1. With a token budget for a pool (a plain object or a Map of
// poolId -> tokens), the remaining fraction decides. Pools without a
// known budget sort after budgeted ones, least used first: their
// headroom is unproven, so proven headroom wins.
function rankPoolsByRemaining(snapshot, windowName, budgets) {
  const budgetOf = (poolId) => {
    if (!budgets) return null;
    const v = typeof budgets.get === 'function' ? budgets.get(poolId) : budgets[poolId];
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const ranked = (snapshot && Array.isArray(snapshot.pools) ? snapshot.pools : []).map((pool) => {
    const w = (pool.windows && pool.windows[windowName]) || emptyWindow();
    const budget = budgetOf(pool.poolId);
    const remaining = budget == null ? null : Math.max(0, budget - w.totalTokens);
    return {
      poolId: pool.poolId,
      keyIds: pool.keyIds || [],
      used: w.totalTokens,
      requests: w.requests,
      budget,
      remaining,
      remainingFraction: remaining == null ? null : remaining / budget,
    };
  });
  ranked.sort((a, b) => {
    if (a.remainingFraction != null && b.remainingFraction != null) {
      return (b.remainingFraction - a.remainingFraction) || (b.remaining - a.remaining);
    }
    if (a.remainingFraction != null) return -1;
    if (b.remainingFraction != null) return 1;
    return (a.used - b.used) || String(a.poolId).localeCompare(String(b.poolId));
  });
  return ranked;
}

module.exports = { POOL_WINDOWS, poolIdOf, createPoolLedger, rankPoolsByRemaining };
