# Antigravity — Provider Reference

Antigravity is the entitlement the **Google Antigravity IDE** carries: a plain
Google account, a daily allowance per model, and an API behind it that is
Google's Cloud Code Assist service. The app talks to that service in its own
protocol, because the service does not speak OpenAI.

Evidence, by kind:

- **DOC** — the service's shape, read from three working open-source
  implementations of it (antigravity-pool, CLIProxyAPI's `antigravity`
  provider, and the antigravity-proxy), cross-checked against each other.
  The routes, the envelope, the headers, the model list and the quota are
  theirs, not guesses.
- **LIVE (2026-10-20)** — `node scripts/live/verify-antigravity.mjs` drives
  the app against a mock that speaks the service's protocol: the sign-in
  (consent page → the answer back to the app → the account stored, with its
  plan), a second account beside it, the roster (the retired and the
  internal models left out), the grouped limits (the weekly and the
  five-hour one, per group, in the drawer), and a chat whose request goes
  out in the service's shape and whose answer comes back and is shown. 45
  checks.
- **NOT PROVEN** — no real Google account was used, so the service's own
  answers to a real account (which model ids it publishes, which allowance
  it grants, whether it needs a project other than `aicode-consumers`) are
  not confirmed here. The protocol around them is.

No real key, token or account value is stored in this repo.

## 0. Summary (ملخص)

| Field (الحقل) | Value (القيمة) |
|---|---|
| Provider name (اسم المزود) | Antigravity |
| Provider URL (رابط المزود) | https://antigravity.google/ — Google's Antigravity IDE |
| API base (قاعدة الـ API) | `https://daily-cloudcode-pa.googleapis.com` |
| Icon URL (مسار الأيقونة) | `src/assets/providers/antigravity.svg` — in repo |
| Provider type (نوع المزود) | OAUTH — a Google account; there is no key to paste |
| Type color dot (لون النوع) | OAuth (var(--type-oauth)) |
| Consumption (الاستهلاك) | a weekly allowance and a five-hour one, per group of models (Gemini, Claude and GPT) |
| Plans (الخطط) | `Free` / `Pro` / `Ultra` — the account's own Google One subscription, on the badge |
| Key-fetchable: plan/quota/reset/expiry (بالمفتاح) | Yes — the plan, the grouped limits and their reset times, read with the account |
| Needs web session (يحتاج جلسة ويب) | No — the app holds a token and renews it by itself |
| Several accounts (تعدد الحسابات) | Yes — one Google account is one key, each with its own allowance |

## 1. Overview

The service is Google's Cloud Code Assist API. Five routes matter:

| Method | Path | What it returns |
|---|---|---|
| `POST` | `/v1internal:fetchAvailableModels` | the models the account may call, which of them are on their way out, and each one's remaining allowance |
| `POST` | `/v1internal:retrieveUserQuotaSummary` | the grouped limits: a weekly one and a five-hour one, per group of models |
| `POST` | `/v1internal:generateContent` | a chat answer (Gemini-shaped, inside an envelope) |
| `POST` | `/v1internal:streamGenerateContent?alt=sse` | the same, as a stream |
| `POST` | `/v1internal:loadCodeAssist` | which project the account is on, and which plan it holds |

The three front doors are the same service: `daily-cloudcode-pa.googleapis.com`
(the one the app uses), `cloudcode-pa.googleapis.com`, and
`daily-cloudcode-pa.sandbox.googleapis.com`. The provider's base URL can be
pointed at any of them; the app refuses a base URL that is not one of the
provider's own (§7).

**The daily host matters.** The front door without the `daily-` prefix
answers `remainingFraction: 1` for the Gemini models — always "100% free" —
and the real limits are enforced at the group level. The app uses the daily
host so the numbers it shows are the numbers the service enforces.

### The request

The service wants a Gemini-shaped request inside an envelope, and it wants
the client to say who it is:

```jsonc
{
  "project": "aicode-consumers",
  "model": "gemini-3-pro-high",
  "request": {
    "contents": [{ "role": "user", "parts": [{ "text": "Hello" }] }],
    "systemInstruction": { "parts": [{ "text": "You are a helpful AI assistant." }] },
    "generationConfig": { "maxOutputTokens": 1024 }
  },
  "requestType": "agent",
  "userAgent": "antigravity",
  "requestId": "agent-<32 hex chars>"
}
```

The headers matter as much as the body: the service checks the client.

| Header | Value |
|---|---|
| `Authorization` | `Bearer <the account's access token>` |
| `User-Agent` | `antigravity/1.11.5 windows/amd64` |
| `X-Goog-Api-Client` | `google-cloud-sdk vscode_cloudshelleditor/0.1` |
| `Client-Metadata` | `{"ideType":"ANTIGRAVITY","platform":"WINDOWS","pluginType":"GEMINI"}` |

### The answer

```jsonc
{
  "response": {
    "candidates": [{ "content": { "parts": [{ "text": "…" }] }, "finishReason": "STOP" }],
    "usageMetadata": { "promptTokenCount": 12, "candidatesTokenCount": 8, "totalTokenCount": 20 }
  }
}
```

The answer is wrapped: `response` holds the Gemini answer. A part marked
`thought: true` is the model's thinking, not its answer.

## 2. The sign-in

A plain Google sign-in, with the OAuth client the Antigravity IDE itself
ships with (a public client id — it identifies the app, never the person).

| | |
|---|---|
| Consent page | `https://accounts.google.com/o/oauth2/v2/auth` |
| Token address | `https://oauth2.googleapis.com/token` |
| Scopes | `openid email profile`, `cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`, `experimentsandconfigs` |
| Grant | authorization code, offline (`access_type=offline`), with the account chooser (`prompt=consent select_account`) |

The access token lasts an hour. The refresh token does not — that is what
keeps the account working without the person signing in again.

The account's own facts (the email that names the account in the app) come
from the `id_token` the token endpoint hands back, read for its `email`
claim. One address, one answer: the token does not travel to a second place
to learn who the account is.

## 3. The allowance and the plan

`retrieveUserQuotaSummary` is the endpoint the Antigravity app itself reads.
It answers with the limits, grouped the way the app groups them:

```jsonc
{
  "groups": [
    {
      "displayName": "Gemini Models",
      "description": "Models within this group: Gemini Flash, Gemini Pro",
      "buckets": [
        { "displayName": "Weekly Limit", "window": "7d", "remainingFraction": 0.07, "resetTime": "2026-10-23T14:00:00Z" },
        { "displayName": "Five Hour Limit", "window": "5h", "remainingFraction": 0, "resetTime": "2026-10-20T22:00:00Z" }
      ]
    },
    { "displayName": "Claude and GPT models", "buckets": [ /* the same two windows */ ] }
  ]
}
```

The service publishes what is **left**; the app shows what was **used** (the
Antigravity app's own wording: "93% used"). The account row carries one bar
per group — the group's tightest window — and the drawer lists every window
of every group, with the time it resets.

`loadCodeAssist` says which plan the account is on. It reports two tiers:
`currentTier` is the Cloud Code Assist one, always `free-tier` for a
consumer account, and `paidTier` carries the Google One subscription the
account actually holds. The subscription is the one a person recognises, so
it wins, and the app shows it on the account's badge: **Free**, **Pro** or
**Ultra**. An account that cannot be asked keeps the safe answer: Free.

## 4. The model list

`fetchAvailableModels` answers with the whole catalogue, the same one for
every account, plus a `deprecatedModelIds` map naming the models that are on
their way out and what replaces them. The app's list is the official app's
list, not that raw answer:

- a model the service has retired is not offered (the official app does not
  offer it either — it is what answers "no longer available");
- the models the service keeps for itself (`chat_*`, `tab_*`) are not
  offered;
- a model of a family the account has no group for is not offered: the
  groups are the service's own answer about what the account can call, so a
  free account does not see the Claude and GPT models.

## 5. Errors

| What the service says | What the app does |
|---|---|
| `429` / `RESOURCE_EXHAUSTED`, "quota exceeded" | the model's allowance is spent; the run moves to the next model, and the model is remembered as spent until the reset time |
| `403` on a model | the model is refused for this account; the run moves on |
| `401` | the token is dead: the app renews it (see §7) and the next request goes out with a fresh one |

## 6. What the app implements

| Hook | What it does |
|---|---|
| `meta.oauth` | `{ kind: 'loopback', profile: 'antigravity' }` — the browser sign-in (§7) |
| `fetchModels` | the service's roster through the wire, minus the retired and the internal models, minus the families the account cannot call |
| `fetchKeyUsage` | the grouped limits: a weekly and a five-hour allowance per group, each with its reset time, and the plan on the drawer |
| `readQuotaError` | a spent allowance is named as such, with the model in the message |
| `buildChatRequest` / `parseChatResponse` | the service's own request and answer, through the app's wire |

The plan badge on the account row is the account's own tier, read at sign-in
and again at every renewal (a plan can change while the account is
connected).

## 7. §7 — How the app implements it

The app treats Antigravity in two halves, because the service is not an
OpenAI provider.

**The wire** (`src/wire/antigravity.js`) is the whole of the service's
protocol: it builds the request the service understands and reads the answer
it sends back. It lives in **main**, not in the page, for one reason — the
app's own routing gateway (`src/router`) forwards to upstreams from main and
has to speak the same protocol the page does. One implementation, two
callers. The page reaches it through `wireBuild` / `wireParse`
(`src/preload.js`); main uses it directly. The provider's own address comes
from the database and never from the page, so a key can only ever travel to
the provider it belongs to.

**The sign-in** is the app's third OAuth grant, `loopback`
(`src/oauth/loopback.js`):

1. The app opens the consent page in the person's own browser.
2. The provider sends the answer back to a short-lived address on this
   machine (`127.0.0.1`, a port the OS picks, for one sign-in).
3. The app exchanges the code for the tokens and stores the account: the
   access token as the credential, the refresh token beside it.
4. The page that comes back says what happened and closes itself. The app
   window comes back to the front by itself.

The answer is only accepted when its `state` matches the sign-in that asked
for it, so an answer from anywhere else is refused before any code is
exchanged.

**The account keeps itself alive**: main sweeps the accounts it holds every
minute and renews a token that is about to expire (five minutes of lead). A
renewal replaces the two secret columns only: the row's name, its place and
whether it is on belong to the person.

**The account knows itself**: at sign-in, and again at every renewal, the
app asks the service which project the account is on and which plan it
holds, and keeps the answer with the account. The plan is the badge on the
account row; the project is what the request is billed to.

**Several accounts**: one Google account is one key, so several accounts are
several keys, each with its own allowance, and the router may use them one
after another. Signing in again with the same account replaces that account's
row rather than doubling it.

**The OAuth client is main's** (`src/oauth/profiles.js`). The page names a
profile and never supplies an address, so code that managed to run in the
renderer cannot point a sign-in — and the authorization code that comes back
from it — at a host of its choosing.

## 7. Limits and notes

- The service's own answers to a real account are not proven here (§ *NOT
  PROVEN*). The protocol around them is.
- The model ids the service publishes change with it; the app shows what
  the service says and does not keep a list of its own.
- The service wants a `project`. The app sends `aicode-consumers` — the
  project every consumer account is on — and the account's own project is
  stored with it when the service names one.
- The `Client-Metadata` header names the IDE the client claims to be. The
  app claims the same client the IDE ships, because the service checks it.
