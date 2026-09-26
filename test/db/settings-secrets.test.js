const test = require('node:test');
const assert = require('node:assert');
const { memoryStore, fakeCipher, encFake, LOCKED_BLOB } = require('../helpers');

test('settings rows round-trip JS types exactly', async (t) => {
  const { repos } = await memoryStore(t);
  const value = { timeGoodMs: 10000, hedgeEnabled: false, theme: 'vercel', nothing: null, list: [1, 'a'] };
  repos.settings.set('settings', value);
  assert.deepStrictEqual(repos.settings.get('settings'), value);
  assert.strictEqual(repos.settings.get('window'), null);
});

test('saveSettings strips aaApiKey and keeps fields the renderer does not know', async (t) => {
  const store = await memoryStore(t);
  store.repos.settings.set('settings', { theme: 'vercel', mediaPrompt: 'legacy prompt', futureField: 42 });
  store.repos.settings.saveSettings({ theme: 'daylight', historyMaxRuns: 50, aaApiKey: 'aa-secret-value' });
  assert.deepStrictEqual(store.repos.settings.get('settings'), {
    theme: 'daylight', mediaPrompt: 'legacy prompt', futureField: 42, historyMaxRuns: 50,
  });
  const raw = store.db.prepare("SELECT value_json FROM settings WHERE key = 'settings'").get().value_json;
  assert.ok(!raw.includes('aa-secret-value'));
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
  assert.strictEqual(store.repos.secrets.save('aaApiKey', '  aa-secret-1  '), true);
  const raw = store.db.prepare("SELECT cipher FROM secrets WHERE name = 'aaApiKey'").get().cipher;
  assert.ok(raw.startsWith('enc:v1:'));
  assert.ok(!raw.includes('aa-secret-1'));
  assert.strictEqual(store.repos.secrets.reveal('aaApiKey'), 'aa-secret-1');
  assert.strictEqual(store.repos.secrets.has('aaApiKey'), true);
});

test("secrets: saving '' deletes", async (t) => {
  const { repos } = await memoryStore(t);
  repos.secrets.save('aaApiKey', 'aa-secret-1');
  assert.strictEqual(repos.secrets.save('aaApiKey', ''), false);
  assert.strictEqual(repos.secrets.has('aaApiKey'), false);
  assert.strictEqual(repos.secrets.reveal('aaApiKey'), null);
});

test('secrets: unknown names are refused', async (t) => {
  const { repos } = await memoryStore(t);
  assert.throws(() => repos.secrets.save('githubToken', 'x'), /Unknown secret/);
});

test('secrets: with OS encryption unavailable nothing is stored', async (t) => {
  const store = await memoryStore(t, { cipher: fakeCipher({ available: false }) });
  assert.throws(() => store.repos.secrets.save('aaApiKey', 'aa-secret'), /unavailable/);
  assert.strictEqual(store.repos.secrets.has('aaApiKey'), false);
});

test('secrets: setCipher copies an envelope verbatim and refuses anything else', async (t) => {
  const { repos } = await memoryStore(t);
  repos.secrets.setCipher('aaApiKey', encFake('aa-x'));
  assert.strictEqual(repos.secrets.getCipher('aaApiKey'), encFake('aa-x'));
  assert.strictEqual(repos.secrets.reveal('aaApiKey'), 'aa-x');
  assert.throws(() => repos.secrets.setCipher('aaApiKey', 'aa-plain'), /enc:v1:/);
});

test('secrets: a value encrypted elsewhere reveals as null (locked)', async (t) => {
  const { repos } = await memoryStore(t);
  repos.secrets.setCipher('aaApiKey', LOCKED_BLOB);
  assert.strictEqual(repos.secrets.has('aaApiKey'), true);
  assert.strictEqual(repos.secrets.reveal('aaApiKey'), null);
});

test('secrets: replacing a secret drops the cached plaintext', async (t) => {
  const { repos } = await memoryStore(t);
  repos.secrets.save('aaApiKey', 'aa-first');
  assert.strictEqual(repos.secrets.reveal('aaApiKey'), 'aa-first');
  repos.secrets.save('aaApiKey', 'aa-second');
  assert.strictEqual(repos.secrets.reveal('aaApiKey'), 'aa-second');
});
