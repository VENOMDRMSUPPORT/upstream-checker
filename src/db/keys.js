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

const TOKEN = /venom(key|secret):([A-Za-z0-9_.-]+)/g;
const HAS_TOKEN = /venom(?:key|secret):/;

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch (_) {
    return null;
  }
}

function createKeyResolver({ providers, secrets }) {
  // A token's secret and the one origin it may go to. For keys the longest key
  // id that starts the token wins, so venomkey:key_12 is key_12, never key_1
  // followed by a "2".
  function lookup(kind, run) {
    if (kind === 'secret') {
      if (!Object.prototype.hasOwnProperty.call(SECRET_ORIGINS, run)) return { error: `Key blocked: unknown secret "${run}"` };
      const secret = secrets.reveal(run);
      if (secret === null) return { error: `Key blocked: the ${run} secret is not set or can't be read on this machine` };
      return { secret, origin: SECRET_ORIGINS[run], used: run.length };
    }
    for (let len = run.length; len > 0; len -= 1) {
      const record = providers.keyRecord(run.slice(0, len));
      if (!record) continue;
      const secret = providers.revealKey(record.id);
      if (secret === null) return { error: `Key blocked: "${record.name}" can't be read on this machine` };
      return { secret, origin: originOf(record.baseUrl), used: len };
    }
    return { error: `Key blocked: unknown key "${run}"` };
  }

  function substitute(text, target, host, encode) {
    let error = null;
    const out = text.replace(TOKEN, (match, kind, run) => {
      if (error) return match;
      const hit = lookup(kind, run);
      if (hit.error) {
        error = hit.error;
        return match;
      }
      if (!target || hit.origin !== target) {
        error = `Key blocked: ${host} is not this key's provider`;
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
