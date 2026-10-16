// Minimal DOM boundary for production appearance controls; live gates prove geometry.
const { loadRendererModules } = require('./module-loader');

function createAppearanceFixture() {
  const attributes = {};
  const listeners = {};
  const nodes = new Map();
  const classes = () => {
    const values = new Set();
    return { add: v => values.add(v), remove: v => values.delete(v), contains: v => values.has(v), toggle: (v, on) => { if (on) values.add(v); else values.delete(v); } };
  };
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, {
      hidden: id.endsWith('pop'), title: '', innerHTML: '', textContent: '', classList: classes(),
      setAttribute(k, v) { this[k] = v; }, addEventListener() {}, focus() {},
    });
    return nodes.get(id);
  };
  const document = {
    documentElement: { setAttribute: (k, v) => { attributes[k] = v; } },
    getElementById: get, querySelector: s => get(s.match(/^#([\w-]+)/)?.[1] || s),
    querySelectorAll: () => [], addEventListener() {},
  };
  const media = { matches: false, addEventListener: (type, fn) => { listeners[type] = fn; } };
  const window = { matchMedia: () => media };
  const modules = loadRendererModules(['settings-defaults', 'appearance'], { window, document });
  const state = { settings: { ...modules.defaults.DEFAULT_SETTINGS }, page: 'providers', saves: 0 };
  const appearance = modules.appearance.create({
    defaults: modules.defaults, getSettings: () => state.settings, getCurrentPage: () => state.page,
    queueSettingsSave: () => { state.saves++; }, hasResultRows: () => false,
    renderResultsTable: () => {}, escapeHtml: String, showPage: () => {}, switchSettingsSection: () => {},
  });
  // The header and diagnostics exist before first applyAppearance.
  get('btn-header-debug'); get('btn-theme-toggle');
  return { appearance, state, attributes, nodes, listeners, media, defaults: modules.defaults.DEFAULT_SETTINGS };
}

module.exports = { createAppearanceFixture };
