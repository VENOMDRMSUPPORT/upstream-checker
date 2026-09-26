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

// A key id is at most 64 chars (KEY_ID in src/db/repos/providers.js, enforced
// on every save-provider and reused by the importer), so a token run is capped
// at 64 too: an attacker-supplied header can't turn one substitution into
// thousands of lookups, and an "unknown key" error can't quote megabytes.
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

// What resolve() substituted: each ref once (kind + id), each placeholder
// once with its secret. The request log scrubs stored text with the pairs.
function collector() {
  const refs = [];
  const substitutions = [];
  const seenRefs = new Set();
  const seenPlaceholders = new Set();
  return {
    refs,
    substitutions,
    add(ref, placeholder, secret) {
      const key = `${ref.kind}:${ref.id}`;
      if (!seenRefs.has(key)) {
        seenRefs.add(key);
        refs.push(ref);
      }
      if (!seenPlaceholders.has(placeholder)) {
        seenPlaceholders.add(placeholder);
        substitutions.push({ placeholder, secret });
      }
    },
  };
}

function createKeyResolver({ providers, secrets }) {
  // A token's secret, resolved only after its one allowed origin is confirmed
  // to match the request's target — so a wrong-host request never reaches the
  // cipher. For keys the longest key id that starts the token wins, so
  // venomkey:key_12 is key_12, never key_1 followed by a "2". Every answer
  // names what it is about (ref), so the request log can say which key a
  // request used, or which one was refused.
  function lookup(kind, run, target) {
    if (kind === 'secret') {
      const ref = { kind: 'secret', id: run, providerId: null };
      if (!Object.prototype.hasOwnProperty.call(SECRET_ORIGINS, run)) return { error: `Key blocked: unknown secret "${run}"`, ref };
      if (!target || SECRET_ORIGINS[run] !== target) return { mismatch: true, ref };
      const secret = secrets.reveal(run);
      if (secret === null) return { error: `Key blocked: the ${run} secret is not set or can't be read on this machine`, ref };
      return { secret, used: run.length, ref };
    }
    for (let len = run.length; len > 0; len -= 1) {
      const record = providers.keyRecord(run.slice(0, len));
      if (!record) continue;
      const ref = { kind: 'key', id: record.id, providerId: record.providerId };
      if (!target || originOf(record.baseUrl) !== target) return { mismatch: true, ref };
      const secret = providers.revealKey(record.id);
      if (secret === null) return { error: `Key blocked: "${record.name}" can't be read on this machine`, ref };
      return { secret, used: len, ref };
    }
    return { error: `Key blocked: unknown key "${run}"`, ref: { kind: 'key', id: run, providerId: null } };
  }

  function substitute(text, target, host, encode, found) {
    let error = null;
    let refused = null;
    const out = text.replace(TOKEN, (match, kind, run) => {
      if (error) return match;
      const hit = lookup(kind, run, target);
      if (hit.mismatch || hit.error) {
        error = hit.mismatch ? `Key blocked: ${host} is not this key's provider` : hit.error;
        refused = hit.ref;
        return match;
      }
      found.add(hit.ref, `venom${kind}:${run.slice(0, hit.used)}`, hit.secret);
      return encode(hit.secret) + run.slice(hit.used);
    });
    return { text: out, error, refused };
  }

  const raw = (s) => s;
  const inJson = (s) => JSON.stringify(s).slice(1, -1);

  // { url, headers, body, refs, substitutions } ready to send, or
  // { blocked: true, error, refs: [the refused ref] }. substitutions holds the
  // secrets themselves: main hands it to the request log's scrubber and
  // nowhere else — never to a reply, a log line or a stored record.
  function resolve({ url, headers, body }) {
    const bodyText = body === undefined || body === null || body === '' || typeof body === 'string' ? body : JSON.stringify(body);
    const needed = HAS_TOKEN.test(String(url))
      || Object.values(headers || {}).some((v) => typeof v === 'string' && HAS_TOKEN.test(v))
      || (typeof bodyText === 'string' && HAS_TOKEN.test(bodyText));
    if (!needed) return { url, headers, body, refs: [], substitutions: [] };

    const target = originOf(url);
    let host = String(url);
    try {
      host = new URL(url).host;
    } catch (_) {
      // Unparsable: named as given.
    }
    const found = collector();
    const blocked = (hit) => ({ blocked: true, error: hit.error, refs: hit.refused ? [hit.refused] : [] });

    const u = substitute(String(url), target, host, encodeURIComponent, found);
    if (u.error) return blocked(u);
    const outHeaders = {};
    for (const [name, value] of Object.entries(headers || {})) {
      if (typeof value !== 'string') {
        outHeaders[name] = value;
        continue;
      }
      const h = substitute(value, target, host, raw, found);
      if (h.error) return blocked(h);
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
      const b = substitute(bodyText, target, host, isJson ? inJson : raw, found);
      if (b.error) return blocked(b);
      outBody = b.text;
    }
    return { url: u.text, headers: outHeaders, body: outBody, refs: found.refs, substitutions: found.substitutions };
  }

  return { resolve };
}

module.exports = { createKeyResolver };
