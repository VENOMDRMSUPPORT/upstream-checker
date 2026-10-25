// Live acceptance for extracted renderer units: real DOM and scratch data only.
// Run: node scripts/live/verify-renderer-modules.mjs
// Uses a local mock provider; never reads owner data or downloads/installs updates.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './cdp.mjs';
import { writeFixture } from './fixture.mjs';
import { startMock } from './mock-provider.mjs';

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -> ${detail}` : ''}`);
}
const dir = mkdtempSync(join(tmpdir(), 'venom-renderer-modules-'));
let mock;
let app;
try {
  mock = await startMock(47869);
  writeFixture(dir, mock.origin);
  app = await launch({ userDataDir: dir, port: 9379 });
  await app.evaluate(`(() => {
    window.__rendererErrors = [];
    window.addEventListener('error', e => window.__rendererErrors.push(e.message || String(e.error || e)));
    window.addEventListener('unhandledrejection', e => window.__rendererErrors.push(String(e.reason?.stack || e.reason)));
    const originalConsoleError = console.error.bind(console);
    console.error = (...args) => { window.__rendererErrors.push(args.map(String).join(' ')); originalConsoleError(...args); };
  })()`);
  await app.unlockAndWait();
  await app.waitFor('window.CATALOG && CATALOG.state.lastSyncAt > 0 && !CATALOG.state.syncing', 30000);
  const startupErrors = await app.evaluate('window.__rendererErrors || []');
  check('renderer startup completes without page errors', startupErrors.length === 0, JSON.stringify(startupErrors));
  const modules = await app.evaluate('Object.keys(window.VENOM_RENDERER).sort()');
  check('all extracted units load together in the real renderer', modules.join(',') === 'appearance,attempts,defaults,effects,oauthConnect,pageRouter,policy,providerActions,providerDetail,providerKeys,providerModels,providerRoster,providerStore,providerView,responses,results,runner,settingsPanel,shell,updates', modules.join(', '));

  const providerDetail = await app.evaluate(`(() => {
    openProviderPage('darkapi');
    const page = document.querySelector('.page-provider');
    const rect = page.getBoundingClientRect();
    const visible = !page.hidden && rect.width > 0 && rect.height > 0
      && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
    return { visible, provider: document.querySelector('#pt-crumbs').textContent,
      keyCount: document.querySelectorAll('#keys-list .key-item').length,
      names: [...document.querySelectorAll('#keys-list .key-name')].map(el => el.textContent) };
  })()`);
  check('provider detail header and key list are visible in the real renderer', providerDetail.visible && providerDetail.keyCount === 3 && providerDetail.names.includes('Dark one') && providerDetail.names.includes('Custom only'), JSON.stringify(providerDetail));

  // The OAuth provider: the panel says Accounts, the button says Connect, and
  // the button a person would click is on screen. The key one is not there —
  // an account is signed in, not pasted.
  const oauthProvider = await app.evaluate(`(() => {
    openProviderPage('muse');
    const connect = document.getElementById('btn-connect-account');
    const add = document.getElementById('btn-add-key');
    const rect = connect && connect.getBoundingClientRect();
    return {
      connectVisible: !!connect && !connect.hidden && rect.width > 0 && rect.height > 0,
      addHidden: !!add && add.hidden,
      label: (document.getElementById('pt-keys-label-text') || {}).textContent || '',
      empty: (document.querySelector('#keys-list .models-empty') || {}).textContent || '',
    };
  })()`);
  check('an OAuth provider offers Connect instead of Add API Key', oauthProvider.connectVisible && oauthProvider.addHidden && oauthProvider.label === 'Accounts', JSON.stringify(oauthProvider));

  // The provider's logo has to load, not merely point at a file: an image
  // that never decoded renders as a dead tile.
  const museLogo = await app.evaluate(`(() => {
    document.querySelector('.shell-nav-item[data-page="providers"]').click();
    document.querySelector('.pv-tab[data-tab="integrated"]').click();
    const cards = [...document.querySelectorAll('.pv-grid-compact .pv-card')];
    const card = cards.find(c => (c.textContent || '').includes('Muse AI'));
    const img = card && card.querySelector('img');
    const rect = img && img.getBoundingClientRect();
    return { card: !!card, img: !!img, complete: !!(img && img.complete), natural: img ? img.naturalWidth : 0,
      src: img ? img.getAttribute('src') : '', visible: !!rect && rect.width > 0 && rect.height > 0 };
  })()`);
  check("the Muse logo file loads and draws in the integrated roster", museLogo.card && museLogo.img && museLogo.complete && museLogo.natural > 0 && museLogo.visible, JSON.stringify(museLogo));

  const providerModels = await app.evaluate(`(() => {
    switchProvider('darkapi');
    document.getElementById('btn-fetch-models').click();
    return true;
  })()`);
  await app.waitFor('PROVIDERS.darkapi.models.length > 0 && getProviderModels("darkapi") === PROVIDERS.darkapi.models', 15000);
  check('provider model discovery stores and serves the roster from its provider record', providerModels && await app.evaluate('PROVIDERS.darkapi.models.some(m => m.id === "fixture-alpha") && PROVIDERS.darkapi.selected.has("fixture-alpha")'));

  const providerRoster = await app.evaluate(`(() => {
    const errors = [];
    const capture = e => errors.push(e.message || String(e.error || e));
    window.addEventListener('error', capture);
    document.querySelector('.shell-nav-item[data-page="providers"]').click();
    const page = document.querySelector('.page-providers');
    const rect = page.getBoundingClientRect();
    const visible = !page.hidden && rect.width > 0 && rect.height > 0
      && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
    const results = document.querySelector('#pv-results');
    const firstRow = results && results.querySelector('.pv-rowcard, .pv-card');
    const rowRect = firstRow && firstRow.getBoundingClientRect();
    const connected = { visible, count: Number(document.getElementById('pv-count-connected').textContent),
      integrated: Number(document.getElementById('pv-count-integrated').textContent),
      results: !!results, rows: results ? results.querySelectorAll('.pv-rowcard, .pv-card').length : 0,
      firstRowVisible: !!firstRow && rowRect.width > 0 && rowRect.height > 0 && rowRect.bottom > 0 && rowRect.top < innerHeight,
      resultText: results?.textContent.trim().slice(0, 100), resultHtml: results?.innerHTML.slice(0, 300), errors };
    document.querySelector('.pv-tab[data-tab="integrated"]').click();
    const grid = document.querySelector('.pv-grid-compact');
    const gridRect = grid && grid.getBoundingClientRect();
    window.removeEventListener('error', capture);
    return { ...connected, integratedGridVisible: !!grid && gridRect.width > 0 && gridRect.height > 0,
      integratedCards: grid ? grid.querySelectorAll('.pv-card').length : 0 };
  })()`);
  check('connected and integrated provider roster render visibly from live data', providerRoster.visible && providerRoster.count > 0 && providerRoster.integrated === 13 && providerRoster.results && providerRoster.rows === providerRoster.count && providerRoster.firstRowVisible && providerRoster.errors.length === 0 && providerRoster.integratedGridVisible && providerRoster.integratedCards > 0, JSON.stringify(providerRoster));

  const appearance = await app.evaluate(`(() => {
    document.querySelector('.shell-nav-item[data-page="settings"]').click();
    document.querySelector('[data-section="sec-appearance"]').click();
    const visible = sel => {
      const el = document.querySelector(sel);
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return !el.hidden && style.display !== 'none' && style.visibility !== 'hidden'
        && r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0
        && r.left < innerWidth && r.top < innerHeight;
    };
    const pageVisible = visible('.page-settings');
    document.querySelector('.mode-card[data-theme-id="daylight"]').click();
    document.querySelector('#accent-row [data-accent-id="violet"]').click();
    document.querySelector('#density-seg button[data-value="compact"]').click();
    const debug = document.getElementById('set-debug-header');
    debug.checked = false;
    debug.dispatchEvent(new Event('change', { bubbles: true }));
    const motion = document.getElementById('set-reduce-motion');
    motion.checked = true;
    motion.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      pageVisible, controlsVisible: visible('#mode-grid') && visible('#accent-row'),
      theme: document.documentElement.dataset.theme,
      accent: document.documentElement.dataset.accent,
      density: document.documentElement.dataset.density,
      motion: document.documentElement.dataset.motion,
      debugHidden: document.getElementById('btn-header-debug').hidden,
      activeAccent: document.querySelector('#accent-row .accent-active-swatch').dataset.accentId,
      swatchCount: document.querySelectorAll('#accent-row [data-accent-id]').length,
    };
  })()`);
  check('appearance page and controls are visibly inside viewport', appearance.pageVisible && appearance.controlsVisible);
  check('theme, accent and density clicks update the real UI', appearance.theme === 'daylight' && appearance.accent === 'violet' && appearance.density === 'compact', JSON.stringify(appearance));
  check('motion and diagnostic settings update the real DOM', appearance.motion === 'reduced' && appearance.debugHidden);
  check('accent swapping keeps four alternatives and one active swatch', appearance.activeAccent === 'violet' && appearance.swatchCount === 5);

  const popup = await app.evaluate(`(() => {
    document.getElementById('btn-accent').click();
    const pop = document.getElementById('accent-pop');
    const r = pop.getBoundingClientRect();
    const visible = !pop.hidden && r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0;
    const active = pop.querySelector('.accent-row-item.active')?.dataset.accentId;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return { visible, active, closed: pop.hidden, focusRestored: document.activeElement.id === 'btn-accent' };
  })()`);
  check('accent popup opens visibly, then Escape closes it and restores focus', popup.visible && popup.active === 'violet' && popup.closed && popup.focusRestored, JSON.stringify(popup));

  const reset = await app.evaluate(`(() => {
    document.getElementById('btn-reset-appearance').click();
    return { ...document.documentElement.dataset, debugHidden: document.getElementById('btn-header-debug').hidden };
  })()`);
  check('appearance reset restores shipped theme/accent/density/motion', reset.theme === 'vercel' && reset.accent === 'emerald' && reset.density === 'normal' && reset.motion === 'normal' && !reset.debugHidden, JSON.stringify(reset));

  const replaced = await app.evaluate(`(() => {
    // The actual Data reset replaces settings rather than mutating it.
    SECTION_RESETTERS['sec-data']();
    document.querySelector('.mode-card[data-theme-id="daylight"]').click();
    document.querySelector('#accent-row [data-accent-id="cyan"]').click();
    document.querySelector('#density-seg button[data-value="roomy"]').click();
    return { theme: settings.theme, accent: settings.accent, density: settings.density,
      paintedAccent: document.documentElement.dataset.accent };
  })()`);
  check('appearance observes a settings object replaced by Data reset', replaced.theme === 'daylight' && replaced.accent === 'cyan' && replaced.density === 'roomy' && replaced.paintedAccent === 'cyan', JSON.stringify(replaced));

  const notes = await app.evaluate(`(() => {
    window.__notesRan = false;
    updates.showUpdateModal({ version: 'fixture-only', releaseNotes: '<h2>Release</h2><ul><li><strong>Safe</strong> <code>code</code><script>window.__notesRan=true</script></li></ul>' });
    const panel = document.querySelector('#update-modal .modal');
    const r = panel.getBoundingClientRect();
    const visible = r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
    const safe = !window.__notesRan && !document.querySelector('#update-modal-notes script');
    const formatted = !!document.querySelector('#update-modal-notes strong') && !!document.querySelector('#update-modal-notes code');
    document.getElementById('update-modal-later-btn').click();
    return { visible, safe, formatted, closed: document.getElementById('update-modal').style.display === 'none' };
  })()`);
  check('release-note modal is visible and HTML notes remain inert', notes.visible && notes.safe && notes.formatted && notes.closed, JSON.stringify(notes));

  const navigation = await app.evaluate(`(() => {
    return ['overview', 'providers', 'catalog', 'profile', 'history', 'monitor', 'router', 'database', 'activity', 'settings'].map(page => {
      document.querySelector('.shell-nav-item[data-page="' + page + '"]').click();
      const el = document.querySelector('.shell-page[data-page="' + page + '"]');
      const r = el.getBoundingClientRect();
      return { page, visible: !el.hidden && r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.left < innerWidth && r.top < innerHeight };
    });
  })()`);
  check('existing shell navigation continues to show each page', navigation.every(n => n.visible), navigation.filter(n => !n.visible).map(n => n.page).join(', '));

  const routerPage = await app.evaluate(`(async () => {
    document.querySelector('.shell-nav-item[data-page="router"]').click();
    await window.ROUTER.refresh();
    const el = document.querySelector('.shell-page[data-page="router"]');
    const r = el.getBoundingClientRect();
    const body = document.getElementById('rt-body');
    const bodyRect = body.getBoundingClientRect();
    return { visible: !el.hidden && r.width > 0 && r.height > 0,
      bodyVisible: bodyRect.width > 0 && bodyRect.height > 0 && bodyRect.top < innerHeight && bodyRect.bottom > 0,
      text: body.textContent.slice(0, 2500) };
  })()`);
  check('router status page shows tiers, gateway and pool from live main', routerPage.visible && routerPage.bodyVisible
    && routerPage.text.includes('LITE POLICY') && routerPage.text.includes('MAX POLICY')
    && routerPage.text.includes('FLEET TARGETS') && routerPage.text.includes('Venom Lite')
    && routerPage.text.includes('ELIGIBLE TARGETS')
    && /127\.0\.0\.1:28228|Inactive/.test(routerPage.text), JSON.stringify(routerPage));

  const saved = await app.evaluate(`(async () => {
    await flushPendingSaves();
    const saved = (await window.electronAPI.readConfig()).settings;
    return { theme: saved.theme, accent: saved.accent, density: saved.density };
  })()`);
  check('changed appearance persists through the app save path', saved.theme === 'daylight' && saved.accent === 'cyan' && saved.density === 'roomy', JSON.stringify(saved));
  if (process.env.VENOM_VERIFY_SHOT_DIR) {
    mkdirSync(process.env.VENOM_VERIFY_SHOT_DIR, { recursive: true });
    const shot = await app.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.env.VENOM_VERIFY_SHOT_DIR, 'appearance-light.png'), Buffer.from(shot.result.data, 'base64'));
  }
  await app.close();
  app = null;
  app = await launch({ userDataDir: dir, port: 9379 });
  await app.unlockAndWait();
  await app.waitFor('window.CATALOG && CATALOG.state.loaded && settings.accent === "cyan"', 30000);
  const restarted = await app.evaluate(`({ theme: settings.theme, accent: settings.accent, density: settings.density, paintedAccent: document.documentElement.dataset.accent })`);
  check('appearance and live getters survive close/reopen', restarted.theme === 'daylight' && restarted.accent === 'cyan' && restarted.density === 'roomy' && restarted.paintedAccent === 'cyan', JSON.stringify(restarted));
} catch (err) {
  const runtime = app ? await app.evaluate(`({ providerCount: typeof PROVIDERS === 'object' ? Object.keys(PROVIDERS).length : null,
    currentPage: typeof getCurrentPage === 'function' ? getCurrentPage() : null,
    readError: typeof storeReadError === 'string' ? storeReadError : null,
    catalog: window.CATALOG ? { loaded: CATALOG.state.loaded, syncing: CATALOG.state.syncing, lastSyncAt: CATALOG.state.lastSyncAt } : null,
    rendererErrors: window.__rendererErrors || [] })`).catch(() => null) : null;
  check('renderer module acceptance completed', false, `${err.stack || err.message}\nRuntime: ${JSON.stringify(runtime)}\n${app ? app.output() : ''}`);
} finally {
  if (app) await app.close().catch(() => {});
  if (mock) await mock.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failures ? `${failures} RENDERER CHECK(S) FAILED` : 'ALL RENDERER MODULE CHECKS PASSED');
process.exitCode = failures ? 1 : 0;
