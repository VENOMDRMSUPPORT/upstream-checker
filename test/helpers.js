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

// A bare in-memory request log database with schema v1 applied, for the
// modules that take a db handle (writer, retention, query). Closed after the
// test.
function migratedLogsDb(t) {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  require('../src/logs/migrations').forEach((m) => m.up(db));
  t.after(() => {
    if (db.open) db.close();
  });
  return db;
}

// A complete request_logs row as src/logs/recorder.js builds it (no has_body:
// the writer sets that). Override what a test needs.
let logRowSeq = 0;
function logRow(overrides = {}) {
  logRowSeq += 1;
  return {
    request_uid: `ROW${String(logRowSeq).padStart(23, '0')}`,
    created_at: 1790000000000,
    source: 'route_test',
    run_id: null,
    attempt: 1,
    is_hedge: 0,
    provider_id: 'nara',
    provider_name: 'NaraRouter',
    key_id: 'key_1',
    method: 'POST',
    endpoint: 'https://router.bynara.id/v1/chat/completions',
    model_requested: 'm1',
    model_returned: 'm1',
    is_stream: 0,
    status: 'ok',
    http_status: 200,
    error_class: null,
    error_code: null,
    error_message: null,
    latency_ms: 800,
    ttft_ms: null,
    first_byte_ms: 700,
    input_tokens: 10,
    output_tokens: 2,
    cached_tokens: null,
    cache_write_tokens: null,
    reasoning_tokens: null,
    usage_source: 'reported',
    cost_micros: 40,
    price_json: '{"input":2,"output":10}',
    meta_json: null,
    user_id: null,
    token_id: null,
    subscription_id: null,
    client_ip: null,
    ...overrides,
  };
}

const countRows = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

module.exports = {
  quietLog, fakeSafeStorage, fakeCipher, encFake, LOCKED_BLOB, tempDir, memoryStore,
  migratedLogsDb, logRow, countRows,
};
