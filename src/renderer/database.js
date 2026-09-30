// Read-only SQLite explorer. All SQL, identifier checks, and redaction happen
// in main; this page renders the bounded safe response only.
(function () {
  'use strict';

  const PAGE_SIZE = 50;
  const state = { database: 'app', table: '', tables: [], schema: [], rows: [], totalRecords: 0, offset: 0, view: 'browse', loading: false };
  const byId = (id) => document.getElementById(id);
  const escape = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const number = (value) => new Intl.NumberFormat().format(Number(value) || 0);

  function setNotice(message) {
    const box = byId('db-notice');
    box.textContent = message || '';
    box.hidden = !message;
  }

  function renderStats() {
    byId('db-stats').innerHTML = [
      `<article class="db-stat-card"><span class="db-stat-icon">▤</span><span><b>${number(state.tables.length)}</b><small>Tables</small></span></article>`,
      `<article class="db-stat-card"><span class="db-stat-icon">▦</span><span><b>${number(state.totalRecords)}</b><small>Database records</small></span></article>`,
      `<article class="db-stat-card"><span class="db-stat-icon">◈</span><span><b>SQLite 3</b><small>Engine / storage</small></span></article>`,
    ].join('');
    byId('db-table-count').textContent = state.tables.length;
  }

  function renderTables() {
    const query = byId('db-filter').value.trim().toLowerCase();
    const visible = state.tables.filter((table) => table.name.toLowerCase().includes(query));
    byId('db-table-list').innerHTML = visible.length ? visible.map((table) =>
      `<button type="button" class="db-table-item${table.name === state.table ? ' active' : ''}" data-db-table="${escape(table.name)}"><span class="db-table-glyph">▦</span><code>${escape(table.name)}</code><span class="db-table-count">${number(table.count)}</span></button>`
    ).join('') : '<div class="db-list-empty">No matching tables</div>';
  }

  function renderHead() {
    const table = state.tables.find((entry) => entry.name === state.table);
    byId('db-content-head').innerHTML = table
      ? `<div><span class="db-head-kicker">TABLE / ${escape(state.database === 'app' ? 'VENOM SYSTEM' : 'REQUEST LOG')}</span><h2><span class="db-head-icon">▦</span><code>${escape(table.name)}</code></h2></div><span class="db-head-records">${number(table.count)} records</span>`
      : '<div><span class="db-head-kicker">DATABASE OVERVIEW</span><h2>Select a table to inspect</h2></div>';
  }

  function renderBrowse() {
    if (!state.table) return '<div class="db-empty"><span>▤</span><b>Choose a table</b><small>Select a table from the list to browse its records and structure.</small></div>';
    if (!state.rows.length) return '<div class="db-empty"><span>▦</span><b>No records in this table</b><small>The table exists, but it does not contain any rows yet.</small></div>';
    const columns = state.schema;
    return `<table class="db-data-table"><thead><tr><th class="db-index">#</th>${columns.map((column) => `<th>${escape(column.name)}${column.primaryKey ? '<span class="db-key-mark" title="Primary key"> PK</span>' : ''}</th>`).join('')}</tr></thead><tbody>${state.rows.map((row, index) => `<tr><td class="db-index">${number(state.offset + index + 1)}</td>${columns.map((column) => {
      const value = row[column.name];
      const display = value == null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value);
      return `<td class="${value == null ? 'db-null' : column.redacted ? 'db-redacted' : ''}" title="${escape(display)}">${escape(display)}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table>`;
  }

  function renderStructure() {
    if (!state.table) return renderBrowse();
    return `<table class="db-data-table db-structure-table"><thead><tr><th>#</th><th>Column</th><th>Type</th><th>Not null</th><th>Default</th><th>Key</th><th>Access</th></tr></thead><tbody>${state.schema.map((column, index) => `<tr><td class="db-index">${index + 1}</td><td><code>${escape(column.name)}</code></td><td><span class="db-type">${escape(column.type || '—')}</span></td><td>${column.notNull ? 'Yes' : 'No'}</td><td class="db-muted">${escape(column.defaultValue == null ? '—' : column.defaultValue)}</td><td>${column.primaryKey ? `<span class="db-key-mark">PK ${column.primaryKey > 1 ? column.primaryKey : ''}</span>` : '—'}</td><td>${column.redacted ? '<span class="db-sensitive">REDACTED</span>' : '<span class="db-safe">VISIBLE</span>'}</td></tr>`).join('')}</tbody></table>`;
  }

  function renderGrid() {
    byId('db-grid').innerHTML = state.view === 'structure' ? renderStructure() : renderBrowse();
    const table = state.tables.find((entry) => entry.name === state.table);
    const end = Math.min(state.offset + PAGE_SIZE, table ? table.count : 0);
    byId('db-pager').innerHTML = table ? `<span>Showing <b>${table.count ? number(state.offset + 1) : 0}–${number(end)}</b> of ${number(table.count)} records</span><div><button class="btn btn-ghost db-page-btn" type="button" data-db-page="prev" ${state.offset === 0 ? 'disabled' : ''}>← Previous</button><button class="btn btn-ghost db-page-btn" type="button" data-db-page="next" ${end >= table.count ? 'disabled' : ''}>Next →</button></div>` : '';
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    setNotice('Loading database…');
    try {
      const result = await window.electronAPI.databaseExplorer({ database: state.database, table: state.table, limit: PAGE_SIZE, offset: state.offset });
      state.tables = result.tables;
      state.schema = result.schema;
      state.rows = result.rows;
      state.totalRecords = result.totalRecords;
      if (state.table && !state.tables.some((table) => table.name === state.table)) state.table = '';
      renderStats(); renderTables(); renderHead(); renderGrid(); setNotice('');
    } catch (error) {
      state.tables = []; state.schema = []; state.rows = []; state.totalRecords = 0;
      renderStats(); renderTables(); renderHead(); renderGrid();
      setNotice(`Could not read database: ${error.message || error}`);
    } finally { state.loading = false; }
  }

  document.addEventListener('click', (event) => {
    const tableButton = event.target.closest('[data-db-table]');
    if (tableButton) { state.table = tableButton.dataset.dbTable; state.offset = 0; load(); return; }
    const viewButton = event.target.closest('[data-db-view]');
    if (viewButton) {
      state.view = viewButton.dataset.dbView;
      document.querySelectorAll('[data-db-view]').forEach((button) => {
        const active = button === viewButton;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      renderGrid(); return;
    }
    const pageButton = event.target.closest('[data-db-page]');
    if (pageButton && !pageButton.disabled) { state.offset = Math.max(0, state.offset + (pageButton.dataset.dbPage === 'next' ? PAGE_SIZE : -PAGE_SIZE)); load(); }
  });
  byId('db-source').addEventListener('change', (event) => { state.database = event.target.value; state.table = ''; state.offset = 0; load(); });
  byId('db-filter').addEventListener('input', renderTables);
  byId('db-refresh').addEventListener('click', load);

  window.DATABASE = { render: load };
})();