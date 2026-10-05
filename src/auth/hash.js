// ============================================
// The owner password — scrypt hash and verify
// ============================================
// `node:crypto`'s scrypt is the only dependency: no bcrypt, no argon2, no new
// package. The parameters are written into the stored string, so raising the
// cost later does not invalidate a password set today — an old string still
// verifies with its own parameters, and the next change re-hashes with the
// current ones.
//
//   scrypt$16384$8$1$<salt base64>$<hash base64>
//
// This file holds no state and loads no Electron. It is the same shape as
// src/db/cipher.js: pure functions over strings, testable under plain Node.
const crypto = require('crypto');

// The password the app ships with. It is written here in the repository, so it
// is NOT a secret and nothing may treat it as one: anyone who can read the
// source knows it. It exists so the first launch has a way in, and Settings
// says so until it is changed. `is_default` on the stored row is what the UI
// reads; this constant is only what gets hashed for that first row.
const DEFAULT_PASSWORD = '123456';

const ALGO = 'scrypt';
const N = 16384; // CPU/memory cost. ~50-70 ms per derivation on this machine.
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_BYTES = 16;

// Parameters are read from the string, so a string this build cannot parse must
// never be silently treated as a wrong password: the caller needs to tell the
// owner the difference between "that is not it" and "this lock cannot be read".
function parse(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6) return null;
  const [algo, n, r, p, salt, hash] = parts;
  if (algo !== ALGO) return null;
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (![params.N, params.r, params.p].every((v) => Number.isInteger(v) && v > 0)) return null;
  if (params.N > 2 ** 20) return null; // refuse a stored cost this build would choke on
  const saltBuf = Buffer.from(salt, 'base64');
  const hashBuf = Buffer.from(hash, 'base64');
  if (saltBuf.length === 0 || hashBuf.length === 0) return null;
  return { params, saltBuf, hashBuf };
}

function derive(password, saltBuf, params) {
  return crypto.scryptSync(password, saltBuf, KEYLEN, {
    N: params.N, r: params.r, p: params.p,
    // scrypt's default maxmem is 32 MB and N=16384,r=8 needs ~16 MB, but a
    // stored string with a higher cost would throw without this headroom.
    maxmem: 128 * N * R * 2,
  });
}

function hashPassword(password, { params = { N, r: R, p: P } } = {}) {
  if (typeof password !== 'string' || password === '') throw new TypeError('Nothing to hash');
  const saltBuf = crypto.randomBytes(SALT_BYTES);
  const hashBuf = derive(password, saltBuf, params);
  const value = [ALGO, params.N, params.r, params.p, saltBuf.toString('base64'), hashBuf.toString('base64')].join('$');
  return { value, params };
}

// false for a wrong password, and false — never a throw — for a string that is
// malformed, truncated or simply not one of ours. The caller asks parse()
// directly when it needs to tell those two apart.
function verifyPassword(password, stored) {
  const parsed = parse(stored);
  if (!parsed) return false;
  if (typeof password !== 'string' || password === '') return false;
  let candidate;
  try {
    candidate = derive(password, parsed.saltBuf, parsed.params);
  } catch (_) {
    return false;
  }
  if (candidate.length !== parsed.hashBuf.length) return false;
  return crypto.timingSafeEqual(candidate, parsed.hashBuf);
}

// True when the stored string is one this build can actually verify against —
// the difference between "wrong password" and "this lock cannot be read".
function isReadable(stored) {
  return parse(stored) !== null;
}

module.exports = { DEFAULT_PASSWORD, hashPassword, verifyPassword, isReadable, ALGO };
