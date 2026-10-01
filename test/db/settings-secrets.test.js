const test = require('node:test');
const assert = require('node:assert');
const { memoryStore, fakeCipher, encFake, LOCKED_BLOB } = require('../helpers');
const { SECRET_ORIGINS } = require('../../src/db/repos/secrets');

test('settings rows round-trip JS types exactly', async (t) => {
  const { repos } = await memoryStore(t);
  const value = { timeGoodMs: 10000, hedgeEnabled: false, theme: 'vercel', nothing: null, list: [1, 'a'] };
  repos.settings.set('settings', value);
  assert.deepStrictEqual(repos.settings.get('settings'), value);
  assert.strictEqual(repos.settings.get('window'), null);
});

test('saveSettings strips the OpenRouter key and keeps fields the renderer does not know', async (t) => {
  const store = await memoryStore(t);
  store.repos.settings.set('settings', { theme: 'vercel', mediaPrompt: 'legacy prompt', futureField: 42 });
  store.repos.settings.saveSettings({ theme: 'daylight', historyMaxRuns: 50, openRouterApiKey: 'or-secret-value' });
  assert.deepStrictEqual(store.repos.settings.get('settings'), {
    theme: 'daylight', mediaPrompt: 'legacy prompt', futureField: 42, historyMaxRuns: 50,
  });
  const raw = store.db.prepare("SELECT value_json FROM settings WHERE key = 'settings'").get().value_json;
  assert.ok(!raw.includes('or-secret-value'));
});

test('saveSettings rejects anything but an object', async (t) => {
  const { repos } = await memoryStore(t);
  [null, 'x', [1]].forEach((v) => assert.throws(() => repos.settings.saveSettings(v), /must be an object/));
});

test('saveTest stores the test row as given', async (t) => {
  const { repos } = await memoryStore(t);
  repos.settings.saveTest({ prompt: 'What is 2+2?', expected: '', autoMinutes: 15 });
  assert.deepStrictEqual(repos.settings.get('test'), { prompt: 'What is 2+2?', expected: '', autoMinutes: 15 });
  assert.throws(() => repos.settings.saveTest(null), /must be an object/);
});

test('secrets: save encrypts, reveal decrypts, the row never holds the plaintext', async (t) => {
  const store = await memoryStore(t);
  assert.strictEqual(store.repos.secrets.save('openRouterApiKey', '  or-secret-1  '), true);
  const raw = store.db.prepare("SELECT cipher FROM secrets WHERE name = 'openRouterApiKey'").get().cipher;
  assert.ok(raw.startsWith('enc:v1:'));
  assert.ok(!raw.includes('or-secret-1'));
  assert.strictEqual(store.repos.secrets.reveal('openRouterApiKey'), 'or-secret-1');
  assert.strictEqual(store.repos.secrets.has('openRouterApiKey'), true);
});

test("secrets: saving '' deletes", async (t) => {
  const { repos } = await memoryStore(t);
  repos.secrets.save('openRouterApiKey', 'or-secret-1');
  assert.strictEqual(repos.secrets.save('openRouterApiKey', ''), false);
  assert.strictEqual(repos.secrets.has('openRouterApiKey'), false);
  assert.strictEqual(repos.secrets.reveal('openRouterApiKey'), null);
});

test('secrets: unknown names are refused', async (t) => {
  const { repos } = await memoryStore(t);
  assert.throws(() => repos.secrets.save('githubToken', 'x'), /Unknown secret/);
});

// The catalog engine reads this secret through its readKey seam, and SECRET_ORIGINS
// is what lets it be stored at all: save() refuses any name not in that map.
test('openRouterApiKey is a known secret bound to openrouter.ai', async (t) => {
  const store = await memoryStore(t);
  // save() answers whether one is stored — the placeholder is built in db/ipc.js:62.
  assert.strictEqual(store.repos.secrets.save('openRouterApiKey', 'sk-or-v1-test'), true);
  assert.strictEqual(store.repos.secrets.has('openRouterApiKey'), true);
  assert.strictEqual(store.repos.secrets.reveal('openRouterApiKey'), 'sk-or-v1-test');
  assert.strictEqual(SECRET_ORIGINS.openRouterApiKey, 'https://openrouter.ai');
  // The Artificial Analysis key is gone with the benchmark and the live
  // leaderboard: the independent indices the catalog wants are OpenRouter's own
  // /benchmarks endpoint now, so there is one named secret and one origin.
  assert.strictEqual(SECRET_ORIGINS.aaApiKey, undefined);
  assert.throws(() => store.repos.secrets.save('someOtherKey', 'x'), /Unknown secret/);
  assert.strictEqual(store.repos.secrets.save('openRouterApiKey', ''), false,
    'and saving an empty value deletes one, like every other secret');
});

test('secrets: with OS encryption unavailable nothing is stored', async (t) => {
  const store = await memoryStore(t, { cipher: fakeCipher({ available: false }) });
  assert.throws(() => store.repos.secrets.save('openRouterApiKey', 'or-secret'), /unavailable/);
  assert.strictEqual(store.repos.secrets.has('openRouterApiKey'), false);
});

test('secrets: setCipher copies an envelope verbatim and refuses anything else', async (t) => {
  const { repos } = await memoryStore(t);
  repos.secrets.setCipher('openRouterApiKey', encFake('aa-x'));
  assert.strictEqual(repos.secrets.getCipher('openRouterApiKey'), encFake('aa-x'));
  assert.strictEqual(repos.secrets.reveal('openRouterApiKey'), 'aa-x');
  assert.throws(() => repos.secrets.setCipher('openRouterApiKey', 'aa-plain'), /enc:v1:/);
});

test('secrets: a value encrypted elsewhere reveals as null (locked)', async (t) => {
  const { repos } = await memoryStore(t);
  repos.secrets.setCipher('openRouterApiKey', LOCKED_BLOB);
  assert.strictEqual(repos.secrets.has('openRouterApiKey'), true);
  assert.strictEqual(repos.secrets.reveal('openRouterApiKey'), null);
});

test('secrets: replacing a secret drops the cached plaintext', async (t) => {
  const { repos } = await memoryStore(t);
  repos.secrets.save('openRouterApiKey', 'aa-first');
  assert.strictEqual(repos.secrets.reveal('openRouterApiKey'), 'aa-first');
  repos.secrets.save('openRouterApiKey', 'aa-second');
  assert.strictEqual(repos.secrets.reveal('openRouterApiKey'), 'aa-second');
});
