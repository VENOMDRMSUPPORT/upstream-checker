// ============================================
// Run ids — ULID, the same format as src/db/ulid.js
// ============================================
// A Route Test run and a benchmark model run get their id here, in the page,
// so every request they send can carry it and the history row (append-run)
// is saved under the same one. 48-bit millisecond time + 80 random bits in
// Crockford base32: sorts by time and needs no coordination.
function newUlid(now = Date.now()) {
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i += 1) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let rand = '';
  // 256 is a multiple of 32, so the modulo keeps every character equally likely.
  for (let i = 0; i < 16; i += 1) rand += ALPHABET[bytes[i] % 32];
  return time + rand;
}
