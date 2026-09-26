// ============================================
// API keys at rest
// ============================================
// Keys are encrypted in config.json with the OS keystore (DPAPI on Windows), so
// the file is useless to anything reading it off disk — another local process, a
// cloud-synced copy of the folder, a backup. The renderer still receives and
// works with plaintext: it has to build the Authorization header, so the key is
// in its memory either way. This protects the file, not the process.
//
// The ciphertext is bound to this OS user on this machine. A config copied
// elsewhere will not decrypt — that is the point, and it is handled here rather
// than silently losing the key.
const { safeStorage } = require('electron');

// The envelope is owned by src/db/cipher.js now; this file only serves
// scripts/keystore-check.js.
const { ENC_PREFIX } = require('./db/cipher');

function decryptKeyEntry(k, log = console) {
  const stored = k.key;
  if (typeof stored !== 'string' || !stored.startsWith(ENC_PREFIX)) return; // not yet migrated
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption unavailable');
    k.key = safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'));
  } catch (err) {
    // Wrong machine or wrong user. Hold on to the ciphertext so the next save
    // can't overwrite it with an empty value, and flag it so the UI can say so.
    log.warn(`Could not decrypt key "${k.name}": ${err.message}`);
    k.key = '';
    k.cipher = stored;
    k.locked = true;
  }
}

function encryptKeyEntry(k, log = console) {
  if (k.locked && k.cipher) {
    k.key = k.cipher; // never decrypted this session — put it back untouched
    delete k.cipher;
    delete k.locked;
    return;
  }
  delete k.cipher;
  delete k.locked;
  if (typeof k.key !== 'string' || k.key === '' || k.key.startsWith(ENC_PREFIX)) return;
  if (!safeStorage.isEncryptionAvailable()) {
    log.warn('OS encryption unavailable — storing the API key as plaintext');
    return; // leave it readable rather than write something we can't get back
  }
  k.key = ENC_PREFIX + safeStorage.encryptString(k.key).toString('base64');
}

function eachStoredKey(data, fn) {
  Object.values(data?.providers || {}).forEach((p) => {
    if (Array.isArray(p.keys)) p.keys.forEach((k) => fn(k));
  });
  return data;
}

function countPlaintextKeys(data) {
  let n = 0;
  eachStoredKey(data, (k) => {
    if (typeof k.key === 'string' && k.key !== '' && !k.key.startsWith(ENC_PREFIX)) n += 1;
  });
  return n;
}

module.exports = {
  ENC_PREFIX,
  decryptKeyEntry,
  encryptKeyEntry,
  eachStoredKey,
  countPlaintextKeys,
};
