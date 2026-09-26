const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { importLegacy, listImportedFiles, describeImportWarnings, needsReimportPrompt, ImportAbort } = require('../../src/db/import-json');
const { memoryStore, fakeCipher, encFake, LOCKED_BLOB, quietLog, tempDir } = require('../helpers');

const NOW = 1727000000000;

const legacyConfig = () => ({
  version: 1,
  providers: {
    nara: {
      name: 'NaraRouter', baseUrl: 'https://router.bynara.id/v1', rpm: null,
      keys: [
        { id: 'key_1', name: 'Main', key: encFake('sk-nara-main'), active: true },
        { id: 'key_2', name: 'Spent', key: encFake('sk-nara-spent'), active: false,
          quotaSpent: { until: 1727100000000, status: 429, message: 'weekly', at: 1727000000000, models: ['m1'] } },
      ],
    },
    darkapi: { name: 'Dark API', baseUrl: 'https://darkapi.dev/v1', rpm: 20, keys: [{ id: 'key_3', name: 'Other PC', key: LOCKED_BLOB, active: true }] },
  },
  settings: { theme: 'daylight', historyMaxRuns: 50, mediaPrompt: 'legacy prompt', futureField: { a: 1 }, aaApiKey: 'aa-plain-key' },
  test: { prompt: 'What is 2+2?', expected: '4', autoMinutes: 15 },
  window: { x: 10, y: 20, width: 1300, height: 850, maximized: false },
});

const legacyCatalog = () => ({
  version: 1,
  models: {
    'nara::m1': {
      key: 'nara::m1', providerId: 'nara', id: 'm1', firstSeen: 1, lastSeen: 2, removedAt: null, isNew: false,
      name: 'm1', kind: 'chat', keyIds: ['key_1'], bench: null, history: [], benchError: null, capsError: null,
    },
  },
  lastSync: { nara: 2 },
  keyModels: { key_1: { count: 1, at: 2 } },
  leaderboard: null,
});

const legacyHistory = () => ({
  version: 1,
  runs: [
    { at: 1727000000000, provider: 'nara', providerName: 'NaraRouter', prompt: 'What is 2+2?',
      results: [{ model: 'm1', status: 'pass', time: 900, tokens: 10, completionTokens: 2, attempts: 1, correct: true }] },
    { at: 1727000100000, provider: 'nara',
      results: [{ model: 'm1', status: 'fail', time: null, tokens: null, completionTokens: null, attempts: 3, correct: null }] },
  ],
});

const all = () => ({ 'config.json': legacyConfig(), 'catalog.json': legacyCatalog(), 'history.json': legacyHistory() });
const ls = (dir) => fs.readdirSync(dir).sort();
const count = (store, table) => store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

async function setup(t, { cipher = fakeCipher(), files = {}, fsImpl } = {}) {
  const dir = tempDir(t);
  Object.entries(files).forEach(([name, content]) => {
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  });
  const store = await memoryStore(t, { cipher });
  const run = (extra = {}) => importLegacy({
    dir, db: store.db, repos: store.repos, cipher, log: quietLog, sleep: async () => {}, now: () => NOW,
    ...(fsImpl ? { fs: fsImpl } : {}), ...extra,
  });
  return { dir, store, run, cipher };
}

function assertNothingWritten(store) {
  ['providers', 'provider_keys', 'settings', 'secrets', 'models', 'test_runs'].forEach((table) => {
    assert.strictEqual(count(store, table), 0, table);
  });
  assert.strictEqual(store.repos.meta.get('imported_from_json_at'), null);
}

// fs with readFileSync failing EBUSY for one file, `failures` times.
function flakyFs(failName, failures) {
  let reads = 0;
  return {
    ...fs,
    readFileSync(file, enc) {
      if (path.basename(file) === failName) {
        reads += 1;
        if (reads <= failures) {
          const e = new Error(`EBUSY: resource busy or locked, open '${file}'`);
          e.code = 'EBUSY';
          throw e;
        }
      }
      return fs.readFileSync(file, enc);
    },
    reads: () => reads,
  };
}

test('imports every file in one go and renames them', async (t) => {
  const { dir, store, run, cipher } = await setup(t, { files: all() });
  const report = await run();
  assert.strictEqual(report.status, 'imported');
  assert.deepStrictEqual(report.unreadable, []);
  assert.deepStrictEqual(report.skipped, { keys: 0, catalogEntries: 0, runs: 0, results: 0 });
  // Ciphertext copied verbatim; nothing was decrypted.
  assert.deepStrictEqual(store.db.prepare('SELECT id, provider_id, cipher, active FROM provider_keys ORDER BY id').all(), [
    { id: 'key_1', provider_id: 'nara', cipher: encFake('sk-nara-main'), active: 1 },
    { id: 'key_2', provider_id: 'nara', cipher: encFake('sk-nara-spent'), active: 0 },
    { id: 'key_3', provider_id: 'darkapi', cipher: LOCKED_BLOB, active: 1 },
  ]);
  assert.strictEqual(cipher.calls.decrypt, 0);
  const providers = store.repos.providers.list();
  assert.deepStrictEqual(Object.keys(providers), ['nara', 'darkapi']);
  assert.strictEqual(providers.darkapi.rpm, 20);
  assert.deepStrictEqual(providers.nara.keys[1].quotaSpent, legacyConfig().providers.nara.keys[1].quotaSpent);
  assert.strictEqual(providers.darkapi.keys[0].locked, true);
  // Settings verbatim minus the AA key, which is a secret now.
  const { aaApiKey, ...settings } = legacyConfig().settings;
  assert.deepStrictEqual(store.repos.settings.get('settings'), settings);
  assert.strictEqual(store.repos.secrets.reveal('aaApiKey'), aaApiKey);
  assert.deepStrictEqual(store.repos.settings.get('test'), legacyConfig().test);
  assert.deepStrictEqual(store.repos.settings.get('window'), legacyConfig().window);
  // History, with the missing name and prompt filled in.
  const runs = store.repos.history.read().runs;
  assert.deepStrictEqual(runs.map((r) => [r.providerName, r.prompt]), [['NaraRouter', 'What is 2+2?'], ['nara', '']]);
  assert.deepStrictEqual(runs[0].results, legacyHistory().runs[0].results);
  const cat = store.repos.catalog.read();
  assert.deepStrictEqual(cat.models['nara::m1'], legacyCatalog().models['nara::m1']);
  assert.deepStrictEqual(cat.lastSync, { nara: 2 });
  assert.deepStrictEqual(cat.keyModels, { key_1: { count: 1, at: 2 } });
  assert.strictEqual(store.repos.meta.get('imported_from_json_at'), String(NOW));
  assert.deepStrictEqual(ls(dir), [`backup-before-database-${NOW}`, 'catalog.imported.json', 'config.imported.json', 'history.imported.json']);
  assert.strictEqual(describeImportWarnings(report), '');
});

test('a fresh install without legacy files is marked, and a later config.json is ignored', async (t) => {
  const { dir, store, run } = await setup(t);
  assert.deepStrictEqual(await run(), { status: 'none' });
  assert.strictEqual(store.repos.meta.get('imported_from_json_at'), 'none');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(legacyConfig()));
  assert.deepStrictEqual(await run(), { status: 'skipped' });
  assert.strictEqual(count(store, 'providers'), 0);
  assert.ok(fs.existsSync(path.join(dir, 'config.json')));
});

test('an I/O error on any file that outlasts the retries aborts with nothing written', async (t) => {
  for (const name of ['config.json', 'catalog.json', 'history.json']) {
    const flaky = flakyFs(name, 99);
    const { dir, store, run } = await setup(t, { files: all(), fsImpl: flaky });
    await assert.rejects(run(), (err) => err instanceof ImportAbort && err.code === 'IMPORT_IO' && err.message.includes(name), name);
    assert.strictEqual(flaky.reads(), 3, name);
    assertNothingWritten(store);
    assert.deepStrictEqual(ls(dir), ['catalog.json', 'config.json', 'history.json'], name);
  }
});

test('an I/O error that clears on a retry imports normally', async (t) => {
  const flaky = flakyFs('config.json', 1);
  const { store, run } = await setup(t, { files: all(), fsImpl: flaky });
  assert.strictEqual((await run()).status, 'imported');
  assert.strictEqual(flaky.reads(), 2);
  assert.strictEqual(count(store, 'providers'), 2);
});

test('a damaged config.json aborts with nothing written: bad JSON, empty file, not an object', async (t) => {
  for (const content of ['{ "providers": ', '', 'null', '[1, 2]']) {
    const { dir, store, run } = await setup(t, { files: { ...all(), 'config.json': content } });
    await assert.rejects(run(), (err) => err.code === 'IMPORT_CONFIG_PARSE');
    assertNothingWritten(store);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'), content);
  }
});

test('a damaged catalogue or history is left out, renamed .unreadable.json and reported', async (t) => {
  const { dir, store, run } = await setup(t, { files: { ...all(), 'catalog.json': '{"models": {', 'history.json': '[1, 2' } });
  const report = await run();
  assert.strictEqual(report.status, 'imported');
  assert.deepStrictEqual(report.unreadable, ['catalog', 'history']);
  assert.strictEqual(count(store, 'providers'), 2);
  assert.strictEqual(count(store, 'models'), 0);
  assert.strictEqual(count(store, 'test_runs'), 0);
  assert.deepStrictEqual(ls(dir), [`backup-before-database-${NOW}`, 'catalog.unreadable.json', 'config.imported.json', 'history.unreadable.json']);
  const text = describeImportWarnings(report);
  assert.match(text, /catalog\.json is damaged and was not imported\. It was renamed catalog\.unreadable\.json\./);
  assert.match(text, /history\.json is damaged and was not imported/);
});

test('malformed catalogue entries and history rows are skipped and counted', async (t) => {
  const catalog = legacyCatalog();
  catalog.models.junk = 'not an entry';
  catalog.models['nara::no-provider'] = { id: 'no-provider' };
  const history = legacyHistory();
  history.runs.push({ at: 5, results: [] });
  history.runs.push('garbage');
  history.runs[0].results.push({ status: 'pass' });
  const { store, run } = await setup(t, { files: { ...all(), 'catalog.json': catalog, 'history.json': history } });
  const report = await run();
  assert.deepStrictEqual(report.skipped, { keys: 0, catalogEntries: 2, runs: 2, results: 1 });
  assert.strictEqual(count(store, 'models'), 1);
  assert.strictEqual(count(store, 'test_runs'), 2);
  const text = describeImportWarnings(report);
  assert.match(text, /2 damaged model pool entries were skipped\./);
  assert.match(text, /2 damaged test runs were skipped\./);
  assert.match(text, /1 damaged test result was skipped\./);
});

test('a plaintext legacy key is encrypted on the way in', async (t) => {
  const config = legacyConfig();
  config.providers.nara.keys[0].key = 'sk-plain-legacy-key';
  const { store, run, cipher } = await setup(t, { files: { 'config.json': config } });
  await run();
  const raw = store.db.prepare("SELECT cipher FROM provider_keys WHERE id = 'key_1'").get().cipher;
  assert.ok(raw.startsWith('enc:v1:') && !raw.includes('sk-plain-legacy-key'));
  assert.strictEqual(store.repos.providers.revealKey('key_1'), 'sk-plain-legacy-key');
  assert.strictEqual(cipher.calls.encrypt, 2); // the key and the plaintext AA key
});

test('without OS encryption a plaintext key aborts the import; ciphertext alone still imports', async (t) => {
  const plain = legacyConfig();
  plain.providers.nara.keys[0].key = 'sk-plain-legacy-key';
  const a = await setup(t, { cipher: fakeCipher({ available: false }), files: { 'config.json': plain } });
  await assert.rejects(a.run(), (err) => err.code === 'IMPORT_NO_ENCRYPTION');
  assertNothingWritten(a.store);
  assert.deepStrictEqual(ls(a.dir), ['config.json']);

  const sealed = legacyConfig();
  delete sealed.settings.aaApiKey;
  const b = await setup(t, { cipher: fakeCipher({ available: false }), files: { 'config.json': sealed } });
  assert.strictEqual((await b.run()).status, 'imported');
  assert.strictEqual(count(b.store, 'provider_keys'), 3);
});

test('a legacy custom provider is imported as stored, flagged custom', async (t) => {
  const config = legacyConfig();
  config.providers.custom_171 = {
    name: 'My router', baseUrl: 'https://router.bynara.id/v1/', custom: true,
    keys: [{ id: 'key_9', name: 'Old', key: encFake('sk-custom'), active: true }],
  };
  const { store, run } = await setup(t, { files: { 'config.json': config } });
  await run();
  const p = store.repos.providers.get('custom_171');
  assert.strictEqual(p.custom, true);
  assert.strictEqual(p.baseUrl, 'https://router.bynara.id/v1/');
  assert.deepStrictEqual(p.keys.map((k) => k.id), ['key_9']);
});

test('keys without an id, with a duplicate id or an unusable id get fresh ids', async (t) => {
  const config = legacyConfig();
  config.providers.nara.keys.push({ name: 'No id', key: encFake('sk-a'), active: true });
  config.providers.darkapi.keys.push({ id: 'key_1', name: 'Duplicate', key: encFake('sk-b'), active: true });
  config.providers.darkapi.keys.push({ id: 'key with spaces', name: 'Unusable', key: encFake('sk-c'), active: true });
  const { store, run } = await setup(t, { files: { 'config.json': config } });
  const report = await run();
  assert.strictEqual(report.reassignedKeys, 2);
  const ids = store.db.prepare('SELECT id FROM provider_keys ORDER BY provider_id, position').all().map((r) => r.id);
  assert.deepStrictEqual(ids, ['key_3', `key_${NOW}_1`, `key_${NOW}_2`, 'key_1', 'key_2', `key_${NOW}`]);
  assert.match(describeImportWarnings(report), /2 keys had a duplicate or unusable id and got a new one\./);
});

test('a key with no value is skipped and reported', async (t) => {
  const config = legacyConfig();
  config.providers.nara.keys.push({ id: 'key_empty', name: 'Blank', key: '', active: true });
  const { store, run } = await setup(t, { files: { 'config.json': config } });
  const report = await run();
  assert.strictEqual(report.skipped.keys, 1);
  assert.strictEqual(store.repos.providers.keyRecord('key_empty'), null);
  assert.match(describeImportWarnings(report), /1 key had no value and was skipped\./);
});

test('running the import again does nothing', async (t) => {
  const { store, run } = await setup(t, { files: all() });
  await run();
  assert.deepStrictEqual(await run(), { status: 'skipped' });
  assert.strictEqual(count(store, 'provider_keys'), 3);
  assert.strictEqual(count(store, 'test_runs'), 2);
});

test('an existing .imported.json is never overwritten', async (t) => {
  const { dir, run } = await setup(t, { files: { ...all(), 'config.imported.json': '{"from":"an earlier import"}' } });
  await run();
  assert.strictEqual(fs.readFileSync(path.join(dir, 'config.imported.json'), 'utf-8'), '{"from":"an earlier import"}');
  assert.ok(fs.existsSync(path.join(dir, `config.imported-${NOW}.json`)));
  assert.ok(!fs.existsSync(path.join(dir, 'config.json')));
});

test('a write that fails mid-import commits nothing and renames nothing', async (t) => {
  const { dir, store, run } = await setup(t, { files: all() });
  store.db.exec("CREATE TRIGGER fail_runs BEFORE INSERT ON test_runs BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  await assert.rejects(run(), (err) => err.code === 'IMPORT_WRITE' && /disk full/.test(err.message));
  assertNothingWritten(store);
  assert.deepStrictEqual(ls(dir), [`backup-before-database-${NOW}`, 'catalog.json', 'config.json', 'history.json']);
  store.db.exec('DROP TRIGGER fail_runs');
  assert.strictEqual((await run()).status, 'imported');
  assert.strictEqual(count(store, 'test_runs'), 2);
  assert.strictEqual(count(store, 'models'), 1);
});

test('re-import reads the .imported.json copies and leaves them in place', async (t) => {
  const files = { 'config.imported.json': legacyConfig(), 'catalog.imported.json': legacyCatalog(), 'history.imported.json': legacyHistory() };
  const { dir, store, run } = await setup(t, { files });
  assert.deepStrictEqual(listImportedFiles(dir), ['config.imported.json', 'catalog.imported.json', 'history.imported.json']);
  const report = await run({ source: 'imported' });
  assert.strictEqual(report.status, 'imported');
  assert.strictEqual(count(store, 'provider_keys'), 3);
  assert.deepStrictEqual(report.renamed, []);
  assert.deepStrictEqual(ls(dir), ['catalog.imported.json', 'config.imported.json', 'history.imported.json']);
});

test('needsReimportPrompt: offered only when saved copies are all that is left', () => {
  // The database was deleted: a fresh DB, no legacy files, saved copies present.
  assert.strictEqual(needsReimportPrompt({ importedAt: null, legacyPresent: false, savedCopies: 3 }), true);
  // Relaunch after an aborted re-import: still nothing imported, copies untouched.
  assert.strictEqual(needsReimportPrompt({ importedAt: null, legacyPresent: false, savedCopies: 1 }), true);
  // Legacy files present: a normal first import, no offer.
  assert.strictEqual(needsReimportPrompt({ importedAt: null, legacyPresent: true, savedCopies: 3 }), false);
  // Already imported, or a fresh install marked 'none'.
  assert.strictEqual(needsReimportPrompt({ importedAt: String(NOW), legacyPresent: false, savedCopies: 3 }), false);
  assert.strictEqual(needsReimportPrompt({ importedAt: 'none', legacyPresent: false, savedCopies: 3 }), false);
});

test('a successful legacy import backs up every legacy file before importing', async (t) => {
  const files = all();
  const { dir, run } = await setup(t, { files });
  const report = await run();
  assert.strictEqual(report.status, 'imported');
  assert.ok(report.backupDir && fs.existsSync(report.backupDir));
  assert.match(path.basename(report.backupDir), /^backup-before-database-\d+$/);
  Object.entries(files).forEach(([name, content]) => {
    const backedUp = fs.readFileSync(path.join(report.backupDir, name), 'utf-8');
    assert.strictEqual(backedUp, JSON.stringify(content));
  });
});

test('a failing backup copy aborts with IMPORT_BACKUP: nothing written, nothing renamed', async (t) => {
  const failing = {
    ...fs,
    copyFileSync(src, dest) {
      if (path.basename(src) === 'catalog.json') {
        const e = new Error('EPERM: operation not permitted');
        throw e;
      }
      return fs.copyFileSync(src, dest);
    },
  };
  const { dir, store, run } = await setup(t, { files: all(), fsImpl: failing });
  await assert.rejects(run(), (err) => err instanceof ImportAbort && err.code === 'IMPORT_BACKUP' && err.message.includes('catalog.json'));
  assertNothingWritten(store);
  const entries = ls(dir).filter((e) => !e.startsWith('backup-before-database-'));
  assert.deepStrictEqual(entries, ['catalog.json', 'config.json', 'history.json']);
});

test('a fresh install with no legacy files creates no backup folder', async (t) => {
  const { dir, run } = await setup(t);
  await run();
  assert.deepStrictEqual(ls(dir), []);
});

test('a rename that fails is reported, not fatal', async (t) => {
  const stubborn = {
    ...fs,
    renameSync(from, to) {
      if (path.basename(from) === 'history.json') {
        const e = new Error('EPERM: operation not permitted');
        e.code = 'EPERM';
        throw e;
      }
      return fs.renameSync(from, to);
    },
  };
  const { dir, store, run } = await setup(t, { files: all(), fsImpl: stubborn });
  const report = await run();
  assert.strictEqual(report.status, 'imported');
  assert.deepStrictEqual(report.renameFailed, ['history.json']);
  assert.strictEqual(count(store, 'test_runs'), 2);
  assert.ok(fs.existsSync(path.join(dir, 'history.json')));
  assert.match(describeImportWarnings(report), /history\.json was imported but could not be renamed/);
});
