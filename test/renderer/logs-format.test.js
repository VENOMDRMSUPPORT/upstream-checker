const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// logs-format.js is a plain browser script of top-level function
// declarations, the same shape as src/renderer/ulid.js. It is evaluated here
// and the functions taken out, which only works while it touches neither
// window nor document at evaluation time.
const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'logs-format.js'), 'utf8');
const F = new Function(`${source}\nreturn { logEscape, normalizeProvider, providerLabel, formatDuration, formatCost, formatTokens, formatWhen, statusTone, passRateText, rangePreset, toViewModel };`)();

// Model ids, error messages and provider names all come from a provider's
// own response and land in innerHTML. In a renderer this is the difference
// between a log row and script execution.
test('logEscape: provider text cannot close a tag', () => {
  assert.strictEqual(F.logEscape('a & b'), 'a &amp; b');
  assert.strictEqual(F.logEscape('</script><img onerror=x>'), '&lt;/script&gt;&lt;img onerror=x&gt;');
  assert.strictEqual(F.logEscape('say "hi"'), 'say &quot;hi&quot;');
  assert.strictEqual(F.logEscape(null), '');
});

test('toViewModel: escapes every string it puts on the page', () => {
  const vm = F.toViewModel({
    id: 1, created_at: Date.UTC(2026, 8, 27), source: 'proxy',
    provider_id: 'p', provider_name: '<b>p</b>', model_requested: '<i>m</i>',
    status: 'error', error_class: 'server', error_message: '<u>boom</u>',
    latency_ms: 10, is_stream: 0, has_body: 0,
  }, {});
  assert.strictEqual(vm.provider, '&lt;b&gt;p&lt;/b&gt;');
  assert.strictEqual(vm.model, '&lt;i&gt;m&lt;/i&gt;');
  assert.strictEqual(vm.errorMessage, '&lt;u&gt;boom&lt;/u&gt;');
});

// Review Focus 5: '' in the roll-ups, NULL in the rows, one label in the UI.
test('normalizeProvider: the unknown provider has one name whichever table it came from', () => {
  assert.strictEqual(F.normalizeProvider(null), 'unknown');
  assert.strictEqual(F.normalizeProvider(''), 'unknown');
  assert.strictEqual(F.normalizeProvider(undefined), 'unknown');
  assert.strictEqual(F.normalizeProvider('mirai'), 'mirai');
  assert.strictEqual(F.providerLabel(null, null), 'Unknown provider');
  assert.strictEqual(F.providerLabel('mirai', 'Mirai API'), 'Mirai API');
  assert.strictEqual(F.providerLabel('mirai', null), 'mirai');
});

test('formatDuration: milliseconds under a second, seconds above, nothing for nothing', () => {
  assert.strictEqual(F.formatDuration(null), '—');
  assert.strictEqual(F.formatDuration(0), '0 ms');
  assert.strictEqual(F.formatDuration(940), '940 ms');
  assert.strictEqual(F.formatDuration(1500), '1.5 s');
  assert.strictEqual(F.formatDuration(61000), '1 m 1 s');
});

test('formatCost: micros to dollars, small amounts kept visible', () => {
  assert.strictEqual(F.formatCost(null), '—');
  assert.strictEqual(F.formatCost(0), '$0');
  assert.strictEqual(F.formatCost(1), '<$0.0001');
  assert.strictEqual(F.formatCost(12340), '$0.0123');
  assert.strictEqual(F.formatCost(2500000), '$2.50');
});

test('formatTokens: thousands separated, null is a dash', () => {
  assert.strictEqual(F.formatTokens(null), '—');
  assert.strictEqual(F.formatTokens(0), '0');
  assert.strictEqual(F.formatTokens(1234567), '1,234,567');
});

test('statusTone: one tone per outcome', () => {
  assert.strictEqual(F.statusTone({ status: 'ok' }), 'pass');
  assert.strictEqual(F.statusTone({ status: 'cancelled' }), 'muted');
  assert.strictEqual(F.statusTone({ status: 'error', error_class: 'blocked' }), 'warn');
  assert.strictEqual(F.statusTone({ status: 'error', error_class: 'rate_limit' }), 'warn');
  assert.strictEqual(F.statusTone({ status: 'error', error_class: 'server' }), 'fail');
});

test('passRateText: a fraction becomes a percentage, null stays unknown', () => {
  assert.strictEqual(F.passRateText(null), '—');
  assert.strictEqual(F.passRateText(1), '100%');
  assert.strictEqual(F.passRateText(2 / 3), '67%');
  assert.strictEqual(F.passRateText(0), '0%');
});

test('rangePreset: every preset ends now and starts before it', () => {
  const now = Date.UTC(2026, 8, 27, 12);
  ['24h', '7d', '30d'].forEach((key) => {
    const r = F.rangePreset(key, now);
    assert.strictEqual(r.to, now + 1, `${key}: to is exclusive, so it must pass now`);
    assert.ok(r.from < now, `${key}: from must precede now`);
  });
  assert.strictEqual(F.rangePreset('24h', now).from, now - 24 * 3600000);
  assert.throws(() => F.rangePreset('forever', now), /Unknown range/);
});

test('toViewModel: a row becomes the cells the table renders', () => {
  const vm = F.toViewModel({
    id: 7, created_at: Date.UTC(2026, 8, 27, 11), source: 'route_test',
    provider_id: null, provider_name: null, model_requested: 'gpt-x',
    status: 'error', error_class: 'server', error_message: 'boom',
    latency_ms: 1500, ttft_ms: null, input_tokens: 10, output_tokens: 5,
    cost_micros: 12340, has_body: 1, is_stream: 0,
  }, {});
  assert.strictEqual(vm.id, 7);
  assert.strictEqual(vm.provider, 'Unknown provider');
  assert.strictEqual(vm.model, 'gpt-x');
  assert.strictEqual(vm.latency, '1.5 s');
  assert.strictEqual(vm.ttft, '—');
  assert.strictEqual(vm.tokens, '15');
  assert.strictEqual(vm.cost, '$0.0123');
  assert.strictEqual(vm.tone, 'fail');
  assert.strictEqual(vm.hasBody, true);
});
