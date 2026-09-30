// Read-only, bounded database inspection. Identifiers are taken only from
// sqlite_master and quoted; callers can never submit SQL or arbitrary paths.
const MAX_LIMIT = 100;
const REDACTED_COLUMN = /(?:cipher|secret|api.?key|password|request_body|response_body|headers|prompt|client_ip|token_id|user_id|subscription_id)/i;

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function inspectDatabase(db, database, tableName, requestedLimit, requestedOffset) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(({ name }) => ({
      name,
      count: db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`).get().count,
    }));
  if (tableName && !tables.some((table) => table.name === tableName)) throw new TypeError('Unknown table');
  const schema = tableName
    ? db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all().map((column) => ({
      name: column.name,
      type: column.type,
      notNull: !!column.notnull,
      primaryKey: column.pk,
      defaultValue: column.dflt_value,
      redacted: REDACTED_COLUMN.test(column.name),
    }))
    : [];
  if (schema.some((column) => REDACTED_COLUMN.test(column.name))) {
    // Do not even read values from sensitive fields: bodies can be very large
    // and may contain user content in addition to credentials.
    const visibleColumns = schema.filter((column) => !column.redacted).map((column) => quoteIdentifier(column.name));
    if (visibleColumns.length === 0) {
      const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(requestedLimit) || 50)));
      const offset = Math.max(0, Math.min(10000000, Math.floor(Number(requestedOffset) || 0)));
      const rows = db.prepare(`SELECT 1 AS "_record" FROM ${quoteIdentifier(tableName)} LIMIT ? OFFSET ?`).all(limit, offset).map(() => ({ _record: '[redacted]' }));
      const totalRecords = tables.reduce((sum, table) => sum + table.count, 0);
      return { database, tables, schema, rows, table: tableName, limit, offset, totalRecords };
    }
  }
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(requestedLimit) || 50)));
  const offset = Math.max(0, Math.min(10000000, Math.floor(Number(requestedOffset) || 0)));
  const selectedColumns = schema.map((column) => column.redacted ? `NULL AS ${quoteIdentifier(column.name)}` : quoteIdentifier(column.name)).join(', ');
  const rows = tableName
    ? db.prepare(`SELECT ${selectedColumns} FROM ${quoteIdentifier(tableName)} LIMIT ? OFFSET ?`).all(limit, offset).map((row) => {
      const safe = {};
      schema.forEach((column) => { safe[column.name] = column.redacted ? '[redacted]' : row[column.name]; });
      return safe;
    })
    : [];
  const totalRecords = tables.reduce((sum, table) => sum + table.count, 0);
  return { database, tables, schema, rows, table: tableName || null, limit, offset, totalRecords };
}

module.exports = { inspectDatabase, MAX_LIMIT };