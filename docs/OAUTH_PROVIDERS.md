# The OAuth plane

How a provider that signs in on a web page is added to the app, and what the
app does with the account afterwards.

This is a **capability**, not a provider: the first provider that uses it is
Muse AI ([docs/integrations/MUSE.md](./integrations/MUSE.md)). Everything below
describes the code as it is now.

## Why it exists

Until now every provider was given a key: the person pasted a string, the app
encrypted it, and every request carried it as a bearer credential. A provider
that signs in on a web page has no such string. The person signs in on the
provider's page, and what comes back is a token that expires.

Three things follow, and they shape everything else here:

1. **The flow needs a browser.** The app opens the provider's page and waits.
2. **The token has a life.** It expires, and something must renew it.
3. **The quota often lives behind the token, not behind the credential.** The
   credential the API is called with cannot read the account's allowance; the
   token can.

The device grant (RFC 8628) is the shape that fits a desktop app best: the
app asks the provider for a code, opens the provider's page with that code
already in the address, and polls until the person approves. There is no
redirect, no local callback listener and no custom protocol handler — the
three things a desktop app would otherwise have to own.

## The shape of a signed-in account

A signed-in account **is a provider key**. One row in `provider_keys`, the
same request path, the same routing, the same panels. Migration v7 added two
columns beside the credential:

| Column | What it holds | Encrypted |
|---|---|---|
| `cipher` | the credential the API is called with | yes |
| `oauth_cipher` | the access token the sign-in produced | yes |
| `oauth_meta_json` | the account's public facts: email, plan, the published usage windows | no |

Two placeholders cross the wire, and the renderer holds neither secret:

| Placeholder | Stands for | Resolved by |
|---|---|---|
| `venomkey:<keyId>` | the credential | `src/db/keys.js` |
| `venomoauth:<keyId>` | the access token | `src/db/keys.js` |

The resolver swaps in the real value just before sending, and only when the
request goes to that secret's own origin — the same rule every other secret
follows. A request that carries `venomoauth:<id>` to another host is refused
before the cipher is touched.

The renderer sees the account's public facts (`k.account`) and the
placeholder (`k.oauthKey`), and that is all.

## The flow

```
 the person                the app (renderer)              main
    |                          |                           |
    |  press Connect           |                           |
    |------------------------->|                           |
    |                          |  oauth-start (the flow    |
    |                          |  declared as plain data)  |
    |                          |-------------------------->|
    |                          |                           |  device code
    |                          |                           |  -> the page opens
    |  the provider's page     |                           |     in the browser
    |<--------------------------------------------------    |
    |  sign in, approve        |                           |
    |                          |  oauth-status (every 2s)  |
    |                          |-------------------------->|
    |                          |                           |  the token
    |                          |                           |  -> the credential
    |                          |                           |  -> the account row
    |                          |  oauth-status: done       |
    |                          |<--------------------------|
    |                          |  the configuration is read again,
    |                          |  the account is on screen  |
```

The four channels (`src/oauth/ipc.js`, exposed in `src/preload.js`):

| Channel | Does | Locked app |
|---|---|---|
| `oauth-start` | starts the sign-in, opens the page | refused (`{ ok: false, code: 'LOCKED' }`) |
| `oauth-status` | the state of the sign-in | answers (a read) |
| `oauth-cancel` | gives up on the sign-in | refused |
| `oauth-reopen` | opens the page again | refused |
| `oauth-usage` | reads the account's usage again | refused |
| `oauth-renew` | renews an account whose token has grown old | refused |

A sign-in mints a credential, so it is the owner's to give: the channels
that act are gated on the app lock, like `copy-key` and `api-request`.

## The three grants

| Kind | How the person signs in | Used by |
|---|---|---|
| `device` | a code to type on the provider's page | Muse AI |
| `web` | a window the app owns (the account's session is the credential) | — |
| `loopback` | the provider's own page in the person's own browser, and the answer comes back to a short-lived address on this machine | Antigravity |

The `loopback` grant, in full:

```
  the person                the app (renderer)              main
     |                          |                           |
     |  press Connect           |                           |
     |------------------------->|                           |
     |                          |  oauth-start ('loopback') |
     |                          |-------------------------->|
     |                          |                           |  a short-lived
     |                          |                           |  address on this
     |  the consent page        |                           |  machine
     |<--------------------------------------------------    |
     |  sign in, approve        |                           |
     |                          |                           |  the answer comes
     |  the tab comes back      |                           |  back to that
     |<----------------------   |                           |  address
     |  the tab closes itself   |  oauth-status: done       |  the code is
     |                          |<--------------------------|  exchanged
     |                          |  the configuration is read again,
     |                          |  the account is on screen  |
```

Four things make it what it is:

- **The answer is tied to the sign-in.** The consent page carries a random
  `state`; the app refuses an answer whose state is not the one it sent. An
  answer from anywhere else never reaches the token exchange.
- **The address is short-lived and local.** `127.0.0.1` only, on a port the
  operating system picks, and it lives for exactly one sign-in.
- **The page that comes back closes itself.** It says what happened and asks
  to be closed; the app's window comes back to the front by itself. A
  browser that refuses to let a page close its own tab leaves the last line
  on screen — the sign-in is already done either way.
- **The OAuth client belongs to main** (`src/oauth/profiles.js`). The page
  names a profile and never supplies an address, so code that managed to run
  in the renderer cannot point a sign-in — and the authorization code that
  comes back from it — at a host of its choosing. A profile also lists the
  origins its credential may be used against, and a provider whose base URL
  is not one of them is refused.

## The declaration

The provider module declares its own flow as plain data, in `meta.oauth`. The
`device` grant looks like this:

```js
oauth: {
  kind: 'device',
  clientId: '…',
  deviceEndpoint: 'https://…/device/authorization/',
  tokenEndpoint: 'https://…/device/token/',
  grantType: 'urn:ietf:params:oauth:grant-type:device_code',
  userAgent: '…',
  exchange: {
    url: 'https://…/key',          // where the access token is sent
    method: 'POST',
    headers: { Authorization: 'Bearer {access_token}' },
    body: { dca_token: '{access_token}' },
    pick: { secret: 'api_key' },    // which field is the credential
    meta: { email: 'user_email', tier: 'subs_tier_name', usage: 'subs_usage' },
  },
}
```

The `loopback` grant declares **which profile to use**, and nothing else:

```js
oauth: { kind: 'loopback', profile: 'antigravity' }
```

The addresses, the client and the scopes are in main's profile
(`src/oauth/profiles.js`), not in the page.

Main **checks the declaration before it uses it**
(`src/oauth/device-flow.js` and `src/oauth/loopback.js`, `normalise`):

- the endpoints must be `https` (or the loopback interface itself);
- the exchange address must be on **the provider's own origin** — the one
  the app already trusts for that provider's keys — because that is where the
  access token is about to be sent. A declaration that points anywhere else
  is refused, and the browser never opens;
- for `loopback`, the provider's base URL must be one of the origins the
  profile lists, because the credential is sent there.

A refusal is a plain `{ ok: false, code, message }`, not an exception: the
renderer shows the reason and nothing else happens.

## What is in main

| File | What it owns |
|---|---|
| `src/oauth/http.js` | its own HTTP client — the OAuth requests carry real secrets and must not travel through `src/api-request.js`, which records every request in the request log |
| `src/oauth/device-flow.js` | the device grant: the declaration check, the device code, the poll, the exchange |
| `src/oauth/loopback.js` | the loopback grant: the declaration check, the consent page, the short-lived address, the exchange, the renewal, the page that closes itself |
| `src/oauth/profiles.js` | the OAuth clients the app ships with — the addresses, the client id and the scopes. Main's own, never the page's |
| `src/oauth/index.js` | the manager: the session, the poll loop, the storage of the finished account, the renewal sweep |
| `src/oauth/ipc.js` | the channels |

The manager keeps one session per provider. The poll waits the provider's own
interval between attempts, stops on `authorization_pending`, slows down on
`slow_down`, and gives up on `access_denied`, `expired_token` or the code's
expiry. Everything stops when the app quits.

The manager also **renews the accounts it holds**: every minute it looks at
the accounts whose token is close to the end of its life and renews them,
five minutes before they die. An account that carries a renewal token (the
`loopback` grant does) keeps working without the person signing in again; a
renewal replaces the two secret columns and nothing else — the row's name,
its place and whether it is on belong to the person.

## What is in the renderer

| File | What it owns |
|---|---|
| `src/renderer/oauth-connect.js` | the Connect button's flow: start, show the code, wait, report |
| `src/renderer/providers/muse.js` | the provider's own declaration and its hooks |
| `src/renderer/provider-detail.js` | the panel: "Accounts" instead of "API keys", Connect instead of Add |
| `src/renderer/provider-keys.js` | the account's row: the plan as a badge beside the account's name |

After the sign-in the configuration is read again from main
(`loadAllProviders`) — the page's copy of the providers is stale until it is,
because the account row was written by main.

## What the app deliberately does not do

- **It does not close a browser tab it did not open.** For the `device` and
  `web` grants the app has no say over the browser. The `loopback` grant is
  the one case where the page that comes back closes itself — and a browser
  that refuses still leaves the sign-in done.
- **It does not renew a credential it cannot renew.** A provider that hands
  over a renewal token (the `loopback` grant) has its accounts renewed by
  the app; a provider that hands over only a long-lived credential is signed
  in again when that credential stops working.
- **It does not show the per-minute rate limit as the allowance.** The
  rate-limit headers and the account's weekly allowance are two different
  numbers; showing one next to the other reads as one thing.

## Adding another provider that signs in

1. Declare the flow in `meta.oauth` (see above) and set `auth: ['oauth']`.
2. Make sure the exchange address is on the provider's own origin. For the
   `loopback` grant, add a profile to `src/oauth/profiles.js` and name it.
3. If the account's allowance lives behind the token, implement
   `fetchKeyUsage` and ask for the token as `oauthKey` — the placeholder
   main swaps for the real one.
4. If the provider refuses an exhausted allowance in a way the app cannot
   recognise, implement `readQuotaError`.
5. If the provider does not speak OpenAI, give it a wire
   (`src/wire/<id>.js`): the request it understands and the answer it sends
   back. The page and the routing gateway then share one implementation.
6. The built-in count in the live checks goes up by one (§7 of the cookbook).

The declaration is checked by main's own validator, and
`test/renderer/muse-provider.test.js` shows the shape: the module's
declaration is run through `normalise` in the test, so a module and the
validator cannot drift apart unnoticed.
