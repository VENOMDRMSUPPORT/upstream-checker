const test = require('node:test');
const assert = require('node:assert');
const { scrub } = require('../../src/logs/scrub');

// sk-"quote\slash/7: needs escaping in JSON and in a URL.
const TRICKY = 'sk-"quote\\slash/7';
const SUBS = [{ placeholder: 'venomkey:key_t', secret: TRICKY }];

test('replaces the raw secret with its placeholder', () => {
  assert.strictEqual(scrub(`bad key ${TRICKY}!`, SUBS), 'bad key venomkey:key_t!');
});

test('replaces the JSON-escaped, \\/-escaped and URL-encoded forms', () => {
  const json = JSON.stringify({ echo: TRICKY });
  const php = json.replace(/\//g, '\\/');
  const url = `https://x.test/?key=${encodeURIComponent(TRICKY)}`;
  assert.strictEqual(scrub(json, SUBS), '{"echo":"venomkey:key_t"}');
  assert.strictEqual(scrub(php, SUBS), '{"echo":"venomkey:key_t"}');
  assert.strictEqual(scrub(url, SUBS), 'https://x.test/?key=venomkey:key_t');
});

test('the longest form goes first, so a secret inside another is replaced whole', () => {
  const subs = [
    { placeholder: 'venomkey:short', secret: 'sk-abc' },
    { placeholder: 'venomkey:long', secret: 'sk-abcdef' },
  ];
  assert.strictEqual(scrub('a sk-abcdef b sk-abc c', subs), 'a venomkey:long b venomkey:short c');
});

test('nothing to scrub: the text comes back as it was', () => {
  assert.strictEqual(scrub('plain', []), 'plain');
  assert.strictEqual(scrub('plain', undefined), 'plain');
  assert.strictEqual(scrub(null, SUBS), null);
  assert.strictEqual(scrub('', SUBS), '');
  assert.strictEqual(scrub('venomkey:key_t stays', SUBS), 'venomkey:key_t stays');
  assert.strictEqual(scrub('x', [{ placeholder: 'p', secret: '' }]), 'x');
});

test('a secret with a lone surrogate is scrubbed from raw text without throwing', () => {
  const lonesurrogate = 'sk-\uD800abc';
  const subs = [{ placeholder: 'venomkey:surrogate', secret: lonesurrogate }];
  assert.strictEqual(scrub(`error key ${lonesurrogate} failed`, subs), 'error key venomkey:surrogate failed');
});
