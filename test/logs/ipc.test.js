const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { registerLogsIpc, LOGS_CHANNELS } = require('../../src/logs/ipc');
const { logsStore, logRow, tempDir, quietLog } = require('../helpers');

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

function setup({ logs = null, error = null, pick = { canceled: true, filePath: '' } } = {}) {
  const ipc = fakeIpcMain();
  const errors = [];
  const dialog = {
    next: pick,
    calls: [],
    showSaveDialog(...args) {
      this.calls.push(args[args.length - 1]);
      return Promise.resolve(this.next);
    },
  };
  registerLogsIpc({
    ipcMain: ipc, getState: () => ({ logs, error }), dialog, getWindow: () => null,
    log: { ...quietLog, error: (...a) => errors.push(a.join(' ')) },
  });
  return { ipc, dialog, errors };
}

test('registers exactly the log channels', () => {
  assert.deepStrictEqual(setup().ipc.channels(), [
    'logs-clear', 'logs-export', 'logs-facets', 'logs-get', 'logs-info', 'logs-list', 'logs-run-summary', 'logs-runs', 'logs-stats',
  ]);
  // The exported list is what a caller reads to know what exists; it must not
  // drift from what was actually registered.
  assert.deepStrictEqual([...LOGS_CHANNELS].sort(), setup().ipc.channels());
});

test('with logging on, the reads answer from the database', async (t) => {
  const logs = logsStore(t);
  logs.writer.add(logRow({ request_uid: 'IPC1', run_id: 'RUN1' }));
  logs.writer.flush();
  const { ipc } = setup({ logs });
  const page = await ipc.invoke('logs-list', {}, null, 10);
  assert.strictEqual(page.rows.length, 1);
  assert.strictEqual((await ipc.invoke('logs-get', page.rows[0].id)).request_uid, 'IPC1');
  const info = await ipc.invoke('logs-info');
  assert.deepStrictEqual([info.enabled, info.rows], [true, 1]);
  assert.strictEqual((await ipc.invoke('logs-stats', {}, 'hour', 'none')).totals.requests, 1);
  assert.deepStrictEqual((await ipc.invoke('logs-facets', {})).sources, ['route_test']);
  assert.strictEqual((await ipc.invoke('logs-run-summary', 'RUN1')).count, 1);
  assert.deepStrictEqual((await ipc.invoke('logs-runs', {}, null, 10)).rows.map((r) => r.run_id), ['RUN1']);
  assert.deepStrictEqual(await ipc.invoke('logs-clear', {}), { rows: 1, bodies: 0, rollups: 1 });
});

test('with logging off: info says why, reads are empty, export and clear do nothing', async () => {
  const { ipc, dialog } = setup({ logs: null, error: 'file is not a database' });
  assert.deepStrictEqual(await ipc.invoke('logs-info'), {
    enabled: false, error: 'file is not a database', path: null, sizeBytes: 0, rows: 0, oldestAt: null, droppedRows: 0, lastPurgeAt: null,
  });
  assert.deepStrictEqual(await ipc.invoke('logs-list', {}, null, 10), { rows: [], nextCursor: null });
  assert.strictEqual(await ipc.invoke('logs-get', 1), null);
  const stats = await ipc.invoke('logs-stats', {}, 'hour', 'none');
  assert.deepStrictEqual([stats.totals.requests, stats.series], [0, []]);
  assert.deepStrictEqual(await ipc.invoke('logs-facets', {}), { providers: [], models: [], sources: [] });
  const run = await ipc.invoke('logs-run-summary', 'RUN1');
  assert.deepStrictEqual([run.runId, run.count], ['RUN1', 0]);
  assert.deepStrictEqual(await ipc.invoke('logs-export', {}, 'csv'), { saved: false, path: null, rows: 0 });
  assert.deepStrictEqual(await ipc.invoke('logs-clear', {}), { rows: 0, bodies: 0, rollups: 0 });
  assert.strictEqual(dialog.calls.length, 0);
});

test('export: CSV to the chosen file; a cancelled dialog saves nothing; an unknown format is refused before any dialog', async (t) => {
  const dir = tempDir(t);
  const logs = logsStore(t);
  logs.writer.add(logRow());
  logs.writer.add(logRow());
  logs.writer.flush();
  const file = path.join(dir, 'export.csv');
  const { ipc, dialog } = setup({ logs, pick: { canceled: false, filePath: file } });
  assert.deepStrictEqual(await ipc.invoke('logs-export', {}, 'csv'), { saved: true, path: file, rows: 2 });
  assert.ok(fs.readFileSync(file, 'utf8').startsWith('id,request_uid,'));
  assert.match(dialog.calls[0].defaultPath, /^venom-requests-\d{4}-\d{2}-\d{2}\.csv$/);
  dialog.next = { canceled: true, filePath: '' };
  assert.deepStrictEqual(await ipc.invoke('logs-export', {}, 'json'), { saved: false, path: null, rows: 0 });
  await assert.rejects(ipc.invoke('logs-export', {}, 'xml'), /Unknown export format/);
  assert.strictEqual(dialog.calls.length, 2);
});

test('a failing query rejects the call and is logged', async (t) => {
  const logs = logsStore(t);
  const { ipc, errors } = setup({ logs });
  await assert.rejects(ipc.invoke('logs-stats', {}, 'week', 'none'), /Unknown bucket/);
  assert.match(errors[0], /logs-stats failed/);
});
