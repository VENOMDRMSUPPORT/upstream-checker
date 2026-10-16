// Appearance factory behavior with a small DOM boundary; production functions are not copied.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAppearanceFixture: setup } = require('./appearance-dom');

test('appearance applies theme/accent/density/motion and diagnostic visibility from replacement settings', () => {
  const { appearance, state, attributes, nodes } = setup();
  state.settings = { ...state.settings, theme: 'daylight', accent: 'cyan', density: 'roomy', reduceMotion: true, debugHeader: false };
  appearance.applyAppearance();
  assert.deepEqual(attributes, { 'data-theme': 'daylight', 'data-accent': 'cyan', 'data-density': 'roomy', 'data-motion': 'reduced' });
  assert.equal(nodes.get('btn-header-debug').hidden, true);
  assert.equal(nodes.get('btn-theme-toggle')['aria-label'], 'Switch to dark mode');
  state.settings.debugHeader = true;
  appearance.applyAppearance();
  assert.equal(nodes.get('btn-header-debug').hidden, false);
});

test('header toggle exits system following and persists the resulting visible theme', () => {
  const { appearance, state, attributes } = setup();
  state.settings.followSystem = true;
  state.settings.theme = 'vercel';
  appearance.toggleTheme();
  assert.equal(state.settings.theme, 'vercel');
  assert.equal(state.settings.followSystem, false);
  assert.equal(attributes['data-theme'], 'vercel');
  assert.equal(state.saves, 1);
});

test('system theme changes only apply while following the system', () => {
  const { appearance, state, attributes, listeners } = setup();
  state.settings.followSystem = false;
  listeners.change();
  assert.deepEqual(attributes, {});
  state.settings.followSystem = true;
  listeners.change();
  assert.equal(attributes['data-theme'], 'daylight');
  assert.equal(appearance.effectiveTheme(), 'daylight');
});

test('unknown accents are refused without changing or saving appearance', () => {
  const { appearance, state } = setup();
  appearance.setAccent('unknown');
  assert.equal(state.settings.accent, 'emerald');
  assert.equal(state.saves, 0);
});

test('appearance defaults contain the shipped settings with the expected value types', () => {
  const { defaults } = setup();
  assert.equal(defaults.theme, 'vercel');
  assert.equal(defaults.followSystem, false);
  assert.equal(defaults.accent, 'emerald');
  assert.equal(defaults.density, 'normal');
  assert.equal(defaults.reduceMotion, false);
  assert.equal(defaults.debugHeader, true);
});
