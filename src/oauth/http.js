// ============================================
// OAuth plane — its own HTTP client
// ============================================
// The OAuth requests carry the account's own credentials: the device code on
// the way to the token endpoint, the access token on the way to the exchange
// endpoint. They must not travel through src/api-request.js — that path
// records every request in the request log, and a body holding a real token
// would be stored as it is. The log scrubs the placeholders the renderer
// sends, never the secrets main holds.
//
// So this client is small on purpose: one request, the whole body read, one
// resolve. It never throws, never logs a body and never retries — the caller
// decides what a failure means.
const https = require('https');
const http = require('http');

// { status, body, headers } or { status: 0, networkError: true, error }.
function request({ url, method = 'GET', headers = {}, body = '', timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    let urlObj;
    try {
      urlObj = new URL(String(url));
    } catch (_) {
      resolve({ status: 0, body: '', headers: {}, networkError: true, error: 'The address is not a valid URL' });
      return;
    }
    if (urlObj.protocol !== 'https:' && urlObj.protocol !== 'http:') {
      resolve({ status: 0, body: '', headers: {}, networkError: true, error: 'Only http and https are allowed' });
      return;
    }
    const isHttps = urlObj.protocol === 'https:';
    const payload = typeof body === 'string' ? body : (body == null ? '' : JSON.stringify(body));
    const outHeaders = {};
    Object.entries(headers || {}).forEach(([name, value]) => {
      if (value == null) return;
      outHeaders[name] = String(value);
    });
    if (payload) outHeaders['Content-Length'] = String(Buffer.byteLength(payload));

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: String(method || 'GET').toUpperCase(),
      headers: outHeaders,
      timeout: Number(timeoutMs) > 0 ? Number(timeoutMs) : 30000,
    };

    let settled = false;
    const finish = (reply) => {
      if (settled) return;
      settled = true;
      resolve(reply);
    };

    let req;
    try {
      req = (isHttps ? https : http).request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          finish({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers || {},
          });
        });
        res.on('error', () => finish({ status: 0, body: '', headers: {}, networkError: true, error: 'The connection failed' }));
      });
    } catch (err) {
      finish({ status: 0, body: '', headers: {}, networkError: true, error: err.message });
      return;
    }

    req.on('error', (err) => finish({ status: 0, body: '', headers: {}, networkError: true, error: err.message }));
    req.on('timeout', () => {
      finish({ status: 0, body: '', headers: {}, networkError: true, timedOut: true, error: 'No answer from the server' });
      req.destroy();
    });

    try {
      if (payload) req.write(payload);
      req.end();
    } catch (err) {
      req.destroy();
      finish({ status: 0, body: '', headers: {}, networkError: true, error: err.message });
    }
  });
}

// A JSON body, or null when the answer is not JSON. An unreadable body is a
// failure to classify, never a crash.
function readJson(res) {
  if (!res || typeof res.body !== 'string' || !res.body) return null;
  try {
    const parsed = JSON.parse(res.body);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function form(pairs) {
  return Object.entries(pairs)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

module.exports = { request, readJson, form };
