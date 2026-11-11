const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// The catalog providers are the generic adapter's proof: six real providers
// (Groq, Cerebras, Google AI Studio, OpenRouter, GitHub Models,
// Pollinations) registered from ONE data table with no per-provider code.
// What the tests must pin:
//
//   1. every entry registers with the identity its verification card states
//   2. meta is plain data — structuredClone-safe for the provider store
//   3. the logo file actually exists on disk (a broken path renders a dead
//      tile)
//   4. the free-tier labelling is honest: Cerebras is a one-time trial
//      behind a payment method, so it must NOT carry freeTier — the other
//      five do
//   5. no entry smuggles in behaviour (fetchModels / fetchKeyUsage / hooks):
//      a provider that needs code graduates to its own module instead
//   6. every entry carries its verification date, so stale facts show as
//      stale

const root = path.join(__dirname, '..', '..');

function loadCatalog() {
  const source = fs.readFileSync(
    path.join(root, 'src', 'renderer', 'providers', 'catalog-providers.js'), 'utf8');
  const window = {};
  new Function('window', source)(window);
  return window.INTEGRATED_PROVIDERS;
}

const EXPECTED = {
  groq: { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
  cerebras: { name: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1' },
  googleaistudio: { name: 'Google AI Studio', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  openrouter: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  githubmodels: { name: 'GitHub Models', baseUrl: 'https://models.github.ai/inference' },
  pollinations: { name: 'Pollinations', baseUrl: 'https://gen.pollinations.ai/v1' },
};

const PROVIDERS = loadCatalog();

test('all six catalog providers register', () => {
  for (const id of Object.keys(EXPECTED)) {
    assert.ok(PROVIDERS[id], `catalog provider ${id} did not register`);
  }
});

for (const [id, want] of Object.entries(EXPECTED)) {
  test(`${id} registers with its verified identity and the standard contract`, () => {
    const meta = PROVIDERS[id].meta;
    assert.strictEqual(meta.id, id);
    assert.strictEqual(meta.name, want.name);
    assert.strictEqual(meta.baseUrl, want.baseUrl);
    assert.strictEqual(meta.modelsEndpoint, '/models');
    assert.strictEqual(meta.chatEndpoint, '/chat/completions');
    assert.deepStrictEqual(meta.auth, ['apikey']);
  });

  test(`${id} meta is plain data — structuredClone-safe for the provider store`, () => {
    const meta = PROVIDERS[id].meta;
    assert.deepStrictEqual(structuredClone(meta), meta);
  });

  test(`${id} logo file exists at the path the meta declares`, () => {
    const logoPath = path.join(root, 'src', 'renderer', PROVIDERS[id].meta.logo);
    assert.ok(fs.existsSync(logoPath), `missing logo file: ${PROVIDERS[id].meta.logo}`);
  });

  test(`${id} carries its verified free-tier facts`, () => {
    const meta = PROVIDERS[id].meta;
    assert.match(meta.verifiedOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(meta.planNote && meta.planNote.length > 0, 'planNote missing');
    assert.ok(meta.rateLimits && Array.isArray(meta.rateLimits.lines) && meta.rateLimits.lines.length > 0,
      'rateLimits lines missing');
  });

  test(`${id} is data only — no behaviour hooks`, () => {
    const entry = PROVIDERS[id];
    assert.deepStrictEqual(Object.keys(entry), ['meta']);
  });
}

test('free-tier labelling is honest: five free, Cerebras is a trial', () => {
  for (const id of ['groq', 'googleaistudio', 'openrouter', 'githubmodels', 'pollinations']) {
    assert.strictEqual(PROVIDERS[id].meta.freeTier, true, `${id} should be freeTier`);
  }
  assert.strictEqual(PROVIDERS.cerebras.meta.freeTier, false,
    'Cerebras is a one-time $5 trial behind a payment method — never tag it free');
});
