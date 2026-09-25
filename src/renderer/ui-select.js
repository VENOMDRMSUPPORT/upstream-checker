// ============================================
// Design system — select menu
// ============================================
// Every <select> in the app is shown as the design system's own trigger and
// menu. The native list can't be styled in this Chromium: its highlight is the
// OS accent (Windows blue), whatever the theme. The native element stays in
// place, hidden, as the source of truth — code keeps reading and writing
// `.value` and listening for `change`/`input` exactly as before — and selects
// added later (a re-rendered toolbar) are picked up automatically.
(function () {
  const CHEVRON = '<svg class="ui-select-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
  const CHECK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
  const valueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  const indexDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');

  let menu = null;     // the one open menu
  let owner = null;    // the select it belongs to
  let active = -1;     // keyboard-highlighted option index

  function labelOf(select) {
    const opt = select.options[select.selectedIndex];
    return opt ? opt.textContent : '';
  }

  function sync(select) {
    const trigger = select._uiTrigger;
    if (!trigger) return;
    trigger.querySelector('.ui-select-value').textContent = labelOf(select);
    trigger.disabled = select.disabled;
  }

  function enhance(select) {
    if (select.dataset.uiEnhanced) return;
    select.dataset.uiEnhanced = '1';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    // A select that is a field on its own (Settings) draws the field frame; one
    // inside a labelled box (the toolbar's "Sort") stays flush with its box.
    trigger.className = `ui-select${select.classList.contains('prompt-input') ? ' ui-select-field' : ''}`;
    if (select.classList.contains('narrow')) trigger.classList.add('narrow');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    const label = select.getAttribute('aria-label') || (select.id && document.querySelector(`label[for="${CSS.escape(select.id)}"]`)?.textContent.trim());
    if (label) trigger.setAttribute('aria-label', label);
    trigger.innerHTML = `<span class="ui-select-value"></span>${CHEVRON}`;
    select.classList.add('ui-select-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    select.after(trigger);
    select._uiTrigger = trigger;

    // Code that sets .value / .selectedIndex directly fires no event; keep the
    // trigger's label in step with it anyway.
    Object.defineProperty(select, 'value', {
      configurable: true,
      get() { return valueDesc.get.call(this); },
      set(v) { valueDesc.set.call(this, v); sync(this); },
    });
    Object.defineProperty(select, 'selectedIndex', {
      configurable: true,
      get() { return indexDesc.get.call(this); },
      set(v) { indexDesc.set.call(this, v); sync(this); },
    });
    select.addEventListener('change', () => sync(select));

    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation(); // the toolbar's own label must not re-dispatch the click
      if (owner === select) close(); else open(select);
    });
    trigger.addEventListener('keydown', (e) => {
      // The menu's own key handler (capture phase) already used this key — an
      // Enter that picked an option must not reopen the menu it just closed.
      if (e.defaultPrevented) return;
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key) && owner !== select) {
        e.preventDefault();
        open(select);
      }
    });
    sync(select);
  }

  function open(select) {
    close();
    if (select.disabled) return;
    owner = select;
    const trigger = select._uiTrigger;
    trigger.setAttribute('aria-expanded', 'true');
    trigger.classList.add('open');
    menu = document.createElement('div');
    menu.className = 'ui-menu';
    menu.setAttribute('role', 'listbox');
    [...select.options].forEach((opt, i) => {
      const item = document.createElement('div');
      item.className = `ui-menu-item${i === select.selectedIndex ? ' selected' : ''}${opt.disabled ? ' disabled' : ''}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(i === select.selectedIndex));
      item.dataset.index = String(i);
      const text = document.createElement('span');
      text.textContent = opt.textContent;
      item.append(text);
      item.insertAdjacentHTML('beforeend', `<span class="ui-menu-check">${CHECK}</span>`);
      menu.append(item);
    });
    menu.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus on the trigger
    menu.addEventListener('click', (e) => {
      const item = e.target.closest('.ui-menu-item');
      if (item && !item.classList.contains('disabled')) pick(Number(item.dataset.index));
    });
    menu.addEventListener('mousemove', (e) => {
      const item = e.target.closest('.ui-menu-item');
      if (item) highlight(Number(item.dataset.index), false);
    });
    document.body.append(menu);
    place();
    highlight(select.selectedIndex, true);
  }

  // Under the trigger, at least as wide as it; above it when there is no room.
  function place() {
    const r = owner._uiTrigger.getBoundingClientRect();
    const anchor = owner._uiTrigger.closest('.dt-select') || owner._uiTrigger;
    const a = anchor.getBoundingClientRect();
    menu.style.minWidth = `${Math.max(a.width, 160)}px`;
    const h = menu.offsetHeight;
    const below = window.innerHeight - r.bottom - 8;
    const top = below >= h || below >= r.top ? a.bottom + 6 : a.top - h - 6;
    const left = Math.min(a.left, window.innerWidth - menu.offsetWidth - 8);
    menu.style.top = `${Math.max(8, top)}px`;
    menu.style.left = `${Math.max(8, left)}px`;
  }

  function highlight(i, scroll) {
    if (!menu) return;
    const items = menu.querySelectorAll('.ui-menu-item');
    items.forEach((el, n) => el.classList.toggle('active', n === i));
    active = i;
    if (scroll && items[i]) items[i].scrollIntoView({ block: 'nearest' });
  }

  function pick(i) {
    const select = owner;
    close();
    if (i < 0 || i === select.selectedIndex) { select._uiTrigger.focus(); return; }
    select.selectedIndex = i;
    // Both, because the app listens for either depending on the control.
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    select._uiTrigger.focus();
  }

  function close() {
    if (!menu) return;
    menu.remove();
    menu = null;
    if (owner && owner._uiTrigger) {
      owner._uiTrigger.setAttribute('aria-expanded', 'false');
      owner._uiTrigger.classList.remove('open');
    }
    owner = null;
    active = -1;
  }

  document.addEventListener('keydown', (e) => {
    if (!menu) return;
    const items = [...menu.querySelectorAll('.ui-menu-item')];
    const next = (from, step) => {
      let i = from;
      for (let n = 0; n < items.length; n++) {
        i = (i + step + items.length) % items.length;
        if (!items[i].classList.contains('disabled')) return i;
      }
      return from;
    };
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight(next(active, 1), true); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(next(active, -1), true); }
    else if (e.key === 'Home') { e.preventDefault(); highlight(next(-1, 1), true); }
    else if (e.key === 'End') { e.preventDefault(); highlight(next(items.length, -1), true); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(active); }
    else if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.preventDefault();
      const t = owner && owner._uiTrigger;
      close();
      if (e.key === 'Escape' && t) t.focus();
    }
  }, true);
  document.addEventListener('mousedown', (e) => {
    if (menu && !menu.contains(e.target) && !(owner && owner._uiTrigger.contains(e.target))) close();
  });
  // A label points at the hidden native select: clicking a label that wraps the
  // control ("Sort ▾") opens the menu, and a title elsewhere focuses the trigger.
  document.addEventListener('click', (e) => {
    const lab = e.target.closest('label');
    const ctl = lab && lab.control;
    if (!ctl || !ctl.dataset || !ctl.dataset.uiEnhanced || ctl._uiTrigger.contains(e.target)) return;
    e.preventDefault();
    if (lab.contains(ctl)) open(ctl);
    else ctl._uiTrigger.focus();
  });
  window.addEventListener('resize', close);
  document.addEventListener('scroll', (e) => { if (menu && !menu.contains(e.target)) close(); }, true);

  function enhanceAll(root) {
    if (root.tagName === 'SELECT') enhance(root);
    else if (root.querySelectorAll) root.querySelectorAll('select').forEach(enhance);
  }

  function start() {
    enhanceAll(document.body);
    new MutationObserver((records) => {
      records.forEach((r) => r.addedNodes.forEach((n) => { if (n.nodeType === 1) enhanceAll(n); }));
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
