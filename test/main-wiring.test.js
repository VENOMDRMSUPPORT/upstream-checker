// main.js needs Electron and can't be loaded under the test runner, so its
// startup and quit order (spec §1) is pinned by reading the source. The
// modules it wires are tested on their own.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// CRLF checkouts would hide the '\n}\n' and '\n});' block markers.
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8').replace(/\r\n/g, '\n');

function block(start, end = '\n});') {
  const at = src.indexOf(start);
  assert.ok(at >= 0, `${start} not found in main.js`);
  return src.slice(at, src.indexOf(end, at));
}

test('startLogs runs after the database opened and before the IPC and the window', () => {
  const ready = block('app.whenReady().then(async () => {');
  const steps = ['startDatabase()', 'startLogs()', 'registerDataIpc(', 'registerLogsIpc(', 'createWindow()'];
  const at = steps.map((s) => ready.indexOf(s));
  at.forEach((i, n) => assert.ok(i >= 0, `${steps[n]} missing from whenReady`));
  assert.deepStrictEqual([...at].sort((x, y) => x - y), at);
});

test('will-quit stops logging (purge timer, then the log DB) before closing venom.db', () => {
  const quit = block("app.on('will-quit', () => {");
  assert.ok(quit.indexOf('stopLogs()') >= 0 && quit.indexOf('stopLogs()') < quit.indexOf('store.close()'));
  const stop = block('function stopLogs() {', '\n}\n');
  assert.ok(stop.indexOf('purgeScheduler.stop()') >= 0 && stop.indexOf('purgeScheduler.stop()') < stop.indexOf('logs.close()'));
});

test('the startup-failure path closes the log database too', () => {
  const ready = block('app.whenReady().then(async () => {');
  const caught = ready.indexOf('} catch (err) {');
  assert.ok(caught >= 0 && ready.indexOf('stopLogs()', caught) > caught);
});

test('requests.log is no longer written; showing and clearing it still work', () => {
  assert.ok(!/appendRequestLog|appendFileSync/.test(src));
  ['read-log-info', 'open-request-log', 'clear-request-log'].forEach((channel) => assert.ok(src.includes(`'${channel}'`), channel));
});

test('api-request goes through the requester and takes no logLevel', () => {
  assert.ok(src.includes("ipcMain.handle('api-request', (_event, args) => requester.request(args || {}));"));
  assert.ok(!/logLevel\s*[,}]/.test(block("ipcMain.handle('api-request'", '\n')));
  assert.ok(src.includes('requester.cancel(requestId, reason)'));
});

test('src/logs and src/api-request never load electron', () => {
  ['settings', 'classify', 'scrub', 'writer', 'retention', 'query', 'lookups', 'recorder', 'ipc', 'index']
    .forEach((m) => require(`../src/logs/${m === 'index' ? '' : m}`));
  require('../src/api-request');
  const electronDir = `${path.sep}node_modules${path.sep}electron${path.sep}`;
  assert.deepStrictEqual(Object.keys(require.cache).filter((f) => f.includes(electronDir)), []);
});
