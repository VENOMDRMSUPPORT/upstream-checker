// Live check of the Antigravity provider: the sign-in, the roster, the
// allowance and the chat.
//
//   node scripts/live/verify-antigravity.mjs
//
// Two halves, both against a mock — never Google's real service, never the
// owner's browser:
//
//   A. The sign-in chain, through the app's own OAuth manager: the consent
//      page answers, the provider sends the answer back to the short-lived
//      address on this machine, the app exchanges the code, the account is
//      stored, a second account is added beside it, and the token is renewed.
//   B. The app itself, on a scratch folder: the provider is there, the roster
//      is fetched in Antigravity's own protocol, the allowance is read, and a
//      model is tested — the request goes out in the service's shape and the
//      answer comes back and is shown.
//
// The mock stands in for Google and for the Cloud Code Assist service. The
// app's own code does everything else.
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './cdp.mjs';
import { createOAuthManager } from '../../src/oauth/index.js';
import { PROFILES } from '../../src/oauth/profiles.js';
import wire from '../../src/wire/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let checks = 0;
function check(name, ok, detail) {
  checks += 1;
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// The mock: Google and the Cloud Code Assist service, on one address.
// ---------------------------------------------------------------------------
const ROSTER = {
  serverTime: '2026-10-20T10:00:00Z',
  models: {
    'gemini-3-pro-high': {
      displayName: 'Gemini 3 Pro',
      supportsThinking: true,
      maxOutputTokens: 64000,
      quotaInfo: { remainingFraction: 0.25, resetTime: '2026-10-21T00:00:00Z' },
    },
    'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6' },
    // A model the service has retired, and one it keeps for itself.
    'gemini-3.5-flash-low': { displayName: 'Gemini 3.5 Flash (Medium)' },
    chat_20706: { displayName: 'Internal' },
  },
  deprecatedModelIds: {
    'gemini-3.5-flash-low': { newModelId: 'gemini-3-pro-high', reasonCode: 'MODEL_RETIRED' },
  },
};

// The grouped limits: a weekly one and a five-hour one, per group of models.
const LIMITS = {
  groups: [
    {
      displayName: 'Gemini Models',
      buckets: [
        { displayName: 'Weekly Limit', window: '7d', remainingFraction: 0.07, resetTime: '2026-10-23T14:00:00Z' },
        { displayName: 'Five Hour Limit', window: '5h', remainingFraction: 0, resetTime: '2026-10-20T22:00:00Z' },
      ],
    },
    {
      displayName: 'Claude and GPT models',
      buckets: [
        { displayName: 'Weekly Limit', window: '7d', remainingFraction: 1 },
        { displayName: 'Five Hour Limit', window: '5h', remainingFraction: 1 },
      ],
    },
  ],
};

// Which project the account is on, and which plan it holds.
const ACCOUNT = {
  cloudaicompanionProject: 'projects/mock-1',
  currentTier: { id: 'free-tier', name: 'Free' },
  paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
};

function idToken(claims) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part(claims)}.signature`;
}

async function startMock() {
  const requests = [];
  const state = { accounts: 0, tokens: 0, emails: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      requests.push({ method: req.method, path: url.pathname, body, headers: req.headers });
      const send = (status, obj, type = 'application/json') => {
        res.writeHead(status, { 'Content-Type': type });
        res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
      };

      // The consent page: the person signs in, the provider sends the answer
      // back to the address the consent page named.
      if (url.pathname === '/oauth/authorize') {
        const redirect = url.searchParams.get('redirect_uri');
        const stateValue = url.searchParams.get('state');
        const email = state.accounts === 0 ? 'first@example.com' : 'second@example.com';
        state.accounts += 1;
        state.emails.push(email);
        res.writeHead(302, { Location: `${redirect}?code=mock-code-${Date.now()}&state=${encodeURIComponent(stateValue)}` });
        res.end();
        return;
      }

      // The token endpoint: the code becomes the tokens, and a renewal becomes
      // a new access token.
      if (url.pathname === '/token') {
        state.tokens += 1;
        const grant = /grant_type=refresh_token/.test(body) ? 'refresh' : 'authorization_code';
        send(200, {
          access_token: `at-${state.tokens}`,
          refresh_token: 'rt-1',
          expires_in: 3600,
          id_token: idToken({ email: state.emails.shift() || 'first@example.com', name: 'A Person' }),
        });
        void grant;
        return;
      }

      // The service's own routes.
      if (url.pathname === '/v1internal:fetchAvailableModels') {
        send(200, ROSTER);
        return;
      }
      if (url.pathname === '/v1internal:retrieveUserQuotaSummary') {
        send(200, LIMITS);
        return;
      }
      if (url.pathname === '/v1internal:loadCodeAssist') {
        send(200, ACCOUNT);
        return;
      }
      if (url.pathname === '/v1internal:generateContent') {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch (_) { /* the check reads the raw body */ }
        send(200, {
          response: {
            candidates: [{ content: { parts: [{ text: `mock answer for ${parsed.model || 'unknown'}` }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
          },
        });
        return;
      }
      send(404, { error: { message: 'mock: no such route' } });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    state,
    close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}

// ---------------------------------------------------------------------------
// A. The sign-in chain, through the app's own manager.
// ---------------------------------------------------------------------------
// The provider's rows, in memory: the manager only needs these four.
function fakeRepos() {
  const providers = new Map();
  return {
    repos: {
      providers: {
        list: () => Object.fromEntries(providers),
        get: (id) => providers.get(id) || null,
        save: (provider) => {
          const row = { ...provider, keys: provider.keys || [] };
          providers.set(provider.id, row);
          return row;
        },
        saveOAuthAccount: (account) => {
          const provider = providers.get(account.providerId) || { id: account.providerId, name: 'Antigravity', baseUrl: 'https://daily-cloudcode-pa.googleapis.com', keys: [] };
          const meta = account.meta || {};
          const row = {
            id: `k_${provider.keys.length + 1}`,
            name: account.name,
            oauth: true,
            account: meta,
            secret: account.secret,
            oauthSecret: account.oauthSecret,
            active: true,
          };
          // The same account signs in again: the row is replaced, not doubled.
          const same = provider.keys.findIndex((k) => meta.email && k.account && k.account.email === meta.email);
          if (same === -1) provider.keys.push(row);
          else provider.keys[same] = row;
          providers.set(account.providerId, provider);
          return { id: row.id, provider };
        },
        revealOauth: (id) => {
          for (const provider of providers.values()) {
            const key = provider.keys.find((k) => k.id === id);
            if (key) return key.oauthSecret || null;
          }
          return null;
        },
        updateOAuthAccount: (account) => {
          for (const provider of providers.values()) {
            const key = provider.keys.find((k) => k.id === account.id);
            if (!key) continue;
            if (account.secret) key.secret = account.secret;
            if (account.oauthSecret) key.oauthSecret = account.oauthSecret;
            if (account.meta) key.account = account.meta;
            return { id: key.id, provider };
          }
          throw new Error('That account is not in the database');
        },
      },
    },
  };
}

async function checkSignIn(mock) {
  console.log('\nA. The sign-in chain (the app\'s own OAuth manager)');
  const profile = PROFILES.antigravity;
  // The mock stands in for Google. Only this process sees it.
  const realProfile = { ...profile };
  profile.authorizationEndpoint = `${mock.origin}/oauth/authorize`;
  profile.tokenEndpoint = `${mock.origin}/token`;
  profile.apiOrigins = [mock.origin];

  const opened = [];
  const { repos } = fakeRepos();
  repos.providers.save({ id: 'antigravity', name: 'Antigravity', baseUrl: mock.origin, keys: [] });
  const oauth = createOAuthManager({
    repos,
    openExternal: async (url) => { opened.push(url); return true; },
    log: { warn: () => {}, error: () => {}, info: () => {} },
  });

  try {
    const started = await oauth.start('antigravity', { kind: 'loopback', profile: 'antigravity' });
    check('the sign-in starts', started && started.ok === true, JSON.stringify(started));
    check('the consent page is opened in the browser', opened.length === 1 && opened[0].startsWith(mock.origin));

    // The browser: the consent page answers with the code, sent back to the
    // address the consent page named.
    const consent = new URL(opened[0]);
    const redirect = consent.searchParams.get('redirect_uri');
    check('the consent page names a loopback address', /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/.test(redirect), redirect);
    const consentResponse = await fetch(opened[0], { redirect: 'manual' });
    const location = consentResponse.headers.get('location') || '';
    check('the provider sends the answer back to the app', location.startsWith(redirect), location.slice(0, 80));
    const answer = await fetch(location);
    check('the page that comes back closes itself', /window\.close\(\)/.test(await answer.text()));

    const state = oauth.status('antigravity');
    check('the sign-in finished', state.state === 'done', JSON.stringify(state));
    check('the account is the one that signed in', state.account && state.account.email === 'first@example.com');

    const provider = repos.providers.get('antigravity');
    check('the account became a key', provider.keys.length === 1);
    check('the credential is the access token', provider.keys[0].secret === 'at-1');
    check('the renewal token is stored beside it', provider.keys[0].oauthSecret === 'rt-1');
    check('the account carries its own facts', provider.keys[0].account.email === 'first@example.com');
    // The plan the account is on, and the project its requests are billed to.
    check('the plan is on the account', provider.keys[0].account.tier === 'Pro', JSON.stringify(provider.keys[0].account));
    check('the project is on the account', provider.keys[0].account.project === 'projects/mock-1');

    // A second Google account: another key, its own allowance.
    const second = await oauth.start('antigravity', { kind: 'loopback', profile: 'antigravity' });
    check('a second sign-in starts', second && second.ok === true);
    const secondConsent = new URL(opened[opened.length - 1]);
    const secondLocation = (await fetch(opened[opened.length - 1], { redirect: 'manual' })).headers.get('location') || '';
    await fetch(secondLocation);
    const after = repos.providers.get('antigravity');
    check('two accounts live side by side', after.keys.length === 2, `keys: ${after.keys.length}`);
    check('the second account is its own', after.keys[1].account.email === 'second@example.com');
    void secondConsent;

    // The renewal: the account keeps working without the person signing in.
    const renewed = await oauth.renew('antigravity', after.keys[0].id);
    check('the account renews itself', renewed && renewed.ok === true, JSON.stringify(renewed));
    check('the new access token is the credential', after.keys[0].secret !== 'at-1');

    // The roster and the allowance, in the service's own protocol. The mock
    // stands in for the service here, so the address is the mock's.
    const rosterSpec = wire.build('antigravity', 'models', { baseUrl: mock.origin, apiKey: 'venomkey:mock' });
    const rosterResponse = await fetch(rosterSpec.url, { method: 'POST', headers: rosterSpec.headers, body: JSON.stringify(rosterSpec.body) });
    const roster = wire.parse('antigravity', 'models', await rosterResponse.text());
    check('the roster is the service\'s own list', roster.models.length === 3, `models: ${roster.models.length}`);
    check('a retired model is named', Boolean(roster.deprecated['gemini-3.5-flash-low']));
    const quotaSpec = wire.build('antigravity', 'quota-summary', { baseUrl: mock.origin, apiKey: 'venomkey:mock' });
    const quotaResponse = await fetch(quotaSpec.url, { method: 'POST', headers: quotaSpec.headers, body: JSON.stringify(quotaSpec.body) });
    const quota = wire.parse('antigravity', 'quota-summary', await quotaResponse.text());
    check('the limits are grouped', quota.groups.length === 2, `groups: ${quota.groups.length}`);
    check('the weekly and the five-hour limits are there', quota.groups[0].windows.length === 2);

    // The chat, in the service's own shape.
    const chatSpec = wire.build('antigravity', 'chat', {
      baseUrl: mock.origin,
      model: 'gemini-3-pro-high',
      apiKey: 'venomkey:mock',
      payload: { messages: [{ role: 'user', content: 'Hello' }] },
    });
    const chatResponse = await fetch(chatSpec.url, { method: 'POST', headers: chatSpec.headers, body: JSON.stringify(chatSpec.body) });
    const chat = wire.parse('antigravity', 'chat', await chatResponse.text());
    check('the answer is read out of the service\'s wrapper', chat.content === 'mock answer for gemini-3-pro-high', chat.content);
    check('the tokens are counted', chat.usage.total_tokens === 10);
  } finally {
    oauth.stopAll();
    Object.assign(profile, realProfile);
  }
}

// ---------------------------------------------------------------------------
// B. The app itself: the provider, the roster, the allowance, the chat.
// ---------------------------------------------------------------------------
async function checkApp(mock) {
  console.log('\nB. The app (a scratch folder, driven over CDP)');
  const dir = mkdtempSync(join(tmpdir(), 'venom-antigravity-'));
  const port = 9400 + Math.floor(Math.random() * 400);
  let app = null;
  try {
    app = await launch({ userDataDir: dir, port });
    // The app has to be awake before it can be driven: app.js parses, then
    // the lock screen comes up, and unlocking it is what runs init().
    await app.waitFor("typeof init === 'function' && typeof PROVIDERS === 'object'", 60000);
    await app.waitFor("(function(){const s=document.getElementById('lock-screen');return !!s && !s.hidden;})()", 30000);
    await app.unlockAndWait();
    try {
      await app.waitFor("typeof PROVIDERS === 'object' && Object.keys(PROVIDERS).length === 13 && !!window.CATALOG && CATALOG.state.loaded", 40000);
    } catch (_) {
      // The gate below reports what the app looked like; the checks that need
      // a live app will fail with their own reason.
    }

    // The connect button: the modal opens with a spinner, and the browser
    // opens the sign-in page by itself.
    const connect = await app.evaluate(`(async () => {
      openProviderPage('antigravity');
      await new Promise((r) => setTimeout(r, 500));
      const button = document.querySelector('#btn-connect-account');
      if (!button) return { button: false };
      button.click();
      await new Promise((r) => setTimeout(r, 900));
      const modal = document.getElementById('oauth-modal');
      const spinner = document.getElementById('oauth-modal-spinner');
      const status = document.getElementById('oauth-modal-status');
      const spinRect = spinner && !spinner.hidden ? spinner.getBoundingClientRect() : null;
      return {
        button: true,
        modalVisible: !!modal && modal.style.display !== 'none',
        spinnerVisible: !!(spinRect && spinRect.width > 0 && spinRect.height > 0),
        status: status ? status.textContent.trim() : null,
      };
    })()`);
    check('the connect button is there', connect.button === true);
    check('the modal opens', connect.modalVisible === true, JSON.stringify(connect));
    check('the modal shows a loading spinner', connect.spinnerVisible === true, JSON.stringify(connect));
    // The sign-in page opened in the browser by itself; the app waits.
    check('the app waits for the sign-in', /sign-in/i.test(String(connect.status || '')), String(connect.status));
    await app.evaluate(`(() => { const b = document.getElementById('oauth-modal-cancel'); if (b) b.click(); return true; })()`);

    // The provider is a built-in, so the app has it from the start. Its
    // address is pointed at the mock: the app must speak the service's
    // protocol to a service wherever it lives.
    const seeded = await app.evaluate(`(async () => {
      await window.electronAPI.saveProvider({
        id: 'antigravity', name: 'Antigravity', baseUrl: ${JSON.stringify(mock.origin)}, rpm: null,
        keys: [{ id: 'k_ag_1', name: 'Mock person', key: 'ya29.mock-token', active: true }],
      });
      await loadAllProviders();
      return !!PROVIDERS.antigravity;
    })()`);
    check('the provider is in the app', seeded === true);
    const baseUrl = await app.evaluate('PROVIDERS.antigravity.baseUrl');
    check('the provider points at the mock', baseUrl === mock.origin, baseUrl);

    const page = await app.evaluate(`(async () => {
      openProviderPage('antigravity');
      await new Promise((r) => setTimeout(r, 600));
      return !document.querySelector('.page-provider').hidden;
    })()`);
    check('the provider page opens', page === true);

    await app.evaluate(`(() => { document.querySelector('#btn-fetch-models').click(); return true; })()`);
    let listed = false;
    try {
      await app.waitFor("document.querySelectorAll('#models-list .model-item').length >= 2", 40000);
      listed = true;
    } catch (_) {
      listed = false;
    }
    const names = await app.evaluate("[...document.querySelectorAll('#models-list .model-item .model-name')].map((el) => el.textContent.trim())");
    check('the roster is fetched in the service\'s protocol', listed === true, JSON.stringify(names));
    check('the roster is the service\'s own list', names.includes('gemini-3-pro-high') && names.includes('claude-sonnet-4-6'), JSON.stringify(names));
    // The retired model and the ones the service keeps for itself are not
    // offered: the official app does not offer them either.
    check('a retired model is not offered', !names.some((n) => /3\.5 Flash/.test(n)), JSON.stringify(names));
    check('the service\'s own models are not offered', names.length === 2, JSON.stringify(names));

    const rosterCalls = mock.requests.filter((r) => r.path === '/v1internal:fetchAvailableModels');
    check('the roster came from the service\'s route', rosterCalls.length > 0);
    check('the request carried the key', rosterCalls.some((r) => String(r.headers.authorization || '').startsWith('Bearer ya29.mock-token')),
      rosterCalls[0] && rosterCalls[0].headers.authorization);

    // The allowance: the key's usage cell is read from the same route. The
    // cells live in the provider card on the providers page — the card is
    // opened with "Manage keys".
    await app.evaluate(`(async () => {
      if (window.KEY_USAGE) await window.KEY_USAGE.refresh('antigravity', 'k_ag_1', { force: true });
      return true;
    })()`, 60000);
    await app.evaluate(`(() => {
      showPage('providers');
      const toggle = document.querySelector('[data-kx-toggle="antigravity"]');
      if (toggle) toggle.click();
      return !!toggle;
    })()`);
    let shown = false;
    try {
      await app.waitFor("(function(){const c=document.querySelector('[data-ku-open=\\\"antigravity|k_ag_1\\\"]');return !!c && /100%/.test(c.textContent);})()", 30000);
      shown = true;
    } catch (_) {
      shown = false;
    }
    const usageText = await app.evaluate("(function(){const c=document.querySelector('[data-ku-open=\\\"antigravity|k_ag_1\\\"]');return c ? c.textContent.replace(/\\\\s+/g,' ').trim() : null;})()");
    const usageState = await app.evaluate(`(function () {
      const cells = [...document.querySelectorAll('[data-ku-open]')].map((c) => c.getAttribute('data-ku-open') + ': ' + c.textContent.replace(/\\s+/g, ' ').trim());
      return { cells: cells.slice(0, 6) };
    })()`);
    check('the allowance is read and shown', shown === true, `${String(usageText)} ${JSON.stringify(usageState)}`);

    // The drawer: the grouped limits, a weekly and a five-hour one per group.
    await app.evaluate(`(() => {
      const cell = document.querySelector('[data-ku-open="antigravity|k_ag_1"]');
      if (cell) cell.click();
      return !!cell;
    })()`);
    let drawerText = null;
    try {
      await app.waitFor("(function(){const d=document.getElementById('ku-drawer');return !!d && !d.hidden && /Weekly Limit/.test(d.textContent);})()", 30000);
      drawerText = await app.evaluate("(function(){const d=document.getElementById('ku-drawer');return d ? d.textContent.replace(/\\s+/g,' ').trim() : null;})()");
    } catch (_) {
      drawerText = null;
    }
    check('the drawer shows the weekly limit of each group', Boolean(drawerText && drawerText.includes('Gemini Models · Weekly Limit')), String(drawerText).slice(0, 200));
    check('the drawer shows the five-hour limit of each group', Boolean(drawerText && drawerText.includes('Claude and GPT models · Five Hour Limit')), String(drawerText).slice(0, 200));
    await app.evaluate(`(() => { const b = document.getElementById('ku-close'); if (b) b.click(); return true; })()`);

    // The chat: the request goes out in the service's shape, and the answer
    // comes back and is shown.
    await app.evaluate(`(() => {
      const all = document.querySelector('#btn-select-all');
      if (all) all.click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 400));
    await app.evaluate(`(() => { document.querySelector('#btn-test-all').click(); return true; })()`);
    let done = false;
    try {
      await app.waitFor(`(function () {
        const table = document.querySelector('#results-table');
        if (!table) return false;
        const rows = table.querySelectorAll('tbody tr');
        if (!rows.length) return false;
        return ![...rows].some((r) => r.querySelector('.status-dot-badge.running') || r.querySelector('.status-dot-badge.queued'));
      })()`, 60000);
      done = true;
    } catch (_) {
      done = false;
    }
    const response = await app.evaluate("(function(){const c=document.querySelector('#results-table .cell-response');return c ? c.textContent.replace(/\\\\s+/g,' ').trim() : null;})()");
    check('the model test finishes', done === true);
    check('the answer is shown', /mock answer for/.test(String(response)), String(response));

    const chatCalls = mock.requests.filter((r) => r.path === '/v1internal:generateContent');
    check('the chat went out in the service\'s shape', chatCalls.length > 0);
    const envelope = chatCalls[0] ? JSON.parse(chatCalls[0].body || '{}') : {};
    check('the request carries the envelope', envelope.project === 'aicode-consumers' && !!envelope.request && !!envelope.request.contents,
      JSON.stringify(envelope).slice(0, 160));
    check('the request carries the client the service expects', /antigravity\//.test(String(chatCalls[0] && chatCalls[0].headers['user-agent'] || '')),
      chatCalls[0] && chatCalls[0].headers['user-agent']);
  } finally {
    if (app) {
      try { await app.close(); } catch (_) { /* the app may already be gone */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

const mock = await startMock();
try {
  await checkSignIn(mock);
  await checkApp(mock);
} finally {
  await mock.close();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log('ALL ANTIGRAVITY CHECKS PASSED');
