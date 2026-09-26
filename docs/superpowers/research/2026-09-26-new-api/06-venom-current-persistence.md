# VENOM Router, part 06: how persistence works today (pre-DB audit)

Date: 2026-09-26. Repo: `C:\Users\venom\Desktop\UPSTREAM CHECKER` at `ae80ccf` (v1.4.1, Electron 33).
Scope: every byte VENOM Router writes to disk, who writes it, when, and what a local embedded DB
plus a logging system must keep doing. All schemas below come from the code only. No user data file
was opened. File sizes are the known figures supplied with the task.

All paths are relative to the repo root. `app.js` = `src/renderer/app.js`, `catalog.js` =
`src/renderer/catalog.js`, and so on.

---

## 0. Summary

- Four app-owned files live in `%APPDATA%\venom-router\` (`src/user-data.js:9-24`, `src/main.js:18-23`):
  `config.json` (7.7 KB), `history.json` (103 KB), `catalog.json` (298 KB), `requests.log` (572 KB,
  plus `requests.log.1`). Each gets a `.tmp` sibling during writes. electron-log writes
  `logs\main.log` in the same folder. Chromium adds `Local Storage\` (one key) and `Local State`
  (holds the safeStorage master key).
- **Every JSON store is a whole-file rewrite.** Only `requests.log` is appended to.
- Main process owns all file I/O. All of it is **synchronous** (`fs.*Sync`) on the main thread.
- The renderer holds every store in memory as a plain object and treats main as a dumb blob store:
  `readConfig` → mutate → `writeConfig`, and `catalog.json` is shipped **whole** over IPC on every
  debounced save.
- Keys are encrypted per entry with `safeStorage` (`enc:v1:` + base64). They are decrypted in main
  on **every** `read-config`, then sent to the renderer **in plaintext**, because the renderer builds
  the `Authorization` header. The Artificial Analysis key (`settings.aaApiKey`) is **not encrypted**.
- Writes use temp-file + rename (atomic replace), but there is no fsync, no backup, no
  single-instance lock, and no flush on quit. A corrupt `config.json` is read as "empty" and then
  **overwritten** by the startup provider seeding, which destroys every stored key (see 4.3).

---

## 1. Store inventory

### 1.1 Overview table

| Store | Location | Owner (I/O) | Format | Write style | Version field | Size today | Bounded? |
|---|---|---|---|---|---|---|---|
| `config.json` | userData | main (`main.js:37-103`) | pretty JSON (2-space) | temp + rename, whole file | `version: 1` (`CONFIG_VERSION`, `main.js:29`) | 7.7 KB | Practically yes (keys, settings) |
| `history.json` | userData | main (`main.js:112-155`) | compact JSON | temp + rename, whole file | `version: 1` (`HISTORY_VERSION`, `main.js:112`) | 103 KB | Yes: run cap (default 300, max 5000) |
| `catalog.json` | userData | main writes, renderer builds the whole object (`catalog.js:53-82`) | compact JSON | temp + rename, whole file | `version: 1` (`CATALOG_VERSION`, `main.js:164`) | 298 KB | Only indirectly (see 2.1) |
| `requests.log` / `.1` | userData | main (`main.js:507-569`) | NDJSON | `appendFileSync`, rotate at 5 MB | none | 572 KB | Yes: about 10 MB worst case |
| `logs/main.log` / `main.old.log` | userData/logs | electron-log defaults | text lines | append, rotate at 1 MB | none | not measured | Yes: about 2 MB |
| `localStorage['pvLegendCollapsed']` | userData/Local Storage | renderer (`app.js:4847`, `5569`, `5626`) | `'0'`/`'1'` | Chromium | none | bytes | Yes |
| `Local State` | userData | Chromium / safeStorage | JSON | Chromium | n/a | n/a | n/a (holds the DPAPI-wrapped key; see 3) |
| `*.tmp` | userData | main | JSON | left behind if a write crashes before the rename | n/a | n/a | n/a |

Not persisted (memory only, lost on restart): Route Test models and selection (`p.models`,
`p.selected`, `app.js:1265-1269`), current `testResults`, provider health (`providerHealth`,
`app.js:745`), key probe verdicts (`keyProbe`, `app.js:4880`), key usage readings
(`key-usage.js:34`), key-usage request history pages (`key-usage.js:161-180`), learned RPM
(`app.js:1722`), cooldowns (`app.js:1677-1678`), entitlement denials (`deniedPairs`, `app.js:1595`),
token-field and reasoning quirks (`app.js:1507`, `1517`), Mirai session cookies
(`providers/mirai.js:38`), Model Pool UI state (`catalog.js:38-44`), and the hash route
(`app.js:4133-4150`). `sessionStorage` and IndexedDB are not used anywhere.

Bundled read-only data: `src/renderer/data/leaderboard-snapshot.js` (43 KB,
`window.LEADERBOARD_SNAPSHOT = { source, capturedAt, models[] }`). It is the fallback when no live
leaderboard sits in `catalog.json` (`catalog.js:433-437`).

### 1.2 IPC surface (`src/preload.js`, handlers in `src/main.js`)

| Preload API (`preload.js`) | Channel | Kind | Handler | Effect |
|---|---|---|---|---|
| `readConfig` (:19) | `read-config` | invoke | `main.js:611-613` | read + decrypt all keys → plaintext to renderer |
| `writeConfig` (:20) | `write-config` | invoke | `main.js:615-617` | encrypt all keys on a clone → temp + rename |
| `readHistory` (:23) | `read-history` | invoke | `main.js:572` | whole `history.json` |
| `appendRun` (:24) | `append-run` | invoke | `main.js:573`, `142-155` | read whole file, push, cap, rewrite whole file |
| `clearHistory` (:25) | `clear-history` | invoke | `main.js:574-582` | write `{version, runs: []}` |
| `readCatalog` (:28) | `read-catalog` | invoke | `main.js:585` | whole `catalog.json` |
| `writeCatalog` (:29) | `write-catalog` | invoke | `main.js:586`, `191-203` | whole object from renderer → temp + rename |
| `getDataPath` (:30) | `get-data-path` | invoke | `main.js:594` | `app.getPath('userData')` |
| `openDataFolder` (:31) | `open-data-folder` | send | `main.js:595` | `shell.openPath` |
| `readLogInfo` (:33) | `read-log-info` | invoke | `main.js:544-552` | `{path, size}` of `requests.log` |
| `openRequestLog` (:34) | `open-request-log` | send | `main.js:554-558` | reveal file |
| `clearRequestLog` (:35) | `clear-request-log` | invoke | `main.js:560-569` | unlink `.log` and `.log.1` |
| `notifyRegression` (:36) | `notify-regression` | send | `main.js:589-592` | OS notification, nothing stored |
| `apiRequest` (:10) | `api-request` | invoke | `main.js:388-484` | HTTP proxy; may append to `requests.log` |
| `cancelApiRequest` (:11) | `cancel-api-request` | send | `main.js:487-494` | abort in-flight request |
| `updateAPI.*` (:38-61) | `update-*`, `download-update`, `install-update`, `check-for-updates-manual` | send/on | `main.js:265-334`, `620-637` | electron-updater; events go to electron-log only |

### 1.3 `config.json`

Readers and writers:

| Who | Where | Op | Trigger |
|---|---|---|---|
| main `ensureConfig` | `main.js:61-64`, `349` | create default if missing | startup |
| main `migrateConfigSecrets` | `main.js:68-80`, `350` | read raw; if any plaintext key: `writeConfig(readConfig())` | startup |
| main `createWindow` | `main.js:219` | read `window` | startup |
| main `saveWindowState` | `main.js:207-216`, `248` | read-modify-write `window` | window `close` |
| main `readConfig` | `main.js:44-59` | writes a default file if it is missing (`:47-49`) | any read |
| renderer `loadSettings` | `app.js:269-292` | read `settings` | init |
| renderer `queueSettingsSave` | `app.js:294-306` | read-modify-write `settings`, **350 ms debounce** | any settings change: form inputs (`app.js:3717-3737`), theme toggle (`:263`), sidebar drag end (`:4104-4115`), live toggle (`:949`), Model Pool settings (`catalog.js:1100-1114`), reset (`app.js:4056-4066`) |
| renderer `loadTestDefinition` / `saveTestDefinition` | `app.js:484-508` | read / read-modify-write `test`; **400 ms debounce** on typing (`:512-516`), immediate on reset (`:538`) and schedule change (`:3646`) | prompt/expected typing, schedule select |
| renderer `loadAllProviders` | `app.js:587-658` | read `providers`; seeds missing built-ins and migrates legacy custom providers; writes if dirty (`:651-657`) | init |
| renderer `saveProviderConfig` | `app.js:354-366` | read-modify-write one `providers[id]`, **no debounce**; then fires a health probe (`:362`) and `providers-changed` (`:365`), which triggers a catalogue re-sync 1.5 s later (`catalog.js:1052-1056`) | add/remove/toggle key (`app.js:1115-1138`, `5282-5310`), edit provider (`:3560-3589`), `markKeySpent` / `clearKeySpent` (`:1652-1668`) **during test runs** |

Inferred schema:

```text
{
  version: 1,                                 // CONFIG_VERSION, main.js:29; forced if missing (:52)
  providers: {                                // keyed by provider id
    [providerId: 'nara'|'darkapi'|'nexum'|'mirai'|'inception'|'tokenharbor'|'experiential'|<legacy custom id>]: {
      name: string,
      baseUrl: string,                        // trailing slashes stripped on edit (app.js:3564)
      rpm: number | null,                     // null = fall back to module default (app.js:608-610)
      keys: [{
        id: string,                           // 'key_' + Date.now() (app.js:1134); legacy ids kept on merge
        name: string,
        key: string,                          // 'enc:v1:<base64>' on disk; plaintext in memory; '' if locked
        active: boolean,
        quotaSpent?: {                        // app.js:1657, survives restart on purpose (:1600-1609)
          until: number | null,               // epoch ms reset time
          status: number | null,              // HTTP status
          message: string,
          at: number,                         // epoch ms
          models: string[]                    // model ids refused for spent quota
        },
        // runtime only, stripped by encryptKeyEntry before writing (keystore.js:34-41):
        cipher?: string, locked?: true
      }],
      custom?: true                           // legacy custom provider, left untouched if it still holds keys (app.js:619-649)
    }
  },
  settings: {                                 // app.js:94-187 (DEFAULT_SETTINGS); type-checked on load (:273-276)
    timeGoodMs, timeOkMs,                                      // number (ms)
    deadlineChatMs, deadlineImageMs, deadlineVideoMs, deadlineDecisionMs,  // number (ms)
    maxTestRetries, maxRateLimitWaits,                         // number
    hedgeEnabled: boolean, hedgeMax: number, hedgeStepMs: number,
    maxOutputTokens: number,
    imagePrompt: string, videoPrompt: string, videoPollMs: number, verifyAssets: boolean,
    decisionState: string, decisionQuestion: string, decisionThreshold: number,
    historyMaxRuns: number (300), sparkRuns: number (12),
    notifyRegression: boolean, notifyRunComplete: boolean, scheduleSkipMedia: boolean,
    healthIntervalMin: number (2), liveUpdates: boolean,
    theme: 'vercel'|'daylight', followSystem: boolean, accent: string, customAccent: '#rrggbb', density: string,
    logLevel: 'off'|'errors'|'all',
    catalogSyncMinutes: number (5), catalogAutoBench: boolean,
    aaApiKey: string,                         // PLAINTEXT secret (see 3.4)
    sidebarWidth: number, concurrency: number,
    mediaPrompt?: string                      // legacy, read once to seed image/video prompts (app.js:278-282)
  },
  test: { prompt: string, expected: string, autoMinutes: number },   // app.js:503
  window: { x, y, width, height: number, maximized: boolean }         // main.js:211
}
```

Notes:
- `settings` is always written in full from the renderer's copy (`app.js:300`), so unknown keys
  written by a newer build are dropped by an older one.
- There is no migration framework. `version` is never compared to anything. Compatibility is done
  by tolerant readers (type checks, defaults, legacy-key shims).

### 1.4 `history.json` (Route Test runs)

Writer: main `appendRun` (`main.js:142-155`) via `append-run`, called by renderer `recordRun`
(`app.js:433-463`) at the end of every run, manual or scheduled (`app.js:2628`). One write per
run. Main reads the whole file, pushes, trims to the cap (`Math.min(maxRuns, 5000)`, default 300 at
`main.js:113`, `:144-148`), and rewrites the whole file. Clear: `main.js:574-582`. Readers:
`loadHistory` at init and after clear (`app.js:398-412`), export (`app.js:4042-4045`).

```text
{
  version: 1,
  runs: [                                     // oldest first; order = insertion order
    {
      at: number,                             // epoch ms, Date.now() at run end; the only identifier
      provider: string,                       // provider id
      providerName: string,
      prompt: string,                         // test prompt at the time (repeated in every run)
      results: [{
        model: string,
        status: 'pass' | 'fail',
        time: number | null,                  // ms of the winning attempt
        tokens: number | null,
        completionTokens: number | null,
        attempts: number,
        correct: boolean | null               // judged at record time against the expected answer
      }]
    }
  ]
}
```

Deliberately **not** stored (`main.js:108-111`): response text, key id, HTTP status code, error
text, flags (`isEmpty`, `quotaSpent`, `entitlementDenied`, `timedOut`, `networkError`,
`assetVerified`, `decisionScore`), expected answer, model kind, run duration, and scheduled vs manual.
A stopped run records only the models that finished (`app.js:2615-2628`). An empty run is skipped
(`app.js:434`).

In-memory derivations built from the whole file at load (`app.js:398-412`):
- `history: Map<'pid::mid', [{at, ok}]>`, per-model verdict series (the uptime and sparkline source).
- `runLog: [{at, provider, providerName, total, passed}]`, per-run summaries (the Overview and
  Providers KPI source).

### 1.5 `catalog.json` (Model Pool + Routing Profiles policy)

Owner model: **the renderer owns the object** (`catalog.js:22-24`, `state.data`). Main only
validates the top-level shape on read (`main.js:176-189`) and stamps `version` on write
(`main.js:195`). Every save sends the whole object through `write-catalog`, **debounced 300 ms**
(`catalog.js:74-82`), and then broadcasts `catalog-changed` (profiles recompute, `profiles.js:627`;
Providers page re-render, `app.js:5050`).

`save()` call sites (each one is a full rewrite of about 300 KB):

| Call site | When |
|---|---|
| `catalog.js:262` | end of **every** `syncAll`: timer every `catalogSyncMinutes` (default 5, min 1, `:271-275`), on startup (`:1154`), window focus if stale (`:1057-1060`), 1.5 s after any `providers-changed` (`:1052-1056`), reset (`:1141`). Always saves, even when nothing changed (`keyModels[*].at` and `lastSync` move on every pass). |
| `catalog.js:378`, `:400` | twice per benchmarked model (after the bench, then in `finally`) |
| `catalog.js:426` | after a standalone capability probe |
| `catalog.js:456`, `:475` | leaderboard refresh error / success |
| `catalog.js:104` | `forgetKey` (key deleted on the Providers page) |
| `catalog.js:1130`, `:1139` | "Clear benchmark results", "Reset model pool" |
| `profiles.js:102-107` | every policy field `change` on Routing Profiles (`profiles.js:587-609`) and policy reset |

Schema:

```text
{
  version: 1,                                  // CATALOG_VERSION
  models: {                                    // keyed by 'providerId::modelId'
    [key]: {
      key: string, providerId: string, id: string,
      firstSeen: number, lastSeen: number,     // epoch ms
      removedAt: number | null,                // set when the provider stops listing it; purged after 14 days (catalog.js:18, 226-228)
      isNew: boolean,                          // appeared after the provider's first baseline sync
      // summarizeModel (catalog.js:145-161), refreshed on every sync:
      pricing: { input: number, output: number, source: 'provider'|'free tier' } | null,   // USD per 1M
      declaresTools: boolean | null, maxOutput: number | null,
      name: string, kind: 'chat'|'image'|'video'|'decision',
      hasVision: boolean, hasReasoning: boolean, isFree: boolean, isFreeForPaid: boolean,
      contextLabel: string, contextWindow: number | null,
      keyIds: string[],                        // keys that listed this model (FK into config keys)
      ownedBy: string,
      // benchmark (benchmark.js:594-658), latest run only:
      bench: null | {
        suite: number (SUITE_VERSION = 3, benchmark.js:19), at: number, provider: string, model: string,
        items: [{ id, category: 'reasoning'|'coding'|'instruction'|'language', label, tier, weight: number,
                  hard: boolean, ok: boolean, status: 'ok'|'empty'|'error'|'timeout'|'ratelimit'|'cancelled',
                  time: number, completionTokens: number, reply: string (<= 160 chars), keyId: string }],   // ~23 tasks
        probes: { latency: { status, time, ttft, error }, throughput: { status, time, ttft, tokens, error } },
        composite: number|null, tier: 'S'|'A'|'B'|'C'|'D'|null, incomplete: boolean, answered: number,
        quality: number|null, speed: number|null, reliability: number,
        categories: { [cat]: { score, passed, answered, total, points, maxPoints } },
        latencyMs, ttftMs, tps, latencyScore, ttftScore, tpsScore            // benchmark.js:428-443
      },
      history: [{ at, composite, tier, quality, latencyMs, ttftMs }],       // last 20 benches (HISTORY_CAP, catalog.js:20, 375-376)
      benchError: string | null,
      caps?: { version: 1 (CAPS_VERSION, benchmark.js:665), at: number,
               tools: { supported: boolean|null, time, note, skipped? },
               json: {...}, longContext: {...}, longLatencyMs: number|null },  // benchmark.js:814; stale after 14 d (catalog.js:323-328)
      capsError?: string | null
    }
  },
  lastSync: { [providerId]: number },          // epoch ms; presence = "baseline taken" (catalog.js:202)
  keyModels: { [keyId]: { count: number, at: number } },   // added by the renderer (catalog.js:67, 180)
  leaderboard: null | { source: string, at: number,
                        models: [{ name, slug, creator, index, codingIndex, mathIndex, tps, ttft, priceBlended }] },  // catalog.js:461-473
  leaderboardError?: { at: number, error: string } | null,
  profiles?: { policy: { version: 1, minRuns, minVerdicts, cooldownStreak, cooldownMinutes, topN,
                         maxProviderShare, sharpness, priceRef,
                         profiles: { lite|pro|max: { label, tag, desc, minIQ, maxTtftMs, minTps, minReliability,
                                                     minContext, maxPrice|null, requireTools, requireJson,
                                                     requireLong, preferFree,
                                                     weights: { iq, speed, reliability, cost } } } } }   // profiles.js:30-67
}
```

Main's `emptyCatalog` (`main.js:172-174`) knows only `models`, `lastSync` and `leaderboard`.
`keyModels`, `profiles` and `leaderboardError` are renderer-only additions that main never validates.

### 1.6 `requests.log`

Writer: `appendRequestLog` (`main.js:529-542`), called from the `api-request` handler only when
the caller passed `logLevel`:
- on response end: when `logLevel === 'all'`, or `'errors'` and `status !== 200` (`main.js:436-447`);
- on socket error: `'all'` or `'errors'` (`main.js:463-469`);
- **never on timeout** (`main.js:473-479`) and never for cancelled hedge losers (`:459-462`).

Each line is NDJSON with these fields:

| Field | Type | Notes |
|---|---|---|
| `at` | ISO-8601 string | the only ISO timestamp in the app; all others are epoch ms |
| `url` | string | full URL including the query |
| `method` | string | |
| `status` | number | 0 on network error |
| `elapsedMs` | number | |
| `requestHeaders` | object | `authorization`, `x-api-key`, `api-key` and `cookie` replaced by `[redacted]` (`main.js:516-522`) |
| `requestBody` | string | clipped to 4000 chars plus a `… [N more chars]` suffix (`main.js:524-527`) |
| `responseBody` | string | clipped the same way (success path only) |
| `error` | string | network error path only |

Not recorded: request id, provider id, key id, model, response headers, TTFB/TTFT, hedge/attempt
number, or which feature made the call.

Callers that pass `logLevel`: Route Test chat attempts (`app.js:2160`), image/video/decision paths
(`app.js:1975`, `2011`, `2050`, `2077`), asset verification (`app.js:1944`), and benchmark tasks and
caps probes (`benchmark.js:502`, `680`). **Not logged:** health probes (`app.js:846-851`), model
discovery (`app.js:1186-1190` and provider `fetchModels`), key checks (`app.js:5250`), key usage and
history (`key-usage.js:100`, `170`), the Artificial Analysis leaderboard (`catalog.js:447-452`), and
Mirai `/check`, which puts `api_key` in the **body** (`providers/mirai.js:80`). That last one would
leak the key if a future "log everything" setting were added without body redaction.

Rotation: before each append, `statSync`; if the file is over 5 MB (`LOG_MAX_BYTES`, `main.js:507`),
it is renamed to `requests.log.1`, replacing the previous `.1`. Toggle: `settings.logLevel`
(default `'off'`, `app.js:165-167`, UI `index.html:1086-1092`). Clear: unlink both files
(`main.js:560-569`).

### 1.7 electron-log (`logs/main.log`)

Only the main process uses it (`main.js:6`), with the v5.2.0 defaults: no transport config anywhere
in `src/`. On Windows the path resolves lazily to `<userData>\logs\main.log`. The first write
happens after `app.setPath('userData')` (`main.js:20-21`), so the path is
`%APPDATA%\venom-router\logs\main.log`. Default rotation is 1 MB, then rename to `main.old.log`
(`node_modules/electron-log/src/node/transports/file/index.js:39-58`). The renderer's
`console.warn` / `console.error` go only to DevTools, never to a file.

Events written: userData move (`main.js:21-22`); config, history and catalog read/write failures
(`:56`, `:100`, `:130`, `:152`, `:186`, `:200`, `:579`); plaintext-key migration count (`:75`);
key decrypt failures by key **name** (`keystore.js:26`); safeStorage unavailable (`keystore.js:44`);
window-state failure (`:214`); every auto-update event: checking, available with version,
not-available, error, download progress **on every progress tick**, downloaded, and the user's
download/install/manual-check actions (`:271-334`, `:621-635`); release-notes fetch fallbacks
(`:298`, `:301`); request-log write failure (`:540`).

### 1.8 localStorage

A single key, `pvLegendCollapsed` (`'0'` / `'1'`): Providers page legend state. Read at
`app.js:4847`, written at `:5569` and `:5626`. Wrapped in try/catch. Nothing else uses Web Storage.

---

## 2. Data volume, growth and hot paths

### 2.1 Growth per store

| Store | Growth driver | Retention / cap | Unbounded risks |
|---|---|---|---|
| `config.json` | keys, `quotaSpent.models[]` | none needed | `quotaSpent.models` grows until the reset time passes. It is only cleared by `clearKeySpent`, not trimmed on expiry. A legacy custom provider that still holds keys is kept forever (`app.js:646-648`). |
| `history.json` | one record per run × models per run | `historyMaxRuns` (UI 10-5000, `index.html:1049`; main clamps to 5000, `main.js:144`) | Bounded, but at 5000 runs × ~40 models the whole-file rewrite reaches several MB per run. |
| `catalog.json` | models × providers; ~5-8 KB per benchmarked model (23 items with 160-char replies); live leaderboard (hundreds of entries) | removed models purged 14 days after `removedAt` (`catalog.js:18`, `226-228`); `history` 20 per model (`:20`); `bench` = latest only | `keyModels` entries for keys removed via the Route Test sidebar (`app.js:1125-1131`) are never deleted (only `deleteKey` calls `forgetKey`, `app.js:5307`). Records of disconnected providers are kept forever by design (`catalog.js:251-253`). |
| `requests.log` | traffic when logging is on | 5 MB + one `.1` | Bounded at about 10 MB. |
| `main.log` | update checks every 2 h (`main.js:336-339`), progress ticks | 1 MB + `.old` | Bounded. |

### 2.2 Hot paths (performance risk)

1. **Catalogue rewrite on a timer.** Every sync pass (default every 5 min, and on focus) structured-clones
   ~300 KB renderer → main, runs `JSON.stringify`, and does a synchronous write + rename on the main
   thread, even with zero changes. During a benchmark queue this adds 2 more full writes per model.
   The 300 ms debounce coalesces bursts only.
2. **Config writes inside test runs.** A quota refusal calls `markKeySpent` → `saveProviderConfig`
   (`app.js:2401`, `1652-1660`). That costs a `read-config` (decrypt **every** key via DPAPI) plus a
   `write-config` (encrypt **every** key; fresh ciphertext each time), then a health probe of all
   keys of the provider (`app.js:362`), then a full catalogue re-sync 1.5 s later
   (`catalog.js:1052-1056`), which is one `/models` call per key. With `concurrency > 1` several lanes
   can do this at once.
3. **Settings saves.** Every debounced settings or test-prompt save is also a full decrypt + encrypt
   cycle of all keys (`app.js:297-305`, `500-508`). The code comment at `app.js:510-511` acknowledges
   this cost.
4. **History append.** Read and parse the whole file, then rewrite it on every run (`main.js:142-155`).
   It is cheap at 300 runs and grows linearly with the cap.
5. **History load.** The whole history is parsed and indexed in the renderer at startup and after
   clear (`app.js:398-412`), and every uptime/sparkline query scans that in-memory array.
6. **Request log.** `statSync` + `appendFileSync` per logged request on the main thread
   (`main.js:533-538`). With `'all'` and hedging (up to 6 parallel attempts, `app.js:115`) this is
   many synchronous writes per second.
7. **All main-process I/O is synchronous**, so any large write blocks every other IPC reply
   (including `api-request` resolutions), which skews measured latencies.

---

## 3. Encryption (`src/keystore.js`)

### 3.1 Mechanism

- `ENC_PREFIX = 'enc:v1:'` (`keystore.js:15`). On write: `k.key = 'enc:v1:' +
  base64(safeStorage.encryptString(k.key))` (`:47`). On Windows safeStorage is DPAPI-backed: a
  master key is stored wrapped in `<userData>\Local State` and bound to the Windows user
  (`keystore.js:4-12`, `user-data.js:3-6`).
- `eachStoredKey` walks **only** `providers.*.keys[]` (`keystore.js:50-55`). Nothing else in config
  is encrypted.
- `writeConfig` encrypts a `structuredClone` so the caller keeps plaintext (`main.js:90`).
- `readConfig` decrypts in place on every read (`main.js:54`).

### 3.2 Failure and fallback semantics (must be preserved)

| Case | Behaviour | Code |
|---|---|---|
| Value has no prefix | treated as not yet migrated; returned as-is | `keystore.js:19` |
| Decrypt fails (other machine or user, `Local State` lost) | `key = ''`, `cipher = <original>`, `locked = true`; UI shows "Encrypted for another machine" and excludes it from runs | `keystore.js:23-30`, `app.js:1028-1047`, `1089-1091` |
| Writing a locked key | original ciphertext restored untouched, runtime fields stripped | `keystore.js:34-39` |
| safeStorage unavailable at write | key left **plaintext** on disk, warning logged | `keystore.js:43-46` |
| Plaintext keys found at startup | `migrateConfigSecrets` rewrites the config encrypted | `main.js:68-80`, `350` |
| Legacy custom provider merge | locked keys de-duplicated by `cipher` identity | `app.js:628-637` |
| userData folder renamed | whole folder moved once so `Local State` travels with the ciphertext | `user-data.js:12-24` |

### 3.3 Where plaintext exists

- Main memory, briefly, inside `readConfig` / `writeConfig`.
- **Renderer memory, permanently**: `PROVIDERS[*].keys[*].key`. It builds `Authorization` headers
  (`app.js:849`, `2156`, `5251`), copies to the clipboard (`app.js:1103`), and passes keys to provider
  modules (`key-usage.js:100`, `170`). By design this "protects the file, not the process"
  (`keystore.js:7-8`).
- **Across IPC** on every `read-config` (settings save, test save, provider save), and in every
  `api-request` payload's headers.

### 3.4 Gaps

- `settings.aaApiKey` (Artificial Analysis key) is saved in plaintext in `config.json`
  (`app.js:176`, `catalog.js:1110-1114`). It is also wiped by "Reset all settings" (`app.js:4057`).
- Mirai session cookies are kept only in memory. That is fine, but they are credentials.
- `countPlaintextKeys` / migration runs only at startup. A key saved while safeStorage is
  unavailable stays plaintext until the next launch where it is available.

### 3.5 Constraints on a DB design

1. Key material must stay encrypted at rest with the same `enc:v1:` envelope (or a versioned
   successor), per value, not per file. An existing `enc:v1:` value must be copied **verbatim**
   during migration, never decrypted and re-encrypted by a migration running in a context where
   decryption could fail. Otherwise locked keys are destroyed.
2. Encryption and decryption stay in **main** only. The DB file must never be opened by the
   renderer. Ideally the renderer stops receiving plaintext at all (main signs requests by `keyId`),
   but that is a behaviour change, not a storage one.
3. The DB must live in the same userData folder as `Local State`. A DB backup or export is useless
   without that file and the same Windows user. Any "export/backup" feature must say so, or export
   keys decrypted only on an explicit user action.
4. `locked` / `cipher` are runtime states, not columns. A key row stores ciphertext only, and a
   decrypt failure must never cause a write of `''`.
5. Encrypt `aaApiKey` (and any future secret, such as gateway tokens) with the same envelope.
6. Do not decrypt all keys on every settings save. A DB lets settings and keys be written
   independently, which removes the DPAPI round trips from hot paths 2 and 3.
7. Logs must never contain key material: keep header redaction, and add body redaction
   (`api_key`, `key`, `token`, `password` fields) before widening what gets logged.

---

## 4. Concurrency and integrity

### 4.1 What is safe today

- Temp-file + `renameSync` for config, history and catalog (`main.js:95-97`, `137-139`, `194-197`).
  On Windows, Node's rename replaces the target atomically, so a crash leaves either the old or the
  new file, plus maybe a stale `.tmp`.
- Main-process handlers are synchronous, so two IPC writes never interleave inside main.
  `appendRun`'s read-modify-write is effectively serialized.

### 4.2 What is not safe

| Risk | Detail | Code |
|---|---|---|
| No fsync | `writeFileSync` + rename without flushing: after a power loss the renamed file can be empty or zeroed on some setups. | `main.js:96-97`, `138-139`, `196-197` |
| Renderer lost updates on config | Writers do `readConfig` → await → mutate → `writeConfig` across two IPC round trips. Concurrent writers (settings debounce, test debounce, `saveProviderConfig` from parallel lanes, `loadAllProviders`) can interleave, and the later write restores stale sections. Example: a settings save that read the config before `markKeySpent` wrote it overwrites `quotaSpent`, or a just-added key. | `app.js:297-305`, `354-360`, `500-505`, `651-653` |
| No flush on quit | Debounced settings (350 ms), test (400 ms) and catalogue (300 ms) writes are dropped if the window closes or `quitAndInstall` runs inside the window. Nothing listens for `beforeunload` / `will-quit`. Benchmark results just computed can be lost. | `app.js:294-306`, `512-516`, `catalog.js:74-82`, `main.js:356-358`, `629-632` |
| Main vs renderer on close | `saveWindowState` does its own read-modify-write of config on `close` (`main.js:207-216`), racing any in-flight renderer `write-config`. | |
| No single-instance lock | `requestSingleInstanceLock` is never called. Two instances share userData: both run timers, both rewrite `catalog.json` from their own memory (last writer wins), both append history (each re-reads, so appends survive, but caps and clears race), and both use the same `.tmp` names. | `main.js` (absent) |
| Multiple windows | Only one `BrowserWindow`. `activate` can create a second on macOS only (`main.js:364-366`). Stores are not shared between renderers anyway. | |
| Stale in-memory catalogue | The renderer is the source of truth. If `read-catalog` fails, `state.data` becomes an empty catalogue (`catalog.js:59-62`) and the next `save()` **overwrites the real file with it**. | `catalog.js:56-70` |

### 4.3 Crash and corruption outcomes

| File corrupt or unparseable | Read result | What happens next |
|---|---|---|
| `config.json` | `getDefaultConfig()` = `{version:1, providers:{}}` (`main.js:55-57`) | `loadAllProviders` sees every built-in missing, seeds them, sets `dirty`, and **writes** (`app.js:612-614`, `651-653`). All keys (ciphertext) are gone for good. `migrateConfigSecrets` would also throw and log. There is no backup copy. |
| `history.json` | empty runs (`main.js:128-132`) | the next `appendRun` overwrites the file, so all history is lost |
| `catalog.json` | `emptyCatalog()` (`main.js:185-188`) | the next `save()` (at the latest after the startup sync) overwrites it: benchmarks, profiles policy and live leaderboard lost |
| stale `.tmp` | ignored | overwritten on the next write; never used for recovery |

---

## 5. Log-like events the app produces (or could)

For each event: where it originates, the fields available at that point, and whether anything
persists today.

| # | Event | Origin | Fields available at creation | Persisted today |
|---|---|---|---|---|
| 1 | Route Test model result | `testModel` → `recordResult` (`app.js:2333-2449`, `2544-2549`) | model id, provider id and name, group/plan, `status`, `response` (full text), `time`, `tokens`, `promptTokens`, `completionTokens`, `attempts`, `keyId`, `statusCode`, `errorCode`, `retryAfter`, `isEmpty`, `cancelled`, `networkError`, `timedOut`, `quotaSpent`, `entitlementDenied`, `assetVerified`, `assetInline`, `decisionScore`, `allKeysCooling`; model `kind`, `hasReasoning`; `correct` via `isCorrect` | partially (the history subset in 1.4) |
| 2 | Route Test run | `runTests` end (`app.js:2551-2633`) | provider, run start (not captured today) and end, `list.length`, `done`, `stopped`, `scheduled`, prompt, expected answer, concurrency, `changes.broke[]` / `recovered[]` | history record (no start time, no scheduled flag, no counts of skipped models) |
| 3 | Individual HTTP attempt (hedge member) | `attemptOnce` → `api-request` (`app.js:2140-2210`, `main.js:388-484`) | url, method, request headers and body, `requestId`, status, elapsed, `firstByteMs`, `firstTokenMs`, response headers and body, `timedOut`, `cancelled`, `networkError` | `requests.log` only if `logLevel` is set, and never for timeouts |
| 4 | Regression / run-complete notification | `announceRegressions` (`app.js:2638-2653`) | title, body, broke list, passed/total; scheduled runs only | no |
| 5 | Scheduled run tick | `runScheduledTest` (`app.js:3633-3641`) | fire time, skipped reason (already testing, nothing selected, no keys), selected count, skip-media filter | no |
| 6 | Benchmark run | `pump` → `B.run` (`catalog.js:358-404`, `benchmark.js:594-658`) | full `bench` object (items with per-task keyId, status, time, tokens, reply), probes, scores, suite, trigger (auto-bench vs manual), error | latest `bench` + 20-entry `history` summary in catalog; older full runs are overwritten |
| 7 | Capability probe | `probeCapabilities` (`benchmark.js:665-814`, `catalog.js:381-393`, `409-429`) | tools / json / longContext `{supported, time, note}`, `longLatencyMs`, version, error | latest `caps` / `capsError` only |
| 8 | Provider health probe | `checkProviderHealth` (`app.js:825-873`) | provider, per-key status / elapsed / error (`keyProbeResult`), final state `ok|fail|none`, detail, transient flag, confirmation re-probe (`:877-886`), trigger (timer every `healthIntervalMin`, focus, online, manual recheck, key edit) | no (memory `providerHealth`) |
| 9 | Key test | `testKey` (`app.js:5262-5280`) | key id, provider, status, elapsed, usage refresh result | no |
| 10 | Key usage fetch | `KEY_USAGE.refresh` / `observe` (`key-usage.js:83-148`) | key id, `quota {total, remaining, unit}`, `expiresAt`, `window24h {requests, successRate, errorRate}`, `allowance {label, usedPct, resetsAt}`, `plan`, `probe`, error, `at`; passive readings from response headers | no (memory cache; stale after 5 min) |
| 11 | Key usage request-history page | `fetchKeyHistory` (`key-usage.js:161-180`) | provider-side items `{at, model, ok, status, inputTokens, outputTokens, totalTokens, cost}`, page, total | no |
| 12 | Quota spent / cleared | `markKeySpent` / `clearKeySpent` (`app.js:1652-1668`) | key, model, until, status, message, at | current state only (`quotaSpent` on the key) |
| 13 | Rate limit / cooldown / learned RPM | `coolKeyDown`, `learnRateLimit` (`app.js:1677-1760`, `2419-2429`) | key id, retry-after, learned ceiling | no |
| 14 | Entitlement denial | `app.js:2406-2417` | key id, model id | no (per run) |
| 15 | Model discovery sync | `syncAll` / `syncProvider` (`catalog.js:198-269`) | reason (`timer|startup|focus|providers|reset`), per provider: ok/failed, `added[]`, `removed[]`, per-key model count, duration, `syncNote` | only the resulting state (`firstSeen`, `removedAt`, `lastSync`, `keyModels`); no event trail |
| 16 | Route Test model fetch | `fetchModels` (`app.js:1171-1290`) | provider, per-key failures, model count, free count | no |
| 17 | Leaderboard refresh | `refreshLeaderboard` (`catalog.js:443-478`) | ok, count, error, cached | latest `leaderboard` / `leaderboardError` |
| 18 | Profiles recompute / policy change | `profiles.js` `compute`, `savePolicy` (`:102-107`) | policy diff, per-profile active/candidate/cooldown/excluded membership and shares | policy only; no membership history |
| 19 | Auto-update lifecycle | `main.js:271-334`, `620-637` | checking, available `{version, releaseNotes, releaseDate}`, not-available, error message, progress `{percent, bytesPerSecond, transferred, total}`, downloaded version, user actions | electron-log text only |
| 20 | Config / keystore events | `main.js:68-80`, `keystore.js:26`, `44` | plaintext migration count, decrypt failure by key name, encryption unavailable | electron-log text only |
| 21 | Data-folder migration | `main.js:18-23`, `user-data.js` | migrated, error | electron-log text only |
| 22 | Settings change / reset, history clear, log clear, catalogue reset / clear-bench | handlers listed in 7 | key, old/new value, actor = user | no audit trail |
| 23 | App lifecycle | `app.whenReady`, `will-quit`, window close (`main.js:348-366`) | version, userData path, window bounds | window bounds only |

---

## 6. Features that read persisted data (queries a DB must serve)

| Feature | Data read | Query shape | Code |
|---|---|---|---|
| Overview KPIs + nav quick stats | `history` Map, `PROVIDERS`, health | distinct `(provider, model)` count; max `at` over all results; providers online | `app.js:4335-4356` |
| Overview trend (14 days) | `runLog` | per local calendar day, last 14 days: `sum(passed)`, `sum(total)`, `count(runs)`; overall rate | `app.js:4364-4401` |
| Overview activity | `runLog` | last 6 runs, newest first: providerName, passed/total, `at`; total run count | `app.js:4403-4412` |
| Route Test uptime column | `history` | per `(activeProvider, model)`: ok-count / count over **all retained** results; null if n < 2 | `app.js:420-424`, `2725`, `2944` |
| Route Test sparkline | `history` | per `(provider, model)`: last `sparkRuns` verdicts, oldest first | `app.js:3037-3051` |
| Regression detection | `history` | per `(provider, model)`: the verdict before the latest | `app.js:427-431`, `468-479` |
| Providers page cards | `history`, `runLog` | per provider: distinct models with results, run count, all-time passed/total, last run `at` | `app.js:4539-4553`, `5434-5437` |
| Providers KPIs | `runLog` | passed/total over runs of connected providers | `app.js:5443-5463` |
| Providers key rows | catalog `keyModels` | per key: model count, `at` | `catalog.js:92-99` |
| About stats | `history` | distinct `(provider, model)` count; total result count | `app.js:3921-3925` |
| Model Pool table / cards | catalog `models`, leaderboard | visible = not removed ∧ provider connected; filter by provider / search / new / benchmarked / untested / on global board; sort by rank (composite, quality, latency), quality, latency, ttft, tps, global index, newest (`firstSeen`), name, provider | `catalog.js:108-114`, `520-528`, `850-937` |
| Model Pool KPIs | catalog | counts; removed in the last 7 days; max `lastSync`; rank correlation vs global | `catalog.js:876-895` |
| Model Pool detail | catalog | latest bench with items, `history` bars (≤20) | `catalog.js:764` |
| Reliability (profiles) | history.json verdicts + catalog bench history + bench items | per `(provider, model)` in a 7-day window: ok rate, n, trailing fail streak, last fail time | `catalog.js:291-311` |
| Stability (profiles) | catalog `history` | stdev/mean of composites | `catalog.js:315-321` |
| Routing Profiles | catalog + reliability + policy | pure function over all visible entries | `profiles.js:122-150` onwards |
| Export: Route Test CSV/JSON | in-memory `testResults` (not the store) | current run only | `app.js:3107-3131` |
| Export: history JSON | `history.json` as stored | whole file | `app.js:4042-4045` |
| Export: profiles.json | computed profiles | derived | `profiles.js:311-335`, `566-572` |
| Settings > Diagnostics | `requests.log` size / path | stat | `app.js:3900-3906` |
| Settings > Data Directory | userData path | | `app.js:5671` |

The DB must reproduce these **semantics** exactly:
- "Uptime" today means "over the retained runs", so it silently shifts when `historyMaxRuns` changes.
- The trend uses **local** midnight (`app.js:4380-4381`).
- Run and verdict order is insertion order, not `at` order.
- Reliability merges three sources.

---

## 7. Settings and actions that affect storage

| Setting / action | Default | Effect | Code |
|---|---|---|---|
| `historyMaxRuns` ("Keep the last N runs") | 300 (10-5000) | cap applied on the next append only; lowering it does not trim until the next run | `app.js:139`, `451`; `main.js:144-148`; `index.html:1046-1049` |
| `sparkRuns` | 12 (4-40) | display window only | `app.js:140`, `3038` |
| `logLevel` | `off` | gates `requests.log` per request | `app.js:167`; `main.js:436`, `463` |
| `catalogSyncMinutes` | 5 (1-120) | sync cadence, and so the catalogue rewrite cadence | `catalog.js:271-275`, `1100-1107` |
| `catalogAutoBench` | true | new models benchmarked, then more catalogue writes | `catalog.js:263-265` |
| `healthIntervalMin`, `liveUpdates` | 2, true | probe cadence (no storage) | `app.js:940-952` |
| `test.autoMinutes` | 0 | scheduled runs, one history record per tick | `app.js:3621-3647` |
| Export history | | downloads the raw `history.json` | `app.js:4042-4045` |
| Clear history | | rewrites the file empty, reloads indexes | `app.js:4047-4052`; `main.js:574-582` |
| Show log / Clear log | | reveal / unlink `.log` + `.log.1` | `app.js:3928-3932`; `main.js:554-569` |
| Open data folder | | `shell.openPath(userData)`; the path is read-only (not configurable) | `app.js:4054`; `main.js:595` |
| Reset all settings | | `settings` back to defaults (includes `aaApiKey`); providers, keys, test prompt, history and catalogue untouched | `app.js:4056-4066` |
| Clear benchmark results | | nulls `bench`, `history`, `benchError` on every model | `catalog.js:1126-1133` |
| Reset model pool | | `models = {}`, `lastSync = {}` then re-sync; keeps `profiles`, `leaderboard`, `keyModels` | `catalog.js:1134-1143` |
| Reset profiles policy | | writes `DEFAULT_POLICY` into the catalogue | `profiles.js:109-112` |
| Reset prompt | | `test.prompt` / `test.expected` defaults | `app.js:532-542` |

The data directory is not configurable. The only relocation is the one-time
`upstream-checker` → `venom-router` rename (`user-data.js:12-24`). An explicit `--user-data-dir`
is honoured for dev/test (`main.js:18`).

---

## 8. Migration risks

1. **Renderer-owned mutable blobs.** `catalog.js` mutates `state.data.models[key]` in place from
   several async flows (sync, benchmark pump, caps probe, profiles policy, key deletion) and relies
   on "save the whole thing later". Moving to row-level writes needs either (a) a main-side
   repository with explicit upsert calls at each mutation site (about 12 sites, listed in 1.5), or
   (b) a transitional "write-catalog → diff → upsert" adapter. Option (b) keeps the 300 KB IPC cost
   and hides bugs.
2. **Profiles depend on catalogue internals.** `profiles.js` reads and writes `C.state.data.profiles`
   directly (`profiles.js:75`, `104`) and calls `C.save()`. It must move to its own settings row or
   table.
3. **In-memory indexes built from full history.** `history` / `runLog` are rebuilt from the whole
   file (`app.js:398-412`) and then appended to locally (`:455-461`). With a DB, either keep the
   in-memory index (load recent N per model) or switch the UI to query calls. Mixing both risks
   drift after "Clear history".
4. **Identity.**
   - Runs have no id; `at` (ms) is the only key, and two quick runs can collide.
   - Model identity is the string `'providerId::modelId'`, used as a Map key, DOM `data-*` value and
     catalogue key. Model ids contain `:` and `/` (for example `qwen3.8-flash:free`).
   - Key ids are `key_<ms>` (`app.js:1134`); legacy merged keys keep their old ids.
   - `keyIds` in catalogue entries and `keyModels` keys are soft foreign keys into config.
   - Store `provider_id` and `model_id` as separate columns and keep the composite only as a derived
     value.
5. **Ordering.** Consumers assume insertion order (`h[h.length-2]`, `slice(-N)`, `runLog.slice(-6)`).
   The DB needs a monotonic run id and `ORDER BY id`, not only `at`, to break ties the same way.
6. **Semantics tied to retention.** Uptime, "Models tracked", "Results recorded" and provider pass
   rates are computed over whatever the cap retained. A DB with longer retention changes these
   numbers unless queries apply the same window (last N runs) or the UI is relabelled.
7. **Encryption.** See 3.5. The migration must copy ciphertext verbatim, keep plaintext-fallback
   entries flagged for re-encryption, and never run it before `app.whenReady` (safeStorage needs it).
8. **Corrupt-source handling.** Today a corrupt JSON silently becomes "empty" and is then
   overwritten. The migration must treat parse failure as **fatal for that store**: keep the file,
   do not create empty rows, and surface it.
9. **Keep the JSON files after migration** (renamed, for example `config.json.migrated-<version>`)
   for downgrade and rollback. electron-updater can install an older build manually, and the
   portable exe can be an older version pointed at the same userData. An old build finding no
   `config.json` would call `ensureConfig` and start empty. Decide explicitly: either leave the JSON
   files readable (read-only mirror) for one or two releases, or accept the downgrade break.
10. **Auto-update quit path.** `quitAndInstall(true, true)` (`main.js:631`) quits immediately.
    Pending debounced renderer writes are lost today. A DB with synchronous transactional writes in
    main fixes this only if the renderer stops debouncing writes of important state. Close the DB
    cleanly on `will-quit` / `before-quit` (checkpoint WAL).
11. **Native dependency in packaging.** Electron 33 bundles Node 20.x, which has no `node:sqlite`
    (it arrived in Node 22.5). The options are `better-sqlite3` (native: needs an Electron rebuild,
    `asarUnpack` of `.node`, and it works with the `nsis` + `portable` targets in `package.json`), a
    WASM engine (sql.js: no native build, but whole-DB-in-memory with manual persistence, which
    recreates today's whole-file rewrite), or upgrading Electron to a Node 22 line. `build.files` is
    `src/**/*` (`package.json`); production `node_modules` still ship, but verify that the native
    binary lands unpacked.
12. **Single instance.** Add `app.requestSingleInstanceLock()` before opening the DB. SQLite locking
    protects the file, but two instances would still double every timer (sync, health, schedule).
13. **Main-thread blocking.** A synchronous DB driver in main has the same blocking property as
    today's `fs.*Sync`. Keep transactions short, batch log inserts, and move heavy queries (trend,
    export) off the hot IPC path or into a worker if needed.
14. **Request log contents.** Request and response bodies (clipped to 4 KB) hold prompts and model
    output. Moving them into the DB makes them queryable and backup-visible. Keep the off-by-default
    toggle, redaction, a size or age retention, and the "Clear log" action.
15. **Settings shape.** `loadSettings` accepts only keys present in `DEFAULT_SETTINGS` with matching
    `typeof` (`app.js:273-276`). A key/value settings table must round-trip the JS types exactly
    (number vs string vs boolean), or values silently revert to defaults.
16. **No tests cover persistence** (`test/` has only `user-data.test.js`), and
    `scripts/keystore-check.js` is a manual Electron script. The migration needs fixture-based tests
    (plaintext, `enc:v1:`, locked, legacy custom provider, `mediaPrompt` shim, corrupt files).

---

## Implications for the DB design

### Principles

- One DB file in userData (next to `Local State`), opened **only in main**, WAL mode, a single
  connection, a versioned schema with forward-only migrations (`schema_version` table), and
  `requestSingleInstanceLock`.
- The renderer talks to **typed IPC methods** (upsert model, append run, set setting, query trend),
  never to a whole-blob read/write. Retire `write-catalog` and whole-config `write-config` for hot
  paths.
- Secrets are encrypted per value with the existing envelope (`enc:v1:`), decrypted in main only.
  `aaApiKey` joins them.
- A one-shot, idempotent JSON → DB importer runs after `whenReady`. It copies ciphertext verbatim,
  refuses to import a corrupt file (keeps it and reports it), and renames the imported files instead
  of deleting them.

### Phase 1 entities

| Entity | Key | Columns (from today's schemas) | Source |
|---|---|---|---|
| `meta` | key | `schema_version`, `imported_from_json_at`, app version | new |
| `settings` | key | `value_json` (typed round-trip), `updated_at` | `config.settings`, `config.test`, `config.window` |
| `providers` | `id` | `name`, `base_url`, `rpm`, `is_custom`, `created_at`, `updated_at` | `config.providers` |
| `provider_keys` | `id` | `provider_id` FK, `name`, `key_cipher` (`enc:v1:…` or flagged plaintext), `active`, `created_at`, `updated_at` | `config.providers[*].keys` |
| `key_quota_state` | (`key_id`, `model_id`) or `key_id` + JSON | `until`, `status`, `message`, `at` | `keys[*].quotaSpent` |
| `secrets` | name | `cipher` | `settings.aaApiKey` (new: encrypted) |
| `test_runs` | autoincrement `id` | `started_at`, `finished_at` (= today's `at`), `provider_id`, `provider_name`, `prompt`, `expected`, `scheduled`, `stopped`, `total`, `passed`, `failed` | `history.runs[*]` |
| `test_results` | `id` | `run_id` FK, `provider_id`, `model_id`, `status`, `correct`, `time_ms`, `tokens`, `completion_tokens`, `attempts`, plus new: `key_id`, `http_status`, `error_code`, `flags` (empty / quota / entitlement / timeout / network), `kind` | `runs[*].results[*]` |
| `models` | (`provider_id`, `model_id`) | `name`, `kind`, `first_seen`, `last_seen`, `removed_at`, `is_new`, `pricing_in`, `pricing_out`, `pricing_source`, `declares_tools`, `max_output`, `context_window`, `context_label`, `has_vision`, `has_reasoning`, `is_free`, `is_free_for_paid`, `owned_by`, `bench_error`, `caps_json`, `caps_at`, `caps_error` | `catalog.models` |
| `model_keys` | (`provider_id`, `model_id`, `key_id`) | | `models[*].keyIds` |
| `key_model_counts` | `key_id` | `count`, `at` | `catalog.keyModels` |
| `provider_sync` | `provider_id` | `last_sync_at` | `catalog.lastSync` |
| `benchmark_runs` | `id` | `provider_id`, `model_id`, `at`, `suite`, `composite`, `tier`, `incomplete`, `answered`, `quality`, `speed`, `reliability`, `latency_ms`, `ttft_ms`, `tps`, scores, `categories_json`, `probes_json`, `trigger` | `models[*].bench` + `models[*].history` (history rows import as summary-only runs) |
| `benchmark_items` | (`run_id`, `task_id`) | `category`, `tier`, `weight`, `hard`, `ok`, `status`, `time_ms`, `completion_tokens`, `reply`, `key_id` | `bench.items` |
| `leaderboard` | `slug` | `name`, `creator`, `index`, `coding_index`, `math_index`, `tps`, `ttft`, `price_blended`; plus a `leaderboard_meta` row (`source`, `at`, `error`, `error_at`) | `catalog.leaderboard*` |
| `profile_policy` | singleton / `version` | `policy_json` | `catalog.profiles.policy` |
| `event_log` (logging system) | autoincrement `id` | `at` (epoch ms), `level`, `category` (test / bench / health / sync / usage / quota / update / config / system), `action`, `provider_id`, `model_id`, `key_id`, `run_id`, `duration_ms`, `status`, `message`, `data_json` | events in section 5 |
| `request_log` (opt-in) | autoincrement `id` | `at`, `request_id`, `feature`, `provider_id`, `model_id`, `key_id`, `method`, `url`, `status`, `elapsed_ms`, `first_byte_ms`, `first_token_ms`, `attempt`, `hedge`, `timed_out`, `cancelled`, `error`, `req_headers_json` (redacted), `req_body` (clipped, redacted), `resp_body` (clipped) | `requests.log` |

Useful indexes: `test_results(provider_id, model_id, run_id)`; `test_runs(finished_at)`;
`test_runs(provider_id, id)`; `models(provider_id, removed_at)`;
`benchmark_runs(provider_id, model_id, at)`; `event_log(at)`; `event_log(category, at)`;
`request_log(at)`; `request_log(provider_id, at)`.

### Phase 1 queries (must match today's behaviour)

1. **Uptime** per `(provider, model)` over the last `historyMaxRuns` runs: ok / n, null if n < 2.
2. **Sparkline**: last `sparkRuns` verdicts per `(provider, model)`, oldest first.
3. **Previous verdict** per `(provider, model)` for regression detection (second-latest by run id).
4. **Overview trend**: per local day for the last 14 days, `sum(passed)`, `sum(total)`, `count(runs)`.
5. **Overview activity**: last 6 runs (newest first) plus total run count.
6. **Quick stats / About**: distinct `(provider, model)` with results; total result rows; latest `at`.
7. **Provider stats**: per provider, distinct models, runs, passed/total, last run `at`; the same
   aggregate over connected providers for the KPI card.
8. **Reliability** (7-day window) per `(provider, model)`: union of test verdicts, benchmark
   composites and latest-bench item statuses → rate, n, trailing fail streak, last fail time.
9. **Stability**: stdev/mean of the last 20 composites per model.
10. **Model Pool list**: visible models (not removed, provider has keys) joined with the latest bench
    and leaderboard; filters and sorts as in section 6; removed-in-7-days count; max `last_sync_at`.
11. **Sync upsert**: per provider, upsert the listed models (set `last_seen`, clear `removed_at`, set
    `is_new` on (re)appearance), mark unseen models removed, purge `removed_at < now - 14 d`, replace
    `model_keys`, update `key_model_counts` and `provider_sync`, all in one transaction.
12. **Benchmark write**: insert run + items, keep the 20 latest summaries per model (or keep all
    runs and window at read time), clear `is_new`.
13. **Retention jobs**: trim test runs to `historyMaxRuns` (apply immediately when the setting is
    lowered), trim `event_log` / `request_log` by age or size, and replace today's 5 MB rotation.
14. **Clears**: clear history, clear benchmark results, reset model pool (keep policy, leaderboard,
    key counts), clear request log, reset settings (must not touch secrets once `aaApiKey` moves to
    `secrets`).
15. **Exports**: history as JSON (the current shape `{version, runs:[{at, provider, providerName,
    prompt, results[]}]}` for compatibility), and, new, CSV/JSON of events and requests with a
    filter.
16. **Keys for main-side use**: fetch the decrypted key by `key_id` in main only. The renderer gets
    `{id, name, masked, active, locked, quotaState}`. This is a phase-1 option that removes plaintext
    from IPC; if deferred, keep today's contract behind the new API.
