// Something the owner can click — proven two ways, on a scratch data folder.
//
//   npm run verify:catalog      (or: node scripts/live/verify-catalog-boot.mjs)
//
// Session 1 boots the app THROUGH THE THROWING NETWORK GUARD
// (scripts/live/boot-guard.cjs), opens Settings and then Settings › Catalog, and
// fails if a single byte tried to leave the process. That is the whole of the
// owner's first safety rule: the app may read its cache at boot and draw four
// lines, and the first upstream fetch must be a click.
//
// Session 2 boots the same folder without the guard and presses the button, so
// the four lines are reported as they really land.
//
// MOCK-PROVIDER RUN, AND IT MATTERS: the app's own provider traffic goes to
// localhost, and the scratch folder starts empty — no providers, no keys, empty
// database. What Session 2 does fetch is the four PUBLIC upstream documents
// (models.dev, OpenRouter, LMArena), because that is what the button is for; they
// are not the owner's providers and no key is involved. This proves wiring, boot
// and the owner-visible block — never a provider and never a real key.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, assertScratchDir } from './cdp.mjs';

const PORT = 9345;
let failures = 0;
function check(name, cond, detail = '') {
  if (!cond) failures += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The window is up and Settings can be opened. The catalog plane's globals are not
// needed here, so this waits on the shell, not on a provider list.
const READY = "!!window.electronAPI && !!document.querySelector('.shell-nav-item[data-page=settings]')";

// Opens Settings, then the Catalog section, then measures. `hasBlock` is reported
// rather than assumed so this script can run before and after the markup lands.
async function openCatalogAndRead(app) {
  return app.evaluate(`(async () => {
    const wait = async (fn, ms = 20000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { try { if (fn()) return true; } catch (_) {} await new Promise((r) => setTimeout(r, 120)); }
      return false;
    };
    // The shell nav is in the static HTML, so it exists before app.js has bound
    // its click handlers; a first click that lands too early does nothing at all
    // and the section stays hidden. Retry rather than assume — the run used to
    // report a FAIL that was this race, not the app.
    let nav = false; let tab = false; let opened = false;
    for (let attempt = 0; attempt < 4 && !opened; attempt += 1) {
      const shell = document.querySelector('.shell-nav-item[data-page=settings]');
      if (shell) shell.click();
      nav = await wait(() => !!document.querySelector('#settings-nav'), 15000);
      tab = await wait(() => !!document.querySelector('#settings-nav .settings-nav-item[data-section="sec-catalog"]'), 15000);
      if (tab) document.querySelector('#settings-nav .settings-nav-item[data-section="sec-catalog"]').click();
      opened = await wait(() => !document.getElementById('sec-catalog').hidden, 5000);
      if (!opened) await new Promise((r) => setTimeout(r, 400));
    }
    // Wait BEFORE reading the row list: the block fills in asynchronously, and a
    // NodeList captured first is a snapshot of the empty container.
    const filled = await wait(() => {
      const el = document.getElementById('catalog-sources-status');
      const rows = el ? [...el.querySelectorAll('.mc-source')] : [];
      return rows.length > 0 && rows.some((r) => /\\S/.test(r.textContent));
    }, 20000);
    const el = document.getElementById('catalog-sources-status');
    const button = document.getElementById('btn-catalog-sync-sources');
    const rows = el ? [...el.querySelectorAll('.mc-source')] : [];
    return {
      nav, tab, opened, filled,
      pageVisible: !document.querySelector('.page-settings').hidden,
      theme: document.documentElement.getAttribute('data-theme'),
      hasBlock: !!el,
      containerText: el ? el.textContent.trim() : '',
      headText: el && el.querySelector('.mc-sources-head') ? el.querySelector('.mc-sources-head').textContent.trim() : '',
      rowCount: rows.length,
      rowText: rows.map((r) => r.textContent.trim().replace(/\\s+/g, ' ')),
      rowCounts: rows.map((r) => {
        const cells = [...r.children].map((c) => c.textContent.trim());
        return cells[0] + '=' + cells[1] + ' @ ' + cells[2];
      }),
      rowClass: rows.map((r) => r.className),
      button: button ? { text: button.textContent.trim(), disabled: button.disabled,
        rect: button.getBoundingClientRect().toJSON() } : null,
    };
  })()`, 60000);
}

// F6 without any network at all: the two sentences the block can now show, read
// straight out of the renderer's own helpers. `ipcMessage` is what a rejection
// looks like after Electron wrapped it, and `catalogSourceFailure` is what main's
// resolved `{ok:false, code}` becomes once it has been turned into words. Both are
// top-level functions in a classic script, so the page can be asked directly.
async function checkFailureWords(app) {
  return app.evaluate(`(() => {
    const wrapped = "Error invoking remote method 'catalog:sources': Error: sync already in progress";
    return {
      raw: new Error(wrapped).message,
      stripped: ipcMessage(new Error(wrapped)),
      running: catalogSourceFailure({ ok: false, code: "SYNC_IN_PROGRESS", message: "sync already in progress" }, null),
      unknown: catalogSourceFailure({ ok: false, code: "PROVIDER_UNAVAILABLE", message: "no provider nara" }, null),
    };
  })()`, 20000);
}

// The Models Catalog page is not this task's page: it still runs on its own path,
// and it owns a `<p class="mc-source">` line whose CSS must not have moved.
async function checkModelsCatalogPageUntouched(app) {
  return app.evaluate(`(async () => {
    document.querySelector('.shell-nav-item[data-page="catalog"]').click();
    const wait = async (fn, ms = 15000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { try { if (fn()) return true; } catch (_) {} await new Promise((r) => setTimeout(r, 120)); }
      return false;
    };
    const shown = await wait(() => !document.querySelector('.page-catalog').hidden);
    const probe = document.createElement('p');
    probe.className = 'mc-source';
    document.querySelector('.page-catalog').append(probe);
    const cs = getComputedStyle(probe);
    const drawerStyle = { fontSize: cs.fontSize, color: cs.color, marginTop: cs.marginTop, display: cs.display };
    probe.remove();
    return {
      shown,
      title: document.querySelector('#shell-page-title') ? document.querySelector('#shell-page-title').textContent : '',
      hasSourcesBlock: !!document.querySelector('.page-catalog .mc-sources'),
      toolbar: !!document.querySelector('.page-catalog .mc-toolbar, .page-catalog .dt-toolbar'),
      drawerStyle,
    };
  })()`, 30000);
}

// The geometry gate: textContent proves text exists, not that a person can see it.
// Every row must have area, must be inside the section it belongs to, must be
// scrollable to within the viewport, and must not be clipped by its own box.
async function measureCatalog(app) {
  return app.evaluate(`(async () => {
    const el = document.getElementById('catalog-sources-status');
    if (!el) return { absent: true };
    const theme = document.documentElement.getAttribute('data-theme');
    const page = document.querySelector('.page-settings');
    const section = document.getElementById('sec-catalog');
    const sectionBox = section.getBoundingClientRect();
    const rows = [...el.querySelectorAll('.mc-source')];
    el.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 250));
    const view = (node) => { const b = node.getBoundingClientRect(); return { top: Math.round(b.top), left: Math.round(b.left),
      w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom) }; };
    const box = view(el);
    const inside = (b) => b.top >= sectionBox.top - 1 && b.bottom <= sectionBox.bottom + 1;
    const list = rows.map((row) => {
      const b = view(row);
      const cs = getComputedStyle(row);
      const number = row.querySelector('b');
      return {
        text: row.textContent.trim().replace(/\\s+/g, ' '),
        box: b,
        painted: b.h > 8 && b.w > 40,
        clippedByItself: row.scrollHeight > row.clientHeight + 1,
        insideSection: inside(b),
        inViewport: b.top >= 0 && b.bottom <= window.innerHeight,
        display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
        numberColor: number ? getComputedStyle(number).color : null,
        textColor: cs.color,
      };
    });
    return {
      theme, box, viewportH: window.innerHeight,
      containerClipped: el.scrollHeight > el.clientHeight + 1,
      containerPainted: box.h > 8 && box.w > 40,
      insideSection: inside(box),
      head: el.querySelector('.mc-sources-head') ? el.querySelector('.mc-sources-head').textContent.trim() : '',
      rows: list,
    };
  })()`, 30000);
}

async function runGuardedSession(dir, report) {
  console.log('\n--- session 1: boot and Settings under a throwing network guard ---');
  process.env.BOOT_GUARD_REPORT = report;
  const app = await launch({ userDataDir: dir, port: PORT, entry: 'scripts/live/boot-guard.cjs' });
  try {
    await app.waitFor(READY, 40000);
    check('the app booted under the guard', true);
    const s = await openCatalogAndRead(app);
    check('Settings › Catalog opened', s.nav && s.tab && s.opened, JSON.stringify(s).slice(0, 120));
    check('the sources block is in the page', s.hasBlock, s.containerText.slice(0, 90));
    if (s.hasBlock) {
      check('it reports four sources', s.rowCount === 4, `${s.rowCount} rows: ${s.rowCounts.join(' | ')}`);
      for (const row of s.rowCounts) console.log(`      row: ${row}`);
      const dark = await measureCatalog(app);
      await app.evaluate(`(async () => {
        settings.theme = 'daylight'; settings.followSystem = false; saveAppearance();
        await new Promise((r) => setTimeout(r, 350));
        return document.documentElement.getAttribute('data-theme');
      })()`);
      const light = await measureCatalog(app);
      // Back to what the app booted with, so session 2 starts from the default.
      await app.evaluate(`(async () => {
        settings.theme = ${JSON.stringify(s.theme)}; settings.followSystem = false; saveAppearance();
        await new Promise((r) => setTimeout(r, 200));
        return true;
      })()`);
      for (const [label, m] of [['dark', dark], ['light', light]]) {
        check(`[${label}] the block has area (${m.theme})`, m.containerPainted, JSON.stringify(m.box));
        check(`[${label}] four rows are each painted and not clipped`,
          m.rows.length === 4 && m.rows.every((r) => r.painted && !r.clippedByItself && r.display !== 'none' && r.visibility === 'visible'),
          m.rows.map((r) => `${r.text.slice(0, 22)}=${r.box.w}x${r.box.h}`).join(' | '));
        check(`[${label}] every row sits inside its section and inside the viewport`,
          m.rows.every((r) => r.insideSection && r.inViewport),
          m.rows.map((r) => `top${r.box.top}/bottom${r.box.bottom} of ${m.viewportH}`).join(' | '));
        check(`[${label}] the row counts are coloured, not invisible`,
          m.rows.every((r) => r.numberColor && r.numberColor !== 'rgba(0, 0, 0, 0)'),
          m.rows.map((r) => `${r.text.split(' ')[0]}=${r.numberColor}`).join(' | '));
        check(`[${label}] the container itself is not scrolled away`, !m.containerClipped,
          `scrollHeight ${m.box.h} visible ${m.box.h}`);
      }
      check('the button is there, enabled and labelled',
        !!s.button && !s.button.disabled && /Sync sources/.test(s.button.text)
        && s.button.rect.height > 8 && s.button.rect.width > 40,
        s.button ? `${s.button.text} ${Math.round(s.button.rect.width)}x${Math.round(s.button.rect.height)} disabled=${s.button.disabled}` : 'missing');
      // F6, the half that needs no network: the owner reads the reason, never the
      // plumbing, and a refused sync has a sentence of its own.
      const words = await checkFailureWords(app);
      check("Electron's wrapper never reaches the owner",
        words.stripped === 'sync already in progress' && /^Error invoking remote method/.test(words.raw),
        `"${words.raw}" -> "${words.stripped}"`);
      check('a sync already running says so instead of looking like a no-op',
        /already running/i.test(words.running), words.running);
      check('an outcome with no sentence of its own still says what happened',
        /Sync failed/.test(words.unknown) && /no provider nara/.test(words.unknown), words.unknown);
      // Constraint: no page other than Settings › Catalog changed.
      const mc = await checkModelsCatalogPageUntouched(app);
      check('the Models Catalog page still opens on its own path', mc.shown && !mc.hasSourcesBlock,
        `title="${mc.title}" toolbar=${mc.toolbar} .mc-sources inside it=${mc.hasSourcesBlock}`);
      check('its .mc-source line keeps the CSS it has always had',
        mc.drawerStyle.fontSize === '10.5px' && mc.drawerStyle.marginTop === '10px'
        && mc.drawerStyle.display === 'block',
        JSON.stringify(mc.drawerStyle));
    }
    const closedCode = await app.close();
    check('the guarded app exited with code 0', closedCode === 0, String(closedCode));
  } finally {
    await app.close().catch(() => {});
  }
  const text = existsSync(report) ? readFileSync(report, 'utf8') : '(no report written)';
  const blocked = text.split('\n').filter((line) => line.startsWith('BLOCKED'));
  check('zero bytes asked to leave the app through boot, Settings and Catalog',
    blocked.length === 0 && /exit: 0 network attempt/.test(text),
    `${blocked.length} blocked attempt(s); ${text.split('\n').pop()}`);
  if (blocked.length) console.log(blocked.join('\n'));
  return blocked.length === 0;
}

// "Nothing tried to leave" is only worth something if the guard bites when
// something does. This asks for the one thing boot never asks for — a forced
// source sync — and requires the guard to have caught it. Re-launching the guard
// rewrites the report from zero, so any BLOCKED line here is this call's.
async function runPositiveControl(dir, report) {
  console.log('\n--- positive control: the guard must bite when a sync IS asked for ---');
  const app = await launch({ userDataDir: dir, port: PORT + 2, entry: 'scripts/live/boot-guard.cjs' });
  try {
    await app.waitFor(READY, 40000);
    const outcome = await app.evaluate(`(async () => {
      try { const r = await window.electronAPI.catalogSources({ force: true }); return { ok: true, r }; }
      catch (err) { return { ok: false, message: err.message }; }
    })()`, 120000);
    await sleep(1500);
    const text = existsSync(report) ? readFileSync(report, 'utf8') : '';
    const blocked = text.split('\n').filter((line) => line.startsWith('BLOCKED'));
    check('catalogSources({force:true}) through the guard was caught, not allowed',
      blocked.length > 0, `${blocked.length} blocked line(s); channel said ${JSON.stringify(outcome).slice(0, 120)}`);
    if (blocked.length) console.log(`      ${blocked[0]}`);
    check('the cache folder was still not written by a refused sync',
      !existsSync(join(dir, 'catalog-cache')), 'a blocked fetch stores nothing');
  } finally {
    await app.close().catch(() => {});
  }
}

async function runSyncedSession(dir) {
  console.log('\n--- session 2: the same folder, and the button really pressed ---');
  const app = await launch({ userDataDir: dir, port: PORT + 1 });
  try {
    await app.waitFor(READY, 40000);
    const before = await openCatalogAndRead(app);
    check('the block rendered before anything was clicked', before.hasBlock && before.rowCount === 4,
      `opened=${before.opened} filled=${before.filled} pageVisible=${before.pageVisible} :: ${before.rowCounts.join(' | ')}`);
    // F5 and F6, end to end over the real channel and with one network pass, not
    // two. A sync is started through `catalogSources` and, while its four documents
    // are in flight, the owner presses the button. Main must ANSWER that click as
    // data — `{ok:false, code:"SYNC_IN_PROGRESS"}`, which is what can cross an
    // `ipcMain.handle` at all — and the block must say so in its own words, painted,
    // with the button clickable again. The rows then fill from the sync that was
    // already running; nothing here fetched twice.
    const clicked = await app.evaluate(`(async () => {
      const button = document.getElementById('btn-catalog-sync-sources');
      const block = () => document.getElementById('catalog-sources-status');
      const wait = async (fn, ms) => {
        const end = Date.now() + ms;
        while (Date.now() < end) { try { if (fn()) return true; } catch (_) {} await new Promise((r) => setTimeout(r, 250)); }
        return false;
      };
      const inFlight = window.electronAPI.catalogSources({ force: true });
      let answeredAsData = null;
      inFlight.then((r) => { answeredAsData = !(r && r.ok === false); }).catch(() => { answeredAsData = false; });
      await new Promise((r) => setTimeout(r, 400));
      button.click();
      const told = await wait(() => !!block().querySelector('.mc-sources-error') && !button.disabled, 30000);
      const notice = block().querySelector('.mc-sources-error');
      // Read every property NOW: the block is redrawn below, and a detached node
      // keeps its textContent while getComputedStyle and getBoundingClientRect go
      // empty — which would fail this check for a reason that is not the app's.
      const noticeBox = notice ? notice.getBoundingClientRect() : null;
      const noticeRead = notice ? {
        text: notice.textContent.trim(),
        color: getComputedStyle(notice).color,
        w: Math.round(noticeBox.width), h: Math.round(noticeBox.height),
      } : null;
      const summary = await inFlight;
      await renderCatalogSources();
      const filled = await wait(() => {
        const rows = [...block().querySelectorAll('.mc-source')];
        return rows.length === 4 && rows.some((r) => /\\d{2,}/.test(r.textContent));
      }, 240000);
      const rows = [...block().querySelectorAll('.mc-source')];
      return { told, answeredAsData, summaryOk: !(summary && summary.ok === false),
        syncs: summary && summary.sources ? summary.sources.filter((s) => s.rowCount > 0).length : 0,
        notice: noticeRead ? noticeRead.text : '',
        noticePainted: !!noticeRead && noticeRead.h > 8 && noticeRead.w > 40,
        noticeColor: noticeRead ? noticeRead.color : null,
        disabled: button.disabled, changed: filled, buttonCleared: !block().querySelector('.mc-sources-error'),
        head: block().querySelector('.mc-sources-head') ? block().querySelector('.mc-sources-head').textContent.trim() : '',
        rows: rows.map((r) => r.textContent.trim().replace(/\\s+/g, ' ')),
        tones: rows.map((r) => r.className),
        counts: rows.map((r) => (r.querySelector('b') || {}).textContent),
      };
    })()`, 300000);
    check('a press during a running sync was answered, not swallowed', clicked.told && clicked.summaryOk,
      `the sync answered as data=${clicked.answeredAsData}; block said "${clicked.notice}"`);
    check('and it said a sync is already running, in painted words',
      /already running/i.test(clicked.notice) && clicked.noticePainted && !!clicked.noticeColor,
      `${clicked.notice} -> ${JSON.stringify(clicked.noticeColor)}`);
    check('the notice went away on its own once the sync had landed',
      clicked.buttonCleared && clicked.disabled === false);
    check('the button filled all four rows', clicked.changed, clicked.rows.join(' | '));
    check('the button re-enabled itself', clicked.disabled === false);
    console.log(`\n      ${clicked.head}`);
    clicked.rows.forEach((row, i) => console.log(`      [${i + 1}] ${row}   (${clicked.tones[i]})`));
    console.log(`      cells: ${clicked.counts.join(' , ')}`);
    const after = await measureCatalog(app);
    check('the rows are still painted after syncing',
      after.rows.length === 4 && after.rows.every((r) => r.painted && !r.clippedByItself),
      after.rows.map((r) => `${r.box.w}x${r.box.h}`).join(' | '));
    check('no key or secret appears anywhere in the block',
      !/sk-|Bearer|venomsecret/.test(clicked.rows.join(' ') + clicked.head));
  } finally {
    const code = await app.close().catch(() => null);
    if (code !== null) check('the app exited with code 0', code === 0, String(code));
  }
}

const dir = mkdtempSync(join(tmpdir(), 'venom-catalog-boot-'));
const report = join(dir, 'boot-guard.txt');
// `--boot-only` is what a commit that has landed the channels but not the block
// runs: session 1 is the safety proof, session 2 is the owner-visible proof.
const BOOT_ONLY = process.argv.includes('--boot-only');
try {
  assertScratchDir(dir);
  const clean = await runGuardedSession(dir, report);
  if (clean) await runPositiveControl(dir, report);
  if (!BOOT_ONLY) await runSyncedSession(dir);
  else console.log('\n(session 2 skipped: --boot-only)');
  console.log(`\ncatalog-cache folder present: ${existsSync(join(dir, 'catalog-cache')) ? 'created' : 'not created'}`);
} catch (err) {
  check('the run finished', false, err.stack || err.message);
} finally {
  await sleep(500);
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CATALOG BOOT CHECKS PASSED');
process.exit(failures ? 1 : 0);
