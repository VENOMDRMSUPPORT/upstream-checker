// ============================================
// Batched writer — request_logs, request_bodies, usage_hourly
// ============================================
// Each finished request reaches add() through the recorder, after the reply
// already went back to the renderer. Rows wait in memory and go to disk every
// 250 ms, or at once when 500 are waiting, in one transaction together with
// their bodies and the hourly roll-ups — so a roll-up never counts a row that
// isn't there, and one fsync covers the batch.
//
// Nothing here throws to the caller. A batch that can't be written is
// dropped and counted (logs-info shows the count), and electron-log hears
// about it at most once a minute.
const { latencyBucket } = require('./classify');

const HOUR = 3600000;
const WARN_EVERY_MS = 60000;

const ROW_COLUMNS = [
  'request_uid', 'created_at', 'source', 'run_id', 'attempt', 'is_hedge',
  'provider_id', 'provider_name', 'key_id', 'method', 'endpoint',
  'model_requested', 'model_returned', 'is_stream', 'status', 'http_status',
  'error_class', 'error_code', 'error_message', 'latency_ms', 'ttft_ms', 'first_byte_ms',
  'input_tokens', 'output_tokens', 'cached_tokens', 'cache_write_tokens', 'reasoning_tokens',
  'usage_source', 'cost_micros', 'price_json', 'has_body', 'meta_json',
  'user_id', 'token_id', 'subscription_id', 'client_ip',
];

const ROLLUP_KEYS = ['hour_start', 'provider_id', 'model_id', 'source'];
const ROLLUP_COUNTERS = [
  'requests', 'ok', 'cancelled', 'blocked', 'timeouts',
  'e_auth', 'e_rate_limit', 'e_quota', 'e_bad_request', 'e_server', 'e_network', 'e_other',
  'latency_sum_ms', 'latency_count',
  ...Array.from({ length: 14 }, (_, i) => `lb${i}`),
  'ttft_sum_ms', 'ttft_count',
  'input_tokens', 'output_tokens', 'cached_tokens', 'cost_micros',
];
const ERROR_CLASSES = new Set(['auth', 'rate_limit', 'quota', 'bad_request', 'server', 'network', 'other']);

// Plain addition on conflict: every counter is a sum.
const ROLLUP_SQL = `INSERT INTO usage_hourly (${[...ROLLUP_KEYS, ...ROLLUP_COUNTERS].join(', ')})
  VALUES (${[...ROLLUP_KEYS, ...ROLLUP_COUNTERS].map(() => '?').join(', ')})
  ON CONFLICT (hour_start, provider_id, model_id, source) DO UPDATE SET
  ${ROLLUP_COUNTERS.map((c) => `${c} = ${c} + excluded.${c}`).join(', ')}`;

// What one row adds to its hour's roll-up.
function rollupDelta(row) {
  const d = {
    hour_start: Math.floor(row.created_at / HOUR) * HOUR,
    provider_id: row.provider_id || '',
    model_id: row.model_requested || '',
    source: row.source || 'other',
  };
  ROLLUP_COUNTERS.forEach((c) => {
    d[c] = 0;
  });
  d.requests = 1;
  if (row.status === 'ok') d.ok = 1;
  else if (row.status === 'cancelled') d.cancelled = 1;
  else if (row.status === 'blocked') d.blocked = 1;
  else if (row.status === 'timeout') d.timeouts = 1;
  else d[`e_${ERROR_CLASSES.has(row.error_class) ? row.error_class : 'other'}`] = 1;
  // Latency only for an answer that came back: ok or error with an HTTP
  // status. A timeout, a network failure, a cancel or a block says nothing
  // about how fast the model answers.
  const answered = (row.status === 'ok' || row.status === 'error')
    && Number.isInteger(row.http_status) && row.error_class !== 'network' && Number.isFinite(row.latency_ms);
  if (answered) {
    d.latency_sum_ms = row.latency_ms;
    d.latency_count = 1;
    d[`lb${latencyBucket(row.latency_ms)}`] = 1;
  }
  if (row.is_stream && Number.isFinite(row.ttft_ms)) {
    d.ttft_sum_ms = row.ttft_ms;
    d.ttft_count = 1;
  }
  d.input_tokens = row.input_tokens || 0;
  d.output_tokens = row.output_tokens || 0;
  d.cached_tokens = row.cached_tokens || 0;
  d.cost_micros = row.cost_micros || 0;
  return d;
}

// Positional values for ROW_COLUMNS. better-sqlite3 binds no booleans and an
// explicit NULL skips a column's DEFAULT, so the flag columns are set here.
function rowValues(row, hasBody) {
  return ROW_COLUMNS.map((c) => {
    if (c === 'has_body') return hasBody ? 1 : 0;
    if (c === 'is_hedge' || c === 'is_stream') return row[c] ? 1 : 0;
    if (c === 'attempt') return Number.isInteger(row.attempt) && row.attempt > 0 ? row.attempt : 1;
    return row[c] === undefined ? null : row[c];
  });
}

function createWriter(db, {
  log = console, now = Date.now, flushMs = 250, batchMax = 500, queueCap = 10000,
  setTimer = setTimeout, clearTimer = clearTimeout, initialDropped = 0,
} = {}) {
  const insertRow = db.prepare(`INSERT INTO request_logs (${ROW_COLUMNS.join(', ')}) VALUES (${ROW_COLUMNS.map(() => '?').join(', ')})`);
  const insertBody = db.prepare(`INSERT INTO request_bodies
    (log_id, created_at, request_headers_json, request_body, response_body, truncated) VALUES (?, ?, ?, ?, ?, ?)`);
  const upsertRollup = db.prepare(ROLLUP_SQL);
  const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

  let queue = [];
  let timer = null;
  let stopped = false;
  let dropped = Number.isInteger(initialDropped) && initialDropped > 0 ? initialDropped : 0;
  // The count as last written to meta: mirrored with the next batch that commits.
  let mirrored = dropped;
  let lastWarnAt = -Infinity;

  const writeBatch = db.transaction((batch) => {
    batch.forEach(({ row, body }) => {
      const id = Number(insertRow.run(rowValues(row, !!body)).lastInsertRowid);
      if (body) {
        insertBody.run(id, row.created_at, body.request_headers_json ?? null, body.request_body ?? null,
          body.response_body ?? null, body.truncated ? 1 : 0);
      }
      const delta = rollupDelta(row);
      upsertRollup.run([...ROLLUP_KEYS, ...ROLLUP_COUNTERS].map((c) => delta[c]));
    });
    if (dropped !== mirrored) setMeta.run('dropped_rows', String(dropped));
  });

  function noteDropped(n, err) {
    dropped += n;
    const t = now();
    if (t - lastWarnAt < WARN_EVERY_MS) return;
    lastWarnAt = t;
    try {
      log.error(`Request log: dropped ${n} record(s)${err && err.message ? ` (${err.message})` : ''}; ${dropped} dropped so far`);
    } catch (_) {
      // A failing logger must not reach api-request either.
    }
  }

  function flush() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (queue.length === 0) return 0;
    const batch = queue;
    queue = [];
    try {
      writeBatch(batch);
      mirrored = dropped;
      return batch.length;
    } catch (err) {
      noteDropped(batch.length, err);
      return 0;
    }
  }

  function add(row, body = null) {
    try {
      queue.push({ row, body });
      if (queue.length > queueCap) {
        const over = queue.length - queueCap;
        queue.splice(0, over);
        noteDropped(over, new Error('the queue is full'));
      }
      if (queue.length >= batchMax) flush();
      else if (timer === null && !stopped) timer = setTimer(flush, flushMs);
    } catch (err) {
      noteDropped(1, err);
    }
  }

  function stop() {
    stopped = true;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  return { add, flush, stop, noteDropped, droppedRows: () => dropped, queued: () => queue.length };
}

module.exports = { createWriter, rollupDelta, ROW_COLUMNS, ROLLUP_KEYS, ROLLUP_COUNTERS };
