const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSources, SOURCES } = require('../../src/catalog/sources');
const { createFetcher } = require('../../src/catalog/fetch');
const { tempDir } = require('../helpers');

const IDS = ['models-dev-spec', 'openrouter-public', 'openrouter-keyed', 'lmarena'];

function responder(bodies) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, headers: opts.headers });
    const hit = Object.entries(bodies).find(([needle]) => url.includes(needle));
    if (!hit) return { ok: false, status: 404, text: async () => '{}' };
    return { ok: true, status: 200, text: async () => JSON.stringify(hit[1]) };
  };
  return { calls, fetcher: createFetcher({ retryDelayMs: 1, sleep: async () => {}, fetchImpl }) };
}

test('exactly four sources, in the reference order, with the reference urls', () => {
  assert.deepEqual(SOURCES.map((s) => s.id), IDS);
  assert.equal(SOURCES[0].url, 'https://models.dev/api.json');
  assert.equal(SOURCES[1].url, 'https://openrouter.ai/api/v1/models');
  assert.equal(SOURCES[2].url, 'https://openrouter.ai/api/v1/benchmarks');
  assert.equal(SOURCES[3].url, 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset');
  assert.equal(SOURCES[2].auth, true, 'only the benchmark feed is keyed');
  assert.equal(SOURCES[0].auth, false);
});

test('the keyed source sends the bearer, and refuses before any request with no key', async (t) => {
  const { calls, fetcher } = responder({ '/benchmarks': { data: [] } });
  const sources = createSources({ cacheDir: tempDir(t), fetcher, readKey: () => 'rk' });
  await sources.fetchOne(SOURCES[2]);
  assert.equal(calls[0].headers.Authorization, 'Bearer rk');
  // The one difference the original could not carry over: it sent its own
  // loopback origin, `http://127.0.0.1:<PORT>`. This app listens on no port.
  assert.equal(calls[0].headers['HTTP-Referer'], 'https://venom-router.local');
  assert.equal(calls[0].headers['X-OpenRouter-Title'], 'Venom Router');

  let touched = 0;
  const noKey = createSources({
    cacheDir: tempDir(t), readKey: () => '',
    fetcher: createFetcher({ retryDelayMs: 1, sleep: async () => {},
      fetchImpl: () => { touched += 1; throw new Error('must not be called'); } }),
  });
  await assert.rejects(() => noKey.fetchOne(SOURCES[2]), /not set|needs an.*key/i);
  assert.equal(touched, 0, 'the throw comes before the request');
});

test('LMArena pages 100 rows a time and stops at a short page, not at the 800 cap', async (t) => {
  let seen = 0;
  const page = (n, offset) => ({ rows: Array.from({ length: n }, (_, i) => ({
    row: { model_name: `m${offset + i}`, category: 'overall', rating: 1200, rank: offset + i + 1, vote_count: 5 },
  })) });
  const fetcher = createFetcher({ retryDelayMs: 1, sleep: async () => {}, fetchImpl: async (url) => {
    const u = new URL(url);
    const offset = Number(u.searchParams.get('offset'));
    seen += 1;
    const n = u.searchParams.get('config') === 'text' ? (offset < 200 ? 100 : offset === 200 ? 5 : 0) : 5;
    return { ok: true, status: 200, text: async () => JSON.stringify(page(n, offset)) };
  } });
  const sources = createSources({ cacheDir: tempDir(t), fetcher, readKey: () => '' });
  const { payload } = await sources.fetchOne(SOURCES[3]);
  assert.equal(payload.data.length, 205);
  assert.equal(payload.webdev.length, 5);
  assert.equal(seen, 4, 'two text pages plus the short one, plus one webdev page');
});

test('every arena page is a 100-row datasets-server request and the walk stops at the 800 cap', async (t) => {
  const pages = [];
  // Rows keep coming, so only the offset cap can end the walk: without it this
  // stub would be asked forever.
  const fetcher = createFetcher({ retryDelayMs: 1, sleep: async () => {}, fetchImpl: async (url) => {
    pages.push(new URL(url));
    return { ok: true, status: 200, text: async () => JSON.stringify({
      rows: Array.from({ length: 100 }, (_, i) => ({
        row: { model_name: `m${i}`, category: 'overall', rating: 1200, rank: i + 1, vote_count: 5 },
      })),
    }) };
  } });
  const sources = createSources({ cacheDir: tempDir(t), fetcher, readKey: () => '' });
  const { payload } = await sources.fetchOne(SOURCES[3]);

  for (const page of pages) {
    assert.equal(`${page.protocol}//${page.host}${page.pathname}`,
      'https://datasets-server.huggingface.co/rows', `the rows route, not ${page.origin}`);
    assert.equal(page.searchParams.get('dataset'), 'lmarena-ai/leaderboard-dataset');
    assert.equal(page.searchParams.get('split'), 'latest');
    assert.equal(page.searchParams.get('length'), '100', 'ARENA_PAGE rows per request');
    assert.ok(Number(page.searchParams.get('offset')) < 800, 'ARENA_MAX_OFFSET: nothing past 800 is asked for');
  }
  const offsets = (config) => pages.filter((p) => p.searchParams.get('config') === config)
    .map((p) => Number(p.searchParams.get('offset')));
  const walk = [0, 100, 200, 300, 400, 500, 600, 700];
  assert.deepEqual(offsets('text'), walk, 'the text board walks to 700 and stops before 800');
  assert.deepEqual(offsets('webdev'), walk, 'the webdev board walks the same way');
  assert.equal(payload.data.length, 800);
  assert.equal(payload.webdev.length, 800);
});

test('both LMArena boards are in flight at once — neither waits for the other to finish', async (t) => {
  const started = [];
  let releaseHeldRequest = null;
  let serialised = false;
  const fetcher = createFetcher({ retryDelayMs: 1, sleep: async () => {}, fetchImpl: async (url) => {
    const config = new URL(url).searchParams.get('config');
    started.push(config);
    if (started.length === 1) {
      // The first board's request stays open until the second board asks for a
      // page of its own. Fetched one after the other, that never happens.
      await new Promise((resolve) => {
        releaseHeldRequest = resolve;
        const bail = setTimeout(() => { serialised = true; resolve(); }, 250);
        bail.unref && bail.unref();
      });
    } else if (releaseHeldRequest) {
      releaseHeldRequest();
    }
    const row = { model_name: `${config}-1`, category: 'overall', rating: 1, rank: 1, vote_count: 1 };
    return { ok: true, status: 200,
      text: async () => JSON.stringify({ rows: [{ row }] }) };
  } });
  const sources = createSources({ cacheDir: tempDir(t), fetcher, readKey: () => '' });
  const { payload } = await sources.fetchOne(SOURCES[3]);

  assert.equal(serialised, false, 'the second board reached the transport while the first was still open');
  assert.deepEqual(started, ['text', 'webdev'], 'one page of each board, both started together');
  assert.deepEqual(payload.data.map((r) => r.model_name), ['text-1']);
  assert.deepEqual(payload.webdev.map((r) => r.model_name), ['webdev-1']);
});

test('a row whose category is not overall ends that board and is not kept', async (t) => {
  const fetcher = createFetcher({ retryDelayMs: 1, sleep: async () => {}, fetchImpl: async () => ({
    ok: true, status: 200, text: async () => JSON.stringify({ rows: [
      { row: { model_name: 'keep', category: 'overall', rating: 1, rank: 1, vote_count: 1 } },
      { row: { model_name: 'drop', category: 'coding', rating: 2, rank: 2, vote_count: 2 } },
      { row: { model_name: 'never', category: 'overall', rating: 3, rank: 3, vote_count: 3 } },
    ] }),
  }) });
  const sources = createSources({ cacheDir: tempDir(t), fetcher, readKey: () => '' });
  const { payload } = await sources.fetchOne(SOURCES[3]);
  assert.deepEqual(payload.data.map((r) => r.model_name), ['keep']);
});

test('a failure after a success keeps the payload and marks the source stale', async (t) => {
  const dir = tempDir(t);
  const good = { data: [{ id: 'a/b', name: 'A' }] };
  const ok = createFetcher({ retryDelayMs: 1, sleep: async () => {},
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(good) }) });
  const sources = createSources({ cacheDir: dir, fetcher: ok, readKey: () => '' });
  const source = SOURCES[1];
  const { at } = await sources.fetchOne(source);
  sources.writeCache(source.id, good,
    { fetchedAt: at, lastAttemptAt: at, error: null, stale: false, rowCount: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'openrouter-public.json'), 'utf8')), good);

  const dead = createFetcher({ retryDelayMs: 1, sleep: async () => {},
    fetchImpl: async () => { throw new Error('socket hang up'); } });
  const s2 = createSources({ cacheDir: dir, fetcher: dead, readKey: () => '' });
  await assert.rejects(() => s2.fetchOne(source));
  assert.equal(s2.writeCacheFailure(source.id, 'socket hang up', '2026-09-30T00:00:00.000Z'), true);

  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'openrouter-public.meta.json'), 'utf8'));
  assert.equal(meta.error, 'socket hang up');
  assert.equal(meta.stale, true);
  assert.equal(meta.fetchedAt, at, 'a failure does not overwrite when the rows were fetched');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'openrouter-public.json'), 'utf8')), good,
    'a failed refresh never replaces the payload');
});

test('writeCacheFailure says false when nothing was ever cached, so a first-run failure is not stale', (t) => {
  const sources = createSources({ cacheDir: tempDir(t), fetcher: createFetcher({}), readKey: () => '' });
  assert.equal(sources.writeCacheFailure('lmarena', 'boom', '2026-09-30T00:00:00.000Z'), false);
});

test('readCache is null until both files exist', (t) => {
  const dir = tempDir(t);
  const sources = createSources({ cacheDir: dir, fetcher: createFetcher({}), readKey: () => '' });
  assert.equal(sources.readCache('lmarena'), null);
  fs.writeFileSync(path.join(dir, 'lmarena.json'), '{}');
  assert.equal(sources.readCache('lmarena'), null, 'the payload alone is not a cache');
});

test('rowCount counts usable rows after indexing, not document size', (t) => {
  const sources = createSources({ cacheDir: tempDir(t), fetcher: createFetcher({}), readKey: () => '' });
  assert.equal(sources.rowCount('openrouter-public', { data: [{ id: 'a/b' }, { name: 'no id' }] }), 1);
  assert.equal(sources.rowCount('openrouter-keyed', { data: [{ model_permaslug: 'a' }] }), 1);
  assert.equal(sources.rowCount('lmarena', { data: [1, 2], webdev: [3] }), 3);
  assert.equal(sources.rowCount('lmarena', null), 0);
  assert.equal(sources.rowCount('unknown-source', { data: [1] }), 0);
});

test('newestFetchedAt is the newest meta timestamp across the four, or null', (t) => {
  const dir = tempDir(t);
  const sources = createSources({ cacheDir: dir, fetcher: createFetcher({}), readKey: () => '' });
  assert.equal(sources.newestFetchedAt(), null);
  sources.writeCache('lmarena', { data: [], webdev: [] },
    { fetchedAt: '2026-09-30T10:00:00.000Z', lastAttemptAt: '2026-09-30T10:00:00.000Z', error: null, stale: false, rowCount: 0 });
  sources.writeCache('openrouter-public', { data: [] },
    { fetchedAt: '2026-09-30T11:00:00.000Z', lastAttemptAt: '2026-09-30T11:00:00.000Z', error: null, stale: false, rowCount: 0 });
  assert.equal(sources.newestFetchedAt(), '2026-09-30T11:00:00.000Z');
});

test('models.dev shares one download with any other caller of the same url', async (t) => {
  let n = 0;
  const fetcher = createFetcher({ retryDelayMs: 1, sleep: async () => {}, fetchImpl: async () => {
    n += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ a: { models: { m: { id: 'm' } } } }) };
  } });
  const sources = createSources({ cacheDir: tempDir(t), fetcher, readKey: () => '' });
  await Promise.all([sources.fetchOne(SOURCES[0]), sources.fetchOne(SOURCES[0])]);
  assert.equal(n, 1, 'the 4.9 MB document is downloaded once per cycle, not once per caller');
});

test('fetchAll reports each source and never rejects for one failure', async (t) => {
  const fetcher = createFetcher({ retryDelayMs: 1, sleep: async () => {}, fetchImpl: async (url) => {
    if (url.includes('models.dev')) throw new Error('gone');
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [], rows: [] }) };
  } });
  const sources = createSources({ cacheDir: tempDir(t), fetcher, readKey: () => 'k' });
  const results = await sources.fetchAll();
  assert.equal(results.length, 4);
  // The whole cause as fetchJson reports it, retry suffix included: a source
  // that failed twice is recorded as failing twice, and fetchAll passes the
  // message through untouched rather than re-wording it.
  assert.equal(results.find((r) => r.id === 'models-dev-spec').error, 'gone (retried once)');
  assert.equal(results.find((r) => r.id === 'lmarena').error, null);
});
