// ULID: 48-bit millisecond time + 80 random bits in Crockford base32. Sorts by
// creation time and needs no coordination, so a run keeps one identity when a
// future server syncs it.
const crypto = require('crypto');

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function ulid(now = Date.now(), random = crypto.randomBytes) {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i += 1) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = random(16);
  let rand = '';
  // 256 is a multiple of 32, so the modulo keeps every character equally likely.
  for (let i = 0; i < 16; i += 1) rand += ALPHABET[bytes[i] % 32];
  return time + rand;
}

module.exports = { ulid };
