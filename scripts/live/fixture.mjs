// Synthetic legacy data folder for the live checks: config.json, catalog.json
// and history.json as an older VENOM Router wrote them, with fake keys and
// provider URLs on a local mock. The plaintext keys are there on purpose —
// the importer must encrypt them with the real OS keystore — and so is one
// enc:v1: blob no machine can open, which must come through as a locked key.
// The owner's real data is never copied, so no timer can send a real key.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertScratchDir } from './cdp.mjs';

export const FIXTURE = {
  port: 47831,
  keys: {
    dark1: 'sk-fixture-dark-0001',
    dark2: 'sk-fixture-dark-0002',
    cust2: 'sk-fixture-cust-0003',
    nexum1: 'sk-fixture-nexum-0004',
    orphan: 'sk-fixture-orphan-0005',
  },
  aaKey: 'aa_fixture_0000000000',
  lockedBlob: `enc:v1:${Buffer.from('fixture: not a DPAPI blob').toString('base64')}`,
};

export function writeFixture(dir, origin) {
  assertScratchDir(dir);
  const now = Date.now();
  const alphaFirstSeen = now - 86400000;
  const k = FIXTURE.keys;

  const config = {
    version: 1,
    providers: {
      darkapi: {
        name: 'Dark API (fixture)', baseUrl: `${origin}/darkapi/v1`, rpm: null,
        keys: [
          { id: 'k_dark_1', name: 'Dark one', key: k.dark1, active: true },
          { id: 'k_dark_2', name: 'Dark two', key: k.dark2, active: true },
        ],
      },
      nexum: {
        name: 'Nexum (fixture)', baseUrl: `${origin}/nexum/v1`, rpm: 30,
        keys: [
          { id: 'k_nexum_1', name: 'Nexum plain', key: k.nexum1, active: true,
            quotaSpent: { until: now + 3600000, status: 429, message: 'fixture quota', at: now, models: ['fixture-beta'] } },
          { id: 'k_nexum_locked', name: 'Other machine', key: FIXTURE.lockedBlob, active: true },
        ],
      },
      // Same base URL as Dark API (trailing slash): merged into it at startup;
      // its first key duplicates Dark one and must be dropped.
      custom_legacy: {
        name: 'Old Dark custom', baseUrl: `${origin}/darkapi/v1/`, custom: true,
        keys: [
          { id: 'k_cust_1', name: 'Dup of Dark one', key: k.dark1, active: true },
          { id: 'k_cust_2', name: 'Custom only', key: k.cust2, active: false },
        ],
      },
      // No built-in twin and it holds a key: kept in the store, never loaded.
      custom_orphan: {
        name: 'Orphan custom', baseUrl: `${origin}/orphan/v1`, custom: true,
        keys: [{ id: 'k_orphan_1', name: 'Orphan key', key: k.orphan, active: true }],
      },
    },
    settings: {
      theme: 'daylight', historyMaxRuns: 5, sparkRuns: 12, catalogAutoBench: false,
      mediaPrompt: 'A fixture media prompt.', aaApiKey: FIXTURE.aaKey, futureField: 'kept',
    },
    test: { prompt: 'Fixture prompt?', expected: '4', autoMinutes: 0 },
    window: { width: 1280, height: 820, maximized: false },
  };

  const entry = (id, extra) => ({
    key: `darkapi::${id}`, providerId: 'darkapi', id, firstSeen: alphaFirstSeen, lastSeen: now - 60000, removedAt: null,
    isNew: false, name: id, kind: 'chat', pricing: null, declaresTools: null, maxOutput: null, hasVision: false,
    hasReasoning: false, isFree: false, isFreeForPaid: false, contextLabel: '', contextWindow: null, keyIds: ['k_dark_1'],
    ownedBy: 'fixture', bench: null, history: [], benchError: null, ...extra,
  });
  const catalog = {
    version: 1,
    models: {
      'darkapi::fixture-alpha': entry('fixture-alpha', {}),
      'darkapi::fixture-gone': entry('fixture-gone', { removedAt: now - 3600000, keyIds: ['k_dark_2'] }),
    },
    lastSync: { darkapi: now - 60000 },
    keyModels: { k_dark_1: { count: 2, at: now - 60000 } },
    // Fresh, so the app never asks artificialanalysis.ai for it.
    leaderboard: {
      source: 'fixture', at: now,
      models: [{ name: 'Fixture Alpha', slug: 'fixture-alpha', creator: 'Fixture', index: 50, codingIndex: 40, mathIndex: 30, tps: 100, ttft: 0.5, priceBlended: 1 }],
    },
    leaderboardError: null,
  };

  const result = (status) => (status === 'pass'
    ? { model: 'fixture-alpha', status, time: 900, tokens: 6, completionTokens: 1, attempts: 1, correct: true }
    : { model: 'fixture-alpha', status, time: null, tokens: null, completionTokens: null, attempts: 3, correct: null });
  const history = {
    version: 1,
    runs: [
      { at: now - 3000, provider: 'darkapi', providerName: 'Dark API (fixture)', prompt: 'Fixture prompt?', results: [result('pass')] },
      { at: now - 2000, provider: 'darkapi', providerName: 'Dark API (fixture)', prompt: 'Fixture prompt?', results: [result('fail')] },
      // An older build's run: no prompt, no providerName.
      { at: now - 1000, provider: 'darkapi', results: [result('pass')] },
    ],
  };

  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2));
  writeFileSync(join(dir, 'catalog.json'), JSON.stringify(catalog));
  writeFileSync(join(dir, 'history.json'), JSON.stringify(history));
  return { alphaFirstSeen };
}
