// Sidebar decoration behavior through the complete production effects script.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererModules } = require('./module-loader');

function setup(reduced = false) {
  const node = () => ({ children: [], style: {}, handlers: {}, attributes: {},
    classList: { values: new Set(), add(v) { this.values.add(v); }, remove(v) { this.values.delete(v); } },
    appendChild(n) { this.children.push(n); }, prepend(n) { this.children.unshift(n); },
    setAttribute(k, v) { this.attributes[k] = v; },
    addEventListener(type, fn) { this.handlers[type] = fn; },
    querySelector(cls) { return this.children.find(n => '.' + n.className === cls); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 20, height: 20 }; },
  });
  const nav = node(); const heart = node(); const body = node();
  const document = { querySelector: s => s === '.shell-nav' ? nav : heart, createElement: node, body };
  const window = { matchMedia: () => ({ matches: reduced }) };
  const effects = loadRendererModules(['sidebar-effects'], { window, document }).effects;
  return { effects, nav, heart, body };
}

test('sidebar stars use a deterministic sky and mounting twice does not duplicate it', () => {
  const one = setup(); const two = setup();
  one.effects.mountSidebarStars(); one.effects.mountSidebarStars(); two.effects.mountSidebarStars();
  assert.equal(one.nav.children.length, 1);
  assert.equal(one.nav.children[0].children.length, 17);
  assert.equal(one.nav.children[0].attributes['aria-hidden'], 'true');
  assert.equal(one.nav.children[0].children[0].style.cssText, two.nav.children[0].children[0].style.cssText);
});

test('signature heart remains keyboard-operable without particles under reduced motion', () => {
  const { effects, heart, body } = setup(true);
  effects.bindSignatureHeart();
  assert.equal(heart.attributes.role, 'button');
  let prevented = false;
  heart.handlers.keydown({ key: 'Enter', preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.ok(heart.classList.values.has('pop'));
  assert.equal(body.children.length, 0);
});
