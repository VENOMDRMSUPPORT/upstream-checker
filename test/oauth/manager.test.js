// The manager main keeps: it opens the provider's page, waits for the
// approval, exchanges the token and stores the account.
//
// What the tests must pin:
//   1. the sign-in page opens in the user's browser, at the address the
//      provider gave (the one that carries the code)
//   2. a finished sign-in becomes a provider key: one row, the credential in
//      `cipher`, the access token in `oauth_cipher`, the account's public
//      facts beside them
//   3. a refused sign-in stores nothing and says why
//   4. a declaration main cannot use is refused before the browser opens
//   5. cancelling stops the wait
const test = require('node:test');
const assert = require('node:assert');
const { createOAuthManager } = require('../../src/oauth');
const { memoryStore, quietLog } = require('../helpers');

const BASE = 'https://api.meta.ai/v1';

const CONFIG = {
  kind: 'device',
  clientId: '1031625952748946',
  deviceEndpoint: 'https://auth.meta.com/oidc/device/authorization/',
  tokenEndpoint: 'https://auth.meta.com/oidc/device/token/',
  grantType: 'urn:ietf:params:oauth:grant-type:device_code',
  userAgent: 'muse-code/1.0.2',
  exchange: {
    url: 'https://api.meta.ai/muse-code/key',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer {access_token}' },
    body: { dca_token: '{access_token}' },
    pick: { secret: 'api_key' },
    meta: {
      email: 'user_email', name: 'user_full_name', tier: 'subs_tier_name',
      tierId: 'subs_tier_id', subsActive: 'is_subs_active', usage: 'subs_usage',
      baseUrl: 'base_url',
    },
  },
};

const json = (status, body) => ({ status, body: JSON.stringify(body), headers: {} });

// A fake HTTP client that answers in order. An object body is turned into
// JSON here, exactly as the real client does.
function fakeHttp(answers) {
  const calls = [];
  return {
    calls,
    async request(args) {
      const sent = args.body && typeof args.body === 'object' ? { ...args, body: JSON.stringify(args.body) } : args;
      calls.push(sent);
      const next = answers.shift();
      if (!next) return { status: 0, body: '', headers: {}, networkError: true, error: 'no answer left' };
      return typeof next === 'function' ? next(sent) : next;
    },
  };
}

// The wait between polls is a timer that fires on the next turn, so the test
// does not sit for the provider's interval.
function fastTimers() {
  const handles = new Set();
  return {
    setTimeoutFn: (fn, ms) => {
      const handle = { fn, ms, cancelled: false };
      handles.add(handle);
      setImmediate(() => { if (!handle.cancelled) fn(); });
      return handle;
    },
    clearTimeoutFn: (handle) => {
      if (!handle) return;
      handle.cancelled = true;
      handles.delete(handle);
    },
  };
}

async function setup(t, answers) {
  const store = await memoryStore(t);
  store.repos.providers.save({ id: 'muse', name: 'Muse AI', baseUrl: BASE, rpm: null, keys: [] });
  const opened = [];
  const http = fakeHttp(answers);
  const timers = fastTimers();
  const oauth = createOAuthManager({
    repos: store.repos,
    openExternal: async (url) => { opened.push(url); return true; },
    log: quietLog,
    http,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  return { store, oauth, opened, http };
}

// The flow, from the first poll to the stored account.
const DEVICE_ANSWER = json(200, {
  device_code: 'dev-1', user_code: 'ABCD-1234',
  verification_uri: 'https://auth.meta.com/oidc/device',
  verification_uri_complete: 'https://auth.meta.com/oidc/device?user_code=ABCD-1234',
  expires_in: 900, interval: 5,
});
const TOKEN_ANSWER = json(200, { access_token: 'dca:abc', expires_in: 3600 });
const EXCHANGE_ANSWER = json(200, {
  api_key: 'muse-key-1',
  base_url: BASE,
  user_email: 'person@example.com',
  user_full_name: 'A Person',
  subs_tier_name: 'Everyday Usage',
  is_subs_active: true,
  subs_usage: { window: { used_percent: 40 }, weekly: { used_percent: 5 } },
});

// Wait until the sign-in reaches a state, or give up.
async function until(oauth, providerId, wanted, tries = 50) {
  for (let i = 0; i < tries; i += 1) {
    const state = oauth.status(providerId);
    if (wanted.includes(state.state)) return state;
    await new Promise((r) => setImmediate(r));
  }
  return oauth.status(providerId);
}

test('the sign-in page opens in the browser, at the address that carries the code', async (t) => {
  const { oauth, opened } = await setup(t, [DEVICE_ANSWER, TOKEN_ANSWER, EXCHANGE_ANSWER]);
  const started = await oauth.start('muse', CONFIG);
  assert.strictEqual(started.ok, true);
  assert.strictEqual(started.userCode, 'ABCD-1234');
  assert.deepStrictEqual(opened, ['https://auth.meta.com/oidc/device?user_code=ABCD-1234']);
});

test('a finished sign-in becomes a provider key with the credential and the account', async (t) => {
  const { store, oauth } = await setup(t, [DEVICE_ANSWER, TOKEN_ANSWER, EXCHANGE_ANSWER]);
  await oauth.start('muse', CONFIG);
  const state = await until(oauth, 'muse', ['done']);
  assert.strictEqual(state.state, 'done');
  assert.strictEqual(state.account.email, 'person@example.com');
  assert.strictEqual(state.account.tier, 'Everyday Usage');

  const provider = store.repos.providers.get('muse');
  assert.strictEqual(provider.keys.length, 1);
  const key = provider.keys[0];
  assert.strictEqual(key.oauth, true);
  assert.ok(key.oauthKey.startsWith('venomoauth:'), 'the renderer gets a placeholder, never the token');
  assert.strictEqual(key.account.email, 'person@example.com');
  assert.strictEqual(key.account.tier, 'Everyday Usage');
  assert.strictEqual(key.account.usage.weekly.used_percent, 5);
  // The credential the API is called with, and the access token, are both
  // stored encrypted and never as plain text.
  assert.strictEqual(store.repos.providers.revealKey(key.id), 'muse-key-1');
  assert.strictEqual(store.repos.providers.revealOauth(key.id), 'dca:abc');
  const row = store.db.prepare('SELECT cipher, oauth_cipher FROM provider_keys WHERE id = ?').get(key.id);
  assert.ok(row.cipher.startsWith('enc:v1:'), 'the credential is in the envelope');
  assert.ok(row.oauth_cipher.startsWith('enc:v1:'), 'the access token is in the envelope');
  assert.ok(!String(row.oauth_cipher).includes('dca:abc'), 'the token is not stored in the clear');
});

test('the same account signed in twice replaces its row instead of adding a second one', async (t) => {
  const { store, oauth } = await setup(t, [
    DEVICE_ANSWER, TOKEN_ANSWER, EXCHANGE_ANSWER,
    DEVICE_ANSWER, TOKEN_ANSWER, EXCHANGE_ANSWER,
  ]);
  await oauth.start('muse', CONFIG);
  await until(oauth, 'muse', ['done']);
  await oauth.start('muse', CONFIG);
  await until(oauth, 'muse', ['done']);
  const provider = store.repos.providers.get('muse');
  assert.strictEqual(provider.keys.length, 1, 'one account, not two');
  assert.strictEqual(store.repos.providers.revealKey(provider.keys[0].id), 'muse-key-1');
});

test('a refused sign-in stores nothing and says why', async (t) => {
  const { store, oauth, opened } = await setup(t, [
    DEVICE_ANSWER,
    json(400, { error: 'access_denied', error_description: 'The person said no' }),
  ]);
  await oauth.start('muse', CONFIG);
  const state = await until(oauth, 'muse', ['failed']);
  assert.strictEqual(state.state, 'failed');
  assert.strictEqual(state.error.code, 'access_denied');
  assert.match(state.error.message, /said no/i);
  assert.strictEqual(store.repos.providers.get('muse').keys.length, 0, 'no half-connected account');
  assert.strictEqual(opened.length, 1);
});

test('a declaration main cannot use is refused before the browser opens', async (t) => {
  const { oauth, opened } = await setup(t, []);
  const bad = { ...CONFIG, exchange: { ...CONFIG.exchange, url: 'https://evil.example/key' } };
  const out = await oauth.start('muse', bad);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'BAD_CONFIG');
  assert.strictEqual(opened.length, 0, 'nothing was opened');
});

test('a provider that is not in the database is refused', async (t) => {
  const { oauth, opened } = await setup(t, []);
  const out = await oauth.start('nothing', CONFIG);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'UNKNOWN_PROVIDER');
  assert.strictEqual(opened.length, 0);
});

test('cancelling stops the wait', async (t) => {
  const { oauth } = await setup(t, [DEVICE_ANSWER]);
  await oauth.start('muse', CONFIG);
  const cancelled = oauth.cancel('muse');
  assert.strictEqual(cancelled.ok, true);
  assert.strictEqual(oauth.status('muse').state, 'cancelled');
});

test('a page that does not open is a failed sign-in, not a wait for ever', async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.save({ id: 'muse', name: 'Muse AI', baseUrl: BASE, rpm: null, keys: [] });
  const oauth = createOAuthManager({
    repos: store.repos,
    openExternal: async () => { throw new Error('Only http and https links open outside the app'); },
    log: quietLog,
    http: fakeHttp([DEVICE_ANSWER]),
  });
  const out = await oauth.start('muse', CONFIG);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'OPEN_FAILED');
  assert.strictEqual(oauth.status('muse').state, 'failed');
  assert.strictEqual(store.repos.providers.get('muse').keys.length, 0);
});

test('the state of a provider with no sign-in is idle', async (t) => {
  const { oauth } = await setup(t, []);
  assert.deepStrictEqual(oauth.status('muse'), { state: 'idle' });
});
