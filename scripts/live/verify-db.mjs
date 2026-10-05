// Live check of the local database against a synthetic data folder.
//
//   npm run verify:live
//
// Builds a fixture userData in %TEMP% (legacy JSON with fake keys, provider
// URLs on a local mock), launches a separate VENOM Router on it over CDP,
// checks the import, the request log and what survives a restart, then
// deletes the folder.
// The owner's data folder is never read.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, spawnPlain } from './cdp.mjs';
import { FIXTURE, writeFixture } from './fixture.mjs';
import { startMock } from './mock-provider.mjs';

let failures = 0;
function check(name, cond, detail = '') {
  if (!cond) failures += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(250);
  }
  return false;
}

const READY = "typeof PROVIDERS === 'object' && Object.keys(PROVIDERS).length === 7 && !!window.CATALOG && CATALOG.state.loaded";

// ---- run 1: the first launch imports the fixture -----------------------------

async function checkImport({ app, dir, mock, fixture }) {
  const s = await app.evaluate(`(async () => {
    const cfg = await window.electronAPI.readConfig();
    const keys = (id) => PROVIDERS[id].keys.map((k) => ({ id: k.id, active: k.active, locked: !!k.locked, quota: !!k.quotaSpent }));
    return {
      providers: Object.keys(PROVIDERS),
      dark: keys('darkapi'),
      nexum: keys('nexum'),
      stored: Object.keys(cfg.providers),
      orphanCustom: !!(cfg.providers.custom_orphan && cfg.providers.custom_orphan.custom),
      theme: settings.theme,
      imagePrompt: settings.imagePrompt,
      hasOr: typeof settings.openRouterApiKey === 'string' && settings.openRouterApiKey.length > 0,
      runs: runLog.length,
      prompt: testPrompt,
      // The pool is NOT imported — catalog.json is read and renamed, but nothing in
      // the schema holds its entries. It IS fetched: the catalogue's first pass
      // asks every connected provider for its roster and ingests what it gets,
      // so what arrives here is the mock's own list (fixture-alpha, fixture-beta,
      // fixture-gamma), not the two entries catalog.json used to carry. That is
      // the honest check: the pool holds what the provider publishes, and none
      // of it came from the file.
      poolSize: CATALOG.state.models.size,
      poolIds: [...CATALOG.state.models.values()].map((r) => r.id).sort(),
      hasLegacy: [...CATALOG.state.models.values()].some((r) => r.id === 'fixture-gone'),
      banner: !document.querySelector('#store-error').hidden,
    };
  })()`);
  check('seven built-in providers loaded', s.providers.length === 7, s.providers.join(', '));
  check('legacy custom provider merged into Dark API, duplicate key dropped',
    s.dark.map((k) => k.id).join(',') === 'k_dark_1,k_dark_2,k_cust_2', s.dark.map((k) => k.id).join(','));
  check('the merged custom provider is gone from the store', !s.stored.includes('custom_legacy'), s.stored.join(', '));
  check('a custom provider with keys and no built-in twin is kept but not loaded', s.orphanCustom && !s.providers.includes('custom_orphan'));
  check('the undecryptable enc:v1: key came through locked',
    s.nexum.map((k) => `${k.id}:${k.locked}`).join(',') === 'k_nexum_1:false,k_nexum_locked:true', JSON.stringify(s.nexum));
  check('quotaSpent survived the import', s.nexum[0].quota === true);
  check('a disabled key stayed disabled through the merge', s.dark[2].active === false);
  check('settings imported', s.theme === 'daylight', s.theme);
  check('legacy mediaPrompt seeded the image prompt', s.imagePrompt === 'A fixture media prompt.', s.imagePrompt);
  check('the legacy key came through as the OpenRouter secret', s.hasOr);
  check('three history runs imported', s.runs === 3, String(s.runs));
  check('test prompt imported', s.prompt === 'Fixture prompt?', s.prompt);
  check('the pool holds what the mock publishes, and none of it came from catalog.json',
    s.poolSize >= 2 && s.poolIds.includes('fixture-alpha') && !s.hasLegacy,
    `${s.poolSize} rows: ${s.poolIds.join(', ')}`);
  check('no read-failure banner', !s.banner);
  ['config', 'catalog', 'history'].forEach((name) => {
    check(`${name}.json renamed to ${name}.imported.json`,
      existsSync(join(dir, `${name}.imported.json`)) && !existsSync(join(dir, `${name}.json`)));
  });
  check('venom.db created', existsSync(join(dir, 'venom.db')));
  const sent = await until(() => mock.requests.some((r) => r.authorization === `Bearer ${FIXTURE.keys.dark1}`));
  check('health and sync traffic reached the mock with the imported key', sent);
  const leaked = mock.requests.filter((r) => [FIXTURE.lockedBlob, FIXTURE.keys.orphan, FIXTURE.keys.cust2]
    .some((v) => r.authorization.includes(v) || r.body.includes(v)));
  check('locked, orphaned and disabled keys were never sent', leaked.length === 0, leaked.map((r) => r.url).join(', '));
}

// ---- keys stay in main ----------------------------------------------------------

async function checkKeysStayInMain({ app, dir, mock }) {
  const s = await app.evaluate(`(async () => {
    const cfg = await window.electronAPI.readConfig();
    const keys = Object.values(PROVIDERS).flatMap((p) => p.keys);
    const blocked = await window.electronAPI.apiRequest({
      url: 'http://localhost:${FIXTURE.port}/steal/models', method: 'GET',
      headers: { Authorization: 'Bearer venomkey:k_dark_1' },
    });
    const sent = await window.electronAPI.apiRequest({
      url: PROVIDERS.darkapi.baseUrl + '/chat/completions', method: 'POST',
      headers: { Authorization: 'Bearer venomkey:k_dark_1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'fixture-alpha', api_key: 'venomkey:k_dark_1', messages: [{ role: 'user', content: 'hi' }] }),
    });
    let lockedCopy = 'copied';
    try { await window.electronAPI.copyKey('k_nexum_locked'); } catch (err) { lockedCopy = 'refused'; }
    CATALOG.fillSettings();
    return {
      page: JSON.stringify({ providers: PROVIDERS, settings, cfg }),
      placeholders: keys.every((k) => (k.locked ? k.key === '' : k.key === 'venomkey:' + k.id)),
      hint: PROVIDERS.darkapi.keys.find((k) => k.id === 'k_dark_1').hint,
      or: settings.openRouterApiKey,
      orField: document.querySelector('#set-openrouter-key').value,
      orSaved: !document.querySelector('#openrouter-key-saved').hidden,
      blocked,
      sentStatus: sent.status,
      lockedCopy,
    };
  })()`);
  check('no key and no OpenRouter key anywhere in the page', !s.page.includes('sk-fixture-') && !s.page.includes(FIXTURE.aaKey));
  check('every key is its placeholder (a locked key is empty)', s.placeholders);
  check('the key hint is the old mask', s.hint === 'sk-fixture********0001', s.hint);
  check('settings.openRouterApiKey is the placeholder', s.or === 'venomsecret:openRouterApiKey', s.or);
  check('the OpenRouter key field is empty with "Saved" showing', s.orField === '' && s.orSaved);
  check("a key sent to a host that isn't its provider is refused",
    s.blocked.blocked === true && s.blocked.status === 0 && s.blocked.error === "Key blocked: localhost:47831 is not this key's provider",
    JSON.stringify(s.blocked));
  check('the refused request never left the app', !mock.requests.some((r) => r.url.includes('/steal')));
  const hit = mock.requests.find((r) => r.url.endsWith('/darkapi/v1/chat/completions') && r.body.includes('fixture-alpha'));
  check('main put the real key in the header and the JSON body',
    s.sentStatus === 200 && !!hit && hit.authorization === `Bearer ${FIXTURE.keys.dark1}` && JSON.parse(hit.body).api_key === FIXTURE.keys.dark1);
  // The log writer flushes every 250 ms.
  await sleep(600);
  const logged = await app.evaluate("window.electronAPI.logsList({ model: 'fixture-alpha', source: ['other'] }, null, 10)");
  const row = logged.rows.find((r) => r.endpoint.endsWith('/darkapi/v1/chat/completions'));
  check('the request was logged under its key id, never the key',
    !!row && row.key_id === 'k_dark_1' && row.provider_id === 'darkapi' && row.status === 'ok' && !JSON.stringify(logged).includes(FIXTURE.keys.dark1),
    JSON.stringify(row && { key: row.key_id, provider: row.provider_id, status: row.status }));
  check('copy-key refuses a locked key', s.lockedCopy === 'refused');
}

// Saved and waited for, so the next run can check it survived.
async function saveForNextRun({ app }) {
  await app.evaluate(`(async () => {
    settings.sparkRuns = 17;
    queueSettingsSave();
    await setKeyActive('darkapi', 'k_dark_2');
    await new Promise((r) => setTimeout(r, 800));
    return true;
  })()`);
}

// Queued and NOT waited for, with its own debounce timer pushed out past the
// close wait: the setting can only reach disk through the renderer's
// flush-pending handler answering the close handshake, not through its own
// timer firing on its own during the 2 s the close waits for that answer.
async function queueSaveThenClose({ app }) {
  await app.evaluate(
    'settings.hedgeStepMs = 2345; clearTimeout(saveSettingsTimer); saveSettingsTimer = setTimeout(saveSettingsNow, 60000); true'
  );
}

// ---- run 2: relaunch on the same folder -----------------------------------------

async function checkFlushOnClose({ app }) {
  const v = await app.evaluate('settings.hedgeStepMs');
  check('a save queued right before closing was written by the close handshake', v === 2345, String(v));
}

async function checkPersistence({ app, dir }) {
  const s = await app.evaluate(`({
    spark: settings.sparkRuns,
    dark: PROVIDERS.darkapi.keys.map((k) => k.id + ':' + k.active).join(','),
    runs: runLog.length,
    // What the pool held BEFORE the restart is the honest question here, not
    // what it holds after: nothing ingested into it in this run, so both are
    // the same and the assertion says that rather than ">= 2" against a pool
    // that migration v3 empties and no importer refills.
    models: CATALOG.state.models.size,
    poolIds: [...CATALOG.state.models.values()].map((r) => r.id).sort(),
  })`);
  check('a setting saved in run 1 survived the restart', s.spark === 17, String(s.spark));
  check('a key toggled in run 1 stayed toggled', s.dark === 'k_dark_1:true,k_dark_2:false,k_cust_2:false', s.dark);
  check('no second import: still three runs', s.runs === 3, String(s.runs));
  check('the imported files were left alone', existsSync(join(dir, 'config.imported.json')) && !existsSync(join(dir, 'config.json')));
  // It is FETCHED, so it survives the restart — but only what the provider
  // published, never the legacy entry catalog.json carried.
  check('the pool survived the restart with the provider’s own models',
    s.models >= 2 && s.poolIds.includes('fixture-alpha') && !s.poolIds.includes('fixture-gone'),
    `${s.models} rows: ${s.poolIds.join(', ')}`);
}

async function checkSingleInstance({ app, dir }) {
  const second = spawnPlain({ userDataDir: dir });
  const code = await Promise.race([second.exited, sleep(15000).then(() => 'timeout')]);
  if (code === 'timeout') {
    second.child.kill();
    await second.exited;
  }
  check('a second instance on the same data folder exits on its own', code !== 'timeout', String(code));
  check('the first instance keeps running', (await app.evaluate('1 + 1')) === 2);
}

// Last in its run: it poisons the session on purpose.
async function checkWriteGate({ app }) {
  const r = await app.evaluate(`(async () => {
    const before = (await window.electronAPI.readConfig()).settings.sparkRuns;
    failStartupRead('live check', new Error('simulated read failure'));
    settings.sparkRuns = 39;
    const direct = await saveSettingsNow();
    const after = (await window.electronAPI.readConfig()).settings.sparkRuns;
    return { before, after, direct: direct === undefined, banner: !document.querySelector('#store-error').hidden };
  })()`);
  check('read gate: the banner is shown', r.banner);
  check('read gate: a settings save is refused and nothing changes on disk', r.direct && r.after === r.before, `${r.before} -> ${r.after}`);
}

// ---- request log ---------------------------------------------------------------

// Answered right before closing: its row can only reach disk through the
// writer's queue — the 250 ms timer or the flush on quit.
const FLUSH_MARKER = `flush-probe-${Date.now()}`;

async function logRightBeforeClose({ app }) {
  await app.evaluate(`window.electronAPI.apiRequest({
    url: PROVIDERS.darkapi.baseUrl + '/${FLUSH_MARKER}', method: 'GET',
    headers: { Authorization: 'Bearer venomkey:k_dark_1' },
  }).then(() => true)`);
}

async function checkQueuedRowSurvivedQuit({ app }) {
  const { rows } = await app.evaluate("window.electronAPI.logsList({ source: ['other'], providerId: ['darkapi'] }, null, 200)");
  check('a request answered right before quitting was written on quit', rows.some((r) => r.endpoint.endsWith(`/${FLUSH_MARKER}`)), FLUSH_MARKER);
}

async function checkLoggingOn({ app, dir }) {
  const s = await app.evaluate(`(async () => ({
    info: await window.electronAPI.logsInfo(),
    health: (await window.electronAPI.logsList({ source: ['health'], providerId: ['darkapi'] }, null, 5)).rows,
    label: document.querySelector('label[for="set-log-level"]').textContent.trim(),
    level: settings.logLevel,
  }))()`);
  check('logging is on and venom-logs.db exists', s.info.enabled === true && s.info.rows > 0 && existsSync(join(dir, 'venom-logs.db')),
    JSON.stringify({ enabled: s.info.enabled, rows: s.info.rows, error: s.info.error }));
  check('health probes are logged with source health and a key id', s.health.length > 0 && /^k_dark_/.test(s.health[0].key_id), String(s.health.length));
  check('the body setting reads "Request bodies" and a new install is on Failed only', s.label === 'Request bodies' && s.level === 'errors', `${s.label} / ${s.level}`);
}

async function checkRouteTestLogged({ app }) {
  const s = await app.evaluate(`(async () => {
    const wait = async (fn, ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (fn()) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    };
    switchProvider('darkapi');
    document.querySelector('#btn-fetch-models').click();
    await wait(() => models.some((m) => m.id === 'fixture-alpha'), 15000);
    await runTests(models.filter((m) => m.id === 'fixture-alpha'));
    await new Promise((r) => setTimeout(r, 800));
    const hist = await window.electronAPI.readHistory();
    const last = hist.runs[hist.runs.length - 1];
    const rows = (await window.electronAPI.logsList({ source: ['route_test'] }, null, 50)).rows;
    return { runUid: last && last.runUid, result: last && last.results[0] && last.results[0].status, rows };
  })()`, 60000);
  const chat = s.rows.find((r) => r.endpoint.endsWith('/darkapi/v1/chat/completions'));
  check('the Route Test passed', s.result === 'pass', String(s.result));
  check('the Route Test wrote route_test rows', s.rows.length > 0, String(s.rows.length));
  check("every route_test row carries the history run's id", s.rows.length > 0 && s.rows.every((r) => r.run_id === s.runUid),
    `${s.runUid} vs ${[...new Set(s.rows.map((r) => r.run_id))].join(',')}`);
  check('tokens come from the mock usage', !!chat && chat.input_tokens === 5 && chat.output_tokens === 1 && chat.usage_source === 'reported',
    JSON.stringify(chat && { in: chat.input_tokens, out: chat.output_tokens }));
  check('cost comes from the pool price (5 × $2 + 1 × $10 per 1M = 20 micro-USD)', !!chat && chat.cost_micros === 20, String(chat && chat.cost_micros));
  check('the row names provider and key, attempt 1, not a hedge',
    !!chat && chat.provider_id === 'darkapi' && /^k_dark_/.test(chat.key_id) && chat.attempt === 1 && chat.is_hedge === 0);
  const meta = chat && chat.meta_json ? JSON.parse(chat.meta_json) : {};
  check('meta_json has the manual trigger and a testGroup', meta.trigger === 'manual' && typeof meta.testGroup === 'string', chat && chat.meta_json);
}

async function checkFailedBodyScrubbed({ app }) {
  const s = await app.evaluate(`(async () => {
    const res = await window.electronAPI.apiRequest({
      url: PROVIDERS.darkapi.baseUrl + '/echo-key', method: 'POST',
      headers: { Authorization: 'Bearer venomkey:k_dark_1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'fixture-alpha', api_key: 'venomkey:k_dark_1' }),
    });
    await new Promise((r) => setTimeout(r, 800));
    const { rows } = await window.electronAPI.logsList({ status: ['error'], providerId: ['darkapi'] }, null, 50);
    const row = rows.find((r) => r.endpoint.endsWith('/echo-key'));
    return { status: res.status, full: row ? await window.electronAPI.logsGet(row.id) : null };
  })()`);
  const full = s.full;
  const body = full && full.body;
  check('the echo route answered 400', s.status === 400, String(s.status));
  check('a failed request stored its body (Failed only)', !!body && full.has_body === 1);
  check('the stored reply holds the placeholder, never the key',
    !!body && body.response_body.includes('venomkey:k_dark_1') && !body.response_body.includes(FIXTURE.keys.dark1), body && body.response_body);
  check('the stored request is the unresolved one and the auth header is redacted',
    !!body && body.request_body.includes('venomkey:k_dark_1') && JSON.parse(body.request_headers_json).Authorization === '[redacted]');
  check('the stored error message is scrubbed too', !!full && full.error_message.includes('venomkey:k_dark_1'), full && full.error_message);
  check('nothing stored for that request holds the key', !!full && !JSON.stringify(full).includes(FIXTURE.keys.dark1));
}

// ---- the log pages read what the run just wrote ------------------------------

async function checkRunsPage({ app }) {
  const s = await app.evaluate(`(async () => {
    const wait = async (fn, ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (fn()) return true;
        await new Promise((r) => setTimeout(r, 120));
      }
      return false;
    };
    const hist = await window.electronAPI.readHistory();
    const runUid = hist.runs[hist.runs.length - 1].runUid;
    document.querySelector('.shell-nav-item[data-page=history]').click();
    const shown = await wait(() => document.querySelectorAll('.log-run').length > 0, 15000);
    const rows = [...document.querySelectorAll('.log-run')].map((tr) => tr.dataset.run);
    const header = [...document.querySelectorAll('.log-table th')].map((t) => t.textContent).join('|');
    // Expand the run this session's Route Test created.
    const tr = [...document.querySelectorAll('.log-run')].find((x) => x.dataset.run === runUid);
    if (tr) tr.click();
    const opened = await wait(() => {
      const d = document.querySelector('.log-run-detail');
      return d && !d.textContent.includes('Loading');
    }, 15000);
    return { shown, rows, runUid, header, opened, detail: (document.querySelector('.log-run-detail') || {}).textContent || '' };
  })()`, 45000);
  check('the Runs tab lists at least one run', s.shown && s.rows.length > 0, String(s.rows.length));
  check("the Route Test's run is one of them", s.rows.includes(s.runUid), `${s.runUid} not in ${s.rows.join(',')}`);
  check('the runs table offers the average latency, not a median it cannot compute', s.header.includes('Avg latency'), s.header);
  check('a run expands into its summary', s.opened, s.detail.slice(0, 80));
  check('the summary carries both medians and a pass rate',
    s.detail.includes('Median latency') && s.detail.includes('Median first token') && s.detail.includes('Pass rate'),
    s.detail.slice(0, 120));
}

async function checkRequestsPageAndDrawer({ app }) {
  const s = await app.evaluate(`(async () => {
    const wait = async (fn, ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (fn()) return true;
        await new Promise((r) => setTimeout(r, 120));
      }
      return false;
    };
    // Drill from the run into its requests: a filter change, not a navigation.
    const see = document.querySelector('[data-see-requests]');
    if (see) see.click();
    const filtered = await wait(() => !!document.getElementById('log-clear-run') && document.querySelectorAll('.log-row').length > 0, 15000);
    const chip = (document.querySelector('.log-chip') || {}).textContent || '';
    const tab = window.LOGS.tab();
    // Clear the filter, then open the failed echo-key request.
    document.getElementById('log-clear-run').click();
    await wait(() => !document.getElementById('log-clear-run'), 10000);
    const rows = (await window.electronAPI.logsList({ status: ['error'] }, null, 50)).rows;
    const failed = rows.find((r) => r.endpoint.endsWith('/echo-key'));
    if (failed) {
      const tr = [...document.querySelectorAll('.log-row')].find((x) => Number(x.dataset.id) === failed.id);
      if (tr) tr.click();
    }
    const opened = await wait(() => {
      const d = document.getElementById('log-drawer');
      return d && !d.hidden && !document.getElementById('log-drawer-body').textContent.includes('Loading');
    }, 15000);
    // Not hidden is not the same as on screen. The shared drawer CSS parks
    // .ku-panel at translateX(100%) until the open class lands, so a drawer
    // that only cleared its hidden attribute sat off screen behind an
    // invisible scrim that ate the next click. Measure the panel, not text.
    await new Promise((r) => setTimeout(r, 400));
    const panel = document.querySelector('#log-drawer .ku-panel');
    const box = panel ? panel.getBoundingClientRect() : { left: 0, right: 0, width: 0 };
    const onScreen = box.width > 200 && box.right <= window.innerWidth + 1 && box.left < window.innerWidth;
    const focused = document.activeElement && document.activeElement.id === 'log-drawer-close';
    const body = document.getElementById('log-drawer-body').textContent;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await wait(() => document.getElementById('log-drawer').hidden, 5000);
    return { filtered, chip, tab, opened, body, onScreen, focused, box: { left: box.left, right: box.right, width: box.width }, vw: window.innerWidth, closed: document.getElementById('log-drawer').hidden };
  })()`, 60000);
  check("seeing a run's requests switches to the Requests tab", s.tab === 'requests', s.tab);
  check('the list is filtered to that run, with a chip naming it', s.filtered && /^Run\s+\S+/.test(s.chip), s.chip);
  check('a failed request opens in the drawer', s.opened, s.body.slice(0, 80));
  check('the drawer panel is actually on screen, not parked off the right edge',
    s.onScreen, `panel ${JSON.stringify(s.box)} in a ${s.vw}px window`);
  check('focus moves into the drawer', s.focused);
  check('the drawer shows the outcome, the endpoint and the stored bodies',
    s.body.includes('Outcome') && s.body.includes('Endpoint') && s.body.includes('Response'), s.body.slice(0, 120));
  check('the drawer shows the placeholder and never the key',
    s.body.includes('venomkey:k_dark_1') && !s.body.includes(FIXTURE.keys.dark1));
  check('Escape closes the drawer', s.closed);
}

async function checkMonitoringPage({ app }) {
  const s = await app.evaluate(`(async () => {
    const wait = async (fn, ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (fn()) return true;
        await new Promise((r) => setTimeout(r, 120));
      }
      return false;
    };
    document.querySelector('.shell-nav-item[data-page=monitor]').click();
    const drawn = await wait(() => document.querySelectorAll('#monitor-body svg[role="img"]').length > 0, 20000);
    const charts = document.querySelectorAll('#monitor-body svg[role="img"]').length;
    const marks = document.querySelectorAll('#monitor-body svg[role="img"] polyline, #monitor-body svg[role="img"] circle').length;
    const tiles = [...document.querySelectorAll('#monitor-body .ov-kpi')].map((t) => t.textContent).join('|');
    return { drawn, charts, marks, tiles };
  })()`, 45000);
  check('Monitoring draws its charts', s.drawn && s.charts === 3, String(s.charts));
  check('the charts have data, not empty axes', s.marks > 0, String(s.marks));
  check('the totals tiles count the run', s.tiles.includes('Requests'), s.tiles.slice(0, 80));
}

async function checkRetentionSettings({ app }) {
  const s = await app.evaluate(`(async () => {
    const wait = async (fn, ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (fn()) return true;
        await new Promise((r) => setTimeout(r, 120));
      }
      return false;
    };
    document.querySelector('.shell-nav-item[data-page=settings]').click();
    document.querySelector('#settings-nav .settings-nav-item[data-section=sec-logs]').click();
    await wait(() => !!document.getElementById('set-log-retention'), 10000);
    const defaults = [
      document.getElementById('set-log-retention').value,
      document.getElementById('set-body-retention').value,
      document.getElementById('set-stats-retention').value,
    ].join(',');
    const healthy = await wait(() => document.getElementById('logs-db-health').textContent.includes('requests'), 15000);
    const health = document.getElementById('logs-db-health').textContent;
    // SETTING_INPUTS binds non-boolean fields on input, not change.
    const input = document.getElementById('set-log-retention');
    input.value = '45';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 2500));
    const stored = (await window.electronAPI.readConfig()).settings.logRetentionDays;
    return { defaults, healthy, health, stored };
  })()`, 45000);
  check('the retention fields open on their defaults', s.defaults === '90,7,12', s.defaults);
  check('the log health block shows the number of rows and the size on disk', s.healthy && s.health.includes('on disk'), s.health.trim().slice(0, 70));
  check('a changed retention value round-trips to the database', s.stored === 45, String(s.stored));
}

async function checkNoRequestsLog({ dir }) {
  check('requests.log was not written', !existsSync(join(dir, 'requests.log')) && !existsSync(join(dir, 'requests.log.1')));
}

async function checkDatabasePage({ app }) {
  const result = await app.evaluate(`(async () => {
    document.querySelector('.shell-nav-item[data-page="database"]').click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const page = document.querySelector('.page-database');
    const rect = page.getBoundingClientRect();
    const visible = !page.hidden && rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0;
    const tables = [...document.querySelectorAll('[data-db-table]')].map((button) => button.dataset.dbTable);
    const providerButton = document.querySelector('[data-db-table="provider_keys"]');
    if (providerButton) providerButton.click();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const hasRedaction = document.querySelector('#db-grid').textContent.includes('[redacted]');
    document.querySelector('[data-db-view="structure"]').click();
    const structure = document.querySelector('#db-grid').textContent;
    document.querySelector('#db-source').value = 'logs';
    document.querySelector('#db-source').dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const logTables = [...document.querySelectorAll('[data-db-table]')].map((button) => button.dataset.dbTable);
    return { visible, tables, hasRedaction, structure, logTables, title: document.querySelector('#shell-page-title').textContent };
  })()`);
  check('Database page is visibly on screen', result.visible, JSON.stringify(result));
  check('Database page loads the main database tables', result.tables.includes('provider_keys') && result.title === 'Database', result.tables.join(', '));
  check('sensitive key fields render as redacted', result.hasRedaction);
  check('Structure view shows SQL column metadata', result.structure.includes('Column') && result.structure.includes('VISIBLE'));
  check('database switch loads the request-log schema', result.logTables.includes('request_logs'), result.logTables.join(', '));
}

const RUN1 = [checkImport, checkKeysStayInMain];
const RUN1_END = [saveForNextRun, logRightBeforeClose, queueSaveThenClose];
const RUN2 = [
  checkPersistence, checkFlushOnClose, checkQueuedRowSurvivedQuit, checkSingleInstance,
  checkLoggingOn, checkRouteTestLogged, checkFailedBodyScrubbed, checkNoRequestsLog,
  // The pages read what the checks above just wrote, so they run after them.
  checkRunsPage, checkRequestsPageAndDrawer, checkMonitoringPage, checkRetentionSettings, checkDatabasePage,
];
const RUN2_END = [checkWriteGate];

// checkFastClose: assert the close was answered by the renderer's
// flush-pending reply, not by the main-side 2 s timeout — used right after
// queueSaveThenClose, whose setting has no other way to reach disk.
async function session(ctx, steps, { checkFastClose = false } = {}) {
  const app = await launch({ userDataDir: ctx.dir });
  try {
    // Past the app lock first: it is the front door, and READY is about the app
    // behind it.
    await app.unlockAndWait();
    await app.waitFor(READY, 30000);
    for (const step of steps) await step({ ...ctx, app });
  } finally {
    const closeStarted = Date.now();
    const code = await app.close().catch((err) => {
      check('the app closed', false, err.message);
      return null;
    });
    if (checkFastClose) {
      const took = Date.now() - closeStarted;
      check('the close was answered by the renderer, not the 2 s flush timeout', took < 1500, `${took} ms`);
      check(
        'no "did not confirm its pending saves" warning in the app output',
        !app.output().includes('did not confirm its pending saves')
      );
    }
    if (code !== null) check('the app exited with code 0', code === 0, String(code));
  }
}

const dir = mkdtempSync(join(tmpdir(), 'venom-live-'));
const mock = await startMock(FIXTURE.port);
try {
  const fixture = writeFixture(dir, mock.origin);
  const ctx = { dir, mock, fixture, check };
  console.log(`Fixture data folder: ${dir}\n`);
  await session(ctx, [...RUN1, ...RUN1_END], { checkFastClose: true });
  await session(ctx, [...RUN2, ...RUN2_END]);
} catch (err) {
  check('the live run finished', false, err.stack || err.message);
} finally {
  await mock.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL LIVE CHECKS PASSED');
process.exit(failures ? 1 : 0);
