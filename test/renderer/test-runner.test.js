// Hedging and retry behavior through the production runner factory.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererModules } = require('./module-loader');

function makeRunner(attemptOnce, extra = {}) {
  const cancellations = [];
  const state = { aborted: false, settings: { hedgeMax: 3, hedgeStepMs: 10, maxTestRetries: 2, maxRateLimitWaits: 0, perModelBudgetMs: 0 } };
  let seq = 0;
  const R = loadRendererModules(['test-response', 'test-policy', 'test-runner']);
  const policy = R.policy.create({ usableKeys: p => p.keys, getProviders: () => ({}), isAborted: () => state.aborted, setStatus: () => {}, sleep: async () => {} });
  const runner = R.runner.create({
    responses: R.responses, policy, attemptOnce, getSettings: () => state.settings,
    isAborted: () => state.aborted, isMedia: m => m.kind === 'video', isDecision: m => m.kind === 'decision',
    kindLimits: () => ({ deadline: 1000, hedge: true }), nextRequestId: () => `r${++seq}`,
    cancelRequest: (id, reason) => cancellations.push({ id, reason }),
    onProgress: () => {}, runningResult: { status: 'running' }, newUlid: () => 'group',
    sleep: async () => {}, retryDelay: () => 1, ...extra,
  });
  return { runner, state, cancellations };
}
const provider = { id: 'p', keys: [{ id: 'k' }] };
const pass = { status: 'pass', response: '4', isEmpty: false, time: 1, tokens: 1 };

test('a race winner cancels all minted request ids as hedge losers', async () => {
  const { runner, cancellations } = makeRunner(async () => pass);
  assert.equal((await runner.raceAttempts({ id: 'm' }, provider, true, 2)).response, '4');
  assert.deepEqual(cancellations, [{ id: 'r1', reason: 'hedge_lost' }, { id: 'r2', reason: 'hedge_lost' }]);
});

test('an empty reply stops adaptive escalation rather than spending all hedge slots', async () => {
  let calls = 0;
  const { runner } = makeRunner(async () => { calls++; return { status: 'pass', isEmpty: true, tokens: 0 }; });
  const result = await runner.adaptiveNonStream({ id: 'm' }, provider);
  assert.equal(result.isEmpty, true);
  assert.equal(calls, 1);
});

test('Stop while an attempt is in flight resolves promptly with the stop reason', async () => {
  let finish;
  const { runner, state, cancellations } = makeRunner(() => new Promise(resolve => { finish = resolve; }));
  const result = runner.adaptiveNonStream({ id: 'm' }, provider);
  state.aborted = true;
  finish({ status: 'fail', cancelled: true });
  assert.equal((await result).response, 'Aborted');
  assert.deepEqual(cancellations, [{ id: 'r1', reason: 'stop' }]);
});

test('decision transport failures are not duplicated by transient retries', async () => {
  let calls = 0;
  const { runner } = makeRunner(async () => { calls++; return { status: 'fail', networkError: true, statusCode: 0 }; }, { kindLimits: () => ({ deadline: 1000, hedge: false }) });
  const result = await runner.testModel({ id: 'm', kind: 'decision' }, provider);
  assert.equal(result.status, 'fail');
  assert.equal(calls, 1);
  assert.equal(result.attempts, 1);
});

test('a settings replacement controls the next model retry count', async () => {
  let calls = 0;
  const { runner, state } = makeRunner(async () => { calls++; return { status: 'fail', statusCode: 502 }; }, { kindLimits: () => ({ deadline: 1000, hedge: false }) });
  state.settings = { ...state.settings, maxTestRetries: 0 };
  assert.equal((await runner.testModel({ id: 'm' }, provider)).attempts, 1);
  assert.equal(calls, 1);
});
