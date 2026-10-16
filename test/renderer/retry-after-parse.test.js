const test = require('node:test');
const assert = require('node:assert');
const { loadRendererModules } = require('./module-loader');

// Exercise the complete pure response module with no provider or window I/O.
//
// The bug this pins: parseInt read an HTTP-date form ("Wed, 21 Oct 2026…") as
// its day-of-month, so a provider naming a reset seconds away sent the key to
// cool down for a full 60s window.
const P = loadRendererModules(['test-response']).responses;

test('delay-seconds form reads as seconds', () => {
  assert.strictEqual(P.parseRetryAfter({ 'retry-after': '30' }), 30);
  assert.strictEqual(P.parseRetryAfter({ 'retry-after': '0' }), 0);
});

test('HTTP-date form reads as seconds until that date', () => {
  const soon = new Date(Date.now() + 30_000).toUTCString();
  const secs = P.parseRetryAfter({ 'retry-after': soon });
  assert.ok(secs >= 25 && secs <= 30, `expected ~30, got ${secs}`);
});

test('a past HTTP-date waits a moment, not a full window', () => {
  const past = new Date(Date.now() - 60_000).toUTCString();
  assert.strictEqual(P.parseRetryAfter({ 'retry-after': past }), 0);
});

test('garbage and absence read as "not stated" (0)', () => {
  assert.strictEqual(P.parseRetryAfter({ 'retry-after': 'soon-ish' }), 0);
  assert.strictEqual(P.parseRetryAfter({}), 0);
  assert.strictEqual(P.parseRetryAfter(undefined), 0);
});
