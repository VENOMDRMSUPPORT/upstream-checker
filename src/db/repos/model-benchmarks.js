// ============================================
// First-party benchmark scores — model_benchmarks
// ============================================
// The latest benchmark run per (provider, model), written by the
// benchmark runner (src/catalog/benchmark.js) after it dispatches the
// suite's tasks through the app's own keys. Readers: the measurement
// layer that stamps the score onto catalog rows (where it outranks
// every external index for this app's own decisions), and the Models
// page.
//
// Statements are prepared on first use (the model-probes pattern):
// the table arrives with migration v9, and open() assembles the repos
// before it knows which migrations will run.

function createModelBenchmarksRepo(db) {
  const prepared = new Map();
  const sql = (key, text) => {
    if (!prepared.has(key)) prepared.set(key, db.prepare(text));
    return prepared.get(key);
  };

  // Store one completed run. Returns false for input this repo
  // refuses (missing ids, a score outside 0..100, no tasks).
  function record({ providerId, modelId, score, passed, total, detail = null, at = Date.now() } = {}) {
    if (!providerId || !modelId) return false;
    if (!Number.isFinite(score) || score < 0 || score > 100) return false;
    if (!Number.isInteger(total) || total <= 0) return false;
    sql('upsert', `INSERT INTO model_benchmarks (provider_id, model_id, score, passed, total, detail_json, measured_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_id, model_id)
      DO UPDATE SET score = excluded.score, passed = excluded.passed, total = excluded.total,
        detail_json = excluded.detail_json, measured_at = excluded.measured_at`)
      .run(providerId, modelId, score, Math.max(0, Math.min(total, passed | 0)), total,
        detail == null ? null : JSON.stringify(detail).slice(0, 4000), at);
    return true;
  }

  function latest() {
    return sql('all', 'SELECT provider_id, model_id, score, passed, total, detail_json, measured_at FROM model_benchmarks')
      .all().map((r) => ({
        providerId: r.provider_id,
        modelId: r.model_id,
        score: r.score,
        passed: r.passed,
        total: r.total,
        detail: r.detail_json ? safeParse(r.detail_json) : null,
        measuredAt: r.measured_at,
      }));
  }

  return { record, latest };
}

function safeParse(text) {
  try { return JSON.parse(text); } catch (_) { return null; }
}

module.exports = { createModelBenchmarksRepo };
