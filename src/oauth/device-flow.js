// ============================================
// OAuth — the device authorization grant (RFC 8628)
// ============================================
// The flow a provider uses when the user signs in on a web page: main asks the
// provider for a device code, opens the verification page in the user's
// browser, and polls until the person approves. There is no redirect and no
// local callback listener, which is why the device grant fits a desktop app
// better than an authorization-code flow.
//
// The provider module declares the whole flow as plain data (meta.oauth), and
// that declaration is what crosses into main. Main checks every field it is
// about to use before it uses it — the endpoints must be https, and the
// exchange endpoint must live on the same origin as the provider's own base
// URL, because that is where the access token is about to be sent.
//
// The access token never leaves main: it is exchanged for the credential the
// API uses, and only the encrypted credential and the account's public facts
// are stored.
const { readJson, form } = require('./http');

// The grant type RFC 8628 defines, and what the provider may override.
const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

// How often the provider asks to be polled when it does not say.
const DEFAULT_INTERVAL_SECONDS = 5;
// How long the device code stays usable when the provider does not say.
const DEFAULT_EXPIRES_SECONDS = 600;

// The answers the token endpoint gives while nobody has approved yet.
const PENDING_ERRORS = new Set(['authorization_pending', 'slow_down']);

function originOf(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch (_) {
    return null;
  }
}

function isHttps(url) {
  try {
    return new URL(String(url)).protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function text(value, max = 200) {
  return typeof value === 'string' && value.length <= max ? value : null;
}

// The provider's declaration, checked. Throws with a plain reason: the
// renderer shows it and nothing else happens.
function normalise(raw, { providerBaseUrl } = {}) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  if (cfg.kind !== 'device') throw new Error('This provider does not offer a device-code sign-in');
  const clientId = text(cfg.clientId, 200);
  if (!clientId) throw new Error('The provider did not declare a client id');
  if (!isHttps(cfg.deviceEndpoint)) throw new Error('The provider did not declare a valid device-authorization address');
  if (!isHttps(cfg.tokenEndpoint)) throw new Error('The provider did not declare a valid token address');

  const exchange = cfg.exchange && typeof cfg.exchange === 'object' ? cfg.exchange : {};
  if (!isHttps(exchange.url)) throw new Error('The provider did not declare a valid exchange address');
  // The access token is sent to the exchange endpoint, so it must be the
  // provider's own origin — the one the app already trusts for this provider's
  // keys. A declaration that points anywhere else is refused.
  const base = originOf(providerBaseUrl);
  if (base && originOf(exchange.url) !== base) {
    throw new Error('The sign-in address does not match this provider\'s API address — check the provider\'s base URL');
  }

  const headers = {};
  Object.entries(exchange.headers || {}).forEach(([name, value]) => {
    if (typeof value === 'string') headers[name] = value;
  });
  const body = {};
  Object.entries(exchange.body || {}).forEach(([name, value]) => {
    if (typeof value === 'string') body[name] = value;
  });

  const pick = exchange.pick && typeof exchange.pick === 'object' ? exchange.pick : {};
  const meta = exchange.meta && typeof exchange.meta === 'object' ? exchange.meta : {};

  return {
    kind: 'device',
    clientId,
    deviceEndpoint: String(cfg.deviceEndpoint),
    tokenEndpoint: String(cfg.tokenEndpoint),
    grantType: text(cfg.grantType, 200) || DEVICE_CODE_GRANT,
    scope: text(cfg.scope, 400) || '',
    userAgent: text(cfg.userAgent, 200) || 'venom-router/1.0',
    exchange: {
      url: String(exchange.url),
      method: text(exchange.method, 10) || 'POST',
      headers,
      body,
      // Which field of the answer is the credential the API uses.
      secret: text(pick.secret, 100) || 'api_key',
      // Which fields carry the account's public facts.
      meta: {
        email: text(meta.email, 200) || 'user_email',
        name: text(meta.name, 200) || 'user_full_name',
        tier: text(meta.tier, 100) || 'subs_tier_name',
        tierId: text(meta.tierId, 100) || 'subs_tier_id',
        subsActive: text(meta.subsActive, 100) || 'is_subs_active',
        usage: text(meta.usage, 100) || 'subs_usage',
        baseUrl: text(meta.baseUrl, 300) || 'base_url',
      },
    },
  };
}

// The device code request. { deviceCode, userCode, verificationUri,
// verificationUriComplete, expiresIn, interval }.
async function startDeviceFlow({ http, config } = {}) {
  const body = form({ client_id: config.clientId, scope: config.scope });
  const res = await http.request({
    url: config.deviceEndpoint,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': config.userAgent,
    },
    body,
    timeoutMs: 30000,
  });
  if (!res || res.status < 200 || res.status >= 300) {
    const detail = res && res.networkError ? res.error : `HTTP ${res && res.status}`;
    throw new Error(`The provider did not start the sign-in (${detail})`);
  }
  const data = readJson(res);
  const deviceCode = data && text(data.device_code, 400);
  const userCode = data && text(data.user_code, 100);
  const verificationUri = data && text(data.verification_uri, 600);
  if (!deviceCode || !verificationUri) {
    throw new Error('The provider did not answer with a sign-in code');
  }
  const interval = Number(data.interval) > 0 ? Number(data.interval) : DEFAULT_INTERVAL_SECONDS;
  const expiresIn = Number(data.expires_in) > 0 ? Number(data.expires_in) : DEFAULT_EXPIRES_SECONDS;
  return {
    deviceCode,
    userCode: userCode || '',
    verificationUri,
    verificationUriComplete: text(data.verification_uri_complete, 600) || verificationUri,
    expiresIn,
    interval,
  };
}

// One poll of the token endpoint.
// { ok: true, accessToken, expiresIn } | { ok: false, error, description }
// where error is 'authorization_pending' while nobody has approved yet.
async function pollDeviceToken({ http, config, deviceCode } = {}) {
  const body = form({
    grant_type: config.grantType,
    device_code: deviceCode,
    client_id: config.clientId,
  });
  const res = await http.request({
    url: config.tokenEndpoint,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': config.userAgent,
    },
    body,
    timeoutMs: 30000,
  });
  if (!res || res.networkError) {
    // A dropped poll is not an answer: the caller waits and tries again.
    return { ok: false, error: 'network', description: (res && res.error) || 'The provider could not be reached' };
  }
  const data = readJson(res);
  if (res.status >= 200 && res.status < 300) {
    const accessToken = data && text(data.access_token, 2000);
    if (!accessToken) return { ok: false, error: 'invalid_response', description: 'The provider answered without a token' };
    const expiresIn = Number(data.expires_in) > 0 ? Number(data.expires_in) : 0;
    return { ok: true, accessToken, expiresIn };
  }
  const code = data && text(data.error, 100);
  const description = (data && text(data.error_description, 400)) || `HTTP ${res.status}`;
  if (code && PENDING_ERRORS.has(code)) return { ok: false, error: code, description };
  return { ok: false, error: code || 'error', description };
}

// The exchange: the access token becomes the credential the API uses, plus
// the account's public facts. { secret, account } or { error }.
async function exchange({ http, config, accessToken } = {}) {
  const headers = {};
  Object.entries(config.exchange.headers).forEach(([name, value]) => {
    headers[name] = value.split('{access_token}').join(accessToken);
  });
  const body = {};
  Object.entries(config.exchange.body).forEach(([name, value]) => {
    body[name] = value.split('{access_token}').join(accessToken);
  });
  const res = await http.request({
    url: config.exchange.url,
    method: config.exchange.method,
    headers,
    body: Object.keys(body).length ? body : '',
    timeoutMs: 30000,
  });
  if (!res || res.networkError) return { error: (res && res.error) || 'The provider could not be reached' };
  if (res.status < 200 || res.status >= 300) {
    return { error: `The provider refused the sign-in (HTTP ${res.status})` };
  }
  const data = readJson(res);
  if (!data) return { error: 'The provider answered with something this app cannot read' };
  const fields = config.exchange.meta;
  const secret = text(data[config.exchange.secret], 4000);
  if (!secret) return { error: 'The provider did not return a credential for this account' };
  const account = {
    email: text(data[fields.email], 200) || '',
    name: text(data[fields.name], 200) || '',
    tier: text(data[fields.tier], 100) || '',
    tierId: text(data[fields.tierId], 100) || '',
    subsActive: data[fields.subsActive] === true,
    baseUrl: text(data[fields.baseUrl], 300) || '',
    usage: data[fields.usage] && typeof data[fields.usage] === 'object' ? data[fields.usage] : null,
  };
  return { secret, account };
}

module.exports = {
  normalise,
  startDeviceFlow,
  pollDeviceToken,
  exchange,
  originOf,
  DEVICE_CODE_GRANT,
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_EXPIRES_SECONDS,
};
