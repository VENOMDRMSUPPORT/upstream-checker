// Read-only SQLite explorer. All SQL, identifier checks, and redaction happen
// in main; this page renders the bounded safe response only.
(function () {
  'use strict';

  const PAGE_SIZE = 50;
  const state = { database: 'app', table: '', tables: [], schema: [], rows: [], totalRecords: 0, offset: 0, view: 'browse', loading: false };
  const byId = (id) => document.getElementById(id);
  const escape = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const number = (value) => new Intl.NumberFormat().format(Number(value) || 0);

  const DB_ICON = {
    tables: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>',
    database: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>',
    table: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M12 3v18"/></svg>',
    engine: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/></svg>',
    prev: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>',
    next: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>',
    itemTable: '<svg class="db-table-glyph" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>',
    headTable: '<svg class="db-head-icon-svg" width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="3" stroke="var(--accent)" stroke-width="1.8"/><path d="M3 9h18" stroke="var(--accent)" stroke-width="1.8"/><path d="M9 21V9" stroke="var(--accent)" stroke-width="1.8"/><rect x="4" y="4" width="16" height="4.5" rx="1.5" fill="var(--accent)" fill-opacity="0.25"/></svg>',
    emptyChoose: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>',
    emptyRecords: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><circle cx="12" cy="15" r="2"/></svg>',
  };

  const sourceCounts = { app: null, logs: null };

  function setNotice(message) {
    const box = byId('db-notice');
    if (!box) return;
    box.textContent = message || '';
    box.hidden = !message;
  }

  function updateSourceTabs() {
    const isApp = state.database === 'app';
    const isLogs = state.database === 'logs';
    const appTab = document.querySelector('[data-db-source="app"]');
    const logsTab = document.querySelector('[data-db-source="logs"]');
    if (appTab) {
      appTab.classList.toggle('active', isApp);
      appTab.setAttribute('aria-selected', isApp ? 'true' : 'false');
    }
    if (logsTab) {
      logsTab.classList.toggle('active', isLogs);
      logsTab.setAttribute('aria-selected', isLogs ? 'true' : 'false');
    }
    const appCount = byId('db-count-app');
    const logsCount = byId('db-count-logs');
    if (appCount && sourceCounts.app != null) appCount.textContent = number(sourceCounts.app);
    if (logsCount && sourceCounts.logs != null) logsCount.textContent = number(sourceCounts.logs);

    const select = byId('db-source');
    if (select && select.value !== state.database) {
      select.value = state.database;
    }
  }

  function renderCrumbs() {
    const el = byId('db-crumbs');
    if (!el || typeof breadcrumbHTML !== 'function') return;
    const dbLabel = state.database === 'app' ? 'venom.db' : 'venom-logs.db';
    const items = [
      { label: 'Overview', page: 'overview' },
      { label: 'Database', page: 'database', icon: 'database' },
      { label: dbLabel }
    ];
    if (state.table) {
      items.push({ label: state.table });
    }
    el.innerHTML = breadcrumbHTML(items);
  }

  function renderStats() {
    const dbName = state.database === 'app' ? 'venom.db' : 'venom-logs.db';
    const curTable = state.tables.find((t) => t.name === state.table);
    const container = byId('db-stats');
    if (!container) return;

    if (typeof statCardsHTML === 'function') {
      container.innerHTML = statCardsHTML([
        {
          label: 'Tables',
          value: state.tables.length,
          icon: DB_ICON.tables,
          foot: `in ${dbName}`
        },
        {
          label: 'Total records',
          value: number(state.totalRecords),
          icon: DB_ICON.database,
          foot: 'across all tables'
        },
        {
          label: 'Current table',
          value: state.table || 'None',
          icon: DB_ICON.table,
          foot: curTable ? `${number(curTable.count)} records` : 'select a table to inspect'
        },
        {
          label: 'Storage engine',
          value: 'SQLite 3',
          icon: DB_ICON.engine,
          foot: 'WAL mode · local storage'
        }
      ]);
    } else {
      container.innerHTML = [
        `<article class="db-stat-card"><span class="db-stat-icon">${DB_ICON.tables}</span><span><b>${number(state.tables.length)}</b><small>Tables</small></span></article>`,
        `<article class="db-stat-card"><span class="db-stat-icon">${DB_ICON.database}</span><span><b>${number(state.totalRecords)}</b><small>Database records</small></span></article>`,
        `<article class="db-stat-card"><span class="db-stat-icon">${DB_ICON.engine}</span><span><b>SQLite 3</b><small>Engine / storage</small></span></article>`,
      ].join('');
    }
    const countEl = byId('db-table-count');
    if (countEl) countEl.textContent = state.tables.length;
  }

  function renderTables() {
    const query = byId('db-filter') ? byId('db-filter').value.trim().toLowerCase() : '';
    const visible = state.tables.filter((table) => table.name.toLowerCase().includes(query));
    byId('db-table-list').innerHTML = visible.length ? visible.map((table) =>
      `<button type="button" class="db-table-item${table.name === state.table ? ' active' : ''}" data-db-table="${escape(table.name)}">${DB_ICON.itemTable}<code>${escape(table.name)}</code><span class="db-table-count">${number(table.count)}</span></button>`
    ).join('') : '<div class="db-list-empty">No matching tables</div>';
  }

  function renderHead() {
    const table = state.tables.find((entry) => entry.name === state.table);
    const info = byId('db-head-info');
    if (info) {
      info.innerHTML = table
        ? `<span class="db-head-kicker">TABLE / ${escape(state.database === 'app' ? 'VENOM SYSTEM' : 'REQUEST LOG')}</span><h2 class="db-head-main"><span class="db-head-icon">${DB_ICON.headTable}</span><code>${escape(table.name)}</code></h2>`
        : '<span class="db-head-kicker">DATABASE OVERVIEW</span><h2 class="db-head-main"><span>Select a table to inspect</span></h2>';
    }
    const countEl = byId('db-browse-count');
    if (countEl) {
      if (table && table.count != null) {
        countEl.textContent = number(table.count);
        countEl.hidden = false;
      } else {
        countEl.hidden = true;
      }
    }
  }

  function renderBrowse() {
    if (!state.table) {
      return `<div class="db-empty">
        <div class="db-empty-card">
          <div class="db-empty-badge">${DB_ICON.emptyChoose}</div>
          <span class="db-empty-tag">DATABASE WORKBENCH</span>
          <h3 class="db-empty-title">Choose a table</h3>
          <p class="db-empty-desc">Select a table from the list on the left to browse its records and inspect its schema.</p>
        </div>
      </div>`;
    }
    if (!state.rows.length) {
      return `<div class="db-empty">
        <div class="db-empty-card">
          <div class="db-empty-badge">
            <svg class="db-empty-svg" width="32" height="32" viewBox="0 0 36 36" fill="none" aria-hidden="true">
              <rect x="4" y="6" width="28" height="24" rx="6" fill="var(--bg-1)" stroke="var(--border-2)" stroke-width="1.8"/>
              <rect x="4" y="6" width="28" height="8" rx="6" fill="var(--accent)" fill-opacity="0.2"/>
              <line x1="4" y1="14" x2="32" y2="14" stroke="var(--border-2)" stroke-width="1.6"/>
              <circle cx="9" cy="10" r="1.8" fill="var(--accent)"/>
              <circle cx="14" cy="10" r="1.8" fill="#10b981"/>
              <line x1="11" y1="20" x2="25" y2="20" stroke="var(--text-3)" stroke-width="1.8" stroke-linecap="round" stroke-dasharray="2 3"/>
              <line x1="13" y1="24" x2="23" y2="24" stroke="var(--text-3)" stroke-width="1.8" stroke-linecap="round" stroke-dasharray="2 3"/>
            </svg>
          </div>
          <span class="db-empty-tag">0 RECORDS</span>
          <h3 class="db-empty-title">No records in this table</h3>
          <p class="db-empty-desc">The table <code>${escape(state.table)}</code> exists in SQLite${state.schema.length ? ` with ${state.schema.length} defined columns` : ''}, but does not contain any rows yet.</p>
          <div class="db-empty-actions">
            <button type="button" class="btn btn-ghost db-empty-view-btn" data-db-view="structure" title="Inspect columns, types, and primary keys">
              <svg class="db-tab-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 6h16" stroke="#f59e0b" stroke-width="2" stroke-linecap="round"/><circle cx="7" cy="6" r="1.6" fill="#f59e0b"/><path d="M4 12h16" stroke="#8b5cf6" stroke-width="2" stroke-linecap="round"/><circle cx="7" cy="12" r="1.6" fill="#8b5cf6"/><path d="M4 18h11" stroke="#06b6d4" stroke-width="2" stroke-linecap="round"/><circle cx="7" cy="18" r="1.6" fill="#06b6d4"/></svg>
              <span>View Table Structure</span>
            </button>
          </div>
        </div>
      </div>`;
    }
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
    const pager = byId('db-pager');
    if (pager) {
      pager.innerHTML = (table && table.count > 0 && state.view === 'browse')
        ? `<span>Showing <b>${number(state.offset + 1)}–${number(end)}</b> of ${number(table.count)} records</span><div class="db-pager-actions"><button class="btn btn-ghost db-page-btn" type="button" data-db-page="prev" ${state.offset === 0 ? 'disabled' : ''}>${DB_ICON.prev}<span>Previous</span></button><button class="btn btn-ghost db-page-btn" type="button" data-db-page="next" ${end >= table.count ? 'disabled' : ''}><span>Next</span>${DB_ICON.next}</button></div>`
        : '';
    }
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    const refreshBtn = byId('db-refresh');
    if (refreshBtn) refreshBtn.classList.add('refreshing');
    setNotice('Loading database…');
    try {
      let result = await window.electronAPI.databaseExplorer({
        database: state.database,
        table: state.table,
        limit: PAGE_SIZE,
        offset: state.offset
      });
      state.tables = result.tables;

      // Select first table by default if none is selected
      if (!state.table && state.tables.length > 0) {
        state.table = state.tables[0].name;
        state.offset = 0;
        result = await window.electronAPI.databaseExplorer({
          database: state.database,
          table: state.table,
          limit: PAGE_SIZE,
          offset: state.offset
        });
      } else if (state.table && !state.tables.some((table) => table.name === state.table)) {
        state.table = state.tables.length > 0 ? state.tables[0].name : '';
        state.offset = 0;
        if (state.table) {
          result = await window.electronAPI.databaseExplorer({
            database: state.database,
            table: state.table,
            limit: PAGE_SIZE,
            offset: state.offset
          });
        }
      }

      state.schema = result.schema || [];
      state.rows = result.rows || [];
      state.totalRecords = result.totalRecords || 0;
      sourceCounts[state.database] = state.tables.length;
      updateSourceTabs();
      renderCrumbs(); renderStats(); renderTables(); renderHead(); renderGrid(); setNotice('');

      const otherDb = state.database === 'app' ? 'logs' : 'app';
      if (sourceCounts[otherDb] == null) {
        window.electronAPI.databaseExplorer({ database: otherDb, limit: 1 }).then((res) => {
          if (res && res.tables) {
            sourceCounts[otherDb] = res.tables.length;
            updateSourceTabs();
          }
        }).catch(() => {});
      }
    } catch (error) {
      state.tables = []; state.schema = []; state.rows = []; state.totalRecords = 0;
      updateSourceTabs();
      renderCrumbs(); renderStats(); renderTables(); renderHead(); renderGrid();
      setNotice(`Could not read database: ${error.message || error}`);
    } finally {
      state.loading = false;
      if (refreshBtn) {
        setTimeout(() => refreshBtn.classList.remove('refreshing'), 350);
      }
    }
  }

  document.addEventListener('click', (event) => {
    const goButton = event.target.closest('#db-crumbs [data-go]');
    if (goButton && typeof showPage === 'function') {
      showPage(goButton.dataset.go);
      return;
    }
    const sourceTab = event.target.closest('[data-db-source]');
    if (sourceTab) {
      const nextDb = sourceTab.dataset.dbSource;
      if (nextDb && nextDb !== state.database) {
        state.database = nextDb;
        state.table = '';
        state.offset = 0;
        updateSourceTabs();
        load();
      }
      return;
    }
    const tableButton = event.target.closest('[data-db-table]');
    if (tableButton) { state.table = tableButton.dataset.dbTable; state.offset = 0; load(); return; }
    const viewButton = event.target.closest('[data-db-view]');
    if (viewButton) {
      state.view = viewButton.dataset.dbView;
      document.querySelectorAll('[data-db-view]').forEach((button) => {
        const active = button.dataset.dbView === state.view;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      renderGrid(); return;
    }
    const pageButton = event.target.closest('[data-db-page]');
    if (pageButton && !pageButton.disabled) { state.offset = Math.max(0, state.offset + (pageButton.dataset.dbPage === 'next' ? PAGE_SIZE : -PAGE_SIZE)); load(); }
  });
  byId('db-source').addEventListener('change', (event) => {
    if (event.target.value !== state.database) {
      state.database = event.target.value;
      state.table = '';
      state.offset = 0;
      updateSourceTabs();
      load();
    }
  });
  byId('db-filter').addEventListener('input', renderTables);
  byId('db-refresh').addEventListener('click', load);

  window.DATABASE = { render: load };
})();