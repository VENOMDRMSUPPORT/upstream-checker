// Results table sort/filter/export and response modal. Row HTML and reference
// facts stay injected so this unit owns table state, not catalog scoring.
window.VENOM_RENDERER = window.VENOM_RENDERER || {};
window.VENOM_RENDERER.results = {
  create(deps) {
    'use strict';
    const {
      escapeHtml, buildRowHtml, contextOf, scoreOf, costOf, latencyOf, uptimeOf, isCorrect,
      updateStats, setStatus, getTestResults, setTestResults, clearRunState,
      getActiveProviderMeta, downloadFile, modelById,
    } = deps;
    const $ = deps.$ || ((s) => document.querySelector(s));
    const $$ = deps.$$ || ((s) => document.querySelectorAll(s));

    let tableRows = [];
    let sortKey = null;
    let sortDir = 1;
    let showFailedOnly = false;

    function hasRows() { return tableRows.length > 0; }
    function isFailedFilterActive() { return showFailedOnly; }
    function forEachRow(fn) { tableRows.forEach(fn); }

    function tokensPerSecond(result) {
      if (!result || result.status !== 'pass' || result.isEmpty) return null;
      if (!result.completionTokens || !result.time) return null;
      return result.completionTokens / (result.time / 1000);
    }

    function init() {
      tableRows = [];
      sortKey = null;
      sortDir = 1;
      showFailedOnly = false;
      $('#results-empty').style.display = 'none';
      $('#results-table').style.display = '';
      $('#results-body').innerHTML = '';
    }

    function addRow(model, result) {
      tableRows.push({ model, result });
      const tbody = $('#results-body');
      const tr = document.createElement('tr');
      tr.dataset.modelId = model.id;
      tr.className = rowClassFor(result);
      tr.innerHTML = buildRowHtml(model, result, tableRows.length);
      tbody.appendChild(tr);
      syncColumnVisibility();
    }

    const SORTERS = {
      status: (e) => ({ fail: 0, skipped: 1, queued: 2, running: 3, pass: e.result.isEmpty ? 4 : 5 })[e.result.status] ?? 6,
      model: (e) => e.model.id.toLowerCase(),
      context: (e) => contextOf(e.model) ?? -1,
      score: (e) => scoreOf(e.model),
      price: (e) => { const c = costOf(e.model); return c.in == null ? c.out : c.in; },
      latency: (e) => latencyOf(e.model),
      time: (e) => (e.result.status === 'pass' ? e.result.time : null),
      tokens: (e) => (e.result.status === 'pass' ? e.result.tokens : null),
      tps: (e) => tokensPerSecond(e.result),
      uptime: (e) => uptimeOf(e.model.id),
      correct: (e) => {
        const c = isCorrect(e.result, e.model);
        return c == null ? null : c ? 1 : 0;
      },
    };

    function sortedRows(rows) {
      if (!sortKey) return rows;
      const read = SORTERS[sortKey];
      return [...rows].sort((a, b) => {
        const x = read(a);
        const y = read(b);
        const xNull = x == null || x === '';
        const yNull = y == null || y === '';
        if (xNull && yNull) return 0;
        if (xNull) return 1;
        if (yNull) return -1;
        if (typeof x === 'string') return x.localeCompare(y) * sortDir;
        return (x - y) * sortDir;
      });
    }

    function visibleRows() {
      const rows = showFailedOnly
        ? tableRows.filter((e) => e.result.status === 'fail' || e.result.isEmpty)
        : tableRows;
      return sortedRows(rows);
    }

    function render() {
      $('#results-body').innerHTML = visibleRows()
        .map(
          ({ model, result }, index) =>
            `<tr class="${rowClassFor(result)}" data-model-id="${escapeHtml(model.id)}">${buildRowHtml(model, result, index + 1)}</tr>`
        )
        .join('');
      syncColumnVisibility();
    }

    function syncColumnVisibility() {
      const table = $('#results-table');
      if (!table) return;
      table.classList.remove('hide-type', 'hide-context', 'hide-score', 'hide-price', 'hide-caps');
    }

    function toggleFailedFilter() {
      showFailedOnly = !showFailedOnly;
      updateStats();
      render();
    }

    function findResultRow(modelId) {
      let found = null;
      $$('#results-body tr').forEach((tr) => {
        if (!found && tr.dataset.modelId === modelId) found = tr;
      });
      return found;
    }

    function rowClassFor(result) {
      if (result.isEmpty) return 'row-empty';
      if (result.status === 'queued') return 'row-pending';
      if (result.status === 'running') return 'row-running';
      if (result.status === 'skipped') return 'row-skipped';
      return result.status === 'pass' ? 'row-pass' : 'row-fail';
    }

    function updateRow(model, result) {
      const entry = tableRows.find((e) => e.model.id === model.id);
      if (entry) entry.result = result;

      if (sortKey || showFailedOnly) {
        render();
        return;
      }
      const tr = findResultRow(model.id);
      if (!tr) return;
      const idx = tableRows.findIndex((e) => e.model.id === model.id);
      tr.className = rowClassFor(result);
      tr.innerHTML = buildRowHtml(model, result, idx >= 0 ? idx + 1 : null);
    }

    function exportFilename(ext) {
      const p = getActiveProviderMeta();
      const slug = (p ? p.name : 'results').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
      return `venom-router-${slug}-${stamp}.${ext}`;
    }

    function defaultDownload(content, filename, mimeType) {
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    }

    const saveFile = downloadFile || defaultDownload;

    function exportCsv() {
      const testResults = getTestResults();
      if (testResults.length === 0) return;
      const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const header =
        'Model,Provider,Plan,Status,Correct,Time (ms),Tokens,Completion Tokens,TPS,Attempts,Response\n';
      const rows = testResults
        .map((r) => {
          const tps = tokensPerSecond(r);
          const correct = isCorrect(r, modelById ? modelById(r.model) : null);
          return [
            q(r.model), q(r.provider), q(r.group || ''), q(r.status),
            correct == null ? '' : correct ? 'yes' : 'no',
            r.time ?? '', r.tokens ?? '', r.completionTokens ?? '',
            tps == null ? '' : tps.toFixed(2), r.attempts ?? 1,
            q(r.response),
          ].join(',');
        })
        .join('\n');
      saveFile(header + rows, exportFilename('csv'), 'text/csv');
    }

    function exportJson() {
      const testResults = getTestResults();
      if (testResults.length === 0) return;
      saveFile(JSON.stringify(testResults, null, 2), exportFilename('json'), 'application/json');
    }

    function clear() {
      setTestResults([]);
      clearRunState();
      tableRows = [];
      sortKey = null;
      sortDir = 1;
      showFailedOnly = false;
      $$('#results-table th').forEach((el) => el.classList.remove('sort-asc', 'sort-desc'));
      $('#results-empty').style.display = '';
      $('#results-table').style.display = 'none';
      $('#results-body').innerHTML = '';
      updateStats();
      setStatus('idle', 'Ready');
      $('#progress-container').style.display = 'none';
    }

    function bind() {
      $('#results-table thead').addEventListener('click', (e) => {
        const th = e.target.closest('.th-sortable');
        if (!th) return;
        const key = th.dataset.sort;
        if (sortKey === key) {
          if (sortDir === -1) sortKey = null;
          else sortDir = -1;
        } else {
          sortKey = key;
          sortDir = 1;
        }
        $$('#results-table th').forEach((el) => el.classList.remove('sort-asc', 'sort-desc'));
        if (sortKey) th.classList.add(sortDir === 1 ? 'sort-asc' : 'sort-desc');
        render();
      });

      $('#pt-kpis').addEventListener('click', (e) => {
        if (e.target.closest('[data-filter-failed]')) toggleFailedFilter();
      });
      $('#pt-kpis').addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('[data-filter-failed]')) {
          e.preventDefault();
          toggleFailedFilter();
        }
      });

      $('#results-body').addEventListener('click', (e) => {
        const cell = e.target.closest('.response-expandable');
        if (!cell) return;
        const tr = cell.closest('tr');
        const entry = tableRows.find((r) => r.model.id === tr?.dataset.modelId);
        if (!entry) return;
        $('#response-modal-title').textContent = entry.model.id;
        $('#response-modal-body').textContent = entry.result.response || '';
        $('#response-modal').style.display = 'flex';
      });

      $('#response-modal-close').addEventListener('click', () => {
        $('#response-modal').style.display = 'none';
      });
      $('#response-modal').addEventListener('click', (e) => {
        if (e.target.id === 'response-modal') $('#response-modal').style.display = 'none';
      });
      $('#response-modal-copy').addEventListener('click', () => {
        navigator.clipboard.writeText($('#response-modal-body').textContent || '');
      });

      $('#btn-export-csv').addEventListener('click', exportCsv);
      $('#btn-export-json').addEventListener('click', exportJson);
      $('#btn-clear-results').addEventListener('click', clear);
    }

    return {
      init, addRow, updateRow, render, clear, bind,
      hasRows, isFailedFilterActive, forEachRow, toggleFailedFilter,
      tokensPerSecond, exportCsv, exportJson, exportFilename,
      // Aliases matching previous app.js names for a gradual call-site migration.
      initResultsTable: init,
      addResultRow: addRow,
      updateResultRow: updateRow,
      renderResultsTable: render,
      clearResults: clear,
    };
  },
};
