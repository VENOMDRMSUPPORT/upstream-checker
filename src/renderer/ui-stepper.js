// ============================================
// Design system — number input stepper
// ============================================
// Every <input type="number"> wrapped in .input-unit is enhanced with the
// design system's own vertical stepper chevrons. The browser's native spin
// buttons are suppressed in CSS because Chromium on Windows renders an ugly
// stark white rectangle with crude black triangles on hover that clashes with
// the application's dark palette. The native <input> element stays in place
// as the single source of truth — reading/writing .value, dispatching input and
// change events, and respecting min, max, and step attributes.
(function () {
  const CHEVRON_UP = '<svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>';
  const CHEVRON_DOWN = '<svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';

  function enhance(unit) {
    if (!unit || unit.dataset.uiEnhanced) return;
    const input = unit.querySelector('input[type="number"]');
    if (!input) return;

    unit.dataset.uiEnhanced = '1';

    const stepper = document.createElement('div');
    stepper.className = 'input-stepper';
    stepper.setAttribute('aria-hidden', 'true');
    stepper.innerHTML = `<button type="button" class="stepper-btn stepper-up" tabindex="-1" aria-label="Increase">${CHEVRON_UP}</button><button type="button" class="stepper-btn stepper-down" tabindex="-1" aria-label="Decrease">${CHEVRON_DOWN}</button>`;

    const label = unit.querySelector('.input-unit-label');
    if (label) {
      unit.insertBefore(stepper, label);
    } else {
      unit.appendChild(stepper);
    }
  }

  function stepUnit(btn) {
    const unit = btn.closest('.input-unit');
    if (!unit) return;
    const input = unit.querySelector('input[type="number"]');
    if (!input || input.disabled || input.readOnly) return;

    if (btn.classList.contains('stepper-up')) {
      input.stepUp();
    } else if (btn.classList.contains('stepper-down')) {
      input.stepDown();
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  let repeatTimer = null;
  let repeatInterval = null;

  function stopRepeat() {
    if (repeatTimer) { clearTimeout(repeatTimer); repeatTimer = null; }
    if (repeatInterval) { clearInterval(repeatInterval); repeatInterval = null; }
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('mousedown', (e) => {
      const btn = e.target.closest('.stepper-btn');
      if (!btn || e.button !== 0) return;
      e.preventDefault();
      stepUnit(btn);
      stopRepeat();
      repeatTimer = setTimeout(() => {
        repeatInterval = setInterval(() => stepUnit(btn), 60);
      }, 350);
    });

    document.addEventListener('mouseup', stopRepeat);
    document.addEventListener('mouseleave', stopRepeat);
    if (typeof window !== 'undefined') {
      window.addEventListener('blur', stopRepeat);
    }

    document.addEventListener('wheel', (e) => {
      const unit = e.target.closest('.input-unit');
      if (!unit) return;
      const input = unit.querySelector('input[type="number"]');
      if (!input || input.disabled || input.readOnly) return;
      if (document.activeElement !== input && !unit.matches(':hover')) return;

      e.preventDefault();
      if (e.deltaY < 0) {
        input.stepUp();
      } else if (e.deltaY > 0) {
        input.stepDown();
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, { passive: false });

    function enhanceAll(root) {
      if (!root) return;
      if (root.classList && root.classList.contains('input-unit')) enhance(root);
      else if (root.querySelectorAll) root.querySelectorAll('.input-unit').forEach(enhance);
    }

    function start() {
      enhanceAll(document.body);
      new MutationObserver((records) => {
        records.forEach((r) => r.addedNodes.forEach((n) => { if (n.nodeType === 1) enhanceAll(n); }));
      }).observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { enhance, stepUnit, stopRepeat, CHEVRON_UP, CHEVRON_DOWN };
  }
})();
