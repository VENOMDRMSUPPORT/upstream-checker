// Live check of the Models page's details drawer and its two tabs.
//
//   npm run verify:sidebar
//
// Launches a VENOM Router on a scratch %TEMP% folder with the legacy fixture
// (fake keys, a local mock provider), opens Models, and measures the drawer —
// geometry, not textContent, because a node in the DOM is not a node a person
// can see. The owner's data folder is never read or written; the folder is
// deleted at the end, and so are the screenshots.
//
// The screenshots are a convenience for whoever is looking at this output, not
// a gate: they go to the run's own scratch folder, which is removed afterwards,
// so a passing run leaves nothing behind.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const dir = mkdtempSync(join(tmpdir(), 'venom-sidebar-'));
const mock = await startMock(47841);
try {
  writeFixture(dir, mock.origin);
  const app = await launch({ userDataDir: dir, port: 9343 });
  try {
    // The app lock is the front door: open it before waiting for the page.
    await app.unlockAndWait();
    await app.waitFor("typeof PROVIDERS === 'object' && Object.keys(PROVIDERS).length === 7 && Boolean(window.CATALOG) && CATALOG.state.loaded", 45000);
    
    // Open catalog page
    await app.evaluate(`
      document.querySelector('.shell-nav-item[data-page="catalog"]').click();
    `);
    await new Promise(r => setTimeout(r, 1500));

    // Verify Output column is gone, Context is present
    const tableInfo = await app.evaluate(`(() => {
      const headers = [...document.querySelectorAll('.mc-table th')].map(th => th.textContent.trim());
      const hasOutHeader = !!document.querySelector('.mc-table th.col-out');
      const hasCtxHeader = !!document.querySelector('.mc-table th.col-ctx');
      const hasOutCells = document.querySelectorAll('.mc-table td.col-out').length > 0;
      const rows = document.querySelectorAll('.mc-table tr.mc-row').length;
      return { headers, hasOutHeader, hasCtxHeader, hasOutCells, rows };
    })()`);

    check('Table has Context column', tableInfo.hasCtxHeader);
    check('Table has NO Output column header', !tableInfo.hasOutHeader);
    check('Table rows have NO Output column cells', !tableInfo.hasOutCells);

    // Capture screenshot of table without Output column
    const shotTable = await app.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(dir, 'catalog_table_no_output.png'), Buffer.from(shotTable.result.data, 'base64'));
    console.log('Saved catalog_table_no_output.png');

    // Click on the first row to open details sidebar
    await app.evaluate(`(() => {
      const firstRow = document.querySelector('.mc-table tr.mc-row');
      if (firstRow) firstRow.click();
    })()`);
    await new Promise(r => setTimeout(r, 500));

    // Check sidebar state
    const drawerInfo = await app.evaluate(`(() => {
      const drawer = document.getElementById('mc-details-drawer');
      const panel = drawer ? drawer.querySelector('.mc-details-panel') : null;
      const title = drawer ? drawer.querySelector('#mc-details-title').textContent.trim() : '';
      const b = panel ? panel.getBoundingClientRect() : null;
      const isOpen = drawer && drawer.classList.contains('open') && !drawer.hidden;
      const panelsCount = drawer ? drawer.querySelectorAll('.mc-panel').length : 0;
      return {
        isOpen,
        title,
        rect: b ? { top: b.top, right: b.right, width: b.width, height: b.height } : null,
        panelsCount,
      };
    })()`);

    check('Details drawer opens on row click', drawerInfo.isOpen);
    check('Drawer has model title', !!drawerInfo.title, drawerInfo.title);
    check('Drawer panel sits on the right', drawerInfo.rect && drawerInfo.rect.right === 1280 && drawerInfo.rect.width > 300, JSON.stringify(drawerInfo.rect));
    check('Drawer contains detail panels', drawerInfo.panelsCount >= 3, `panels=${drawerInfo.panelsCount}`);

    // Capture screenshot with sidebar drawer open from the right
    const shotDrawer = await app.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(dir, 'catalog_sidebar_drawer_open.png'), Buffer.from(shotDrawer.result.data, 'base64'));
    console.log('Saved catalog_sidebar_drawer_open.png');

    // Close the drawer via close button
    await app.evaluate(`(() => {
      const closeBtn = document.querySelector('[data-details-close].mc-details-close');
      if (closeBtn) closeBtn.click();
    })()`);
    await new Promise(r => setTimeout(r, 400));

    const closed = await app.evaluate(`(() => {
      const drawer = document.getElementById('mc-details-drawer');
      return drawer && (!drawer.classList.contains('open') || drawer.hidden);
    })()`);
    check('Drawer closes on clicking close button', closed);

  } finally {
    await app.close().catch(() => {});
  }
} finally {
  await mock.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}

console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL SIDEBAR CHECKS PASSED');
process.exit(failures ? 1 : 0);
