const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../../src/catalog/util');

test('asNumber: absent, empty and unparsable all stay null, never 0', () => {
  assert.equal(U.asNumber(null), null);
  assert.equal(U.asNumber(''), null);
  assert.equal(U.asNumber('abc'), null);
  assert.equal(U.asNumber(undefined), null);
  assert.equal(U.asNumber('12'), 12);
  assert.equal(U.asNumber(0), 0, 'a published zero is a zero, not a gap');
});

test('perMillion: null in, null out — a missing price is not free', () => {
  assert.equal(U.perMillion(null), null);
  assert.equal(U.perMillion('0.000002'), 2);
});

test('boolOrNull: only a real true or false is an answer', () => {
  assert.equal(U.boolOrNull(true), true);
  assert.equal(U.boolOrNull(false), false);
  assert.equal(U.boolOrNull(undefined), null);
  assert.equal(U.boolOrNull('yes'), null, 'a string is not a boolean');
});

test('uniqueJoin: dedupes case-insensitively, drops empties, keeps the first spelling', () => {
  assert.equal(U.uniqueJoin(['Text', 'image', 'text']), 'Text, image');
  assert.equal(U.uniqueJoin([['text'], 'image, audio']), 'text, image, audio');
  assert.equal(U.uniqueJoin([]), '');
});

test('unixToDate: seconds and milliseconds both become YYYY-MM-DD, junk becomes empty', () => {
  const day = new Date(1727000000000).toISOString().slice(0, 10);
  assert.equal(U.unixToDate(1727000000), day);
  assert.equal(U.unixToDate(1727000000000), day);
  assert.equal(U.unixToDate(null), '');
  assert.equal(U.unixToDate('nonsense'), '');
});

test('providerOf: the routing prefix, or empty string', () => {
  assert.equal(U.providerOf('openai/gpt-5'), 'openai');
  assert.equal(U.providerOf('gpt-5'), '');
});

test('listHas: compares trimmed case-insensitively across arrays and comma strings', () => {
  assert.equal(U.listHas(['Text'], 'text'), true);
  assert.equal(U.listHas('text, image', 'image'), true);
  assert.equal(U.listHas('text', 'audio'), false);
  assert.equal(U.listHas(null, 'text'), false);
});

test('median: empty and non-finite collapse to null; even counts average the middle pair', () => {
  assert.equal(U.median([]), null);
  assert.equal(U.median([null, 2, 4]), 3);
  assert.equal(U.median([1, 2, 3]), 2);
});

test('clamp: min then max', () => {
  assert.equal(U.clamp(5, 0, 10), 5);
  assert.equal(U.clamp(-5, 0, 10), 0);
  assert.equal(U.clamp(50, 0, 10), 10);
});

test('monthsSince: 30.4-day months, unparseable is null, the future is clamped to 0', () => {
  assert.equal(U.monthsSince('not a date'), null);
  assert.equal(U.monthsSince(new Date(Date.now() + 86400000).toISOString()), 0);
  const sixMonthsAgo = new Date(Date.now() - 6 * 30.4 * 86400000).toISOString();
  assert.ok(Math.abs(U.monthsSince(sixMonthsAgo) - 6) < 0.02, 'the spec fit caps age at 36 months using this');
});
