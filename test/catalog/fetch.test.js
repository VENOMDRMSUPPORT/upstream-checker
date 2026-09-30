const test = require('node:test');
const assert = require('node:assert');
const { createFetcher, RETRY_DELAY_MS, DEFAULT_CACHE_TTL_MS, DEFAULT_TIMEOUT_MS } = require('../../src/catalog/fetch');

const json = (body, ok = true, status = 200) => ({ ok, status, text: async () => JSON.stringify(body) });

function stub(responses) {
  const calls = [];
  let i = 0;
  return {
    calls,
    fetchImpl: async (url) => {
      calls.push(url);
      const next = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return next();
    },
  };
}

const fast = (over = {}) => createFetcher({ retryDelayMs: 1, sleep: async () => {}, ...over });

test('an answer comes back parsed with accept: application/json added', async () => {
  let seenHeaders;
  const f = fast({ fetchImpl: async (url, opts) => { seenHeaders = opts.headers; return json({ data: [1] }); } });
  assert.deepEqual(await f.fetchJson('https://x/y'), { data: [1] });
  assert.equal(seenHeaders.accept, 'application/json');
});

test('a caller header survives, and a caller-set accept wins', async () => {
  let seen;
  const f = fast({ fetchImpl: async (url, opts) => { seen = opts.headers; return json({}); } });
  await f.fetchJson('https://x/y', { Authorization: 'Bearer k', accept: 'application/json+mine' });
  assert.equal(seen.Authorization, 'Bearer k');
  assert.equal(seen.accept, 'application/json+mine');
});

test('exactly one retry on any failure, and the answer still arrives', async () => {
  const s = stub([() => { throw new Error('ECONNRESET'); }, () => json({ ok: true })]);
  const f = fast({ fetchImpl: s.fetchImpl });
  assert.deepEqual(await f.fetchJson('https://x/y'), { ok: true });
  assert.equal(s.calls.length, 2, 'a transient blip must not surface as a failure');
});

test('the retry waits one full RETRY_DELAY_MS before the second attempt', async () => {
  const delays = [];
  const s = stub([() => { throw new Error('ECONNRESET'); }, () => json({ ok: true })]);
  // The default delay, but an injected sleep: the suite proves the fetcher asks
  // for the retry pause without spending it.
  const f = createFetcher({ sleep: async (ms) => { delays.push(ms); }, fetchImpl: s.fetchImpl });
  assert.deepEqual(await f.fetchJson('https://x/y'), { ok: true });
  assert.deepEqual(delays, [RETRY_DELAY_MS], 'one pause of the built-in delay, not zero and not two');
});

test('two failures throw the second cause suffixed (retried once) — never a third attempt', async () => {
  const s = stub([() => json({}, false, 500), () => json({}, false, 503)]);
  const f = fast({ fetchImpl: s.fetchImpl });
  await assert.rejects(() => f.fetchJson('https://x/y'), /HTTP 503 \(retried once\)$/);
  assert.equal(s.calls.length, 2);
});

test('a non-2xx is a failure even though the transport worked', async () => {
  const s = stub([() => json({ error: 'no' }, false, 429), () => json({ error: 'no' }, false, 429)]);
  const f = fast({ fetchImpl: s.fetchImpl });
  await assert.rejects(() => f.fetchJson('https://x/y'), /HTTP 429/);
});

test('unparsable JSON fails and retries: a truncated payload is not a source', async () => {
  let n = 0;
  const f = fast({ fetchImpl: async () => { n += 1; return { ok: true, status: 200, text: async () => '{"data":[' }; } });
  await assert.rejects(() => f.fetchJson('https://x/y'), /retried once/);
  assert.equal(n, 2);
});

test('an abort is reported as a timeout, in seconds', async () => {
  const f = createFetcher({
    retryDelayMs: 1, sleep: async () => {}, timeoutMs: 20000,
    fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); },
  });
  await assert.rejects(() => f.fetchJson('https://x/y'), /timed out after 20s \(retried once\)/);
});

test('the transport is handed an AbortSignal for the request', async () => {
  const f = createFetcher({ retryDelayMs: 1, sleep: async () => {}, timeoutMs: 5000,
    fetchImpl: async (url, opts) => { assert.ok(opts.signal, 'the abort signal is passed through'); return json({}); } });
  assert.deepEqual(await f.fetchJson('https://x/y'), {});
});

test('the deadline is armed at the caller timeout and aborts a request that outlives it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals = [];
  let attempt = 0;
  const f = createFetcher({ timeoutMs: 5000, retryDelayMs: 1, sleep: async () => {},
    fetchImpl: async (url, opts) => {
      attempt += 1;
      signals.push(opts.signal);
      if (attempt === 1) {
        // Stays open until its own deadline closes it.
        await new Promise((_, reject) => opts.signal.addEventListener('abort',
          () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      }
      return json({ attempt });
    } });
  const pending = f.fetchJson('https://x/y');
  assert.equal(signals.length, 1, 'the first attempt reached the transport');

  t.mock.timers.tick(4999);
  assert.equal(signals[0].aborted, false, 'nothing fires before the deadline the caller asked for');
  t.mock.timers.tick(1);
  assert.equal(signals[0].aborted, true, 'the deadline fires the abort at exactly timeoutMs');
  assert.deepEqual(await pending, { attempt: 2 }, 'the retry answers inside its own deadline');
});

test('the deadline is cleared the moment an answer arrives, so it cannot abort a finished request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const f = createFetcher({ timeoutMs: 5000, retryDelayMs: 1, sleep: async () => {},
    fetchImpl: async (url, opts) => { signal = opts.signal; return json({ answered: true }); } });
  assert.deepEqual(await f.fetchJson('https://x/y'), { answered: true });

  t.mock.timers.tick(60000);
  assert.equal(signal.aborted, false, 'the armed deadline was cleared, not left behind to fire');
});

test('fetchJsonCached shares one in-flight download between concurrent callers', async () => {
  const s = stub([() => json({ big: true })]);
  const f = fast({ fetchImpl: s.fetchImpl });
  const [a, b] = await Promise.all([f.fetchJsonCached('https://x/big'), f.fetchJsonCached('https://x/big')]);
  assert.equal(a, b, 'the same object, one download');
  assert.equal(s.calls.length, 1);
});

test('a cached document is reused inside its ttl and refetched once the ttl has passed', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1760000000000 });
  const f = createFetcher({ retryDelayMs: 1, sleep: async () => {}, cacheTtlMs: 5000,
    fetchImpl: async () => json({ fetchedAt: Date.now() }) });

  const first = await f.fetchJsonCached('https://x/doc');
  t.mock.timers.tick(4999);
  assert.deepEqual(await f.fetchJsonCached('https://x/doc'), first, 'inside the ttl nothing is downloaded again');
  t.mock.timers.tick(2);
  const third = await f.fetchJsonCached('https://x/doc');
  assert.notDeepEqual(third, first, 'past the ttl the document is fetched again, not served forever');
});

test('a failed cached fetch is evicted so the next caller retries', async () => {
  const s = stub([() => { throw new Error('down'); }, () => { throw new Error('down'); }, () => json({ up: true })]);
  const f = fast({ fetchImpl: s.fetchImpl });
  await assert.rejects(() => f.fetchJsonCached('https://x/y'));
  assert.deepEqual(await f.fetchJsonCached('https://x/y'), { up: true });
});

test('the dedup is keyed by url, so two documents never share a payload', async () => {
  const seen = [];
  const f = fast({ fetchImpl: async (url) => { seen.push(url); return json({ url }); } });
  await Promise.all([f.fetchJsonCached('https://x/a'), f.fetchJsonCached('https://x/b')]);
  assert.deepEqual(seen.sort(), ['https://x/a', 'https://x/b']);
});

test('the constants are the ones spec §11 names', () => {
  assert.equal(RETRY_DELAY_MS, 400);
  assert.equal(DEFAULT_CACHE_TTL_MS, 60000);
  assert.equal(DEFAULT_TIMEOUT_MS, 20000);
});
