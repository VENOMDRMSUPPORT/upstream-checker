// Shared test helpers. Nothing here touches the real app data folder: stores
// live in memory or in a fresh temp directory, and encryption is a fake that
// needs no OS keystore.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCipher, ENC_PREFIX } = require('../src/db/cipher');

const quietLog = { info() {}, warn() {}, error() {} };

// Stands in for Electron's safeStorage. It "encrypts" by prefixing, so a value
// it did not make (LOCKED_BLOB) fails to decrypt, like DPAPI data from another
// machine or Windows user.
function fakeSafeStorage(state = { available: true }) {
  return {
    isEncryptionAvailable: () => state.available,
    encryptString: (text) => Buffer.from(`fake:${text}`, 'utf8'),
    decryptString: (buf) => {
      const s = buf.toString('utf8');
      if (!s.startsWith('fake:')) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      return s.slice('fake:'.length);
    },
  };
}

// A cipher backed by the fake, with call counters. Flip state.available to
// simulate the OS keystore going away.
function fakeCipher({ available = true } = {}) {
  const state = { available };
  const real = createCipher(fakeSafeStorage(state));
  const calls = { encrypt: 0, decrypt: 0 };
  return {
    state,
    calls,
    available: () => real.available(),
    encrypt: (text) => { calls.encrypt += 1; return real.encrypt(text); },
    decrypt: (value) => { calls.decrypt += 1; return real.decrypt(value); },
  };
}

// What fakeCipher().encrypt(text) returns, for building legacy fixtures.
const encFake = (text) => ENC_PREFIX + Buffer.from(`fake:${text}`, 'utf8').toString('base64');

// A well-formed envelope the fake can't open: a key encrypted on another machine.
const LOCKED_BLOB = ENC_PREFIX + Buffer.from('ciphertext from another machine', 'utf8').toString('base64');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-test-'));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { /* a file still open on Windows */ }
  });
  return dir;
}

// A migrated in-memory database with every repository, closed after the test.
async function memoryStore(t, { cipher = fakeCipher(), log = quietLog } = {}) {
  const database = require('../src/db');
  const store = await database.open(':memory:', { cipher, log });
  t.after(() => store.close());
  return store;
}

module.exports = { quietLog, fakeSafeStorage, fakeCipher, encFake, LOCKED_BLOB, tempDir, memoryStore };
