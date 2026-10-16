// Per-model budgets against the complete production retry/hedge runner.
const test = require('node:test');
const assert = require('node:assert');
const { loadRendererModules } = require('./module-loader');

function makeRunner(script, opts = {}) {
  const state = { abortTesting: false, ...opts };
  let call = 0;
  const denied = new Set();
  const policy = {
    soonestKeyAvailable: () => (typeof opts.soonestKeyAvailable === 'function' ? opts.soonestKeyAvailable() : opts.soonestKeyAvailable) ?? 0,
    waitForAnyKey: async () => {}, keysFor: () => [{ id: 'k1' }],
    isKeySpentFor: () => !!state.spent, clearKeySpent: async () => {},
    readQuotaError: () => typeof opts.readQuotaError === 'function' ? opts.readQuotaError() : null,
    markKeySpent: async () => { state.spent = true; },
    deny: (k, m) => denied.add(k + '::' + m),
    isDenied: (k, m) => denied.has(k + '::' + m),
    isEntitlementDenial: () => false, isRateLimit: () => false,
    learnRateLimit: () => {}, coolKeyDown: () => {},
    hasFreeKeyBudget: () => true, formatIn: () => '',
  };
  const modules = loadRendererModules(['test-response', 'test-runner']);
  const runner = modules.runner.create({
    responses: modules.responses, policy,
    getSettings: () => ({ perModelBudgetMs: 0, maxRateLimitWaits: 3, maxTestRetries: 2, ...(opts.settings || {}) }),
    isAborted: () => state.abortTesting, isMedia: () => !!opts.isMedia, isDecision: () => false,
    kindLimits: () => ({ deadline: 1000, hedge: false }),
    newUlid: () => 'ulid-1', nextRequestId: () => 'attempt-' + call, cancelRequest: () => {},
    onProgress: () => {}, runningResult: { status: 'running' },
    retryDelay: () => 1, sleep: async () => {},
    attemptOnce: async () => {
      const step = script[Math.min(call, script.length - 1)];
      call++;
      if (step && typeof step.after === 'number') await new Promise(r => setTimeout(r, step.after));
      return step && step.result ? step.result : step;
    },
  });
  return {
    run: model => runner.testModel(model, { id: 'p1', name: 'P', keys: [{ id: 'k1', key: 'x' }] }),
    state, attempts: () => call,
  };
}

const fail502 = { status: 'fail', response: 'HTTP 502', time: 5, tokens: 0, statusCode: 502, keyId: 'k1' };
const passFull = { status: 'pass', response: '4', isEmpty: false, time: 100, tokens: 5, keyId: 'k1' };

test('budget off (0): a model may fail through the whole retry ladder, no marker', async () => {
  const { run } = makeRunner([fail502, fail502, fail502, fail502]);
  const r = await run({ id: 'm1' });
  assert.strictEqual(r.status, 'fail');
  assert.strictEqual(r.budgetAborted, undefined);
  assert.strictEqual(r.attempts, 3); // initial + maxTestRetries
});

test('an empty budget expires and reports the give-up, not an endless ladder', async () => {
  const slowEmpty = { status: 'pass', response: '', isEmpty: true, time: 10, tokens: 1, keyId: 'k1' };
  const { run } = makeRunner(
    [{ after: 40, result: slowEmpty }, { after: 40, result: slowEmpty }, slowEmpty],
    { settings: { perModelBudgetMs: 30 } }
  );
  const r = await run({ id: 'm1' });
  assert.strictEqual(r.status, 'fail');
  assert.strictEqual(r.budgetAborted, true);
  assert.match(r.response, /^Gave up after \d+s — /);
});

test('a give-up during transient retries keeps the status code for the log and the 429 exclusion', async () => {
  // Every round is a 502; the budget runs out between rounds. The result keeps
  // its statusCode so the run's filters still see the truth.
  const { run } = makeRunner(
    [{ after: 30, result: fail502 }, { after: 30, result: fail502 }, fail502],
    { settings: { perModelBudgetMs: 20 } }
  );
  const r = await run({ id: 'm1' });
  assert.strictEqual(r.budgetAborted, true);
  assert.strictEqual(r.statusCode, 502);
});

test('a spent-quota give-up keeps quotaSpent: a key fact never becomes a model verdict', async () => {
  // The quota path: readQuotaError fires, the (single) key is then spent for
  // this model, so the loop would return quotaSpent — unless the budget dies
  // first, in which case the flag must still ride along.
  const quotaFail = { status: 'fail', response: 'insufficient quota', time: 5, tokens: 0, statusCode: 429, keyId: 'k1', errorCode: 'insufficient_quota' };
  const { run } = makeRunner([quotaFail, quotaFail], {
    settings: { perModelBudgetMs: 20 },
    readQuotaError: () => ({ until: null, message: 'quota' }),
  });
  const r = await run({ id: 'm1' });
  // With one key the quota path returns quotaSpent immediately (no budget
  // needed); either way it must never arrive as a plain budget fail.
  assert.strictEqual(r.quotaSpent, true);
  assert.strictEqual(r.status, 'fail');
});

test('Stop wins over the budget: an aborted run says Aborted', async () => {
  const { run, state } = makeRunner([fail502]);
  state.abortTesting = true;
  const r = await run({ id: 'm1' });
  assert.strictEqual(r.response, 'Aborted');
  assert.strictEqual(r.budgetAborted, undefined);
});

test('media models have no budget: a video model may take its minutes', async () => {
  const { run } = makeRunner(
    [{ after: 30, result: fail502 }, { after: 30, result: fail502 }, fail502],
    { settings: { perModelBudgetMs: 1 }, isMedia: true }
  );
  const r = await run({ id: 'vid-1' });
  assert.strictEqual(r.budgetAborted, undefined);
  assert.strictEqual(r.attempts, 3);
});

test('a pass always wins, budget or no budget', async () => {
  const { run } = makeRunner([passFull], { settings: { perModelBudgetMs: 90000 } });
  const r = await run({ id: 'm1' });
  assert.strictEqual(r.status, 'pass');
  assert.strictEqual(r.budgetAborted, undefined);
});

test('all keys rate limited past the budget: gives up without entering the wait', async () => {
  const { run } = makeRunner([fail502], {
    settings: { perModelBudgetMs: 5000 },
    soonestKeyAvailable: () => Date.now() + 120_000, // cooldown far past the budget
  });
  const t0 = Date.now();
  const r = await run({ id: 'm1' });
  // Returned promptly, not after the 120s cooldown.
  assert.ok(Date.now() - t0 < 5000, 'should not wait out the cooldown');
  assert.strictEqual(r.status, 'fail');
  assert.strictEqual(r.budgetAborted, true);
  assert.match(r.response, /rate limited/);
});
