// Live check of the local database against a synthetic data folder.
//
//   npm run verify:live
//
// Builds a fixture userData in %TEMP% (legacy JSON with fake keys, provider
// URLs on a local mock), launches a separate VENOM Router on it over CDP,
// checks the import and what survives a restart, then deletes the folder.
// The owner's data folder is never read.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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

// ---- run 2: relaunch on the same folder -----------------------------------------

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

const RUN1 = [checkImport];
const RUN1_END = [saveForNextRun];
const RUN2 = [checkPersistence];
const RUN2_END = [checkWriteGate];

async function session(ctx, steps) {
  const app = await launch({ userDataDir: ctx.dir });
  try {
    await app.waitFor(READY, 30000);
    for (const step of steps) await step({ ...ctx, app });
  } finally {
    const code = await app.close().catch((err) => {
      check('the app closed', false, err.message);
      return null;
    });
    if (code !== null) check('the app exited with code 0', code === 0, String(code));
  }
}

const dir = mkdtempSync(join(tmpdir(), 'venom-live-'));
const mock = await startMock(FIXTURE.port);
try {
  const fixture = writeFixture(dir, mock.origin);
  const ctx = { dir, mock, fixture, check };
  console.log(`Fixture data folder: ${dir}\n`);
  await session(ctx, [...RUN1, ...RUN1_END]);
  await session(ctx, [...RUN2, ...RUN2_END]);
} catch (err) {
  check('the live run finished', false, err.stack || err.message);
} finally {
  await mock.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL LIVE CHECKS PASSED');
process.exit(failures ? 1 : 0);
