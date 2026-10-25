const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Muse AI is served by a local bridge (MuseBridge) on 127.0.0.1:8787. The
// app talks to it like any other provider; the only thing that is special is
// that the usage comes from /admin/usage instead of a provider API.
//
// What the tests must pin:
//   1. registration + structuredClone-safe meta
//   2. the logo file actually exists on disk
//   3. the bridge's usage answer is mapped into the app's allowance shape —
//      the weekly limit is the headline, the additional tokens are listed
//      beside it, and the count of tokens left is shown
//   4. an absent reading is "not published", never a zero
//   5. a bridge that does not answer says so

const root = path.join(__dirname, '..', '..');

function loadMuse() {
  const source = fs.readFileSync(
    path.join(root, 'src', 'renderer', 'providers', 'muse.js'), 'utf8');
  const window = {};
  new Function('window', source)(window);
  return window.INTEGRATED_PROVIDERS.muse;
}

const MUSE = loadMuse();

const BRIDGE_USAGE = {
  plan: 'Muse مجاني',
  tier: { id: 'hatch_free', code: 'HATCH_FREE', name: 'Muse مجاني', isPaid: false, rank: 0 },
  state: 'METERED',
  quotaStatus: 'SUFFICIENT',
  weekly: { percent: 2, resets: '2026-10-26', resetsAt: 1793057551, resetsInSeconds: 547202, label: '2% مستخدَمة' },
  tokens: { percent: 0, left: '1B', balanceCredits: 40000000, totalCredits: 40000000, label: '0% مستخدَمة (تبقى 1 مليار رمز)' },
  invite: { code: 'D6XPL9', link: 'https://muse.ai/join', maxUses: 30, useCount: 0, usesRemaining: 30, state: 'eligible', redeemed: true },
  fetchedAt: '2026-10-20T15:32:29.157Z',
  source: 'hatch-api',
};

test('registers into window.INTEGRATED_PROVIDERS with the Muse AI identity', () => {
  assert.ok(MUSE, 'muse module did not register');
  assert.strictEqual(MUSE.meta.id, 'muse');
  assert.strictEqual(MUSE.meta.name, 'Muse AI');
  assert.strictEqual(MUSE.meta.baseUrl, 'http://127.0.0.1:8787');
  assert.strictEqual(MUSE.meta.modelsEndpoint, '/v1/models');
  assert.strictEqual(MUSE.meta.chatEndpoint, '/v1/chat/completions');
});

test('the account is a normal key, served by the bridge', () => {
  assert.deepStrictEqual(MUSE.meta.auth, ['apikey']);
});

test('meta is plain data — structuredClone-safe for the provider store', () => {
  const clone = structuredClone(MUSE.meta);
  assert.deepStrictEqual(clone, MUSE.meta);
});

test('logo file exists at the path the meta declares', () => {
  const rel = MUSE.meta.logo.replace(/^\.\.\//, '');
  const file = path.join(root, 'src', rel.replace(/\//g, path.sep));
  assert.ok(fs.existsSync(file), `missing logo file: ${file}`);
});

test('the bridge usage is mapped into the app allowance shape', async () => {
  let asked = null;
  const usage = await MUSE.fetchKeyUsage({
    apiKey: 'venomkey:bridge_1',
    baseUrl: 'http://127.0.0.1:8787',
    apiRequest: async (opts) => {
      asked = opts;
      return { status: 200, body: JSON.stringify(BRIDGE_USAGE) };
    },
  });
  assert.strictEqual(asked.url, 'http://127.0.0.1:8787/admin/usage');
  assert.strictEqual(asked.method, 'GET');

  assert.strictEqual(usage.plan, 'Muse مجاني');
  assert.strictEqual(usage.allowance.label, 'Muse مجاني · weekly limit');
  assert.strictEqual(usage.allowance.usedPct, 2);
  // Unix seconds become milliseconds.
  assert.strictEqual(usage.allowance.resetsAt, 1793057551000);
  assert.strictEqual(usage.allowances.length, 2);
  assert.strictEqual(usage.allowances[1].label, 'Additional tokens (1B left)');
  assert.strictEqual(usage.allowances[1].usedPct, 0);
});

test('a bridge that does not answer says so', async () => {
  await assert.rejects(
    () => MUSE.fetchKeyUsage({ apiKey: 'venomkey:bridge_1', apiRequest: async () => ({ status: 503, body: '' }) }),
    /did not answer/i,
  );
});

test('a reading that is not published is not a zero allowance', async () => {
  const usage = await MUSE.fetchKeyUsage({
    apiKey: 'venomkey:bridge_1',
    apiRequest: async () => ({ status: 200, body: JSON.stringify({ plan: 'Muse مجاني' }) }),
  });
  assert.strictEqual(usage.allowance, undefined);
  assert.strictEqual(usage.allowances, undefined);
});

test('an exhausted allowance is recognised, a rate limit is not', () => {
  assert.ok(MUSE.readQuotaError({ code: null, status: 402, message: 'subscription quota exhausted' }));
  assert.ok(MUSE.readQuotaError({ code: 'quota_exceeded', message: 'nope' }));
  assert.strictEqual(MUSE.readQuotaError({ code: 'rate_limit_exceeded', message: 'too many requests', status: 429 }), null);
  assert.strictEqual(MUSE.readQuotaError({ code: 'invalid_api_key', message: 'bad key', status: 401 }), null);
});
