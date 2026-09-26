// ============================================
// Secrets at rest — the enc:v1: envelope
// ============================================
// A secret is stored as 'enc:v1:' + base64(safeStorage.encryptString(text)).
// On Windows safeStorage is DPAPI: the value opens only for this Windows user
// on this machine, with the master key kept in <userData>\Local State.
//
// safeStorage is passed in rather than required, so nothing under src/db
// loads electron and the tests can use a fake.
const ENC_PREFIX = 'enc:v1:';

function isEnvelope(value) {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX) && value.length > ENC_PREFIX.length;
}

function createCipher(safeStorage) {
  const available = () => safeStorage.isEncryptionAvailable();
  return {
    available,
    // Throws rather than fall back to plaintext: a secret is never stored readable.
    encrypt(text) {
      if (typeof text !== 'string' || text === '') throw new TypeError('Nothing to encrypt');
      if (!available()) throw new Error('OS encryption is unavailable');
      return ENC_PREFIX + safeStorage.encryptString(text).toString('base64');
    },
    decrypt(value) {
      if (!isEnvelope(value)) throw new TypeError('Not an enc:v1: value');
      if (!available()) throw new Error('OS encryption is unavailable');
      return safeStorage.decryptString(Buffer.from(value.slice(ENC_PREFIX.length), 'base64'));
    },
  };
}

// Decrypts a stored value once per session. null means it can't be opened on
// this machine (a "locked" key): remembered, so it isn't retried on every read.
function revealCached(cipher, cache, cacheKey, value) {
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  let plain = null;
  try {
    plain = cipher.decrypt(value);
  } catch (_) {
    plain = null;
  }
  cache.set(cacheKey, plain);
  return plain;
}

module.exports = { ENC_PREFIX, isEnvelope, createCipher, revealCached };
