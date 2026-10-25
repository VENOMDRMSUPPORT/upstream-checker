// ============================================
// OAuth — the channels the renderer uses
// ============================================
// Four channels: start a sign-in, read its state, open the page again, and
// give up. The state is a read, so it answers even while the app is locked —
// a locked app has no page to show it anyway.
//
// The three that act are gated on the lock, like copy-key and api-request: a
// sign-in mints a credential, and that is the owner's to give. A refused
// call resolves { ok: false, code: 'LOCKED' } rather than throwing, so the
// renderer can tell a locked app from a real failure.
function registerOAuthIpc({ ipcMain, oauth, auth = null, log = console } = {}) {
  const handle = (channel, fn) => {
    ipcMain.handle(channel, (_event, ...args) => {
      try {
        return fn(...args);
      } catch (err) {
        log.error(`${channel} failed:`, err.message);
        throw err;
      }
    });
  };

  const whenUnlocked = (fn) => (...args) => {
    if (auth && auth.isLocked()) {
      return { ok: false, code: 'LOCKED', message: 'The app is locked.' };
    }
    return fn(...args);
  };

  handle('oauth-start', whenUnlocked((providerId, config) => oauth.start(providerId, config)));
  handle('oauth-status', (providerId) => oauth.status(providerId));
  handle('oauth-cancel', whenUnlocked((providerId) => oauth.cancel(providerId)));
  handle('oauth-reopen', whenUnlocked((providerId) => oauth.reopen(providerId)));
  // The account's usage, read again with the stored session.
  handle('oauth-usage', whenUnlocked((providerId, config) => oauth.usage(providerId, config)));
  // An account whose token has grown old, renewed before it is used. The
  // app renews on its own every minute; this is the button that does it now.
  handle('oauth-renew', whenUnlocked((providerId, keyId) => oauth.renew(providerId, keyId)));
}

module.exports = { registerOAuthIpc };
