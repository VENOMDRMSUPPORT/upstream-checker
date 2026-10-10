// src/catalog/ipc.js
'use strict';

// The renderer's only way to the catalog. Seven channels, one thing each, the
// same rule src/db/ipc.js follows so two writers cannot overwrite each other.
//
// The provider adapters stay in the renderer — they own discovery and auth, and
// the page holds only venomkey: placeholders. So ingest and fetch-info receive
// the rows the adapter read and do the merge, the scoring and the writing here.
// Nothing on this surface ever carries a key: main reads the OpenRouter secret
// itself, at the point of use (src/main.js startCatalog's readKey).
//
// THE CONTRACT, which the Models-page batch is written against:
//
//   A channel RESOLVES. Always. An outcome the UI has to act on — a bad payload, a
//   provider that does not exist, a quarantined drop, a sync already running — is
//   data of the shape `{ ok: false, code, message }`, and the success shapes are
//   each channel's own (unchanged from Task 10):
//     catalog:ingest      { ok, rows, changes, stale, warning }
//     catalog:read        { ok, rows, providers, readAt, oldestFetch, stale,
//                           warning, lastSyncAt, catalogCount }
//     catalog:health      { p50, samples }
//     catalog:sources     the engine summary (forced or read-only)
//     catalog:fetch-info  { ok, outcome, before, after, changes, borrowed }
//     catalog:events      { ok, rows, unread, counts, totals }
//     catalog:events-read { ok, marked, unread }
//   Only a genuine programmer error rejects — a bad argument type, an assertion.
//
//   Why: `ipcMain.handle` resolves by STRUCTURE and turns a rejection into a NEW
//   Error that carries only its `message`, prefixed `Error invoking remote method
//   'catalog:ingest': `. An `err.code` set in main simply does not cross. A channel
//   whose verdict lives on the thrown object is a channel whose verdict the renderer
//   never receives — so the verdict has to be in the value instead.
//
//   Callers test `reply && reply.ok === false`, never `catch`. `catalog:sources`
//   and `catalog:health` answers have no `ok` key at all on success, which that
//   check handles; `ingest` and `read` carry `ok: true`.
//
// The read is also filtered now (F2): the renderer owns PROVIDERS and isConnected,
// so it passes `providerIds`; main filters that set against repos.providers and
// refuses an id it cannot find. An empty or absent set serves nothing — it does not
// mean "everything" — and a provider with nothing to serve is named with a code
// rather than dropped from the reply (ref §9 readConnected, NO_SNAPSHOT).

const { providerRow, matchIds, qualityProxyIds, rosterProxyIds } = require('./row');
const { syncSnapshot, dropNonText, validateProviderRows, providerRowSnapshot,
  restoreLastGoodRows, REMOVED_WINDOW_DAYS } = require('./snapshot');

const LATENCY_SAMPLES_KEPT = 20;

// The codes that are outcomes rather than bugs. Anything thrown with one of these
// becomes a resolved reply; anything else is a defect and stays a rejection.
const DATA_CODES = new Set(['INVALID_PROVIDER_PAYLOAD', 'NOT_FOUND',
  'SUSPICIOUS_PROVIDER_DROP', 'SYNC_IN_PROGRESS']);

// Days a removed model is retained before the purge, read from the saved
// settings row on every ingest (mirrors src/main.js idleLimitMs): a missing
// or out-of-range value reads as REMOVED_WINDOW_DAYS and is never written
// back. Pure, so the boundary is unit-testable without a database.
function readPurgeWindowDays(saved) {
  // Number(null) is 0, not NaN — so absence is checked before conversion, or
  // a fresh install would purge everything at once.
  const raw = saved && saved.purgeWindowDays;
  if (raw == null) return REMOVED_WINDOW_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return REMOVED_WINDOW_DAYS;
  return Math.min(365, Math.max(1, Math.round(n)));
}

function purgeWindowDays(repos) {
  try {
    if (repos && repos.settings && typeof repos.settings.get === 'function') {
      return readPurgeWindowDays(repos.settings.get('settings'));
    }
  } catch (_) {
    // A settings row that cannot be read must not break a roster sync.
  }
  return REMOVED_WINDOW_DAYS;
}

/** An expected outcome, carried by code so the boundary can turn it into data. */
function catalogError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// The fields a Fetch information click may report as moved. Exactly the provider's
// own facts (ref §8.1); a derived value changing would say the provider published
// something when only the reference moved.
const COMPARE_FIELDS = ['name', 'description', 'family', 'context_tokens', 'output_tokens',
  'input_modalities', 'output_modalities', 'tools', 'reasoning', 'structured', 'attachment',
  'cost_in_per_m', 'cost_out_per_m', 'cost_kind', 'release_date', 'status', 'kind'];

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Both arguments are PROVIDER rows: the one stored, and the one just mapped from
// what the adapter read — before scoring, and before `fillFromCatalog` borrows from
// the reference. Compare anything else and every field a thin row borrows diffs on
// every click, because providerRowSnapshot re-blanks exactly those before storing.
function diffRow(before, after) {
  const out = [];
  for (const field of COMPARE_FIELDS) {
    if (!same(before[field], after[field])) out.push({ field, from: before[field] ?? null, to: after[field] ?? null });
  }
  return out;
}

/** The provider's own published facts on this row, as the diff reads them. */
const publishedOnly = (row) => Object.fromEntries(
  COMPARE_FIELDS.map((field) => [field, row ? row[field] ?? null : null]),
);

/** The newest sample is the last; p50 over the kept ring, null when empty. */
function readHealth(health) {
  const samples = ((health && health.latencies) || []).map((s) => s.ms).filter((n) => Number.isFinite(n));
  if (!samples.length) return { p50: null, samples: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const p50 = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  return { p50, samples: sorted.length };
}

function appendLatency(previous, at, ms) {
  const ring = ((previous && previous.latencies) || []).slice();
  if (Number.isFinite(ms)) ring.push({ at, ms: Math.round(ms) });
  return ring.slice(-LATENCY_SAMPLES_KEPT);
}

const CHECKS_SAMPLES_KEPT = 30;
function appendCheck(previous, check) {
  const ring = ((previous && previous.checks) || []).slice();
  if (check && check.status) {
    ring.push({
      at: check.at || Date.now(),
      status: check.status,
      note: check.note || null,
      ms: Number.isFinite(check.ms) ? Math.round(check.ms) : null,
      tokens: Number.isFinite(check.tokens) ? check.tokens : null,
      tps: Number.isFinite(check.tps) ? Math.round(check.tps * 10) / 10 : null,
    });
  }
  return ring.slice(-CHECKS_SAMPLES_KEPT);
}

/**
 * The aliases a row may be matched by, and the base route it may borrow a score
 * from. Both are PROVIDER facts and both must reach `summary_json`, or the row
 * loses its only way to be scored on the next read.
 *
 * `row.js` emits the §8.1 fields and deliberately no `match_ids`, because the
 * aliases it generates are a function of the id. But ref §8.2 makes adapter-curated
 * aliases the only way some rows match at all — the reference's `wan-2.0` is
 * unreachable by any spelling this file could invent — while `scoring.js`'s
 * `lookupCatalogRow` step 1 is authoritative ONLY for a verbatim `match_ids` hit.
 * So the adapter's own list goes FIRST (lookupCatalogRow returns the first exact
 * hit, so a curated alias must never be displaced by a generated one), then the
 * generated ones, deduped. A `-thinking` route with no declared proxy gets the
 * one derivable from its id.
 */
function withAliases(row, model, roster) {
  const declared = Array.isArray(model && model.match_ids)
    ? model.match_ids.filter((alias) => typeof alias === 'string' && alias.trim()) : [];
  row.match_ids = [...new Set([...declared, ...matchIds(row.id)])];
  const proxies = Array.isArray(model && model.quality_proxy_ids)
    ? model.quality_proxy_ids.filter((alias) => typeof alias === 'string' && alias.trim()) : [];
  // Order is precedence: what the adapter declared wins, then the base the
  // provider's own roster makes unambiguous, then the one derivable from the id
  // alone. `lookupQualityProxy` takes the first of these the reference can
  // resolve, so a later candidate can never displace an earlier one.
  row.quality_proxy_ids = [...new Set([
    ...proxies,
    ...rosterProxyIds(row.id, roster),
    ...qualityProxyIds(row.id),
  ])];
  return row;
}

function createCatalogIpc({ ipcMain, repos, engine, log = console, onRosterWritten = () => {} }) {
  // The door (ref §9 refresh): one in-flight ingest per provider, shared by the
  // timer, a Fetch models click and a Fetch information click, so an overlap
  // costs one upstream fetch, one snapshot write, one diff.
  const inFlight = new Map();

  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        // An outcome, not a defect: resolve it as data, because a rejection loses
        // the code on the way across the boundary (see the contract at the top).
        if (err && DATA_CODES.has(err.code)) {
          log.warn(`${channel} answered ${err.code}: ${err.message}`);
          return { ok: false, code: err.code, message: err.message };
        }
        log.error(`${channel} failed:`, err.message);
        throw err;
      }
    });
  };

  // ref §9 step 1: `get(id)`, unknown → NOT_FOUND. The renderer is allowed to ask
  // for the providers it thinks are connected; main is the only place that knows
  // whether one still exists, so a deleted provider's roster stops here rather than
  // being served forever. Only the id is read — a provider row carries key hints,
  // and nothing on this surface travels to the renderer except catalog facts.
  function requireProvider(providerId, asking) {
    const id = providerId == null ? '' : String(providerId).trim();
    if (id && repos.providers.get(id)) return id;
    throw catalogError('NOT_FOUND',
      `no provider "${id || '(none given)'}" — ${asking} refused, nothing fetched and nothing written`);
  }

  function mapRows(providerId, models) {
    // The roster is read once and handed to every row: a variant's base is
    // resolved against the models this provider actually serves, so the whole
    // list has to be known before any one row's proxies can be derived.
    // A renderer-side adapter verdict (nexum classify()) is itself a declared
    // kind: it is stored on the row so the renderer never re-derives it and
    // fetch-info diffs it like any other provider fact.
    const roster = models.map((m) => String((m && m.id) || '')).filter(Boolean);
    return models.map((m) => withAliases(providerRow(m, providerId), m, roster));
  }

  // "How did the last attempt end", recorded where the read path can find it.
  // `setLastSync` answers false and writes nothing when the provider has never
  // produced a snapshot — it refuses to invent a phantom provider, so a failed
  // first attempt leaves `listProviderIds()` meaning "has ever synced".
  const recordFailure = (providerId, at, warning) => {
    try {
      repos.snapshots.setLastSync(providerId, { at, ok: false, warning });
    } catch (err) {
      log.warn(`catalog: could not record the failed attempt for ${providerId}:`, err.message);
    }
  };

  // The last-good roster, re-stamped and re-scored, served as stale.
  //
  // Only when there IS one. An empty list served as `stale: true` reads to the owner
  // as "your provider has no models", which is a different claim from "the last
  // attempt failed and I am showing you what it said before that" — with nothing to
  // stand in, the verdict itself is the answer, and it travels as data.
  const staleFrom = (previous, at, err) => {
    const rows = previous ? restoreLastGoodRows(previous, at) : [];
    if (!rows.length) throw err;
    return { ok: true, stale: true, code: err.code || null, warning: err.message,
      rows: engine.scoreRows(rows), changes: null };
  };

  // The write path for one provider, always behind the door.
  function ingest(providerId, models) {
    // Before the door, before any read, fetch or write: a mistyped id used to
    // create a snapshot_meta row and a roster set for a provider that does not
    // exist, and the read path then served it forever.
    const provider = requireProvider(providerId, 'the ingest');
    const existing = inFlight.get(provider);
    if (existing) return existing;
    const job = (async () => {
      const list = Array.isArray(models) ? models : [];
      const now = Date.now();
      let stored;
      try {
        // The RAW roster is validated before anything is mapped: an adapter row
        // with no id, or the same id twice, is refused with the code the contract
        // names rather than with whatever providerRow happens to throw.
        validateProviderRows(provider, list);
        const rows = mapRows(provider, list);
        const { kept, dropped } = dropNonText({ provider: { id: provider }, rows,
          isNonTextModel: (r) => engine.isNonTextModel(r) });
        stored = { rows: validateProviderRows(provider, kept), dropped };
      } catch (err) {
        // An empty or malformed roster is not a removal: keep what we have and
        // say so. With nothing ever stored there is no roster to be stale about,
        // so the refusal goes on to the caller — as `{ ok: false, code }`.
        const previous = repos.snapshots.read(provider);
        recordFailure(provider, now, err.message);
        return staleFrom(previous, now, err);
      }
      let changes;
      try {
        changes = syncSnapshot(repos.snapshots, provider, stored.rows, now, stored.dropped,
          purgeWindowDays(repos));
      } catch (err) {
        if (err.code !== 'SUSPICIOUS_PROVIDER_DROP') throw err;
        // syncSnapshot wrote the pending drop before throwing; setLastSync keeps
        // that column and adds the verdict the read path reports as stale.
        const previous = repos.snapshots.read(provider);
        recordFailure(provider, now, err.message);
        return staleFrom(previous, now, err);
      }
      // The roster edge is the notification feed: one event per arrival and
      // departure, written here — the one place rosters change — so the bell
      // and the history view read rows, never diffs. Recording never breaks a
      // sync: a full events table is a trimming detail, not a roster defect.
      try {
        if (changes.appearedIds && changes.appearedIds.length) {
          repos.rosterEvents.record(provider, changes.appearedIds, 'added', now);
        }
        if (changes.disappearedIds && changes.disappearedIds.length) {
          repos.rosterEvents.record(provider, changes.disappearedIds, 'removed', now);
        }
      } catch (err) {
        log.warn('catalog: roster changed but the event was not recorded:', err.message);
      }
      // The one place the roster changes, so it is the one place the price book
      // has to hear about it: every cached cost for this provider may be stale
      // now. This is not the log recorder's business, so it arrives as a hook
      // rather than as a direct call.
      try {
        onRosterWritten(provider);
      } catch (err) {
        log.warn('catalog: roster written but the price book was not invalidated:', err.message);
      }
      const scored = engine.scoreRows(stored.rows.map(providerRowSnapshot));
      engine.syncIfUnscored(scored).catch(() => {});
      return { ok: true, stale: false, warning: null, rows: scored, changes };
    })();
    inFlight.set(provider, job);
    job.finally(() => inFlight.delete(provider)).catch(() => {});
    return job;
  }

  // The read path (ref §9 readConnected): snapshots re-scored against today's
  // reference. No fetch, no write, no event.
  //
  // The connected set is the caller's (ref §9 readConnected filtered on
  // connections.connectedIds; here the renderer owns PROVIDERS and isConnected, so
  // it passes `providerIds`). Two rules make that filter real rather than decorative:
  // an absent or empty set serves NOTHING — it cannot quietly mean "everything the
  // database holds" — and an id main cannot find in repos.providers is refused even
  // when a snapshot for it exists on disk. A provider with no roster yet is named
  // with a code instead of vanishing, because silence reads as "it has no models".
  function read(query = {}) {
    const asked = Array.isArray(query && query.providerIds)
      ? [...new Set(query.providerIds.map((id) => String(id ?? '').trim()).filter(Boolean))]
      : [];
    const merged = [];
    const providers = [];
    let oldest = null;
    let anyStale = false;
    let warning = null;
    const now = Date.now();
    for (const providerId of asked) {
      if (!repos.providers.get(providerId)) {
        providers.push({ providerId, ok: false, code: 'NOT_FOUND', total: 0, fetchedAt: null,
          stale: false, lastSyncAt: null, warning: null,
          message: `no provider "${providerId}" — its roster is not served` });
        continue;
      }
      const snapshot = repos.snapshots.read(providerId);
      // Re-stamped, not replayed: first_seen and the newness verdict come from the
      // history as it stands today, because is_new is never stored (Task 7).
      const rows = snapshot ? restoreLastGoodRows(snapshot, now) : [];
      if (!rows.length) {
        providers.push({ providerId, ok: false, code: 'NO_SNAPSHOT', total: 0, fetchedAt: null,
          stale: false, lastSyncAt: null, warning: null,
          message: `${providerId} has not been synced yet.` });
        continue;
      }
      // The row is the page's only address for itself: every render, filter, sort
      // and button lookup reads PROVIDERS[row.providerId], and the page composes
      // its `${providerId}::${id}` key from it. The providers[] array names the
      // provider too, but a merged row that does not carry its own is a row the
      // page cannot place, colour, or act on.
      rows.forEach((row) => { row.providerId = providerId; });
      // The stored health verdict rides on the read row: health_json lives in
      // roster_snapshot and is otherwise write-only, so without this the page's
      // Health badge and latency p50 are blank after every restart (spec §5 "read
      // as { p50, samples }"). One repo call per row, keyed like setHealth.
      rows.forEach((row) => { row.health = repos.snapshots.getHealth(providerId, row.id); });
      const lastSync = snapshot.lastSync || null;
      const stale = Boolean(lastSync && lastSync.ok === false);
      if (snapshot.fetchedAt != null && (oldest === null || snapshot.fetchedAt < oldest)) {
        oldest = snapshot.fetchedAt;
      }
      if (stale) {
        anyStale = true;
        warning = lastSync.warning;
      }
      providers.push({ providerId, ok: true, code: null, total: rows.length,
        fetchedAt: snapshot.fetchedAt ?? null, stale,
        lastSyncAt: lastSync ? lastSync.at : null, warning: stale ? lastSync.warning : null });
      merged.push(...rows);
    }
    // Once, over everything shown. attachScores dense-ranks the list it is handed, so
    // scoring provider by provider would make each roster rank against itself and a
    // two-provider view answer with two rank 1s — while spec §7 defines `#` as the
    // dense rank over the MERGED view (ref providers/index.js:625 then :693).
    const rows = engine.scoreRows(merged);
    return { ok: true, rows, providers, readAt: now, oldestFetch: oldest, stale: anyStale, warning,
      lastSyncAt: engine.state.lastSyncAt, catalogCount: engine.state.catalog.rows.length };
  }

  function health(providerId, modelId, result) {
    const provider = requireProvider(providerId, 'the health result');
    const previous = repos.snapshots.getHealth(provider, modelId);
    const stored = {
      status: result.status, note: result.note || null, httpStatus: result.httpStatus ?? null,
      at: result.at || Date.now(),
      latencies: appendLatency(previous, result.at || Date.now(), result.timeMs),
      checks: appendCheck(previous, {
        at: result.at || Date.now(),
        status: result.status,
        note: result.note || null,
        ms: result.timeMs,
        tokens: result.tokens,
        tps: result.tps,
      }),
    };
    try {
      repos.snapshots.setHealth(provider, modelId, stored);
    } catch (err) {
      // repos.snapshots refuses a model that is not in the roster. That is a state
      // the page can act on — check information for this provider first — not a
      // defect, so it becomes NOT_FOUND data. Anything else stays a rejection.
      if (/^unknown model/.test(String(err && err.message))) {
        throw catalogError('NOT_FOUND', err.message);
      }
      throw err;
    }
    return readHealth(stored);
  }

  // Fetch information (spec §6): the network pass is TTL-gated, the merge and the
  // report never are.
  //
  // The diff is between two PROVIDER rows — the stored one and the one just mapped
  // from what the adapter read, before scoring and before fillFromCatalog borrows
  // eleven reference values into COMPARE_FIELDS. providerRowSnapshot re-blanks
  // exactly those on the way in, so scoring before the compare made every borrowed
  // field "move" on every click, and a model with no stored row reported the
  // reference's own numbers as what the provider had just learned. What the
  // reference lends is still said — as `borrowed`, separately from `changes`.
  async function fetchInfo(providerId, modelId, models) {
    const provider = requireProvider(providerId, 'the fetch');
    await engine.syncAll();
    const before = repos.snapshots.read(provider);
    const beforeRow = before && (before.lastGoodRows || [])
      .find((r) => String(r.id) === String(modelId));
    // Mapped from the caller's own list, NOT taken from the ingest reply: the
    // reply's rows are scored and filled. One row, found by id, so a roster with a
    // missing id cannot make this throw an error that has no code — the ingest
    // below is what reports that, as INVALID_PROVIDER_PAYLOAD data.
    const asked = (Array.isArray(models) ? models : [])
      .find((m) => String((m && m.id) || '').trim() === String(modelId)) || null;
    const published = publishedOnly(asked ? providerRow(asked, provider) : null);
    const { rows, stale, code, warning } = await ingest(provider, models);
    // The ingest refused this roster (a malformed list, a quarantined drop) and
    // answered with the last-good rows. Nothing was compared, so nothing may be
    // reported as moved: its verdict is the answer, and it crosses as data.
    if (stale && code) throw catalogError(code, warning || `the ingest for ${provider} refused this roster`);
    // The roster this click read does not name the model at all. That is the
    // provider dropping it — and it is the only honest answer, because an empty
    // `published` diffed against a stored row would claim the provider unpublished
    // every fact it ever said.
    if (!asked) {
      return { ok: true, outcome: 'no-longer-listed', before: beforeRow || null, after: null,
        changes: null, borrowed: [] };
    }
    const after = rows.find((r) => String(r.id) === String(modelId));
    const borrowed = after && after.filled_from_catalog ? after.filled_from_catalog : [];
    if (!after) {
      return { ok: true, outcome: 'no-longer-listed', before: beforeRow || null, after: null,
        changes: null, borrowed: [] };
    }
    if (after.matched_id == null) {
      return { ok: true, outcome: 'no-match', before: beforeRow || null, after, changes: null, borrowed };
    }
    const changes = beforeRow ? diffRow(publishedOnly(beforeRow), published)
      : COMPARE_FIELDS.filter((f) => published[f] != null && published[f] !== '')
        .map((f) => ({ field: f, from: null, to: published[f] }));
    return { ok: true, outcome: changes.length ? 'updated' : 'matched', before: beforeRow || null, after,
      changes: changes.length ? changes : null, borrowed };
  }

  // Roster change events: what the bell and the history view read. List
  // answers newest-first with the unread count beside it; read marks rows.
  // Both resolve; a malformed query is data, never a rejection.
  function events(query = {}) {
    const { providerId = null, kind = null, limit = 50, unreadOnly = false, search = null } = query || {};
    try {
      const rows = repos.rosterEvents.list({ providerId, kind, limit, unreadOnly, search });
      const filtered = repos.rosterEvents.counts({ providerId, search });
      const totals = (providerId == null && (search == null || String(search).trim() === ''))
        ? filtered : repos.rosterEvents.counts({});
      return { ok: true, rows, unread: repos.rosterEvents.unreadCount(), counts: filtered, totals };
    } catch (err) {
      return { ok: false, code: 'BAD_QUERY', message: err.message };
    }
  }

  function eventsRead(query = {}) {
    const { ids = null, all = false, before = null } = query || {};
    if (!all && !Array.isArray(ids)) return { ok: false, code: 'BAD_QUERY', message: 'pass { ids } or { all: true }' };
    try {
      const marked = repos.rosterEvents.markRead({ ids, all: all === true, before });
      return { ok: true, marked, unread: repos.rosterEvents.unreadCount() };
    } catch (err) {
      return { ok: false, code: 'BAD_QUERY', message: err.message };
    }
  }

  handle('catalog:ingest', (providerId, models) => ingest(providerId, models));
  handle('catalog:read', (query) => read(query));
  handle('catalog:health', (providerId, modelId, result) => health(providerId, modelId, result));
  // Two different asks, one channel, and only one of them may reach the network.
  //
  // `force` is the owner's click on Sync sources: syncAll, four documents, the
  // summary it just rebuilt. Without it the channel is the Interfaces contract
  // read literally — the engine's `summary()` — because its caller is Settings
  // › Catalog drawing four lines every time the section opens. syncAll's TTL is
  // "older than 15 minutes counts as due", so a non-forced syncAll on a machine
  // that has never fetched (or fetched this morning) would download five
  // megabytes because a page opened. Nothing may. The TTL-gated network pass
  // still exists for the callers that ask for it by name: catalog:fetch-info
  // calls engine.syncAll() itself, behind a row's own button.
  handle('catalog:sources', (query = {}) => (query.force === true
    ? engine.syncAll({ force: true })
    : engine.summary()));
  handle('catalog:fetch-info', (providerId, modelId, models) => fetchInfo(providerId, modelId, models));
  handle('catalog:events', (query) => events(query));
  handle('catalog:events-read', (query) => eventsRead(query));
}

module.exports = { createCatalogIpc, COMPARE_FIELDS, diffRow, readHealth, appendLatency,
  appendCheck, CHECKS_SAMPLES_KEPT, withAliases, LATENCY_SAMPLES_KEPT, readPurgeWindowDays };
