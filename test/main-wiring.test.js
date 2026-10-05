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
  assert.ok(src.includes('requester.request(args || {})'));
  assert.ok(!/logLevel\s*[,}]/.test(block("ipcMain.handle('api-request'", '\n')));
  assert.ok(src.includes('requester.cancel(requestId, reason)'));
});

test('api-request is gated by the app lock, and a gated call spends nothing', () => {
  const gate = block("ipcMain.handle('api-request'", '\n});\n');
  // The gate must come before the request goes out, and must return a value the
  // renderer can read — not throw, because a code on a rejection does not cross.
  assert.ok(gate.includes('auth.isLocked()'), 'the lock is consulted');
  assert.ok(gate.indexOf('auth.isLocked()') < gate.indexOf('requester.request(args || {})'),
    'and consulted before the request is sent');
  assert.ok(/outcome:\s*'locked'/.test(gate), 'the refusal is a value with an outcome, not a throw');
  // Main's own code counts as activity, so the idle deadline does not depend on
  // the renderer having reported anything.
  assert.ok(gate.includes('auth.noteActivity()'));
});

test('the app lock is built after the database opens and before the window', () => {
  const ready = block('app.whenReady().then(async () => {');
  const steps = ['startDatabase()', 'startLogs()', 'createAuthLock(', 'auth.ensureDefault()', 'registerAuthIpc(', 'createWindow()'];
  const at = steps.map((s) => ready.indexOf(s));
  at.forEach((i, n) => assert.ok(i >= 0, `${steps[n]} missing from whenReady`));
  assert.deepStrictEqual([...at].sort((x, y) => x - y), at,
    'the lock row lives in venom.db, so it cannot be built before the store is open');
  assert.ok(ready.indexOf('startDatabase()') < ready.indexOf('createAuthLock('));
});

test('the catalog starts after both databases and both IPC blocks, before the window', () => {
  const ready = block('app.whenReady().then(async () => {');
  const steps = ['registerDataIpc(', 'registerLogsIpc(', 'startCatalog(', 'createWindow()'];
  const at = steps.map((s) => ready.indexOf(s));
  at.forEach((i, n) => assert.ok(i >= 0, `${steps[n]} missing from whenReady`));
  assert.deepStrictEqual([...at].sort((x, y) => x - y), at,
    'catalog:* channels write through repos.snapshots, so they cannot be registered before the store');
});

// The owner's safety rule: opening a window must not download anything. Pinning
// the source is the cheap half; scripts/live/boot-guard.cjs arms a throwing
// fetch/net guard over a real boot of the app for the other half.
test('starting the catalog reads the cache and never syncs, and no timer is registered on it', () => {
  const boot = block('function startCatalog({ repos, log', '\n}\n');
  assert.ok(boot.includes('engine.loadCache()'), 'boot reads the four cached documents');
  // onRosterWritten is the price book's cache invalidation, called by
  // catalog:ingest — not a network call and not a timer, and it is the only
  // reason the log recorder's costs can be current.
  assert.ok(boot.includes('onRosterWritten'), 'a roster write invalidates the price book');
  for (const networked of ['syncAll', 'fetchAll', 'fetchJson', 'setInterval', 'setTimeout']) {
    assert.ok(!boot.includes(networked),
      `startCatalog must not mention ${networked}(): nothing downloads because a window opened`);
  }
  const quit = block("app.on('will-quit', () => {");
  assert.ok(!/catalog/i.test(quit),
    'will-quit gains nothing for the catalog: it starts no timer and opens no handle, so the close handshake stays as it was');
});

test('src/logs and src/api-request never load electron', () => {
  ['settings', 'classify', 'scrub', 'writer', 'retention', 'query', 'lookups', 'recorder', 'ipc', 'index']
    .forEach((m) => require(`../src/logs/${m === 'index' ? '' : m}`));
  require('../src/api-request');
  const electronDir = `${path.sep}node_modules${path.sep}electron${path.sep}`;
  assert.deepStrictEqual(Object.keys(require.cache).filter((f) => f.includes(electronDir)), []);
});
