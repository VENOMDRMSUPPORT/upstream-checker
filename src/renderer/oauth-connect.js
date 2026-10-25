// ============================================
// OAuth — the connect flow in the page
// ============================================
// The page asks main to start the provider's own sign-in, shows the code the
// person has to type on the provider's page, and waits for the approval.
// Nothing secret is in the page: the reply carries a code to type and the
// state of the sign-in, and the account itself arrives as a key row main
// wrote to the database.
//
// The provider's flow is declared in its module (meta.oauth) and handed to
// main as plain data. The page never reads a token.
window.VENOM_RENDERER = window.VENOM_RENDERER || {};
window.VENOM_RENDERER.oauthConnect = {
  create(deps) {
    'use strict';
    const { $, electronAPI, getProvider, reloadProviders, escapeHtml } = deps;

    // How often the state of the sign-in is read while it is running.
    const POLL_MS = 2000;
    // How long a toast stays on screen.
    const TOAST_MS = 4200;

    let poller = null;
    let current = null; // { providerId, name }

    function stopPolling() {
      if (poller) {
        clearInterval(poller);
        poller = null;
      }
    }

    function close() {
      stopPolling();
      current = null;
      const el = $('#oauth-modal');
      if (el) el.style.display = 'none';
    }

    function status(text, state) {
      const el = $('#oauth-modal-status');
      const row = $('#oauth-modal-status-row');
      const spin = $('#oauth-modal-spinner');
      if (el) {
        el.textContent = text || '';
        el.dataset.state = state || '';
        el.hidden = !text;
      }
      if (row) row.hidden = !text;
      // The spinner turns while the app waits: for the browser to open, for
      // the person to sign in, for the answer to come back.
      if (spin) spin.hidden = state !== 'busy';
    }

    function showCode(code) {
      const box = $('#oauth-modal-code-box');
      const el = $('#oauth-modal-code');
      if (!box || !el) return;
      if (!code) {
        box.hidden = true;
        el.textContent = '';
        return;
      }
      el.textContent = code;
      box.hidden = false;
    }

    function toast(message, tone) {
      const root = document.getElementById('mc-toasts');
      if (!root) return;
      const el = document.createElement('div');
      el.className = `mc-toast mc-toast-${tone || 'info'}`;
      el.setAttribute('role', 'status');
      el.innerHTML = `<span class="mc-toast-msg">${escapeHtml(message)}</span>`;
      root.appendChild(el);
      requestAnimationFrame(() => el.classList.add('show'));
      setTimeout(() => {
        el.classList.remove('show');
        setTimeout(() => el.remove(), 240);
      }, TOAST_MS);
    }

    // The sign-in is running: the page reads its state until it is done.
    function poll(providerId) {
      stopPolling();
      poller = setInterval(async () => {
        let state = null;
        try {
          state = await electronAPI.oauthStatus(providerId);
        } catch (_) {
          return; // a failed read is not an answer; try again
        }
        if (!state || state.state === 'pending') return;
        stopPolling();
        if (state.state === 'done') {
          const account = state.account || {};
          const who = account.email || account.name;
          close();
          await reloadProviders(providerId);
          toast(who ? `Connected as ${who}` : 'The account is connected', 'ok');
          return;
        }
        if (state.state === 'failed') {
          status((state.error && state.error.message) || 'The sign-in did not finish.', 'fail');
          return;
        }
        close();
      }, POLL_MS);
    }

    async function open(providerId) {
      const entry = (window.INTEGRATED_PROVIDERS || {})[providerId];
      const meta = entry && entry.meta;
      if (!meta || !meta.oauth) {
        toast('This provider does not sign in on a web page.', 'warn');
        return;
      }
      const p = getProvider(providerId);
      const kind = String(meta.oauth.kind || 'device');
      // 'web' opens a window the app owns; 'loopback' opens the person's own
      // browser and takes the answer back on a short-lived address; 'device'
      // shows a code to type.
      current = { providerId, name: (p && p.name) || meta.name, kind, inAppWindow: kind === 'web' };

      const title = $('#oauth-modal-title');
      if (title) title.textContent = `Connect ${current.name}`;
      const lead = $('#oauth-modal-lead');
      if (lead) {
        lead.textContent = kind === 'web'
          ? 'A sign-in window opens. Sign in there — the app waits for you, takes the session and closes the window.'
          : kind === 'loopback'
            ? 'Your browser opens on the sign-in page. Sign in there — the app takes the account, the tab closes itself and the app carries on.'
            : 'A sign-in page opens in your browser. Sign in there, approve the app, and come back — this window waits for you.';
      }
      const reopenBtn = $('#oauth-modal-reopen');
      if (reopenBtn) reopenBtn.hidden = !!current.inAppWindow;
      showCode('');
      status(kind === 'web'
        ? 'Opening the sign-in window…'
        : 'Opening the sign-in page in your browser…', 'busy');
      const el = $('#oauth-modal');
      if (el) el.style.display = 'flex';

      let started = null;
      try {
        started = await electronAPI.oauthStart(providerId, meta.oauth);
      } catch (err) {
        status(`The sign-in could not start: ${err.message}`, 'fail');
        return;
      }
      if (!started || started.ok === false) {
        const code = started && started.code;
        if (code === 'LOCKED') {
          status('The app is locked. Unlock it and try again.', 'fail');
          close();
          return;
        }
        status((started && started.message) || 'The sign-in could not start.', 'fail');
        return;
      }
      // The page the browser opened already carries the code; it is shown here
      // too, for the person who opened the page by hand.
      showCode(started.userCode || '');
      status(current.inAppWindow
        ? 'Waiting for the sign-in in the window…'
        : kind === 'loopback'
          ? 'Waiting for the sign-in in your browser…'
          : 'Waiting for the approval in your browser…', 'busy');
      poll(providerId);
    }

    async function reopen() {
      if (!current) return;
      try {
        await electronAPI.oauthReopen(current.providerId);
      } catch (_) {
        status('The sign-in page could not be opened again.', 'fail');
      }
    }

    async function cancel() {
      const providerId = current && current.providerId;
      close();
      if (!providerId) return;
      try {
        await electronAPI.oauthCancel(providerId);
      } catch (_) {
        // The sign-in is gone either way: the page is closed and the poll
        // stopped, so there is nothing left to wait for.
      }
    }

    const closeBtn = $('#oauth-modal-close');
    if (closeBtn) closeBtn.addEventListener('click', () => { cancel(); });
    const cancelBtn = $('#oauth-modal-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', () => { cancel(); });
    const reopenBtn = $('#oauth-modal-reopen');
    if (reopenBtn) reopenBtn.addEventListener('click', () => { reopen(); });
    const overlay = $('#oauth-modal');
    if (overlay) overlay.addEventListener('click', (e) => { if (e.target.id === 'oauth-modal') cancel(); });

    return { open, close, cancel, isOpen: () => !!current };
  },
};
