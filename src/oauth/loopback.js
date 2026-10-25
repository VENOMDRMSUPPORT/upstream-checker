// ============================================
// OAuth — the loopback authorization-code grant
// ============================================
// A desktop app that signs in on a web page and comes back to itself: the
// browser is opened on the provider's consent page, the provider sends the
// answer back to a short-lived address on this machine, and the app exchanges
// the code for the tokens.
//
// The browser is the person's own — the default one — so the sign-in looks
// like every other Google sign-in they have ever done. The page that comes
// back is served by the app: it says what happened and closes itself, and the
// app carries on without the person touching anything.
//
// The loopback address lives on 127.0.0.1 only, on a port the operating
// system picks, and it lives for exactly one sign-in. The state parameter is
// what ties the answer to the sign-in that asked for it: an answer with
// another state — or no state — is refused before any code is exchanged.
//
// The profile (src/oauth/profiles.js) says which pages this is. Nothing here
// knows any provider by name.
const http = require('http');
const crypto = require('crypto');
const { readJson, form } = require('./http');

// Where the provider sends the answer back to.
const CALLBACK_PATH = '/auth/callback';
// How long a sign-in may take before the app stops waiting for it.
const DEFAULT_WAIT_MS = 10 * 60 * 1000;

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

// Where a secret may travel: over TLS, or across the loopback interface —
// that is this machine, and it is where the app's own short-lived address
// lives. A profile that names anything else is refused.
function isSafeEndpoint(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol === 'https:') return true;
    if (u.protocol !== 'http:') return false;
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname);
  } catch (_) {
    return false;
  }
}

function text(value, max = 400) {
  return typeof value === 'string' && value.length <= max ? value : null;
}

// The profile, checked. Throws with a plain reason: the renderer shows it and
// nothing else happens.
function normalise(raw, { profile } = {}) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  if (cfg.kind !== 'loopback') throw new Error('This provider does not offer a browser sign-in');
  if (!profile) throw new Error('The app does not ship a sign-in for this provider');
  const clientId = text(profile.clientId, 200);
  if (!clientId) throw new Error('The sign-in profile has no client id');
  if (!isSafeEndpoint(profile.authorizationEndpoint)) throw new Error('The sign-in profile has no valid consent address');
  if (!isSafeEndpoint(profile.tokenEndpoint)) throw new Error('The sign-in profile has no valid token address');
  const scopes = Array.isArray(profile.scopes)
    ? profile.scopes.filter((s) => typeof s === 'string' && s.length > 0 && s.length <= 300)
    : [];
  if (!scopes.length) throw new Error('The sign-in profile asks for nothing');
  const params = {};
  Object.entries(profile.params || {}).forEach(([name, value]) => {
    if (typeof value === 'string' && value.length <= 400) params[name] = value;
  });
  // The origins the credential may be used against: over TLS, or across the
  // loopback interface — that is this machine.
  const apiOrigins = Array.isArray(profile.apiOrigins)
    ? profile.apiOrigins.filter((o) => isSafeEndpoint(o)).map((o) => originOf(o)).filter(Boolean)
    : [];
  return {
    kind: 'loopback',
    profileId: profile.id,
    label: text(profile.label, 100) || 'this provider',
    clientId,
    clientSecret: text(profile.clientSecret, 300) || '',
    authorizationEndpoint: String(profile.authorizationEndpoint),
    tokenEndpoint: String(profile.tokenEndpoint),
    scopes,
    params,
    apiOrigins,
    account: profile.account && typeof profile.account === 'object' ? profile.account : {},
    project: profile.project && typeof profile.project === 'object' ? profile.project : {},
  };
}

// The consent page: everything the provider needs to send the answer back to
// this app, and nothing more.
function buildAuthUrl(config, { state, redirectUri } = {}) {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: String(redirectUri || ''),
    response_type: 'code',
    scope: config.scopes.join(' '),
    state: String(state || ''),
  });
  Object.entries(config.params || {}).forEach(([name, value]) => params.set(name, value));
  return `${config.authorizationEndpoint}?${params.toString()}`;
}

// The code becomes the tokens. { accessToken, refreshToken, expiresIn,
// idToken, scope } or { error }.
async function exchangeCode({ http: client, config, code, redirectUri } = {}) {
  const body = form({
    code: String(code || ''),
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: String(redirectUri || ''),
    grant_type: 'authorization_code',
  });
  const res = await client.request({
    url: config.tokenEndpoint,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    timeoutMs: 30000,
  });
  if (!res || res.networkError) return { error: (res && res.error) || 'The provider could not be reached' };
  const data = readJson(res);
  if (res.status < 200 || res.status >= 300) {
    const detail = (data && (data.error_description || data.error)) || `HTTP ${res.status}`;
    return { error: `The provider refused the sign-in (${detail})` };
  }
  if (!data) return { error: 'The provider answered with something this app cannot read' };
  const accessToken = text(data.access_token, 4000);
  if (!accessToken) return { error: 'The provider answered without a token' };
  return {
    accessToken,
    // A provider that does not send a refresh token on a renewal keeps the
    // one it already has; only a new one replaces it.
    refreshToken: text(data.refresh_token, 4000) || '',
    expiresIn: Number(data.expires_in) > 0 ? Number(data.expires_in) : 0,
    idToken: text(data.id_token, 8000) || '',
    scope: text(data.scope, 800) || '',
  };
}

// The renewal: a refresh token becomes a new access token. { accessToken,
// refreshToken, expiresIn } or { error }.
async function refreshAccessToken({ http: client, config, refreshToken } = {}) {
  const token = text(refreshToken, 4000);
  if (!token) return { error: 'This account has no renewal token' };
  const body = form({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: token,
  });
  const res = await client.request({
    url: config.tokenEndpoint,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    timeoutMs: 30000,
  });
  if (!res || res.networkError) return { error: (res && res.error) || 'The provider could not be reached' };
  const data = readJson(res);
  if (res.status < 200 || res.status >= 300) {
    const detail = (data && (data.error_description || data.error)) || `HTTP ${res.status}`;
    return { error: `The provider refused the renewal (${detail})` };
  }
  const accessToken = text(data.access_token, 4000);
  if (!accessToken) return { error: 'The provider answered without a token' };
  return {
    accessToken,
    refreshToken: text(data.refresh_token, 4000) || token,
    expiresIn: Number(data.expires_in) > 0 ? Number(data.expires_in) : 0,
  };
}

// The id_token is a JWT: three parts, the middle one the claims. It is read
// for the account's name only, and it came straight back from the token
// endpoint over TLS, so nothing here trusts a signature it cannot check —
// the claims are a label on screen, never a permission.
function readIdTokenClaims(idToken) {
  const raw = String(idToken || '');
  const parts = raw.split('.');
  if (parts.length < 2) return {};
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (_) {
    return {};
  }
  return payload && typeof payload === 'object' ? payload : {};
}

// The account's public facts, as the profile names them.
function accountFromTokens(config, tokens) {
  const claims = config.account && config.account.fromIdToken ? readIdTokenClaims(tokens.idToken) : {};
  const fields = config.account || {};
  const email = text(claims[fields.email || 'email'], 200) || '';
  const name = text(claims[fields.name || 'name'], 200) || '';
  return { email, name, claims };
}

// A random, unguessable value that ties an answer to the sign-in that asked
// for it.
function newState() {
  return crypto.randomBytes(24).toString('base64url');
}

const PAGE_STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0f1115; color: #e6e8ee;
    font: 15px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif;
  }
  .card { text-align: center; padding: 40px 32px; max-width: 460px; }
  .mark {
    width: 64px; height: 64px; margin: 0 auto 20px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 32px; font-weight: 700;
    background: rgba(64, 200, 120, .14); color: #46d183; border: 1px solid rgba(64, 200, 120, .35);
  }
  .mark.bad { background: rgba(230, 90, 90, .14); color: #ef7d7d; border-color: rgba(230, 90, 90, .35); }
  h1 { font-size: 19px; font-weight: 600; margin: 0 0 8px; }
  p { margin: 0; color: #9aa3b2; font-size: 14px; }
  .hint { margin-top: 18px; font-size: 12px; color: #6b7484; }
`;

// The page the browser comes back to. It says what happened and closes
// itself: the tab was opened for this one job, and the app is already
// carrying on. A browser that refuses to let a page close its own tab shows
// the last line instead, so the person is never left guessing.
function successPage(label) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Signed in — VENOM Router</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><style>${PAGE_STYLE}</style></head>
<body>
  <main class="card">
    <div class="mark">&#10003;</div>
    <h1>Signed in to ${escapeHtml(label)}</h1>
    <p>VENOM Router has the account. This tab closes itself.</p>
    <p class="hint">If it stays open, you can close it — the app is already connected.</p>
  </main>
  <script>
    (function () {
      var done = false;
      function close() {
        if (done) return;
        done = true;
        try { window.close(); } catch (e) {}
      }
      // Some browsers only let a page close a window it opened itself.
      try { var w = window.open('', '_self'); if (w && !w.closed) w.close(); } catch (e) {}
      setTimeout(close, 120);
      setTimeout(close, 600);
      setTimeout(close, 1500);
    })();
  </script>
</body></html>`;
}

function failurePage(message) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign-in failed — VENOM Router</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><style>${PAGE_STYLE}</style></head>
<body>
  <main class="card">
    <div class="mark bad">&#33;</div>
    <h1>The sign-in did not finish</h1>
    <p>${escapeHtml(message || 'The provider did not approve the sign-in.')}</p>
    <p class="hint">Close this tab and try again from the app.</p>
  </main>
</body></html>`;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// The short-lived address the answer comes back to. It listens on the
// loopback interface only, on a port the operating system picks, and it
// answers exactly one route.
function createCallbackServer({ handle, log = console } = {}) {
  let closed = false;
  const server = http.createServer((req, res) => {
    const done = (status, html) => {
      try {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
      } catch (_) {
        // The person closed the tab; nothing to say.
      }
    };
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch (_) {
      done(400, failurePage('The address was not understood.'));
      return;
    }
    if (url.pathname !== CALLBACK_PATH) {
      done(404, failurePage('This address does nothing.'));
      return;
    }
    const query = Object.fromEntries(url.searchParams.entries());
    Promise.resolve()
      .then(() => handle(query))
      .then((answer) => {
        const ok = answer && answer.ok !== false;
        done(ok ? 200 : 400, ok ? successPage(answer.label) : failurePage(answer && answer.message));
      })
      .catch((err) => {
        log.warn('OAuth: the sign-in callback failed:', err && err.message);
        done(400, failurePage('The sign-in could not be completed.'));
      });
  });

  return {
    // The address the provider sends the answer to. It is only known after
    // the server is listening, because the port is the operating system's.
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        // 127.0.0.1 only: this address exists for one sign-in and must not be
        // reachable from the network.
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      const port = server.address().port;
      return {
        port,
        redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
        origin: `http://127.0.0.1:${port}`,
      };
    },
    close() {
      if (closed) return;
      closed = true;
      try { server.closeAllConnections(); } catch (_) { /* older runtimes */ }
      try { server.close(); } catch (_) { /* already closing */ }
    },
  };
}

module.exports = {
  normalise,
  buildAuthUrl,
  exchangeCode,
  refreshAccessToken,
  readIdTokenClaims,
  accountFromTokens,
  newState,
  createCallbackServer,
  CALLBACK_PATH,
  DEFAULT_WAIT_MS,
};
