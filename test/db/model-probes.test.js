const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const MIGRATIONS = require('../../src/db/migrations');
const { createModelProbesRepo } = require('../../src/db/repos/model-probes');

// model_probes (migration v8): the latest first-party capability
// verdict per provider + model + kind.

function setup() {
  const db = new Database(':memory:');
  for (const m of MIGRATIONS) m.up(db);
  return { db, repo: createModelProbesRepo(db) };
}

test('record upserts the latest verdict per kind and latest() maps it back', () => {
  const { repo } = setup();
  assert.equal(repo.record({ providerId: 'p1', modelId: 'm1', kind: 'chat', ok: true, at: 100 }), true);
  assert.equal(repo.record({ providerId: 'p1', modelId: 'm1', kind: 'tools', ok: false, detail: 'no tool call returned', at: 100 }), true);
  assert.equal(repo.record({ providerId: 'p1', modelId: 'm1', kind: 'chat', ok: false, detail: 'later failure', at: 200 }), true);
  const rows = repo.latest();
  assert.equal(rows.length, 2);
  const chat = rows.find((r) => r.kind === 'chat');
  assert.deepStrictEqual(
    { ok: chat.ok, detail: chat.detail, measuredAt: chat.measuredAt },
    { ok: false, detail: 'later failure', measuredAt: 200 });
  const tools = rows.find((r) => r.kind === 'tools');
  assert.equal(tools.ok, false);
});

test('unknown kinds and missing ids are refused, never stored', () => {
  const { repo } = setup();
  assert.equal(repo.record({ providerId: 'p1', modelId: 'm1', kind: 'vision', ok: true }), false);
  assert.equal(repo.record({ providerId: '', modelId: 'm1', kind: 'chat', ok: true }), false);
  assert.equal(repo.record({ providerId: 'p1', modelId: '', kind: 'chat', ok: true }), false);
  assert.deepStrictEqual(repo.latest(), []);
});
