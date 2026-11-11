// App shell navigation, page lifecycle and Overview summaries.
window.VENOM_RENDERER = window.VENOM_RENDERER || {};
window.VENOM_RENDERER.shell = {
  create(deps) {
    'use strict';
    const {
      $, $$, pageRouter, pageMeta, getProviders, getActiveProvider,
      getRunHistory, getRunLog, getProviderHealth, getCurrentPage,
      renderProviderHead, resetProviderPage, renderProfilePage,
      prepareSettingsPage, providerRoster, syncRoute, toggleTheme,
      switchSettingsSection, escapeHtml, renderQuickStatsIntervalMs = 60000,
    } = deps;

    function renderPageHeader(page) {
      // The provider page is a child of Providers: it wears that page's icon,
      // and its title is the provider it shows.
      const p = page === 'provider' ? getProviders()[getActiveProvider()] : null;
      const meta = p
        ? { title: p.name, desc: `Test the models ${p.name} offers, and manage its keys.` }
        : pageMeta[page];
      $('#shell-page-title').textContent = meta.title;
      $('#shell-page-desc').textContent = meta.desc;
      const navPage = page === 'provider' ? 'providers' : page;
      const icon = document.querySelector(`.shell-nav-item[data-page="${navPage}"] .shell-nav-icon`);
      const box = $('#shell-page-icon');
      box.replaceChildren();
      if (icon) box.appendChild(icon.cloneNode(true));
      document.title = `${meta.title} — VENOM Router`;
    }

    function showPage(page) {
      if (!pageRouter.isPage(page)) return;
      pageRouter.setCurrentPage(page);
      $$('.shell-page').forEach((el) => { el.hidden = el.dataset.page !== page; });
      $$('.shell-nav-item[data-page]').forEach((el) => {
        const on = el.dataset.page === (page === 'provider' ? 'providers' : page);
        el.classList.toggle('active', on);
        if (on) el.setAttribute('aria-current', 'page');
        else el.removeAttribute('aria-current');
      });
      renderPageHeader(page);
      if (page === 'overview') renderGettingStarted();
      if (page === 'provider') resetProviderPage();
      if (page === 'profile') renderProfilePage();
      if (page === 'settings') prepareSettingsPage();
      if (page === 'catalog' && window.CATALOG) (window.CATALOG.open ? window.CATALOG.open() : window.CATALOG.render());
      if (page === 'activity' && window.ACTIVITY) window.ACTIVITY.render();
      if (page === 'database' && window.DATABASE) window.DATABASE.render();
      if (page === 'history' && window.LOGS) window.LOGS.render();
      if (page === 'monitor' && window.LOGS) window.LOGS.renderMonitor();
      if (page === 'router' && window.ROUTER) window.ROUTER.render();
      // Leaving Test History stops its live tail; nothing else tells it the page is gone.
      if (page !== 'history' && window.LOGS) window.LOGS.sync();
      if (page === 'providers') providerRoster.resetForEntry();
      syncRoute();
    }

    function bindShell() {
      const { mountSidebarStars, bindSignatureHeart } = window.VENOM_RENDERER.effects;
      mountSidebarStars();
      bindSignatureHeart();
      const shell = $('#shell');
      renderPageHeader(getCurrentPage());
      $('#btn-theme-toggle').addEventListener('click', toggleTheme);
      $('#btn-header-debug')?.addEventListener('click', () => {
        showPage('settings');
        switchSettingsSection('sec-logs');
      });
      $('.page-overview').addEventListener('click', (e) => {
        const go = e.target.closest('[data-go]');
        if (go) showPage(go.dataset.go);
      });
      $('#shell-status').addEventListener('click', () => showPage('providers'));
      $$('.shell-nav-item[data-page]').forEach((el) => {
        el.addEventListener('click', () => showPage(el.dataset.page));
      });

      const menuBtn = $('#shell-menu-btn');
      const setNavOpen = (open) => {
        shell.classList.toggle('nav-open', open);
        menuBtn.setAttribute('aria-expanded', String(open));
        menuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      };
      menuBtn.addEventListener('click', () => setNavOpen(!shell.classList.contains('nav-open')));
      $('#shell-nav-close').addEventListener('click', () => setNavOpen(false));
      $('#shell-backdrop').addEventListener('click', () => setNavOpen(false));
      shell.querySelectorAll('.shell-nav-item:not(:disabled)').forEach((el) => {
        el.addEventListener('click', () => setNavOpen(false));
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && shell.classList.contains('nav-open')) setNavOpen(false);
      });
      window.matchMedia('(max-width: 1100px)').addEventListener('change', (mq) => {
        if (!mq.matches) setNavOpen(false);
      });
      setInterval(renderQuickStats, renderQuickStatsIntervalMs);
    }

    function formatAgo(ts) {
      const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
      if (s < 60) return 'just now';
      if (s < 3600) return `${Math.floor(s / 60)}m ago`;
      if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
      return `${Math.floor(s / 86400)}d ago`;
    }

    function scoreClass(rate) {
      if (rate >= 0.9) return '';
      return rate >= 0.6 ? 'low' : 'bad';
    }

    function renderQuickStats() {
      const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
      const history = getRunHistory();
      let last = 0;
      history.forEach((runs) => {
        const at = runs.length ? runs[runs.length - 1].at : 0;
        if (at > last) last = at;
      });
      const providers = getProviders();
      const ids = Object.keys(providers);
      const lastText = last ? formatAgo(last) : 'Never';
      set('stat-providers', ids.length);
      set('stat-models', history.size);
      set('stat-last-check', lastText);
      set('ov-providers', ids.length);
      set('ov-models', history.size);
      set('ov-last', lastText);
      const health = getProviderHealth();
      const states = ids.map((id) => (health.get(id) || {}).state);
      const testable = states.filter((state) => state && state !== 'none').length;
      set('ov-online', testable ? `${states.filter((state) => state === 'ok').length}/${testable}` : '—');
      renderSystemLamp();
      renderOverviewPanels();
      renderGettingStarted();
    }

    // The first-run journey, drawn from state rather than stored anywhere:
    // the card exists exactly while a step is missing, and a finished install
    // never sees it again. Step one is the password — being inside the app at
    // all means it is done, because the lock screen is where it happens.
    function renderGettingStarted() {
      const card = document.getElementById('getting-started');
      if (!card) return;
      const providers = getProviders();
      const connected = Object.values(providers)
        .filter((p) => (typeof isConnected === 'function' ? isConnected(p) : !!(p && p.keys && p.keys.length))).length;
      const cat = window.CATALOG ? window.CATALOG.state : null;
      const catalogRows = cat && cat.models ? cat.models.size : 0;
      const synced = catalogRows > 0;
      const journeyDone = connected > 0 && synced;
      card.hidden = journeyDone;
      if (journeyDone) return;

      const mark = (id, stateName) => {
        const row = document.getElementById(id);
        if (row) row.dataset.state = stateName;
      };
      mark('gs-step-password', 'done');
      mark('gs-step-connect', connected > 0 ? 'done' : 'current');
      mark('gs-step-sync', synced ? 'done' : (connected > 0 ? 'current' : 'pending'));
      const doneCount = 1 + (connected > 0 ? 1 : 0) + (synced ? 1 : 0);
      const meta = document.getElementById('gs-meta');
      if (meta) meta.textContent = `${doneCount} of 3 done`;
      const connectBtn = document.getElementById('gs-connect-btn');
      if (connectBtn) connectBtn.hidden = connected > 0;
      const syncBtn = document.getElementById('gs-sync-btn');
      if (syncBtn) {
        syncBtn.hidden = synced;
        syncBtn.disabled = connected === 0 || !!(cat && cat.syncing);
        syncBtn.textContent = cat && cat.syncing ? 'Syncing…' : 'Sync the catalog';
        if (!syncBtn.dataset.bound && typeof syncBtn.addEventListener === 'function') {
          syncBtn.dataset.bound = '1';
          syncBtn.addEventListener('click', gettingStartedSync);
        }
      }
    }

    // The checklist's own sync: roster discovery for what is connected, plus
    // the reference sources — the same two planes the Catalog page fills.
    // Failures are said in words on the card, never swallowed.
    async function gettingStartedSync() {
      const note = document.getElementById('gs-note');
      if (note) note.textContent = 'Syncing the catalog…';
      try {
        if (window.CATALOG && window.CATALOG.syncAll) await window.CATALOG.syncAll({ reason: 'getting-started' });
      } catch (_) { /* the roster plane reports through its own state */ }
      let failure = null;
      try {
        const reply = await window.electronAPI.catalogSources({ force: true });
        if (reply && reply.ok === false) failure = reply.message || reply.code || 'the sync was refused';
      } catch (err) {
        failure = err.message;
      }
      if (note) {
        note.textContent = failure
          ? `The reference sources could not be fetched (${failure}). Models from your connected providers still arrive on their own.`
          : '';
      }
      renderGettingStarted();
    }

    function renderOverviewPanels() {
      const trend = document.getElementById('ov-trend');
      const activity = document.getElementById('ov-activity');
      if (!trend || !activity) return;
      const runLog = getRunLog();
      if (runLog.length === 0) {
        const empty = '<div class="ov-empty">No test runs recorded yet.' +
          '<button class="btn btn-ghost" type="button" data-go="providers">Open Providers</button></div>';
        trend.innerHTML = empty;
        activity.innerHTML = empty;
        $('#ov-trend-meta').textContent = '';
        $('#ov-activity-meta').textContent = '';
        return;
      }

      const DAY = 86400000;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const days = [];
      for (let d = 13; d >= 0; d--) days.push({ start: today.getTime() - d * DAY, passed: 0, total: 0, runs: 0 });
      runLog.forEach((run) => {
        const idx = Math.floor((run.at - days[0].start) / DAY);
        if (idx < 0 || idx > 13) return;
        days[idx].passed += run.passed;
        days[idx].total += run.total;
        days[idx].runs += 1;
      });
      const fmt = (ts) => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      trend.innerHTML = '<div class="ov-trend-bars">' + days.map((day) => {
        if (day.total === 0) return `<div class="ov-trend-bar empty" title="${fmt(day.start)} · no runs"><span></span></div>`;
        const rate = day.passed / day.total;
        const pct = Math.round(rate * 100);
        return `<div class="ov-trend-bar ${scoreClass(rate)}" title="${fmt(day.start)} · ${pct}% pass · ${day.runs} run${day.runs === 1 ? '' : 's'}">` +
          `<span style="height:${Math.max(4, pct)}%"></span></div>`;
      }).join('') + '</div>' +
        `<div class="ov-trend-axis"><span>${fmt(days[0].start)}</span><span>Today</span></div>`;
      const totals = days.reduce((acc, day) => ({ p: acc.p + day.passed, t: acc.t + day.total }), { p: 0, t: 0 });
      $('#ov-trend-meta').innerHTML = totals.t ? `<b>${Math.round((totals.p / totals.t) * 100)}%</b> overall` : 'No runs in this window';

      const recent = runLog.slice(-6).reverse();
      activity.innerHTML = recent.map((run) => {
        const rate = run.total ? run.passed / run.total : 0;
        return `<div class="ov-activity-row">
      <span class="ov-activity-name">${escapeHtml(run.providerName)}</span>
      <span class="ov-activity-score ${scoreClass(rate)}">${run.passed}/${run.total}</span>
      <span class="ov-activity-when">${formatAgo(run.at)}</span>
    </div>`;
      }).join('');
      $('#ov-activity-meta').textContent = `${runLog.length} total`;
    }

    function renderSystemLamp() {
      const box = document.getElementById('shell-status');
      if (!box) return;
      const providers = getProviders();
      const health = getProviderHealth();
      const ids = Object.keys(providers);
      const states = ids.map((id) => (health.get(id) || {}).state || 'pending');
      const failed = ids.filter((_, i) => states[i] === 'fail').map((id) => providers[id].name);
      const checked = states.filter((state) => state === 'ok' || state === 'fail').length;
      const testable = states.filter((state) => state !== 'none').length;

      let state;
      let text;
      if (!navigator.onLine) {
        state = 'fail';
        text = 'Offline — no network connection';
      } else if (ids.length === 0 || testable === 0) {
        state = 'idle';
        text = 'No provider keys configured';
      } else if (checked < testable) {
        state = 'pending';
        text = `Checking providers… ${checked}/${testable}`;
      } else if (failed.length === 0) {
        state = 'ok';
        text = `All ${testable} providers online`;
      } else if (failed.length === testable) {
        state = 'fail';
        text = 'All providers unreachable';
      } else {
        state = 'fail';
        text = failed.length === 1 ? `${failed[0]} is unreachable` : `${failed.length} providers unreachable`;
      }
      box.dataset.state = state;
      const label = state === 'ok' ? 'All systems operational' : text;
      box.title = failed.length > 1 ? `${label}: ${failed.join(', ')}` : label;
      box.setAttribute('aria-label', box.title);
    }

    return { renderPageHeader, showPage, bindShell, formatAgo, scoreClass, renderQuickStats, renderOverviewPanels, renderSystemLamp };
  },
};
