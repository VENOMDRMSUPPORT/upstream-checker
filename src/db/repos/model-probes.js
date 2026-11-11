// ============================================
// First-party capability probes — model_probes
// ============================================
// The latest verdict per (provider, model, probe kind), written by the
// catalog prober (src/catalog/probe.js) after it makes REAL calls
// through the app's own dispatch path. Readers: the measurement layer
// that stamps probe facts onto catalog rows, and the Models page.
//
// Statements are prepared on first use (the roster-events pattern):
// the table arrives with migration v8, and open() assembles the repos
// before it knows which migrations will run.

const PROBE_KINDS = new Set(['chat', 'tools']);

function createModelProbesRepo(db) {
  const prepared = new Map();
  const sql = (key, text) => {
    if (!prepared.has(key)) prepared.set(key, db.prepare(text));
    return prepared.get(key);
  };

  // Upsert the latest verdict for one probe kind. Returns false for
  // input this repo refuses to store (unknown kind, missing ids).
  function record({ providerId, modelId, kind, ok, detail = null, at = Date.now() } = {}) {
    if (!providerId || !modelId || !PROBE_KINDS.has(kind)) return false;
    sql('upsert', `INSERT INTO model_probes (provider_id, model_id, kind, ok, detail, measured_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_id, model_id, kind)
      DO UPDATE SET ok = excluded.ok, detail = excluded.detail, measured_at = excluded.measured_at`)
      .run(providerId, modelId, kind, ok ? 1 : 0,
        detail == null ? null : String(detail).slice(0, 300), at);
    return true;
  }

  function latest() {
    return sql('all', 'SELECT provider_id, model_id, kind, ok, detail, measured_at FROM model_probes')
      .all().map((r) => ({
        providerId: r.provider_id,
        modelId: r.model_id,
        kind: r.kind,
        ok: r.ok === 1,
        detail: r.detail,
        measuredAt: r.measured_at,
      }));
  }

  return { record, latest };
}

module.exports = { createModelProbesRepo, PROBE_KINDS };
