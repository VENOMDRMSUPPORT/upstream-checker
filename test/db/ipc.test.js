const test = require('node:test');
const assert = require('node:assert');
const { registerDataIpc } = require('../../src/db/ipc');
const { memoryStore, quietLog, LOCKED_BLOB } = require('../helpers');

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

async function setup(t) {
  const store = await memoryStore(t);
  const ipc = fakeIpcMain();
  const clipboard = { text: null, writeText(value) { this.text = value; } };
  registerDataIpc({ ipcMain: ipc, repos: store.repos, clipboard, log: quietLog });
  return { store, ipc, clipboard };
}

const nara = (keys) => ({ id: 'nara', name: 'NaraRouter', baseUrl: 'https://router.bynara.id/v1', rpm: null, keys });

test('registers exactly the data channels', async (t) => {
  const { ipc } = await setup(t);
  assert.deepStrictEqual(ipc.channels(), [
    'append-run', 'clear-history', 'copy-key', 'delete-provider', 'merge-provider', 'read-catalog', 'read-config',
    'read-history', 'save-provider', 'save-secret', 'save-settings', 'save-test-definition', 'write-catalog',
  ]);
});

test('read-config on an empty database', async (t) => {
  const { ipc } = await setup(t);
  assert.deepStrictEqual(await ipc.invoke('read-config'), { version: 1, providers: {} });
});

test('read-config hands out placeholders and hints, never keys', async (t) => {
  const { ipc } = await setup(t);
  await ipc.invoke('save-provider', nara([{ id: 'key_1', name: 'Main', key: 'sk-nara-secret-0001', active: true }]));
  await ipc.invoke('save-secret', 'aaApiKey', 'aa-secret');
  const cfg = await ipc.invoke('read-config');
  assert.deepStrictEqual(cfg.providers.nara.keys[0], {
    id: 'key_1', name: 'Main', key: 'venomkey:key_1', hint: 'sk-nara-se********0001', active: true, locked: false,
  });
  assert.strictEqual(cfg.settings.aaApiKey, 'venomsecret:aaApiKey');
});

test('no reply hands a secret to the renderer', async (t) => {
  const { ipc, clipboard } = await setup(t);
  const secrets = ['sk-live-SECRET-0001', 'sk-live-SECRET-0002', 'aa-live-SECRET'];
  const replies = [];
  replies.push(await ipc.invoke('save-provider', nara([{ id: 'key_1', name: 'A', key: secrets[0], active: true }])));
  replies.push(await ipc.invoke('save-provider', {
    id: 'custom_x', name: 'X', baseUrl: 'https://router.bynara.id/v1/', rpm: null, custom: true,
    keys: [{ id: 'key_2', name: 'B', key: secrets[1], active: true }],
  }));
  replies.push(await ipc.invoke('save-secret', 'aaApiKey', secrets[2]));
  replies.push(await ipc.invoke('read-config'));
  replies.push(await ipc.invoke('merge-provider', 'custom_x', 'nara'));
  replies.push(await ipc.invoke('copy-key', 'key_2'));
  replies.push(await ipc.invoke('read-config'));
  const wire = JSON.stringify(replies);
  secrets.forEach((s) => assert.ok(!wire.includes(s), `${s} reached the renderer`));
  assert.ok(wire.includes('venomkey:key_1') && wire.includes('venomkey:key_2') && wire.includes('venomsecret:aaApiKey'));
  assert.strictEqual(clipboard.text, secrets[1]);
});

test('copy-key writes the clipboard in main and refuses a key it cannot read', async (t) => {
  const { store, ipc, clipboard } = await setup(t);
  store.repos.providers.importProvider({
    id: 'darkapi', name: 'Dark API', baseUrl: 'https://darkapi.dev/v1', rpm: null, custom: false, position: 0,
    keys: [{ id: 'key_9', name: 'Other PC', cipher: LOCKED_BLOB, active: true, quotaSpent: null }],
  });
  await ipc.invoke('save-provider', nara([{ id: 'key_1', name: 'Main', key: 'sk-copy-me', active: true }]));
  assert.deepStrictEqual(await ipc.invoke('copy-key', 'key_1'), { copied: true });
  assert.strictEqual(clipboard.text, 'sk-copy-me');
  await assert.rejects(ipc.invoke('copy-key', 'key_9'), /cannot be read/);
  await assert.rejects(ipc.invoke('copy-key', 'key_nope'), /cannot be read/);
  assert.strictEqual(clipboard.text, 'sk-copy-me');
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
