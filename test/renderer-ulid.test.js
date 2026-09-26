const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ulid } = require('../src/db/ulid');
const { memoryStore } = require('./helpers');

// ulid.js is a plain browser script that declares a global function; it is
// evaluated here the same way and the function taken out.
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'ulid.js'), 'utf8');
const newUlid = new Function(`${source}\nreturn newUlid;`)();

test('newUlid: 26 Crockford characters, the same time prefix as src/db/ulid.js, unique', () => {
  const now = 1790000000000;
  const a = newUlid(now);
  const b = newUlid(now);
  assert.match(a, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.strictEqual(a.slice(0, 10), ulid(now).slice(0, 10));
  assert.notStrictEqual(a, b);
  assert.ok(newUlid(now + 1).slice(0, 10) > a.slice(0, 10));
});

test('the history repository keeps a run id the renderer made', async (t) => {
  const { repos } = await memoryStore(t);
  const runUid = newUlid();
  assert.strictEqual(repos.history.append({ at: 1, provider: 'nara', runUid, results: [] }, 300).runUid, runUid);
});
