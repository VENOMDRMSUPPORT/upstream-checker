// Live check of the Models page's capability legend, against the fixture folder.
//
//   node scripts/live/verify-catalog-legend.mjs
//
// Launches a VENOM Router on a scratch %TEMP% folder with the legacy fixture
// (fake keys, a local mock provider), opens Models, and measures the legend and
// the capability icons in the table — geometry, not textContent, because a node
// in the DOM is not a node a person can see. The owner's data folder is never
// read or written; the folder is deleted at the end.
//
// Every row the page shows here is the mock's own three models, so the numbers
// are small and known. What is being proved is that the legend names eight
// capabilities, that the same eight icons appear on a row, and that a published
// yes is lit while a nobody-said is dim — never a red refusal.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './cdp.mjs';
import { FIXTURE, writeFixture } from './fixture.mjs';
import { startMock } from './mock-provider.mjs';

let failures = 0;
function check(name, cond, detail = '') {
  if (!cond) failures += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}

const PORT = 47837;
const READY = "typeof PROVIDERS === 'object' && Object.keys(PROVIDERS).length === 7 && !!window.CATALOG && CATALOG.state.loaded";

// The eight tone classes the tiles are drawn with, in the order they must
// appear. The tile's class list carries the icon's own class and its tone
// together, so the tone is the one that starts with this prefix.
const TONES = ['tool', 'reasoning', 'structured', 'vision', 'imagegen', 'audio', 'video', 'files'];
const toneClass = (id) => `mc-cap-${id}`;

async function measureLegend(app) {
  return app.evaluate(`(async () => {
    const wait = async (fn, ms = 20000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { try { if (fn()) return true; } catch (_) {} await new Promise((r) => setTimeout(r, 120)); }
      return false;
    };
    document.querySelector('.shell-nav-item[data-page="catalog"]').click();
    const shown = await wait(() => !document.querySelector('.page-catalog').hidden && !!document.querySelector('.mc-legend'));
    const rowsLoaded = await wait(() => document.querySelectorAll('.mc-row').length > 0, 25000);
    await new Promise((r) => setTimeout(r, 400));

    const toneOf = (el) => [...el.classList]
      .filter((c) => c.startsWith('mc-cap-') && c !== 'mc-cap-ico').join(',');
    const box = (node) => { const b = node.getBoundingClientRect();
      return { top: Math.round(b.top), left: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom) }; };
    // textContent proves the legend exists; only geometry proves it is on
    // screen. Position is part of the answer: an element scrolled out of the
    // results pane keeps its width and height, and a size-only check would
    // happily pass on something nobody can see.
    const visibleBox = (node) => { const b = box(node); const cs = getComputedStyle(node);
      return b.h > 6 && b.w > 6 && b.top >= 0 && b.left >= 0 && b.bottom <= window.innerHeight
        && cs.display !== 'none' && cs.visibility === 'visible' && Number(cs.opacity) > 0; };

    const legend = document.querySelector('.mc-legend');
    const tiles = [...document.querySelectorAll('.mc-legend-tile')];
    const tileInfo = tiles.map((t) => {
      const ico = t.querySelector('.mc-legend-ico');
      const b = box(ico);
      const count = t.querySelector('.mc-legend-count');
      return {
        label: t.querySelector('.mc-legend-label').textContent.trim(),
        blurb: t.querySelector('.mc-legend-blurb').textContent.trim(),
        count: count.textContent.trim(),
        countText: parseInt(count.textContent.trim(), 10),
        // The count is a positive integer with the word "model"/"models" after it. The
    // number itself is checked where the legend's arithmetic is, not here.
    countSays: /^[0-9]+ models?$/.test(count.textContent.trim()),
        tone: toneOf(ico),
        classes: [...ico.classList],
        painted: visibleBox(ico),
        w: b.w, h: b.h,
        colour: getComputedStyle(ico).color,
        iconMark: ico.innerHTML.includes('<svg'),
      };
    });

    // The toggle: does folding it actually take the tiles off the screen?
    // Everything measured here is measured BEFORE the first click, because the
    // click re-renders and replaces the very nodes these numbers describe — a
    // detached node's rect is all zeroes, which reads as "nothing on screen"
    // when the truth is "it was there a moment ago".
    const legendOnScreen = visibleBox(legend);
    const legendBox = box(legend);
    const toggle = document.querySelector('[data-mc-legend-toggle]');
    const expandedBefore = toggle.getAttribute('aria-expanded');
    const labelBefore = toggle.textContent.trim();
    toggle.click();
    await new Promise((r) => setTimeout(r, 350));
    const foldedHidden = document.querySelector('.mc-legend-body').hidden;
    const foldedPainted = visibleBox(document.querySelector('.mc-legend-tile'));
    const toggleText = document.querySelector('[data-mc-legend-toggle]').textContent.trim();
    const collapsedBefore = document.querySelector('[data-mc-legend-toggle]').getAttribute('aria-expanded');
    document.querySelector('[data-mc-legend-toggle]').click();
    await new Promise((r) => setTimeout(r, 350));
    const reopened = document.querySelector('.mc-legend-body').hidden === false;

    // The row cells: what each row actually draws, and how bright. Measured
    // before anything above replaces the results container, and after scrolling
    // the first row into view — a column below the fold has a real width and a
    // real height, so a size-only check would pass on icons nobody can see.
    const firstRow = document.querySelector('.mc-row');
    if (firstRow) firstRow.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 350));
    const cells = [...document.querySelectorAll('.mc-row')].map((tr) => {
      const capCell = tr.querySelector('.mc-caps');
      const icons = capCell ? [...capCell.querySelectorAll('.mc-cap-ico')] : [];
      return {
        model: (tr.querySelector('.mc-name') || {}).textContent.trim(),
        silent: capCell ? capCell.classList.contains('is-silent') : null,
        drawn: icons.length,
        lit: icons.filter((i) => i.classList.contains('is-yes')).length,
        dim: icons.filter((i) => i.classList.contains('is-unknown')).length,
        // A refusal would be is-no, and is-no is not a class this page emits.
        refused: icons.filter((i) => i.classList.contains('is-no')).length,
        painted: icons.every((i) => visibleBox(i)),
        litColours: icons.filter((i) => i.classList.contains('is-yes')).map((i) => getComputedStyle(i).color),
        dimColours: icons.filter((i) => i.classList.contains('is-unknown')).map((i) => getComputedStyle(i).color),
      };
    });

    // A search that narrows to nothing must take the counts with it, not leave
    // the numbers from a wider list sitting beside a table with no rows.
    const input = document.querySelector('#mc-toolbar [data-dt="search"]');
    input.value = 'no-such-model-anywhere';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const narrowed = {
      legendGone: !document.querySelector('.mc-legend'),
      nomatch: !!document.querySelector('.dt-nomatch'),
      counts: [...document.querySelectorAll('.mc-legend-count')].map((c) => c.textContent.trim()),
    };
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const restored = document.querySelectorAll('.mc-legend-count').length;

    return {
      shown, rowsLoaded,
      legendPainted: legendOnScreen, legendBox,
      headText: document.querySelector('.mc-legend-head').textContent.trim(),
      gridColumns: getComputedStyle(document.querySelector('.mc-legend-grid')).gridTemplateColumns.split(' ').length,
      tiles: tileInfo,
      toggle: { expandedBefore, labelBefore, foldedHidden, foldedPainted, toggleText, collapsedBefore, reopened },
      cells, narrowed, restored,
      capHeader: (document.querySelector('.mc-table th.col-caps') || {}).textContent,
    };
  })()`, 90000);
}

const dir = mkdtempSync(join(tmpdir(), 'venom-legend-'));
const mock = await startMock(PORT);
try {
  writeFixture(dir, mock.origin);
  console.log(`Scratch data folder: ${dir}\n`);
  const app = await launch({ userDataDir: dir, port: 9339 });
  try {
    // The app lock is the front door: open it before waiting for the page.
    await app.unlockAndWait();
    await app.waitFor(READY, 45000);
    const r = await measureLegend(app);
    const appErrors = app.output().split('\n').filter((l) => /Uncaught|TypeError|ReferenceError/.test(l));

    check('the Models page opened with the legend on it', r.shown && r.rowsLoaded);
    check('the legend itself is on screen, not merely in the DOM',
      r.legendPainted, JSON.stringify(r.legendBox));
    check('it says what it is', /Model Capabilities Legend/.test(r.headText), r.headText.slice(0, 60));
    check('it is a four-across grid of eight tiles', r.gridColumns === 4 && r.tiles.length === 8,
      `${r.gridColumns} columns, ${r.tiles.length} tiles`);
    check('every tile is drawn, with an icon, a name and a count',
      r.tiles.every((t) => t.w > 6 && t.h > 6 && t.iconMark && t.label && t.countSays),
      r.tiles.map((t) => `${t.label}|${JSON.stringify(t.count)}|svg=${t.iconMark}|${t.w}x${t.h}|countSays=${t.countSays}`).join(' '));
    check('the tiles carry all eight capabilities in order',
      r.tiles.every((t, i) => t.classes.includes(toneClass(TONES[i]))),
      r.tiles.map((t, i) => `${t.tone}${t.classes.includes(toneClass(TONES[i])) ? '' : `!expected ${toneClass(TONES[i])}`}`).join(' '));
    check('each tile says what its icon means',
      r.tiles.every((t) => t.blurb.length > 10), r.tiles.map((t) => t.blurb.slice(0, 16)).join(' | '));
    const colours = new Set(r.tiles.map((t) => t.colour));
    check('the eight capabilities are eight different colours', colours.size === 8,
      r.tiles.map((t) => `${t.tone}:${t.colour}`).join(' '));
    check('the counts are numbers the page can prove', r.tiles.every((t) => Number.isFinite(t.countText)),
      r.tiles.map((t) => t.count).join(' '));

    check('the legend starts open and the button says Hide',
      r.toggle.expandedBefore === 'true' && /Hide/.test(r.toggle.labelBefore), r.toggle.labelBefore);
    check('folding it takes the tiles off the screen',
      r.toggle.foldedHidden === true && r.toggle.foldedPainted === false && r.toggle.collapsedBefore === 'false',
      `hidden=${r.toggle.foldedHidden} stillPainted=${r.toggle.foldedPainted}`);
    check('and it opens again', r.toggle.reopened);

    // Every row displays all 8 capability icons (lit when supported, dimmed when unknown/unsupported)
    check('every row displays all 8 capability icons on screen',
      r.cells.every((c) => c.painted && c.refused === 0 && c.drawn === 8),
      r.cells.map((c) => `${c.model.split(' ')[0]}:${c.drawn} drawn, painted=${c.painted}`).join(' | '));
    check('table has both lit and dimmed icons across rows according to model capabilities',
      r.cells.some((c) => c.lit > 0) && r.cells.some((c) => c.dim > 0),
      r.cells.map((c) => `${c.model.split(' ')[0]}: lit=${c.lit} dim=${c.dim}`).join(' | '));
    check('no row draws a refusal', r.cells.every((c) => c.refused === 0),
      r.cells.map((c) => String(c.refused)).join(','));
    const lit = r.cells.find((c) => c.lit > 0);
    check('at least one row has a lit capability', !!lit,
      r.cells.map((c) => `${c.model.split(' ')[0]}:${c.lit}/${c.dim}`).join(' | '));
    check('a lit icon is full colour and a dim one is the same hue, fainter',
      !!lit && lit.litColours.length > 0 && lit.dimColours.length > 0
      && lit.litColours.every((c) => !lit.dimColours.includes(c)),
      lit ? `lit ${lit.litColours[0]} dim ${lit.dimColours[0]}` : 'no mixed row');
    check('the row icons wear the legend\'s colours',
      !!lit && lit.litColours.every((c) => [...colours].includes(c)),
      lit ? lit.litColours.join(' ') : '');

    check('a search that matches nothing takes the counts with it',
      r.narrowed.legendGone === true && r.narrowed.nomatch === true && r.narrowed.counts.length === 0,
      JSON.stringify(r.narrowed));
    check('and clearing the search brings them back', r.restored === 8, String(r.restored));

    check('the capability column is named for what it holds', /Capabilit/.test(r.capHeader || ''), r.capHeader);
    check('nothing threw while the page drew all of this', appErrors.length === 0, appErrors.slice(0, 2).join(' | '));
  } finally {
    await app.close().catch(() => {});
  }
} catch (err) {
  check('the live run finished', false, err.stack || err.message);
} finally {
  await mock.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
console.log(`\n  fixture keys are synthetic (${FIXTURE.keys.dark1}…) — no real provider was contacted.\n`);
console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL LEGEND CHECKS PASSED');
process.exit(failures ? 1 : 0);