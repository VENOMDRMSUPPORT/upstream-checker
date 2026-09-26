// Launches a separate VENOM Router on a scratch data folder with remote
// debugging, and drives it over CDP with Node's own fetch and WebSocket (no
// packages). Used by the live checks; never pointed at the owner's data.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Required from plain Node, the electron package exports the binary's path.
const ELECTRON = require('electron');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Refuses anything inside %APPDATA%, where the owner's venom-router folder lives.
export function assertScratchDir(dir) {
  const full = path.resolve(dir).toLowerCase();
  const appData = process.env.APPDATA ? path.resolve(process.env.APPDATA).toLowerCase() : null;
  if (appData && (full === appData || full.startsWith(appData + path.sep))) {
    throw new Error(`Refusing to use ${dir}: it is inside %APPDATA%`);
  }
}

// NODE_ENV=development skips the update check (no GitHub traffic), and
// ELECTRON_RUN_AS_NODE must not leak in from a test shell.
export function appEnv() {
  const env = { ...process.env, NODE_ENV: 'development' };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export { ROOT, ELECTRON };

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms: ${what}`)), ms);
    }),
  ]);
}

export async function launch({ userDataDir, port = 9333 }) {
  assertScratchDir(userDataDir);
  const child = spawn(ELECTRON, [
    '.',
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    // Windows stops painting an occluded window, which stalls CDP calls.
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ], { cwd: ROOT, env: appEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i += 1) {
    await sleep(500);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch (_) {
      // Not listening yet.
    }
  }
  if (!wsUrl) {
    child.kill();
    throw new Error(`The app did not open a debuggable window.\n${output}`);
  }

  const ws = new WebSocket(wsUrl);
  await withTimeout(new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }), 10000, 'CDP connect');
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}, ms = 30000) => {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return withTimeout(new Promise((resolve) => pending.set(id, resolve)), ms, method);
  };

  // Evaluates in the page's global scope (app.js globals are visible) and
  // returns the value; a returned promise is awaited.
  async function evaluate(expression, ms = 30000) {
    const msg = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, ms);
    if (msg.error) throw new Error(msg.error.message);
    const r = msg.result;
    if (r.exceptionDetails) {
      throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    }
    return r.result.value;
  }

  async function waitFor(expression, ms = 20000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        if (await evaluate(expression, 5000)) return true;
      } catch (_) {
        // Page still loading.
      }
      await sleep(250);
    }
    throw new Error(`Timed out waiting for: ${expression}`);
  }

  // Closes through the app's own close path (the title-bar X), so whatever
  // runs on close runs. Kills its own process only if it doesn't exit.
  async function close(ms = 15000) {
    try {
      ws.send(JSON.stringify({ id: nextId++, method: 'Runtime.evaluate', params: { expression: 'window.electronAPI.close()' } }));
    } catch (_) {
      // Socket already gone.
    }
    const code = await Promise.race([exited, sleep(ms).then(() => 'timeout')]);
    try { ws.close(); } catch (_) { /* already closed */ }
    if (code === 'timeout') {
      child.kill();
      await exited;
      throw new Error(`The app did not exit within ${ms} ms of closing its window`);
    }
    return code;
  }

  return { child, evaluate, waitFor, close, exited, output: () => output };
}

// A second, plain instance on the same data folder (no CDP), for the
// single-instance check.
export function spawnPlain({ userDataDir }) {
  assertScratchDir(userDataDir);
  const child = spawn(ELECTRON, ['.', `--user-data-dir=${userDataDir}`], { cwd: ROOT, env: appEnv(), stdio: 'ignore' });
  return { child, exited: new Promise((resolve) => child.on('exit', (code) => resolve(code))) };
}
