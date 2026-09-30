'use strict';

// One provider's roster, split across the two tables the reference kept in one
// JSON file: snapshot_meta holds the file-level fields, roster_snapshot holds
// each model's history entry and the provider's own facts for it. Assembled here
// so src/catalog/snapshot.js sees the same object shape the reference did, and
// so one sync is one transaction — a half-written roster can never become the
// baseline the next sync is diffed against.
//
// Column ownership is the one rule this file exists to keep: `setHealth` is the
// only writer of health_json, and the roster writer never touches it. Two tables
// is what makes that a hazard at all — in the reference both halves lived in one
// object one writer replaced wholesale. `setLastSync` is the same rule one level
// up: it answers "how did the last attempt end", so it writes one meta column and
// no roster row, not even an `updated_at`.

const WARNING_MAX = 200;

function clip(text) {
  if (typeof text !== 'string') return text == null ? null : String(text);
  return text.length > WARNING_MAX ? text.slice(0, WARNING_MAX) : text;
}

function createSnapshotRepo(db) {
  const readMeta = db.prepare('SELECT * FROM snapshot_meta WHERE provider_id = ?');
  const readRows = db.prepare('SELECT * FROM roster_snapshot WHERE provider_id = ?');
  const readHealth = db.prepare('SELECT health_json FROM roster_snapshot WHERE provider_id = ? AND model_id = ?');
  const writeMeta = db.prepare(`
    INSERT INTO snapshot_meta (provider_id, created_at, fetched_at, last_sync_json, pending_drop_json)
    VALUES (@provider_id, @created_at, @fetched_at, @last_sync_json, @pending_drop_json)
    ON CONFLICT(provider_id) DO UPDATE SET
      created_at = @created_at, fetched_at = @fetched_at,
      last_sync_json = @last_sync_json, pending_drop_json = @pending_drop_json
  `);
  // health_json appears in the VALUES only so a re-inserted row can be given the
  // value this writer just read; the conflict branch COALESCEs to the stored one,
  // so no roster rewrite — and no future rewrite of this statement — can clear a
  // model's latency history.
  const writeRow = db.prepare(`
    INSERT INTO roster_snapshot
      (provider_id, model_id, name, first_seen, last_seen, removed_at, summary_json, health_json, updated_at)
    VALUES (@provider_id, @model_id, @name, @first_seen, @last_seen, @removed_at, @summary_json, @health_json, @updated_at)
    ON CONFLICT(provider_id, model_id) DO UPDATE SET
      name = @name, first_seen = @first_seen, last_seen = @last_seen, removed_at = @removed_at,
      summary_json = @summary_json, updated_at = @updated_at,
      health_json = COALESCE(roster_snapshot.health_json, excluded.health_json)
  `);
  // Health is written on its own: a health check must never rewrite the row's
  // history or its summary as a side effect of recording one probe.
  const writeHealth = db.prepare('UPDATE roster_snapshot SET health_json = ?, updated_at = ? WHERE provider_id = ? AND model_id = ?');
  const deleteRow = db.prepare('DELETE FROM roster_snapshot WHERE provider_id = ? AND model_id = ?');
  const listStmt = db.prepare('SELECT provider_id FROM snapshot_meta ORDER BY provider_id');

  const entryOf = (row) => {
    const entry = { name: row.name, first_seen: row.first_seen, last_seen: row.last_seen };
    if (row.removed_at != null) entry.removed_at = row.removed_at;
    return entry;
  };

  function read(providerId) {
    const meta = readMeta.get(providerId);
    if (!meta) return null;
    const rows = readRows.all(providerId);
    const models = {};
    const lastGoodRows = [];
    for (const row of rows) {
      models[row.model_id] = entryOf(row);
      // A tombstoned model is history, not a row the read path should serve.
      if (row.removed_at == null && row.summary_json) {
        lastGoodRows.push(JSON.parse(row.summary_json));
      }
    }
    const snapshot = {
      createdAt: meta.created_at,
      fetchedAt: meta.fetched_at,
      models,
      lastGoodRows,
      lastSync: meta.last_sync_json ? JSON.parse(meta.last_sync_json) : null,
    };
    // pendingDrop stays absent rather than null: syncSnapshot deletes the key when
    // a quarantine is confirmed, and `in` is how the diff asks whether one is live.
    // `is_new` is deliberately not a column. The reference never stored it either:
    // it is `first_seen !== createdAt` within the 7-day window, so it is computed
    // at read time by restoreLastGoodRows (Task 8) — storing it would freeze a
    // verdict that changes on its own as the clock moves.
    if (meta.pending_drop_json) snapshot.pendingDrop = JSON.parse(meta.pending_drop_json);
    return snapshot;
  }

  function write(providerId, snapshot) {
    const now = Date.now();
    const run = db.transaction(() => {
      writeMeta.run({
        provider_id: providerId,
        created_at: snapshot.createdAt,
        fetched_at: snapshot.fetchedAt == null ? null : snapshot.fetchedAt,
        last_sync_json: snapshot.lastSync ? JSON.stringify(snapshot.lastSync) : null,
        pending_drop_json: snapshot.pendingDrop ? JSON.stringify(snapshot.pendingDrop) : null,
      });

      // One pass over the provider's rows, used twice: for the health each row
      // already carries, and for the ids this snapshot no longer knows.
      const previous = new Map(readRows.all(providerId).map((row) => [row.model_id, row.health_json]));

      // The summary travels with the history entry that names the same model, so
      // one row answers both "when have we seen this" and "what does the provider
      // say about it". A model in lastGoodRows but not in models is a provider
      // fact with no history — impossible after a sync, and refused here rather
      // than stored under a first_seen nobody observed.
      const summaries = new Map((snapshot.lastGoodRows || []).map((r) => [String(r.id), r]));
      const keep = new Set();
      for (const [id, entry] of Object.entries(snapshot.models || {})) {
        keep.add(id);
        const summary = summaries.get(id);
        writeRow.run({
          provider_id: providerId,
          model_id: id,
          name: entry.name ?? null,
          first_seen: entry.first_seen,
          last_seen: entry.last_seen,
          removed_at: entry.removed_at == null ? null : entry.removed_at,
          summary_json: summary ? JSON.stringify(summary) : null,
          health_json: previous.has(id) ? previous.get(id) : null,
          updated_at: now,
        });
      }
      // `forget` in syncSnapshot deletes from snapshot.models before writing, so a
      // row that is gone from the object is gone from the table too — and its
      // health goes with it, because the row that held it is gone.
      for (const id of previous.keys()) {
        if (!keep.has(id)) deleteRow.run(providerId, id);
      }
    });
    run();
  }

  // How an attempt ended, written onto the provider's meta row and nowhere else.
  //
  // This does not go through `write`, for two reasons. (1) A failure did not
  // replace any roster, so it must not re-stamp `updated_at` on rows it never
  // fetched — that would claim the roster is newer than `fetched_at` says it is.
  // (2) A failure needs something to qualify. With no snapshot there is no
  // last-good roster for the attempt to be stale about, and the reference
  // refuses exactly that (providers/index.js:440-442, "Nothing is written when
  // there is no snapshot yet"). So this answers `false` and invents no provider
  // row — the same signal `sources.writeCacheFailure` gives when no payload is
  // cached, and the reason `listProviderIds()` keeps meaning "has ever produced a
  // snapshot" rather than "has ever been attempted".
  function setLastSync(providerId, { at, ok, warning }) {
    const meta = readMeta.get(providerId);
    if (!meta) return false;
    // writeMeta replaces all four meta columns, so the three that are not about
    // this attempt are handed back exactly as stored — a quarantine in particular
    // survives the failure that found nothing to do with it.
    writeMeta.run({
      provider_id: providerId,
      created_at: meta.created_at,
      fetched_at: meta.fetched_at,
      last_sync_json: JSON.stringify({ at, ok: Boolean(ok), warning: clip(warning) }),
      pending_drop_json: meta.pending_drop_json,
    });
    return true;
  }

  function setHealth(providerId, modelId, health) {
    const changed = writeHealth.run(health ? JSON.stringify(health) : null, Date.now(), providerId, modelId).changes;
    if (!changed) throw new Error(`unknown model ${providerId}/${modelId}`);
    return health;
  }

  function getHealth(providerId, modelId) {
    const row = readHealth.get(providerId, String(modelId));
    return row && row.health_json ? JSON.parse(row.health_json) : null;
  }

  return {
    read,
    write,
    setLastSync,
    setHealth,
    getHealth,
    listProviderIds: () => listStmt.all().map((r) => r.provider_id),
  };
}

module.exports = { createSnapshotRepo, WARNING_MAX };
