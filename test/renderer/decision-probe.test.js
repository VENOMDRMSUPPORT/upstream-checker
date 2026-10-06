const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// The TypeSafe /systemone decision wire protocol — the `noul` probe body and
// the answer parsing — belongs to the provider modules that declare
// decisionEndpoint (nara, experiential), not to app.js's generic tester.
// app.js only drives the request and judges the score.
//
// The bug this pins: attemptDecision hardcoded the provider-family body shape
// ({ state, questions: { probe: { type: 'noul', ... } } }) and the `noul`
// answer field directly in app.js, so a third provider with a different
// decision protocol could not exist without editing shared code.

const root = path.join(__dirname, '..', '..');

function loadProvider(file) {
  const source = fs.readFileSync(path.join(root, 'src', 'renderer', 'providers', file), 'utf8');
  const window = {};
  new Function('window', source)(window);
  return window.INTEGRATED_PROVIDERS;
}

const NARA = loadProvider('nara.js');
const EXPERIENTIAL = loadProvider('experiential.js');

const MODEL = { id: 'jev-2', name: 'Jev 2' };
const CTX = { state: 'draft', question: 'How likely is a refund?' };

test('nara declares the TypeSafe decision hooks at adapter level', () => {
  assert.strictEqual(typeof NARA.nara.decisionProbe, 'function');
  assert.strictEqual(typeof NARA.nara.readDecisionAnswer, 'function');
});

test('nara decisionProbe builds the noul question body', () => {
  assert.deepStrictEqual(NARA.nara.decisionProbe(MODEL, CTX), {
    model: 'jev-2',
    state: 'draft',
    questions: { probe: { type: 'noul', instructions: 'How likely is a refund?' } },
  });
});

test('experiential declares the same hooks at adapter level', () => {
  assert.strictEqual(typeof EXPERIENTIAL.experiential.decisionProbe, 'function');
  assert.strictEqual(typeof EXPERIENTIAL.experiential.readDecisionAnswer, 'function');
  assert.deepStrictEqual(EXPERIENTIAL.experiential.decisionProbe(MODEL, CTX),
    NARA.nara.decisionProbe(MODEL, CTX));
});

test('readDecisionAnswer scores an object answer, named in the row', () => {
  const a = NARA.nara.readDecisionAnswer({ answers: { probe: { noul: 0.8734 } } });
  assert.strictEqual(a.score, 0.8734);
  assert.strictEqual(a.response, 'noul 0.87');
});

test('readDecisionAnswer scores a bare numeric answer', () => {
  const a = EXPERIENTIAL.experiential.readDecisionAnswer({ answers: { probe: 0.5 } });
  assert.strictEqual(a.score, 0.5);
});

test('readDecisionAnswer returns null when no probability comes back', () => {
  assert.strictEqual(NARA.nara.readDecisionAnswer({}), null);
  assert.strictEqual(NARA.nara.readDecisionAnswer({ answers: { probe: null } }), null);
  assert.strictEqual(NARA.nara.readDecisionAnswer({ answers: { probe: { noul: 'high' } } }), null);
});

// attemptDecision itself: sliced out of app.js the same way key-quota-state
// does, exercised against a stubbed apiRequest and the real provider modules.
const appSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');
const start = appSource.indexOf('async function attemptDecision');
assert.ok(start !== -1, 'attemptDecision not found in app.js');
// app.js is CRLF on disk; the function ends at the first brace in column 0.
const endMatch = /\r?\n\}\r?\n/.exec(appSource.slice(start));
assert.ok(endMatch, 'attemptDecision end not found in app.js');
const block = appSource.slice(start, start + endMatch.index + endMatch[0].length);

async function runAttemptDecision({ providerOverrides = {}, response } = {}) {
  const calls = [];
  const registry = { nara: { ...NARA.nara, ...providerOverrides } };
  const sandbox = {
    window: {
      INTEGRATED_PROVIDERS: registry,
      electronAPI: { apiRequest: async (req) => { calls.push(req); return response; } },
    },
    settings: { decisionState: 'draft', decisionQuestion: 'How likely?' },
    kindLimits: () => ({ deadline: 5000 }),
    authHeaders: (key) => ({ Authorization: `Bearer ${key}` }),
    routeTestTags: () => ({}),
    transportFailure: () => null,
    failFromResponse: (res) => ({ status: 'fail', response: `HTTP ${res.status}` }),
    buildEmptyResult: () => ({ status: 'pass', isEmpty: true }),
    usageTokens: () => 7,
  };
  const attemptDecision = new Function(...Object.keys(sandbox),
    `${block}\nreturn attemptDecision;`)(...Object.values(sandbox));
  const provider = { id: 'nara', name: 'NARA Router', baseUrl: 'https://x/v1', decisionEndpoint: '/systemone' };
  return { result: await attemptDecision(MODEL, provider, { id: 'k1', key: 'sk-test' }, 'r1'), calls };
}

test('attemptDecision consults the adapter hooks, not a hardcoded body', async () => {
  const { result, calls } = await runAttemptDecision({
    response: { status: 200, body: JSON.stringify({ answers: { probe: { noul: 0.42 } }, usage: { total_tokens: 7 } }), elapsed: 120 },
  });
  assert.strictEqual(result.status, 'pass');
  assert.strictEqual(result.decisionScore, 0.42);
  assert.strictEqual(result.response, 'noul 0.42');
  assert.strictEqual(result.tokens, 7);
  // The wire body came from the provider module's hook.
  assert.deepStrictEqual(JSON.parse(calls[0].body), {
    model: 'jev-2',
    state: 'draft',
    questions: { probe: { type: 'noul', instructions: 'How likely?' } },
  });
  assert.strictEqual(calls[0].url, 'https://x/v1/systemone');
});

test('attemptDecision reports an empty result when no probability returns', async () => {
  const { result } = await runAttemptDecision({
    response: { status: 200, body: JSON.stringify({ answers: {}, usage: {} }), elapsed: 120 },
  });
  assert.strictEqual(result.isEmpty, true);
});

test('attemptDecision fails cleanly for an adapter without hooks', async () => {
  const { result } = await runAttemptDecision({
    providerOverrides: { decisionProbe: undefined, readDecisionAnswer: undefined },
  });
  assert.strictEqual(result.status, 'fail');
  assert.match(result.response, /decision endpoint/);
});

// The acceptance test: no provider-family wire vocabulary remains in app.js.
test('app.js no longer hardcodes the noul protocol', () => {
  assert.ok(!appSource.includes('noul'), 'app.js still mentions noul');
  assert.ok(appSource.includes('decisionProbe'), 'attemptDecision must consult the adapter hook');
  assert.ok(appSource.includes('readDecisionAnswer'), 'attemptDecision must consult the adapter parser');
});
