// Live check of the local database against a synthetic data folder.
//
//   npm run verify:live
//
// Builds a fixture userData in %TEMP% (legacy JSON with fake keys, provider
// URLs on a local mock), launches a separate VENOM Router on it over CDP,
// checks the import and what survives a restart, then deletes the folder.
// The owner's data folder is never read.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
      hasAa: typeof settings.aaApiKey === 'string' && settings.aaApiKey.length > 0,
      runs: runLog.length,
      prompt: testPrompt,
      alphaFirstSeen: (CATALOG.state.data.models['darkapi::fixture-alpha'] || {}).firstSeen,
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
  check('Artificial Analysis key imported', s.hasAa);
  check('three history runs imported', s.runs === 3, String(s.runs));
  check('test prompt imported', s.prompt === 'Fixture prompt?', s.prompt);
  check('model pool imported with firstSeen kept', s.alphaFirstSeen === fixture.alphaFirstSeen, String(s.alphaFirstSeen));
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
      url: PROVIDERS.darkapi.baseUrl + '/chat/completions', method: 'POST', logLevel: 'all',
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
      aa: settings.aaApiKey,
      aaField: document.querySelector('#set-aa-key').value,
      aaSaved: !document.querySelector('#aa-key-saved').hidden,
      blocked,
      sentStatus: sent.status,
      lockedCopy,
    };
  })()`);
  check('no key and no AA key anywhere in the page', !s.page.includes('sk-fixture-') && !s.page.includes(FIXTURE.aaKey));
  check('every key is its placeholder (a locked key is empty)', s.placeholders);
  check('the key hint is the old mask', s.hint === 'sk-fixture********0001', s.hint);
  check('settings.aaApiKey is the placeholder', s.aa === 'venomsecret:aaApiKey', s.aa);
  check('the AA key field is empty with "Saved" showing', s.aaField === '' && s.aaSaved);
  check("a key sent to a host that isn't its provider is refused",
    s.blocked.blocked === true && s.blocked.status === 0 && s.blocked.error === "Key blocked: localhost:47831 is not this key's provider",
    JSON.stringify(s.blocked));
  check('the refused request never left the app', !mock.requests.some((r) => r.url.includes('/steal')));
  const hit = mock.requests.find((r) => r.url.endsWith('/darkapi/v1/chat/completions') && r.body.includes('fixture-alpha'));
  check('main put the real key in the header and the JSON body',
    s.sentStatus === 200 && !!hit && hit.authorization === `Bearer ${FIXTURE.keys.dark1}` && JSON.parse(hit.body).api_key === FIXTURE.keys.dark1);
  const log = existsSync(join(dir, 'requests.log')) ? readFileSync(join(dir, 'requests.log'), 'utf-8') : '';
  check('requests.log keeps the placeholder, never the key', log.includes('venomkey:k_dark_1') && !log.includes(FIXTURE.keys.dark1));
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
    models: Object.keys(CATALOG.state.data.models).length,
  })`);
  check('a setting saved in run 1 survived the restart', s.spark === 17, String(s.spark));
  check('a key toggled in run 1 stayed toggled', s.dark === 'k_dark_1:true,k_dark_2:false,k_cust_2:false', s.dark);
  check('no second import: still three runs', s.runs === 3, String(s.runs));
  check('the imported files were left alone', existsSync(join(dir, 'config.imported.json')) && !existsSync(join(dir, 'config.json')));
  check('the model pool kept its rows', s.models >= 2, String(s.models));
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

const RUN1 = [checkImport, checkKeysStayInMain];
const RUN1_END = [saveForNextRun, queueSaveThenClose];
const RUN2 = [checkPersistence, checkFlushOnClose, checkSingleInstance];
const RUN2_END = [checkWriteGate];

// checkFastClose: assert the close was answered by the renderer's
// flush-pending reply, not by the main-side 2 s timeout — used right after
// queueSaveThenClose, whose setting has no other way to reach disk.
async function session(ctx, steps, { checkFastClose = false } = {}) {
  const app = await launch({ userDataDir: ctx.dir });
  try {
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
