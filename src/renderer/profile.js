// ============================================
// Header profile menu — Administrator, and the way out
// ============================================
// The header's profile button used to be inert ("Profile — coming soon"). It
// now opens a menu whose two items are the two things the app lock can do from
// inside a session: lock it now, and sign out.
//
// Both end the same session; they differ only in what the owner is told. "Lock
// now" is the deliberate one — leave the machine, come back to the same window.
// "Sign out" is the same lock with the wording a person expects from a session,
// and it closes the menu it was clicked from.
//
// This file is loaded before app.js and depends on window.LOCK, which lock.js
// publishes. It deliberately does NOT depend on app.js: the menu must keep
// working on the lock screen's edges and in any load order.
(function () {
  'use strict';

  const wrap = document.querySelector('.hdr-profile-wrap');
  const button = document.getElementById('btn-profile');
  const pop = document.getElementById('profile-pop');
  if (!wrap || !button || !pop) return;

  function setOpen(open) {
    pop.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  }

  const isOpen = () => !pop.hidden;

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!isOpen());
  });

  // Clicking inside must not be read as a click outside by the document
  // listener below — the same reason the accent popover stops it.
  pop.addEventListener('click', (e) => e.stopPropagation());

  document.addEventListener('click', (e) => {
    if (isOpen() && !e.target.closest('.hdr-profile-wrap')) setOpen(false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) {
      setOpen(false);
      button.focus();
    }
  });

  async function lockNow() {
    setOpen(false);
    try {
      await window.electronAPI.authLock();
    } catch (err) {
      console.error('Could not lock the app:', err);
      return;
    }
    // main sends auth:locked to the window, and lock.js shows the panel from
    // there. It does this one too so the screen appears the moment the click
    // lands rather than when the message arrives.
    if (window.LOCK) window.LOCK.show('locked');
  }

  const lockItem = document.getElementById('btn-profile-lock');
  const signOutItem = document.getElementById('btn-profile-signout');
  if (lockItem) lockItem.addEventListener('click', lockNow);
  if (signOutItem) signOutItem.addEventListener('click', lockNow);
})();
