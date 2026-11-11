const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const MIGRATIONS = require('../../src/db/migrations');
const { createModelBenchmarksRepo } = require('../../src/db/repos/model-benchmarks');

// model_benchmarks (migration v9): the latest first-party benchmark
// score per provider + model.

function setup() {
  const db = new Database(':memory:');
  for (const m of MIGRATIONS) m.up(db);
  return { db, repo: createModelBenchmarksRepo(db) };
}

test('record upserts the latest run and latest() maps it back with its detail', () => {
  const { repo } = setup();
  const detail = { tasks: [{ id: 'reasoning', weight: 2, pass: true }] };
  assert.equal(repo.record({ providerId: 'p1', modelId: 'm1', score: 80, passed: 6, total: 7, detail, at: 100 }), true);
  assert.equal(repo.record({ providerId: 'p1', modelId: 'm1', score: 60, passed: 4, total: 7, detail: null, at: 200 }), true);
  const rows = repo.latest();
  assert.equal(rows.length, 1);
  assert.deepStrictEqual(
    { score: rows[0].score, passed: rows[0].passed, total: rows[0].total, measuredAt: rows[0].measuredAt },
    { score: 60, passed: 4, total: 7, measuredAt: 200 });
  assert.equal(rows[0].detail, null);
});

test('invalid runs are refused, never stored', () => {
  const { repo } = setup();
  assert.equal(repo.record({ providerId: '', modelId: 'm1', score: 50, passed: 1, total: 7 }), false);
  assert.equal(repo.record({ providerId: 'p1', modelId: 'm1', score: 140, passed: 1, total: 7 }), false);
  assert.equal(repo.record({ providerId: 'p1', modelId: 'm1', score: 50, passed: 1, total: 0 }), false);
  assert.deepStrictEqual(repo.latest(), []);
});
