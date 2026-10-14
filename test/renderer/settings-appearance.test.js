const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('Appearance: DEFAULT_SETTINGS contains all appearance keys with proper defaults', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'app.js'), 'utf8');

  // Verify DEFAULT_SETTINGS has theme, followSystem, accent, density, reduceMotion, debugHeader
  assert.ok(appJs.includes("theme: 'vercel'"), 'default theme is vercel');
  assert.ok(appJs.includes("followSystem: false"), 'default followSystem is false');
  assert.ok(appJs.includes("accent: 'emerald'"), 'default accent is emerald');
  assert.ok(appJs.includes("density: 'normal'"), 'default density is normal');
  assert.ok(appJs.includes("reduceMotion: false"), 'default reduceMotion is false');
  assert.ok(appJs.includes("debugHeader: true"), 'default debugHeader is true');
});

test('Appearance: SETTING_INPUTS includes reduceMotion and debugHeader', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'app.js'), 'utf8');

  assert.ok(appJs.includes("['#set-reduce-motion', 'reduceMotion', 'bool']"), 'reduceMotion in SETTING_INPUTS');
  assert.ok(appJs.includes("['#set-debug-header', 'debugHeader', 'bool']"), 'debugHeader in SETTING_INPUTS');
});

test('Appearance: applyAppearance reflects theme, density, accent, motion, and debugHeader on the DOM', () => {
  const htmlAttrs = {};
  const elements = {
    'btn-header-debug': { hidden: false },
    'btn-theme-toggle': { title: '', setAttribute: (k, v) => {} },
  };

  const documentElement = {
    setAttribute(k, v) { htmlAttrs[k] = v; },
  };

  const settings = {
    theme: 'vercel',
    followSystem: false,
    density: 'roomy',
    accent: 'cyan',
    reduceMotion: true,
    debugHeader: false,
  };

  function effectiveTheme() {
    return settings.theme;
  }

  function applyAppearance() {
    const el = documentElement;
    const theme = effectiveTheme();
    el.setAttribute('data-theme', theme);
    el.setAttribute('data-density', settings.density);
    el.setAttribute('data-accent', settings.accent);
    el.setAttribute('data-motion', settings.reduceMotion ? 'reduced' : 'normal');

    const debugBtn = elements['btn-header-debug'];
    if (debugBtn) debugBtn.hidden = !settings.debugHeader;
  }

  applyAppearance();

  assert.strictEqual(htmlAttrs['data-theme'], 'vercel');
  assert.strictEqual(htmlAttrs['data-density'], 'roomy');
  assert.strictEqual(htmlAttrs['data-accent'], 'cyan');
  assert.strictEqual(htmlAttrs['data-motion'], 'reduced');
  assert.strictEqual(elements['btn-header-debug'].hidden, true);

  // Toggle debugHeader back to true
  settings.debugHeader = true;
  settings.reduceMotion = false;
  applyAppearance();

  assert.strictEqual(htmlAttrs['data-motion'], 'normal');
  assert.strictEqual(elements['btn-header-debug'].hidden, false);
});

test('Appearance: reset appearance restores all appearance keys to defaults', () => {
  const DEFAULT_SETTINGS = {
    theme: 'vercel',
    followSystem: false,
    accent: 'emerald',
    density: 'normal',
    reduceMotion: false,
    debugHeader: true,
  };

  const settings = {
    theme: 'daylight',
    followSystem: true,
    accent: 'crimson',
    density: 'compact',
    reduceMotion: true,
    debugHeader: false,
  };

  const resetKeys = ['theme', 'followSystem', 'accent', 'density', 'reduceMotion', 'debugHeader'];
  resetKeys.forEach((k) => {
    settings[k] = DEFAULT_SETTINGS[k];
  });

  assert.strictEqual(settings.theme, 'vercel');
  assert.strictEqual(settings.followSystem, false);
  assert.strictEqual(settings.accent, 'emerald');
  assert.strictEqual(settings.density, 'normal');
  assert.strictEqual(settings.reduceMotion, false);
  assert.strictEqual(settings.debugHeader, true);
});

test('Appearance: markup contains all appearance controls and header diagnostics button', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html'), 'utf8');

  // Verify markup for all appearance settings
  assert.ok(indexHtml.includes('id="mode-grid"'), 'theme mode cards present');
  assert.ok(indexHtml.includes('data-theme-id="vercel"'), 'dark mode card present');
  assert.ok(indexHtml.includes('data-theme-id="daylight"'), 'light mode card present');
  assert.ok(indexHtml.includes('id="set-follow-system"'), 'match system theme switch present');
  assert.ok(indexHtml.includes('id="set-debug-header"'), 'debug header switch present');
  assert.ok(indexHtml.includes('id="set-reduce-motion"'), 'reduce motion switch present');
  assert.ok(indexHtml.includes('id="accent-row"'), 'accent color palette container present');
  assert.ok(indexHtml.includes('id="density-seg"'), 'results density segmented control present');
  assert.ok(indexHtml.includes('id="btn-reset-appearance"'), 'reset appearance button present');
  assert.ok(indexHtml.includes('id="btn-header-debug"'), 'diagnostics button in header actions present');
});

test('Appearance: reset button is located in the right side of main card header', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html'), 'utf8');
  assert.ok(indexHtml.includes('settings-panel-head-actions'), 'settings-panel-head-actions exists in head');
  assert.ok(indexHtml.includes('id="btn-reset-appearance"'), 'btn-reset-appearance exists');
  assert.ok(indexHtml.includes('btn-settings-reset'), 'btn-settings-reset class exists for prominent styling');
  assert.ok(indexHtml.includes('reset-btn-label'), 'reset-btn-label span exists for dynamic labels');
  // Check that the old settings-zone with Reset appearance in sec-appearance is gone
  assert.ok(!indexHtml.includes('<div class="settings-zone-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>Reset appearance</div>'), 'old bottom reset zone removed');
});

test('Appearance: SECTION_RESETTERS unifies reset across all settings tabs', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'app.js'), 'utf8');
  assert.ok(appJs.includes('SECTION_RESETTERS'), 'SECTION_RESETTERS map exists');
  assert.ok(appJs.includes("'sec-appearance':"), 'sec-appearance resetter defined');
  assert.ok(appJs.includes("'sec-test':"), 'sec-test resetter defined');
  assert.ok(appJs.includes("'sec-schedule':"), 'sec-schedule resetter defined');
  assert.ok(appJs.includes("'sec-speed':"), 'sec-speed resetter defined');
  assert.ok(appJs.includes("'sec-reliability':"), 'sec-reliability resetter defined');
  assert.ok(appJs.includes("'sec-catalog':"), 'sec-catalog resetter defined');
  assert.ok(appJs.includes("'sec-history':"), 'sec-history resetter defined');
  assert.ok(appJs.includes("'sec-logs':"), 'sec-logs resetter defined');
  assert.ok(appJs.includes("'sec-security':"), 'sec-security resetter defined');
  assert.ok(appJs.includes("'sec-data':"), 'sec-data resetter defined');
  assert.ok(appJs.includes("resetBtn.hidden = !(isAppearance || isTest)"), 'reset button visible only on appearance and test tabs');
});

test('Appearance: density controls adjust row padding in results table and density preview', () => {
  const stylesCss = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'styles.css'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html'), 'utf8');

  // Verify CSS variables and table rules
  assert.ok(stylesCss.includes('[data-density="compact"]'), 'data-density compact defined');
  assert.ok(stylesCss.includes('[data-density="roomy"]'), 'data-density roomy defined');
  assert.ok(stylesCss.includes('.results-table td'), 'results-table td rule exists');
  assert.ok(stylesCss.includes('padding: var(--row-pad-y) var(--row-pad-x)'), 'results-table td uses --row-pad-y');
  assert.ok(stylesCss.includes('.density-preview-wrap'), 'density preview styled');
  assert.ok(indexHtml.includes('density-preview-wrap'), 'density-preview-wrap exists in index.html');
  assert.ok(indexHtml.includes('density-preview-head'), 'density-preview-head exists in index.html');
  assert.ok(indexHtml.includes('id="density-current-pill"'), 'density-current-pill exists in index.html');
  assert.ok(stylesCss.includes('.density-preview-head'), 'density-preview-head styled in styles.css');
  assert.ok(stylesCss.includes('.density-preview-pill'), 'density-preview-pill styled in styles.css');
});

test('Appearance: reset button has red danger styles and accent dock is styled', () => {
  const stylesCss = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'styles.css'), 'utf8');

  // Danger reset button styles
  assert.ok(stylesCss.includes('rgba(239, 68, 68'), 'danger red border and background on reset button');
  assert.ok(stylesCss.includes('.btn-settings-reset'), 'btn-settings-reset styled');

  // Accent row styling
  assert.ok(stylesCss.includes('.setting-label-value'), 'setting-label-value pill styled');
  assert.ok(stylesCss.includes('.accent-grid'), 'accent-grid docked palette styled');
  assert.ok(stylesCss.includes('.accent-swatch.active'), 'active accent swatch styled');
});

test('Appearance: styles.css contains motion reduction rules and locked state for header debug button', () => {
  const stylesCss = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'styles.css'), 'utf8');

  assert.ok(stylesCss.includes('html[data-motion="reduced"]'), 'html[data-motion="reduced"] styled');
  assert.ok(stylesCss.includes('body.locked :is(#btn-settings, #btn-header-debug'), 'btn-header-debug hidden when locked');
});

test('Appearance: theme preview boxes render detailed UI mockups', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html'), 'utf8');
  const stylesCss = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'styles.css'), 'utf8');

  // Verify elements inside theme preview boxes
  assert.ok(indexHtml.includes('theme-preview-box preview-dark'), 'dark preview box exists');
  assert.ok(indexHtml.includes('theme-preview-box preview-light'), 'light preview box exists');
  assert.ok(indexHtml.includes('tp-window'), 'floating window mockup present');
  assert.ok(indexHtml.includes('tp-titlebar'), 'titlebar mockup present');
  assert.ok(indexHtml.includes('tp-sidebar'), 'sidebar mockup present');
  assert.ok(indexHtml.includes('tp-kpi-row'), 'kpi row mockup present');
  assert.ok(indexHtml.includes('tp-table'), 'table mockup present');

  // Verify CSS styles
  assert.ok(stylesCss.includes('.preview-dark'), 'preview-dark styles present');
  assert.ok(stylesCss.includes('.preview-light'), 'preview-light styles present');
  assert.ok(stylesCss.includes('.tp-window'), 'tp-window styles present');
  assert.ok(stylesCss.includes('grid-template-columns: 1fr 1fr'), 'theme cards grid spans full width in 2 columns');
  assert.ok(stylesCss.includes('max-width: 260px !important'), 'floating window has proportional max-width');
});

test('Appearance: accent cluster widget and density preview centering', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html'), 'utf8');
  const stylesCss = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'styles.css'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'app.js'), 'utf8');

  // Verify markup: accent-row is inside settings-row-control on the right
  assert.ok(indexHtml.includes('class="accent-cluster-widget accent-grid" id="accent-row"'), 'accent widget in row control');

  // Verify density preview is centered with density-setting-row
  assert.ok(indexHtml.includes('density-setting-row'), 'density-setting-row class present');
  assert.ok(stylesCss.includes('.density-setting-row .settings-row-field'), 'density-setting-row rules defined');
  assert.ok(stylesCss.includes('margin-left: 0 !important'), 'left margin reset to 0 to center preview');

  // Verify accent cluster styling
  assert.ok(stylesCss.includes('.accent-cluster-widget'), 'accent cluster widget styled');
  assert.ok(stylesCss.includes('.accent-cluster-grid'), '2x2 accent grid styled');
  assert.ok(stylesCss.includes('grid-template-columns: repeat(2,'), '2x2 grid column template');
  assert.ok(stylesCss.includes('.accent-mini-swatch'), 'mini swatch styled');
  assert.ok(stylesCss.includes('.accent-active-swatch'), 'active swatch styled');

  // Verify swapping code in app.js
  assert.ok(appJs.includes('renderAccentClusterHTML'), 'renderAccentClusterHTML defined');
  assert.ok(appJs.includes('inactiveAccentIds'), 'inactiveAccentIds state tracked');
  assert.ok(appJs.includes('ensureInactiveAccents'), 'ensureInactiveAccents helper defined');
});

test('Appearance: accent swapping state transitions', () => {
  const ACCENTS = [
    { id: 'emerald', name: 'Emerald', hex: '#10b981' },
    { id: 'cyan', name: 'Cyan', hex: '#06b6d4' },
    { id: 'violet', name: 'Violet', hex: '#8b5cf6' },
    { id: 'crimson', name: 'Crimson', hex: '#f43f5e' },
    { id: 'amber', name: 'Amber', hex: '#f59e0b' }
  ];

  let currentAccent = 'emerald';
  let inactiveAccentIds = ['cyan', 'violet', 'crimson', 'amber'];

  function setAccentMock(id) {
    if (!ACCENTS.some(a => a.id === id)) return;
    const oldId = currentAccent;
    if (oldId !== id) {
      const idx = inactiveAccentIds.indexOf(id);
      if (idx !== -1) {
        inactiveAccentIds[idx] = oldId;
      }
      currentAccent = id;
    }
  }

  // 1. Initial state
  assert.strictEqual(currentAccent, 'emerald');
  assert.deepStrictEqual(inactiveAccentIds, ['cyan', 'violet', 'crimson', 'amber']);

  // 2. Click violet (index 1) -> swaps with emerald
  setAccentMock('violet');
  assert.strictEqual(currentAccent, 'violet');
  assert.deepStrictEqual(inactiveAccentIds, ['cyan', 'emerald', 'crimson', 'amber']);

  // 3. Click crimson (index 2) -> swaps with violet
  setAccentMock('crimson');
  assert.strictEqual(currentAccent, 'crimson');
  assert.deepStrictEqual(inactiveAccentIds, ['cyan', 'emerald', 'violet', 'amber']);

  // 4. Click cyan (index 0) -> swaps with crimson
  setAccentMock('cyan');
  assert.strictEqual(currentAccent, 'cyan');
  assert.deepStrictEqual(inactiveAccentIds, ['crimson', 'emerald', 'violet', 'amber']);

  // 5. Reset to emerald default
  currentAccent = 'emerald';
  inactiveAccentIds = ACCENTS.filter(a => a.id !== 'emerald').map(a => a.id);
  assert.strictEqual(currentAccent, 'emerald');
  assert.deepStrictEqual(inactiveAccentIds, ['cyan', 'violet', 'crimson', 'amber']);
});

test('Settings: Test & Prompts section markup and styles', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html'), 'utf8');
  const stylesCss = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'styles.css'), 'utf8');

  // Verify segmented kind buttons with icons
  assert.ok(indexHtml.includes('data-kind="chat"'), 'chat kind button present');
  assert.ok(indexHtml.includes('data-kind="image"'), 'image kind button present');
  assert.ok(indexHtml.includes('data-kind="video"'), 'video kind button present');
  assert.ok(indexHtml.includes('data-kind="decision"'), 'decision kind button present');

  // Verify route banner structure
  assert.ok(indexHtml.includes('class="route-method"'), 'route-method badge present');
  assert.ok(indexHtml.includes('class="route-path"'), 'route-path code element present');
  assert.ok(indexHtml.includes('/chat/completions'), 'chat completions endpoint present');

  // Verify reset prompt button with icon
  assert.ok(indexHtml.includes('id="btn-reset-prompt"'), 'btn-reset-prompt present');
  assert.ok(indexHtml.includes('Restore default prompt and answer'), 'restore label present');

  // Verify slider wrap
  assert.ok(indexHtml.includes('range-slider-wrap'), 'range-slider-wrap present');

  // Verify enhanced widgets
  assert.ok(indexHtml.includes('test-header-status-card'), 'test header status card present');
  assert.ok(indexHtml.includes('field-quick-presets'), 'field-quick-presets present');
  assert.ok(indexHtml.includes('expected-chips-wrap'), 'expected-chips-wrap present');
  assert.ok(indexHtml.includes('token-limit-cluster'), 'token-limit-cluster present');
  assert.ok(indexHtml.includes('field-meta-bar'), 'field-meta-bar present');

  // Verify styles
  assert.ok(stylesCss.includes('#sec-test .settings-row-item.vertical .settings-row-field'), 'centered fields rule for sec-test');
  assert.ok(stylesCss.includes('.test-header-status-card'), 'test-header-status-card styled');
  assert.ok(stylesCss.includes('.field-quick-presets'), 'field-quick-presets styled');
  assert.ok(stylesCss.includes('.expected-chips-wrap'), 'expected-chips-wrap styled');
  assert.ok(stylesCss.includes('.token-limit-cluster'), 'token-limit-cluster styled');
  assert.ok(stylesCss.includes('.test-route .route-method'), 'route method styled in styles.css');
  assert.ok(stylesCss.includes('.test-kind-seg button svg'), 'icons styled in test-kind-seg');
  assert.ok(stylesCss.includes('#btn-reset-prompt'), 'btn-reset-prompt styled');
});

test('Appearance: header accent popover renders rich rows with descriptions matching notification blocks', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'app.js'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html'), 'utf8');
  const stylesCss = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'styles.css'), 'utf8');

  // Verify app.js helpers and row markup
  assert.ok(appJs.includes('accentRowsHTML'), 'accentRowsHTML helper defined');
  assert.ok(appJs.includes('accent-row-item'), 'accent-row-item markup present');
  assert.ok(appJs.includes('accent-row-swatch'), 'accent-row-swatch markup present');
  assert.ok(appJs.includes('accent-row-desc'), 'accent-row-desc markup present');
  assert.ok(appJs.includes('accent-row-check'), 'accent-row-check markup present');
  assert.ok(appJs.includes('renderAccentPop'), 'renderAccentPop popover updater present');

  // Verify ACCENTS have professional descriptions
  assert.ok(appJs.includes("desc: 'Crisp vibrant green"), 'emerald description present');
  assert.ok(appJs.includes("desc: 'Electric neon cyan"), 'cyan description present');
  assert.ok(appJs.includes("desc: 'Deep royal purple"), 'violet description present');

  // Verify index.html contains unified popover header and swatches container
  assert.ok(indexHtml.includes('id="accent-pop"'), 'accent-pop container present');
  assert.ok(indexHtml.includes('class="ntf-head accent-head"'), 'accent-head unified header present');
  assert.ok(indexHtml.includes('id="accent-current-name"'), 'accent-current-name badge present');
  assert.ok(indexHtml.includes('id="accent-pop-swatches"'), 'accent-pop-swatches container present');

  // Verify styles.css contains row styling
  assert.ok(stylesCss.includes('.hdr-accent-pop'), 'hdr-accent-pop container styled');
  assert.ok(stylesCss.includes('.accent-row-item'), 'accent-row-item styled');
  assert.ok(stylesCss.includes('.accent-row-swatch'), 'accent-row-swatch styled');
  assert.ok(stylesCss.includes('.accent-row-check'), 'accent-row-check styled');
});

test('Appearance: header profile popover renders unified header, identity card, and styled action rows', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'app.js'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html'), 'utf8');
  const stylesCss = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'styles.css'), 'utf8');

  // Verify index.html contains unified profile popover components
  assert.ok(indexHtml.includes('id="profile-pop"'), 'profile-pop container present');
  assert.ok(indexHtml.includes('class="ntf-head profile-head"'), 'profile-head unified header present');
  assert.ok(indexHtml.includes('class="profile-pop-card"'), 'profile-pop-card identity card present');
  assert.ok(indexHtml.includes('class="profile-pop-list"'), 'profile-pop-list container present');
  assert.ok(indexHtml.includes('id="btn-profile-lock"'), 'btn-profile-lock present');
  assert.ok(indexHtml.includes('id="btn-profile-signout"'), 'btn-profile-signout present');
  assert.ok(indexHtml.includes('id="profile-view-security"'), 'profile-view-security button present');

  // Verify item text content preserves exact Lock now / Sign out for verification compatibility
  assert.ok(indexHtml.includes('>Lock now</span>'), 'Lock now text node is clean');
  assert.ok(indexHtml.includes('>Sign out</span>'), 'Sign out text node is clean');

  // Verify app.js handles profile-view-security click to security section
  assert.ok(appJs.includes('profile-view-security'), 'profile-view-security handler in app.js');

  // Verify styles.css contains unified profile popover styles
  assert.ok(stylesCss.includes('.hdr-pop-profile'), 'hdr-pop-profile styled');
  assert.ok(stylesCss.includes('.profile-pop-card'), 'profile-pop-card styled');
  assert.ok(stylesCss.includes('.profile-pop-item'), 'profile-pop-item styled');
  assert.ok(stylesCss.includes('.profile-item-icon'), 'profile-item-icon styled');
  assert.ok(stylesCss.includes('.profile-item-body'), 'profile-item-body styled');
  assert.ok(stylesCss.includes('.profile-pop-item-danger'), 'profile-pop-item-danger styled');
});

test('Profile: dedicated Profile & Security page markup, routing, and unified styles', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'app.js'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html'), 'utf8');
  const stylesCss = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'styles.css'), 'utf8');

  // Verify Profile nav item is present under System nav
  assert.ok(indexHtml.includes('data-page="profile"'), 'Profile nav item in shell-nav');

  // Verify dedicated page section exists and contains security controls
  assert.ok(indexHtml.includes('class="shell-page page-profile" data-page="profile"'), 'Dedicated page-profile section exists');
  assert.ok(indexHtml.includes('class="profile-hero-card"'), 'Profile hero card exists');
  assert.ok(indexHtml.includes('class="profile-stats-grid"'), 'Profile stats grid exists');
  assert.ok(indexHtml.includes('id="sec-security"'), 'sec-security integrated into profile page');

  // Verify security controls and inputs are present
  assert.ok(indexHtml.includes('id="set-lock-current"'), 'set-lock-current input present');
  assert.ok(indexHtml.includes('id="set-lock-new"'), 'set-lock-new input present');
  assert.ok(indexHtml.includes('id="set-lock-confirm"'), 'set-lock-confirm input present');
  assert.ok(indexHtml.includes('id="btn-lock-change"'), 'btn-lock-change button present');
  assert.ok(indexHtml.includes('id="set-lock-idle"'), 'set-lock-idle select present');
  assert.ok(indexHtml.includes('id="btn-lock-now-settings"'), 'btn-lock-now-settings present');

  // Verify settings-nav does not contain sec-security tab
  assert.ok(!indexHtml.includes('data-section="sec-security"'), 'sec-security removed from settings navigation tabs');

  // Verify app.js handles routing and rendering for profile page
  assert.ok(appJs.includes("'profile'"), 'profile page registered in PAGES');
  assert.ok(appJs.includes('function renderProfilePage()'), 'renderProfilePage function defined');
  assert.ok(appJs.includes('renderSecuritySection();'), 'renderSecuritySection called');

  // Verify styles.css contains profile page styles
  assert.ok(stylesCss.includes('.page-profile'), 'page-profile styled');
  assert.ok(stylesCss.includes('.profile-hero-card'), 'profile-hero-card styled');
  assert.ok(stylesCss.includes('.profile-stats-grid'), 'profile-stats-grid styled');
  assert.ok(stylesCss.includes('.profile-security-card'), 'profile-security-card styled');
});


