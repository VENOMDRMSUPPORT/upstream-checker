// Production response parsing and classification, evaluated as a whole module.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererModules } = require('./module-loader');
const load = () => loadRendererModules(['test-response']).responses;

test('response parser uses reasoning text only when message content is empty', () => {
  const R = load();
  assert.equal(R.parseChatCompletion('{"choices":[{"message":{"reasoning_content":" 4 "}}]}').content, '4');
  assert.equal(R.parseChatCompletion('{"choices":[{"message":{"content":" four ","reasoning_content":"ignored"}}]}').content, 'four');
  assert.throws(() => R.parseChatCompletion('not json'), { name: 'SyntaxError' });
});

test('stream parser joins content, skips malformed chunks and preserves final usage', () => {
  const R = load();
  const body = 'event: message\ndata: {"choices":[{"delta":{"content":" fo"}}]}\ndata: garbage\ndata: {"choices":[{"delta":{"content":"ur "}}],"usage":{"total_tokens":7}}\ndata: [DONE]';
  const parsed = R.parseStreamedCompletion(body);
  assert.equal(parsed.content, 'four');
  assert.equal(parsed.usage.total_tokens, 7);
  assert.equal(R.parseStreamedCompletion('').content, '');
});

test('failure parser retains machine error code, key identity and retry delay', () => {
  const R = load();
  const failed = R.failFromResponse({ status: 429, elapsed: 12, body: '{"error":{"message":"Quota used","code":"quota_exceeded"}}', headers: { 'retry-after': '30' } }, 'k1');
  assert.equal(failed.response, 'Quota used');
  assert.equal(failed.errorCode, 'quota_exceeded');
  assert.equal(failed.retryAfter, 30);
  assert.equal(failed.keyId, 'k1');
  assert.equal(R.failFromResponse({ status: 502, elapsed: 1, body: '<html>bad</html>' }, 'k2').response, 'HTTP 502');
});

test('asset search prefers URL fields and distinguishes missing models from routes', () => {
  const R = load();
  assert.equal(R.findAssetUrl({ text: 'https://wrong.example', output_url: 'https://right.example/image.png' }), 'https://right.example/image.png');
  assert.equal(R.findAssetUrl({ data: [{ url: 'data:image/png;base64,abc' }] }), 'data:image/png;base64,abc');
  assert.equal(R.findAssetUrl({ data: 'nothing' }), null);
  assert.equal(R.extractMediaUrl('![image](https://example.test/a.png)'), 'https://example.test/a.png');
  assert.equal(R.isMissingRoute({ status: 404 }, 'Model not found'), false);
  assert.equal(R.isMissingRoute({ status: 404 }, 'Endpoint not found'), true);
  assert.equal(R.isMissingRoute({ status: 405 }, ''), true);
});

test('empty and transport results preserve outcome rather than invent content', () => {
  const R = load();
  const empty = R.buildEmptyResult({ prompt_tokens: 2, completion_tokens: 3 }, 8);
  assert.equal(empty.isEmpty, true);
  assert.equal(empty.tokens, 5);
  assert.equal(R.resultRank(empty), 2);
  assert.equal(R.resultRank({ status: 'pass', isEmpty: false }), 3);
  assert.equal(R.transportFailure({ status: 200 }, 'k'), null);
  assert.equal(R.transportFailure({ cancelled: true, elapsed: 4 }, 'k').cancelled, true);
  const failed = R.transportFailure({ networkError: true, error: 'lost', timedOut: true }, 'k');
  assert.equal(failed.response, 'lost');
  assert.equal(failed.timedOut, true);
  assert.equal(R.usageTokens({ input_tokens: 4, output_tokens: 6 }), 10);
  assert.equal(R.usageTokens({ total_tokens: 0, input_tokens: 4 }), 0);
});
