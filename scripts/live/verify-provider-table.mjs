// Live check of the provider test table's reference columns, against the fixture
// folder.
//
//   node scripts/live/verify-provider-table.mjs
//
// Launches a VENOM Router on a scratch %TEMP% folder with the legacy fixture
// (fake keys, a local mock provider), opens a provider page, fetches its models,
// runs a test, and measures the header and the cells — geometry and computed
// display, not textContent, because a cell in the DOM is not a cell a person can
// see.
//
// What is being proved is the rule the columns exist for: a fact somebody
// published is shown, a fact nobody published is an em-dash, and every provider
// shows the same columns always — a column with no answers renders dashes,
// never folds away. The
// mock's three models are the whole tri-state — fixture-alpha publishes a price,
// fixture-gamma publishes its modalities, fixture-beta publishes nothing — so the
// three of them together have to produce one priced row, one row of input chips,
// and one row that claims nothing at all.
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { launch } from './cdp.mjs';
import { FIXTURE, writeFixture } from './fixture.mjs';
import { startMock } from './mock-provider.mjs';

// The real source cache lives under the owner's app data. It is COPIED into the
// scratch folder, never opened in place, so the live check reads real reference
// rows without the owner's folder being touched or written by a test.
const REAL_CACHE = join(process.env.APPDATA || '', 'venom-router', 'catalog-cache');

function seedRealCache(userDataDir) {
  const dest = join(userDataDir, 'catalog-cache');
  if (!existsSync(REAL_CACHE)) return false;
  mkdirSync(dest, { recursive: true });
  for (const f of readdirSync(REAL_CACHE)) copyFileSync(join(REAL_CACHE, f), join(dest, f));
  return true;
}

// A model whose facts the reference really holds, so the fallback is exercised
// against data rather than only against its absence. These are the ids the Dark
// API test page showed.
const REAL_MODELS = ['deepseek-v4.1-flash', 'glm-5.3-flash', 'claude-opus-5-5'];

// The shared fixture mock serves only the three fixture ids, which are in no
// source — so the roster is served here instead, with the fixture's three models
// AND the real ones on the same origin. The tri-state still comes from the three
// fixture rows; the real rows are what prove the reference fallback lands.
function startMockWithRealModels(port) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const auth = req.headers.authorization || '';
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (!auth.startsWith('Bearer sk-fixture-')) return send(401, { error: { message: 'fixture: missing or unknown key' } });
      if (req.method === 'GET' && req.url.endsWith('/models')) {
        return send(200, { object: 'list', data: [
          { id: 'fixture-alpha', object: 'model', owned_by: 'fixture',
            pricing: { input_usd_per_1m: 2, output_usd_per_1m: 10 }, tool_call: true },
          { id: 'fixture-gamma', object: 'model', owned_by: 'fixture',
            modalities: { input: ['text', 'image', 'audio'], output: ['text'] },
            supported_parameters: ['tools', 'response_format'], tool_call: true, reasoning: true },
          { id: 'fixture-beta', object: 'model', owned_by: 'fixture' },
          // Published as bare ids, the way a thin provider serves them: no
          // limits, no price, no modalities. Everything the table shows for these
          // has to come from the reference.
          ...REAL_MODELS.map((id) => ({ id, object: 'model', owned_by: 'fixture' })),
        ] });
      }
      if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
        return send(200, {
          id: 'fixture', object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: '4' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        });
      }
      return send(404, { error: { message: 'fixture: no such route' } });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({
      origin: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }),
    }));
  });
}

let failures = 0;
function check(name, cond, detail = '') {
  if (!cond) failures += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}

const READY = "typeof PROVIDERS === 'object' && Object.keys(PROVIDERS).length === 7 && !!window.CATALOG && CATALOG.state.loaded";

// Both ports are claimed from the OS rather than fixed. A run killed mid-flight
// leaves its mock and its debugging socket behind, and the next run then dies on
// EADDRINUSE or, worse, drives the window the dead run left standing.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function measureTable(app) {
  return app.evaluate(`(async () => {
    const wait = async (fn, ms = 30000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { try { if (fn()) return true; } catch (_) {} await new Promise((r) => setTimeout(r, 120)); }
      return false;
    };

    // The provider page, opened the way the app itself opens it.
    openProviderPage('darkapi');
    await wait(() => !document.querySelector('.page-provider').hidden);

    document.querySelector('#btn-fetch-models').click();
    const listed = await wait(() => document.querySelectorAll('#models-list .model-item').length >= 3, 25000);
    document.querySelector('#btn-select-all').click();
    await new Promise((r) => setTimeout(r, 300));
    document.querySelector('#btn-test-all').click();

    const table = document.querySelector('#results-table');
    // The status badge is the status-dot-badge span (app.js statusIconBadge);
    // wait on any running or queued badge rather than a stale class name.
    const stillOut = () => [...table.querySelectorAll('tbody tr')].some((r) =>
      r.querySelector('.status-dot-badge.running') || r.querySelector('.status-dot-badge.queued'));
    const done = await wait(() => {
      const rows = table.querySelectorAll('tbody tr');
      return rows.length >= 3 && !stillOut();
    }, 40000);
    await new Promise((r) => setTimeout(r, 400));

    const cs = (el) => getComputedStyle(el);
    const painted = (el) => {
      if (!el) return false;
      const b = el.getBoundingClientRect();
      const s = cs(el);
      return b.width > 4 && b.height > 4 && s.display !== 'none' && s.visibility === 'visible' && Number(s.opacity) > 0;
    };
    const text = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : null);

    const heads = [...table.querySelectorAll('thead th')].map((th) => ({
      label: text(th), cls: th.className, painted: painted(th) }));

    const rows = [...table.querySelectorAll('tbody tr')].map((tr) => {
      const cell = (sel) => tr.querySelector(sel);
      // CAPS and inputs share the same mark now (mc-cap-ico): the reader is
      // scoped per cell. An input mark has no on/is-yes class — presence IS
      // the yes — while a CAPS mark carries is-yes when supported.
      const capsChips = [...tr.querySelectorAll('.cell-caps .mc-cap-ico')].map((c) => ({
        token: c.getAttribute('title') || text(c), on: c.classList.contains('is-yes'),
        stated: c.classList.contains('is-yes') || c.classList.contains('is-no'),
        painted: painted(c) }));
      const inputChips = [...tr.querySelectorAll('.cell-model-inputs .mc-cap-ico')].map((c) => ({
        token: c.getAttribute('title') || text(c), on: true,
        stated: true, painted: painted(c) }));
      return {
        model: text(cell('.cell-model')),
        modelLogo: cell('.cell-model .cell-model-logo') ? painted(cell('.cell-model .cell-model-logo')) : false,
        status: cell('.cell-status') ? cs(cell('.cell-status')).display : null,
        context: { text: text(cell('.cell-context')), na: cell('.cell-context') ? cell('.cell-context').classList.contains('cell-na') : null },
        score: { text: text(cell('.cell-score')), na: cell('.cell-score') ? cell('.cell-score').classList.contains('cell-na') : null,
                 tag: cell('.cell-score .score-tag-badge') ? text(cell('.cell-score .score-tag-badge')) : null,
                 title: cell('.cell-score .score-num') ? cell('.cell-score .score-num').getAttribute('title') : null },
        time: { text: text(cell('.cell-time')), na: cell('.cell-time') ? cell('.cell-time').classList.contains('cell-na') : null },
        price: { text: text(cell('.cell-price')), na: cell('.cell-price') ? cell('.cell-price').classList.contains('cell-na') : null,
                 inText: text(cell('.cell-price .price-in')), outText: text(cell('.cell-price .price-out')) },
        caps: { text: text(cell('.cell-caps')), na: cell('.cell-caps') ? cell('.cell-caps').classList.contains('cell-na') : null,
                chips: capsChips },
        inputs: inputChips,
        response: text(cell('.cell-response')),
        actions: cell('.cell-actions') ? cell('.cell-actions').innerHTML : null,
      };
    });

    const classes = [...table.classList];
    return { listed, done, heads, rows, classes,
      hidden: { context: table.classList.contains('hide-context'), score: table.classList.contains('hide-score'),
                price: table.classList.contains('hide-price'), caps: table.classList.contains('hide-caps'),
                type: table.classList.contains('hide-type') } };
  })()`);
}

const dir = mkdtempSync(join(tmpdir(), 'venom-ptable-'));
let mock = null;
let app = null;
try {
  mock = await startMockWithRealModels(0);
  writeFixture(dir, mock.origin);
  const seeded = seedRealCache(dir);
  app = await launch({ userDataDir: dir, port: await freePort() });
  // app.js parses before init() runs, so this is the earliest the app can be
  // driven — and it has to be waited for BEFORE the unlock. Unlocking first is
  // the bug this gate kept hitting: lock.js unlocks and then calls init(), and
  // if it does that before app.js has defined init, init never runs at all. The
  // window then sits on an empty shell forever — no providers, no catalog.
  //
  // The lock has to EXIST before it can be opened. authStatus answers
  // `locked:false` while main is still creating the lock, and the gate would then
  // take the "already open" path, which calls nothing — init() is what lock.js
  // runs after a real unlock, so no unlock means no startup.
  await app.waitFor("typeof init === 'function' && typeof PROVIDERS === 'object' && !!window.CATALOG", 60000);
  await app.waitFor("(function(){const s=document.getElementById('lock-screen');return !!s && !s.hidden;})()", 30000);
  await app.unlockAndWait();
  let ready = false;
  try {
    ready = await app.waitFor(READY, 20000);
  } catch (_) {
    ready = false;
  }
  // The unlock is what runs init(), and there is a window where main answers
  // `locked:false` before the lock exists — the unlock then takes the "already
  // open" path, calls nothing, and the window sits on an empty shell with no
  // providers and no catalog. Driving init() once here recovers that race. It is
  // a harness recovery, not a product fix: a person clicking Unlock never hits
  // it, because they cannot click before the lock screen is on screen.
  if (!ready) {
    await app.evaluate('(typeof init === "function" ? init() : null)').catch(() => {});
    try {
      ready = await app.waitFor(READY, 40000);
    } catch (_) {
      ready = false;
    }
  }
  if (!ready) {
    const state = await app.evaluate(`JSON.stringify({
      providers: typeof PROVIDERS === 'object' ? Object.keys(PROVIDERS).length : String(typeof PROVIDERS),
      loaded: typeof CATALOG === 'object' && CATALOG ? CATALOG.state.loaded : null,
      locked: document.querySelector('.lock-screen') ? !document.querySelector('.lock-screen').hidden : null,
      status: (document.querySelector('#status-text') || {}).textContent,
      bodyText: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 160),
    })`);
    console.log('not ready ->', state);
    console.log('app output tail ->', app.output().split('\n').slice(-10).join(' | '));
    throw new Error('the app never reached a ready state');
  }
  const r = await measureTable(app);
  const appErrors = app.output().split('\n').filter((l) => /Uncaught|TypeError|ReferenceError/.test(l));

  // The headers the table actually carries today. TIME covers both the run's
  // own time and the recorded-run median the column draws; LATENCY is the
  // provider-facts name for the same statistic, kept here so a rename of the
  // header is caught rather than silently dropped from the check.
  const label = (l) => r.heads.find((h) => new RegExp(`^${l}$`, 'i').test(h.label || ''));
  console.log('headers:', r.heads.map((h) => `${h.label}${h.painted ? '' : '(hidden)'}`).join(' | '));
  console.log('hidden:', JSON.stringify(r.hidden));

  check('the provider page listed its three fixture models', r.listed);
  check('the run finished and the table has a row per model', r.done && r.rows.length >= 3,
    `${r.rows.length} rows`);

  // The columns exist as headers, and the ones with data are actually painted.
  check('SCORE, PRICE IN/OUT and CAPS are headers on the table',
    !!label('SCORE') && !!label('PRICE IN/OUT') && !!label('CAPS') && !!label('TIME'),
    r.heads.map((h) => h.label).join('|'));

  // Every provider shows the same columns, always: a column with no answers
  // renders em-dashes, never folds away. The three real ids are served as bare
  // ids — no limits, no price, no modalities — so anything shown for them came
  // from the reference; the point is the columns are painted either way.
  check('the reference cache was seeded into the scratch folder', seeded === true, `seeded=${seeded}`);
  check('CONTEXT, SCORE, PRICE and CAPS are painted, even with no answers',
    r.hidden.context === false && r.hidden.score === false && r.hidden.price === false
      && r.hidden.caps === false,
    JSON.stringify(r.hidden));
  check('the headers carrying data are actually painted',
    ['CONTEXT', 'SCORE', 'PRICE IN/OUT', 'CAPS', 'TIME'].every((l) => { const h = label(l); return h && h.painted; }),
    ['CONTEXT', 'SCORE', 'PRICE IN/OUT', 'CAPS', 'TIME'].map((l) => `${l}:${(label(l) || {}).painted}`).join(' '));

  const byModel = {};
  for (const row of r.rows) {
    for (const id of ['fixture-alpha', 'fixture-gamma', 'fixture-beta', ...REAL_MODELS]) {
      // The model cell carries the id plus the input chips plus the key label,
      // and textContent runs them together with no separator — so the row is
      // found by the id it starts with, never by splitting on a space that is
      // not there.
      if (String(row.model).startsWith(id)) byModel[id] = row;
    }
  }
  const alpha = byModel['fixture-alpha'];
  const gamma = byModel['fixture-gamma'];
  const beta = byModel['fixture-beta'];
  const glm = byModel['glm-5.3-flash'];
  const opus = byModel['claude-opus-5-5'];

  check('every row the roster served has a row on the table',
    Object.keys(byModel).length === 6, Object.keys(byModel).join(','));

  // --- the provider's own facts still win -------------------------------
  // A published price is shown at the values the mock served, not at zero and
  // not as a dash. $2.00 in / $10.00 out is exactly what /models said.
  check('the priced model shows the price the provider published',
    !!alpha && alpha.price.text === '$2.00/$10.00',
    alpha && JSON.stringify(alpha.price));

  // Silence is not a zero: the model that published no price must read as an
  // unpublished gap, and fmtPrice has to refuse Number(null) === 0 to do it.
  check('a model that published no price is a dash, never $0.00',
    !!beta && !/\$0\.00|\$0\b/.test(String(beta.price.text)),
    beta && JSON.stringify(beta.price));

  // The input chips draw only what a row SUPPORTS. fixture-gamma published
  // text/image/audio, so those three are ON; the two it omitted simply do not
  // draw — an unsupported input is the absence of a chip, not a dimmed one.
  check('the model that published its modalities shows chips for its three tokens',
    !!gamma && gamma.inputs.length === 3, gamma && JSON.stringify(gamma.inputs.map((c) => c.token)));

  // The chip's title carries the token it is about, because the chip itself is
  // an icon with no text in it — so the token is read from the title, not from
  // the (empty) textContent.
  const tokenOf = (chip) => {
    const m = /(?:Reads|Does not read) (\w+)/.exec(String(chip.token || ''));
    return m ? m[1] : null;
  };
  const gammaTokens = gamma ? Object.fromEntries(gamma.inputs.map((c) => [tokenOf(c), c.on])) : {};
  check('the three tokens it published are on',
    gammaTokens.text === true && gammaTokens.image === true && gammaTokens.audio === true,
    JSON.stringify(gammaTokens));

  // The model that published nothing gets NO chip at all — not five struck-
  // through ones, which would be the page inventing five refusals.
  check('a model that published no modalities shows no input chip at all',
    !!beta && beta.inputs.length === 0, beta && JSON.stringify(beta.inputs));

  check('the model that published capabilities shows lit capability chips',
    !!gamma && gamma.caps.chips.some((c) => c.on === true && c.painted),
    gamma && JSON.stringify(gamma.caps.chips));
  // A model that published nothing must claim nothing. Every capability is
  // either lit or absent now — drawing only what a row supports — so a silent
  // row draws no capability chip at all.
  check('a model that published nothing draws no capability chip at all',
    !!beta && beta.caps.chips.length === 0,
    beta && JSON.stringify(beta.caps.chips.map((c) => c.stated)));

  // --- the reference fills what the provider left out --------------------
  // These ids were served as bare ids. Every fact below came from the copied
  // source cache, which is the whole change: the number is on the row because
  // the reference had it, not because the provider published it.
  check('a model the provider published as a bare id still gets its context',
    !!glm && glm.context.na === false && /\d/.test(String(glm.context.text)),
    glm && JSON.stringify(glm.context));
  // The number only — the tier (aa/est/local/proxy) lives in the tooltip, not
  // beside the value.
  check('and it gets the reference score, with the tier in the tooltip',
    !!glm && glm.score.tag == null && /artificial analysis/i.test(String(glm.score.title || ''))
      && /^\d/.test(String(glm.score.text)),
    glm && JSON.stringify(glm.score));
  check('and the price the reference holds for it',
    !!glm && /^\$0\.150\/\$0\.500$/.test(String(glm.price.text)),
    glm && JSON.stringify(glm.price));
  check('the strongest model on the roster carries the highest score',
    !!opus && parseFloat(opus.score.text) > parseFloat(glm.score.text),
    `${opus && opus.score.text} vs ${glm && glm.score.text}`);

  // A published modality list names what the model reads; tokens it leaves out
  // simply do not draw.
  const glmTokens = glm ? Object.fromEntries(glm.inputs.map((c) => [tokenOf(c), c.on])) : {};
  check('the reference modality list draws the tokens it names',
    glmTokens.text === true && glmTokens.image === true && glmTokens.video === true
      && glmTokens.pdf === true,
    JSON.stringify(glmTokens));

  // --- the model cell: provider mark + coloured inputs -------------------
  check('every row shows its provider mark beside the model name',
    r.rows.length >= 3 && r.rows.every((row) => row.modelLogo === true),
    JSON.stringify(r.rows.map((row) => row.modelLogo)));
  // The input marks reuse the CAPS colours (mc-cap tone per token): same mark,
  // same meaning, drawn under the name rather than beside it.
  const inputTones = await app.evaluate(`[...document.querySelectorAll('#results-body tr')].map((tr) =>
    [...tr.querySelectorAll('.cell-model-inputs .mc-cap-ico')].map((c) => c.className))`);
  check('the input marks wear the CAPS colours',
    inputTones.some((list) => list.length > 0)
      && inputTones.every((list) => list.every((cls) => /mc-cap-(tool|vision|audio|video|files)/.test(cls))),
    JSON.stringify(inputTones.slice(0, 2)));

  // --- the run's own TIME column --------------------------------------
  // TIME draws the run's own measurement (result.time), freshly produced by the
  // run above — not the recorded-run median, which this table never drew. The
  // mock answers in ~0ms, so every row shows a time near zero rather than a
  // dash: the point is the column is populated and painted, not the value.
  check('every finished row shows its own run time',
    r.rows.length >= 3 && r.rows.every((row) => /\d/.test(String((row.time || {}).text))),
    JSON.stringify(r.rows.map((row) => row.time)));

  // --- the ACTIONS column ------------------------------------------------
  // One column, every row, whether the row passed or failed: the button is the
  // per-row retry, and its presence must not depend on the verdict.
  check('every row carries its own retry button under ACTIONS',
    r.rows.length >= 3 && r.rows.every((row) => /row-retry-btn/.test(String(row.actions || ''))),
    JSON.stringify(r.rows.map((row) => String(row.actions || '').slice(0, 60))));

  // --- the RESPONSE column clips -----------------------------------------
  // The mock answers '4', which fits; the check is structural: the cell clips
  // by width (ellipsis) and its title carries the whole answer on hover.
  check('every row has a clipped response cell with the full answer on hover',
    r.rows.length >= 3 && r.rows.every((row) => row.response != null),
    JSON.stringify(r.rows.map((row) => row.response)));

  check('the app logged no uncaught renderer error', appErrors.length === 0, appErrors.slice(0, 2).join(' | '));
} finally {
  if (app) await app.close();
  if (mock) await mock.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll provider-table checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
