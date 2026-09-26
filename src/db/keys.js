// ============================================
// Placeholders → secrets, for outgoing requests
// ============================================
// The renderer never holds a key. It puts venomkey:<keyId> (a provider key) or
// venomsecret:<name> (the Artificial Analysis key) where the key goes — a
// header, the URL, a body — and main swaps in the secret just before sending,
// only when the request goes to that secret's own origin.
//
// Defence in depth, not a wall: a compromised renderer could still repoint a
// provider's base URL with save-provider. It stops a key reaching the wrong
// host by mistake or through an injected URL.
const { SECRET_ORIGINS } = require('./repos/secrets');

// A key id is at most 64 chars (src/db/repos/providers.js), so a token run is
// capped at 64 too: an attacker-supplied header can't turn one substitution
// into thousands of lookups, and an "unknown key" error can't quote megabytes.
const TOKEN = /venom(key|secret):([A-Za-z0-9_.-]{1,64})/g;
const HAS_TOKEN = /venom(?:key|secret):/;

// Only http/https have a real origin. Every other scheme — no scheme at all
// ("localhost:8080/v1"), a typo'd scheme ("htps://…"), or a deliberately
// invented one ("x://…") — gets the opaque origin "null" from the platform
// URL parser, and two opaque origins are indistinguishable from each other.
// Returning null here (not the string "null") for anything non-http(s) means
// such a pair can never satisfy the `hit.origin === target` check below.
function originOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch (_) {
    return null;
  }
}

function createKeyResolver({ providers, secrets }) {
  // A token's secret, resolved only after its one allowed origin is confirmed
  // to match the request's target — so a wrong-host request never reaches the
  // cipher. For keys the longest key id that starts the token wins, so
  // venomkey:key_12 is key_12, never key_1 followed by a "2".
  function lookup(kind, run, target) {
    if (kind === 'secret') {
      if (!Object.prototype.hasOwnProperty.call(SECRET_ORIGINS, run)) return { error: `Key blocked: unknown secret "${run}"` };
      if (!target || SECRET_ORIGINS[run] !== target) return { mismatch: true };
      const secret = secrets.reveal(run);
      if (secret === null) return { error: `Key blocked: the ${run} secret is not set or can't be read on this machine` };
      return { secret, used: run.length };
    }
    for (let len = run.length; len > 0; len -= 1) {
      const record = providers.keyRecord(run.slice(0, len));
      if (!record) continue;
      if (!target || originOf(record.baseUrl) !== target) return { mismatch: true };
      const secret = providers.revealKey(record.id);
      if (secret === null) return { error: `Key blocked: "${record.name}" can't be read on this machine` };
      return { secret, used: len };
    }
    return { error: `Key blocked: unknown key "${run}"` };
  }

  function substitute(text, target, host, encode) {
    let error = null;
    const out = text.replace(TOKEN, (match, kind, run) => {
      if (error) return match;
      const hit = lookup(kind, run, target);
      if (hit.mismatch) {
        error = `Key blocked: ${host} is not this key's provider`;
        return match;
      }
      if (hit.error) {
        error = hit.error;
        return match;
      }
      return encode(hit.secret) + run.slice(hit.used);
    });
    return { text: out, error };
  }

  const raw = (s) => s;
  const inJson = (s) => JSON.stringify(s).slice(1, -1);

  // { url, headers, body } ready to send, or { blocked: true, error }.
  function resolve({ url, headers, body }) {
    const bodyText = body === undefined || body === null || body === '' || typeof body === 'string' ? body : JSON.stringify(body);
    const needed = HAS_TOKEN.test(String(url))
      || Object.values(headers || {}).some((v) => typeof v === 'string' && HAS_TOKEN.test(v))
      || (typeof bodyText === 'string' && HAS_TOKEN.test(bodyText));
    if (!needed) return { url, headers, body };

    const target = originOf(url);
    let host = String(url);
    try {
      host = new URL(url).host;
    } catch (_) {
      // Unparsable: named as given.
    }
    const blocked = (error) => ({ blocked: true, error });

    const u = substitute(String(url), target, host, encodeURIComponent);
    if (u.error) return blocked(u.error);
    const outHeaders = {};
    for (const [name, value] of Object.entries(headers || {})) {
      if (typeof value !== 'string') {
        outHeaders[name] = value;
        continue;
      }
      const h = substitute(value, target, host, raw);
      if (h.error) return blocked(h.error);
      outHeaders[name] = h.text;
    }
    let outBody = bodyText;
    if (typeof bodyText === 'string' && HAS_TOKEN.test(bodyText)) {
      let isJson = true;
      try {
        JSON.parse(bodyText);
      } catch (_) {
        isJson = false;
      }
      const b = substitute(bodyText, target, host, isJson ? inJson : raw);
      if (b.error) return blocked(b.error);
      outBody = b.text;
    }
    return { url: u.text, headers: outHeaders, body: outBody };
  }

  return { resolve };
}

module.exports = { createKeyResolver };
