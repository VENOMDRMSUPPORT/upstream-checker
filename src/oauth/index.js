// ============================================
// OAuth — the manager main keeps
// ============================================
// One sign-in at a time per provider. The renderer asks to start a connect,
// this opens the provider's page in the user's browser and keeps polling in
// the background; the renderer asks for the status until the account is
// there.
//
// What never leaves main: the device code and the access token. What is
// stored: the credential the API uses (encrypted, like every other key) and
// the account's public facts. The access token is stored too, encrypted, in
// its own column — it is what lets the account be read again later (a quota
// reading needs it) and what lets a new credential be minted if the old one
// stops working.
const flow = require('./device-flow');
const web = require('./web-session');
const loopback = require('./loopback');
const { getProfile } = require('./profiles');
const wire = require('../wire');
const realHttp = require('./http');

// The polling stops when the session ends, the app quits, or the provider
// says the code expired. The cap is the provider's own expiry when it gives
// one, and 15 minutes otherwise — the same ceiling the device grant itself
// uses in practice.
const MAX_SESSION_MS = 15 * 60 * 1000;

// How often the app looks at the accounts it holds, and how close to the end
// of its life an access token has to be before it is renewed. Google access
// tokens last an hour; renewing them five minutes early means a request
// never travels with a token that is about to die.
const RENEWAL_SWEEP_MS = 60 * 1000;
const RENEWAL_LEAD_MS = 5 * 60 * 1000;

function createOAuthManager({ repos, openExternal, log = console, http = realHttp, now = Date.now, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, BrowserWindow = null, parentWindow = null, webSessionTimeoutMs = web.DEFAULT_WAIT_MS, focusWindow = null } = {}) {
  // providerId → the session. One live sign-in per provider.
  const sessions = new Map();

  function sessionOf(providerId) {
    return sessions.get(providerId) || null;
  }

  function publicState(session) {
    if (!session) return { state: 'idle' };
    return {
      state: session.state,
      providerId: session.providerId,
      kind: session.kind || 'device',
      userCode: session.userCode,
      verificationUri: session.verificationUri,
      verificationUriComplete: session.verificationUriComplete,
      startedAt: session.startedAt,
      expiresAt: session.expiresAt,
      error: session.error || null,
      account: session.account || null,
    };
  }

  function stopSession(session) {
    if (!session || session.timer) {
      if (session && session.timer) clearTimeoutFn(session.timer);
      session.timer = null;
    }
    // A sign-in that opened an address on this machine gives it back.
    if (session && session.server) {
      try { session.server.close(); } catch (_) { /* closing anyway */ }
      session.server = null;
    }
    session.cancelled = true;
  }

  // The poll loop. Every step is awaited in sequence so a slow answer never
  // overlaps the next one; the provider's interval is the pause between
  // attempts.
  async function poll(session) {
    const { config, device } = session;
    const deadline = Math.min(session.expiresAt, now() + MAX_SESSION_MS);
    while (!session.cancelled) {
      if (now() >= deadline) {
        session.state = 'failed';
        session.error = { code: 'expired', message: 'The sign-in code expired before it was approved' };
        return;
      }
      await sleep(session.waitMs);
      if (session.cancelled) return;
      let answer;
      try {
        answer = await flow.pollDeviceToken({ http, config, deviceCode: device.deviceCode });
      } catch (err) {
        answer = { ok: false, error: 'network', description: err.message };
      }
      if (session.cancelled) return;
      if (answer.ok) {
        await complete(session, answer.accessToken, answer.expiresIn);
        return;
      }
      if (answer.error === 'network') continue; // a dropped poll is not an answer
      if (answer.error === 'slow_down') {
        // The provider asked us to slow down.
        session.waitMs = Math.min(session.waitMs * 2, 30000);
        continue;
      }
      if (answer.error === 'authorization_pending') continue;
      session.state = 'failed';
      session.error = { code: answer.error || 'denied', message: answer.description || 'The sign-in was not approved' };
      return;
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => { setTimeoutFn(resolve, ms); });
  }

  // The access token becomes the credential the API uses, and the account is
  // saved. A failure here is a failed sign-in, not a half-connected account.
  async function complete(session, accessToken, expiresIn) {
    let exchanged;
    try {
      exchanged = await flow.exchange({ http, config: session.config, accessToken });
    } catch (err) {
      exchanged = { error: err.message };
    }
    if (session.cancelled) return;
    if (!exchanged || exchanged.error) {
      session.state = 'failed';
      session.error = { code: 'exchange_failed', message: (exchanged && exchanged.error) || 'The account could not be read' };
      return;
    }
    const account = exchanged.account || {};
    const meta = {
      email: account.email || '',
      name: account.name || '',
      tier: account.tier || '',
      tierId: account.tierId || '',
      subsActive: account.subsActive === true,
      baseUrl: account.baseUrl || '',
      usage: account.usage || null,
      accessExpiresAt: expiresIn > 0 ? now() + expiresIn * 1000 : 0,
      connectedAt: now(),
    };
    let saved;
    try {
      saved = repos.providers.saveOAuthAccount({
        providerId: session.providerId,
        name: account.email || account.name || session.providerName || 'Account',
        secret: exchanged.secret,
        oauthSecret: accessToken,
        meta,
      });
    } catch (err) {
      session.state = 'failed';
      session.error = { code: 'save_failed', message: err.message };
      return;
    }
    session.state = 'done';
    session.account = {
      keyId: saved.id,
      email: meta.email,
      name: meta.name,
      tier: meta.tier,
    };
  }

  // Start a sign-in: the provider's own page opens in the user's browser and
  // the approval is waited for here.
  async function start(providerId, rawConfig) {
    const provider = repos.providers.get(providerId);
    if (!provider) return { ok: false, code: 'UNKNOWN_PROVIDER', message: 'That provider is not in the database' };

    // A provider that signs in on its own page is a different flow: the page
    // opens in a window the app owns, and the account's session is the
    // credential.
    if (rawConfig && rawConfig.kind === 'web') return startWeb(providerId, provider, rawConfig);
    // A provider that signs in on a web page in the person's own browser:
    // the consent page opens there, the answer comes back to a short-lived
    // address on this machine, and the tab closes itself.
    if (rawConfig && rawConfig.kind === 'loopback') return startLoopback(providerId, provider, rawConfig);

    let config;
    try {
      config = flow.normalise(rawConfig, { providerBaseUrl: provider.baseUrl });
    } catch (err) {
      // A sign-in this build does not know: the provider asked for a flow
      // that is not in the app. Saying so is more use than a message about
      // the wrong grant.
      if (rawConfig && rawConfig.kind && rawConfig.kind !== 'device') {
        return { ok: false, code: 'UNKNOWN_FLOW', message: `This app does not know the "${rawConfig.kind}" sign-in — update or restart the app and try again.` };
      }
      return { ok: false, code: 'BAD_CONFIG', message: err.message };
    }

    const previous = sessionOf(providerId);
    if (previous && previous.state === 'pending') {
      return { ok: false, code: 'BUSY', message: 'A sign-in for this provider is already running' };
    }
    if (previous) stopSession(previous);

    let device;
    try {
      device = await flow.startDeviceFlow({ http, config });
    } catch (err) {
      return { ok: false, code: 'START_FAILED', message: err.message };
    }

    const session = {
      providerId,
      providerName: provider.name,
      config,
      device,
      state: 'pending',
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      verificationUriComplete: device.verificationUriComplete,
      startedAt: now(),
      expiresAt: now() + device.expiresIn * 1000,
      waitMs: Math.max(1000, device.interval * 1000),
      error: null,
      account: null,
      cancelled: false,
      timer: null,
    };
    sessions.set(providerId, session);

    // The page opens in the user's own browser: the app never sees the
    // password, and the provider gets the sign-in it expects.
    try {
      await openExternal(device.verificationUriComplete);
    } catch (err) {
      // A page that does not open is a failed sign-in: there is nothing to
      // approve, so the session says so instead of waiting for ever.
      session.state = 'failed';
      session.error = { code: 'OPEN_FAILED', message: `The sign-in page could not be opened: ${err.message}` };
      log.warn('OAuth: the sign-in page could not be opened:', err && err.message);
      return { ok: false, code: 'OPEN_FAILED', message: session.error.message };
    }

    poll(session).catch((err) => {
      session.state = 'failed';
      session.error = { code: 'failed', message: err.message };
    });

    return {
      ok: true,
      userCode: session.userCode,
      verificationUri: session.verificationUri,
      verificationUriComplete: session.verificationUriComplete,
      expiresAt: session.expiresAt,
    };
  }

  // A provider that signs in on a web page in the person's own browser. The
  // app opens the consent page there; the provider sends the answer back to a
  // short-lived address on this machine; the app takes the tokens from there
  // and the tab closes itself. The person signs in once and everything after
  // it happens in the app.
  async function startLoopback(providerId, provider, rawConfig) {
    const profileName = (rawConfig && rawConfig.profile) || providerId;
    const profile = getProfile(profileName);
    if (!profile) {
      return { ok: false, code: 'NO_PROFILE', message: 'The app does not ship a sign-in for this provider' };
    }
    let config;
    try {
      config = loopback.normalise(rawConfig, { profile });
    } catch (err) {
      return { ok: false, code: 'BAD_CONFIG', message: err.message };
    }
    // The access token is sent to the provider's own API and nowhere else, so
    // a provider whose base URL points at another host would carry it there.
    const base = flow.originOf(provider.baseUrl);
    if (!base || !config.apiOrigins.includes(base)) {
      return { ok: false, code: 'WRONG_ORIGIN', message: 'This provider points at an address its sign-in does not cover — check the provider\'s base URL' };
    }
    const previous = sessionOf(providerId);
    if (previous && previous.state === 'pending') {
      return { ok: false, code: 'BUSY', message: 'A sign-in for this provider is already running' };
    }
    if (previous) stopSession(previous);

    const state = loopback.newState();
    const server = loopback.createCallbackServer({
      log,
      handle: (query) => handleLoopbackCallback(providerId, provider, config, state, query),
    });
    let address;
    try {
      address = await server.listen();
    } catch (err) {
      server.close();
      log.warn('OAuth: the sign-in address could not be opened:', err && err.message);
      return { ok: false, code: 'START_FAILED', message: 'The sign-in address could not be opened on this machine' };
    }

    const session = {
      providerId,
      providerName: provider.name,
      config,
      kind: 'loopback',
      state: 'pending',
      userCode: '',
      verificationUri: '',
      verificationUriComplete: '',
      startedAt: now(),
      expiresAt: now() + loopback.DEFAULT_WAIT_MS,
      error: null,
      account: null,
      cancelled: false,
      timer: null,
      server,
      oauthState: state,
      redirectUri: address.redirectUri,
    };
    sessions.set(providerId, session);

    const authUrl = loopback.buildAuthUrl(config, { state, redirectUri: address.redirectUri });
    session.verificationUri = authUrl;
    session.verificationUriComplete = authUrl;

    try {
      await openExternal(authUrl);
    } catch (err) {
      // A page that does not open is a failed sign-in: there is nothing to
      // approve, so the session says so instead of waiting for ever.
      session.state = 'failed';
      session.error = { code: 'OPEN_FAILED', message: `The sign-in page could not be opened: ${err.message}` };
      log.warn('OAuth: the sign-in page could not be opened:', err && err.message);
      server.close();
      return { ok: false, code: 'OPEN_FAILED', message: session.error.message };
    }

    return { ok: true, userCode: '', verificationUri: authUrl, kind: 'loopback' };
  }

  // The answer the provider sent back. The state has to match the sign-in
  // that asked for it: an answer with another state — or none — is refused
  // before any code is exchanged.
  async function handleLoopbackCallback(providerId, provider, config, state, query) {
    const session = sessionOf(providerId);
    if (!session || session.oauthState !== state) {
      return { ok: false, message: 'This sign-in did not come from VENOM Router.' };
    }
    if (query.error) {
      const message = query.error_description || query.error || 'The sign-in was not approved.';
      session.state = 'failed';
      session.error = { code: String(query.error).slice(0, 100), message };
      return { ok: false, message };
    }
    if (!query.code) {
      session.state = 'failed';
      session.error = { code: 'NO_CODE', message: 'The provider sent no sign-in code.' };
      return { ok: false, message: session.error.message };
    }
    let tokens;
    try {
      tokens = await loopback.exchangeCode({ http, config, code: query.code, redirectUri: session.redirectUri });
    } catch (err) {
      tokens = { error: err.message };
    }
    if (session.cancelled) return { ok: false, message: 'The sign-in was cancelled.' };
    if (!tokens || tokens.error) {
      session.state = 'failed';
      session.error = { code: 'exchange_failed', message: (tokens && tokens.error) || 'The account could not be read' };
      return { ok: false, message: session.error.message };
    }

    const account = loopback.accountFromTokens(config, tokens);
    // What the account is: the project its requests are billed to, and the
    // plan it is on. A provider that speaks its own protocol answers this
    // itself; one that speaks OpenAI has nothing to say.
    const facts = await discoverAccount(providerId, provider, tokens.accessToken);
    const meta = {
      email: account.email || '',
      name: account.name || '',
      // The badge on the account is the plan, not the provider's name: Free,
      // Pro or Ultra.
      tier: (facts && facts.tierLabel) || 'Free',
      tierId: (facts && facts.tier) || 'FREE',
      plan: (facts && facts.tierName) || null,
      subsActive: true,
      baseUrl: provider.baseUrl,
      usage: null,
      oauthKind: 'loopback',
      profile: config.profileId,
      // The account carries two secrets: the access token the API is called
      // with, and the renewal token that replaces it when it grows old.
      refreshable: true,
      project: (facts && facts.project) || (config.project && config.project.default) || '',
      accessExpiresAt: tokens.expiresIn > 0 ? now() + tokens.expiresIn * 1000 : 0,
      connectedAt: now(),
    };
    let saved;
    try {
      saved = repos.providers.saveOAuthAccount({
        providerId,
        name: account.email || account.name || provider.name || 'Account',
        secret: tokens.accessToken,
        oauthSecret: tokens.refreshToken,
        meta,
      });
    } catch (err) {
      session.state = 'failed';
      session.error = { code: 'save_failed', message: err.message };
      return { ok: false, message: session.error.message };
    }
    session.state = 'done';
    session.account = { keyId: saved.id, email: meta.email, name: meta.name, tier: meta.tier };
    // The person is in the browser; the app is where the work is. The window
    // comes back to the front by itself.
    if (typeof focusWindow === 'function') {
      try { focusWindow(); } catch (_) { /* the window may be gone */ }
    }
    return { ok: true, label: config.label };
  }

  // What an account is, asked of the provider itself. The answer is
  // best-effort: an account that cannot be asked keeps what it knows.
  async function discoverAccount(providerId, provider, accessToken) {
    try {
      const found = await wire.discover(providerId, {
        baseUrl: provider.baseUrl,
        apiKey: accessToken,
        http,
      });
      return found || null;
    } catch (err) {
      log.warn('OAuth: the account could not be asked about itself:', err && err.message);
      return null;
    }
  }

  // The account's own token, renewed. The access token the API is called with
  // is short-lived; the renewal token beside it is not, so the account keeps
  // working without the person signing in again.
  async function renewAccount(providerId, keyId) {
    const provider = repos.providers.get(providerId);
    if (!provider) return { ok: false, message: 'That provider is not in the database' };
    const key = (provider.keys || []).find((k) => k.id === keyId);
    if (!key) return { ok: false, message: 'That account is not in the database' };
    const meta = key.account || {};
    if (!meta.refreshable) return { ok: false, message: 'This account cannot be renewed' };
    const profile = getProfile(meta.profile || providerId);
    if (!profile) return { ok: false, message: 'The app does not ship a sign-in for this provider' };
    let config;
    try {
      config = loopback.normalise({ kind: 'loopback', profile: profile.id }, { profile });
    } catch (err) {
      return { ok: false, message: err.message };
    }
    const renewal = repos.providers.revealOauth(key.id);
    if (!renewal) return { ok: false, message: 'The stored renewal token cannot be read on this machine' };
    let answer;
    try {
      answer = await loopback.refreshAccessToken({ http, config, refreshToken: renewal });
    } catch (err) {
      answer = { error: err.message };
    }
    if (!answer || answer.error) {
      return { ok: false, message: (answer && answer.error) || 'The account could not be renewed' };
    }
    const nextMeta = {
      ...meta,
      accessExpiresAt: answer.expiresIn > 0 ? now() + answer.expiresIn * 1000 : 0,
      refreshedAt: now(),
    };
    // The plan can change while the account is connected, so the renewal
    // asks the provider again.
    const facts = await discoverAccount(providerId, provider, answer.accessToken);
    if (facts) {
      nextMeta.tier = facts.tierLabel || nextMeta.tier;
      nextMeta.tierId = facts.tier || nextMeta.tierId;
      nextMeta.plan = facts.tierName || nextMeta.plan;
      if (facts.project) nextMeta.project = facts.project;
    }
    try {
      repos.providers.updateOAuthAccount({
        id: key.id,
        secret: answer.accessToken,
        oauthSecret: answer.refreshToken,
        meta: nextMeta,
      });
    } catch (err) {
      return { ok: false, message: err.message };
    }
    return { ok: true, expiresAt: nextMeta.accessExpiresAt };
  }

  // Every account that is close to the end of its token's life, renewed. The
  // sweep is what makes the account work an hour later, a day later, without
  // the person ever pressing Connect again.
  async function renewAll() {
    let providers = {};
    try {
      providers = repos.providers.list() || {};
    } catch (_) {
      return;
    }
    for (const providerId of Object.keys(providers)) {
      const provider = providers[providerId];
      const keys = (provider && provider.keys) || [];
      for (const key of keys) {
        const meta = key.account || {};
        if (!key.oauth || !meta.refreshable) continue;
        const expiresAt = Number(meta.accessExpiresAt) || 0;
        // An account with no known expiry is left alone: renewing it on every
        // sweep would be a request per minute for nothing.
        if (!expiresAt) continue;
        if (expiresAt - now() > RENEWAL_LEAD_MS) continue;
        try {
          const answer = await renewAccount(providerId, key.id);
          if (!answer.ok) log.warn(`OAuth: the account "${key.name}" could not be renewed:`, answer.message);
        } catch (err) {
          log.warn('OAuth: an account could not be renewed:', err && err.message);
        }
      }
    }
  }

  let renewalTimer = null;
  function startRenewals() {
    if (renewalTimer) return;
    // The first sweep runs right away: an account whose token died while the
    // app was closed is renewed before anything uses it.
    setTimeoutFn(() => { renewAll().catch(() => {}); }, 2000);
    renewalTimer = setInterval(() => { renewAll().catch(() => {}); }, RENEWAL_SWEEP_MS);
    if (renewalTimer && typeof renewalTimer.unref === 'function') renewalTimer.unref();
  }

  function status(providerId) {
    return publicState(sessionOf(providerId));
  }

  function cancel(providerId) {
    const session = sessionOf(providerId);
    if (!session) return { ok: false, code: 'NO_SESSION', message: 'There is no sign-in running for this provider' };
    stopSession(session);
    if (session.state === 'pending') session.state = 'cancelled';
    return { ok: true };
  }

  // The page is opened again: the code is still valid, the person simply
  // needs the tab.
  async function reopen(providerId) {
    const session = sessionOf(providerId);
    if (!session || !session.verificationUriComplete) {
      return { ok: false, code: 'NO_SESSION', message: 'There is no sign-in running for this provider' };
    }
    try {
      await openExternal(session.verificationUriComplete);
      return { ok: true };
    } catch (err) {
      return { ok: false, code: 'OPEN_FAILED', message: err.message };
    }
  }

  // A provider that signs in on a web page of its own. The page opens in a
  // window the app owns (no application can read another application's
  // cookies), the person signs in there, and the app takes the session when
  // the provider says the person is signed in.
  async function startWeb(providerId, provider, rawConfig) {
    if (!BrowserWindow) {
      return { ok: false, code: 'NO_WINDOW', message: 'This build cannot open a sign-in window' };
    }
    let config;
    try {
      config = web.normalise(rawConfig);
    } catch (err) {
      return { ok: false, code: 'BAD_CONFIG', message: err.message };
    }
    const previous = sessionOf(providerId);
    if (previous && previous.state === 'pending') {
      return { ok: false, code: 'BUSY', message: 'A sign-in for this provider is already running' };
    }
    if (previous) stopSession(previous);

    const session = {
      providerId,
      providerName: provider.name,
      config,
      kind: 'web',
      state: 'pending',
      userCode: '',
      verificationUri: config.signInUrl,
      startedAt: now(),
      expiresAt: now() + web.DEFAULT_WAIT_MS,
      error: null,
      account: null,
      cancelled: false,
      timer: null,
      window: null,
    };
    sessions.set(providerId, session);

    runWebSession(session).catch((err) => {
      if (session.cancelled) return;
      session.state = 'failed';
      session.error = { code: 'failed', message: err.message };
    });

    return { ok: true, userCode: '', verificationUri: config.signInUrl, inAppWindow: true };
  }

  // The sign-in, end to end: the window, the wait, the usage and the session.
  // The window closes by itself — after the login the person does not have to
  // do anything else.
  async function runWebSession(session) {
    const win = web.openWindow({
      BrowserWindow,
      parent: parentWindow,
      config: session.config,
      providerId: session.providerId,
      title: `Sign in to ${session.providerName}`,
    });
    session.window = win;
    const close = () => {
      try { if (!win.isDestroyed()) win.destroy(); } catch (_) { /* closing anyway */ }
    };
    try {
      await win.loadURL(session.config.signInUrl).catch(() => { });
      const signed = await web.waitForSession({ window: win, config: session.config, timeoutMs: webSessionTimeoutMs });
      if (session.cancelled) return;
      if (!signed.ok) {
        session.state = 'failed';
        session.error = { code: 'NOT_SIGNED_IN', message: signed.message };
        return;
      }
      const usage = await web.readUsage({ window: win, config: session.config });
      const cookies = await web.captureCookies({ window: win, config: session.config });
      if (!cookies.ok) {
        session.state = 'failed';
        session.error = { code: 'NO_SESSION', message: cookies.message };
        return;
      }
      const meta = {
        oauthKind: 'web',
        email: signed.email || '',
        name: signed.email || session.providerName || 'Account',
        tier: '',
        tierId: '',
        subsActive: true,
        baseUrl: session.config.origin,
        usage: usage.ok ? usage.text : '',
        connectedAt: now(),
      };
      let saved;
      try {
        saved = repos.providers.saveOAuthAccount({
          providerId: session.providerId,
          name: meta.email || meta.name,
          // The credential is the session itself.
          secret: cookies.jar,
          oauthSecret: '',
          meta,
        });
      } catch (err) {
        session.state = 'failed';
        session.error = { code: 'save_failed', message: err.message };
        return;
      }
      session.state = 'done';
      session.account = { keyId: saved.id, email: meta.email, name: meta.name, tier: meta.tier };
    } finally {
      close();
    }
  }

  // Read the account's usage again, with the session the app stored. The
  // provider's page opens with that session and the provider's own steps lead
  // to the panel that shows the usage.
  async function readUsage(providerId, rawConfig) {
    const provider = repos.providers.get(providerId);
    if (!provider) return { ok: false, message: 'That provider is not in the database' };
    if (!BrowserWindow) return { ok: false, message: 'This build cannot open the account page' };
    let config;
    try {
      config = web.normalise(rawConfig);
    } catch (err) {
      return { ok: false, message: err.message };
    }
    const account = (provider.keys || []).find((k) => k.oauth);
    if (!account) return { ok: false, message: 'This provider is not connected' };
    const jar = repos.providers.revealKey(account.id);
    if (!jar) return { ok: false, message: 'The stored session cannot be read on this machine' };
    const win = web.openWindow({
      BrowserWindow,
      parent: parentWindow,
      config,
      providerId,
      title: provider.name,
    });
    try {
      await web.restoreCookies({ window: win, config, jar });
      await win.loadURL(config.signInUrl).catch(() => { });
      const signed = await web.waitForSession({ window: win, config, timeoutMs: 30000 });
      if (!signed.ok) return { ok: false, message: 'The stored session is no longer accepted' };
      const usage = await web.readUsage({ window: win, config });
      if (!usage.ok) return { ok: false, message: usage.message };
      return { ok: true, text: usage.text };
    } finally {
      try { if (!win.isDestroyed()) win.destroy(); } catch (_) { /* closing anyway */ }
    }
  }

  // Called when the app is closing: every poll stops.
  function stopAll() {
    if (renewalTimer) {
      clearTimeoutFn(renewalTimer);
      renewalTimer = null;
    }
    sessions.forEach((session) => stopSession(session));
    sessions.clear();
  }

  return { start, status, cancel, reopen, stopAll, usage: readUsage, renew: renewAccount, renewAll, startRenewals };
}

module.exports = { createOAuthManager };
