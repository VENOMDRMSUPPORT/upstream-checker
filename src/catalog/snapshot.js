// src/catalog/snapshot.js
'use strict';

// Change detection for one provider's roster, keeping three questions apart:
//   added / removed  WINDOWS — "what is new lately", still populated for days
//   moved            the EDGE — "did the roster change just now"
//   baseline         the first snapshot, where nothing is new by definition
// Only `moved` may gate a notice: gating on a window would make the read path
// refetch itself without bound (ref §12).
//
// Ported from the reference's providers/index.js:130-428. Two things changed on
// the way in. The directory of JSON files became a store seam —
// `{ read(providerId), write(providerId, snapshot) }`, satisfied by
// `repos.snapshots` (two INTEGER columns deep) and by a Map in tests. And every
// timestamp became epoch milliseconds: `created_at`, `fetched_at`, `first_seen`,
// `last_seen`, `removed_at` are all INTEGER columns in venom.db, so `daysBetween`
// subtracts them rather than calling `Date.parse` on a number that would come
// back NaN and read as "nothing has ever been new".
//
// The `engine`'s third proof that a listing is a generator arrives as an
// injected `isNonTextModel` rather than a module singleton, because the filter
// runs at ingest and the engine owns the reference.

const crypto = require('crypto');

const NEW_WINDOW_DAYS = 7;
const REMOVED_WINDOW_DAYS = 30;
const DROP_CONFIRMATION_MS = 6 * 60 * 60 * 1000;
const DROP_MIN_PREVIOUS = 5;
const DROP_MIN_LOSS = 3;

function invalidPayload(providerId, detail) {
  const error = new Error(`${providerId} returned an invalid model list: ${detail}`);
  error.code = 'INVALID_PROVIDER_PAYLOAD';
  return error;
}

function suspiciousDrop(providerId, from, to) {
  const error = new Error(`${providerId} model count dropped from ${from} to ${to}; awaiting confirmation`);
  error.code = 'SUSPICIOUS_PROVIDER_DROP';
  return error;
}

const daysBetween = (from, to) => (to - from) / 86400000;

function validateProviderRows(providerId, rows) {
  if (!Array.isArray(rows)) throw invalidPayload(providerId, 'expected an array');
  if (!rows.length) throw invalidPayload(providerId, 'empty model list');
  const ids = new Set();
  for (const row of rows) {
    const id = row && String(row.id || '').trim();
    if (!id) throw invalidPayload(providerId, 'model is missing id');
    if (ids.has(id)) throw invalidPayload(providerId, `duplicate model id: ${id}`);
    ids.add(id);
  }
  return rows;
}

function cloneRows(rows) {
  return rows.map((row) => ({
    ...row,
    match_ids: Array.isArray(row.match_ids) ? [...row.match_ids] : row.match_ids,
    quality_proxy_ids: Array.isArray(row.quality_proxy_ids) ? [...row.quality_proxy_ids] : row.quality_proxy_ids,
    score_basis: Array.isArray(row.score_basis) ? [...row.score_basis] : row.score_basis,
    filled_from_catalog: Array.isArray(row.filled_from_catalog) ? [...row.filled_from_catalog] : row.filled_from_catalog,
  }));
}

// Everything the engine derives on each pass. None of it is stored with the
// last-good rows: a fallback row must be re-scored against today's reference,
// not replay what it said on the day the provider last answered.
//
// `filled_from_catalog` joins the list the reference kept (`is_new`, `first_seen`
// among them) because this app re-blanks the borrowed fields on read: storing the
// list would claim the borrow was the provider's own fact. `is_new` is in the list
// and is in none of the columns — `syncSnapshot` stamps it on the rows it returns
// and `restoreLastGoodRows` recomputes it, because a stored verdict would freeze a
// window that moves with the clock.
const DERIVED_FIELDS = [
  'score', 'score_source', 'score_basis', 'rank', 'catalog_rank', 'matched_id', 'bench_id',
  'aa_intelligence', 'aa_coding', 'lmarena_elo', 'lmarena_rank', 'lmarena_code_rank',
  'score_proxy_for', 'is_new', 'first_seen', 'filled_from_catalog',
];
const BLANK_STRING_FIELDS = new Set(['input_modalities', 'output_modalities', 'release_date']);

/** The provider's own row: derived fields dropped, borrowed metadata blanked again. */
function providerRowSnapshot(row) {
  const stored = cloneRows([row])[0];
  const borrowed = stored.filled_from_catalog || [];
  for (const field of DERIVED_FIELDS) delete stored[field];
  for (const field of borrowed) {
    stored[field] = BLANK_STRING_FIELDS.has(field) ? '' : null;
  }
  return stored;
}

/**
 * Last-good rows, re-stamped with the history the snapshot still knows.
 *
 * Each one goes through `providerRowSnapshot` again rather than a plain clone,
 * because `is_new` is not a column: the verdict is recomputed here from
 * `first_seen` against `now`, and anything a caller stamped onto the row on the
 * way in (a score, a rank) is stripped so the engine re-derives it against
 * today's reference.
 */
function restoreLastGoodRows(snapshot, now) {
  const rows = (snapshot.lastGoodRows || []).map(providerRowSnapshot);
  for (const row of rows) {
    const entry = snapshot.models && snapshot.models[String(row.id)];
    if (!entry) continue;
    row.first_seen = entry.first_seen;
    row.is_new = entry.first_seen !== snapshot.createdAt
      && daysBetween(entry.first_seen, now) <= NEW_WINDOW_DAYS;
  }
  return rows;
}

/** Does this row PROVE it cannot answer in text? Silence is not proof. */
function declaresNonTextOutput(row) {
  const out = String((row && row.output_modalities) || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
  return out.length > 0 && !out.includes('text');
}

/**
 * Three ways to know a listing is a generator, and one is enough: it published
 * the modality, this app enumerates it, or the reference recognises the model it
 * matches. Filtered ids travel as `forget` — the provider removed nothing, so a
 * tombstone and a removal notice would both say something untrue.
 */
function dropNonText({ provider, rows, isNonTextModel }) {
  const declared = (provider && provider.NON_TEXT_MODELS) || {};
  if (!Array.isArray(rows)) return { kept: rows, dropped: [] };
  const kept = rows.filter((row) => {
    if (declaresNonTextOutput(row)) return false;
    if (declared[String(row.id)]) return false;
    return !(isNonTextModel && isNonTextModel(row));
  });
  const dropped = rows.filter((row) => !kept.includes(row)).map((row) => String(row.id));
  return { kept, dropped };
}

/** Fingerprint of a candidate drop: the same set twice is one attempt counting, a different set restarts it. */
function providerIdContract(rows) {
  const ids = rows.map((r) => String(r.id)).sort();
  return { count: ids.length, sha256: crypto.createHash('sha256').update(ids.join('\n')).digest('hex') };
}

const activeCount = (snapshot) => Object.values(snapshot.models).filter((e) => !e.removed_at).length;

/**
 * @param {{ read: Function, write: Function }} store
 * @param {number} now  epoch ms — integers everywhere, as venom.db stores them
 * @param {string[]} forget  ids this app filtered out, not ids the provider removed
 * @param {number} purgeWindowDays  days a removed model is retained before the
 *   purge; a Settings value on the caller side, REMOVED_WINDOW_DAYS by default
 * @returns {{ baseline: boolean, since: number|null, added: object[], removed: object[],
 *   moved: {appeared: number, disappeared: number},
 *   appearedIds: object[], disappearedIds: object[] }}
 *
 * `added`/`removed` are sticky windows (what the table badges); `appearedIds`/
 * `disappearedIds` are this sync's edge (what the notification center records),
 * so one event is written per arrival and departure, never one per tick.
 */
function syncSnapshot(store, providerId, rows, now, forget = [], purgeWindowDays = REMOVED_WINDOW_DAYS) {
  validateProviderRows(providerId, rows);
  const previous = store.read(providerId);
  const snapshot = previous || { createdAt: now, fetchedAt: null, models: {} };

  if (previous) {
    const before = activeCount(previous);
    const largeDrop = before >= DROP_MIN_PREVIOUS
      && before - rows.length >= DROP_MIN_LOSS
      && rows.length < before / 2;
    if (largeDrop) {
      const contract = providerIdContract(rows);
      const same = previous.pendingDrop && previous.pendingDrop.sha256 === contract.sha256;
      const attempts = same ? previous.pendingDrop.attempts + 1 : 1;
      const firstSeenAt = same ? previous.pendingDrop.firstSeenAt : now;
      if (attempts < 3 || now - firstSeenAt < DROP_CONFIRMATION_MS) {
        // Written before anything else mutates, so a crash cannot reset the count
        // and a half-applied drop can never be the new baseline.
        store.write(providerId, { ...previous, pendingDrop: { ...contract, attempts, firstSeenAt } });
        throw suspiciousDrop(providerId, before, rows.length);
      }
    }
    delete snapshot.pendingDrop;
  }

  // Ids this app filtered out, forgotten rather than tombstoned. The provider
  // still lists them; letting them fall through would tombstone them, put them in
  // the `removed` window for thirty days, and fire a notice telling the owner
  // their provider dropped a model it did not drop.
  for (const id of forget) delete snapshot.models[String(id)];

  const currentIds = new Set(rows.map((row) => String(row.id)));
  const moved = { appeared: 0, disappeared: 0 };
  const appearedIds = [];
  const disappearedIds = [];

  for (const row of rows) {
    const id = String(row.id);
    const entry = snapshot.models[id];
    if (entry) {
      // Back after being marked gone is a move exactly as a first sighting is.
      if (entry.removed_at) {
        moved.appeared += 1;
        appearedIds.push({ id, name: row.name });
      }
      entry.name = row.name;
      entry.last_seen = now;
      delete entry.removed_at;
    } else {
      // Not on the baseline: the first snapshot is the roster arriving, not
      // moving, and nothing is flagged new there either.
      if (previous) {
        moved.appeared += 1;
        appearedIds.push({ id, name: row.name });
      }
      snapshot.models[id] = { name: row.name, first_seen: now, last_seen: now };
    }
  }

  const added = [];
  const removed = [];
  for (const [id, entry] of Object.entries(snapshot.models)) {
    if (currentIds.has(id)) {
      const isNew = entry.first_seen !== snapshot.createdAt
        && daysBetween(entry.first_seen, now) <= NEW_WINDOW_DAYS;
      if (isNew) added.push({ id, name: entry.name, first_seen: entry.first_seen });
      continue;
    }
    if (!entry.removed_at) {
      entry.removed_at = now;
      moved.disappeared += 1;
      disappearedIds.push({ id, name: entry.name });
    }
    if (daysBetween(entry.last_seen, now) <= purgeWindowDays) {
      removed.push({ id, name: entry.name, last_seen: entry.last_seen });
    } else {
      // Fully purged: the provider dropped it over a month ago. Nothing reads
      // it any more — the table, the counts and the badge all build from live
      // rows — so keeping it only grows the database. If it ever comes back
      // it arrives as a new appearance, which is the truth.
      delete snapshot.models[id];
    }
  }

  const addedIds = new Set(added.map((a) => a.id));
  for (const row of rows) {
    const entry = snapshot.models[String(row.id)];
    row.first_seen = entry.first_seen;
    row.is_new = addedIds.has(String(row.id));
  }

  const since = snapshot.fetchedAt;
  snapshot.fetchedAt = now;
  snapshot.lastGoodRows = rows.map(providerRowSnapshot);
  snapshot.lastSync = { at: now, ok: true, warning: null };
  store.write(providerId, snapshot);
  return { baseline: !previous, since, added, removed, moved, appearedIds, disappearedIds };
}

module.exports = {
  NEW_WINDOW_DAYS, REMOVED_WINDOW_DAYS, DROP_CONFIRMATION_MS, DROP_MIN_PREVIOUS, DROP_MIN_LOSS,
  DERIVED_FIELDS, BLANK_STRING_FIELDS, daysBetween,
  syncSnapshot, validateProviderRows, providerRowSnapshot, cloneRows, restoreLastGoodRows,
  declaresNonTextOutput, dropNonText, providerIdContract,
};
