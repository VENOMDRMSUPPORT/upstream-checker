// src/catalog/ipc.js
'use strict';

// The renderer's only way to the catalog. Five channels, one thing each, the
// same rule src/db/ipc.js follows so two writers cannot overwrite each other.
//
// The provider adapters stay in the renderer — they own discovery and auth, and
// the page holds only venomkey: placeholders. So ingest and fetch-info receive
// the rows the adapter read and do the merge, the scoring and the writing here.
// Nothing on this surface ever carries a key: main reads the OpenRouter secret
// itself, at the point of use (src/main.js startCatalog's readKey).

const { providerRow, matchIds, qualityProxyIds } = require('./row');
const { syncSnapshot, dropNonText, validateProviderRows, providerRowSnapshot,
  restoreLastGoodRows } = require('./snapshot');

const LATENCY_SAMPLES_KEPT = 20;

// The fields a Fetch information click may report as moved. Exactly the provider's
// own facts (ref §8.1); a derived value changing would say the provider published
// something when only the reference moved.
const COMPARE_FIELDS = ['name', 'description', 'family', 'context_tokens', 'output_tokens',
  'input_modalities', 'output_modalities', 'tools', 'reasoning', 'structured', 'attachment',
  'cost_in_per_m', 'cost_out_per_m', 'cost_kind', 'release_date', 'status'];

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function diffRow(before, after) {
  const out = [];
  for (const field of COMPARE_FIELDS) {
    if (!same(before[field], after[field])) out.push({ field, from: before[field] ?? null, to: after[field] ?? null });
  }
  return out;
}

/** The newest sample is the last; p50 over the kept ring, null when empty. */
function readHealth(health) {
  const samples = ((health && health.latencies) || []).map((s) => s.ms).filter((n) => Number.isFinite(n));
  if (!samples.length) return { p50: null, samples: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const p50 = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  return { p50, samples: sorted.length };
}

function appendLatency(previous, at, ms) {
  const ring = ((previous && previous.latencies) || []).slice();
  if (Number.isFinite(ms)) ring.push({ at, ms: Math.round(ms) });
  return ring.slice(-LATENCY_SAMPLES_KEPT);
}

/**
 * The aliases a row may be matched by, and the base route it may borrow a score
 * from. Both are PROVIDER facts and both must reach `summary_json`, or the row
 * loses its only way to be scored on the next read.
 *
 * `row.js` emits the §8.1 fields and deliberately no `match_ids`, because the
 * aliases it generates are a function of the id. But ref §8.2 makes adapter-curated
 * aliases the only way some rows match at all — the reference's `wan-2.0` is
 * unreachable by any spelling this file could invent — while `scoring.js`'s
 * `lookupCatalogRow` step 1 is authoritative ONLY for a verbatim `match_ids` hit.
 * So the adapter's own list goes FIRST (lookupCatalogRow returns the first exact
 * hit, so a curated alias must never be displaced by a generated one), then the
 * generated ones, deduped. A `-thinking` route with no declared proxy gets the
 * one derivable from its id.
 */
function withAliases(row, model) {
  const declared = Array.isArray(model && model.match_ids)
    ? model.match_ids.filter((alias) => typeof alias === 'string' && alias.trim()) : [];
  row.match_ids = [...new Set([...declared, ...matchIds(row.id)])];
  const proxies = Array.isArray(model && model.quality_proxy_ids)
    ? model.quality_proxy_ids.filter((alias) => typeof alias === 'string' && alias.trim()) : [];
  row.quality_proxy_ids = proxies.length ? proxies : qualityProxyIds(row.id);
  return row;
}

function createCatalogIpc({ ipcMain, repos, engine, log = console }) {
  // The door (ref §9 refresh): one in-flight ingest per provider, shared by the
  // timer, a Fetch models click and a Fetch information click, so an overlap
  // costs one upstream fetch, one snapshot write, one diff.
  const inFlight = new Map();

  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        log.error(`${channel} failed:`, err.message);
        throw err;
      }
    });
  };

  function mapRows(providerId, models) {
    return models.map((m) => withAliases(providerRow(m, providerId), m));
  }

  // "How did the last attempt end", recorded where the read path can find it.
  // `setLastSync` answers false and writes nothing when the provider has never
  // produced a snapshot — it refuses to invent a phantom provider, so a failed
  // first attempt leaves `listProviderIds()` meaning "has ever synced".
  const recordFailure = (providerId, at, warning) => {
    try {
      repos.snapshots.setLastSync(providerId, { at, ok: false, warning });
    } catch (err) {
      log.warn(`catalog: could not record the failed attempt for ${providerId}:`, err.message);
    }
  };

  // The last-good roster, re-stamped and re-scored, served as stale.
  const staleFrom = (previous, at, warning) => ({
    ok: true, stale: true, warning,
    rows: engine.scoreRows(restoreLastGoodRows(previous, at)), changes: null,
  });

  // The write path for one provider, always behind the door.
  function ingest(providerId, models) {
    const existing = inFlight.get(providerId);
    if (existing) return existing;
    const job = (async () => {
      const list = Array.isArray(models) ? models : [];
      const now = Date.now();
      let stored;
      try {
        // The RAW roster is validated before anything is mapped: an adapter row
        // with no id, or the same id twice, is refused with the code the contract
        // names rather than with whatever providerRow happens to throw.
        validateProviderRows(providerId, list);
        const rows = mapRows(providerId, list);
        const { kept, dropped } = dropNonText({ provider: { id: providerId }, rows,
          isNonTextModel: (r) => engine.isNonTextModel(r) });
        stored = { rows: validateProviderRows(providerId, kept), dropped };
      } catch (err) {
        // An empty or malformed roster is not a removal: keep what we have and
        // say so. With nothing ever stored there is no roster to be stale about,
        // so the refusal goes on to the caller unchanged.
        const previous = repos.snapshots.read(providerId);
        if (!previous || !(previous.lastGoodRows || []).length) throw err;
        recordFailure(providerId, now, err.message);
        return staleFrom(previous, now, err.message);
      }
      let changes;
      try {
        changes = syncSnapshot(repos.snapshots, providerId, stored.rows, now, stored.dropped);
      } catch (err) {
        if (err.code !== 'SUSPICIOUS_PROVIDER_DROP') throw err;
        // syncSnapshot wrote the pending drop before throwing; setLastSync keeps
        // that column and adds the verdict the read path reports as stale.
        const previous = repos.snapshots.read(providerId);
        recordFailure(providerId, now, err.message);
        return staleFrom(previous, now, err.message);
      }
      const scored = engine.scoreRows(stored.rows.map(providerRowSnapshot));
      engine.syncIfUnscored(scored).catch(() => {});
      return { ok: true, stale: false, warning: null, rows: scored, changes };
    })();
    inFlight.set(providerId, job);
    job.finally(() => inFlight.delete(providerId)).catch(() => {});
    return job;
  }

  // The read path (ref §9 readConnected): snapshots re-scored against today's
  // reference. No fetch, no write, no event.
  function read() {
    const providerIds = repos.snapshots.listProviderIds();
    const rows = [];
    let oldest = null;
    let anyStale = false;
    let warning = null;
    for (const providerId of providerIds) {
      const snapshot = repos.snapshots.read(providerId);
      if (!snapshot) continue;
      if (snapshot.fetchedAt != null && (oldest === null || snapshot.fetchedAt < oldest)) {
        oldest = snapshot.fetchedAt;
      }
      if (snapshot.lastSync && snapshot.lastSync.ok === false) {
        anyStale = true;
        warning = snapshot.lastSync.warning;
      }
      // Re-stamped, not replayed: first_seen and the newness verdict come from the
      // history as it stands today, because is_new is never stored (Task 7).
      rows.push(...engine.scoreRows(restoreLastGoodRows(snapshot, Date.now())));
    }
    return { rows, readAt: Date.now(), oldestFetch: oldest, stale: anyStale, warning,
      lastSyncAt: engine.state.lastSyncAt, catalogCount: engine.state.catalog.rows.length };
  }

  function health(providerId, modelId, result) {
    const previous = repos.snapshots.getHealth(providerId, modelId);
    const stored = {
      status: result.status, note: result.note || null, httpStatus: result.httpStatus ?? null,
      at: result.at || Date.now(),
      latencies: appendLatency(previous, result.at || Date.now(), result.timeMs),
    };
    repos.snapshots.setHealth(providerId, modelId, stored);
    return readHealth(stored);
  }

  // Fetch information (spec §6): the network pass is TTL-gated, the merge and the
  // report never are.
  async function fetchInfo(providerId, modelId, models) {
    await engine.syncAll();
    const before = repos.snapshots.read(providerId);
    const beforeRow = before && (before.lastGoodRows || []).find((r) => String(r.id) === String(modelId));
    const { rows } = await ingest(providerId, models);
    const after = rows.find((r) => String(r.id) === String(modelId));
    if (!after) return { outcome: 'no-longer-listed', before: beforeRow || null, after: null, changes: null };
    if (after.matched_id == null) {
      return { outcome: 'no-match', before: beforeRow || null, after, changes: null };
    }
    const changes = beforeRow ? diffRow(beforeRow, after) : COMPARE_FIELDS
      .filter((f) => after[f] != null && after[f] !== '')
      .map((f) => ({ field: f, from: null, to: after[f] }));
    return { outcome: changes.length ? 'updated' : 'matched', before: beforeRow || null, after,
      changes: changes.length ? changes : null };
  }

  handle('catalog:ingest', (providerId, models) => ingest(providerId, models));
  handle('catalog:read', () => read());
  handle('catalog:health', (providerId, modelId, result) => health(providerId, modelId, result));
  // Two different asks, one channel, and only one of them may reach the network.
  //
  // `force` is the owner's click on Sync sources: syncAll, four documents, the
  // summary it just rebuilt. Without it the channel is the Interfaces contract
  // read literally — the engine's `summary()` — because its caller is Settings
  // › Catalog drawing four lines every time the section opens. syncAll's TTL is
  // "older than 15 minutes counts as due", so a non-forced syncAll on a machine
  // that has never fetched (or fetched this morning) would download five
  // megabytes because a page opened. Nothing may. The TTL-gated network pass
  // still exists for the callers that ask for it by name: catalog:fetch-info
  // calls engine.syncAll() itself, behind a row's own button.
  handle('catalog:sources', (query = {}) => (query.force === true
    ? engine.syncAll({ force: true })
    : engine.summary()));
  handle('catalog:fetch-info', (providerId, modelId, models) => fetchInfo(providerId, modelId, models));
}

module.exports = { createCatalogIpc, COMPARE_FIELDS, diffRow, readHealth, appendLatency,
  withAliases, LATENCY_SAMPLES_KEPT };
