// Connected and integrated providers page controller.
window.VENOM_RENDERER = window.VENOM_RENDERER || {};
window.VENOM_RENDERER.providerRoster = {
  create(deps) {
    'use strict';
    const {
      $, $$, compactLayout, getProviders, getRunLog, getCurrentPage, isConnected, usableKeys,
      providerHealthLine, providerStats, providerAuthKinds, providerAuthGroup,
      providerDisplayModelsCount, providerHost, providerLegendHTML,
      groupHeadHTML, providerCardHTML, providerRowsHTML, dataToolbarHTML,
      bindDataToolbar, statCardsHTML, noMatchIcon, emptyIcon, plugIcon,
      authGroups, breadcrumbHTML, closeRateLimitPop, toggleExpanded,
      clearExpanded, setLegendCollapsed, getLegendCollapsed, testKey,
      setKeyActive, deleteKey, getKey, markCopied, setStatus, showPage,
      switchProvider, openAddKeyModal, openProviderPage, recheckProvider, connectAccount,
    } = deps;
    const state = { search: '', filter: 'all', status: 'all', sort: 'name', view: compactLayout.matches ? 'cards' : 'table' };
    let tab = 'connected';
    let shell = null;

    const toolbar = {
      placeholder: 'Search providers, models, hosts or URLs…',
      statusFilter: {
        icon: 'server', label: 'Provider Status',
        options: [
          { value: 'all', label: 'All Providers' },
          { value: 'ok', label: 'Connected' },
          { value: 'fail', label: 'Down' },
          { value: 'pending', label: 'Pending' },
          { value: 'none', label: 'No Active Key' },
        ],
      },
      filters: [
        { value: 'all', label: 'All' },
        { value: 'oauth', label: 'OAuth', dot: 'var(--type-oauth)' },
        { value: 'apikey', label: 'API Key', dot: 'var(--type-apikey)' },
      ],
      sorts: [
        { value: 'name', label: 'Name' },
        { value: 'rate', label: 'Pass rate' },
        { value: 'models', label: 'Models' },
        { value: 'recent', label: 'Last run' },
      ],
    };

    const KPI_ICON = {
      plug: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v4"/></svg>',
      key: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/></svg>',
      pulse: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>',
      target: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></svg>',
    };

    function lastRun(p) {
      const runs = getRunLog();
      for (let i = runs.length - 1; i >= 0; i--) if (runs[i].provider === p.id) return runs[i].at;
      return 0;
    }

    function modelSearchText(p) {
      try {
        if (window.CATALOG && typeof window.CATALOG.visibleEntries === 'function') {
          const rows = window.CATALOG.visibleEntries().filter((e) => e && e.providerId === p.id);
          if (rows.length) return rows.map((e) => `${e.name || ''} ${e.id || ''} ${e.family || ''}`).join(' ');
        }
        const models = window.CATALOG && window.CATALOG.state && window.CATALOG.state.models;
        if (models && typeof models.values === 'function') {
          return [...models.values()].filter((e) => e && e.providerId === p.id).map((e) => `${e.name || ''} ${e.id || ''} ${e.family || ''}`).join(' ');
        }
      } catch (_) {}
      return '';
    }

    function searchText(p) {
      const keys = (p.keys || []).map((k) => `${k.name || ''} ${k.hint || ''}`).join(' ');
      return `${p.name} ${providerHost(p)} ${p.baseUrl} ${keys} ${modelSearchText(p)}`;
    }

    function filtered(connected) {
      const q = state.search.trim().toLowerCase();
      let list = connected.filter((p) => {
        if (q && !searchText(p).toLowerCase().includes(q)) return false;
        if (state.filter !== 'all' && !providerAuthKinds(p).includes(state.filter)) return false;
        if (state.status !== 'all' && providerHealthLine(p).state !== state.status) return false;
        return true;
      });
      const stats = new Map(list.map((p) => [p.id, providerStats(p)]));
      const by = {
        name: (a, b) => a.name.localeCompare(b.name),
        rate: (a, b) => {
          const ra = stats.get(a.id)?.rate ?? null;
          const rb = stats.get(b.id)?.rate ?? null;
          if (ra == null && rb == null) return a.name.localeCompare(b.name);
          if (ra == null) return 1;
          if (rb == null) return -1;
          return rb !== ra ? rb - ra : a.name.localeCompare(b.name);
        },
        models: (a, b) => {
          const ma = providerDisplayModelsCount(a);
          const mb = providerDisplayModelsCount(b);
          if (ma == null && mb == null) return a.name.localeCompare(b.name);
          if (ma == null) return 1;
          if (mb == null) return -1;
          return mb !== ma ? mb - ma : a.name.localeCompare(b.name);
        },
        recent: (a, b) => lastRun(b) - lastRun(a),
      };
      list = list.sort(by[state.sort] || by.name);
      return { list, stats };
    }

    function renderConnectedKpis(connected, all) {
      const keys = connected.reduce((n, p) => n + p.keys.length, 0);
      const active = connected.reduce((n, p) => n + usableKeys(p).length, 0);
      const reachable = connected.filter((p) => providerHealthLine(p).state === 'ok').length;
      let passed = 0;
      let total = 0;
      getRunLog().forEach((r) => {
        if (connected.some((p) => p.id === r.provider)) { passed += r.passed; total += r.total; }
      });
      const rate = total ? passed / total : null;
      $('#pv-kpis').innerHTML = statCardsHTML([
        { label: 'Connected', value: connected.length, sub: `/ ${all.length}`, icon: KPI_ICON.plug, tone: 'green', subhead: 'OF INTEGRATED PROVIDERS', pill: connected.length ? `${connected.length} Active` : undefined, meter: all.length ? connected.length / all.length : 0, foot: 'of the integrated providers' },
        { label: 'Active keys', value: active, sub: `/ ${keys}`, icon: KPI_ICON.key, tone: 'amber', subhead: 'KEY ALLOCATION', pill: active ? `${active} Active` : undefined, meter: keys ? active / keys : 0, foot: keys - active ? `${keys - active} switched off` : 'all keys in use' },
        { label: 'Reachable', value: reachable, sub: `/ ${connected.length}`, icon: KPI_ICON.pulse, tone: connected.length && reachable < connected.length ? 'amber' : 'cyan', subhead: 'ENDPOINT HEALTH', pill: connected.length && reachable === connected.length ? 'All Reachable' : (connected.length && reachable ? `${reachable}/${connected.length} Reachable` : undefined), meter: connected.length ? reachable / connected.length : 0, foot: 'answered the health check' },
        { label: 'Pass rate', value: rate == null ? '—' : `${Math.round(rate * 100)}%`, icon: KPI_ICON.target, tone: 'blue', subhead: 'BENCHMARK RUNS', pill: rate != null ? `${Math.round(rate * 100)}% Benchmarked` : undefined, meter: rate, foot: total ? `${total.toLocaleString()} results recorded` : 'no runs recorded yet' },
      ]);
    }

    function renderConnectedResults(connected) {
      closeRateLimitPop();
      const results = $('#pv-results');
      const q = state.search.trim().toLowerCase();
      const searched = connected.filter((p) => (!q || searchText(p).toLowerCase().includes(q))
        && (state.status === 'all' || providerHealthLine(p).state === state.status));
      const count = { all: searched.length };
      authGroups.forEach((g) => { count[g] = searched.filter((p) => providerAuthKinds(p).includes(g)).length; });
      $$('#pv-toolbar [data-dt-count]').forEach((el) => { el.textContent = count[el.dataset.dtCount] ?? 0; });
      const { list, stats } = filtered(connected);
      if (!list.length) {
        results.innerHTML = `<div class="dt-nomatch"><span class="dt-nomatch-icon" aria-hidden="true">${noMatchIcon}</span><strong>No providers match</strong>Try a different search or filter.<button class="btn btn-ghost" type="button" data-dt-clear>Clear search and filters</button></div>`;
        return;
      }
      const groups = authGroups.map((g) => ({ g, items: list.filter((p) => (state.filter === 'all' ? providerAuthGroup(p) === g : g === state.filter)) })).filter((x) => x.items.length);
      results.innerHTML = state.view === 'table'
        ? providerRowsHTML(groups, stats)
        : groups.map((x) => groupHeadHTML(x.g, x.items.length) + `<div class="pv-grid">${x.items.map((p) => providerCardHTML(p, 'connected')).join('')}</div>`).join('');
    }

    function render() {
      closeRateLimitPop();
      const body = document.getElementById('pv-body');
      if (!body) return;
      const all = Object.values(getProviders());
      const connected = all.filter(isConnected);
      $('#pv-count-connected').textContent = connected.length;
      $('#pv-count-integrated').textContent = all.length;
      $$('.pv-tab').forEach((t) => {
        const on = t.dataset.tab === tab;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', String(on));
      });
      $('#pv-crumbs').innerHTML = breadcrumbHTML([
        { label: 'Overview', page: 'overview' },
        { label: 'Providers', tab: 'connected', icon: 'providers' },
        { label: tab === 'connected' ? 'Connected' : 'Integrated' },
      ]);
      if (tab === 'integrated') {
        shell = 'integrated';
        const groups = authGroups.map((g) => ({ g, items: all.filter((p) => providerAuthGroup(p) === g) })).filter((x) => x.items.length);
        body.innerHTML = providerLegendHTML(all) + groups.map((x) => groupHeadHTML(x.g, x.items.length) + `<div class="pv-grid pv-grid-compact">${x.items.map((p) => providerCardHTML(p, 'integrated')).join('')}</div>`).join('');
        return;
      }
      if (!connected.length) {
        shell = 'empty';
        body.innerHTML = `<div class="pv-empty"><div class="pv-empty-icon">${emptyIcon}</div><h3>No providers connected yet</h3><p>Connect an integrated provider with an API key and it will show up here, with its keys, health and test history in one place.</p><button class="btn btn-primary" type="button" data-tab="integrated">${plugIcon}Browse integrated providers</button></div>`;
        return;
      }
      if (shell !== 'connected') {
        shell = 'connected';
        body.innerHTML = `<div id="pv-kpis"></div><div id="pv-legend"></div><div id="pv-toolbar">${dataToolbarHTML(toolbar, state)}</div><div id="pv-results"></div>`;
        bindDataToolbar($('#pv-toolbar'), state, () => renderConnectedResults(Object.values(getProviders()).filter(isConnected)));
      }
      renderConnectedKpis(connected, all);
      $('#pv-legend').innerHTML = providerLegendHTML(connected);
      renderConnectedResults(connected);
    }

    function resetForEntry() {
      tab = 'connected';
      shell = null;
      state.view = compactLayout.matches ? 'cards' : 'table';
      setLegendCollapsed(true);
      try { localStorage.setItem('pvLegendCollapsed', '1'); } catch (_) {}
      render();
    }

    function connectProvider(id) {
      tab = 'connected';
      shell = null;
    }

    compactLayout.addEventListener('change', (e) => {
      state.view = e.matches ? 'cards' : 'table';
      tab = 'connected';
      clearExpanded();
      setLegendCollapsed(true);
      try { localStorage.setItem('pvLegendCollapsed', '1'); } catch (_) {}
      shell = null;
      if (getCurrentPage() === 'providers') render();
    });

    document.querySelector('.page-providers').addEventListener('keydown', (e) => {
      const row = e.target.closest && e.target.closest('.pv-row[data-kx-toggle]');
      if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        toggleExpanded(row.dataset.kxToggle);
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
      const input = document.querySelector('.shell-page:not([hidden]) [data-dt="search"]');
      if (input) { e.preventDefault(); input.focus(); }
    });
    $('.page-providers').addEventListener('click', async (e) => {
      const site = e.target.closest('[data-site]');
      if (site) { window.electronAPI.openExternal(site.dataset.site); return; }
      const keyAction = e.target.closest('[data-kx-test], [data-kx-active], [data-kx-del], [data-kx-copy]');
      if (keyAction) {
        if (keyAction.disabled) return;
        const [pid, kid] = (keyAction.dataset.kxTest || keyAction.dataset.kxActive || keyAction.dataset.kxDel || keyAction.dataset.kxCopy).split('|');
        if (keyAction.dataset.kxTest) testKey(pid, kid);
        else if (keyAction.dataset.kxActive) setKeyActive(pid, kid);
        else if (keyAction.dataset.kxDel) deleteKey(pid, kid);
        else if (getKey(pid, kid) && !getKey(pid, kid).locked) {
          try { await window.electronAPI.copyKey(kid); markCopied(keyAction); }
          catch (_) { setStatus('error', 'Could not copy the key to the clipboard'); }
        }
        return;
      }
      const toggle = e.target.closest('[data-kx-toggle]');
      if (toggle && (toggle.tagName === 'BUTTON' || !e.target.closest('button, a, input, .kx-panel'))) { toggleExpanded(toggle.dataset.kxToggle); return; }
      if (e.target.closest('[data-legend-toggle]')) {
        const collapsed = !getLegendCollapsed();
        setLegendCollapsed(collapsed);
        try { localStorage.setItem('pvLegendCollapsed', collapsed ? '1' : '0'); } catch (_) {}
        $$('.pv-legend').forEach((lg) => {
          lg.classList.toggle('collapsed', collapsed);
          const button = lg.querySelector('.pv-legend-toggle');
          button.setAttribute('aria-expanded', String(!collapsed));
          button.querySelector('span').textContent = collapsed ? 'Show legend' : 'Hide legend';
        });
        return;
      }
      if (e.target.closest('[data-dt-clear]')) {
        Object.assign(state, { search: '', filter: 'all', status: 'all', sort: 'name' });
        shell = null;
        render();
        return;
      }
      const el = e.target.closest('[data-tab], [data-go], [data-connect], [data-manage], [data-recheck], [data-copy], [data-show-connected]');
      if (!el || el.disabled) return;
      const { dataset: d } = el;
      if (d.tab) { tab = d.tab; shell = null; render(); return; }
      if (d.showConnected) { tab = 'connected'; toggleExpanded(d.showConnected); shell = null; render(); return; }
      if (d.go) { showPage(d.go); return; }
      if (d.connect) {
        const target = getProviders()[d.connect];
        // A provider that signs in on a web page has no key to paste: its
        // Connect button starts the sign-in, not the key modal.
        if (target && Array.isArray(target.auth) && target.auth.includes('oauth')) {
          if (connectAccount) connectAccount(d.connect);
          return;
        }
        switchProvider(d.connect);
        const name = target ? target.name : '';
        openAddKeyModal(tab === 'integrated' ? `Connect ${name}` : `Add key to ${name}`, tab === 'integrated' ? d.connect : undefined);
        return;
      }
      if (d.manage) { openProviderPage(d.manage); return; }
      if (d.recheck) { recheckProvider(d.recheck); return; }
      if (d.copy) {
        try { await navigator.clipboard.writeText(d.copy); markCopied(el); }
        catch (_) { setStatus('error', 'Could not copy to the clipboard'); }
      }
    });

    return {
      render,
      resetForEntry,
      connectProvider,
      getTab: () => tab,
      renderIfShown: () => { if (getCurrentPage() === 'providers') render(); },
      KPI_ICON,
    };
  },
};
