// General settings form binding, cost estimate and section navigation.
// Appearance and Security stay in their own units / app-owned handlers.
window.VENOM_RENDERER = window.VENOM_RENDERER || {};
window.VENOM_RENDERER.settingsPanel = {
  create(deps) {
    'use strict';
    const {
      getSettings, queueSettingsSave, applyAppearance, hasResultRows, renderResultsTable,
      getSelectedModels, getAutoTestMinutes, getTestPrompt, getExpectedAnswer,
      renderDecisionThreshold, updatePromptStats, updateExpectedChips,
      syncPromptPresetPills, syncTokenPresets, showPage, syncRoute, getCurrentPage,
      breadcrumbHTML, renderAppearancePickers, refreshLogInfo, renderAbout,
      renderSecuritySection, fillCatalogSettings, renderCatalogSources,
      onCatalogRepaint,
    } = deps;
    const $ = deps.$ || ((s) => document.querySelector(s));
    const $$ = deps.$$ || ((s) => document.querySelectorAll(s));

    const SETTING_INPUTS = [
      ['#set-max-tokens', 'maxOutputTokens', 'int'],
      ['#set-image-prompt', 'imagePrompt', 'text'],
      ['#set-video-prompt', 'videoPrompt', 'text'],
      ['#set-video-poll', 'videoPollMs', 'sec'],
      ['#set-verify-assets', 'verifyAssets', 'bool'],
      ['#set-decision-state', 'decisionState', 'text'],
      ['#set-decision-question', 'decisionQuestion', 'text'],
      ['#set-decision-threshold', 'decisionThreshold', 'ratio'],
      ['#set-deadline-decision', 'deadlineDecisionMs', 'sec'],
      ['#set-per-model-budget', 'perModelBudgetMs', 'sec'],
      ['#set-time-good', 'timeGoodMs', 'sec'],
      ['#set-time-ok', 'timeOkMs', 'sec'],
      ['#set-deadline-chat', 'deadlineChatMs', 'sec'],
      ['#set-deadline-image', 'deadlineImageMs', 'sec'],
      ['#set-deadline-video', 'deadlineVideoMs', 'sec'],
      ['#set-hedge-enabled', 'hedgeEnabled', 'bool'],
      ['#set-hedge-max', 'hedgeMax', 'int'],
      ['#set-hedge-step', 'hedgeStepMs', 'int'],
      ['#set-retries', 'maxTestRetries', 'int'],
      ['#set-rl-waits', 'maxRateLimitWaits', 'int'],
      ['#set-history-max', 'historyMaxRuns', 'int'],
      ['#set-spark-runs', 'sparkRuns', 'int'],
      ['#set-skip-media', 'scheduleSkipMedia', 'bool'],
      ['#set-notify-regression', 'notifyRegression', 'bool'],
      ['#set-notify-complete', 'notifyRunComplete', 'bool'],
      ['#set-log-level', 'logLevel', 'text'],
      ['#set-log-retention', 'logRetentionDays', 'int'],
      ['#set-body-retention', 'bodyRetentionDays', 'int'],
      ['#set-stats-retention', 'statsRetentionMonths', 'int'],
      ['#set-purge-window', 'purgeWindowDays', 'int'],
      ['#set-concurrency', 'concurrency', 'int'],
      ['#set-reduce-motion', 'reduceMotion', 'bool'],
      ['#set-debug-header', 'debugHeader', 'bool'],
      ['#set-lock-idle', 'lockIdleMin', 'int'],
      ['#set-gateway-port', 'routerGatewayPort', 'int'],
    ];

    const COST_SECTIONS = ['sec-test', 'sec-schedule', 'sec-speed', 'sec-reliability'];

    const SETTINGS_SECTIONS_META = {
      'sec-appearance': { label: 'Appearance', desc: 'Theme, accent colour and how dense the results table is' },
      'sec-test': { label: 'Test & Prompts', desc: 'The prompt and the pass rule for each kind of model' },
      'sec-schedule': { label: 'Schedule', desc: 'Automatic re-tests, health checks and alerts' },
      'sec-speed': { label: 'Speed & Timeouts', desc: 'Latency colours, and how long a model may take' },
      'sec-reliability': { label: 'Reliability', desc: 'Hedging, models tested at once, and retries' },
      'sec-catalog': { label: 'Models Catalog', desc: 'How the model pool syncs, and the sources its facts are scored against' },
      'sec-history': { label: 'History', desc: 'How many runs are kept, and exporting them' },
      'sec-logs': { label: 'Diagnostics & Logs', desc: 'What is logged about each request, and where' },
      'sec-security': { label: 'Security', desc: 'The owner password, and how long an idle session stays open' },
      'sec-data': { label: 'Data Directory', desc: 'Where your settings, keys and history are stored' },
      'sec-about': { label: 'About VENOM Router', desc: 'Version, providers and updates' },
    };

    function fillForm() {
      const settings = getSettings();
      SETTING_INPUTS.forEach(([sel, key, kind]) => {
        const el = $(sel);
        if (!el) return;
        if (kind === 'bool') el.checked = !!settings[key];
        else if (kind === 'sec') el.value = Math.round(settings[key] / 1000);
        else el.value = settings[key];
      });
      $('#prompt-input').value = getTestPrompt();
      $('#expected-input').value = getExpectedAnswer();
      $('#auto-test-select').value = String(getAutoTestMinutes());
      renderDecisionThreshold();
      renderCostEstimate();
      updatePromptStats();
      updateExpectedChips();
      syncPromptPresetPills();
      syncTokenPresets();
    }

    function bindForm() {
      SETTING_INPUTS.forEach(([sel, key, kind]) => {
        const el = $(sel);
        if (!el) return;
        el.addEventListener(kind === 'bool' ? 'change' : 'input', () => {
          const settings = getSettings();
          if (kind === 'bool') settings[key] = el.checked;
          else if (kind === 'text') settings[key] = el.value;
          else {
            const n = Number(el.value);
            if (el.value.trim() === '') return;
            if (key === 'lockIdleMin') settings[key] = Math.min(480, Math.max(5, Math.round(n)));
            else if (key === 'routerGatewayPort') settings[key] = Math.min(65535, Math.max(1024, Math.round(n)));
            else if (key === 'perModelBudgetMs') settings[key] = Math.max(0, Math.round(n));
            else {
              if (!Number.isFinite(n) || n <= 0) return;
              settings[key] = kind === 'sec' ? Math.round(n * 1000) : kind === 'ratio' ? n : Math.round(n);
            }
          }
          if (key === 'decisionThreshold') renderDecisionThreshold();
          if (key === 'maxOutputTokens') syncTokenPresets(settings.maxOutputTokens);
          if (key === 'reduceMotion' || key === 'debugHeader') applyAppearance();
          queueSettingsSave();
          renderCostEstimate();
          if (hasResultRows()) renderResultsTable();
          if (typeof onCatalogRepaint === 'function') onCatalogRepaint();
        });
      });
    }

    function renderCostEstimate() {
      const el = $('#settings-estimate');
      if (!el) return;
      const settings = getSettings();
      const models = getSelectedModels().length;
      const section = document.querySelector('.settings-nav-item.active')?.dataset.section;
      el.hidden = models === 0 || !COST_SECTIONS.includes(section);
      if (models === 0) return;
      const perModelMax = (settings.hedgeEnabled ? Math.max(1, settings.hedgeMax) : 1) * (1 + settings.maxTestRetries);
      const low = models;
      const high = models * perModelMax;
      let text = `${models} models · ${low} to ${high} requests per run`;
      if (settings.concurrency > 1) text += ` · ${settings.concurrency} at a time`;
      const autoTestMinutes = getAutoTestMinutes();
      if (autoTestMinutes > 0) {
        const perDay = Math.round((24 * 60) / autoTestMinutes);
        text += ` · ${(low * perDay).toLocaleString()} to ${(high * perDay).toLocaleString()} per day on this schedule`;
      }
      el.textContent = text;
    }

    function renderSettingsCrumbs(activeSectionLabel) {
      const el = $('#settings-crumbs');
      if (!el) return;
      el.innerHTML = breadcrumbHTML([
        { label: 'Overview', page: 'overview' },
        { label: 'Settings', page: 'settings' },
        { label: activeSectionLabel || 'Appearance' },
      ]);
    }

    function switchSection(sectionId) {
      const targetId = sectionId || 'sec-appearance';
      if (targetId === 'sec-security') {
        showPage('profile');
        return;
      }
      const btn = $(`#settings-nav .settings-nav-item[data-section="${targetId}"]`);
      if (!btn) return;
      $$('#settings-nav .settings-nav-item').forEach((b) => {
        const on = b === btn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', String(on));
      });
      $$('.settings-section').forEach((sec) => { sec.hidden = sec.id !== targetId; });
      if (targetId === 'sec-logs' && window.LOGS) window.LOGS.health();
      if (targetId === 'sec-catalog' && typeof renderCatalogSources === 'function') renderCatalogSources();
      if (targetId === 'sec-security') renderSecuritySection();

      const page = $('.page-settings');
      const grid = $('.settings-layout-grid');
      if (page && grid && !page.hidden) {
        const stick = parseFloat(getComputedStyle(page).paddingTop) || 0;
        const offset = grid.getBoundingClientRect().top - page.getBoundingClientRect().top;
        if (offset < stick) page.scrollTop += offset - stick;
      }

      const resetBtn = $('#btn-reset-appearance');
      if (resetBtn) {
        const isAppearance = targetId === 'sec-appearance';
        const isTest = targetId === 'sec-test';
        resetBtn.hidden = !(isAppearance || isTest);
        const meta = SETTINGS_SECTIONS_META[targetId];
        const labelSpan = resetBtn.querySelector('.reset-btn-label');
        if (labelSpan) labelSpan.textContent = 'Reset to defaults';
        resetBtn.title = isTest
          ? 'Restore default prompt and expected answer'
          : `Reset ${meta ? meta.label : 'appearance'} to defaults`;
      }

      const meta = SETTINGS_SECTIONS_META[targetId] || { label: 'Settings', desc: 'Configure application options' };
      const titleEl = $('#settings-main-head-title');
      const descEl = $('#settings-main-head-desc');
      if (titleEl) titleEl.textContent = meta.label;
      if (descEl) descEl.textContent = meta.desc;
      const iconBox = $('#settings-main-head-icon');
      const navIcon = btn.querySelector('.settings-nav-icon');
      if (iconBox) iconBox.replaceChildren(...(navIcon ? [navIcon.cloneNode(true)] : []));

      renderSettingsCrumbs(meta.label);
      renderCostEstimate();
      if (getCurrentPage() === 'settings') syncRoute();
    }

    function preparePage() {
      fillForm();
      renderAppearancePickers();
      refreshLogInfo();
      renderAbout();
      renderSecuritySection();
      if (typeof fillCatalogSettings === 'function') fillCatalogSettings();
      const activeBtn = $('#settings-nav .settings-nav-item.active') || $('#settings-nav .settings-nav-item');
      if (activeBtn) switchSection(activeBtn.dataset.section);
      else switchSection('sec-appearance');
    }

    function openSettings() {
      showPage('settings');
    }

    function sectionMeta(id) {
      return SETTINGS_SECTIONS_META[id];
    }

    return {
      SETTING_INPUTS,
      COST_SECTIONS,
      SETTINGS_SECTIONS_META,
      fillForm,
      bindForm,
      renderCostEstimate,
      switchSection,
      preparePage,
      openSettings,
      sectionMeta,
      renderSettingsCrumbs,
      // Aliases for existing app call sites
      fillSettingsForm: fillForm,
      bindSettingsForm: bindForm,
      switchSettingsSection: switchSection,
      prepareSettingsPage: preparePage,
    };
  },
};
