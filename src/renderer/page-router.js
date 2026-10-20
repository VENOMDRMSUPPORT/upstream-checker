// Hash-route parsing and synchronization for the renderer shell.
window.VENOM_RENDERER = window.VENOM_RENDERER || {};
window.VENOM_RENDERER.pageRouter = {
  create(deps) {
    'use strict';
    const {
      location, history, $, getProviders, getActiveProvider, showPage,
      openProviderPage, switchSettingsSection, logs,
    } = deps;
    const pages = ['overview', 'providers', 'provider', 'catalog', 'activity', 'database', 'history', 'monitor', 'router', 'profile', 'settings'];
    let currentPage = 'overview';

    function parseRoute() {
      const [page, sub] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
      return { page: pages.includes(page) ? page : 'overview', sub: sub || '' };
    }

    function syncRoute() {
      let hash = `#/${currentPage}`;
      if (currentPage === 'provider' && getActiveProvider()) hash += `/${encodeURIComponent(getActiveProvider())}`;
      if (currentPage === 'settings') {
        const btn = $('#settings-nav .settings-nav-item.active');
        if (btn) hash += `/${btn.dataset.section.replace(/^sec-/, '')}`;
      }
      if (currentPage === 'history' && logs) hash += `/${logs.tab()}`;
      if (location.hash !== hash) history.replaceState(null, '', hash);
    }

    function applyRoute() {
      const { page, sub } = parseRoute();
      if (page === 'provider') {
        if (sub && getProviders()[sub]) openProviderPage(sub);
        else showPage('providers');
        return;
      }
      showPage(page);
      if (page === 'settings' && sub) switchSettingsSection(`sec-${sub}`);
    }

    return {
      pages,
      isPage: (page) => pages.includes(page),
      getCurrentPage: () => currentPage,
      setCurrentPage: (page) => { if (pages.includes(page)) currentPage = page; },
      parseRoute,
      syncRoute,
      applyRoute,
    };
  },
};
