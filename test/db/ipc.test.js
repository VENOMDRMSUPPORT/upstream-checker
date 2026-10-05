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
    handlers,
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

// The catalogue left this surface: the model pool moved to repos.snapshots and
// is reached only through the catalog:* channels in src/catalog/ipc.js.
test('registers exactly the data channels', async (t) => {
  const { ipc } = await setup(t);
  assert.deepStrictEqual(ipc.channels(), [
    'append-run', 'clear-history', 'copy-key', 'database-explorer', 'delete-provider', 'merge-provider',
    'read-config', 'read-history', 'save-provider', 'save-secret', 'save-settings', 'save-test-definition',
  ]);
});

test('read-config on an empty database', async (t) => {
  const { ipc } = await setup(t);
  assert.deepStrictEqual(await ipc.invoke('read-config'), { version: 1, providers: {} });
});

test('read-config hands out placeholders and hints, never keys', async (t) => {
  const { ipc } = await setup(t);
  await ipc.invoke('save-provider', nara([{ id: 'key_1', name: 'Main', key: 'sk-nara-secret-0001', active: true }]));
  await ipc.invoke('save-secret', 'openRouterApiKey', 'or-secret');
  const cfg = await ipc.invoke('read-config');
  assert.deepStrictEqual(cfg.providers.nara.keys[0], {
    id: 'key_1', name: 'Main', key: 'venomkey:key_1', hint: 'sk-nara-se********0001', active: true, locked: false,
  });
  assert.strictEqual(cfg.settings.openRouterApiKey, 'venomsecret:openRouterApiKey');
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
  replies.push(await ipc.invoke('save-secret', 'openRouterApiKey', secrets[2]));
  replies.push(await ipc.invoke('read-config'));
  replies.push(await ipc.invoke('merge-provider', 'custom_x', 'nara'));
  replies.push(await ipc.invoke('copy-key', 'key_2'));
  replies.push(await ipc.invoke('read-config'));
  const wire = JSON.stringify(replies);
  secrets.forEach((s) => assert.ok(!wire.includes(s), `${s} reached the renderer`));
  assert.ok(wire.includes('venomkey:key_1') && wire.includes('venomkey:key_2') && wire.includes('venomsecret:openRouterApiKey'));
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

// The lock gate: copy-key is one of the two channels that hands over a secret
// (api-request is the other, gated in src/main.js). It answers a value rather
// than throwing, because `err.code` does not cross ipcMain.handle — a renderer
// that received only a message could not tell "locked" from a real failure.
test('copy-key refuses while the app is locked, and the clipboard is not written', async (t) => {
  const store = await memoryStore(t);
  const ipc = fakeIpcMain();
  const clipboard = { text: null, writeText(value) { this.text = value; } };
  const locked = { isLocked: () => true };
  registerDataIpc({ ipcMain: ipc, repos: store.repos, clipboard, log: quietLog, auth: locked });
  await ipc.invoke('save-provider', nara([{ id: 'key_1', name: 'Main', key: 'sk-copy-me', active: true }]));

  assert.deepStrictEqual(await ipc.invoke('copy-key', 'key_1'),
    { ok: false, code: 'LOCKED', message: 'The app is locked.' });
  assert.strictEqual(clipboard.text, null, 'nothing reached the clipboard');
});

test('copy-key works again once the app is unlocked', async (t) => {
  const store = await memoryStore(t);
  const ipc = fakeIpcMain();
  const clipboard = { text: null, writeText(value) { this.text = value; } };
  const state = { locked: true };
  registerDataIpc({
    ipcMain: ipc, repos: store.repos, clipboard, log: quietLog,
    auth: { isLocked: () => state.locked },
  });
  await ipc.invoke('save-provider', nara([{ id: 'key_1', name: 'Main', key: 'sk-copy-me', active: true }]));

  assert.strictEqual((await ipc.invoke('copy-key', 'key_1')).code, 'LOCKED');
  state.locked = false;
  assert.deepStrictEqual(await ipc.invoke('copy-key', 'key_1'), { copied: true });
  assert.strictEqual(clipboard.text, 'sk-copy-me');
});

test('no auth object means no gate — the other data channels are unaffected', async (t) => {
  // The lock is opt-in on this surface, so the existing wiring keeps working
  // exactly as it did and only copy-key gains a condition.
  const { ipc, store } = await setup(t);
  await ipc.invoke('save-provider', nara([{ id: 'key_1', name: 'Main', key: 'sk-x', active: true }]));
  assert.deepStrictEqual(await ipc.invoke('copy-key', 'key_1'), { copied: true });
  assert.deepStrictEqual(Object.keys(await ipc.invoke('read-config')).sort(), ['providers', 'version']);
  assert.strictEqual((await ipc.invoke('read-history')).length ?? 0, 0);
  assert.ok(store);
});

test('save-settings drops the key; settings, test and window come back in read-config', async (t) => {
  const { store, ipc } = await setup(t);
  assert.deepStrictEqual(await ipc.invoke('save-settings', { theme: 'daylight', openRouterApiKey: 'or-typed' }), { success: true });
  assert.deepStrictEqual(await ipc.invoke('save-test-definition', { prompt: 'p', expected: 'e', autoMinutes: 0 }), { success: true });
  store.repos.settings.set('window', { width: 1200, height: 800, maximized: false });
  assert.deepStrictEqual(await ipc.invoke('read-config'), {
    version: 1,
    providers: {},
    settings: { theme: 'daylight', openRouterApiKey: '' },
    test: { prompt: 'p', expected: 'e', autoMinutes: 0 },
    window: { width: 1200, height: 800, maximized: false },
  });
  assert.strictEqual(store.repos.secrets.has('openRouterApiKey'), false);
});

test('save-secret answers with the placeholder, or empty after a delete', async (t) => {
  const { ipc } = await setup(t);
  assert.deepStrictEqual(await ipc.invoke('save-secret', 'openRouterApiKey', 'or-secret'), { placeholder: 'venomsecret:openRouterApiKey' });
  assert.deepStrictEqual(await ipc.invoke('save-secret', 'openRouterApiKey', ''), { placeholder: '' });
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

test('the model pool is not on this surface at all', async (t) => {
  // read-catalog / write-catalog are gone with repos/catalog.js. The roster is
  // reached only through catalog:ingest and catalog:read (src/catalog/ipc.js),
  // and a stale channel name here would be a handler nothing answers.
  const { ipc } = await setup(t);
  assert.ok(!ipc.channels().includes('read-catalog'));
  assert.ok(!ipc.channels().includes('write-catalog'));
  assert.strictEqual(ipc.handlers.has('write-catalog'), false);
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

test('save-settings hands main the merged settings, and the key never travels with them', async (t) => {
  const store = await memoryStore(t);
  const ipc = fakeIpcMain();
  const seen = [];
  registerDataIpc({
    ipcMain: ipc, repos: store.repos, clipboard: { writeText() {} }, log: quietLog,
    hooks: { onSettingsSaved: (s) => seen.push(['settings', s]) },
  });
  await ipc.invoke('save-settings', { theme: 'daylight' });
  await ipc.invoke('save-settings', { logLevel: 'all', openRouterApiKey: 'or-typed' });
  assert.deepStrictEqual(seen, [
    ['settings', { theme: 'daylight' }],
    ['settings', { theme: 'daylight', logLevel: 'all' }],
  ]);
  assert.strictEqual(store.repos.secrets.has('openRouterApiKey'), false, 'the typed key went nowhere');
});

test('a hook that throws does not fail the save', async (t) => {
  const store = await memoryStore(t);
  const ipc = fakeIpcMain();
  const warnings = [];
  registerDataIpc({
    ipcMain: ipc, repos: store.repos, clipboard: { writeText() {} },
    log: { ...quietLog, warn: (...a) => warnings.push(a.join(' ')) },
    hooks: { onSettingsSaved: () => { throw new Error('cache bug'); } },
  });
  assert.deepStrictEqual(await ipc.invoke('save-settings', { theme: 'daylight' }), { success: true });
  assert.strictEqual(store.repos.settings.get('settings').theme, 'daylight');
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /onSettingsSaved failed/);
});
