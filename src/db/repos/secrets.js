// ============================================
// Named secrets — the Artificial Analysis key
// ============================================
// Stored in the enc:v1: envelope like provider keys. Each name has the one
// origin it may be sent to (src/db/keys.js enforces it).
const { isEnvelope, revealCached } = require('../cipher');

const SECRET_ORIGINS = { aaApiKey: 'https://artificialanalysis.ai' };

function createSecretsRepo(db, cipher, cache) {
  const q = {
    get: db.prepare('SELECT cipher FROM secrets WHERE name = ?'),
    set: db.prepare(`INSERT INTO secrets (name, cipher, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET cipher = excluded.cipher, updated_at = excluded.updated_at`),
    remove: db.prepare('DELETE FROM secrets WHERE name = ?'),
  };
  const cacheKey = (name) => `secret:${name}`;

  function known(name) {
    if (!Object.prototype.hasOwnProperty.call(SECRET_ORIGINS, name)) throw new Error(`Unknown secret "${name}"`);
  }

  function getCipher(name) {
    const row = q.get.get(name);
    return row ? row.cipher : null;
  }

  function has(name) {
    return getCipher(name) !== null;
  }

  // save-secret: '' deletes. Encryption failing (OS keystore unavailable)
  // throws, so a secret is never stored readable. Returns whether one is stored.
  function save(name, value) {
    known(name);
    const text = typeof value === 'string' ? value.trim() : '';
    cache.delete(cacheKey(name));
    if (!text) {
      q.remove.run(name);
      return false;
    }
    q.set.run(name, cipher.encrypt(text), Date.now());
    return true;
  }

  // Import only: an existing envelope is copied as is, never re-encrypted.
  function setCipher(name, value) {
    known(name);
    if (!isEnvelope(value)) throw new TypeError(`Secret "${name}" must be an enc:v1: value`);
    cache.delete(cacheKey(name));
    q.set.run(name, value, Date.now());
  }

  // Plaintext for main-process use only (request signing), or null when unset
  // or not readable on this machine.
  function reveal(name) {
    const value = getCipher(name);
    return value === null ? null : revealCached(cipher, cache, cacheKey(name), value);
  }

  return { has, getCipher, save, setCipher, reveal };
}

module.exports = { createSecretsRepo, SECRET_ORIGINS };
