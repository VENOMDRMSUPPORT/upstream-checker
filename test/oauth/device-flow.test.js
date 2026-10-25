// The device authorization grant (RFC 8628) and the exchange that turns the
// access token into the credential the API is called with.
//
// What the tests must pin:
//   1. the declaration is checked before it is used — the endpoints must be
//      https, and the exchange address must be the provider's own origin,
//      because that is where the access token goes
//   2. the device code request asks for a code and reads it
//   3. a poll that finds nobody has approved yet says so, and is not a failure
//   4. the exchange sends the token in the header and in the body, and reads
//      the credential and the account's public facts
const test = require('node:test');
const assert = require('node:assert');
const flow = require('../../src/oauth/device-flow');

const BASE = 'https://api.meta.ai/v1';
const DEVICE = 'https://auth.meta.com/oidc/device/authorization/';
const TOKEN = 'https://auth.meta.com/oidc/device/token/';
const EXCHANGE = 'https://api.meta.ai/muse-code/key';

const CONFIG = {
  kind: 'device',
  clientId: '1031625952748946',
  deviceEndpoint: DEVICE,
  tokenEndpoint: TOKEN,
  grantType: flow.DEVICE_CODE_GRANT,
  userAgent: 'muse-code/1.0.2',
  exchange: {
    url: EXCHANGE,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-version': '1.0.0',
      Authorization: 'Bearer {access_token}',
    },
    body: { dca_token: '{access_token}' },
    pick: { secret: 'api_key' },
    meta: {
      email: 'user_email',
      name: 'user_full_name',
      tier: 'subs_tier_name',
      tierId: 'subs_tier_id',
      subsActive: 'is_subs_active',
      usage: 'subs_usage',
      baseUrl: 'base_url',
    },
  },
};

// A fake HTTP client: it answers in order and remembers what it was asked.
// An object body is turned into JSON here, exactly as the real client does —
// so the test reads what would really go on the wire.
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

const json = (status, body) => ({ status, body: JSON.stringify(body), headers: {} });

test('a declaration that is not a device flow is refused', () => {
  assert.throws(() => flow.normalise({ kind: 'redirect' }, { providerBaseUrl: BASE }), /device-code/i);
});

test('a non-https endpoint is refused', () => {
  const bad = { ...CONFIG, deviceEndpoint: 'http://auth.meta.com/oidc/device/authorization/' };
  assert.throws(() => flow.normalise(bad, { providerBaseUrl: BASE }), /device-authorization/i);
});

test('an exchange address on another origin is refused', () => {
  // The access token is about to be sent there, so it must be the provider's
  // own origin — the one the app already trusts for this provider's keys.
  const bad = { ...CONFIG, exchange: { ...CONFIG.exchange, url: 'https://evil.example/key' } };
  assert.throws(() => flow.normalise(bad, { providerBaseUrl: BASE }), /does not match/i);
});

test('the good declaration is accepted and completed with the defaults', () => {
  const cfg = flow.normalise(CONFIG, { providerBaseUrl: BASE });
  assert.strictEqual(cfg.kind, 'device');
  assert.strictEqual(cfg.clientId, '1031625952748946');
  assert.strictEqual(cfg.grantType, flow.DEVICE_CODE_GRANT);
  assert.strictEqual(cfg.exchange.secret, 'api_key');
  assert.strictEqual(cfg.exchange.meta.email, 'user_email');
  assert.strictEqual(cfg.exchange.meta.usage, 'subs_usage');
});

test('the device code request asks for a code and reads it', async () => {
  const http = fakeHttp([json(200, {
    device_code: 'dev-1', user_code: 'ABCD-1234',
    verification_uri: 'https://auth.meta.com/oidc/device',
    verification_uri_complete: 'https://auth.meta.com/oidc/device?user_code=ABCD-1234',
    expires_in: 900, interval: 5,
  })]);
  const cfg = flow.normalise(CONFIG, { providerBaseUrl: BASE });
  const out = await flow.startDeviceFlow({ http, config: cfg });
  assert.strictEqual(out.deviceCode, 'dev-1');
  assert.strictEqual(out.userCode, 'ABCD-1234');
  assert.strictEqual(out.verificationUriComplete, 'https://auth.meta.com/oidc/device?user_code=ABCD-1234');
  assert.strictEqual(out.expiresIn, 900);
  assert.strictEqual(out.interval, 5);
  const call = http.calls[0];
  assert.strictEqual(call.url, DEVICE);
  assert.match(call.body, /client_id=1031625952748946/);
  assert.strictEqual(call.headers['Content-Type'], 'application/x-www-form-urlencoded');
});

test('a device endpoint that refuses the request is a failure, not a silent empty', async () => {
  const http = fakeHttp([{ status: 400, body: '{"error":"invalid_client"}', headers: {} }]);
  const cfg = flow.normalise(CONFIG, { providerBaseUrl: BASE });
  await assert.rejects(() => flow.startDeviceFlow({ http, config: cfg }), /did not start the sign-in/i);
});

test('a poll that finds nobody has approved says pending, not failed', async () => {
  const http = fakeHttp([json(400, { error: 'authorization_pending' })]);
  const cfg = flow.normalise(CONFIG, { providerBaseUrl: BASE });
  const out = await flow.pollDeviceToken({ http, config: cfg, deviceCode: 'dev-1' });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'authorization_pending');
});

test('a poll that reaches the token answers with it', async () => {
  const http = fakeHttp([json(200, { access_token: 'dca:abc', token_type: 'Bearer', expires_in: 3600 })]);
  const cfg = flow.normalise(CONFIG, { providerBaseUrl: BASE });
  const out = await flow.pollDeviceToken({ http, config: cfg, deviceCode: 'dev-1' });
  assert.deepStrictEqual(out, { ok: true, accessToken: 'dca:abc', expiresIn: 3600 });
  const call = http.calls[0];
  assert.strictEqual(call.url, TOKEN);
  assert.match(call.body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code/);
  assert.match(call.body, /device_code=dev-1/);
});

test('a refused sign-in is reported with its reason', async () => {
  const http = fakeHttp([json(400, { error: 'access_denied', error_description: 'The person said no' })]);
  const cfg = flow.normalise(CONFIG, { providerBaseUrl: BASE });
  const out = await flow.pollDeviceToken({ http, config: cfg, deviceCode: 'dev-1' });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'access_denied');
  assert.strictEqual(out.description, 'The person said no');
});

test('a dropped poll is a wait, not an answer', async () => {
  const http = fakeHttp([{ status: 0, body: '', headers: {}, networkError: true, error: 'offline' }]);
  const cfg = flow.normalise(CONFIG, { providerBaseUrl: BASE });
  const out = await flow.pollDeviceToken({ http, config: cfg, deviceCode: 'dev-1' });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'network');
});

test('the exchange sends the token in the header and in the body, and reads the account', async () => {
  const http = fakeHttp([json(200, {
    api_key: 'muse-key-1',
    base_url: 'https://api.meta.ai/v1',
    user_email: 'person@example.com',
    user_full_name: 'A Person',
    subs_tier_name: 'Everyday Usage',
    subs_tier_id: 'everyday',
    is_subs_active: true,
    subs_usage: { window: { used_percent: 40, resets_at: 1790000000 }, weekly: { used_percent: 5 } },
  })]);
  const cfg = flow.normalise(CONFIG, { providerBaseUrl: BASE });
  const out = await flow.exchange({ http, config: cfg, accessToken: 'dca:abc' });
  assert.strictEqual(out.error, undefined);
  assert.strictEqual(out.secret, 'muse-key-1');
  assert.strictEqual(out.account.email, 'person@example.com');
  assert.strictEqual(out.account.name, 'A Person');
  assert.strictEqual(out.account.tier, 'Everyday Usage');
  assert.strictEqual(out.account.subsActive, true);
  assert.strictEqual(out.account.baseUrl, 'https://api.meta.ai/v1');
  assert.strictEqual(out.account.usage.weekly.used_percent, 5);
  const call = http.calls[0];
  assert.strictEqual(call.url, EXCHANGE);
  assert.strictEqual(call.headers.Authorization, 'Bearer dca:abc');
  assert.deepStrictEqual(JSON.parse(call.body), { dca_token: 'dca:abc' });
});

test('an exchange answer without a credential is refused', async () => {
  const http = fakeHttp([json(200, { user_email: 'person@example.com' })]);
  const cfg = flow.normalise(CONFIG, { providerBaseUrl: BASE });
  const out = await flow.exchange({ http, config: cfg, accessToken: 'dca:abc' });
  assert.match(out.error, /did not return a credential/i);
});
