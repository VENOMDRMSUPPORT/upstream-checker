// ============================================
// The app lock screen — src/renderer/lock.js
// ============================================
// Loaded BEFORE app.js and exposes window.LOCK. app.js's start() asks
// `waitForUnlock()` before it does any startup work, so nothing is read from the
// database, no provider is loaded and no page is rendered until the password is
// accepted.
//
// This file never decides anything. It sends a candidate up and shows what main
// answers; whether the app is locked, whether the password is right and whether
// the attempt is throttled are all main's answers, and main's authority. A
// renderer that lied about being unlocked would change only what it drew.
//
// The colour of this screen does not come from the theme or the accent: the
// values live on #lock-screen in styles.css, not on :root. Changing the app's
// accent in Settings cannot reach this screen, which is the requirement met by
// construction rather than by remembering to opt out.
(function () {
  'use strict';

  const MIN_IDLE_MIN = 5;

  const el = {
    screen: null, canvas: null, form: null, input: null, submit: null,
    status: null, reveal: null, note: null, sub: null,
  };

  let resolved = null;         // the pending waitForUnlock() promise held open
  let onUnlocked = null;
  let particle = null;         // the canvas field's state, null while stopped
  let frame = null;            // the requestAnimationFrame handle
  let running = false;         // guards against two loops from two start() calls
  let activityBound = false;
  let lastActivitySent = 0;    // main counts too; this only keeps a drag to one send
  let throttleTimer = null;
  let reduceMotion = false;

  const ACTIVITY_SEND_MS = 5000;
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  // ---------- the particle field ----------
  // Cyan motes drifting up. Bounded on purpose: it stops when the screen is
  // hidden, when the window loses focus, and after a successful unlock — a rAF
  // loop left running is the one way an idle app can quietly burn CPU all day.
  function sizeCanvas() {
    const c = el.canvas;
    if (!c) return;
    // Capped at 2: a 4x display would otherwise push 4x the pixels through a
    // decorative background.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(window.innerWidth));
    const h = Math.max(1, Math.floor(window.innerHeight));
    c.width = Math.floor(w * dpr);
    c.height = Math.floor(h * dpr);
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    const ctx = c.getContext('2d');
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function seedParticles() {
    const count = window.innerWidth < 720 ? 34 : 60;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const list = [];
    for (let i = 0; i < count; i += 1) {
      list.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: 0.6 + Math.random() * 1.6,
        // Mostly upward with a small side drift, so the field reads as a slow
        // rise rather than as static noise that happens to be moving.
        vx: (Math.random() - 0.5) * 0.16,
        vy: -(0.12 + Math.random() * 0.34),
        a: 0.18 + Math.random() * 0.5,
        tw: Math.random() * Math.PI * 2,
      });
    }
    return list;
  }

  function tick() {
    if (!running) return;
    const c = el.canvas;
    const ctx = c && c.getContext('2d');
    if (!ctx) { running = false; return; }
    const w = window.innerWidth;
    const h = window.innerHeight;
    ctx.clearRect(0, 0, w, h);
    for (const p of particle) {
      p.x += p.vx;
      p.y += p.vy;
      p.tw += 0.012;
      // Wrap rather than bounce: a mote leaving the top reappears at the bottom,
      // so the field never thins out over a long idle.
      if (p.y < -4) { p.y = h + 4; p.x = Math.random() * w; }
      if (p.x < -4) p.x = w + 4;
      if (p.x > w + 4) p.x = -4;
      const alpha = p.a * (0.62 + 0.38 * Math.sin(p.tw));
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(6, 182, 212, ${alpha.toFixed(3)})`;
      ctx.fill();
    }
    frame = window.requestAnimationFrame(tick);
  }

  function startField() {
    if (running || reduceMotion || !el.canvas) return;
    running = true;
    sizeCanvas();
    if (!particle) particle = seedParticles();
    frame = window.requestAnimationFrame(tick);
  }

  function stopField() {
    running = false;
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
      frame = null;
    }
    const ctx = el.canvas && el.canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }

  // ---------- motion preference ----------
  // Both switches, and either one is enough: the OS setting (an accessibility
  // choice the app must not overrule) and the app's own Reduce motion setting
  // (which was saved and read by nothing until the lock screen needed it).
  function applyMotionPref() {
    const appSays = document.documentElement.getAttribute('data-motion') === 'reduced';
    reduceMotion = prefersReduced.matches || appSays;
    if (reduceMotion) stopField();
    else if (!el.screen || !el.screen.hidden) startField();
  }

  // ---------- activity ----------
  // Only while unlocked, and at most one send every five seconds: a drag or a
  // burst of typing is one IPC call. Main also counts a successful api-request as
  // activity, so the deadline moves even if this reporting stops.
  function sendActivity() {
    const now = Date.now();
    if (now - lastActivitySent < ACTIVITY_SEND_MS) return;
    lastActivitySent = now;
    window.electronAPI.authActivity().catch(() => {});
  }

  function bindActivity() {
    if (activityBound) return;
    activityBound = true;
    ['pointerdown', 'keydown', 'wheel', 'focus'].forEach((type) => {
      window.addEventListener(type, sendActivity, { passive: true });
    });
  }

  function unbindActivity() {
    if (!activityBound) return;
    activityBound = false;
    ['pointerdown', 'keydown', 'wheel', 'focus'].forEach((type) => {
      window.removeEventListener(type, sendActivity);
    });
  }

  // ---------- status line ----------
  function setStatus(text, kind) {
    if (!el.status) return;
    el.status.textContent = text || '';
    el.status.dataset.kind = kind || '';
  }

  function setBusy(busy) {
    if (el.submit) el.submit.disabled = busy;
    if (el.input) el.input.disabled = busy;
    if (el.screen) el.screen.classList.toggle('is-busy', busy);
  }

  // A throttle is a countdown the owner can watch, not a dead button. The brake
  // itself lives in main and survives a restart; this only draws what is left of
  // it, and re-enables the field when the wait is over.
  function startThrottle(ms) {
    if (throttleTimer) clearInterval(throttleTimer);
    let left = Math.ceil(ms / 1000);
    const draw = () => {
      if (left <= 0) {
        clearInterval(throttleTimer);
        throttleTimer = null;
        setBusy(false);
        setStatus('You can try again now.', '');
        return;
      }
      setBusy(true);
      setStatus(`Too many attempts. Try again in ${left}s.`, 'warn');
      left -= 1;
    };
    draw();
    throttleTimer = setInterval(draw, 1000);
  }

  function stopThrottle() {
    if (throttleTimer) {
      clearInterval(throttleTimer);
      throttleTimer = null;
    }
    setBusy(false);
  }

  // ---------- reveal ----------
  function setRevealed(on) {
    if (!el.input || !el.reveal) return;
    el.input.type = on ? 'text' : 'password';
    el.reveal.setAttribute('aria-pressed', String(on));
    const label = on ? 'Hide password' : 'Show password';
    el.reveal.setAttribute('aria-label', label);
    el.reveal.setAttribute('title', label);
  }

  // ---------- unlock ----------
  async function submit() {
    if (!el.input) return;
    const candidate = el.input.value;
    if (!candidate) {
      setStatus('Enter the owner password.', 'warn');
      el.input.focus();
      return;
    }
    setBusy(true);
    setStatus('Checking…', '');
    let reply;
    try {
      reply = await window.electronAPI.authUnlock(candidate);
    } catch (err) {
      // A rejection here is a real defect, not a verdict — the contract in
      // preload.js says a verdict resolves. Say so rather than blaming the
      // password for it.
      setBusy(false);
      setStatus(`Could not check the password: ${err.message}`, 'error');
      return;
    }
    if (reply && reply.ok) {
      el.input.value = '';
      hide();
      return;
    }
    setBusy(false);
    // Never leave the value in the field: a wrong password should not still be
    // sitting there, revealed or not.
    if (el.input) el.input.value = '';
    const code = reply && reply.code;
    if (code === 'THROTTLED') {
      startThrottle(reply.retryAfterMs || 30000);
      return;
    }
    if (code === 'LOCK_NOT_READY') {
      setStatus(reply.message || 'This build cannot read the saved app lock.', 'error');
      return;
    }
    const left = reply && typeof reply.attemptsLeft === 'number' ? reply.attemptsLeft : null;
    setStatus(`Wrong password.${left !== null ? ` ${left} attempt${left === 1 ? '' : 's'} left.` : ''}`, 'error');
    if (el.input) el.input.focus();
  }

  // ---------- show / hide ----------
  function show(reason) {
    if (!el.screen) return;
    el.screen.hidden = false;
    document.body.classList.add('locked');
    // The shell is inert, not merely covered: no tab stop, no click, no scroll
    // and no focus reaches anything under this screen.
    const shell = document.querySelector('.shell');
    if (shell) shell.setAttribute('inert', '');
    unbindActivity();
    if (reason === 'expired') {
      setStatus('Locked after a period of inactivity.', 'warn');
      if (el.sub) el.sub.textContent = 'Your session expired. Enter your owner password to continue.';
    } else if (reason === 'locked') {
      setStatus('', '');
      if (el.sub) el.sub.textContent = 'Signed out. Enter your owner password to continue.';
    } else {
      setStatus('', '');
      if (el.sub) el.sub.textContent = 'Enter your owner password to continue.';
    }
    applyMotionPref();
    if (el.input) {
      el.input.focus();
      // A programmatic focus on a hidden element is silently dropped, so the
      // caret is placed on the next frame, once the element is laid out.
      window.requestAnimationFrame(() => { try { el.input.focus(); } catch (_) {} });
    }
  }

  function hide() {
    if (!el.screen) return;
    stopThrottle();
    stopField();
    setStatus('', '');
    document.body.classList.remove('locked');
    const shell = document.querySelector('.shell');
    if (shell) shell.removeAttribute('inert');
    el.screen.hidden = true;
    bindActivity();
    if (typeof onUnlocked === 'function') onUnlocked();
    if (resolved) {
      const done = resolved;
      resolved = null;
      done({ ok: true });
    }
  }

  function bind() {
    el.form.addEventListener('submit', (e) => {
      e.preventDefault();
      submit();
    });
    el.reveal.addEventListener('click', () => {
      setRevealed(el.input.type === 'password');
    });
    window.addEventListener('resize', () => {
      if (running) {
        sizeCanvas();
        particle = null;
      }
    });
    // Losing focus stops the loop; coming back restarts it, so the field is not
    // dead after a minimize and is not animating in the background either.
    window.addEventListener('blur', stopField);
    window.addEventListener('focus', () => {
      if (!el.screen.hidden) startField();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopField();
      else if (!el.screen.hidden) startField();
    });
    if (prefersReduced.addEventListener) prefersReduced.addEventListener('change', applyMotionPref);
    // Main locked the app: the idle limit ended the session while a request was
    // being gated, or the owner asked from the profile menu. The screen comes
    // back with the reason it happened, rather than silently.
    window.electronAPI.onAuthLocked((reason) => {
      // Already up (the profile menu showed it optimistically): just keep it.
      if (!el.screen.hidden) return;
      show(reason === 'expired' ? 'expired' : 'locked');
    });
  }

  // app.js asks for status first, so a launch that is already unlocked never
  // shows this screen and never starts the canvas.
  function init(status) {
    el.screen = document.getElementById('lock-screen');
    el.canvas = document.getElementById('lock-canvas');
    el.form = document.getElementById('lock-form');
    el.input = document.getElementById('lock-password');
    el.submit = document.getElementById('lock-submit');
    el.status = document.getElementById('lock-status');
    el.reveal = document.getElementById('lock-reveal');
    el.note = document.getElementById('lock-note-text');
    el.sub = document.getElementById('lock-sub');

    if (el.note && status && status.idleMs > 0) {
      const minutes = Math.max(MIN_IDLE_MIN, Math.round(status.idleMs / 60000));
      el.note.textContent = `Sessions expire automatically after ${minutes} minutes idle; you will be asked to log in again.`;
    }
    bind();
    applyMotionPref();
    setRevealed(false);
    // A launch that is already unlocked — a page reload in development, which
    // re-runs app.js while main still holds the session — never shows the panel
    // and never starts the canvas.
    if (status && status.locked === false) {
      el.screen.hidden = true;
      document.body.classList.remove('locked');
      const shell = document.querySelector('.shell');
      if (shell) shell.removeAttribute('inert');
      bindActivity();
    } else {
      show('boot');
    }
    return status;
  }

  // Resolves once the password is accepted. A status read that failed resolves
  // { ok: false } so the app opens instead of bricking into an empty screen —
  // that path is logged by app.js, which is where the owner can see it.
  function waitForUnlock() {
    if (!el.screen || el.screen.hidden) return Promise.resolve({ ok: true });
    return new Promise((resolve) => { resolved = resolve; });
  }

  // Called by the lock screen itself once it is up, so app.js can continue
  // startup at the same moment the app becomes visible.
  function setOnUnlocked(fn) { onUnlocked = fn; }

  // The shell is inert from the first paint, before app.js has run, so a click
  // landing in the frame between the page parsing and lock.js loading cannot
  // reach a control. app.js re-applies it, and this covers the gap.
  const shellNow = document.querySelector('.shell');
  if (shellNow) shellNow.setAttribute('inert', '');
  document.body.classList.add('locked');

  window.LOCK = { init, waitForUnlock, setOnUnlocked, show, hide, submit };
})();
