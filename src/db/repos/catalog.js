// ============================================
// Model pool — models, key links, sync times, catalogue meta
// ============================================
// The renderer still owns the catalogue object and sends it whole
// (write-catalog). Main compares every entry with a hash of the row it wrote
// last and writes only what changed, in one transaction — a sync that changes
// nothing writes nothing. Granular IPC per mutation can come later.
//
// Entry ↔ row mapping (spec §1): scalar fields have columns; the summary
// fields go to summary_json with any unknown field under `extra`, so a round
// trip never drops data; bench/history/caps stay JSON.
const SUMMARY_KEYS = ['pricing', 'declaresTools', 'maxOutput', 'hasVision', 'hasReasoning', 'isFree', 'isFreeForPaid', 'contextLabel', 'contextWindow', 'ownedBy'];
const COLUMN_FIELDS = new Set(['key', 'providerId', 'id', 'name', 'kind', 'firstSeen', 'lastSeen', 'removedAt', 'isNew', 'bench', 'history', 'benchError', 'caps', 'capsError', 'keyIds', ...SUMMARY_KEYS]);
const META_KEYS = ['leaderboard', 'leaderboardError', 'profiles'];
const HASH_COLUMNS = ['name', 'kind', 'first_seen', 'last_seen', 'removed_at', 'is_new', 'summary_json', 'bench_json', 'history_json', 'bench_error', 'caps_json', 'caps_error'];

const keyOf = (providerId, modelId) => `${providerId}::${modelId}`;
const numOrNull = (v) => (Number.isFinite(v) ? v : null);
// JSON columns keep null apart from absent: SQL NULL = absent, 'null' = null.
const jsonOrNull = (v) => (v === undefined ? null : JSON.stringify(v));
const textOrNull = (v) => (v === undefined || v === null ? null : String(v));

function entryToRow(entry) {
  const summary = {};
  SUMMARY_KEYS.forEach((k) => { if (entry[k] !== undefined) summary[k] = entry[k]; });
  const extra = {};
  Object.keys(entry).forEach((k) => { if (!COLUMN_FIELDS.has(k) && entry[k] !== undefined) extra[k] = entry[k]; });
  if (Object.keys(extra).length) summary.extra = extra;
  return {
    provider_id: entry.providerId,
    model_id: entry.id,
    name: typeof entry.name === 'string' ? entry.name : null,
    kind: typeof entry.kind === 'string' ? entry.kind : null,
    first_seen: numOrNull(entry.firstSeen),
    last_seen: numOrNull(entry.lastSeen),
    removed_at: numOrNull(entry.removedAt),
    is_new: entry.isNew ? 1 : 0,
    summary_json: JSON.stringify(summary),
    bench_json: jsonOrNull(entry.bench),
    history_json: jsonOrNull(entry.history),
    bench_error: textOrNull(entry.benchError),
    caps_json: jsonOrNull(entry.caps),
    caps_error: textOrNull(entry.capsError),
  };
}

// Deduped, order kept: rows are re-inserted in this order and read back by rowid.
function entryKeyIds(entry) {
  return Array.isArray(entry.keyIds) ? [...new Set(entry.keyIds.filter((k) => typeof k === 'string' && k))] : [];
}

function rowHash(row, keyIds) {
  return JSON.stringify([HASH_COLUMNS.map((c) => row[c]), keyIds]);
}

function rowToEntry(row, keyIds) {
  const { extra, ...summary } = JSON.parse(row.summary_json || '{}');
  const e = { ...(extra || {}), key: keyOf(row.provider_id, row.model_id), providerId: row.provider_id, id: row.model_id };
  if (row.name !== null) e.name = row.name;
  if (row.kind !== null) e.kind = row.kind;
  if (row.first_seen !== null) e.firstSeen = row.first_seen;
  if (row.last_seen !== null) e.lastSeen = row.last_seen;
  e.removedAt = row.removed_at;
  e.isNew = row.is_new === 1;
  Object.assign(e, summary);
  if (row.bench_json !== null) e.bench = JSON.parse(row.bench_json);
  if (row.history_json !== null) e.history = JSON.parse(row.history_json);
  // Absent and null read the same to the renderer; both come back as null.
  e.benchError = row.bench_error;
  if (row.caps_json !== null) e.caps = JSON.parse(row.caps_json);
  e.capsError = row.caps_error;
  e.keyIds = keyIds;
  return e;
}

function createCatalogRepo(db) {
  const q = {
    models: db.prepare('SELECT * FROM models'),
    modelKeys: db.prepare('SELECT provider_id, model_id, key_id FROM model_keys ORDER BY rowid'),
    upsertModel: db.prepare(`INSERT INTO models (provider_id, model_id, name, kind, first_seen, last_seen, removed_at, is_new,
        summary_json, bench_json, history_json, bench_error, caps_json, caps_error, updated_at)
      VALUES (@provider_id, @model_id, @name, @kind, @first_seen, @last_seen, @removed_at, @is_new,
        @summary_json, @bench_json, @history_json, @bench_error, @caps_json, @caps_error, @updated_at)
      ON CONFLICT(provider_id, model_id) DO UPDATE SET name = excluded.name, kind = excluded.kind,
        first_seen = excluded.first_seen, last_seen = excluded.last_seen, removed_at = excluded.removed_at,
        is_new = excluded.is_new, summary_json = excluded.summary_json, bench_json = excluded.bench_json,
        history_json = excluded.history_json, bench_error = excluded.bench_error, caps_json = excluded.caps_json,
        caps_error = excluded.caps_error, updated_at = excluded.updated_at`),
    deleteModel: db.prepare('DELETE FROM models WHERE provider_id = ? AND model_id = ?'),
    deleteModelKeys: db.prepare('DELETE FROM model_keys WHERE provider_id = ? AND model_id = ?'),
    insertModelKey: db.prepare('INSERT INTO model_keys (provider_id, model_id, key_id) VALUES (?, ?, ?)'),
    syncRows: db.prepare('SELECT provider_id, last_sync_at FROM provider_sync'),
    upsertSync: db.prepare(`INSERT INTO provider_sync (provider_id, last_sync_at) VALUES (?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET last_sync_at = excluded.last_sync_at`),
    deleteSync: db.prepare('DELETE FROM provider_sync WHERE provider_id = ?'),
    countRows: db.prepare('SELECT key_id, count, at FROM key_model_counts'),
    upsertCount: db.prepare(`INSERT INTO key_model_counts (key_id, count, at) VALUES (?, ?, ?)
      ON CONFLICT(key_id) DO UPDATE SET count = excluded.count, at = excluded.at`),
    deleteCount: db.prepare('DELETE FROM key_model_counts WHERE key_id = ?'),
    meta: db.prepare('SELECT value_json FROM catalog_meta WHERE key = ?'),
    upsertMeta: db.prepare(`INSERT INTO catalog_meta (key, value_json) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`),
    deleteMeta: db.prepare('DELETE FROM catalog_meta WHERE key = ?'),
  };

  // 'pid::mid' -> { hash, providerId, modelId } for every row on disk; null
  // until built. Replaced only after a commit, so a rolled-back write can't
  // make the next one skip rows that never reached the disk.
  let hashes = null;

  function loadModels() {
    const keyIds = new Map();
    q.modelKeys.all().forEach((r) => {
      const k = keyOf(r.provider_id, r.model_id);
      if (!keyIds.has(k)) keyIds.set(k, []);
      keyIds.get(k).push(r.key_id);
    });
    const models = {};
    const fresh = new Map();
    q.models.all().forEach((row) => {
      const k = keyOf(row.provider_id, row.model_id);
      const ids = keyIds.get(k) || [];
      models[k] = rowToEntry(row, ids);
      fresh.set(k, { hash: rowHash(row, ids), providerId: row.provider_id, modelId: row.model_id });
    });
    hashes = fresh;
    return models;
  }

  function read() {
    const models = loadModels();
    const lastSync = {};
    q.syncRows.all().forEach((r) => { lastSync[r.provider_id] = r.last_sync_at; });
    const keyModels = {};
    q.countRows.all().forEach((r) => { keyModels[r.key_id] = { count: r.count, at: r.at }; });
    const out = { version: 1, models, lastSync, keyModels, leaderboard: null };
    META_KEYS.forEach((k) => {
      const row = q.meta.get(k);
      if (row) out[k] = JSON.parse(row.value_json);
    });
    return out;
  }

  function writeLastSync(map) {
    const current = new Map(q.syncRows.all().map((r) => [r.provider_id, r.last_sync_at]));
    const seen = new Set();
    Object.entries(map).forEach(([pid, at]) => {
      if (!Number.isFinite(at)) return;
      seen.add(pid);
      if (current.get(pid) !== at) q.upsertSync.run(pid, at);
    });
    current.forEach((_, pid) => { if (!seen.has(pid)) q.deleteSync.run(pid); });
  }

  function writeKeyModels(map) {
    const current = new Map(q.countRows.all().map((r) => [r.key_id, r]));
    const seen = new Set();
    Object.entries(map).forEach(([kid, v]) => {
      if (!v || !Number.isFinite(v.count) || !Number.isFinite(v.at)) return;
      seen.add(kid);
      const had = current.get(kid);
      if (!had || had.count !== v.count || had.at !== v.at) q.upsertCount.run(kid, v.count, v.at);
    });
    current.forEach((_, kid) => { if (!seen.has(kid)) q.deleteCount.run(kid); });
  }

  function writeMeta(key, value) {
    if (value === undefined) {
      q.deleteMeta.run(key);
      return;
    }
    const json = JSON.stringify(value);
    const row = q.meta.get(key);
    if (!row || row.value_json !== json) q.upsertMeta.run(key, json);
  }

  function write(catalog, { reset = false } = {}) {
    if (!catalog || typeof catalog !== 'object' || !catalog.models || typeof catalog.models !== 'object') {
      throw new TypeError('write-catalog needs an object with models');
    }
    if (!hashes) loadModels();
    const next = new Map();
    Object.values(catalog.models).forEach((entry) => {
      if (!entry || typeof entry !== 'object' || typeof entry.providerId !== 'string' || !entry.providerId || typeof entry.id !== 'string' || !entry.id) {
        throw new TypeError('A catalogue entry needs providerId and id');
      }
      const row = entryToRow(entry);
      const keyIds = entryKeyIds(entry);
      next.set(keyOf(row.provider_id, row.model_id), { row, keyIds, hash: rowHash(row, keyIds) });
    });
    // A failed read or a bug upstream must never wipe the pool; only the
    // Clear/Reset buttons send reset.
    if (next.size === 0 && hashes.size > 0 && reset !== true) throw new Error('Refusing to empty the model pool without a reset');

    const now = Date.now();
    let written = 0;
    let deleted = 0;
    db.transaction(() => {
      next.forEach((n, k) => {
        const had = hashes.get(k);
        if (had && had.hash === n.hash) return;
        q.upsertModel.run({ ...n.row, updated_at: now });
        q.deleteModelKeys.run(n.row.provider_id, n.row.model_id);
        n.keyIds.forEach((kid) => q.insertModelKey.run(n.row.provider_id, n.row.model_id, kid));
        written += 1;
      });
      hashes.forEach((h, k) => {
        if (next.has(k)) return;
        q.deleteModel.run(h.providerId, h.modelId);
        deleted += 1;
      });
      if (catalog.lastSync && typeof catalog.lastSync === 'object') writeLastSync(catalog.lastSync);
      if (catalog.keyModels && typeof catalog.keyModels === 'object') writeKeyModels(catalog.keyModels);
      META_KEYS.forEach((k) => { if (k in catalog) writeMeta(k, catalog[k]); });
    })();

    const fresh = new Map();
    next.forEach((n, k) => fresh.set(k, { hash: n.hash, providerId: n.row.provider_id, modelId: n.row.model_id }));
    hashes = fresh;
    return { written, deleted };
  }

  function resetCache() {
    hashes = null;
  }

  return { read, write, resetCache };
}

module.exports = { createCatalogRepo };
