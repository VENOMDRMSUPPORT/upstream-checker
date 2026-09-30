'use strict';

// Owns the in-memory copy of the four sources and the reference built from them,
// and hands out exactly what the rest of the app needs:
//   loadCache / syncAll   keep the sources fresh
//   scoreRows(rows)       give provider rows their score and rank
//   summary / health      status for Settings
//   isNonTextModel        the third proof that a listing is a generator
//
// Providers never depend on this for their model list — only for score, rank,
// and whatever blank metadata a thin row borrows. With nothing synced, scoreRows
// leaves both null and the page reads "Unrated".
//
// The reference is never persisted: it comes back from the four cached payloads
// at boot (~210 ms) and after every sync, so a row is always scored against
// today's reference rather than the one the provider last answered.

const { buildCatalog } = require('./build');
const { attachScores, buildMatchIndex, lookupCatalogRow } = require('./scoring');

// Gates the per-row Fetch information button's network pass (spec §6): the merge
// costs ~210 ms and always runs; re-downloading ~5 MB across four endpoints only
// runs when the newest payload is older than this.
const SOURCE_SYNC_MIN_AGE_MS = 15 * 60 * 1000;

/**
 * One cached source, as the engine holds it. All six fields, always: the
 * original declared four, wrote the error-stub branch to match that, and so a
 * source cached in an error state became the one kind that never reported itself
 * stale (ref lib/engine.js:19-29, and the case that test pins below).
 *
 * @typedef {{fetchedAt: string|null, lastAttemptAt: string|null, error: string|null,
 *   stale: boolean, rowCount: number, payload: unknown}} SourceEntry
 */
function emptySource() {
  return { fetchedAt: null, lastAttemptAt: null, error: null, stale: false, rowCount: 0, payload: null };
}

function createEngine({ sources, minAgeMs = SOURCE_SYNC_MIN_AGE_MS, log = () => {} }) {
  const state = {
    /** @type {Record<string, SourceEntry>} */
    sourceStore: {},
    catalog: { fetchedAt: null, rows: [], byId: new Map(), fits: {}, nonTextIndex: null },
    lastSyncAt: null,
    syncing: false,
  };

  for (const source of sources.SOURCES) state.sourceStore[source.id] = emptySource();

  // An id the current reference cannot score. Without this, every pass re-fetches
  // four sources hoping one model shows up, forever.
  const unscorable = new Set();

  const payloadOf = (id) => {
    const entry = state.sourceStore[id];
    return entry && entry.payload ? entry.payload : null;
  };

  function rebuild() {
    const merged = buildCatalog({
      spec: payloadOf('models-dev-spec'),
      openrouter: payloadOf('openrouter-public'),
      benchmarks: payloadOf('openrouter-keyed'),
      lmarena: payloadOf('lmarena'),
    });
    state.catalog = {
      fetchedAt: state.lastSyncAt,
      rows: merged.rows,
      byId: merged.byId,
      fits: merged.fits,
      // Not part of the reference — the opposite of it. Kept so a provider that
      // publishes no modality can still be told one of its listings is a
      // generator (ref §3 step 4).
      nonTextIndex: buildMatchIndex(merged.nonText || []),
    };
    const measured = merged.rows.filter((r) => r.score_source === 'aa').length;
    const estimated = merged.rows.filter((r) => r.score_source === 'est').length;
    log(`catalog rows=${merged.rows.length} measured=${measured} estimated=${estimated}`
      + ` unrated=${merged.rows.length - measured - estimated}`
      + ` fits=${JSON.stringify(merged.fits)}`);
  }

  /** Read every cached source from disk and build the reference. Safe when empty. */
  function loadCache() {
    let newest = null;
    for (const source of sources.SOURCES) {
      let cached;
      try {
        cached = sources.readCache(source.id);
      } catch (error) {
        state.sourceStore[source.id] = { ...emptySource(), error: `cache read failed: ${error.message}` };
        continue;
      }
      if (!cached) continue;
      const { payload, meta } = cached;
      const errorStub = meta.error && payload && typeof payload === 'object'
        && Object.keys(payload).length === 1 && typeof payload.error === 'string';
      // Both branches spread emptySource so all six fields always exist.
      state.sourceStore[source.id] = errorStub
        ? {
          ...emptySource(),
          fetchedAt: meta.fetchedAt || null,
          lastAttemptAt: meta.lastAttemptAt || meta.fetchedAt || null,
          error: meta.error,
          stale: true,
        }
        : {
          fetchedAt: meta.fetchedAt || null,
          lastAttemptAt: meta.lastAttemptAt || meta.fetchedAt || null,
          error: meta.error || null,
          stale: Boolean(meta.stale || meta.error),
          rowCount: sources.rowCount(source.id, payload),
          payload,
        };
      if (meta.fetchedAt && (!newest || meta.fetchedAt > newest)) newest = meta.fetchedAt;
    }
    state.lastSyncAt = newest;
    rebuild();
  }

  function storeFetched(source, payload, at) {
    const rowCount = sources.rowCount(source.id, payload);
    state.sourceStore[source.id] = { fetchedAt: at, lastAttemptAt: at, error: null, stale: false, rowCount, payload };
    sources.writeCache(source.id, payload,
      { fetchedAt: at, lastAttemptAt: at, error: null, stale: false, rowCount });
  }

  function storeFailed(source, message, at) {
    const previous = state.sourceStore[source.id] || emptySource();
    state.sourceStore[source.id] = {
      ...previous, lastAttemptAt: at, error: message, stale: Boolean(previous.payload),
    };
    sources.writeCacheFailure(source.id, message, at);
  }

  function ageOfNewest() {
    const at = sources.newestFetchedAt();
    if (!at) return Infinity;
    const t = Date.parse(at);
    return Number.isFinite(t) ? Date.now() - t : Infinity;
  }

  /**
   * @param {{ force?: boolean }} opts  force ignores the TTL. The toolbar button,
   *   the background timer and the unscored trigger pass force; the per-row Fetch
   *   information button does not, so a click seconds after a sync re-merges in
   *   210 ms instead of paying five megabytes.
   */
  async function syncAll({ force = false } = {}) {
    if (state.syncing) {
      const error = new Error('sync already in progress');
      error.code = 'SYNC_IN_PROGRESS';
      throw error;
    }
    if (!force && ageOfNewest() < minAgeMs) {
      rebuild();
      return { ...summary(), skipped: true };
    }
    state.syncing = true;
    try {
      // The reference settled each source itself with Promise.allSettled; here
      // sources.fetchAll() already settled them, so the decision "a source
      // failed" lives in exactly one file and never rejects up through here.
      const results = await sources.fetchAll();
      const started = new Date().toISOString();
      for (const result of results) {
        const source = { id: result.id };
        if (result.error) storeFailed(source, result.error, started);
        else storeFetched(source, result.payload, started);
      }
      state.lastSyncAt = started;
      rebuild();
      // Nothing here touches `unscorable`, and that is the whole point of the
      // set: "the reference scores SOMETHING" is true of almost every sync, so
      // clearing on it would give a permanently unknown model a fresh four-source
      // download on every forced sync — the toolbar button and the background
      // timer included, which is the opposite of the comment above the set. The
      // reference never had such a line: its `unscorable` lives in the poller and
      // is revisited only by that comparison (ref lib/poller.js:154-156), so the
      // port's version of it is the bug and this file keeps only the comparative.
    } finally {
      // Before the summary is built, not after: the reference returns
      // summary() from inside the try, so the object its caller awaits says
      // `syncing: true` for a sync that has already finished. Spec §7's Settings
      // status block reads that object, so the port does not inherit it.
      state.syncing = false;
    }
    // Both exits of syncAll have one shape. `skipped` is present and false here
    // rather than absent, for the reason this file already records about
    // `stale` and `lastAttemptAt`: a flag that is missing reads as silence, and
    // Task 10's own engine seam already returns `skipped: !force`.
    return { ...summary(), skipped: false };
  }

  function scoreRows(rows) {
    return attachScores(rows, state.catalog.rows);
  }

  /** Rows scored against the current reference, without touching the caller's copies. */
  function scoredClone(rows) {
    return attachScores((rows || []).map((row) => ({ ...row })), state.catalog.rows);
  }

  function isNonTextModel(row) {
    if (!state.catalog.nonTextIndex) return false;
    return Boolean(lookupCatalogRow(row, state.catalog.nonTextIndex));
  }

  // Ids the reference cannot score right now. The question is asked the
  // reference's way (ref lib/poller.js:113): score the rows first, then read
  // which ones have no score — unscoreable is a property of the id against
  // today's reference, not of a caller forgetting to set a `score` field.
  function unscoredIds(rows) {
    return scoredClone(rows)
      .filter((r) => r.score == null && !unscorable.has(String(r.id)))
      .map((r) => String(r.id));
  }

  /** The same, before the ids already given up on are removed from it. */
  function allUnscoredIds(rows) {
    return scoredClone(rows).filter((r) => r.score == null).map((r) => String(r.id));
  }

  /**
   * The demand trigger the reference uses instead of a manual source-sync button
   * (ref §11 step 7): a row the reference cannot score is a reason to re-fetch,
   * once. Ids that stay unscored are remembered so a permanently unknown model
   * costs four downloads and then nothing — and this comparison is the only
   * place that verdict is ever revisited, so a sync started by anything else
   * (the toolbar, the background timer) cannot reopen it.
   */
  async function syncIfUnscored(rows) {
    const before = allUnscoredIds(rows);
    const pending = before.filter((id) => !unscorable.has(id));
    if (!pending.length) return { synced: false, scored: 0, unscored: [] };
    await syncAll({ force: true });
    const after = allUnscoredIds(rows);
    // Whatever stayed unscored against a fresh reference is what no reference can
    // score; anything that scored proves the set was worth revisiting, so the
    // whole set is re-stamped rather than merely cleared (ref poller.js:154-156).
    if (after.length < before.length) unscorable.clear();
    after.forEach((id) => unscorable.add(id));
    return { synced: true, scored: before.length - after.length, unscored: pending };
  }

  function summary() {
    return {
      lastSyncAt: state.lastSyncAt,
      syncing: state.syncing,
      keyedAuthConfigured: Boolean(sources.readKey && sources.readKey()),
      catalogCount: state.catalog.rows.length,
      fits: state.catalog.fits,
      sources: sources.SOURCES.map((source) => {
        const entry = state.sourceStore[source.id] || emptySource();
        return { id: source.id, name: source.name, description: source.description,
          fetchedAt: entry.fetchedAt, lastAttemptAt: entry.lastAttemptAt,
          error: entry.error, stale: entry.stale, rowCount: entry.rowCount };
      }),
    };
  }

  function health() {
    const age = ageOfNewest();
    return { ...summary(),
      newestPayloadAgeMs: age === Infinity ? null : age,
      minSyncAgeMs: minAgeMs,
      unscorableCount: unscorable.size };
  }

  function unscorableSize() { return unscorable.size; }

  return { state, loadCache, syncAll, rebuild, scoreRows, isNonTextModel,
    unscoredIds, syncIfUnscored, unscorableSize, summary, health, minAgeMs };
}

module.exports = { createEngine, SOURCE_SYNC_MIN_AGE_MS };
