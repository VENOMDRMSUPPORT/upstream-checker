// src/auth/ipc.js
'use strict';

// The renderer's only way to the lock. Five channels, one thing each.
//
// THE CONTRACT, the same one src/preload.js states for catalog:*
//
//   Every channel RESOLVES. An outcome the UI has to act on is data of the
//   shape `{ ok: false, code, message }` — WRONG_PASSWORD, THROTTLED,
//   WEAK_PASSWORD, LOCK_NOT_READY. Only a genuine programmer error rejects.
//
//   Why: `ipcMain.handle` resolves by STRUCTURE and turns a rejection into a new
//   Error carrying only its `message`. An `err.code` set in main does not cross.
//   A channel whose verdict lives on the thrown object is a channel whose verdict
//   the renderer never receives — so the verdict has to be in the value instead.
//
// Nothing here returns a hash, a salt or the stored row. `auth:status` reports
// whether the shipped default is still in force and nothing about the value, and
// there is no channel that reads the lock back out.
//
// `onLocked` is how main tells the window the session ended, and why: 'expired'
// when the idle limit closed it, 'locked' when the owner asked. The idle check
// runs inside isLocked(), which the request gate calls on every request — so the
// moment is noticed there, but it is this layer that turns it into a message the
// window can act on.

function registerAuthIpc({ ipcMain, auth, log = console, onLocked = null }) {
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

  // A status read also reports an idle expiry that has already happened, so a
  // window that was idle while nothing else called in still gets told.
  const announce = () => {
    const expired = auth.takeExpiry();
    if (expired && typeof onLocked === 'function') {
      try {
        onLocked('expired');
      } catch (err) {
        log.warn('onLocked failed:', err.message);
      }
    }
  };

  handle('auth:status', () => {
    const status = auth.status();
    announce();
    return { ok: true, ...status };
  });

  handle('auth:unlock', (candidate) => auth.unlock(candidate));
  handle('auth:change', (current, next) => auth.change(current, next));
  handle('auth:lock', () => {
    const reply = auth.lock();
    if (typeof onLocked === 'function') {
      try {
        onLocked('locked');
      } catch (err) {
        log.warn('onLocked failed:', err.message);
      }
    }
    return reply;
  });
  handle('auth:activity', () => auth.noteActivity());

  return { channels: ['auth:status', 'auth:unlock', 'auth:change', 'auth:lock', 'auth:activity'] };
}

module.exports = { registerAuthIpc };
