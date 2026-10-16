// Theme, accent and density controls; state is read through live getters.
window.VENOM_RENDERER = window.VENOM_RENDERER || {};
window.VENOM_RENDERER.appearance = {
  create(deps) {
    'use strict';
    const { getSettings, getCurrentPage, queueSettingsSave, hasResultRows, renderResultsTable,
      escapeHtml, showPage, switchSettingsSection } = deps;
    const { ACCENTS, DEFAULT_SETTINGS } = deps.defaults;
    const $ = s => document.querySelector(s);
    const $$ = s => document.querySelectorAll(s);
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

    function effectiveTheme() {
      if (getSettings().followSystem) return systemDark.matches ? 'vercel' : 'daylight';
      return getSettings().theme;
    }

    function accentLabel() {
      return (ACCENTS.find((a) => a.id === getSettings().accent) || ACCENTS[0]).name;
    }

    function applyAppearance() {
      const el = document.documentElement;
      const theme = effectiveTheme();
      el.setAttribute('data-theme', theme);
      el.setAttribute('data-density', getSettings().density);
      el.setAttribute('data-accent', getSettings().accent);
      // The lock screen's motion switch. It reads this attribute in CSS and in
      // lock.js, so flipping the setting takes effect without a reload — and the
      // OS's own prefers-reduced-motion is honoured on top of it, in both places.
      el.setAttribute('data-motion', getSettings().reduceMotion ? 'reduced' : 'normal');
      queueBrandIcon(getSettings().accent);

      const debugBtn = document.getElementById('btn-header-debug');
      if (debugBtn) debugBtn.hidden = !getSettings().debugHeader;

      const toggle = document.getElementById('btn-theme-toggle');
      if (toggle) {
        const label = theme === 'daylight' ? 'Switch to dark mode' : 'Switch to light mode';
        toggle.title = label;
        toggle.setAttribute('aria-label', label);
      }
    }

    // The taskbar icon follows the accent: main sets the window icon to that
    // accent's emblem. Debounced, because a quick run through the swatches would
    // otherwise set it once per click; an unchanged accent is not sent again.
    const brandIcon = { id: null, timer: null };

    function queueBrandIcon(id) {
      if (!window.electronAPI?.setWindowIcon || id === brandIcon.id) return;
      brandIcon.id = id;
      clearTimeout(brandIcon.timer);
      brandIcon.timer = setTimeout(() => window.electronAPI.setWindowIcon(id), 150);
    }

    // Every emblem, once, so picking an accent swaps the picture at once instead of
    // showing a gap while the file loads.
    function preloadEmblems() {
      ACCENTS.forEach((a) => {
        ['', '-light'].forEach((suffix) => { new Image().src = `../assets/brand/emblem-${a.id}${suffix}.png`; });
      });
    }

    // Windows switching light/dark while the app is open.
    systemDark.addEventListener('change', () => {
      if (!getSettings().followSystem) return;
      applyAppearance();
      if (getCurrentPage() === 'settings') renderAppearancePickers();
    });

    // Header toggle flips the mode actually on screen; an explicit choice ends
    // following the system.
    function toggleTheme() {
      getSettings().theme = effectiveTheme() === 'daylight' ? 'vercel' : 'daylight';
      getSettings().followSystem = false;
      applyAppearance();
      queueSettingsSave();
      if (getCurrentPage() === 'settings') renderAppearancePickers();
    }

    function accentSwatchesHTML(cls, role) {
      return ACCENTS.map((a) => {
        const on = a.id === getSettings().accent;
        return `<button class="${cls} ${on ? 'active' : ''}" type="button" role="${role}" aria-checked="${on}"
                 data-accent-id="${a.id}" title="${a.name}" aria-label="${a.name}"
                 style="background:${a.hex};color:${a.hex}"></button>`;
      }).join('');
    }

    // Inactive accent IDs currently displayed in the 2x2 grid.
    let inactiveAccentIds = ['cyan', 'violet', 'crimson', 'amber'];

    function ensureInactiveAccents() {
      const current = getSettings().accent;
      const remaining = ACCENTS.filter((a) => a.id !== current).map((a) => a.id);
      if (!Array.isArray(inactiveAccentIds) || inactiveAccentIds.length !== 4) {
        inactiveAccentIds = remaining;
        return;
      }
      if (inactiveAccentIds.includes(current)) {
        const idx = inactiveAccentIds.indexOf(current);
        const missing = remaining.find((id) => !inactiveAccentIds.includes(id));
        if (missing && idx !== -1) {
          inactiveAccentIds[idx] = missing;
        } else {
          inactiveAccentIds = remaining;
        }
      }
    }

    function renderAccentClusterHTML() {
      ensureInactiveAccents();
      const currentAccent = ACCENTS.find((a) => a.id === getSettings().accent) || ACCENTS[0];
      const subSwatches = inactiveAccentIds.map((id) => {
        const a = ACCENTS.find((item) => item.id === id) || ACCENTS[0];
        return `<button class="accent-swatch accent-mini-swatch" type="button" role="radio" aria-checked="false"
                 data-accent-id="${a.id}" title="${a.name}" aria-label="${a.name}"
                 style="--swatch-color:${a.hex};background:${a.hex};color:${a.hex};"></button>`;
      }).join('');

      return `<div class="accent-cluster-grid" role="group" aria-label="Alternative accent colors">
        ${subSwatches}
      </div>
      <div class="accent-cluster-divider" aria-hidden="true"></div>
      <div class="accent-cluster-active-wrap">
        <button class="accent-swatch active accent-active-swatch" type="button" role="radio" aria-checked="true"
                data-accent-id="${currentAccent.id}" title="${currentAccent.name} (Active)" aria-label="${currentAccent.name} (Active)"
                style="--swatch-color:${currentAccent.hex};background:${currentAccent.hex};color:${currentAccent.hex};"></button>
      </div>`;
    }

    function renderAppearancePickers() {
      const theme = effectiveTheme();
      $$('#mode-grid .mode-card').forEach((card) => {
        const on = card.dataset.themeId === theme;
        card.classList.toggle('active', on);
        card.setAttribute('aria-checked', String(on));
      });
      $('#mode-grid').classList.toggle('following', getSettings().followSystem);
      const themeBadge = document.getElementById('theme-active-mode-badge');
      if (themeBadge) {
        themeBadge.textContent = getSettings().followSystem ? 'Auto (System)' : (effectiveTheme() === 'vercel' ? 'Dark' : 'Light');
      }
      $('#set-follow-system').checked = getSettings().followSystem;

      const debugHeaderInput = document.getElementById('set-debug-header');
      if (debugHeaderInput) debugHeaderInput.checked = !!getSettings().debugHeader;
      const reduceMotionInput = document.getElementById('set-reduce-motion');
      if (reduceMotionInput) reduceMotionInput.checked = !!getSettings().reduceMotion;

      $('#accent-row').innerHTML = renderAccentClusterHTML();
      $('#accent-name').textContent = accentLabel();

      $$('#density-seg button').forEach((b) => {
        const on = b.dataset.value === getSettings().density;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', String(on));
      });

      const densityPill = document.getElementById('density-current-pill');
      if (densityPill) {
        densityPill.textContent = `${getSettings().density.charAt(0).toUpperCase() + getSettings().density.slice(1)} density`;
      }
    }

    function saveAppearance() {
      applyAppearance();
      queueSettingsSave();
      renderAppearancePickers();
      if (!$('#accent-pop').hidden) renderAccentPop();
    }

    function setAccent(id) {
      if (!ACCENTS.some((a) => a.id === id)) return;
      const oldId = getSettings().accent;
      if (oldId !== id) {
        ensureInactiveAccents();
        const idx = inactiveAccentIds.indexOf(id);
        if (idx !== -1) {
          inactiveAccentIds[idx] = oldId;
        }
        getSettings().accent = id;
        saveAppearance();
      } else {
        const activeEl = document.querySelector('#accent-row .accent-active-swatch');
        if (activeEl) {
          activeEl.classList.remove('accent-pulse');
          void activeEl.offsetWidth;
          activeEl.classList.add('accent-pulse');
        }
      }
    }

    function bindAccentSwatches(container) {
      if (!container) return;
      container.addEventListener('click', (e) => {
        const sw = e.target.closest('[data-accent-id]');
        if (sw) setAccent(sw.dataset.accentId);
      });
      container.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          const sw = e.target.closest('[data-accent-id]');
          if (sw) {
            e.preventDefault();
            setAccent(sw.dataset.accentId);
          }
        }
      });
    }

    function accentRowsHTML() {
      return ACCENTS.map((a) => {
        const on = a.id === getSettings().accent;
        return `<div class="accent-row-item ${on ? 'active' : ''}" role="menuitemradio" aria-checked="${on}"
                     data-accent-id="${a.id}" tabindex="0" title="${escapeHtml(a.name)}">
          <span class="accent-row-swatch" style="--swatch-c:${a.hex};background:${a.hex}"></span>
          <div class="accent-row-text">
            <div class="accent-row-name">${escapeHtml(a.name)}</div>
            <div class="accent-row-desc">${escapeHtml(a.desc || '')}</div>
          </div>
          <div class="accent-row-status">
            ${on ? `<span class="accent-row-check" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>` : ''}
          </div>
        </div>`;
      }).join('');
    }

    function renderAccentPop() {
      $('#accent-pop-swatches').innerHTML = accentRowsHTML();
      const pill = document.getElementById('accent-current-name');
      if (pill) pill.textContent = accentLabel();
    }

    function setAccentPopOpen(open) {
      $('#accent-pop').hidden = !open;
      $('#btn-accent').setAttribute('aria-expanded', String(open));
      // One header popup at a time: the notifications and profile panels' own
      // outside-click closers never fire through this stopped toggle click.
      if (open) {
        for (const [popId, btnId] of [['notif-pop', 'btn-notifications'], ['profile-pop', 'btn-profile']]) {
          const other = document.getElementById(popId);
          if (other && !other.hidden) {
            other.hidden = true;
            const btn = document.getElementById(btnId);
            if (btn) btn.setAttribute('aria-expanded', 'false');
          }
        }
      }
      if (open) renderAccentPop();
    }
    function reset() {
      ['theme', 'followSystem', 'accent', 'density', 'reduceMotion', 'debugHeader'].forEach(k => { getSettings()[k] = DEFAULT_SETTINGS[k]; });
      inactiveAccentIds = ACCENTS.filter(a => a.id !== DEFAULT_SETTINGS.accent).map(a => a.id);
      saveAppearance();
      renderAppearancePickers();
    }

    function bindControls() {
      $('#mode-grid').addEventListener('click', (e) => {
        const card = e.target.closest('.mode-card');
        if (!card) return;
        getSettings().theme = card.dataset.themeId;
        getSettings().followSystem = false;
        saveAppearance();
      });

      $('#set-follow-system').addEventListener('change', (e) => {
        getSettings().followSystem = e.target.checked;
        // Turning it off keeps the mode that is on screen rather than jumping back.
        if (!getSettings().followSystem) getSettings().theme = systemDark.matches ? 'vercel' : 'daylight';
        saveAppearance();
      });

      $('#density-seg').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-value]');
        if (!b) return;
        getSettings().density = b.dataset.value;
        saveAppearance();
        if (hasResultRows()) renderResultsTable();
      });

      bindAccentSwatches($('#accent-row'));


      // Header accent picker. Built from ACCENTS, like the Settings row, so the two
      // always offer the same colours.


      $('#btn-accent').addEventListener('click', (e) => {
        e.stopPropagation();
        setAccentPopOpen($('#accent-pop').hidden);
      });
      // Picking re-renders the swatches, detaching the clicked node; stopped here so
      // the outside-click check below doesn't read it as a click outside and close
      // the popover mid-comparison.
      $('#accent-pop').addEventListener('click', (e) => e.stopPropagation());
      bindAccentSwatches($('#accent-pop-swatches'));
      const accentAppBtn = document.getElementById('accent-view-appearance');
      if (accentAppBtn) {
        accentAppBtn.addEventListener('click', () => {
          setAccentPopOpen(false);
          showPage('settings');
          if (typeof switchSettingsSection === 'function') switchSettingsSection('sec-appearance');
        });
      }
      document.addEventListener('click', (e) => {
        if (!$('#accent-pop').hidden && !e.target.closest('.hdr-accent')) setAccentPopOpen(false);
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !$('#accent-pop').hidden) {
          setAccentPopOpen(false);
          $('#btn-accent').focus();
        }
      });
    }
    return {
      effectiveTheme, accentLabel, applyAppearance, queueBrandIcon, preloadEmblems, toggleTheme,
      renderAppearancePickers, saveAppearance, setAccent, renderAccentPop, setAccentPopOpen, reset,
      bindControls,
    };
  },
};
