const test = require('node:test');
const assert = require('node:assert');
const { memoryStore } = require('../helpers');
const { ulid } = require('../../src/db/ulid');
const { historyCap } = require('../../src/db/repos/history');

const run = (at, results, extra = {}) => ({
  at, provider: 'nara', providerName: 'NaraRouter', prompt: 'What is 2+2?', results, ...extra,
});
const pass = (model) => ({ model, status: 'pass', time: 900, tokens: 12, completionTokens: 2, attempts: 1, correct: true });
const fail = (model) => ({ model, status: 'fail', time: null, tokens: null, completionTokens: null, attempts: 3, correct: null });

test('append and read round-trip today\'s run shape, plus an id', async (t) => {
  const { repos } = await memoryStore(t);
  const { id, runUid } = repos.history.append(run(1727000000000, [pass('m1'), { ...fail('m2'), correct: false }]), 300);
  assert.strictEqual(typeof id, 'number');
  assert.match(runUid, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.deepStrictEqual(repos.history.read(), {
    version: 1,
    runs: [{
      id, at: 1727000000000, provider: 'nara', providerName: 'NaraRouter', prompt: 'What is 2+2?',
      results: [pass('m1'), { ...fail('m2'), correct: false }],
    }],
  });
});

test('missing providerName and prompt fall back to the provider id and an empty prompt', async (t) => {
  const { repos } = await memoryStore(t);
  repos.history.insert({ at: 1, provider: 'nara', results: [] });
  const [r] = repos.history.read().runs;
  assert.strictEqual(r.providerName, 'nara');
  assert.strictEqual(r.prompt, '');
});

test('runs come back in insertion order, not by time', async (t) => {
  const { repos } = await memoryStore(t);
  repos.history.append(run(3000, [pass('a')]), 300);
  repos.history.append(run(1000, [pass('b')]), 300);
  assert.deepStrictEqual(repos.history.read().runs.map((r) => r.at), [3000, 1000]);
});

test('append trims to the cap, results of trimmed runs go too', async (t) => {
  const store = await memoryStore(t);
  for (let i = 1; i <= 5; i += 1) store.repos.history.append(run(i, [pass('m1'), fail('m2')]), 3);
  assert.deepStrictEqual(store.repos.history.read().runs.map((r) => r.at), [3, 4, 5]);
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM test_results').get().n, 6);
});

test('historyCap clamps to 5000 and falls back to 300', () => {
  assert.strictEqual(historyCap(50), 50);
  assert.strictEqual(historyCap(12000), 5000);
  assert.strictEqual(historyCap(0), 300);
  assert.strictEqual(historyCap('abc'), 300);
  assert.strictEqual(historyCap(undefined), 300);
});

test('clear empties runs and results', async (t) => {
  const store = await memoryStore(t);
  store.repos.history.append(run(1, [pass('m1')]), 300);
  store.repos.history.clear();
  assert.deepStrictEqual(store.repos.history.read(), { version: 1, runs: [] });
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM test_results').get().n, 0);
});

test('a malformed run is refused and nothing is written', async (t) => {
  const { repos } = await memoryStore(t);
  assert.throws(() => repos.history.append({ provider: 'nara', results: [] }, 300), /numeric at/);
  assert.throws(() => repos.history.append({ at: 1, results: [] }, 300), /provider id/);
  assert.throws(() => repos.history.append(run(1, [{ status: 'pass' }]), 300), /model and a status/);
  assert.deepStrictEqual(repos.history.read().runs, []);
});

test('ulid: 26 Crockford characters, time-prefixed, unique', () => {
  const a = ulid(1727000000000);
  const b = ulid(1727000000000);
  assert.match(a, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.strictEqual(a.slice(0, 10), b.slice(0, 10));
  assert.notStrictEqual(a, b);
  assert.ok(ulid(1727000000001).slice(0, 10) > a.slice(0, 10));
});
