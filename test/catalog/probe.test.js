const test = require('node:test');
const assert = require('node:assert');
const { probeModel } = require('../../src/catalog/probe');

// Capability probes (foundation rebuild R2): verdicts come from real
// dispatch outcomes, and a probe that observes nothing records
// nothing — unknown stays unknown.

const ROUTE = { keyId: 'k1', providerId: 'p1', modelId: 'm1' };

function harness(dispatchImpl) {
  const records = [];
  return { records, dispatch: dispatchImpl, record: (e) => records.push(e) };
}

test('a model that answers and calls the tool earns both verdicts', async () => {
  const h = harness(async (_route, payload) => {
    if (payload.body.tools) return { text: '', toolCalls: [{ id: 'c1', type: 'function' }] };
    return { text: 'ok', toolCalls: null };
  });
  const verdict = await probeModel({ dispatch: h.dispatch, route: ROUTE, record: h.record });
  assert.deepStrictEqual(verdict, { chatOk: true, toolsObserved: true });
  assert.deepStrictEqual(h.records.map((r) => [r.kind, r.ok]), [['chat', true], ['tools', true]]);
});

test('a model that answers but returns no tool call records tools as not observed', async () => {
  const h = harness(async () => ({ text: 'ok', toolCalls: null }));
  const verdict = await probeModel({ dispatch: h.dispatch, route: ROUTE, record: h.record });
  assert.deepStrictEqual(verdict, { chatOk: true, toolsObserved: false });
  assert.deepStrictEqual(h.records.map((r) => [r.kind, r.ok]), [['chat', true], ['tools', false]]);
});

test('a failed chat probe records the failure and never runs the tools probe', async () => {
  let calls = 0;
  const h = harness(async () => { calls += 1; throw new Error('upstream answered 402'); });
  const verdict = await probeModel({ dispatch: h.dispatch, route: ROUTE, record: h.record });
  assert.deepStrictEqual(verdict, { chatOk: false, toolsObserved: null });
  assert.equal(calls, 1);
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0].kind, 'chat');
  assert.equal(h.records[0].ok, false);
  assert.match(h.records[0].detail, /402/);
});

test('a tools call that itself errors records nothing for tools', async () => {
  const h = harness(async (_route, payload) => {
    if (payload.body.tools) throw new Error('tools unsupported upstream');
    return { text: 'ok', toolCalls: null };
  });
  const verdict = await probeModel({ dispatch: h.dispatch, route: ROUTE, record: h.record });
  assert.deepStrictEqual(verdict, { chatOk: true, toolsObserved: null });
  assert.deepStrictEqual(h.records.map((r) => r.kind), ['chat']);
});
