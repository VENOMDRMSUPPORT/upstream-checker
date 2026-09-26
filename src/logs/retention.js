// ============================================
// Request log retention — chunked purge, stepped vacuum
// ============================================
// better-sqlite3 runs on the main thread, so one DELETE of a month of rows
// would freeze the window. Every delete here takes at most `chunk` rows,
// picked by a fresh short query each time (no iterator is held across a
// yield), and the event loop runs between chunks. A database closed
// mid-purge (the app quitting) ends the purge quietly.
const DAY = 86400000;
const CHUNK = 1000;
// Small enough that one step never sits on the main thread for long, so a
// request in flight (isBusy) is checked often and a purge that turns
// unwelcome mid-run gives it the thread back quickly.
const VACUUM_PAGES = 500;
const defaultYield = () => new Promise((resolve) => setImmediate(resolve));
const neverBusy = () => false;

// Runs step() (one chunk, one transaction, returns the rows it took) until a
// chunk comes back short, the database is gone, or isBusy() turns true —
// checked before every chunk (including the first), so a purge yields the
// rest of its work back to the scheduler the moment a request is in flight,
// rather than finishing the phase it happens to be in first.
async function inChunks(db, step, chunk, yieldFn, isBusy = neverBusy) {
  let total = 0;
  while (db.open && !isBusy()) {
    const n = step();
    total += n;
    if (n < chunk) break;
    await yieldFn();
  }
  return total;
}

async function purgeLogsBefore(db, cutoff, { chunk = CHUNK, yieldFn = defaultYield, isBusy = neverBusy } = {}) {
  const pick = 'SELECT id FROM request_logs WHERE created_at < ? ORDER BY created_at, id LIMIT ?';
  const deleteBodies = db.prepare(`DELETE FROM request_bodies WHERE log_id IN (${pick})`);
  const deleteRows = db.prepare(`DELETE FROM request_logs WHERE id IN (${pick})`);
  let bodies = 0;
  const step = db.transaction(() => {
    bodies += deleteBodies.run(cutoff, chunk).changes;
    return deleteRows.run(cutoff, chunk).changes;
  });
  const rows = await inChunks(db, step, chunk, yieldFn, isBusy);
  return { rows, bodies };
}

async function purgeBodiesBefore(db, cutoff, { chunk = CHUNK, yieldFn = defaultYield, isBusy = neverBusy } = {}) {
  const pick = 'SELECT log_id FROM request_bodies WHERE created_at < ? ORDER BY created_at, log_id LIMIT ?';
  const clearFlag = db.prepare(`UPDATE request_logs SET has_body = 0 WHERE id IN (${pick})`);
  const deleteBodies = db.prepare(`DELETE FROM request_bodies WHERE log_id IN (${pick})`);
  const step = db.transaction(() => {
    clearFlag.run(cutoff, chunk);
    return deleteBodies.run(cutoff, chunk).changes;
  });
  return { bodies: await inChunks(db, step, chunk, yieldFn, isBusy) };
}

async function purgeRollupsBefore(db, hourCutoff, { chunk = CHUNK, yieldFn = defaultYield, isBusy = neverBusy } = {}) {
  const del = db.prepare(`DELETE FROM usage_hourly WHERE rowid IN
    (SELECT rowid FROM usage_hourly WHERE hour_start < ? ORDER BY hour_start LIMIT ?)`);
  return { rollups: await inChunks(db, () => del.run(hourCutoff, chunk).changes, chunk, yieldFn, isBusy) };
}

// Hands freed pages back to the file system a few hundred at a time. Only
// an INCREMENTAL database can (auto_vacuum is set when the file is created).
async function stepVacuum(db, { pages = VACUUM_PAGES, yieldFn = defaultYield, maxSteps = 10000, isBusy = neverBusy } = {}) {
  if (!db.open || db.pragma('auto_vacuum', { simple: true }) !== 2) return;
  const n = Math.max(1, Math.floor(pages));
  for (let i = 0; i < maxSteps && db.open && !isBusy(); i += 1) {
    if (db.pragma('freelist_count', { simple: true }) === 0) return;
    db.pragma(`incremental_vacuum(${n})`);
    await yieldFn();
  }
}

function monthsAgo(now, months) {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.getTime();
}

// One retention pass (spec §3): old rows with their bodies, old bodies, old
// roll-ups, then the freed pages and the WAL. isBusy is re-checked between
// every phase (each of which already re-checks it between its own chunks):
// a request that starts mid-purge stops the rest of it early, same as the
// database closing — the scheduler's retry picks up where this left off.
async function purge(db, {
  now = Date.now(), logRetentionDays, bodyRetentionDays, statsRetentionMonths, meta,
  chunk = CHUNK, yieldFn = defaultYield, vacuumPages = VACUUM_PAGES, isBusy = neverBusy,
}) {
  if (!db.open || isBusy()) return null;
  const opts = { chunk, yieldFn, isBusy };
  const logs = await purgeLogsBefore(db, now - logRetentionDays * DAY, opts);
  if (!db.open || isBusy()) return null;
  const bodies = await purgeBodiesBefore(db, now - bodyRetentionDays * DAY, opts);
  if (!db.open || isBusy()) return null;
  const rollups = await purgeRollupsBefore(db, monthsAgo(now, statsRetentionMonths), opts);
  if (!db.open || isBusy()) return null;
  await stepVacuum(db, { pages: vacuumPages, yieldFn, isBusy });
  if (!db.open || isBusy()) return null;
  db.pragma('wal_checkpoint(TRUNCATE)');
  meta.set('last_purge_at', now);
  return { rows: logs.rows, bodies: logs.bodies + bodies.bodies, rollups: rollups.rollups };
}

// 30 s after startup, then every 24 h. While requests are in flight the run
// waits another minute: a purge chunk would sit between them and the log.
function createPurgeScheduler({
  run, isBusy = () => false, log = console,
  firstDelayMs = 30000, everyMs = DAY, retryMs = 60000,
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let timer = null;
  let stopped = false;
  let running = false;

  function schedule(ms) {
    if (stopped) return;
    timer = setTimer(tick, ms);
  }

  async function tick() {
    timer = null;
    if (stopped) return;
    if (isBusy()) {
      schedule(retryMs);
      return;
    }
    running = true;
    let result;
    try {
      result = await run();
    } catch (err) {
      log.warn('Request log purge failed:', err && err.message);
    } finally {
      running = false;
    }
    // null means the purge stopped early (busy, or the database closed): try
    // again sooner rather than waiting a full day for the rest of it.
    schedule(result === null ? retryMs : everyMs);
  }

  return {
    start: () => schedule(firstDelayMs),
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    isRunning: () => running,
  };
}

module.exports = {
  purge, purgeLogsBefore, purgeBodiesBefore, purgeRollupsBefore, stepVacuum, monthsAgo, createPurgeScheduler,
};
