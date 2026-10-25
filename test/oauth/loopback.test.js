// The loopback grant: the browser signs in, the answer comes back to a
// short-lived address on this machine, and the app takes the tokens.
//
// What the tests must pin:
//   1. the profile is checked before anything is opened: a declaration main
//      cannot use is refused
//   2. the consent page carries everything the provider needs to send the
//      answer back — and the state's own answers
//   3. the code becomes tokens, and a refusal says why
//   4. the renewal keeps the account working, and keeps the renewal token
//      when the provider does not send a new one
//   5. the account's own facts come from the id_token
//   6. the callback address answers only the sign-in that asked for it: an
//      answer with another state is refused before any code is exchanged
//   7. a finished sign-in becomes a provider key: one row, the credential in
//      `cipher`, the renewal token in `oauth_cipher`, the account's facts
//      beside them — and the account is renewed later without a sign-in
const test = require('node:test');
const assert = require('node:assert');
const { createOAuthManager } = require('../../src/oauth');
const loopback = require('../../src/oauth/loopback');
const { getProfile } = require('../../src/oauth/profiles');
const { memoryStore, quietLog } = require('../helpers');

const BASE = 'https://daily-cloudcode-pa.googleapis.com';

const PROFILE = {
  id: 'antigravity',
  label: 'Antigravity',
  clientId: 'client-1',
  clientSecret: 'secret-1',
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  scopes: ['openid', 'email', 'https://www.googleapis.com/auth/cloud-platform'],
  params: { access_type: 'offline', prompt: 'consent select_account' },
  apiOrigins: [BASE],
  account: { fromIdToken: true, email: 'email', name: 'name' },
  project: { default: 'aicode-consumers' },
};

const json = (status, body) => ({ status, body: JSON.stringify(body), headers: {} });

function fakeHttp(answers) {
  const calls = [];
  return {
    calls,
    async request(args) {
      calls.push(args);
      const next = answers.shift();
      if (!next) return { status: 0, body: '', headers: {}, networkError: true, error: 'no answer left' };
      return typeof next === 'function' ? next(args) : next;
    },
  };
}

// An id_token with the claims the profile reads.
function idToken(claims) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part(claims)}.signature`;
}

test('a declaration main cannot use is refused before anything opens', () => {
  assert.throws(() => loopback.normalise({ kind: 'device' }, { profile: PROFILE }), /browser sign-in/);
  assert.throws(() => loopback.normalise({ kind: 'loopback' }, { profile: null }), /does not ship a sign-in/);
  assert.throws(
    () => loopback.normalise({ kind: 'loopback' }, { profile: { ...PROFILE, tokenEndpoint: 'http://oauth2.example.com/token' } }),
    /valid token address/,
  );
  assert.throws(
    () => loopback.normalise({ kind: 'loopback' }, { profile: { ...PROFILE, scopes: [] } }),
    /asks for nothing/,
  );
});

test('the profile is normalised into what the grant needs', () => {
  const config = loopback.normalise({ kind: 'loopback', profile: 'antigravity' }, { profile: PROFILE });
  assert.strictEqual(config.kind, 'loopback');
  assert.strictEqual(config.clientId, 'client-1');
  assert.deepStrictEqual(config.apiOrigins, [BASE]);
  assert.strictEqual(config.project.default, 'aicode-consumers');
});

test('the app ships a profile for Antigravity, and it names Google', () => {
  const profile = getProfile('antigravity');
  assert.ok(profile, 'no Antigravity profile');
  assert.strictEqual(profile.authorizationEndpoint, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.strictEqual(profile.tokenEndpoint, 'https://oauth2.googleapis.com/token');
  assert.ok(profile.scopes.includes('openid'));
  assert.ok(profile.apiOrigins.includes(BASE));
  // The grant is an offline one: the account has to survive the token dying.
  assert.strictEqual(profile.params.access_type, 'offline');
});

test('the consent page carries everything the provider needs to answer', () => {
  const config = loopback.normalise({ kind: 'loopback' }, { profile: PROFILE });
  const url = new URL(loopback.buildAuthUrl(config, { state: 'st-1', redirectUri: 'http://127.0.0.1:5000/auth/callback' }));
  assert.strictEqual(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.strictEqual(url.searchParams.get('client_id'), 'client-1');
  assert.strictEqual(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:5000/auth/callback');
  assert.strictEqual(url.searchParams.get('response_type'), 'code');
  assert.strictEqual(url.searchParams.get('state'), 'st-1');
  assert.strictEqual(url.searchParams.get('access_type'), 'offline');
  assert.ok(url.searchParams.get('scope').includes('email'));
});

test('the code becomes tokens, and a refusal says why', async () => {
  const config = loopback.normalise({ kind: 'loopback' }, { profile: PROFILE });
  const http = fakeHttp([json(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 })]);
  const answer = await loopback.exchangeCode({ http, config, code: 'code-1', redirectUri: 'http://127.0.0.1:5000/auth/callback' });
  assert.strictEqual(answer.accessToken, 'at-1');
  assert.strictEqual(answer.refreshToken, 'rt-1');
  assert.strictEqual(answer.expiresIn, 3600);
  const sent = http.calls[0].body;
  assert.ok(sent.includes('code=code-1'));
  assert.ok(sent.includes('grant_type=authorization_code'));
  assert.ok(sent.includes('redirect_uri='));

  const refused = await loopback.exchangeCode({
    http: fakeHttp([json(400, { error: 'invalid_grant', error_description: 'bad code' })]),
    config, code: 'x', redirectUri: 'http://127.0.0.1:5000/auth/callback',
  });
  assert.match(refused.error, /bad code/);
});

test('the renewal keeps the renewal token when the provider sends none', async () => {
  const config = loopback.normalise({ kind: 'loopback' }, { profile: PROFILE });
  const http = fakeHttp([json(200, { access_token: 'at-2', expires_in: 3600 })]);
  const answer = await loopback.refreshAccessToken({ http, config, refreshToken: 'rt-1' });
  assert.strictEqual(answer.accessToken, 'at-2');
  assert.strictEqual(answer.refreshToken, 'rt-1');
  assert.ok(http.calls[0].body.includes('grant_type=refresh_token'));
});

test('the account facts come from the id_token', () => {
  const config = loopback.normalise({ kind: 'loopback' }, { profile: PROFILE });
  const account = loopback.accountFromTokens(config, {
    idToken: idToken({ email: 'person@example.com', name: 'A Person' }),
  });
  assert.strictEqual(account.email, 'person@example.com');
  assert.strictEqual(account.name, 'A Person');
});

test('the callback address answers only the sign-in that asked for it', async () => {
  const seen = [];
  const server = loopback.createCallbackServer({
    handle: (query) => {
      seen.push(query);
      if (query.state !== 'mine') return { ok: false, message: 'This sign-in did not come from VENOM Router.' };
      return { ok: true, label: 'Antigravity' };
    },
  });
  const address = await server.listen();
  try {
    // The address lives on the loopback interface only.
    assert.match(address.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    const wrong = await fetch(`${address.redirectUri}?code=abc&state=other`);
    assert.strictEqual(wrong.status, 400);
    assert.match(await wrong.text(), /did not come from VENOM Router/);

    const right = await fetch(`${address.redirectUri}?code=abc&state=mine`);
    assert.strictEqual(right.status, 200);
    const page = await right.text();
    assert.match(page, /Signed in to Antigravity/);
    // The page closes itself: that is the whole point of it.
    assert.match(page, /window\.close\(\)/);
    assert.deepStrictEqual(seen.map((q) => q.code), ['abc', 'abc']);
  } finally {
    server.close();
  }
});

test('a signed-in account becomes a key, and the app renews it later', async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.save({ id: 'antigravity', name: 'Antigravity', baseUrl: BASE, rpm: null, keys: [] });
  const opened = [];
  const http = fakeHttp([
    json(200, {
      access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600,
      id_token: idToken({ email: 'person@example.com', name: 'A Person' }),
    }),
    // The account is asked about itself: which project it is on, and which
    // plan it holds.
    json(200, {
      cloudaicompanionProject: 'projects/mock-1',
      currentTier: { id: 'free-tier', name: 'Free' },
      paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
    }),
    json(200, { access_token: 'at-2', expires_in: 3600 }),
  ]);
  const oauth = createOAuthManager({
    repos: store.repos,
    openExternal: async (url) => { opened.push(url); return true; },
    log: quietLog,
    http,
  });

  try {
    const started = await oauth.start('antigravity', { kind: 'loopback', profile: 'antigravity' });
    assert.strictEqual(started.ok, true);
    assert.strictEqual(opened.length, 1);
    const consent = new URL(opened[0]);
    assert.strictEqual(consent.searchParams.get('state') != null, true);

    // The provider sends the answer back to the address the consent page named.
    const redirect = new URL(consent.searchParams.get('redirect_uri'));
    const answer = await fetch(`${redirect.origin}${redirect.pathname}?code=code-1&state=${consent.searchParams.get('state')}`);
    assert.strictEqual(answer.status, 200);

    const state = oauth.status('antigravity');
    assert.strictEqual(state.state, 'done');
    assert.strictEqual(state.account.email, 'person@example.com');

    const provider = store.repos.providers.get('antigravity');
    assert.strictEqual(provider.keys.length, 1);
    const key = provider.keys[0];
    assert.strictEqual(key.name, 'person@example.com');
    // The credential the API is called with, and the renewal token beside it.
    assert.strictEqual(store.repos.providers.revealKey(key.id), 'at-1');
    assert.strictEqual(store.repos.providers.revealOauth(key.id), 'rt-1');
    assert.strictEqual(key.account.email, 'person@example.com');
    assert.strictEqual(key.account.refreshable, true);
    // The plan the account is on is the badge on the account row.
    assert.strictEqual(key.account.tier, 'Pro');
    assert.strictEqual(key.account.tierId, 'PRO');
    assert.strictEqual(key.account.plan, 'Google AI Pro');
    // The project the account's requests are billed to.
    assert.strictEqual(key.account.project, 'projects/mock-1');
    assert.ok(key.account.accessExpiresAt > 0);

    // The renewal: the access token is replaced and the row keeps its name,
    // its place and whether it is on.
    const renewed = await oauth.renew('antigravity', key.id);
    assert.strictEqual(renewed.ok, true, JSON.stringify(renewed));
    assert.strictEqual(store.repos.providers.revealKey(key.id), 'at-2');
    // The provider did not send a new renewal token, so the one the account
    // already has is kept.
    assert.strictEqual(store.repos.providers.revealOauth(key.id), 'rt-1');
  } finally {
    // The sign-in opened an address on this machine; it gives it back even
    // when the test fails, so the runner never waits on it.
    oauth.stopAll();
  }
});

test('the renewal is refused for an account that cannot be renewed', async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.save({ id: 'antigravity', name: 'Antigravity', baseUrl: BASE, rpm: null, keys: [] });
  const oauth = createOAuthManager({ repos: store.repos, openExternal: async () => true, log: quietLog, http: fakeHttp([]) });
  const answer = await oauth.renew('antigravity', 'nope');
  assert.strictEqual(answer.ok, false);
  assert.match(answer.message, /not in the database/);
  oauth.stopAll();
});

test('a provider whose address is not the provider\'s own is refused', async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.save({ id: 'antigravity', name: 'Antigravity', baseUrl: 'https://evil.example.com', rpm: null, keys: [] });
  const opened = [];
  const oauth = createOAuthManager({
    repos: store.repos,
    openExternal: async (url) => { opened.push(url); return true; },
    log: quietLog,
    http: fakeHttp([]),
  });
  const started = await oauth.start('antigravity', { kind: 'loopback', profile: 'antigravity' });
  assert.strictEqual(started.ok, false);
  assert.strictEqual(started.code, 'WRONG_ORIGIN');
  assert.strictEqual(opened.length, 0);
  oauth.stopAll();
});
