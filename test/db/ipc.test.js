const test = require('node:test');
const assert = require('node:assert');
const { registerDataIpc } = require('../../src/db/ipc');
const { memoryStore, quietLog } = require('../helpers');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle(channel, fn) {
      if (handlers.has(channel)) throw new Error(`Registered twice: ${channel}`);
      handlers.set(channel, fn);
    },
    invoke: async (channel, ...args) => handlers.get(channel)({}, ...args),
    channels: () => [...handlers.keys()].sort(),
  };
}

async function setup(t, opts = {}) {
  const store = await memoryStore(t);
  const ipc = fakeIpcMain();
  registerDataIpc({ ipcMain: ipc, repos: store.repos, log: quietLog, ...opts });
  return { store, ipc };
}

const nara = (keys) => ({ id: 'nara', name: 'NaraRouter', baseUrl: 'https://router.bynara.id/v1', rpm: null, keys });

test('registers exactly the data channels', async (t) => {
  const { ipc } = await setup(t);
  assert.deepStrictEqual(ipc.channels(), [
    'append-run', 'clear-history', 'delete-provider', 'merge-provider', 'read-catalog', 'read-config',
    'read-history', 'save-provider', 'save-secret', 'save-settings', 'save-test-definition', 'write-catalog',
  ]);
});

test('read-config on an empty database', async (t) => {
  const { ipc } = await setup(t);
  assert.deepStrictEqual(await ipc.invoke('read-config'), { version: 1, providers: {} });
});

test('read-config reveals keys and the AA key only when plaintextKeys is on', async (t) => {
  const plain = await setup(t, { plaintextKeys: true });
  await plain.ipc.invoke('save-provider', nara([{ id: 'key_1', name: 'Main', key: 'sk-nara-1', active: true }]));
  await plain.ipc.invoke('save-secret', 'aaApiKey', 'aa-secret');
  const open = await plain.ipc.invoke('read-config');
  assert.strictEqual(open.providers.nara.keys[0].key, 'sk-nara-1');
  assert.strictEqual(open.settings.aaApiKey, 'aa-secret');

  const sealed = await setup(t);
  await sealed.ipc.invoke('save-provider', nara([{ id: 'key_1', name: 'Main', key: 'sk-nara-1', active: true }]));
  await sealed.ipc.invoke('save-secret', 'aaApiKey', 'aa-secret');
  const closed = await sealed.ipc.invoke('read-config');
  assert.strictEqual(closed.providers.nara.keys[0].key, 'venomkey:key_1');
  assert.strictEqual(closed.settings.aaApiKey, 'venomsecret:aaApiKey');
});

test('save-settings drops aaApiKey; settings, test and window come back in read-config', async (t) => {
  const { store, ipc } = await setup(t);
  assert.deepStrictEqual(await ipc.invoke('save-settings', { theme: 'daylight', aaApiKey: 'aa-typed' }), { success: true });
  assert.deepStrictEqual(await ipc.invoke('save-test-definition', { prompt: 'p', expected: 'e', autoMinutes: 0 }), { success: true });
  store.repos.settings.set('window', { width: 1200, height: 800, maximized: false });
  assert.deepStrictEqual(await ipc.invoke('read-config'), {
    version: 1,
    providers: {},
    settings: { theme: 'daylight', aaApiKey: '' },
    test: { prompt: 'p', expected: 'e', autoMinutes: 0 },
    window: { width: 1200, height: 800, maximized: false },
  });
  assert.strictEqual(store.repos.secrets.has('aaApiKey'), false);
});

test('save-secret answers with the placeholder, or empty after a delete', async (t) => {
  const { ipc } = await setup(t);
  assert.deepStrictEqual(await ipc.invoke('save-secret', 'aaApiKey', 'aa-secret'), { placeholder: 'venomsecret:aaApiKey' });
  assert.deepStrictEqual(await ipc.invoke('save-secret', 'aaApiKey', ''), { placeholder: '' });
});

test('save-provider, merge-provider and delete-provider', async (t) => {
  const { ipc } = await setup(t);
  const saved = await ipc.invoke('save-provider', nara([{ id: 'key_1', name: 'Main', key: 'sk-1', active: true }]));
  assert.deepStrictEqual(saved.keys.map((k) => k.id), ['key_1']);
  await ipc.invoke('save-provider', { id: 'custom_1', name: 'Old', baseUrl: 'https://router.bynara.id/v1/', rpm: null, custom: true,
    keys: [{ id: 'key_2', name: 'Extra', key: 'sk-2', active: true }] });
  const merged = await ipc.invoke('merge-provider', 'custom_1', 'nara');
  assert.deepStrictEqual(merged.keys.map((k) => k.id), ['key_1', 'key_2']);
  assert.deepStrictEqual(await ipc.invoke('delete-provider', 'nara'), { deleted: true });
  assert.deepStrictEqual((await ipc.invoke('read-config')).providers, {});
});

test('write-catalog resets only on reset === true', async (t) => {
  const { ipc } = await setup(t);
  const entry = { key: 'nara::m1', providerId: 'nara', id: 'm1', name: 'm1', removedAt: null, isNew: false, keyIds: [] };
  assert.deepStrictEqual(await ipc.invoke('write-catalog', { models: { 'nara::m1': entry } }), { written: 1, deleted: 0 });
  await assert.rejects(ipc.invoke('write-catalog', { models: {} }, { reset: 'yes' }), /Refusing to empty/);
  assert.deepStrictEqual(await ipc.invoke('write-catalog', { models: {} }, { reset: true }), { written: 0, deleted: 1 });
  assert.deepStrictEqual((await ipc.invoke('read-catalog')).models, {});
});

test('append-run returns the new ids; read-history and clear-history', async (t) => {
  const { ipc } = await setup(t);
  const out = await ipc.invoke('append-run', { at: 1, provider: 'nara', providerName: 'N', prompt: 'p', results: [] }, 300);
  assert.strictEqual(typeof out.id, 'number');
  assert.strictEqual(typeof out.runUid, 'string');
  assert.deepStrictEqual((await ipc.invoke('read-history')).runs.map((r) => r.id), [out.id]);
  assert.deepStrictEqual(await ipc.invoke('clear-history'), { success: true });
  assert.deepStrictEqual((await ipc.invoke('read-history')).runs, []);
});

test('a handler that fails rejects the call', async (t) => {
  const { ipc } = await setup(t);
  await assert.rejects(ipc.invoke('save-settings', null), /must be an object/);
  await assert.rejects(ipc.invoke('merge-provider', 'ghost', 'nara'), /not found/);
});
