// The single-provider page header and API-key list.
window.VENOM_RENDERER = window.VENOM_RENDERER || {};
window.VENOM_RENDERER.providerDetail = {
  create(deps) {
    'use strict';
    const {
      $, $$, getProvider, getActiveProvider, getCurrentPage, breadcrumbHTML,
      providerMark, providerStatusHTML, renderPageHeader, showPage, openProviderModal,
      escapeHtml, toggleKeyActive, removeKey, copyKey, connectAccount,
    } = deps;
    const ICON_UNLOCKED = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 019.9-1"/></svg>`;
    const ICON_LOCKED = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>`;

    function renderHead() {
      const p = getProvider(getActiveProvider());
      if (!p) return;
      $('#pt-crumbs').innerHTML = breadcrumbHTML([
        { label: 'Overview', page: 'overview' },
        { label: 'Providers', page: 'providers' },
        { label: p.name, iconHTML: `<span class="crumb-mark">${providerMark(p)}</span>` },
      ]);
      const healthEl = $('#pt-health');
      if (healthEl) healthEl.innerHTML = providerStatusHTML(p);
      if (getCurrentPage() === 'provider') renderPageHeader('provider');
    }

    function renderKeys() {
      const p = getProvider(getActiveProvider());
      if (!p) return;
      const container = $('#keys-list');
      $('#pt-key-count').textContent = String(p.keys.length);
      // A provider that signs in on a web page holds accounts, not pasted
      // keys: the panel says so, and the button is Connect, not Add.
      const isOauth = Array.isArray(p.auth) && p.auth.includes('oauth');
      const addBtn = $('#btn-add-key');
      const connectBtn = $('#btn-connect-account');
      if (addBtn) addBtn.hidden = isOauth;
      if (connectBtn) connectBtn.hidden = !isOauth;
      const labelText = $('#pt-keys-label-text');
      if (labelText) labelText.textContent = isOauth ? 'Accounts' : 'API keys';
      if (p.keys.length === 0) {
        container.innerHTML = `<div class="models-empty"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" opacity="0.5" aria-hidden="true"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg><span>${isOauth ? 'No accounts yet' : 'No keys yet'}</span><span class="models-empty-hint">${isOauth ? 'Connect an account to fetch and test this provider&#39;s models.' : 'Add a key to fetch and test this provider&#39;s models.'}</span></div>`;
        return;
      }
      container.innerHTML = p.keys.map((k) => `
    <div class="key-item ${k.locked ? 'unreadable' : k.active ? 'active' : ''}" data-key-id="${k.id}">
      <div class="key-header"><div class="key-name">${escapeHtml(k.name)}</div><div class="key-actions">
        <button class="key-icon-btn key-toggle-btn ${k.active && !k.locked ? 'active' : ''}" data-key-id="${k.id}" ${k.locked ? 'disabled' : ''} title="${k.locked ? 'Unreadable on this machine' : k.active ? 'In use — click to disable' : 'Disabled — click to enable'}">${k.active && !k.locked ? ICON_UNLOCKED : ICON_LOCKED}</button>
        <button class="key-icon-btn key-delete-btn" data-key-id="${k.id}" title="Remove key"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/><path d="M10 11v6M14 11v6"/></svg></button>
      </div></div>
      <div class="key-value"><span class="key-masked ${k.locked ? 'unreadable' : ''}">${k.locked ? 'Encrypted for another machine — re-add it' : (k.hint ? escapeHtml(k.hint) : '<span class="kx-notsaved" title="WARNING: Key value was never saved — re-add it">NOT SAVED: not saved</span>')}</span>
        <button class="key-icon-btn key-copy-btn" data-key-id="${k.id}" title="Copy key" ${k.locked ? 'disabled' : ''}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>
      </div>
    </div>`).join('');
      $$('.key-toggle-btn').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); toggleKeyActive(btn.dataset.keyId); }));
      $$('.key-delete-btn').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); removeKey(btn.dataset.keyId); }));
      $$('.key-copy-btn').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); copyKey(btn.dataset.keyId, btn); }));
    }

    $('.page-provider').addEventListener('click', (e) => {
      const go = e.target.closest('[data-go]');
      if (go) showPage(go.dataset.go);
    });
    $('#pt-edit').addEventListener('click', () => openProviderModal(getActiveProvider()));
    // Connect: the provider's own sign-in, opened in the user's browser.
    const connectBtn = $('#btn-connect-account');
    if (connectBtn) {
      connectBtn.addEventListener('click', () => {
        const p = getProvider(getActiveProvider());
        if (p && connectAccount) connectAccount(p.id);
      });
    }
    return { renderHead, renderKeys };
  },
};
