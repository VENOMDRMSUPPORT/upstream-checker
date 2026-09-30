'use strict';

// An Electron entry that arms a throwing network guard and then boots the real
// main process. Run it instead of `electron .` to answer one question with an
// exit code rather than an argument: does VENOM Router reach the network before
// the owner clicks something?
//
//   node scripts/live/verify-catalog-boot.mjs        (drives this over CDP)
//
// Every outbound path main has goes through one of the hooks below: the catalog
// fetcher uses global `fetch`, src/api-request.js uses `https`/`http`, and a raw
// socket would be `net`/`tls`. `dns` is armed too, because a hostname lookup is
// already traffic. Requiring those modules is not traffic and is not blocked —
// electron-updater loads them at startup and says nothing over the wire in a
// development run (src/main.js skips the update check on NODE_ENV).
//
// The renderer is not in reach of this file and does not need it: it has no Node,
// and `connect-src 'none'` in its CSP (src/renderer/index.html) blocks fetch there.
// Main owns every socket in this app, so main is where the guard goes.
//
// An attempt is recorded the moment it happens — appended, so a crash or a kill
// cannot lose the log — and then throws. The report file is the evidence: an empty
// one after boot plus a visit to Settings means the app started clean.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const dns = require('dns');
const http2 = require('http2');

const REPORT = process.env.BOOT_GUARD_REPORT
  || path.join(process.env.TEMP || require('os').tmpdir(), 'venom-boot-guard.txt');

// The switch is Electron's, so read it before anything asks for a path.
const userDataFlag = process.argv.find((a) => a.startsWith('--user-data-dir='));
if (!userDataFlag) {
  console.error('BOOT GUARD: refusing to run without --user-data-dir (a scratch folder only)');
  process.exit(2);
}
const SCRATCH = path.resolve(userDataFlag.slice('--user-data-dir='.length));
const APPDATA = process.env.APPDATA ? path.resolve(process.env.APPDATA) : null;
if (APPDATA && (SCRATCH.toLowerCase() === APPDATA.toLowerCase()
  || SCRATCH.toLowerCase().startsWith(`${APPDATA.toLowerCase()}${path.sep}`))) {
  console.error(`BOOT GUARD: refusing a data folder inside %APPDATA%: ${SCRATCH}`);
  process.exit(2);
}

let attempts = 0;
function record(kind, target) {
  attempts += 1;
  const where = new Error().stack.split('\n').slice(3, 7).join('\n').trim();
  const line = `BLOCKED  ${kind}  ${String(target).slice(0, 160)}\n${where}\n\n`;
  try { fs.appendFileSync(REPORT, line); } catch (_) { /* the throw below is the point */ }
  const error = new Error(`BOOT GUARD: ${kind} is blocked in this run (${String(target).slice(0, 120)})`);
  error.code = 'BOOT_GUARD_BLOCKED';
  throw error;
}

function arm(object, name, kind) {
  const original = object && object[name];
  if (typeof original !== 'function') return;
  object[name] = function guarded(...args) {
    const target = args[0] && (args[0].host || args[0].hostname || args[0].url || args[0].path)
      || (typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0] && args[0].port || args[0] || ''));
    return record(kind, target);
  };
}

arm(globalThis, 'fetch', 'fetch()');
for (const [module_, label] of [[http, 'http'], [https, 'https']]) {
  arm(module_, 'request', `${label}.request()`);
  arm(module_, 'get', `${label}.get()`);
}
arm(net, 'connect', 'net.connect()');
arm(net, 'createConnection', 'net.createConnection()');
arm(net.Socket.prototype, 'connect', 'socket.connect()');
arm(tls, 'connect', 'tls.connect()');
arm(http2, 'connect', 'http2.connect()');
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'lookupService']) {
  arm(dns, name, `dns.${name}()`);
}

fs.writeFileSync(REPORT, `guard armed for ${SCRATCH}\n`);
process.on('exit', () => {
  try { fs.appendFileSync(REPORT, `exit: ${attempts} network attempt(s) blocked\n`); } catch (_) { /* dying */ }
});

// Boot the app with every one of the above armed to throw.
require(path.join(__dirname, '..', '..', 'src', 'main.js'));
