const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { requestFlush, DEFAULT_FLUSH_TIMEOUT_MS } = require('../src/flush');

// answer: 'right' (echo the token), 'stale' (an old token), 'never'.
function fakes({ answer = 'right', destroyed = false } = {}) {
  const ipcMain = new EventEmitter();
  const sent = [];
  const webContents = {
    isDestroyed: () => destroyed,
    isCrashed: () => false,
    send(channel, token) {
      sent.push(channel);
      if (answer === 'right') setImmediate(() => ipcMain.emit('flush-done', {}, token));
      if (answer === 'stale') setImmediate(() => ipcMain.emit('flush-done', {}, 'an-earlier-token'));
    },
  };
  return { ipcMain, webContents, sent };
}

test('resolves "done" when the renderer confirms, then stops listening', async () => {
  const f = fakes();
  assert.strictEqual(await requestFlush({ webContents: f.webContents, ipcMain: f.ipcMain, timeoutMs: 1000 }), 'done');
  assert.deepStrictEqual(f.sent, ['flush-pending']);
  assert.strictEqual(f.ipcMain.listenerCount('flush-done'), 0);
});

test('a renderer that never answers cannot hold the close past the timeout', async () => {
  const f = fakes({ answer: 'never' });
  const started = Date.now();
  assert.strictEqual(await requestFlush({ webContents: f.webContents, ipcMain: f.ipcMain, timeoutMs: 100 }), 'timeout');
  const took = Date.now() - started;
  assert.ok(took >= 90 && took < 1000, `took ${took} ms`);
  assert.strictEqual(f.ipcMain.listenerCount('flush-done'), 0);
});

test('an answer to an earlier request is ignored', async () => {
  const f = fakes({ answer: 'stale' });
  assert.strictEqual(await requestFlush({ webContents: f.webContents, ipcMain: f.ipcMain, timeoutMs: 100 }), 'timeout');
});

test('a destroyed window is skipped at once', async () => {
  const f = fakes({ destroyed: true });
  assert.strictEqual(await requestFlush({ webContents: f.webContents, ipcMain: f.ipcMain, timeoutMs: 1000 }), 'skipped');
  assert.deepStrictEqual(f.sent, []);
});

test('the default wait is 2 seconds', () => {
  assert.strictEqual(DEFAULT_FLUSH_TIMEOUT_MS, 2000);
});
