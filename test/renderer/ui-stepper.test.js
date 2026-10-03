const test = require('node:test');
const assert = require('node:assert');
const { enhance, stepUnit, stopRepeat, CHEVRON_UP, CHEVRON_DOWN } = require('../../src/renderer/ui-stepper.js');

// Mock DOM elements for testing the unit stepper in Node
function createMockUnit({ value = '75', min = '5', max = '100', step = '5', disabled = false, readOnly = false, hasLabel = true } = {}) {
  const events = [];
  const input = {
    tagName: 'INPUT',
    type: 'number',
    value: String(value),
    min: String(min),
    max: String(max),
    step: String(step),
    disabled,
    readOnly,
    stepUp() {
      const s = Number(this.step) || 1;
      const v = Number(this.value) + s;
      const m = Number(this.max);
      this.value = String(Number.isFinite(m) ? Math.min(m, v) : v);
    },
    stepDown() {
      const s = Number(this.step) || 1;
      const v = Number(this.value) - s;
      const m = Number(this.min);
      this.value = String(Number.isFinite(m) ? Math.max(m, v) : v);
    },
    dispatchEvent(evt) {
      events.push(evt.type);
    },
  };

  const label = hasLabel ? { tagName: 'SPAN', className: 'input-unit-label', textContent: 's' } : null;
  const children = [input];
  if (label) children.push(label);

  const unit = {
    dataset: {},
    children,
    querySelector(sel) {
      if (sel === 'input[type="number"]') return input;
      if (sel === '.input-unit-label') return label;
      if (sel === '.input-stepper') return children.find(c => c.className === 'input-stepper') || null;
      return null;
    },
    insertBefore(newChild, refChild) {
      const idx = children.indexOf(refChild);
      if (idx !== -1) children.splice(idx, 0, newChild);
      else children.push(newChild);
      newChild.parentElement = this;
    },
    appendChild(child) {
      children.push(child);
      child.parentElement = this;
    },
    closest(sel) {
      if (sel === '.input-unit') return this;
      return null;
    },
  };

  input.closest = (sel) => sel === '.input-unit' ? unit : null;

  return { unit, input, label, events };
}

// In Node global document doesn't exist, so provide minimal mock for enhance()
if (typeof global.document === 'undefined') {
  global.document = {
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(),
        className: '',
        innerHTML: '',
        setAttribute(k, v) { this[k] = v; },
        parentElement: null,
      };
    },
  };
}
if (typeof global.Event === 'undefined') {
  global.Event = function(type) { this.type = type; };
}

test('enhance: mounts .input-stepper before .input-unit-label and sets data-ui-enhanced', () => {
  const { unit, input } = createMockUnit();
  enhance(unit);

  assert.strictEqual(unit.dataset.uiEnhanced, '1');
  const stepper = unit.querySelector('.input-stepper');
  assert.ok(stepper, 'stepper should be created');
  assert.strictEqual(stepper.className, 'input-stepper');
  assert.ok(stepper.innerHTML.includes('stepper-up'));
  assert.ok(stepper.innerHTML.includes('stepper-down'));
  assert.ok(stepper.innerHTML.includes(CHEVRON_UP));
  assert.ok(stepper.innerHTML.includes(CHEVRON_DOWN));

  // Idempotence: calling again changes nothing
  enhance(unit);
  assert.strictEqual(unit.children.filter(c => c.className === 'input-stepper').length, 1);
});

test('enhance: ignores unit if no input[type="number"] exists', () => {
  const emptyUnit = { dataset: {}, querySelector: () => null };
  enhance(emptyUnit);
  assert.strictEqual(emptyUnit.dataset.uiEnhanced, undefined);
});

test('stepUnit: stepper-up increments input by step and dispatches input and change events', () => {
  const { unit, input, events } = createMockUnit({ value: '75', step: '5', min: '5', max: '100' });
  const btnUp = {
    classList: { contains: (cls) => cls === 'stepper-up' },
    closest: (sel) => sel === '.input-unit' ? unit : null,
  };

  stepUnit(btnUp);
  assert.strictEqual(input.value, '80');
  assert.deepStrictEqual(events, ['input', 'change']);
});

test('stepUnit: stepper-down decrements input by step and dispatches input and change events', () => {
  const { unit, input, events } = createMockUnit({ value: '75', step: '5', min: '5', max: '100' });
  const btnDown = {
    classList: { contains: (cls) => cls === 'stepper-down' },
    closest: (sel) => sel === '.input-unit' ? unit : null,
  };

  stepUnit(btnDown);
  assert.strictEqual(input.value, '70');
  assert.deepStrictEqual(events, ['input', 'change']);
});

test('stepUnit: respects disabled and readOnly inputs', () => {
  const { unit: unitDis, input: inputDis, events: eventsDis } = createMockUnit({ value: '75', disabled: true });
  const btnUp = {
    classList: { contains: (cls) => cls === 'stepper-up' },
    closest: (sel) => sel === '.input-unit' ? unitDis : null,
  };

  stepUnit(btnUp);
  assert.strictEqual(inputDis.value, '75', 'disabled input should not step');
  assert.strictEqual(eventsDis.length, 0);

  const { unit: unitRo, input: inputRo, events: eventsRo } = createMockUnit({ value: '75', readOnly: true });
  const btnRo = {
    classList: { contains: (cls) => cls === 'stepper-up' },
    closest: (sel) => sel === '.input-unit' ? unitRo : null,
  };

  stepUnit(btnRo);
  assert.strictEqual(inputRo.value, '75', 'readOnly input should not step');
  assert.strictEqual(eventsRo.length, 0);
});
