// Loads complete browser modules in a controlled VM; no source slicing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadRendererModules(names, globals = {}) {
  const context = vm.createContext({
    window: {}, Date, setTimeout, clearTimeout, console, ...globals,
  });
  for (const name of names) {
    const file = path.join(__dirname, '../../src/renderer', `${name}.js`);
    assert.ok(fs.existsSync(file), `Production renderer module is missing: ${name}`);
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  return context.window.VENOM_RENDERER;
}

module.exports = { loadRendererModules };
