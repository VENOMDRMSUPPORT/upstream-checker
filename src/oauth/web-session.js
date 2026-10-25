// ============================================
// OAuth — a provider that signs in on its own web page
// ============================================
// Some providers have no API key to paste. The person signs in on the
// provider's page, and the account's session is the credential.
//
// The page has to open in a window the app owns: no application can read
// another application's cookies, so a page signed in in the system browser
// could be a signed-in account the app can never use. Inside the app's own
// window it is the same page, the same login and the same account — and
// after that login everything is automatic. The person signs in; the app
// waits, takes the session, reads the account's usage and closes the window.
//
// The provider declares the page, the address that says "this person is
// signed in", the cookies that make up the session and how to reach the
// usage panel. main checks every field before it uses it, exactly as it
// does for the device grant.
//
// Nothing secret crosses to the renderer: the session is stored encrypted
// like every other key, and the renderer only ever sees the account's
// public facts and the usage text the panel shows.
const DEFAULT_WAIT_MS = 5 * 60 * 1000;
const DEFAULT_STEP_WAIT_MS = 8000;
const DIALOG_SELECTOR = '[role="dialog"],[aria-modal="true"]';

function originOf(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch (_) {
    return null;
  }
}

function httpsUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'https:' ? u.toString() : null;
  } catch (_) {
    return null;
  }
}

// The provider's declaration, checked.
function normalise(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  if (cfg.kind !== 'web') throw new Error('This provider does not sign in on a web page');
  const signInUrl = httpsUrl(cfg.signInUrl);
  if (!signInUrl) throw new Error('The provider did not declare a valid sign-in address');
  const sessionUrl = httpsUrl(cfg.sessionUrl);
  if (!sessionUrl) throw new Error('The provider did not declare a valid session address');
  const origin = originOf(signInUrl);
  // The session address has to be the provider's own: the app sends the
  // person's session nowhere else.
  if (originOf(sessionUrl) !== origin) {
    throw new Error('The provider asked to check the sign-in on another address — refused');
  }
  const cookieNames = Array.isArray(cfg.cookieNames)
    ? cfg.cookieNames.filter((n) => typeof n === 'string' && n.length > 0)
    : [];
  const usage = cfg.usage && typeof cfg.usage === 'object' ? cfg.usage : {};
  const steps = Array.isArray(usage.steps) ? usage.steps : [];
  return {
    kind: 'web',
    signInUrl,
    sessionUrl,
    origin,
    // The word the session answer carries when the person is really signed in.
    sessionMarker: typeof cfg.sessionMarker === 'string' ? cfg.sessionMarker : '',
    cookieNames,
    usage: { steps },
  };
}

// The sign-in window. It keeps its own partition, so the person stays signed
// in between runs and the app does not ask again.
function openWindow({ BrowserWindow, parent, config, providerId, title }) {
  const win = new BrowserWindow({
    width: 560,
    height: 820,
    parent: parent || undefined,
    title: title || 'Sign in',
    autoHideMenuBar: true,
    webPreferences: {
      partition: `persist:venom-oauth-${providerId}`,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  return win;
}

// A real mouse click on the page: some of these menus only open for a real
// click, and the coordinates come from the element's own text box so a
// wrapper never aims at the wrong row.
async function clickInPage(win, { selector, text }) {
  const js = `(() => {
    const visible = (e) => e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    let el = null;
    if (${selector ? JSON.stringify(selector) : 'null'}) {
      el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(visible) || null;
    }
    if (!el && ${text ? JSON.stringify(text) : 'null'}) {
      const wanted = ${JSON.stringify(text || '')};
      const all = [...document.querySelectorAll('*')];
      const visible = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
      let matches = all.filter((e) => visible(e) && (e.innerText || '').trim() === wanted);
      // A menu item may carry a shortcut suffix (SettingsCtrl+,), so a text
      // that starts with the wanted one counts too.
      if (!matches.length) {
        matches = all.filter((e) => visible(e) && (e.innerText || '').trim().startsWith(wanted));
      }
      const deep = matches.filter((e) => !matches.some((o) => o !== e && e.contains(o)));
      el = deep[0] || matches[0] || null;
    }
    if (!el) return null;
    let x = 0;
    let y = 0;
    if (${text ? JSON.stringify(text) : 'null'}) {
      // A text match: aim at the text itself, so a wrapper never sends the
      // click to the wrong row.
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = range.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      x = Math.round(r.left + r.width / 2);
      y = Math.round(r.top + r.height / 2);
    } else {
      // An icon has no text to aim at: aim at the element itself.
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      x = Math.round(r.left + r.width / 2);
      y = Math.round(r.top + r.height / 2);
    }
    return { x, y };
  })()`;
  const spot = await win.webContents.executeJavaScript(js);
  if (!spot) return false;
  win.webContents.sendInputEvent({ type: 'mouseMove', x: spot.x, y: spot.y });
  win.webContents.sendInputEvent({ type: 'mouseDown', x: spot.x, y: spot.y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: spot.x, y: spot.y, button: 'left', clickCount: 1 });
  return true;
}

// The text of the panel the steps opened.
async function readDialog(win) {
  const js = `(() => {
    const d = [...document.querySelectorAll(${JSON.stringify(DIALOG_SELECTOR)})]
      .find((e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden');
    return d ? (d.innerText || '') : '';
  })()`;
  return win.webContents.executeJavaScript(js);
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Wait until the provider says the person is signed in. The check runs inside
// the window, so it carries the window's own session.
async function waitForSession({ window: win, config, timeoutMs = DEFAULT_WAIT_MS, onTick }) {
  const deadline = Date.now() + timeoutMs;
  // The sign-in page names the account it is about to sign in (an address, a
  // phone number). It is the only place the app sees who this is, so it is
  // remembered on the way past.
  let emailOnPage = '';
  while (Date.now() < deadline) {
    if (win.isDestroyed()) return { ok: false, message: 'The sign-in window was closed' };
    if (!emailOnPage) {
      emailOnPage = await pageEmail(win);
    }
    const js = `(async () => {
      try {
        const res = await fetch(${JSON.stringify(config.sessionUrl)}, { credentials: 'include' });
        const text = await res.text();
        return { status: res.status, text: text.slice(0, 8000) };
      } catch (err) {
        return { status: 0, text: String((err && err.message) || err) };
      }
    })()`;
    let answer = null;
    try {
      answer = await win.webContents.executeJavaScript(js);
    } catch (_) {
      answer = null;
    }
    if (answer && answer.status === 200) {
      const marker = config.sessionMarker;
      if (!marker || (answer.text || '').includes(marker)) {
        return { ok: true, text: answer.text || '', email: emailOnPage };
      }
    }
    if (onTick) onTick(answer);
    await sleep(2000);
  }
  return { ok: false, message: 'The sign-in did not finish in time' };
}

// Walk the provider's steps and read the panel they open. The text is the
// provider's own — the provider module reads it, because only it knows what
// the words mean.
async function readUsage({ window: win, config }) {
  const steps = config.usage && config.usage.steps ? config.usage.steps : [];
  let text = '';
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    if (step.click || step.clickText) {
      const wait = Number(step.wait) > 0 ? Number(step.wait) : DEFAULT_STEP_WAIT_MS;
      const until = Date.now() + wait;
      let clicked = false;
      while (Date.now() < until && !clicked) {
        clicked = await clickInPage(win, { selector: step.click, text: step.clickText });
        if (!clicked) await sleep(400);
      }
      if (!clicked) return { ok: false, message: 'The account page did not open its settings' };
      await sleep(step.pause || 800);
      continue;
    }
    if (step.read === 'dialog') {
      const until = Date.now() + (Number(step.wait) > 0 ? Number(step.wait) : DEFAULT_STEP_WAIT_MS);
      while (Date.now() < until) {
        text = await readDialog(win);
        if (text) break;
        await sleep(400);
      }
    }
  }
  if (!text) return { ok: false, message: 'The account page did not show its usage' };
  return { ok: true, text };
}

// The session itself: the cookies the provider named, as one header value.
// They are a secret and are stored encrypted like any other key.
async function captureCookies({ window: win, config }) {
  let all = [];
  try {
    all = await win.webContents.session.cookies.get({ url: config.origin });
  } catch (_) {
    all = [];
  }
  const wanted = config.cookieNames;
  const picked = all.filter((c) => !wanted.length || wanted.includes(c.name));
  const jar = picked
    .filter((c) => c.value)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  if (!jar) return { ok: false, message: 'The sign-in left no session behind' };
  return { ok: true, jar, names: picked.map((c) => c.name) };
}

// The same session, put back into a window that was opened later (a usage
// refresh after the sign-in window is gone).
async function restoreCookies({ window: win, config, jar }) {
  const pairs = String(jar || '').split(';').map((p) => p.trim()).filter(Boolean);
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const name = pair.slice(0, at);
    const value = pair.slice(at + 1);
    try {
      await win.webContents.session.cookies.set({ url: config.origin, name, value, path: '/' });
    } catch (_) {
      // A cookie the store refuses is not fatal: the rest of the jar may be
      // enough for the session.
    }
  }
}

// The account the page is about to sign in, if it names one.
async function pageEmail(win) {
  try {
    const text = await win.webContents.executeJavaScript(`(document.body.innerText || '').slice(0, 4000)`);
    const found = String(text || '').match(/[\w.+-]+@[\w-]+\.[\w.-]{2,}/);
    return found ? found[0] : '';
  } catch (_) {
    return '';
  }
}

module.exports = {
  normalise,
  openWindow,
  waitForSession,
  readUsage,
  captureCookies,
  restoreCookies,
  clickInPage,
  readDialog,
  DEFAULT_WAIT_MS,
};
