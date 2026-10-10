// ============================================
// Roster change events — roster_events
// ============================================
// One row per model arrival and departure, written by the catalog ingest flow
// from syncSnapshot's edge (appearedIds/disappearedIds). The bell and the
// history view read here; nothing else writes.
//
// Bounded: the newest EVENTS_KEPT rows are kept and older ones are trimmed on
// write, so a chattering provider cannot grow the table without bound.
//
// Statements are prepared on first use rather than at assembly (the auth-repo
// pattern): the table arrives with migration v5, and `open()` assembles the
// repos before it knows which migrations will run.
const EVENTS_KEPT = 500;
const KINDS = new Set(['added', 'removed']);

function createRosterEventsRepo(db) {
  const prepared = new Map();
  const sql = (key, text) => {
    if (!prepared.has(key)) prepared.set(key, db.prepare(text));
    return prepared.get(key);
  };

  // items: [{ id, name }]. One transaction: insert, then trim past the cap.
  function record(providerId, items, kind, at = Date.now()) {
    if (!KINDS.has(kind)) throw new Error(`unknown roster event kind: ${kind}`);
    const list = Array.isArray(items) ? items : [];
    if (!providerId || !list.length) return 0;
    return db.transaction(() => {
      const insert = sql('insert',
        'INSERT INTO roster_events (provider_id, model_id, name, kind, at, is_read) VALUES (?, ?, ?, ?, ?, 0)');
      for (const item of list) {
        const id = item && item.id != null ? String(item.id) : '';
        if (!id) continue;
        insert.run(String(providerId), id, item.name != null ? String(item.name) : null, kind, at);
      }
      sql('trim', `DELETE FROM roster_events WHERE id NOT IN
        (SELECT id FROM roster_events ORDER BY id DESC LIMIT ${EVENTS_KEPT})`).run();
      return list.length;
    })();
  }

  function list({ providerId = null, kind = null, limit = 50, unreadOnly = false, search = null } = {}) {
    if (kind != null && !KINDS.has(kind)) throw new Error(`unknown roster event kind: ${kind}`);
    const capped = Math.max(1, Math.min(200, Math.floor(Number(limit)) || 50));
    const where = [];
    const params = [];
    if (providerId != null) {
      where.push('provider_id = ?');
      params.push(String(providerId));
    }
    if (kind != null) {
      where.push('kind = ?');
      params.push(kind);
    }
    if (unreadOnly) where.push('is_read = 0');
    if (typeof search === 'string' && search.trim() !== '') {
      // LIKE with % and _ literal: a search for either must not become a wildcard.
      where.push('(provider_id LIKE ? ESCAPE \'\\\' OR model_id LIKE ? ESCAPE \'\\\' OR COALESCE(name, \'\') LIKE ? ESCAPE \'\\\')');
      const q = `%${search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(q, q, q);
    }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return sql(`list:${filter}:${capped}`, `SELECT id, provider_id, model_id, name, kind, at, is_read
      FROM roster_events ${filter} ORDER BY id DESC LIMIT ${capped}`).all(...params)
      .map((row) => ({ ...row, is_read: row.is_read === 1 }));
  }

  // Totals for the stat cards and the filter chips. Same filters as list(),
  // minus kind: chips show each kind's share of the current filter.
  function counts({ providerId = null, search = null } = {}) {
    const where = [];
    const params = [];
    if (providerId != null) {
      where.push('provider_id = ?');
      params.push(String(providerId));
    }
    if (typeof search === 'string' && search.trim() !== '') {
      where.push('(provider_id LIKE ? ESCAPE \'\\\' OR model_id LIKE ? ESCAPE \'\\\' OR COALESCE(name, \'\') LIKE ? ESCAPE \'\\\')');
      const q = `%${search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(q, q, q);
    }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = sql(`counts:${filter}`, `SELECT kind, COUNT(*) AS n FROM roster_events
      ${filter} GROUP BY kind`).all(...params);
    const out = { added: 0, removed: 0, total: 0 };
    for (const row of rows) {
      if (KINDS.has(row.kind)) out[row.kind] = row.n;
      out.total += row.n;
    }
    return out;
  }

  function unreadCount(providerId = null) {
    if (providerId != null) {
      return sql('unreadBy', 'SELECT COUNT(*) AS n FROM roster_events WHERE is_read = 0 AND provider_id = ?')
        .get(String(providerId)).n;
    }
    return sql('unread', 'SELECT COUNT(*) AS n FROM roster_events WHERE is_read = 0').get().n;
  }

  // { ids: [...] } marks those rows; { all: true } marks everything (optionally
  // only rows at or before `before`, so a concurrent arrival stays unread).
  function markRead({ ids = null, all = false, before = null } = {}) {
    if (all) {
      if (before != null) {
        return sql('readAllBefore', 'UPDATE roster_events SET is_read = 1 WHERE is_read = 0 AND at <= ?')
          .run(Number(before)).changes;
      }
      return sql('readAll', 'UPDATE roster_events SET is_read = 1 WHERE is_read = 0').run().changes;
    }
    const clean = [...new Set(Array.isArray(ids) ? ids : [])]
      .map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!clean.length) return 0;
    return sql(`readIds:${clean.length}`, `UPDATE roster_events SET is_read = 1
      WHERE is_read = 0 AND id IN (${clean.map(() => '?').join(',')})`).run(...clean).changes;
  }

  return { record, list, counts, unreadCount, markRead, EVENTS_KEPT };
}

module.exports = { createRosterEventsRepo, EVENTS_KEPT };
