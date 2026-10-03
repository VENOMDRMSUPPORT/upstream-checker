# App lock — design

Date: 2026-10-03
Status: awaiting owner review

## Goal

VENOM Router opens on a password screen. Nothing in the app — no page, no
provider, no key, no request — is reachable until the owner password is entered.
The screen is the app's front door, so it carries the brand: the emblem large,
animated, in cyan on black.

The password is a **local lock, not an account**. There is no server, no user
name, no recovery e-mail, and none of the app's data leaves the machine. This
document says plainly what the lock does and does not protect against.

## Decisions (made with the owner)

| Topic | Decision |
|---|---|
| When it locks | At every launch, and after **60 minutes** idle while open |
| Session expiry | The unlock lives in main memory only — a restart always asks again |
| Login-screen title bar | Drag, minimize, close. Settings, accent and theme buttons are removed while locked |
| Forgotten password | Documented recovery: delete the `app_lock` row. No in-app back door |
| Default password | `habiba77Hm`, shipped. Settings warns while it is unchanged; it is never forced |
| Lock screen colours | Cyan on black, always. Never follows `settings.theme` or `settings.accent` |
| Animation | CSS layers (grid, aurora, logo glow and orbit ring) **plus** a canvas particle field |
| Motion off | The existing **Reduce motion** setting is wired to it. It is currently saved but read by nothing |

## Threat model

Said here so nothing later over-claims.

**This protects against:** someone who sits at an unlocked machine and opens the
app; someone who does not know the password finding the app usable; a person
who has a copy of `venom.db` learning the password (the stored value is a salted
scrypt hash, and the default is not stored in a comparable form).

**This does not protect against:** an attacker with code execution as this
Windows user, who can read the renderer's memory, patch `src/main.js`, or read
`Local State`. It is not a substitute for a Windows account password or disk
encryption, and it does not make the stored API keys safer than DPAPI already
does — those are encrypted per-user on this machine either way.

**Not gated:** most IPC channels stay answerable while locked. The lock screen
is `inert` and covers the window, so there is no path in the UI to reach them,
but the honest statement is that the lock gates the window entrance and the two
channels that matter — `api-request` and `copy-key` — not every channel. Widening
that is a separate piece of work and is out of scope here.

## 1. Where the lock lives

The password never reaches the renderer as a value that can be compared, and the
lock state is never held by the renderer. The renderer sends a candidate **up**;
all authority is in main.

```
renderer/lock.js  ──auth:unlock(candidate)──▶  src/auth/ipc.js
                  ◀──{ ok, code, message }──   src/auth/index.js   (state, idle, throttle)
                                               src/auth/hash.js    (scrypt verify)
                                               src/db/repos/auth.js (app_lock row)
```

`src/auth/` follows the same rule as `src/db/`: **nothing in it loads electron.**
The cipher and `safeStorage` come in as arguments, so the whole module runs under
plain Node and is testable by `npm test`.

## 2. Data model — migration v4

Appended to `src/db/migrations.js`. Entries that have shipped are never edited,
and this one ships as version 4. `backupBeforeMigrate` already takes a
`venom.db.bak-v3` copy first, so a v3 database upgrades with a rollback copy on
disk.

```sql
CREATE TABLE app_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hash TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  changed_at INTEGER,
  created_at INTEGER NOT NULL
);
```

- **One row, enforced by the schema.** `CHECK (id = 1)` means the table can hold
  the lock and nothing else, so no code has to decide which row wins.
- **`is_default` is a column, not a comparison.** Answering "is this still the
  shipped password?" by deriving scrypt with the stored salt would cost a ~60 ms
  KDF on every status read. The flag is written at creation and cleared on change.
- **The row is written by `src/auth`, not by the migration.** Migrations are
  immutable once shipped; a password hash literal frozen inside one could never be
  changed. The migration creates the empty table and `ensureDefault()` writes the
  row when it is absent.
- **No row means the default password.** A fresh database, and a database just
  reset by the recovery script, both read as "locked with `habiba77Hm`".

**The hash is not wrapped in the `enc:v1:` DPAPI envelope.** Provider keys are,
because losing them is recoverable ("locked key", the UI says so). Losing the
lock hash is not — if `safeStorage` is unavailable, the app would be unopenable
with no way back in. A salted scrypt hash is the standard on-disk form for a
password and is safe to leave readable. This is a deliberate trade, not an
oversight.

## 3. `src/auth/hash.js`

```js
// Written into the string with the hash, so raising the cost later does not
// invalidate a password set today: an old string still verifies with its own
// parameters, and the next change re-hashes with the current ones.
//   scrypt$16384$8$1$<salt base64>$<hash base64>
const DEFAULT_PASSWORD = 'habiba77Hm'; // bootstrap value, not a secret: it is in this repo
```

- `hashPassword(password)` → `{ value, params }` with a fresh 16-byte salt and
  `N=16384, r=8, p=1, keylen=32`.
- `verifyPassword(password, stored)` → boolean. Parses the parameters **out of
  the stored string**, derives, and compares with `crypto.timingSafeEqual`.
  Returns `false` — never throws — on a malformed or truncated string.
- `DEFAULT_PASSWORD` carries a comment saying it is a published bootstrap value.
  Anyone can read it here, so it is not a secret and the code must not pretend
  otherwise. That is exactly why Settings warns until it is changed.

`node:crypto`'s `scrypt` is the only dependency. No `bcrypt`, no `argon2`, no new
package.

## 4. `src/auth/index.js`

`createAuthLock({ repo, log, idleMs })`.

**Session.** Unlock sets `session.token` in main memory and `lastActivity = now`.
Nothing is persisted, so a restart always asks again. The token is random and is
compared with `timingSafeEqual`.

**Idle is arithmetic, not a timer.** `isLocked()` is
`!session.token || Date.now() - lastActivity >= idleMs`. There is no interval to
clear, nothing to leak, and no path where a suspended timer leaves the app open.
`idleMs` defaults to `60 * 60 * 1000`.

**How `lastActivity` moves.** The renderer sends `auth:activity` on `pointerdown`,
`keydown`, `wheel` and window `focus` — bound only while unlocked. Main throttles
those to **at most one write every 5 s**, so a drag or a burst of keystrokes is
one send. A **successful `api-request` also counts as activity**, because the
gate there is main's own code and does not depend on the renderer having said
anything. If the renderer's activity reporting stops for any reason, the session
still expires rather than staying open forever.

**Throttling.** `failed_attempts` is persisted, so a lockout survives a restart —
closing and reopening the app is not a way around it.

- Five consecutive failures set `locked_until = now + 30_000`.
- While `locked_until` is in the future, `unlock` refuses **before running the
  KDF**: `{ ok: false, code: 'THROTTLED', retryAfterMs }`. Refusing early means a
  throttled guess costs no CPU, which is the point of a brake.
- A successful unlock clears `failed_attempts` back to 0.

**Two instances cannot disagree.** The derivation parameters are read from the
stored string, so an older and a newer build both verify the same password. If a
future change makes that untrue, `verifyPassword` failing to parse reports
`LOCK_NOT_READY` and the screen says so instead of claiming the password is wrong.

### IPC surface (`src/auth/ipc.js`)

Every `auth:*` reply **resolves** and is `{ ok: true, ... }` or
`{ ok: false, code, message }` — the contract `src/preload.js` already states for
`catalog:*`, because `err.code` cannot cross a rejection.

| Channel | In | Out |
|---|---|---|
| `auth:status` | — | `{ ok, locked, isDefault, idleMs }` |
| `auth:unlock` | `candidate` | `{ ok }` / `WRONG_PASSWORD` (+`attemptsLeft`) / `THROTTLED` (+`retryAfterMs`) / `LOCK_NOT_READY` |
| `auth:change` | `current, next` | `{ ok, isDefault: false }` / `WRONG_PASSWORD` / `WEAK_PASSWORD` / `THROTTLED` |
| `auth:lock` | — | `{ ok }`, and broadcasts `auth:locked` to the window |
| `auth:activity` | — | `{ ok }`, throttled |

`LOCKED` is added to the outcome vocabulary of `api-request`: a request made while
locked resolves `{ outcome: 'locked', error: '…' }` and **is not recorded in the
request log**, because nothing was sent for a log row to describe.

Runtime invariant: `hash.js` has no state, so two `createAuthLock` instances
cannot disagree about an ordinary password — only about the in-memory session.

## 5. Main wiring (`src/main.js`)

- Built once, right after `startDatabase()` succeeds and before the window:
  `auth = createAuthLock({ repo: store.repos.auth, log, idleMs: from settings })`.
- `ensureDefault()` runs there — the default row is written on the first launch
  after the migration and on the first launch after a reset.
- `api-request` is wrapped: `if (auth.isLocked()) return { outcome: 'locked', … }`.
  `copy-key` likewise refuses. Both channels exist regardless of what the UI shows.
- `window-close`, `window-minimize` and the flush handshake are untouched.
- The idle limit is a new setting (`lockIdleMin`, default `60`) read at this point
  and re-read on every `save-settings`, like `logSettings` already is.

## 6. Lock screen

### Markup and stacking

`<section id="lock-screen">` is the last child of `<body>`, `position: fixed;
inset: 0; z-index: 10000` — above `.modal-overlay` (9999), so a modal that was
open when the app locked is covered by the lock, not on top of it.

`<main class="shell">` takes the **`inert`** attribute while locked. That is the
mechanism that makes the screen real: no tab stop, no scroll, no click, no
focus reaches anything underneath. It is removed on unlock. `aria-hidden` is not
used — `inert` already removes the subtree from the accessibility tree, and
setting both is noise.

### Colours are hard-coded and cannot follow the app

The screen declares its own values on the section, not on `:root`:

```css
#lock-screen {
  --lock-accent: #06b6d4;
  --lock-accent-dim: #0891b2;
  --lock-bg: #000000;
}
```

It therefore does not read `--accent`, `--bg-*` or `[data-theme]`. Changing
theme or accent in Settings changes the app and leaves this screen exactly as it
is — the requirement is met by construction rather than by remembering to opt out.

### Layout

Centred column: emblem, wordmark, one line of copy, the password field, the
button, a status line. `LOCAL CONTROL PLANE` above the wordmark, in the same
letter-spaced mono capitals the title bar uses.

The field is a real `<form>`, so Enter submits without extra key handling. It
uses the existing `--field-*` tokens and the search/eye affordance pattern from
`ui-select.js`; the reveal button is `aria-pressed`, not a checkbox.

### The logo

`--lock-emblem-size: 176px`, in the same css-var-first style as every other
sizing rule in `styles.css`, with a smaller value under a `max-height` media
query so a 1000×700 window does not push the button off screen.

Source: a new **`src/assets/brand/emblem-cyan-512.png`**, generated by
`scripts/generate-icons.js` the same way `icon-512.png` already is (lanczos3 from
`assets-src/brand/emblem-cyan.png`). The shipped emblems are 256 px and would be
soft at 176 px on a 2x display. This follows the repo's rule that images are
generated by that one script rather than hand-placed in `src/assets`.

### Animation

Three CSS layers behind the panel, one canvas, and the emblem itself.

**CSS, all `transform`/`opacity` only** — nothing here animates a layout
property, so the compositor does the work:

- **Grid** — a repeating-linear-gradient plane at `perspective`, drifting on
  `translate3d` over ~40 s.
- **Aurora** — two large radial-gradient blooms in cyan, counter-drifting and
  breathing over ~18 s with a slight `blur`.
- **Orbit ring** — a `conic-gradient` sweep masked to a ring, rotating 8 s, sitting
  behind the emblem.
- **Emblem** — a glow `drop-shadow` pulse (3 s) plus a 6 s scale "breath" between
  1.0 and 1.03, and a slow cyan sheen crossing it.

**Canvas particles** — `src/renderer/lock.js`, ~80 lines, no dependency: 60 cyan
motes with slight upward drift, wrapped at the edges, drawn at a device-pixel
ratio capped at 2. `matchMedia('(prefers-reduced-motion: reduce)')` and the
**Reduce motion** setting both stop the loop.

The loop is the part that can go wrong, so it is bounded explicitly:

- `requestAnimationFrame` is cancelled when the screen is hidden, when the window
  is blurred, and after a successful unlock.
- It **starts only after a successful `auth:status` reporting `locked: true`**, so
  an unlocked launch never pays for it.
- A `document.visibilitychange` listener restarts it on the way back, so the field
  is not dead after a minimize.
- Guarded by a module-level `running` flag, so two calls cannot start two loops.

### Title bar while locked

`#btn-settings`, `#btn-accent` and `#btn-theme-toggle` get `disabled` + `hidden`
via a `body.locked` class. Drag, minimize and close stay live. Close must stay:
the window is frameless, so removing it would leave Alt+F4 as the only way out,
which is a trap rather than a feature.

### Reveal transition

The lock screen goes to `opacity: 0; scale: 1.02` and then `hidden` on success;
the app is un-`inert`-ed at the same moment. Under `prefers-reduced-motion` the
transition is dropped, not the state change.

## 7. In-app settings

A new `Secure` zone in Settings, following the existing settings-row markup:

| Row | Control |
|---|---|
| App lock | Current password / New password / Confirm, and a Change button |
| Lock after | Stepper, minutes, 5–480, saved as `lockIdleMin` |
| Lock now | Button → `auth:lock` |

While `isDefault` is true, a warning row sits above them:

> This app is still using the password it shipped with. Anyone who has read the
> VENOM Router source knows it. Change it here.

The warning is informational. It does not block, and it is not a modal. Clearing
it is done by changing the password; nothing else dismisses it.

`auth:change` refuses `''`, anything shorter than 8 characters, and a new value
equal to the current one (`WEAK_PASSWORD`), because the point of the row is to
leave the shipped default behind.

## 8. Renderer boot sequencing

The app's `init()` in `src/renderer/app.js` does real work on load: `readConfig`,
providers, history, and `window.CATALOG.init()`. If the lock is on, that work is
wasted, and worse, it runs before the owner has proved they may see it.

`start()` becomes a gate:

```js
async function start() {
  const state = await window.electronAPI.authStatus();   // resolves; never rejects
  window.LOCK.init(state);                               // shows the panel, starts the canvas
  const { ok } = await window.LOCK.waitForUnlock();      // resolves once unlocked
  if (!ok) return;                                       // the status call itself failed
  try { await init(); } catch (err) { console.error('Startup failed:', err); }
}
```

`src/renderer/lock.js` is loaded **before** `app.js` in `index.html`, and exposes
`window.LOCK` with `init`, `waitForUnlock`, `show`, `hide`. If `authStatus()`
fails, `waitForUnlock()` resolves `{ ok: false }` and `init()` still runs — a
broken lock must not brick the app into an empty screen, and it must not be
mistaken for a security decision either. The failure is logged and the app opens.

The renderer's dev CSS watcher is unaffected: it reloads a stylesheet, not the
page. A full page reload (any `.js`/`.html` save in dev) re-runs `start()`, which
asks `auth:status` again — and since the session lives in main, an unlocked page
reload does not re-prompt. That is correct: reloading is not a new launch.

## 9. Failure modes

| Situation | Behaviour |
|---|---|
| No `app_lock` row | Default password applies, `isDefault: true` |
| Database missing / damaged | `startDatabase()` already refuses to start and says so. Unchanged |
| `safeStorage` unavailable | No effect on the lock — the hash is not DPAPI-wrapped |
| `auth:status` fails at boot | Logged, app opens, lock is not enforced. Never silent |
| Tampered `hash` string | `verifyPassword` returns false; the screen reports the password is wrong, and `LOCK_NOT_READY` if the string cannot be parsed at all |
| Renderer killed while locked | Nothing to recover — the session was never in the renderer |
| Window closed while locked | Normal flush handshake, then close |

## 10. Recovery

`scripts/reset-lock.mjs`, run as `npm run reset:lock -- "<data-dir>"`.

- The folder is an **explicit argument with no default**, so the owner's real
  `%APPDATA%\venom-router` can never be the implicit target of a bare command.
- It prints the resolved path and what it is about to do, then `DELETE FROM
  app_lock` — one row, in one table. Providers, keys, history, logs and settings
  are not touched.
- The next launch sees no row and re-creates the default, which is `habiba77Hm`.

This is a documented recovery, not a back door: it needs filesystem access to the
data folder, which already implies the ability to do anything to this app.

## 11. Testing

**Unit (`npm test`)** — plain Node, no Electron:

- `test/auth/hash.test.js` — round-trip; wrong password; a stored string with
  different parameters still verifies; truncated/garbage/HMAC-shaped strings
  return `false` rather than throwing; two hashes of the same password differ
  (salt); `timingSafeEqual` is used on equal-length buffers.
- `test/auth/lock.test.js` — default is locked on a fresh repo; the right password
  unlocks; the wrong one does not; the default stops working after a change; five
  failures throttle and the sixth is refused with `retryAfterMs`; a throttle
  survives closing and reopening the repo; `isLocked()` flips once `idleMs` has
  passed since the last activity; `auth:activity` moves it back; a failed unlock
  does not count as activity; `auth:lock` clears the session.
- `test/db/auth-repo.test.js` — `ensureDefault` writes exactly one row; `CHECK
  (id = 1)` rejects a second; delete-then-read resolves back to the default.
- `test/db/open.test.js` (extended) — a v3 database migrates to v4, gets a
  `venom.db.bak-v3`, and comes out with an empty `app_lock`.
- `test/main-wiring.test.js` (extended) — the static check that main registers the
  auth channels. This file already exists for exactly this purpose.

**Live (`npm run verify:lock`)** — `scripts/live/verify-lock.mjs`, driving the
app over CDP on a scratch data folder via `scripts/live/cdp.mjs`, which refuses
any path inside `%APPDATA%`.

A scratch run has **no providers and an empty database**. That is expected, not a
broken build.

It asserts by **measured geometry**, not `textContent` — the repo has already
been burned once by a check that read text and passed while a drawer never
appeared:

1. `#lock-screen`'s bounding rect covers the viewport (`width`/`height` within 1px
   of `innerWidth`/`innerHeight`, `x`/`y` at 0).
2. The emblem's rendered `offsetWidth` is ≥ 160 px **and** its computed
   `background-image` resolves to a URL containing `emblem-cyan` — proof it is
   large *and* that it is the cyan artwork, not whichever accent is set.
3. `.shell` reports `inert === true`, and `document.activeElement` is not inside
   it.
4. Computed `background-color` of the screen is the locked black, and the button's
   accent is cyan — with `data-accent="violet"` and `data-theme="daylight"` forced
   on `<html>` first, to prove the screen ignores both.
5. A wrong password leaves it locked; the right one removes it and `.shell`'s
   `inert` goes back to false.
6. `window.LOCK` exposes no way to read the stored hash or the session token.
7. A screenshot of the locked state is written to the scratch folder.

**Also run:** `npm run check` — `repo-map.mjs --check` fails on an unregistered
source file, so `docs/CODE_MAP.md` must be updated in the same change.

## 12. Out of scope

- Gating every IPC channel. Only `api-request` and `copy-key` are refused.
- Any second factor, biometric, or OS keychain integration.
- Encrypting the database with the password. The password unlocks the window; it
  does not become a key. That would change how `venom.db` is read and is its own
  design.
- Per-page or per-provider locks.
- A user name, multiple accounts, or anything account-shaped.

## 13. Files

**New**

| File | Purpose |
|---|---|
| `src/db/repos/auth.js` | The `app_lock` row — read, ensureDefault, change, counters |
| `src/auth/hash.js` | scrypt hash and verify, `DEFAULT_PASSWORD` |
| `src/auth/index.js` | Session, idle, throttle, `isLocked()` |
| `src/auth/ipc.js` | The five `auth:*` channels |
| `src/renderer/lock.js` | Lock panel, canvas field, `window.LOCK` |
| `src/assets/brand/emblem-cyan-512.png` | Generated, not hand-placed |
| `scripts/reset-lock.mjs` | Documented recovery |
| `scripts/live/verify-lock.mjs` | Geometry-based live gate |
| `test/auth/hash.test.js`, `test/auth/lock.test.js`, `test/db/auth-repo.test.js` | Unit |

**Modified**

| File | Change |
|---|---|
| `src/db/migrations.js` | Migration v4 |
| `src/db/index.js` | `repos.auth` |
| `src/main.js` | Auth wiring, the two gates, idle re-read |
| `src/preload.js` | `auth*` API |
| `src/renderer/index.html` | `#lock-screen`, `lock.js` before `app.js` |
| `src/renderer/styles.css` | Lock styles + `--lock-emblem-size` |
| `src/renderer/app.js` | Gated `start()`, Secure settings zone, Reduce motion wired |
| `scripts/generate-icons.js` | The 512 cyan emblem |
| `package.json` | `reset:lock`, `verify:lock` |
| `docs/CODE_MAP.md`, `docs/ARCHITECTURE.md` | Required by `npm run check` |
| `CHANGELOG.md` | The release note |

## 14. What the owner will see

`npm start` in `C:\Users\venom\Desktop\UPSTREAM CHECKER` — the same command and
the same data folder — now opens on the lock screen. Enter `habiba77Hm` and the
app is exactly as it was today. This is the behaviour that was asked for, and it
changes the first thing the app shows, so it is stated here rather than found.
