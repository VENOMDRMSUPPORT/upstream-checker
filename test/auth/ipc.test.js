// The auth IPC surface: five channels, every one of them resolving, and nothing
// on the wire that carries the hash.
const test = require('node:test');
const assert = require('node:assert');
const { registerAuthIpc } = require('../../src/auth/ipc');
const { createAuthLock, MAX_FAILED, THROTTLE_MS } = require('../../src/auth');
const { hashPassword, DEFAULT_PASSWORD } = require('../../src/auth/hash');
const { quietLog } = require('../helpers');

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

function fakeRepo() {
  const state = { row: null };
  return {
    state,
    get: () => (state.row ? { ...state.row } : null),
    ensureDefault(hash, { now = 0, isDefault = true } = {}) {
      if (state.row) return { ...state.row };
      state.row = { hash, is_default: isDefault ? 1 : 0, failed_attempts: 0, locked_until: 0, created_at: now };
      return { ...state.row };
    },
    setHash(hash, { isDefault = false, now = 0 } = {}) {
      Object.assign(state.row, { hash, is_default: isDefault ? 1 : 0, failed_attempts: 0, locked_until: 0, changed_at: now });
      return { ...state.row };
    },
    recordFailure(n) { state.row.failed_attempts = n; return n; },
    setLockedUntil(ts) { state.row.locked_until = ts; },
    clearFailures() { state.row.failed_attempts = 0; state.row.locked_until = 0; },
    remove() { const n = state.row ? 1 : 0; state.row = null; return n; },
  };
}

function setup({ idleMs = 0, withRow = true } = {}) {
  const clock = { t: 1_000_000 };
  const repo = fakeRepo();
  const auth = createAuthLock({ repo, log: quietLog, now: () => clock.t, idleMs });
  if (withRow) {
    repo.ensureDefault(hashPassword(DEFAULT_PASSWORD).value, { now: clock.t });
  }
  const ipc = fakeIpcMain();
  const announcements = [];
  registerAuthIpc({ ipcMain: ipc, auth, log: quietLog, onLocked: (why) => announcements.push(why) });
  return { repo, auth, ipc, clock, announcements };
}

test('registers exactly the five auth channels', () => {
  const { ipc } = setup();
  assert.deepStrictEqual(ipc.channels(), ['auth:activity', 'auth:change', 'auth:lock', 'auth:status', 'auth:unlock']);
});

test('auth:status reports the lock without ever carrying the hash', async () => {
  const { ipc, repo } = setup();
  const reply = await ipc.invoke('auth:status');
  assert.strictEqual(reply.ok, true);
  assert.strictEqual(reply.locked, true);
  assert.strictEqual(reply.isDefault, true);
  assert.strictEqual(reply.hasRow, true);
  const serialised = JSON.stringify(reply);
  assert.ok(!serialised.includes('scrypt$'), 'no hash');
  assert.ok(!serialised.includes(repo.get().hash), 'and certainly not this one');
});

test('auth:unlock resolves a verdict rather than rejecting', async () => {
  const { ipc } = setup();
  const bad = await ipc.invoke('auth:unlock', 'wrong');
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.code, 'WRONG_PASSWORD');
  const good = await ipc.invoke('auth:unlock', DEFAULT_PASSWORD);
  assert.deepStrictEqual(good, { ok: true });
  assert.strictEqual((await ipc.invoke('auth:status')).locked, false);
});

test('auth:unlock before the row exists is LOCK_NOT_READY, not a rejection', async () => {
  const { ipc } = setup({ withRow: false });
  const reply = await ipc.invoke('auth:unlock', DEFAULT_PASSWORD);
  assert.strictEqual(reply.ok, false);
  assert.strictEqual(reply.code, 'LOCK_NOT_READY');
});

test('auth:change refuses a weak value with a code the UI can act on', async () => {
  const { ipc } = setup();
  await ipc.invoke('auth:unlock', DEFAULT_PASSWORD);
  const weak = await ipc.invoke('auth:change', DEFAULT_PASSWORD, 'short');
  assert.strictEqual(weak.code, 'WEAK_PASSWORD');
  const ok = await ipc.invoke('auth:change', DEFAULT_PASSWORD, 'a-much-better-one');
  assert.strictEqual(ok.ok, true);
  assert.strictEqual((await ipc.invoke('auth:status')).isDefault, false);
});

test('auth:lock ends the session and tells the main process why', async () => {
  const { ipc, announcements } = setup();
  await ipc.invoke('auth:unlock', DEFAULT_PASSWORD);
  assert.strictEqual((await ipc.invoke('auth:status')).locked, false);
  assert.deepStrictEqual(await ipc.invoke('auth:lock'), { ok: true });
  assert.deepStrictEqual(announcements, ['locked']);
  assert.strictEqual((await ipc.invoke('auth:status')).locked, true);
});

test('an idle expiry is announced once, through auth:status', async () => {
  const { ipc, clock, announcements } = setup({ idleMs: 1000 });
  await ipc.invoke('auth:unlock', DEFAULT_PASSWORD);
  clock.t += 1000;
  assert.strictEqual((await ipc.invoke('auth:status')).locked, true);
  assert.deepStrictEqual(announcements, ['expired']);
  // A second read reports the same state and announces nothing again.
  await ipc.invoke('auth:status');
  assert.deepStrictEqual(announcements, ['expired']);
});

test('auth:activity is accepted and resolves', async () => {
  const { ipc } = setup();
  await ipc.invoke('auth:unlock', DEFAULT_PASSWORD);
  assert.deepStrictEqual(await ipc.invoke('auth:activity'), { ok: true, locked: false });
});

test('an onLocked hook that throws does not take the channel down with it', async () => {
  const repo = fakeRepo();
  repo.ensureDefault(hashPassword(DEFAULT_PASSWORD).value);
  const auth = createAuthLock({ repo, log: quietLog, idleMs: 0 });
  const ipc = fakeIpcMain();
  registerAuthIpc({ ipcMain: ipc, auth, log: quietLog, onLocked: () => { throw new Error('no window'); } });
  // The lock still happens; only the announcement is lost.
  assert.deepStrictEqual(await ipc.invoke('auth:lock'), { ok: true });
  assert.strictEqual((await ipc.invoke('auth:status')).locked, true);
});

test('a throttled brute force reaches the renderer as THROTTLED with a wait', async () => {
  const { ipc } = setup();
  for (let i = 1; i < MAX_FAILED; i += 1) {
    assert.strictEqual((await ipc.invoke('auth:unlock', 'nope')).code, 'WRONG_PASSWORD');
  }
  const braked = await ipc.invoke('auth:unlock', 'nope');
  assert.strictEqual(braked.code, 'THROTTLED');
  assert.strictEqual(braked.retryAfterMs, THROTTLE_MS);
  assert.match(braked.message, /Try again/);
});
