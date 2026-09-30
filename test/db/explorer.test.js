const test = require('node:test');
const assert = require('node:assert');
const { memoryStore, quietLog } = require('../helpers');
const { registerDataIpc } = require('../../src/db/ipc');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle(channel, fn) { handlers.set(channel, fn); },
    invoke: async (channel, ...args) => handlers.get(channel)({}, ...args),
    channels: () => [...handlers.keys()].sort(),
  };
}

test('database explorer lists tables and schema without exposing secret or body columns', async (t) => {
  const store = await memoryStore(t);
  const ipc = fakeIpcMain();
  registerDataIpc({ ipcMain: ipc, repos: store.repos, databases: { app: store.db }, clipboard: { writeText() {} }, log: quietLog });
  assert.ok(ipc.channels().includes('database-explorer'));
  store.db.prepare('INSERT INTO secrets (name, cipher, updated_at) VALUES (?, ?, ?)').run('test-secret', 'enc:v1:never-return-this', 1);
  const result = await ipc.invoke('database-explorer', { database: 'app', table: 'secrets', limit: 20 });
  assert.ok(result.tables.some((table) => table.name === 'provider_keys'));
  assert.ok(result.schema.some((column) => column.name === 'cipher' && column.redacted));
  assert.strictEqual(result.rows[0].cipher, '[redacted]');
  assert.ok(!JSON.stringify(result).includes('never-return-this'));
  assert.strictEqual(result.database, 'app');
});

test('database explorer only accepts known databases and tables, clamps result limits', async (t) => {
  const store = await memoryStore(t);
  const ipc = fakeIpcMain();
  registerDataIpc({ ipcMain: ipc, repos: store.repos, databases: { app: store.db }, clipboard: { writeText() {} }, log: quietLog });
  await assert.rejects(ipc.invoke('database-explorer', { database: '../../secrets', table: 'anything' }), /database/i);
  await assert.rejects(ipc.invoke('database-explorer', { database: 'app', table: 'sqlite_master' }), /table/i);
  const result = await ipc.invoke('database-explorer', { database: 'app', table: 'meta', limit: 99999 });
  assert.ok(result.rows.length <= 100);
});