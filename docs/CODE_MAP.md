# Code map

> GENERATED FILE — do not edit by hand. Regenerate with: npm run repo:map

115 files under src/, scripts/, test plus the app shell and the stylesheet. Each row is one file: its size, what it is for and the names it defines. Read this before opening files, then open only what the task needs — for the long ones, jump with the landmarks section below.

The architecture behind these files — boot order, IPC channels, the two databases, the request lifecycle — is in [ARCHITECTURE.md](ARCHITECTURE.md). Task recipes are in [COOKBOOK.md](COOKBOOK.md).

## IPC channels

39 channels, in registration order. invoke/handle answers a promise; send/on is fire-and-forget. The renderer reaches them through window.electronAPI (src/preload.js).

| Channel | Registered in |
| --- | --- |
| `read-config` | src/db/ipc.js |
| `database-explorer` | src/db/ipc.js |
| `save-settings` | src/db/ipc.js |
| `save-secret` | src/db/ipc.js |
| `save-test-definition` | src/db/ipc.js |
| `save-provider` | src/db/ipc.js |
| `merge-provider` | src/db/ipc.js |
| `delete-provider` | src/db/ipc.js |
| `copy-key` | src/db/ipc.js |
| `read-catalog` | src/db/ipc.js |
| `write-catalog` | src/db/ipc.js |
| `read-history` | src/db/ipc.js |
| `append-run` | src/db/ipc.js |
| `clear-history` | src/db/ipc.js |
| `logs-list` | src/logs/ipc.js |
| `logs-get` | src/logs/ipc.js |
| `logs-stats` | src/logs/ipc.js |
| `logs-facets` | src/logs/ipc.js |
| `logs-runs` | src/logs/ipc.js |
| `logs-run-summary` | src/logs/ipc.js |
| `logs-export` | src/logs/ipc.js |
| `logs-info` | src/logs/ipc.js |
| `logs-clear` | src/logs/ipc.js |
| `window-minimize` | src/main.js |
| `window-maximize` | src/main.js |
| `window-close` | src/main.js |
| `set-window-icon` | src/main.js |
| `api-request` | src/main.js |
| `cancel-api-request` | src/main.js |
| `read-log-info` | src/main.js |
| `open-request-log` | src/main.js |
| `clear-request-log` | src/main.js |
| `notify-regression` | src/main.js |
| `get-data-path` | src/main.js |
| `open-data-folder` | src/main.js |
| `open-external` | src/main.js |
| `download-update` | src/main.js |
| `install-update` | src/main.js |
| `check-for-updates-manual` | src/main.js |

## Large-file landmarks

Files of 700+ lines, with the section banners inside them. Open the window you need — do not read one of these whole. Line numbers are 1-based.

### src/main.js — 730 lines

| Line | Section |
| --- | --- |
| 60 | Local database — venom.db (src/db) |
| 71 | Request log — venom-logs.db (src/logs) |
| 140 | Model catalog engine — src/catalog |
| 626 | API requests (src/api-request.js) |
| 648 | Old request log file (requests.log) |

### src/renderer/app.js — 6027 lines

| Line | Section |
| --- | --- |
| 2 | VENOM ROUTER — Application Logic v2 |
| 26 | Model kinds |
| 88 | Settings |
| 383 | Saving — every write goes through persist() |
| 456 | Providers — each saved on its own (save-provider) |
| 505 | Run history — uptime, regressions, scheduling |
| 642 | Test definition — prompt + expected answer |
| 808 | Title bar |
| 815 | Provider page — header |
| 838 | Provider health — a silent background probe of each provider's key |
| 1109 | API Keys management |
| 1281 | Fetch models from provider — only models for the key's plan |
| 1500 | Render the models list |
| 1661 | Test reliability settings |
| 1804 | Keys and pacing |
| 2018 | Testers — one request, judged by the model's kind |
| 2512 | Test a single model — adaptive hedge, handles reasoning, empty, rate limits |
| 2683 | Test all selected models |
| 2887 | Results table |
| 3222 | Full response modal |
| 3270 | Stats & status |
| 3330 | Export |
| 3398 | Update handling |
| 3662 | Add Key modal |
| 3770 | Edit Provider modal |
| 3845 | Init |
| 3848 | Scheduled re-testing |
| 3881 | Settings panel |
| 4484 | Sidebar ambience — moving stars and the signature heart |
| 4738 | Breadcrumb — shared helper |
| 4768 | Providers page |
| 5103 | Provider types — legend and markers |
| 5178 | Providers page — key management panel (table rows and cards) |
| 5198 | Action feedback — Recheck and key Test |
| 5630 | Stat cards — shared |
| 5647 | Data toolbar — shared |
| 5710 | Providers page — Connected view |

### src/renderer/benchmark.js — 984 lines

| Line | Section |
| --- | --- |
| 2 | Model benchmark — quick, cheap, deterministic |

### src/renderer/catalog.js — 1646 lines

| Line | Section |
| --- | --- |
| 2 | Models Catalog — live model inventory + benchmark leaderboard |

### src/renderer/logs.js — 934 lines

| Line | Section |
| --- | --- |
| 2 | Log pages — Runs, Requests and Monitoring |

### test/catalog/ipc.test.js — 882 lines

*(no section banners)*

### src/renderer/index.html — 1471 lines

| Line | Section |
| --- | --- |
| 231 | page: overview |
| 273 | page: providers |
| 294 | page: database |
| 326 | page: catalog |
| 334 | page: profiles |
| 344 | page: provider |
| 457 | page: history |
| 466 | page: monitor |
| 474 | page: settings |
| 492 | settings: sec-appearance |
| 496 | settings: sec-test |
| 500 | settings: sec-schedule |
| 504 | settings: sec-speed |
| 508 | settings: sec-reliability |
| 512 | settings: sec-catalog |
| 516 | settings: sec-history |
| 520 | settings: sec-logs |
| 524 | settings: sec-data |
| 528 | settings: sec-about |
| 1245 | overlay: response-modal |
| 1265 | overlay: add-key-modal |
| 1296 | overlay: add-provider-modal |
| 1331 | overlay: update-modal |
| 1348 | overlay: update-modal-notes |
| 1390 | overlay: log-drawer |
| 1391 | overlay: log-drawer-scrim |
| 1397 | overlay: log-drawer-body |
| 1401 | overlay: ku-drawer |
| 1419 | overlay: mc-chat-drawer |

### src/renderer/styles.css — 8202 lines

| Line | Section |
| --- | --- |
| 2 | VENOM ROUTER — Enterprise Dark Theme |
| 108 | Reset & Base |
| 158 | Title Bar |
| 338 | App shell — nav rail + page area |
| 407 | SIDEBAR BOTTOM ACCENT & STARRY STIPPLE EFFECT |
| 1784 | Animations |
| 1803 | API Keys |
| 2029 | Responsive |
| 2037 | Update Modal |
| 2268 | Settings |
| 2338 | Themes |
| 2692 | Pages — Overview placeholder |
| 2768 | Shell header |
| 3045 | Dark mode: pages share the nav's visual language |
| 3073 | Provider page — one provider's keys, models and test runs |
| 3336 | Light mode — page area only |
| 3360 | Overview — live panels |
| 3489 | Card headers — one accent-led treatment everywhere |
| 3532 | Signature heart (nav footer) |
| 3596 | Sidebar ambience — a living layer of stars |
| 3670 | Breadcrumb — shared by every page that needs one |
| 3713 | Providers page |
| 4433 | Stat cards — shared (Overview, Providers, …) |
| 4474 | Page toolbar — one card for every page that has one |
| 4522 | Design system — form fields |
| 4785 | Data table — shared |
| 5003 | Provider types — legend and markers |
| 5186 | Settings page — layout |
| 5195 | Providers — expandable rows and the key panel |
| 5219 | Providers — list of row cards |
| 5962 | Settings — Unified 2-Column Design System |
| 6401 | Settings content — one design language for every tab |
| 6747 | Models Catalog |
| 7074 | Venom Profiles |
| 7287 | Key usage (key-usage.js) — quota and expiry in the key row, the rest in a |
| 7446 | Catalog: live health badge + toast notifications |
| 7502 | Model chat drawer — a full-height panel sliding in from the right, |
| 7880 | Log pages — Runs, Requests, Monitoring |
| 8079 | Monitoring Page |
| 8145 | Database explorer — compact SQLite workbench |

### scripts/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `check-import-counts.js` | 162 | Owner-run, read-only comparison of the legacy JSON files with venom.db. | BLOCKED, relaunchUnderElectron, blockNetworking, asObject, readJson, legacyCounts, dbCounts, compare, main |
| `generate-icons.js` | 92 | Builds every brand asset the app uses from the VenomGPT brand pack, kept in | ROOT, SRC, ASSETS, OUT, ACCENTS, DEFAULT_ACCENT, UI_SIZE, ICO_SIZES, resize, buildICO, main |
| `keystore-check.js` | 77 | Throwaway verification of src/keystore.js under a real Electron process. | quiet, failures, check, save, load |
| `release.mjs` | 171 | One-shot release: tag the current version, push it, publish the notes, then | REPO, version, tag, run, capture, changelogNotes, notes, smokeTest, releasesForTag, localTags |
| `repo-map.mjs` | 272 | Code map — a compact symbol index of the source tree | ROOT, OUT, ROOTS, EXTENSIONS, SKIP_DIRS, MAX_SYMBOLS, MAX_TEST_NAMES, MAX_PURPOSE, MAX_LANDMARKS, LANDMARK_MIN_LINES, PLAIN_FILES, PURPOSE_OVERRIDES, +15 more |
| `run-tests.js` | 43 | Runs the unit tests under Electron's own Node (ELECTRON_RUN_AS_NODE=1). | ROOT, findTests, args, files, result |

### scripts/live/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `boot-guard.cjs` | 93 | An Electron entry that arms a throwing network guard and then boots the real | REPORT, userDataFlag, SCRATCH, APPDATA, attempts, record, arm |
| `cdp.mjs` | 148 | Launches a separate VENOM Router on a scratch data folder with remote | require, ROOT, sleep, assertScratchDir, appEnv, withTimeout, launch, spawnPlain |
| `fixture.mjs` | 111 | Synthetic legacy data folder for the live checks: config.json, catalog.json | FIXTURE, writeFixture |
| `mock-provider.mjs` | 53 | A local stand-in for the fixture's providers: OpenAI-shaped /models and | startMock |
| `verify-catalog-boot.mjs` | 384 | Something the owner can click — proven two ways, on a scratch data folder. | PORT, failures, check, sleep, READY, openCatalogAndRead, checkFailureWords, checkModelsCatalogPageUntouched, measureCatalog, runGuardedSession, runPositiveControl, runSyncedSession, +3 more |
| `verify-db.mjs` | 521 | Live check of the local database against a synthetic data folder. | failures, check, sleep, until, READY, checkImport, checkKeysStayInMain, saveForNextRun, queueSaveThenClose, checkFlushOnClose, checkPersistence, checkSingleInstance, +20 more |

### src/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `api-request.js` | 226 | api-request — every outbound request the renderer asks for | CONTENT_TOKEN, CANCEL_REASONS, CUT_OFF, createApiRequester |
| `flush.js` | 38 | Close handshake with the renderer | DEFAULT_FLUSH_TIMEOUT_MS, requestFlush |
| `keystore.js` | 74 | API keys at rest | decryptKeyEntry, encryptKeyEntry, eachStoredKey, countPlaintextKeys |
| `main.js` | 730 | Main process: data folder, boot order, IPC wiring, auto-updater | isPrimary, store, importReport, keyResolver, logs, logsError, recorder, priceBook, purgeScheduler, logSettings, startLogs, stopLogs, +20 more |
| `preload.js` | 111 | contextBridge surface — the renderer's only door to main | minimize, maximize, close, setWindowIcon, apiRequest, cancelApiRequest, onAppVersion, onDevReloadCss, onFlushPending, flushDone, readConfig, databaseExplorer, +42 more |
| `user-data.js` | 29 | Where the app keeps its data. Electron names the userData folder after the | LEGACY_DIR, CURRENT_DIR, resolveUserDataDir |

### src/catalog/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `atomic.js` | 32 | Replacing a JSON file the app owns. Every store here (source cache, provider | writeJsonAtomic |
| `build.js` | 624 | The scoring catalog: merges the four upstream sources into one row per model | IMAGE_SLUG_RE, deriveCostKind, deriveCreateImages, usableNumber, pickNumber, indexModelsDev, indexOpenRouterModels, emptyBench, BENCH_VALUES, isBetter, rememberBench, indexBenchmarks, +10 more |
| `engine.js` | 277 | Owns the in-memory copy of the four sources and the reference built from them, | SOURCE_SYNC_MIN_AGE_MS, emptySource, createEngine |
| `fetch.js` | 78 | The one JSON fetch helper for every upstream call the catalog makes. Sends | DEFAULT_TIMEOUT_MS, RETRY_DELAY_MS, DEFAULT_CACHE_TTL_MS, friendlyMessage, createFetcher |
| `ipc.js` | 397 | src/catalog/ipc.js | LATENCY_SAMPLES_KEPT, DATA_CODES, catalogError, COMPARE_FIELDS, same, diffRow, publishedOnly, readHealth, appendLatency, withAliases, createCatalogIpc |
| `keys.js` | 237 | Model-name normalization. The same model shows up under different names in | MATCH_AMBIGUOUS, LAB_PROVIDERS, PRICING_MODIFIERS, QUALITY_MODIFIERS, BUILD_SUFFIX_RE, PARAM_SIZE_RE, QUANT_TOKENS, cleanModelId, modelSlug, identityKey, normalizeName, slugTokens, +11 more |
| `row.js` | 263 | One adapter's model object → the shared provider row the reference merge | ROW_FIELDS, firstNumber, positive, pick, dedupe, LAB_TOKENS, labTokenOf, familyOf, costKind, readPricing, readsTools, readsReasoning, +5 more |
| `scoring.js` | 439 | Score estimation, dense ranking, and the lookup that gives provider rows their | MIN_FIT_SAMPLES, MIN_FIT_R2, SPEC_AGE_CAP_MONTHS, scoreQuality, fitLinear, solveLinear, specFeatures, fitSpec, assignScores, assignDenseRank, preferredListing, putMatch, +9 more |
| `snapshot.js` | 247 | src/catalog/snapshot.js | NEW_WINDOW_DAYS, REMOVED_WINDOW_DAYS, DROP_CONFIRMATION_MS, DROP_MIN_PREVIOUS, DROP_MIN_LOSS, invalidPayload, suspiciousDrop, daysBetween, validateProviderRows, cloneRows, DERIVED_FIELDS, BLANK_STRING_FIELDS, +7 more |
| `sources.js` | 184 | The four upstream documents that feed the reference catalog, how each is | SOURCES, ARENA_ROWS, ARENA_PAGE, ARENA_MAX_OFFSET, arenaUrl, dataPath, metaPath, createSources |
| `util.js` | 101 | Small pure helpers shared by the engine and the provider modules. | asNumber, perMillion, uniqueJoin, unixToDate, boolOrNull, hasParam, listHas, providerOf, median, clamp, monthsSince |

### src/db/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `cipher.js` | 49 | Secrets at rest — the enc:v1: envelope | ENC_PREFIX, isEnvelope, createCipher, revealCached |
| `explorer.js` | 53 | Read-only, bounded database inspection. Identifiers are taken only from | MAX_LIMIT, REDACTED_COLUMN, quoteIdentifier, inspectDatabase |
| `import-json.js` | 419 | One-shot import of the legacy JSON files | FILES, READ_ATTEMPTS, READ_GAP_MS, ImportAbort, isObject, renamedAs, plural, listImportedFiles, readWithRetry, parse, normaliseConfig, normaliseCatalog, +5 more |
| `index.js` | 158 | Local database — venom.db | DB_FILE, BACKUPS_KEPT, DbTooNewError, applyPragmas, latestVersion, backupBeforeMigrate, migrate, getMeta, setMeta, createRepos, close, open |
| `ipc.js` | 92 | Data IPC — the renderer's only way to the database | readConfig, registerDataIpc |
| `keys.js` | 161 | Placeholders → secrets, for outgoing requests | TOKEN, HAS_TOKEN, originOf, collector, createKeyResolver |
| `migrations.js` | 174 | Schema migrations |  |
| `ulid.js` | 23 | ULID: 48-bit millisecond time + 80 random bits in Crockford base32. Sorts by | ALPHABET, ulid |

### src/db/repos/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `catalog.js` | 231 | Model pool — models, key links, sync times, catalogue meta | SUMMARY_KEYS, COLUMN_FIELDS, META_KEYS, HASH_COLUMNS, keyOf, numOrNull, jsonOrNull, textOrNull, entryToRow, entryKeyIds, rowHash, rowToEntry, +1 more |
| `history.js` | 106 | Run history — test_runs + test_results | ULID, DEFAULT_MAX_RUNS, MAX_RUNS_CEILING, historyCap, num, createHistoryRepo |
| `providers.js` | 251 | Providers and their API keys | KEY_PLACEHOLDER, ANY_PLACEHOLDER, KEY_ID, maskKey, createProvidersRepo |
| `secrets.js` | 68 | Named secrets — the Artificial Analysis key | SECRET_ORIGINS, createSecretsRepo |
| `settings.js` | 45 | Settings rows — settings, test, window | createSettingsRepo |
| `snapshots.js` | 187 | One provider's roster, split across the two tables the reference kept in one | WARNING_MAX, clip, createSnapshotRepo |

### src/logs/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `classify.js` | 283 | Request classification — pure, no I/O | QUOTA_CODES, JSON_PARSE_LIMIT, SCAN_WINDOW, MODEL_MAX, RETURNED_MODEL_MAX, LATENCY_EDGES, clipped, tokens, endpointOf, bodyText, parseObject, modelRequested, +13 more |
| `index.js` | 107 | Request log — venom-logs.db | LOGS_FILE, LogsTooNewError, latestVersion, migrate, open, tryOpen |
| `ipc.js` | 64 | Request log IPC — what the log pages (sub-project C) call | LOGS_CHANNELS, NOT_SAVED, offInfo, registerLogsIpc |
| `lookups.js` | 47 | venom.db lookups for the request log | createProviderLookup, readPrice, createPriceBook |
| `migrations.js` | 111 | Request log schema migrations (venom-logs.db) |  |
| `query.js` | 530 | Request log queries — what the log pages (sub-project C) read | HOUR, MAX_LIMIT, DEFAULT_LIMIT, MAX_FILTER_ITEMS, EXPORT_CHUNK, EVERYTHING, EXPORT_COLUMNS, LIKE, CLASS_COUNTERS, GROUP_COLUMNS, SORT_COLUMNS, MAX_SORT_RANGE_MS, +22 more |
| `recorder.js` | 183 | Request record — what one finished request becomes in the log | SOURCES, CANCEL_REASONS, TRIGGERS, BODY_MAX, REDACTED_HEADERS, shortString, whole, clip, redactHeaders, metaOf, originOf, whoFor, +3 more |
| `retention.js` | 157 | Request log retention — chunked purge, stepped vacuum | DAY, CHUNK, VACUUM_PAGES, defaultYield, neverBusy, inChunks, purgeLogsBefore, purgeBodiesBefore, purgeRollupsBefore, stepVacuum, monthsAgo, purge, +1 more |
| `scrub.js` | 39 | Scrub substituted secrets out of stored log text | formsOf, scrub |
| `settings.js` | 27 | Request log settings, read by main from the settings row | LOG_LEVELS, LOG_DEFAULTS, wholeIn, readLogSettings |
| `writer.js` | 182 | Batched writer — request_logs, request_bodies, usage_hourly | HOUR, WARN_EVERY_MS, ROW_COLUMNS, ROLLUP_KEYS, ROLLUP_COUNTERS, ERROR_CLASSES, ROLLUP_SQL, rollupDelta, rowValues, createWriter |

### src/renderer/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `app.js` | 6027 | VENOM ROUTER — Application Logic v2 | DEFAULT_TEST_PROMPT, DEFAULT_EXPECTED, testPrompt, expectedAnswer, NA, RESPONSE_PREVIEW, truthy, KIND_LABELS, kindLimits, classifyModel, isMedia, isDecision, +389 more |
| `benchmark.js` | 984 | Model benchmark — quick, cheap, deterministic | SUITE_VERSION, cleanReply, lastLine, lines, gradeNumber, gradeWord, exp, alts, gradeRegexSolution, gradeJson, gradeExact, norm, +125 more |
| `catalog.js` | 1646 | Models Catalog — live model inventory + benchmark leaderboard | REMOVED_KEEP_MS, LEADERBOARD_TTL_MS, HISTORY_CAP, state, chat, ui, keyOf, loadPromise, load, saveTimer, saveReset, save, +219 more |
| `database.js` | 105 | Read-only SQLite explorer. All SQL, identifier checks, and redaction happen | PAGE_SIZE, state, byId, escape, number, setNotice, box, renderStats, renderTables, query, visible, renderHead, +10 more |
| `key-usage.js` | 539 | Key usage — quota, expiry and request history per API key | KEY_USAGE |
| `logs-format.js` | 132 | Log pages — pure formatting and mapping | LOGS_RANGES, logEscape, normalizeProvider, providerLabel, formatDuration, formatCost, formatTokens, logPad, formatWhen, statusTone, passRateText, rangePreset, +1 more |
| `logs.js` | 934 | Log pages — Runs, Requests and Monitoring | state, el, REDUCED_MOTION, drawerOpener, closeTimer, tabFromRoute, parts, loadInfo, emptyState, loggingOffMarkup, why, render, +106 more |
| `profiles.js` | 670 | Routing profiles — three exits in front of the whole model pool | PROFILE_IDS, DEFAULT_POLICY, state, policy, saved, mergePolicy, out, savePolicy, resetPolicy, blendedPrice, factsOf, ownIQ, +72 more |
| `ui-select.js` | 217 | Design system — select menu | CHEVRON, CHECK, valueDesc, indexDesc, menu, owner, active, labelOf, opt, sync, trigger, enhance, +17 more |
| `ulid.js` | 22 | Run ids — ULID, the same format as src/db/ulid.js | newUlid |
| `index.html` | 1471 | App shell markup: nav, every page, the drawers and modals |  |
| `styles.css` | 8202 | The whole stylesheet: tokens, themes, accents, components |  |

### src/renderer/providers/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `darkapi.js` | 32 | DARK API — integrated provider module | INTEGRATED_PROVIDERS |
| `experiential.js` | 102 | Experiential Labs — integrated provider module | INTEGRATED_PROVIDERS |
| `inception.js` | 56 | INCEPTION LABS — integrated provider module | INTEGRATED_PROVIDERS |
| `mirai.js` | 160 | MIRAI API — integrated provider module | INTEGRATED_PROVIDERS |
| `nara.js` | 99 | NARA Router — integrated provider module | INTEGRATED_PROVIDERS |
| `nexum.js` | 61 | NEXUM ROUTER — integrated provider module | INTEGRATED_PROVIDERS |
| `tokenharbor.js` | 178 | Token Harbor — integrated provider module | INTEGRATED_PROVIDERS, TOKENHARBOR_VIRTUAL_OWNER, tokenharborIsZero, tokenharborIsFree, TOKENHARBOR_QUOTA_CODE, tokenharborResetAt, tokenharborKeyFree |

### test/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `api-request.test.js` | 271 | Sends headers and one SSE chunk, then holds the response open. | a normal end resolves the reply and reports one record after it, a socket timeout reports exactly one record, a blocked request never leaves and reports once, a cancel after the end, a second cancel and an unknown id change nothing, a recorder that throws never touches the reply, and runs only after it, an unparsable URL resolves as a network error instead of rejecting |
| `check-import-counts.test.js` | 72 |  | before the import: legacy counts only, after the import every count matches and nothing secret is printed |
| `flush.test.js` | 52 | answer: 'right' (echo the token), 'stale' (an old token), 'never'. | resolves "done" when the renderer confirms, then stops listening, a renderer that never answers cannot hold the close past the timeout, an answer to an earlier request is ignored, a destroyed window is skipped at once, the default wait is 2 seconds |
| `helpers.js` | 155 | Shared test helpers. Nothing here touches the real app data folder: stores |  |
| `main-wiring.test.js` | 81 | main.js needs Electron and can't be loaded under the test runner, so its | the startup-failure path closes the log database too, requests.log is no longer written; showing and clearing it still work, api-request goes through the requester and takes no logLevel, src/logs and src/api-request never load electron |
| `renderer-ulid.test.js` | 28 | ulid.js is a plain browser script that declares a global function; it is | the history repository keeps a run id the renderer made |
| `repo-map.test.js` | 49 | docs/CODE_MAP.md is generated, and a stale one sends the next reader to the | the code map on disk is what the generator would write right now, a stale map is refused with exit 1 and the command that fixes it |
| `user-data.test.js` | 62 |  | fresh install uses the new folder and renames nothing, legacy only is moved to the new folder, both exist: the new folder wins and legacy is untouched, two first launches racing: the loser follows the folder the winner moved, locked legacy (old version running) keeps using the legacy folder |

### test/catalog/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `atomic.test.js` | 62 | Every JSON file the app owns is replaced atomically: a reader never sees a |  |
| `build.test.js` | 366 |  | a negative published price reads as null, never as -1000000 (§16.4), a sentinel price loses to the other source, not to nothing (§16.4), output_modalities is unioned across listings of one identity (§16.6) |
| `engine.test.js` | 432 | A sources stand-in backed by two Maps. It keeps the disk out of the test while | loadCache rebuilds from what is already cached, with no fetch at all, syncAll stores every payload that arrived and rebuilds, a source that fails after succeeding keeps its payload and reads stale, a second syncAll while one is in flight is refused with SYNC_IN_PROGRESS, syncAll resolves to one shape on either path, with the sync already over, syncIfUnscored syncs once for an unknown row, then gives up on it |
| `fetch.test.js` | 165 |  | an answer comes back parsed with accept: application/json added, a caller header survives, and a caller-set accept wins, exactly one retry on any failure, and the answer still arrives, the retry waits one full RETRY_DELAY_MS before the second attempt, a non-2xx is a failure even though the transport worked, unparsable JSON fails and retries: a truncated payload is not a source |
| `ipc.test.js` | 882 | The five catalog channels, the single-flight door and the read/write split. | registers exactly the five channels spec §6 names, two overlapping ingests for one provider cost one snapshot write, catalog:health keeps only the last 20 samples, catalog:sources syncs when forced and reports without the TTL otherwise, catalog:sources answers with the engine summary, not with a bare ok, catalog:fetch-info lists each field that moved, old to new |
| `keys.test.js` | 144 | lib/keys.js is where every cross-source model match happens. These cases are |  |
| `non-text.test.js` | 288 |  | a published non-text output is proof; silence is not, output_modalities reaches the row at all, a video model never enters the catalog, a row that publishes no modality is kept, the dropped rows are gone BEFORE the fits are computed, any one of the three proofs drops the row, and none of them keeps it |
| `row.test.js` | 301 |  | the row is exactly the reference shape, with nothing invented, an absent capability is null, never false — the rule the port rests on, today\, eight price spellings all land on cost per million, the preferred spelling wins when a provider co-publishes both spellings, a negative published price reads as null, and the kind says unknown |
| `scoring.test.js` | 547 | lib/scoring.js turns catalog rows into score + rank. Fits run on synthetic | a provider row reaches a measured catalog row through its alias alone |
| `snapshot.test.js` | 539 | src/catalog/snapshot.js diffs each sync against a store seam and reports which | one provider\, baseline sync: nothing is flagged new or removed, a model appearing after the baseline is flagged added and is_new, removed models become retained tombstones after REMOVED_WINDOW_DAYS, moved reports the edge, not the window a change is still inside, a model coming back from a tombstone is a move |
| `sources.test.js` | 231 | The one difference the original could not carry over: it sent its own | exactly four sources, in the reference order, with the reference urls, a row whose category is not overall ends that board and is not kept, a failure after a success keeps the payload and marks the source stale, readCache is null until both files exist, rowCount counts usable rows after indexing, not document size, newestFetchedAt is the newest meta timestamp across the four, or null |
| `util.test.js` | 70 |  | asNumber: absent, empty and unparsable all stay null, never 0, perMillion: null in, null out — a missing price is not free, boolOrNull: only a real true or false is an answer, providerOf: the routing prefix, or empty string, clamp: min then max |

### test/db/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `catalog.test.js` | 148 |  | a catalogue round-trips deep-equal, unknown entry fields are kept under summary_json.extra, absent benchError/capsError read back as null; absent caps stays absent, keyIds keep their order, unchanged rows are not rewritten, before or after a read, an empty model set never replaces a non-empty one without reset |
| `cipher.test.js` | 54 |  | encrypt wraps in the enc:v1: envelope and decrypt opens it, encrypt refuses when OS encryption is unavailable (never plaintext), encrypt refuses an empty value, decrypt refuses a value without the envelope, decrypt of a value encrypted elsewhere throws, isEnvelope needs the prefix and a payload |
| `explorer.test.js` | 37 |  |  |
| `history.test.js` | 112 |  | append and read round-trip today\, runs come back in insertion order, not by time, append trims to the cap, results of trimmed runs go too, historyCap clamps to 5000 and falls back to 300, clear empties runs and results, a malformed run is refused and nothing is written |
| `import-json.test.js` | 479 |  | imports every file in one go and renames them, an I/O error that clears on a retry imports normally, malformed catalogue entries and history rows are skipped and counted, a plaintext legacy key is encrypted on the way in, a legacy custom provider is imported as stored, flagged custom, keys without an id, with a duplicate id or an unusable id get fresh ids |
| `ipc.test.js` | 177 |  | registers exactly the data channels, read-config on an empty database, read-config hands out placeholders and hints, never keys, no reply hands a secret to the renderer, copy-key writes the clipboard in main and refuses a key it cannot read, save-secret answers with the placeholder, or empty after a delete |
| `keys.test.js` | 229 | Needs escaping in JSON and in a URL. | a header placeholder becomes the key for its own provider, a placeholder in the URL is replaced URL-encoded, inside a JSON body the key is inserted JSON-escaped, a non-JSON string body gets the raw key, an object body is sent as JSON with the key inside, the longest matching key id wins |
| `open.test.js` | 220 | Migration v2 is additive, so v1's own shape is worth pinning on its own — and it | schema v1: every table it shipped with, and install_id, schema v2 adds the two snapshot tables and touches models not at all, a v1 file upgrades to v2 with every row it held, pragmas on a file: WAL, NORMAL, foreign keys, busy timeout, temp store, :memory: reports journal_mode memory, reopening an up-to-date file runs nothing and makes no backup |
| `providers.test.js` | 253 |  | the placeholder of the same key keeps the stored cipher, a new value replaces the secret and the next read sees it, sending the same plaintext back keeps the stored cipher, keys missing from the payload are deleted, a key id that another provider owns is refused, created_at survives updates and position follows payload order |
| `settings-secrets.test.js` | 104 |  | settings rows round-trip JS types exactly, saveSettings strips aaApiKey and keeps fields the renderer does not know, saveSettings rejects anything but an object, saveTest stores the test row as given, secrets: unknown names are refused, openRouterApiKey is a known secret bound to openrouter.ai |
| `snapshots.test.js` | 249 | The two-table roster repository: what survives a write, what a tombstone is, | a provider with no snapshot reads null, not an empty object, every file-level field the reference kept survives the round trip, pendingDrop is present only while a mass drop is quarantined, listProviderIds is the set that has ever produced a snapshot, forgetting a model deletes its row, so it is not read as a removal, setHealth records a probe without rewriting the summary or the history |

### test/logs/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `classify.test.js` | 197 |  | endpointOf keeps origin and path, drops the query, endpointOf caps a very long http(s) origin+path at 500 characters too, bodyText and modelRequested read the model from a JSON body, isStreamRequest: stream true in the body, or an event-stream reply, Anthropic JSON: input counts cache reads and writes, OpenAI SSE: usage from the final chunk, model from the chunks |
| `ipc.test.js` | 104 |  | registers exactly the log channels, with logging on, the reads answer from the database, a failing query rejects the call and is logged |
| `lookups.test.js` | 44 |  | a missing or malformed price is null, the provider lookup lists id, name and base URL |
| `open.test.js` | 132 |  | open(":memory:") wires the writer, meta and the query API on schema v1, reopening an up-to-date file runs no migration, a migration that throws rolls back and leaves the version, downgrade guard: a newer schema is refused and the file is not written, tryOpen: a corrupt file turns logging off and is left as it was, tryOpen: a newer schema turns logging off with the reason |
| `query.test.js` | 604 | entries: a row, or { row, body }. | list: limit defaults to 50 and is capped at 200, list filters: time range, source, provider, model, status, run id, list text search: uid, run id and error message; % and _ are literal, filter arrays are capped at 50 items, afterId returns only newer rows (live tail), get: the row with its body, or null |
| `recorder.test.js` | 221 |  | a successful chat: identity, tags, model, usage, cost and meta, cost: a free model costs 0; an unknown price or no usage is NULL, TTFT is kept for streams only, bodies: Off, Failed only and All, and what counts as failed, no form of a substituted secret reaches a queued record, a record that cannot be built is counted as dropped, never thrown |
| `retention.test.js` | 198 |  | rows older than the limit go with their bodies, a chunk at a time, bodies older than their limit go and has_body is cleared; the rows stay, roll-ups older than the stats limit go, last_purge_at is recorded and the freed pages are handed back, purge lets other work run between chunks, closing the database mid-purge ends it without throwing |
| `schema.test.js` | 62 |  | schema v1 creates the four tables and six indexes, a row with only the required columns gets the defaults, request_uid is unique, usage_hourly has one row per hour, provider, model and source, readLogSettings: stored values are used as they are |
| `scrub.test.js` | 44 | sk-"quote\slash/7: needs escaping in JSON and in a URL. | replaces the raw secret with its placeholder, replaces the JSON-escaped, \\/-escaped and URL-encoded forms, nothing to scrub: the text comes back as it was |
| `writer.test.js` | 182 |  | rows wait for the 250 ms timer, then land in one flush, the 500th record flushes at once, a body is stored under its row id and has_body is set, beyond the queue cap the oldest records are dropped and counted, add() never throws, even after the database closed, the count continues from the value in meta |

### test/renderer/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `logs-format.test.js` | 140 | logs-format.js is a plain browser script of top-level function | logEscape: provider text cannot close a tag, toViewModel: escapes every string it puts on the page, formatCost: micros to dollars, small amounts kept visible, formatTokens: thousands separated, null is a dash, statusTone: one tone per outcome, passRateText: a fraction becomes a percentage, null stays unknown |
