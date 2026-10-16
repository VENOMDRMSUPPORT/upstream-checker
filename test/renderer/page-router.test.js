// Hash routes belong to the page-router unit; page changes remain app callbacks.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererModules } = require('./module-loader');

function setup(hash = '') {
  const location = { hash };
  const calls = [];
  const active = { page: 'overview', provider: 'alpha' };
  let router;
  const button = { dataset: { section: 'sec-general' } };
  const namespace = loadRendererModules(['page-router'], { window: { VENOM_RENDERER: {} } });
  router = namespace.pageRouter.create({
    location, history: { replaceState(_state, _title, next) { location.hash = next; calls.push(['replace', next]); } },
    $: () => button,
    getProviders: () => ({ alpha: {}, beta: {} }), getActiveProvider: () => active.provider,
    showPage: (page) => { active.page = page; router.setCurrentPage(page); calls.push(['show', page]); },
    openProviderPage: (id) => { active.provider = id; active.page = 'provider'; router.setCurrentPage('provider'); calls.push(['provider', id]); },
    switchSettingsSection: (section) => calls.push(['section', section]),
    logs: { tab: () => 'requests' },
  });
  return { router, location, calls, active, button };
}

test('routes decode provider and settings subpaths while invalid pages fall back to overview', () => {
  const provider = setup('#/provider/beta%20one');
  assert.deepEqual(JSON.parse(JSON.stringify(provider.router.parseRoute())), { page: 'provider', sub: 'beta one' });
  const invalid = setup('#/missing/extra');
  assert.deepEqual(JSON.parse(JSON.stringify(invalid.router.parseRoute())), { page: 'overview', sub: 'extra' });
  assert.equal(invalid.router.isPage('profile'), true);
  assert.equal(invalid.router.isPage('not-a-page'), false);
});

test('deep links delegate page entry and subpage behavior to the app', () => {
  const provider = setup('#/provider/beta');
  provider.router.applyRoute();
  assert.deepEqual(provider.calls, [['provider', 'beta']]);
  const settings = setup('#/settings/appearance');
  settings.router.applyRoute();
  assert.deepEqual(settings.calls, [['show', 'settings'], ['section', 'sec-appearance']]);
  const missingProvider = setup('#/provider/nope');
  missingProvider.router.applyRoute();
  assert.deepEqual(missingProvider.calls, [['show', 'providers']]);
});

test('route synchronization preserves provider, settings section and history tab subroutes', () => {
  const provider = setup();
  provider.router.setCurrentPage('provider');
  provider.router.syncRoute();
  assert.equal(provider.location.hash, '#/provider/alpha');
  const settings = setup();
  settings.router.setCurrentPage('settings');
  settings.router.syncRoute();
  assert.equal(settings.location.hash, '#/settings/general');
  const history = setup();
  history.router.setCurrentPage('history');
  history.router.syncRoute();
  assert.equal(history.location.hash, '#/history/requests');
});
