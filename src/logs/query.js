// ============================================
// Request log queries — what the log pages (sub-project C) read
// ============================================
// Read-only except exportTo and clear. Lists page with a keyset on
// (created_at, id), never OFFSET, so the fortieth page costs what the first
// does. Charts read usage_hourly, never the raw rows. Failures throw: an
// empty result always means there was nothing to find.
const fs = require('fs');
const { approxP95 } = require('./classify');
const { ROW_COLUMNS, ROLLUP_COUNTERS } = require('./writer');
const { purgeLogsBefore, purgeRollupsBefore, stepVacuum } = require('./retention');

const HOUR = 3600000;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const MAX_FILTER_ITEMS = 50;
const EXPORT_CHUNK = 1000;
const EVERYTHING = Number.MAX_SAFE_INTEGER;
const EXPORT_COLUMNS = ['id', ...ROW_COLUMNS];
const LIKE = "LIKE ? ESCAPE '\\'";
// Each error class and the roll-up counter that holds it.
const CLASS_COUNTERS = {
  auth: 'e_auth', rate_limit: 'e_rate_limit', quota: 'e_quota', bad_request: 'e_bad_request',
  server: 'e_server', network: 'e_network', other: 'e_other', timeout: 'timeouts', blocked: 'blocked',
};
const GROUP_COLUMNS = { none: null, source: 'source', provider: 'provider_id', model: 'model_id' };
// The four orders the request list offers, all descending. A log is read
// worst-first: the slowest request, the most expensive, the longest wait for
// a first token. Ascending would need its own mirrored keyset predicate for a
// view nobody asked for, so it is not offered at all.
const SORT_COLUMNS = { time: 'created_at', latency: 'latency_ms', ttft: 'ttft_ms', cost: 'cost_micros' };
// A sort with no index behind it is only allowed inside a range the
// created_at index has already narrowed.
const MAX_SORT_RANGE_MS = 31 * 24 * 3600000;
const defaultYield = () => new Promise((resolve) => setImmediate(resolve));

const finite = (v) => (Number.isFinite(v) ? v : null);
const nonEmpty = (v) => (typeof v === 'string' && v !== '' ? v : null);
const items = (list) => (Array.isArray(list) ? list.filter((v) => typeof v === 'string' && v !== '').slice(0, MAX_FILTER_ITEMS) : []);
const escapeLike = (text) => text.replace(/[\\%_]/g, (c) => `\\${c}`);
const whereSql = (parts) => (parts.length ? `WHERE ${parts.join(' AND ')}` : '');
const pad = (n) => String(n).padStart(2, '0');

// The local calendar date of an hour: grouping hours by it is DST-safe (a
// 23- or 25-hour day is still one day).
function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function clampLimit(limit) {
  const n = Number(limit);
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;
}

function createMeta(db) {
  const get = db.prepare('SELECT value FROM meta WHERE key = ?');
  const set = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  return {
    get: (key) => {
      const row = get.get(key);
      return row ? row.value : null;
    },
    set: (key, value) => {
      set.run(key, String(value));
    },
  };
}

function conditions() {
  const where = [];
  const params = [];
  return {
    where,
    params,
    add(sql, ...values) {
      where.push(sql);
      params.push(...values);
    },
    inList(column, values) {
      if (values.length) this.add(`${column} IN (${values.map(() => '?').join(', ')})`, ...values);
    },
  };
}

function rowFilters(filters) {
  const f = filters && typeof filters === 'object' ? filters : {};
  const c = conditions();
  if (finite(f.from) !== null) c.add('created_at >= ?', f.from);
  if (finite(f.to) !== null) c.add('created_at < ?', f.to);
  c.inList('source', items(f.source));
  c.inList('provider_id', items(f.providerId));
  c.inList('status', items(f.status));
  if (nonEmpty(f.model)) c.add('model_requested = ?', f.model);
  if (nonEmpty(f.runId)) c.add('run_id = ?', f.runId);
  const text = nonEmpty(f.text) ? f.text.trim().slice(0, 200) : '';
  if (text) {
    const p = `%${escapeLike(text)}%`;
    c.add(`(request_uid ${LIKE} OR run_id ${LIKE} OR error_message ${LIKE})`, p, p, p);
  }
  if (Number.isInteger(f.afterId)) c.add('id > ?', f.afterId);
  return c;
}

function emptyCounters() {
  const acc = {};
  ROLLUP_COUNTERS.forEach((col) => {
    acc[col] = 0;
  });
  return acc;
}

function addCounters(acc, row) {
  ROLLUP_COUNTERS.forEach((col) => {
    acc[col] += row[col];
  });
}

function summarize(a) {
  const attempted = a.requests - a.cancelled - a.blocked;
  const errors = attempted - a.ok;
  const p95 = approxP95(Array.from({ length: 14 }, (_, i) => a[`lb${i}`]), a.latency_count);
  const errorsByClass = {};
  Object.entries(CLASS_COUNTERS).forEach(([cls, col]) => {
    if (cls !== 'blocked') errorsByClass[cls] = a[col];
  });
  return {
    requests: a.requests,
    ok: a.ok,
    okPct: attempted > 0 ? (a.ok * 100) / attempted : null,
    errors,
    errorRate: attempted > 0 ? errors / attempted : null,
    errorsByClass,
    cancelled: a.cancelled,
    blocked: a.blocked,
    timeouts: a.timeouts,
    avgLatencyMs: a.latency_count ? Math.round(a.latency_sum_ms / a.latency_count) : null,
    p95LatencyMs: p95 ? p95.ms : null,
    p95Overflow: p95 ? p95.overflow : false,
    avgTtftMs: a.ttft_count ? Math.round(a.ttft_sum_ms / a.ttft_count) : null,
    inputTokens: a.input_tokens,
    outputTokens: a.output_tokens,
    cachedTokens: a.cached_tokens,
    costMicros: a.cost_micros,
  };
}

function emptyStats() {
  return { totals: summarize(emptyCounters()), series: [] };
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function summarizeRun(runId, rows) {
  const errorsByClass = {};
  Object.keys(CLASS_COUNTERS).forEach((cls) => {
    errorsByClass[cls] = 0;
  });
  let ok = 0;
  let cancelled = 0;
  let cost = null;
  const models = new Set();
  const providers = new Set();
  const latencies = [];
  const ttfts = [];
  rows.forEach((r) => {
    if (r.status === 'ok') ok += 1;
    else if (r.status === 'cancelled') cancelled += 1;
    else if (r.error_class in errorsByClass) errorsByClass[r.error_class] += 1;
    if (r.model_requested) models.add(r.model_requested);
    if (r.provider_id) providers.add(r.provider_id);
    if (Number.isFinite(r.cost_micros)) cost = (cost || 0) + r.cost_micros;
    const answered = (r.status === 'ok' || r.status === 'error') && Number.isInteger(r.http_status) && r.error_class !== 'network';
    if (answered && Number.isFinite(r.latency_ms)) latencies.push(r.latency_ms);
    // A non-stream request has no first token to wait for; counting it as
    // zero would drag the median toward nothing.
    if (r.is_stream && Number.isFinite(r.ttft_ms)) ttfts.push(r.ttft_ms);
  });
  const attempted = rows.length - cancelled - errorsByClass.blocked;
  return {
    runId,
    count: rows.length,
    ok,
    cancelled,
    errorsByClass,
    models: [...models].sort(),
    providers: [...providers].sort(),
    costMicros: cost,
    firstAt: rows.length ? rows[0].created_at : null,
    lastAt: rows.length ? rows[rows.length - 1].created_at : null,
    medianLatencyMs: median(latencies),
    medianTtftMs: median(ttfts),
    // The same denominator summarize() uses for okPct: requests minus the
    // ones that never got to try. Leaving blocked in would give the app two
    // different pass rates for the same traffic — one here, one on
    // Monitoring.
    passRate: attempted > 0 ? ok / attempted : null,
  };
}

function emptyRunSummary(runId) {
  return summarizeRun(runId, []);
}

// A spreadsheet opens a cell that starts like a formula as one, and error
// text comes from providers.
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function fileSize(file) {
  if (!file || file === ':memory:') return 0;
  return ['', '-wal'].reduce((sum, suffix) => {
    try {
      return sum + fs.statSync(file + suffix).size;
    } catch (_) {
      return sum;
    }
  }, 0);
}

function createQuery(db, { file = null, meta, droppedRows = () => 0 } = {}) {
  // Filters make the SQL vary; each distinct statement is prepared once.
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };

  // The order a sorted page uses, and the predicate that continues it.
  //
  // time keeps the two-branch cursor it has always had: created_at is NOT
  // NULL, so a plain comparison is total. The other three columns are all
  // nullable — a cancelled request has no latency, a non-stream request no
  // TTFT, a model with no price no cost — and in SQLite a comparison against
  // NULL is NULL, never true. A two-branch cursor therefore matches nothing
  // the moment it lands on a NULL row, and the page silently stops there.
  //
  // So NULLs are pushed into one block at the end, `(col IS NULL) ASC`, and
  // the cursor says which block it is in.
  function sortOrder(sort) {
    if (sort === 'time') return 'created_at DESC, id DESC';
    const column = SORT_COLUMNS[sort];
    return `(${column} IS NULL) ASC, ${column} DESC, id DESC`;
  }

  function addCursor(c, sort, cursor) {
    if (!cursor || typeof cursor !== 'object') return;
    if (sort === 'time') {
      if (!Number.isFinite(cursor.createdAt) || !Number.isInteger(cursor.id)) return;
      c.add('(created_at < ? OR (created_at = ? AND id < ?))', cursor.createdAt, cursor.createdAt, cursor.id);
      return;
    }
    if (!Number.isInteger(cursor.id)) return;
    const col = SORT_COLUMNS[sort];
    if (cursor.isNull) {
      // Inside the NULL block: id strictly decreases, and this can never
      // re-enter the valued block, so paging terminates.
      c.add(`(${col} IS NULL AND id < ?)`, cursor.id);
      return;
    }
    if (!Number.isFinite(cursor.value)) return;
    // The rest of the valued block, then the whole NULL block after it.
    c.add(`(${col} IS NULL OR ${col} < ? OR (${col} = ? AND id < ?))`, cursor.value, cursor.value, cursor.id);
  }

  function cursorFor(sort, row) {
    if (sort === 'time') return { createdAt: row.created_at, id: row.id };
    const value = row[SORT_COLUMNS[sort]];
    return { value: value === null ? null : value, isNull: value === null, id: row.id };
  }

  function page(filters, cursor, limit, sort = 'time') {
    if (!Object.prototype.hasOwnProperty.call(SORT_COLUMNS, sort)) throw new TypeError(`Unknown sort "${sort}"`);
    const f = filters && typeof filters === 'object' ? filters : {};
    if (sort !== 'time') {
      const from = finite(f.from);
      const to = finite(f.to);
      if (from === null || to === null || to - from > MAX_SORT_RANGE_MS) {
        throw new RangeError(`Sorting by ${sort} needs a from/to range of at most 31 days`);
      }
    }
    const c = rowFilters(f);
    addCursor(c, sort, cursor);
    // The live tail (afterId set, no cursor) wants rows in the order they
    // arrived, which is what the primary key gives it directly. Ordering by
    // created_at instead would let a request logged out of clock order (or
    // just filed a millisecond late) jump the queue — and would need the
    // planner to sort id > ? results by a different column than the one the
    // filter used. Keyset paging (a cursor) keeps created_at, id: that's the
    // page order the log list shows. It is only offered on the time sort;
    // the sorted views are not tails.
    const liveTail = Number.isInteger(f.afterId) && !cursor && sort === 'time';
    const orderBy = liveTail ? 'id DESC' : sortOrder(sort);
    const rows = stmt(`SELECT * FROM request_logs ${whereSql(c.where)} ORDER BY ${orderBy} LIMIT ?`).all(...c.params, limit);
    const last = rows[rows.length - 1];
    return { rows, nextCursor: rows.length === limit ? cursorFor(sort, last) : null };
  }

  function list(filters, cursor, limit, sort = 'time') {
    return page(filters, cursor, clampLimit(limit), sort);
  }

  function get(id) {
    if (!Number.isInteger(id)) return null;
    const row = stmt('SELECT * FROM request_logs WHERE id = ?').get(id);
    if (!row) return null;
    const body = stmt('SELECT request_headers_json, request_body, response_body, truncated FROM request_bodies WHERE log_id = ?').get(id);
    return { ...row, body: body || null };
  }

  function stats(filters, bucket = 'hour', groupBy = 'none') {
    if (bucket !== 'hour' && bucket !== 'day') throw new TypeError(`Unknown bucket "${bucket}"`);
    if (groupBy !== 'error_class' && !Object.prototype.hasOwnProperty.call(GROUP_COLUMNS, groupBy)) {
      throw new TypeError(`Unknown groupBy "${groupBy}"`);
    }
    const f = filters && typeof filters === 'object' ? filters : {};
    const c = conditions();
    if (finite(f.from) !== null) c.add('hour_start >= ?', Math.floor(f.from / HOUR) * HOUR);
    if (finite(f.to) !== null) c.add('hour_start < ?', f.to);
    c.inList('source', items(f.source));
    c.inList('provider_id', items(f.providerId));
    if (nonEmpty(f.model)) c.add('model_id = ?', f.model);
    // Sum every counter in SQL, grouped by hour (and the group column, when
    // there is one): a range's rows collapse from one per combo to one per
    // hour[/group] before they ever reach JS. error_class has no group
    // column of its own (its "groups" are counter columns, not a queried
    // one), so it groups by hour_start alone, same as 'none'.
    const groupCol = GROUP_COLUMNS[groupBy] || null;
    const groupByCols = groupCol ? `hour_start, ${groupCol}` : 'hour_start';
    const sums = ROLLUP_COUNTERS.map((col) => `SUM(${col}) AS ${col}`).join(', ');
    const rows = stmt(`SELECT ${groupByCols}, ${sums} FROM usage_hourly ${whereSql(c.where)} GROUP BY ${groupByCols} ORDER BY ${groupByCols}`)
      .all(...c.params);

    const totals = emptyCounters();
    const series = new Map();
    rows.forEach((r) => {
      addCounters(totals, r);
      const b = bucket === 'day' ? localDay(r.hour_start) : r.hour_start;
      if (groupBy === 'error_class') {
        Object.entries(CLASS_COUNTERS).forEach(([cls, col]) => {
          if (!r[col]) return;
          const key = `${b}|${cls}`;
          const e = series.get(key) || { bucket: b, group: cls, count: 0 };
          e.count += r[col];
          series.set(key, e);
        });
        return;
      }
      const g = groupCol ? r[groupCol] : null;
      const key = `${b}|${g}`;
      if (!series.has(key)) series.set(key, { bucket: b, group: g, acc: emptyCounters() });
      addCounters(series.get(key).acc, r);
    });
    return {
      totals: summarize(totals),
      series: [...series.values()].map((e) => (e.acc ? { bucket: e.bucket, group: e.group, ...summarize(e.acc) } : e)),
    };
  }

  function facets(range) {
    const r = range && typeof range === 'object' ? range : {};
    const c = conditions();
    if (finite(r.from) !== null) c.add('hour_start >= ?', Math.floor(r.from / HOUR) * HOUR);
    if (finite(r.to) !== null) c.add('hour_start < ?', r.to);
    const also = (extra) => whereSql([...c.where, extra]);
    // The distinct ids come from usage_hourly (a handful of rows per hour,
    // never the raw table): '' is how a missing provider/model is rolled up
    // (writer.js), so it is filtered out the same way NULL was on the raw
    // rows. Provider names aren't rolled up, so the latest one for each id
    // found is looked up straight off request_logs_by_provider — an index
    // hit, not a scan, and one per distinct provider rather than one per row.
    const providerIds = stmt(`SELECT DISTINCT provider_id AS id FROM usage_hourly ${also("provider_id != ''")} ORDER BY provider_id`)
      .all(...c.params).map((x) => x.id);
    const models = stmt(`SELECT DISTINCT model_id AS id FROM usage_hourly ${also("model_id != ''")} ORDER BY model_id`)
      .all(...c.params).map((x) => x.id);
    const sources = stmt(`SELECT DISTINCT source FROM usage_hourly ${whereSql(c.where)} ORDER BY source`)
      .all(...c.params).map((x) => x.source);
    const latestName = stmt('SELECT provider_name AS name FROM request_logs WHERE provider_id = ? ORDER BY created_at DESC LIMIT 1');
    const providers = providerIds.map((id) => ({ id, name: (latestName.get(id) || {}).name ?? null }));
    return { providers, models, sources };
  }

  // The filters a runs listing may use. Deliberately a fixed subset rather
  // than rowFilters(): status, runId and afterId filter *rows*, and a row
  // filter inside an aggregate corrupts it — filter to status 'ok' and every
  // run comes back with ok === requests.
  function runFilters(filters) {
    const f = filters && typeof filters === 'object' ? filters : {};
    const c = conditions();
    c.add('run_id IS NOT NULL');
    if (finite(f.from) !== null) c.add('created_at >= ?', f.from);
    if (finite(f.to) !== null) c.add('created_at < ?', f.to);
    c.inList('source', items(f.source));
    c.inList('provider_id', items(f.providerId));
    if (nonEmpty(f.model)) c.add('model_requested = ?', f.model);
    const text = nonEmpty(f.text) ? f.text.trim().slice(0, 200) : '';
    if (text) c.add(`run_id ${LIKE}`, `%${escapeLike(text)}%`);
    return c;
  }

  // One row per run. from/to bound created_at, which prunes rows and not
  // groups: a run that began before `from` still appears, with started_at
  // clamped to its first in-range request and counters covering that part
  // only. Dropping it instead would hide the run the owner is looking at
  // whenever they narrow the range.
  //
  // AVG rather than a median because SQLite has no median; the true median
  // comes from runSummary, which computes it in JS over the run's own rows.
  //
  // No index beyond request_logs_by_time is needed: measured on a seeded
  // 60k-row database, adding (run_id, created_at) changed neither the plan
  // nor the time (22.1 ms to 21.2 ms, inside noise).
  function runs(filters, cursor, limit) {
    const c = runFilters(filters);
    const having = [];
    const havingParams = [];
    if (cursor && typeof cursor === 'object' && Number.isFinite(cursor.startedAt) && typeof cursor.runId === 'string') {
      // started_at is an aggregate, so its keyset lives in HAVING. Both
      // columns are NOT NULL here, so two branches are total.
      having.push('(started_at < ? OR (started_at = ? AND run_id < ?))');
      havingParams.push(cursor.startedAt, cursor.startedAt, cursor.runId);
    }
    const n = clampLimit(limit);
    const rows = stmt(`SELECT run_id,
        MIN(created_at) AS started_at,
        MAX(created_at) AS ended_at,
        COUNT(*) AS requests,
        SUM(status = 'ok') AS ok,
        SUM(status = 'cancelled') AS cancelled,
        SUM(cost_micros) AS cost_micros,
        AVG(latency_ms) AS avg_latency_ms,
        COUNT(DISTINCT model_requested) AS models,
        MIN(source) AS source
      FROM request_logs ${whereSql(c.where)}
      GROUP BY run_id
      ${having.length ? `HAVING ${having.join(' AND ')}` : ''}
      ORDER BY started_at DESC, run_id DESC
      LIMIT ?`).all(...c.params, ...havingParams, n);
    const last = rows[rows.length - 1];
    return { rows, nextCursor: rows.length === n ? { startedAt: last.started_at, runId: last.run_id } : null };
  }

  function runSummary(runId) {
    if (!nonEmpty(runId)) throw new TypeError('A run id is needed');
    const rows = stmt(`SELECT created_at, status, error_class, model_requested, provider_id, cost_micros, latency_ms, http_status, ttft_ms, is_stream
      FROM request_logs WHERE run_id = ? ORDER BY created_at, id`).all(runId);
    return summarizeRun(runId, rows);
  }

  // Written a keyset page at a time, yielding between pages, so a large
  // export never holds the main thread for long.
  async function exportTo(target, filters, format, { yieldFn = defaultYield } = {}) {
    if (format !== 'csv' && format !== 'json') throw new TypeError(`Unknown export format "${format}"`);
    const fd = fs.openSync(target, 'w');
    let written = 0;
    try {
      fs.writeSync(fd, format === 'csv' ? `${EXPORT_COLUMNS.join(',')}\r\n` : '[');
      let cursor = null;
      do {
        const p = page(filters, cursor, EXPORT_CHUNK);
        if (p.rows.length) {
          const text = format === 'csv'
            ? `${p.rows.map((r) => EXPORT_COLUMNS.map((col) => csvCell(r[col])).join(',')).join('\r\n')}\r\n`
            : `${written === 0 ? '\n' : ',\n'}${p.rows.map((r) => JSON.stringify(r)).join(',\n')}`;
          fs.writeSync(fd, text);
          written += p.rows.length;
        }
        cursor = p.nextCursor;
        if (cursor) await yieldFn();
      } while (cursor);
      if (format === 'json') fs.writeSync(fd, '\n]\n');
    } finally {
      fs.closeSync(fd);
    }
    return written;
  }

  function info() {
    const { rows, oldest } = stmt('SELECT COUNT(*) AS rows, MIN(created_at) AS oldest FROM request_logs').get();
    const last = Number(meta.get('last_purge_at'));
    return {
      enabled: true,
      error: null,
      path: file,
      sizeBytes: fileSize(file),
      rows,
      oldestAt: oldest,
      droppedRows: droppedRows(),
      lastPurgeAt: Number.isFinite(last) && last > 0 ? last : null,
    };
  }

  // Rows (and their bodies) older than `before`, and the roll-ups whose whole
  // hour lies before it (hour_start + 1 h <= before); everything when `before`
  // is absent. A present but non-finite `before` (NaN, a string, null, a
  // Date...) throws and deletes nothing, rather than silently clearing all.
  async function clear(opts, { yieldFn = defaultYield } = {}) {
    const hasBefore = !!opts && opts.before !== undefined;
    if (hasBefore && !Number.isFinite(opts.before)) throw new TypeError('clear({ before }) needs a finite number, or no before at all');
    const before = hasBefore ? opts.before : EVERYTHING;
    const logs = await purgeLogsBefore(db, before, { yieldFn });
    const rollups = await purgeRollupsBefore(db, before === EVERYTHING ? EVERYTHING : before - HOUR + 1, { yieldFn });
    await stepVacuum(db, { yieldFn });
    db.pragma('wal_checkpoint(TRUNCATE)');
    return { rows: logs.rows, bodies: logs.bodies, rollups: rollups.rollups };
  }

  return { list, get, stats, facets, runs, runSummary, exportTo, info, clear };
}

module.exports = { createQuery, createMeta, emptyStats, emptyRunSummary, EXPORT_COLUMNS };
