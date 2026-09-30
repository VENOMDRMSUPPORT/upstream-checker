'use strict';

// The four upstream documents that feed the reference catalog, how each is
// fetched, and how its payload is cached on disk. No in-memory state lives here
// — src/catalog/engine.js owns that.

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic');
const { indexModelsDev, indexOpenRouterModels } = require('./build');

const SOURCES = [
  {
    id: 'models-dev-spec',
    name: 'models.dev (spec)',
    url: 'https://models.dev/api.json',
    auth: false,
    description: 'Limits, modalities, capabilities, catalog prices, release dates',
  },
  {
    id: 'openrouter-public',
    name: 'OpenRouter (models)',
    url: 'https://openrouter.ai/api/v1/models',
    auth: false,
    description: 'Live pricing, parameters, architecture, hosted limits',
  },
  {
    id: 'openrouter-keyed',
    name: 'OpenRouter (benchmarks)',
    url: 'https://openrouter.ai/api/v1/benchmarks',
    auth: true,
    description: 'Independent AA indices and Design Arena Elo',
  },
  {
    id: 'lmarena',
    name: 'LMArena (text)',
    url: 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset',
    auth: false,
    description: 'Human Arena Elo from text overall + Code Arena (webdev)',
  },
];

const ARENA_ROWS = 'https://datasets-server.huggingface.co/rows';
const ARENA_PAGE = 100;
const ARENA_MAX_OFFSET = 800;

function arenaUrl(config, offset) {
  return `${ARENA_ROWS}?dataset=lmarena-ai/leaderboard-dataset&config=${config}`
    + `&split=latest&offset=${offset}&length=${ARENA_PAGE}`;
}

const dataPath = (dir, id) => path.join(dir, `${id}.json`);
const metaPath = (dir, id) => path.join(dir, `${id}.meta.json`);

function createSources({ cacheDir, fetcher, readKey = () => '' }) {
  async function fetchBoard(config) {
    const data = [];
    for (let offset = 0; offset < ARENA_MAX_OFFSET; offset += ARENA_PAGE) {
      const payload = await fetcher.fetchJson(arenaUrl(config, offset));
      const rows = (payload && payload.rows) || [];
      if (!rows.length) break;
      let done = false;
      for (const entry of rows) {
        const row = (entry && entry.row) || {};
        // The board interleaves categories; "overall" names each model once.
        // Anything else means the overall section has ended.
        if (row.category && row.category !== 'overall') { done = true; break; }
        if (!row.model_name) continue;
        data.push({
          model_name: row.model_name,
          organization: row.organization || '',
          rating: row.rating,
          rank: row.rank,
          vote_count: row.vote_count,
          board: config,
        });
      }
      if (done || rows.length < ARENA_PAGE) break;
    }
    return data;
  }

  async function fetchOne(source) {
    const at = new Date().toISOString();
    if (source.id === 'lmarena') {
      const [data, webdev] = await Promise.all([fetchBoard('text'), fetchBoard('webdev')]);
      return { id: source.id, payload: { data, webdev }, at };
    }
    if (source.id === 'models-dev-spec') {
      // Cached by url, so a source sync and a provider load that want the same
      // 4.9 MB document pay for it once between them.
      return { id: source.id, payload: await fetcher.fetchJsonCached(source.url), at };
    }
    const headers = {};
    if (source.auth) {
      const key = readKey();
      if (!key) throw new Error(`${source.name} is not set: no OpenRouter key. Add it in Settings › Catalog.`);
      headers.Authorization = `Bearer ${key}`;
      headers['HTTP-Referer'] = 'https://venom-router.local';
      headers['X-OpenRouter-Title'] = 'Venom Router';
    }
    return { id: source.id, payload: await fetcher.fetchJson(source.url, headers), at };
  }

  // Never rejects for a source failure — deciding what a dead source means is
  // the engine's job, and one dead board must not cost the other three.
  async function fetchAll() {
    return Promise.all(SOURCES.map(async (source) => {
      try {
        const { payload, at } = await fetchOne(source);
        return { id: source.id, source, payload, at, error: null };
      } catch (error) {
        return {
          id: source.id, source, payload: null,
          at: new Date().toISOString(), error: error.message || 'fetch failed',
        };
      }
    }));
  }

  function writeCache(id, payload, meta) {
    fs.mkdirSync(cacheDir, { recursive: true });
    writeJsonAtomic(dataPath(cacheDir, id), payload);
    writeJsonAtomic(metaPath(cacheDir, id), meta);
  }

  /** Records an unsuccessful attempt without touching the last-good payload. */
  function writeCacheFailure(id, message, attemptedAt) {
    if (!fs.existsSync(dataPath(cacheDir, id)) || !fs.existsSync(metaPath(cacheDir, id))) return false;
    let previous;
    try {
      previous = JSON.parse(fs.readFileSync(metaPath(cacheDir, id), 'utf8'));
    } catch (_) {
      return false;
    }
    writeJsonAtomic(metaPath(cacheDir, id),
      { ...previous, lastAttemptAt: attemptedAt, error: message, stale: true });
    return true;
  }

  function readCache(id) {
    if (!fs.existsSync(dataPath(cacheDir, id)) || !fs.existsSync(metaPath(cacheDir, id))) return null;
    return {
      payload: JSON.parse(fs.readFileSync(dataPath(cacheDir, id), 'utf8')),
      meta: JSON.parse(fs.readFileSync(metaPath(cacheDir, id), 'utf8')),
    };
  }

  /** Usable rows after indexing, not document size — the number the UI shows. */
  function rowCount(id, payload) {
    if (id === 'models-dev-spec') return indexModelsDev(payload).size;
    if (id === 'openrouter-public') return indexOpenRouterModels(payload).length;
    if (id === 'openrouter-keyed') return payload && Array.isArray(payload.data) ? payload.data.length : 0;
    if (id === 'lmarena') {
      const data = payload && Array.isArray(payload.data) ? payload.data.length : 0;
      const web = payload && Array.isArray(payload.webdev) ? payload.webdev.length : 0;
      return data + web;
    }
    return 0;
  }

  function newestFetchedAt() {
    let newest = null;
    for (const source of SOURCES) {
      let meta;
      try { meta = readCache(source.id); } catch (_) { continue; }
      const at = meta && meta.meta && meta.meta.fetchedAt;
      if (at && (!newest || at > newest)) newest = at;
    }
    return newest;
  }

  function hasPayload(id) {
    return fs.existsSync(dataPath(cacheDir, id));
  }

  return {
    SOURCES, fetchOne, fetchAll, readCache, writeCache, writeCacheFailure,
    rowCount, newestFetchedAt, hasPayload, readKey, cacheDir,
  };
}

module.exports = { SOURCES, createSources };
