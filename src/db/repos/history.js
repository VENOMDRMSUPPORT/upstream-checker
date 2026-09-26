// ============================================
// Run history — test_runs + test_results
// ============================================
// One row per Route Test run and one per model verdict. Only the verdict is
// kept, never the response text. Order is insertion order (id), which is what
// uptime, sparklines and regression detection read.
const { ulid } = require('../ulid');

const DEFAULT_MAX_RUNS = 300;
const MAX_RUNS_CEILING = 5000;

function historyCap(maxRuns) {
  const n = Number(maxRuns);
  return n > 0 ? Math.min(Math.floor(n), MAX_RUNS_CEILING) : DEFAULT_MAX_RUNS;
}

const num = (v) => (Number.isFinite(v) ? v : null);

function createHistoryRepo(db, { newUid = ulid } = {}) {
  const q = {
    insertRun: db.prepare('INSERT INTO test_runs (run_uid, at, provider_id, provider_name, prompt) VALUES (?, ?, ?, ?, ?)'),
    insertResult: db.prepare(`INSERT INTO test_results
      (run_id, model_id, status, time_ms, tokens, completion_tokens, attempts, correct) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    trim: db.prepare('DELETE FROM test_runs WHERE id NOT IN (SELECT id FROM test_runs ORDER BY id DESC LIMIT ?)'),
    runs: db.prepare('SELECT id, at, provider_id, provider_name, prompt FROM test_runs ORDER BY id'),
    results: db.prepare(`SELECT run_id, model_id, status, time_ms, tokens, completion_tokens, attempts, correct
      FROM test_results ORDER BY run_id, id`),
    clear: db.prepare('DELETE FROM test_runs'),
  };

  const insert = db.transaction((run) => {
    if (!run || typeof run !== 'object') throw new TypeError('A run must be an object');
    if (!Number.isFinite(run.at)) throw new TypeError('A run needs a numeric at');
    if (typeof run.provider !== 'string' || !run.provider) throw new TypeError('A run needs a provider id');
    const results = Array.isArray(run.results) ? run.results : [];
    results.forEach((r) => {
      if (!r || typeof r.model !== 'string' || !r.model || typeof r.status !== 'string' || !r.status) {
        throw new TypeError('A result needs a model and a status');
      }
    });
    const runUid = newUid();
    const providerName = typeof run.providerName === 'string' && run.providerName ? run.providerName : run.provider;
    const prompt = typeof run.prompt === 'string' ? run.prompt : '';
    const id = Number(q.insertRun.run(runUid, run.at, run.provider, providerName, prompt).lastInsertRowid);
    results.forEach((r) => q.insertResult.run(
      id, r.model, r.status, num(r.time), num(r.tokens), num(r.completionTokens),
      Number.isFinite(r.attempts) ? r.attempts : 1,
      typeof r.correct === 'boolean' ? (r.correct ? 1 : 0) : null,
    ));
    return { id, runUid };
  });

  // append-run: the cap applies on every append (and matches the renderer's
  // in-memory cap), so lowering historyMaxRuns trims on the next run.
  const append = db.transaction((run, maxRuns) => {
    const out = insert(run);
    q.trim.run(historyCap(maxRuns));
    return out;
  });

  function read() {
    const byRun = new Map();
    q.results.all().forEach((r) => {
      if (!byRun.has(r.run_id)) byRun.set(r.run_id, []);
      byRun.get(r.run_id).push({
        model: r.model_id,
        status: r.status,
        time: r.time_ms,
        tokens: r.tokens,
        completionTokens: r.completion_tokens,
        attempts: r.attempts,
        correct: r.correct === null ? null : r.correct === 1,
      });
    });
    const runs = q.runs.all().map((r) => ({
      id: r.id,
      at: r.at,
      provider: r.provider_id,
      providerName: r.provider_name,
      prompt: r.prompt,
      results: byRun.get(r.id) || [],
    }));
    return { version: 1, runs };
  }

  function clear() {
    q.clear.run();
  }

  return { read, insert, append, clear };
}

module.exports = { createHistoryRepo, historyCap };
