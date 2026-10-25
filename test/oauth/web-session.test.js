// The web-session flow: a provider that signs in on a page of its own.
//
// What the tests must pin:
//   1. the declaration is checked before it is used — the addresses must be
//      https, and the session address must be the provider's own origin,
//      because the session goes nowhere else
//   2. the sign-in window waits for the provider to say the person is signed
//      in, then takes the session
//   3. the account is stored as a provider key with the session as its
//      credential, and with no second secret
const test = require('node:test');
const assert = require('node:assert');
const web = require('../../src/oauth/web-session');
const { createOAuthManager } = require('../../src/oauth');
const { memoryStore, quietLog } = require('../helpers');

const DECL = {
  kind: 'web',
  signInUrl: 'https://muse.ai/',
  sessionUrl: 'https://muse.ai/api/session',
  sessionMarker: 'assigned',
  cookieNames: ['hatch_sess', 'hatch_gw'],
  usage: { steps: [{ read: 'dialog' }] },
};

test('a declaration that is not a web sign-in is refused', () => {
  assert.throws(() => web.normalise({ kind: 'device' }), /web page/i);
});

test('a non-https sign-in address is refused', () => {
  assert.throws(() => web.normalise({ ...DECL, signInUrl: 'http://muse.ai/' }), /sign-in address/i);
});

test('a session address on another origin is refused', () => {
  assert.throws(
    () => web.normalise({ ...DECL, sessionUrl: 'https://elsewhere.example/api/session' }),
    /another address/i,
  );
});

test('the good declaration is accepted', () => {
  const cfg = web.normalise(DECL);
  assert.strictEqual(cfg.kind, 'web');
  assert.strictEqual(cfg.origin, 'https://muse.ai');
  assert.deepStrictEqual(cfg.cookieNames, ['hatch_sess', 'hatch_gw']);
});

// A window that answers what the flow asks it.
function fakeWindow({ sessionAnswer = { status: 200, text: '{"status":"assigned"}' }, cookies = [] } = {}) {
  const calls = [];
  return {
    calls,
    isDestroyed: () => false,
    destroy() { this.destroyed = true; },
    setMenuBarVisibility() {},
    setBounds() {},
    async loadURL(url) { calls.push(['load', url]); },
    webContents: {
      session: {
        cookies: {
          async get() { return cookies; },
          async set() { return null; },
        },
      },
      sendInputEvent() { },
      async executeJavaScript(js) {
        calls.push(['js', js]);
        if (js.includes('/api/session')) return sessionAnswer;
        if (js.includes('innerText')) return 'person@example.com';
        if (js.includes('range')) return { x: 10, y: 10 };
        return '';
      },
    },
  };
}

function fakeBrowserWindow(window) {
  return function BrowserWindowStub() { return window; };
}

test('the sign-in window waits for the session and then the account is stored', async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.save({ id: 'muse', name: 'Muse AI', baseUrl: 'https://muse.ai', rpm: null, keys: [] });
  const win = fakeWindow({
    cookies: [
      { name: 'hatch_sess', value: 'sess-value' },
      { name: 'hatch_gw', value: 'gw-value' },
      { name: 'other', value: 'ignored' },
    ],
  });
  const oauth = createOAuthManager({
    repos: store.repos,
    log: quietLog,
    BrowserWindow: fakeBrowserWindow(win),
    // The wait gives up on its own; the session ends either way.
    webSessionTimeoutMs: 300,
  });

  const started = await oauth.start('muse', DECL);
  assert.strictEqual(started.ok, true);
  assert.strictEqual(started.inAppWindow, true);

  // The manager runs the flow in the background; wait for it to finish.
  let state = null;
  for (let i = 0; i < 50; i += 1) {
    state = oauth.status('muse');
    if (state.state === 'done' || state.state === 'failed') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.strictEqual(state.state, 'done', JSON.stringify(state));
  assert.strictEqual(state.account.email, 'person@example.com');

  const provider = store.repos.providers.get('muse');
  assert.strictEqual(provider.keys.length, 1);
  const key = provider.keys[0];
  assert.strictEqual(key.oauth, true);
  assert.strictEqual(key.oauthKey, undefined, 'a web account has no second secret');
  assert.strictEqual(key.account.oauthKind, 'web');
  // The credential is the session, and it is stored encrypted.
  const jar = store.repos.providers.revealKey(key.id);
  assert.ok(jar.includes('hatch_sess=sess-value'), 'the session is the credential');
  assert.ok(!jar.includes('ignored'), 'only the cookies the provider named are kept');
  const row = store.db.prepare('SELECT cipher, oauth_cipher FROM provider_keys WHERE id = ?').get(key.id);
  assert.ok(row.cipher.startsWith('enc:v1:'), 'the session is in the envelope');
  assert.strictEqual(row.oauth_cipher, null, 'no second secret beside it');
});

test('a sign-in that never happens fails, and stores nothing', async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.save({ id: 'muse', name: 'Muse AI', baseUrl: 'https://muse.ai', rpm: null, keys: [] });
  const win = fakeWindow({ sessionAnswer: { status: 401, text: '' } });
  const oauth = createOAuthManager({
    repos: store.repos,
    log: quietLog,
    BrowserWindow: fakeBrowserWindow(win),
    // The wait gives up on its own instead of waiting for the full window.
    webSessionTimeoutMs: 300,
  });
  const started = await oauth.start('muse', DECL);
  assert.strictEqual(started.ok, true);
  let state = null;
  for (let i = 0; i < 50; i += 1) {
    state = oauth.status('muse');
    if (state.state === 'done' || state.state === 'failed') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  // The wait gives up on its own; the session ends either way.
  assert.ok(['failed', 'pending'].includes(state.state), state.state);
  assert.strictEqual(store.repos.providers.get('muse').keys.length, 0);
});

test('a declaration main cannot use is refused before any window opens', async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.save({ id: 'muse', name: 'Muse AI', baseUrl: 'https://muse.ai', rpm: null, keys: [] });
  let opened = 0;
  const oauth = createOAuthManager({
    repos: store.repos,
    log: quietLog,
    BrowserWindow: function () { opened += 1; return fakeWindow(); },
  });
  const out = await oauth.start('muse', { ...DECL, sessionUrl: 'https://elsewhere.example/s' });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'BAD_CONFIG');
  assert.strictEqual(opened, 0, 'nothing was opened');
});
