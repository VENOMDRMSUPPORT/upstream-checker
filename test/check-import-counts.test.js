const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const database = require('../src/db');
const { importLegacy } = require('../src/db/import-json');
const { legacyCounts, dbCounts, compare } = require('../scripts/check-import-counts');
const { fakeCipher, encFake, quietLog, tempDir } = require('./helpers');

function writeLegacy(dir) {
  const config = {
    version: 1,
    providers: {
      nara: {
        name: 'NaraRouter', baseUrl: 'https://router.bynara.id/v1', rpm: null,
        keys: [
          { id: 'key_1', name: 'A', key: encFake('sk-owner-secret-1'), active: true },
          { id: 'key_2', name: 'B', key: 'sk-owner-plain-2', active: true },
        ],
      },
      darkapi: { name: 'Dark API', baseUrl: 'https://darkapi.dev/v1', rpm: null, keys: [] },
    },
    settings: { theme: 'daylight', historyMaxRuns: 50, aaApiKey: 'aa-owner-secret' },
  };
  const catalog = {
    version: 1,
    models: {
      'nara::m1': { key: 'nara::m1', providerId: 'nara', id: 'm1', keyIds: [] },
      'nara::m2': { key: 'nara::m2', providerId: 'nara', id: 'm2', keyIds: [] },
    },
    lastSync: {},
  };
  const history = {
    version: 1,
    runs: [
      { at: 1, provider: 'nara', providerName: 'N', prompt: 'p', results: [{ model: 'm1', status: 'pass' }, { model: 'm2', status: 'fail' }] },
      { at: 2, provider: 'nara', providerName: 'N', prompt: 'p', results: [{ model: 'm1', status: 'pass' }] },
    ],
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(catalog));
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify(history));
}

test('before the import: legacy counts only', (t) => {
  const dir = tempDir(t);
  writeLegacy(dir);
  const legacy = legacyCounts(dir);
  assert.deepStrictEqual(legacy.providers, { nara: 2, darkapi: 0 });
  assert.strictEqual(legacy.models, 2);
  assert.strictEqual(legacy.runs, 2);
  assert.strictEqual(legacy.results, 3);
  assert.strictEqual(legacy.hasAa, true);
  assert.strictEqual(dbCounts(dir), null);
});

test('after the import every count matches and nothing secret is printed', async (t) => {
  const dir = tempDir(t);
  writeLegacy(dir);
  const cipher = fakeCipher();
  const store = await database.open(dir, { cipher, log: quietLog });
  try {
    await importLegacy({ dir, db: store.db, repos: store.repos, cipher, log: quietLog });
  } finally {
    store.close();
  }
  const rows = compare(legacyCounts(dir), dbCounts(dir));
  assert.deepStrictEqual(rows.filter((r) => !r.same), []);
  const printed = JSON.stringify(rows);
  ['sk-owner-secret-1', 'sk-owner-plain-2', 'aa-owner-secret', 'enc:v1:'].forEach((s) => assert.ok(!printed.includes(s), s));
});
