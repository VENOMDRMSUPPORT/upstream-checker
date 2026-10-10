# Code map

> GENERATED FILE — do not edit by hand. Regenerate with: npm run repo:map

137 files under src/, scripts/, test plus the app shell and the stylesheet. Each row is one file: its size, what it is for and the names it defines. Read this before opening files, then open only what the task needs — for the long ones, jump with the landmarks section below.

The architecture behind these files — boot order, IPC channels, the two databases, the request lifecycle — is in [ARCHITECTURE.md](ARCHITECTURE.md). Task recipes are in [COOKBOOK.md](COOKBOOK.md).

## IPC channels

44 channels, in registration order. invoke/handle answers a promise; send/on is fire-and-forget. The renderer reaches them through window.electronAPI (src/preload.js).

| Channel | Registered in |
| --- | --- |
| `catalog:ingest` | src/catalog/ipc.js |
| `catalog:read` | src/catalog/ipc.js |
| `catalog:health` | src/catalog/ipc.js |
| `catalog:sources` | src/catalog/ipc.js |
| `catalog:fetch-info` | src/catalog/ipc.js |
| `catalog:events` | src/catalog/ipc.js |
| `catalog:events-read` | src/catalog/ipc.js |
| `read-config` | src/db/ipc.js |
| `database-explorer` | src/db/ipc.js |
| `save-settings` | src/db/ipc.js |
| `save-secret` | src/db/ipc.js |
| `save-test-definition` | src/db/ipc.js |
| `save-provider` | src/db/ipc.js |
| `merge-provider` | src/db/ipc.js |
| `delete-provider` | src/db/ipc.js |
| `copy-key` | src/db/ipc.js |
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

### src/main.js — 808 lines

| Line | Section |
| --- | --- |
| 62 | Local database — venom.db (src/db) |
| 78 | Request log — venom-logs.db (src/logs) |
| 165 | Model catalog engine — src/catalog |
| 688 | API requests (src/api-request.js) |
| 726 | Old request log file (requests.log) |

### src/renderer/app.js — 6874 lines

| Line | Section |
| --- | --- |
| 2 | VENOM ROUTER — Application Logic v2 |
| 26 | Model kinds |
| 97 | Settings |
| 410 | Saving — every write goes through persist() |
| 483 | Providers — each saved on its own (save-provider) |
| 537 | Run history — uptime, regressions, scheduling |
| 688 | Test definition — prompt + expected answer |
| 868 | Title bar |
| 875 | Provider page — header |
| 1173 | API Keys management |
| 1345 | Fetch models from provider — only models for the key's plan |
| 1636 | Render the models list |
| 1802 | Test reliability settings |
| 1968 | Keys and pacing |
| 2182 | Testers — one request, judged by the model's kind |
| 2675 | Test a single model — adaptive hedge, handles reasoning, empty, rate limits |
| 2846 | Test all selected models |
| 3102 | Results table |
| 3319 | Reference facts for the test table |
| 3708 | Full response modal |
| 3756 | Stats & status |
| 3833 | Export |
| 3901 | Update handling |
| 4165 | Add Key modal |
| 4274 | Edit Provider modal |
| 4349 | Init |
| 4352 | Scheduled re-testing |
| 4385 | Settings panel |
| 4868 | Security — the app lock from inside the app |
| 5128 | Sidebar ambience — moving stars and the signature heart |
| 5382 | Breadcrumb — shared helper |
| 5412 | Providers page |
| 5750 | Provider types — legend and markers |
| 5825 | Providers page — key management panel (table rows and cards) |
| 5845 | Action feedback — Recheck and key Test |
| 6364 | Stat cards — shared |
| 6381 | Data toolbar — shared |
| 6509 | Providers page — Connected view |

### src/renderer/catalog.js — 2101 lines

| Line | Section |
| --- | --- |
| 2 | Models Catalog — the merged reference, scored |

### src/renderer/logs.js — 1308 lines

| Line | Section |
| --- | --- |
| 2 | Log pages — Runs, Requests and Monitoring |

### test/catalog/ipc.test.js — 946 lines

*(no section banners)*

### src/renderer/index.html — 1690 lines

| Line | Section |
| --- | --- |
| 266 | page: overview |
| 308 | page: providers |
| 329 | page: database |
| 385 | page: catalog |
| 405 | page: activity |
| 414 | page: provider |
| 540 | page: history |
| 564 | page: monitor |
| 572 | page: settings |
| 590 | settings: sec-appearance |
| 594 | settings: sec-test |
| 598 | settings: sec-schedule |
| 602 | settings: sec-speed |
| 606 | settings: sec-reliability |
| 610 | settings: sec-catalog |
| 614 | settings: sec-history |
| 618 | settings: sec-logs |
| 622 | settings: sec-security |
| 626 | settings: sec-data |
| 630 | settings: sec-about |
| 1388 | overlay: response-modal |
| 1408 | overlay: add-key-modal |
| 1439 | overlay: add-provider-modal |
| 1474 | overlay: update-modal |
| 1491 | overlay: update-modal-notes |
| 1533 | overlay: log-drawer |
| 1534 | overlay: log-drawer-scrim |
| 1540 | overlay: log-drawer-body |
| 1544 | overlay: ku-drawer |
| 1562 | overlay: mc-chat-drawer |
| 1592 | overlay: mc-details-drawer |

### src/renderer/styles.css — 10002 lines

| Line | Section |
| --- | --- |
| 2 | VENOM ROUTER — Enterprise Dark Theme |
| 98 | Reset & Base |
| 148 | Title Bar |
| 328 | App shell — nav rail + page area |
| 397 | SIDEBAR BOTTOM ACCENT & STARRY STIPPLE EFFECT |
| 2051 | Animations |
| 2070 | API Keys |
| 2296 | Responsive |
| 2304 | Update Modal |
| 2535 | Settings |
| 2605 | Themes |
| 2955 | Pages — Overview placeholder |
| 3035 | Shell header |
| 3312 | Dark mode: pages share the nav's visual language |
| 3339 | Provider page — one provider's keys, models and test runs |
| 3586 | Light mode — page area only |
| 3610 | Overview — live panels |
| 3739 | Card headers — one accent-led treatment everywhere |
| 3794 | Signature heart (nav footer) |
| 3858 | Sidebar ambience — a living layer of stars |
| 3932 | Breadcrumb — shared by every page that needs one |
| 3975 | Providers page |
| 4701 | Stat cards — shared (Overview, Providers, …) |
| 4742 | Page toolbar — one card for every page that has one |
| 4790 | Design system — form fields |
| 5142 | Data table — shared |
| 5422 | Provider types — legend and markers |
| 5609 | Settings page — layout |
| 5618 | Providers — expandable rows and the key panel |
| 5642 | Providers — list of row cards |
| 6417 | Settings — Unified 2-Column Design System |
| 6860 | Settings content — one design language for every tab |
| 7258 | Models Catalog |
| 7744 | Key usage (key-usage.js) — quota and expiry in the key row, the rest in a |
| 7903 | Catalog: live health badge + toast notifications |
| 7958 | Model details drawer — a full-height sidebar sliding in from the right, |
| 8114 | Model chat drawer — a full-height panel sliding in from the right, |
| 8492 | Log pages — Runs, Requests, Monitoring |
| 9075 | Monitoring Page |
| 9220 | Database explorer — compact SQLite workbench |
| 9226 | Model Activity — same page padding as every other page |
| 9445 | App lock screen — the front door |
| 9823 | Header profile menu |
| 9882 | Security settings |
| 9943 | Notifications bell + Model Activity |

### scripts/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `check-import-counts.js` | 169 | Owner-run, read-only comparison of the legacy JSON files with venom.db. | BLOCKED, relaunchUnderElectron, blockNetworking, asObject, readJson, legacyCounts, dbCounts, compare, main |
| `generate-icons.js` | 98 | Builds every brand asset the app uses from the VenomGPT brand pack, kept in | ROOT, SRC, ASSETS, OUT, ACCENTS, DEFAULT_ACCENT, UI_SIZE, ICO_SIZES, resize, buildICO, main |
| `keystore-check.js` | 77 | Throwaway verification of src/keystore.js under a real Electron process. | quiet, failures, check, save, load |
| `release.mjs` | 171 | One-shot release: tag the current version, push it, publish the notes, then | REPO, version, tag, run, capture, changelogNotes, notes, smokeTest, releasesForTag, localTags |
| `repo-map.mjs` | 276 | Code map — a compact symbol index of the source tree | ROOT, OUT, ROOTS, EXTENSIONS, SKIP_DIRS, MAX_SYMBOLS, MAX_TEST_NAMES, MAX_PURPOSE, MAX_LANDMARKS, LANDMARK_MIN_LINES, PLAIN_FILES, PURPOSE_OVERRIDES, +15 more |
| `reset-lock.js` | 127 | Deletes the app lock row, nothing else. | REQUIRED, Refused, fail, usage |
| `run-tests.js` | 43 | Runs the unit tests under Electron's own Node (ELECTRON_RUN_AS_NODE=1). | ROOT, findTests, args, files, result |

### scripts/live/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `boot-guard.cjs` | 93 | An Electron entry that arms a throwing network guard and then boots the real | REPORT, userDataFlag, SCRATCH, APPDATA, attempts, record, arm |
| `cdp.mjs` | 187 | Launches a separate VENOM Router on a scratch data folder with remote | require, ROOT, sleep, assertScratchDir, appEnv, withTimeout, launch, spawnPlain |
| `fixture.mjs` | 111 | Synthetic legacy data folder for the live checks: config.json, catalog.json | FIXTURE, writeFixture |
| `mock-provider.mjs` | 66 | A local stand-in for the fixture's providers: OpenAI-shaped /models and | startMock |
| `verify-catalog-boot.mjs` | 428 | Something the owner can click — proven two ways, on a scratch data folder. | PORT, failures, check, sleep, READY, openCatalogAndRead, checkFailureWords, checkModelsCatalogPageUntouched, measureCatalog, runGuardedSession, runPositiveControl, runSyncedSession, +4 more |
| `verify-catalog-legend.mjs` | 235 | Live check of the Models page's capability legend, against the fixture folder. | failures, check, PORT, READY, TONES, toneClass, measureLegend, dir, mock |
| `verify-catalog-sidebar.mjs` | 118 | Live check of the Models page's details drawer and its two tabs. | failures, check, dir, mock |
| `verify-db.mjs` | 544 | Live check of the local database against a synthetic data folder. | failures, check, sleep, until, READY, checkImport, checkKeysStayInMain, saveForNextRun, queueSaveThenClose, checkFlushOnClose, checkPersistence, checkSingleInstance, +20 more |
| `verify-lock.mjs` | 490 | Live check of the app lock, against a scratch data folder. | require, ROOT, SHOT_DIR, shotPath, runResetLock, readRow, readLockRow, readSurvivors, failures, check, PORT, READY, +4 more |
| `verify-provider-table.mjs` | 420 | Live check of the provider test table's reference columns, against the fixture | REAL_CACHE, seedRealCache, REAL_MODELS, startMockWithRealModels, failures, check, READY, freePort, measureTable, dir, mock, app |

### src/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `api-request.js` | 226 | api-request — every outbound request the renderer asks for | CONTENT_TOKEN, CANCEL_REASONS, CUT_OFF, createApiRequester |
| `flush.js` | 38 | Close handshake with the renderer | DEFAULT_FLUSH_TIMEOUT_MS, requestFlush |
| `keystore.js` | 74 | API keys at rest | decryptKeyEntry, encryptKeyEntry, eachStoredKey, countPlaintextKeys |
| `main.js` | 808 | Main process: data folder, boot order, IPC wiring, auto-updater | isPrimary, store, importReport, keyResolver, auth, logs, logsError, recorder, priceBook, purgeScheduler, logSettings, DEFAULT_LOCK_IDLE_MIN, +23 more |
| `preload.js` | 124 | contextBridge surface — the renderer's only door to main | minimize, maximize, close, setWindowIcon, authStatus, authUnlock, authChange, authLock, authActivity, onAuthLocked, apiRequest, cancelApiRequest, +48 more |
| `user-data.js` | 29 | Where the app keeps its data. Electron names the userData folder after the | LEGACY_DIR, CURRENT_DIR, resolveUserDataDir |

### src/auth/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `hash.js` | 89 | The owner password — scrypt hash and verify | DEFAULT_PASSWORD, ALGO, N, R, P, KEYLEN, SALT_BYTES, parse, derive, hashPassword, verifyPassword, isReadable |
| `index.js` | 187 | The app lock — session, idle and throttle | MAX_FAILED, THROTTLE_MS, MIN_PASSWORD_LENGTH, normaliseIdle, createAuthLock |
| `ipc.js` | 77 | src/auth/ipc.js | registerAuthIpc |

### src/catalog/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `atomic.js` | 32 | Replacing a JSON file the app owns. Every store here (source cache, provider | writeJsonAtomic |
| `build.js` | 624 | The scoring catalog: merges the four upstream sources into one row per model | IMAGE_SLUG_RE, deriveCostKind, deriveCreateImages, usableNumber, pickNumber, indexModelsDev, indexOpenRouterModels, emptyBench, BENCH_VALUES, isBetter, rememberBench, indexBenchmarks, +10 more |
| `engine.js` | 277 | Owns the in-memory copy of the four sources and the reference built from them, | SOURCE_SYNC_MIN_AGE_MS, emptySource, createEngine |
| `fetch.js` | 78 | The one JSON fetch helper for every upstream call the catalog makes. Sends | DEFAULT_TIMEOUT_MS, RETRY_DELAY_MS, DEFAULT_CACHE_TTL_MS, friendlyMessage, createFetcher |
| `ipc.js` | 527 | src/catalog/ipc.js | LATENCY_SAMPLES_KEPT, DATA_CODES, readPurgeWindowDays, purgeWindowDays, catalogError, COMPARE_FIELDS, same, diffRow, publishedOnly, readHealth, appendLatency, CHECKS_SAMPLES_KEPT, +3 more |
| `keys.js` | 311 | Model-name normalization. The same model shows up under different names in | MATCH_AMBIGUOUS, LAB_PROVIDERS, PRICING_MODIFIERS, QUALITY_MODIFIERS, BUILD_SUFFIX_RE, VARIANT_MODIFIERS, PARAM_SIZE_RE, QUANT_TOKENS, cleanModelId, modelSlug, identityKey, normalizeName, +15 more |
| `row.js` | 348 | One adapter's model object → the shared provider row the reference merge | ROW_FIELDS, firstNumber, positive, pick, dedupe, LAB_TOKENS, labTokenOf, familyOf, costKind, readPricing, readsTools, readsReasoning, +7 more |
| `scoring.js` | 593 | Score estimation, dense ranking, and the lookup that gives provider rows their | MIN_FIT_SAMPLES, MIN_FIT_R2, SPEC_AGE_CAP_MONTHS, SCORE_QUALITY, scoreQuality, fitLinear, solveLinear, specFeatures, fitSpec, hasSpecSignal, specModelCache, specModelFor, +15 more |
| `snapshot.js` | 269 | src/catalog/snapshot.js | NEW_WINDOW_DAYS, REMOVED_WINDOW_DAYS, DROP_CONFIRMATION_MS, DROP_MIN_PREVIOUS, DROP_MIN_LOSS, invalidPayload, suspiciousDrop, daysBetween, validateProviderRows, cloneRows, DERIVED_FIELDS, BLANK_STRING_FIELDS, +7 more |
| `sources.js` | 184 | The four upstream documents that feed the reference catalog, how each is | SOURCES, ARENA_ROWS, ARENA_PAGE, ARENA_MAX_OFFSET, arenaUrl, dataPath, metaPath, createSources |
| `util.js` | 101 | Small pure helpers shared by the engine and the provider modules. | asNumber, perMillion, uniqueJoin, unixToDate, boolOrNull, hasParam, listHas, providerOf, median, clamp, monthsSince |

### src/db/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `cipher.js` | 49 | Secrets at rest — the enc:v1: envelope | ENC_PREFIX, isEnvelope, createCipher, revealCached |
| `explorer.js` | 53 | Read-only, bounded database inspection. Identifiers are taken only from | MAX_LIMIT, REDACTED_COLUMN, quoteIdentifier, inspectDatabase |
| `import-json.js` | 405 | One-shot import of the legacy JSON files | FILES, READ_ATTEMPTS, READ_GAP_MS, ImportAbort, isObject, renamedAs, plural, listImportedFiles, readWithRetry, parse, normaliseConfig, normaliseHistory, +4 more |
| `index.js` | 160 | Local database — venom.db | DB_FILE, BACKUPS_KEPT, DbTooNewError, applyPragmas, latestVersion, backupBeforeMigrate, migrate, getMeta, setMeta, createRepos, close, open |
| `ipc.js` | 103 | Data IPC — the renderer's only way to the database | readConfig, registerDataIpc |
| `keys.js` | 161 | Placeholders → secrets, for outgoing requests | TOKEN, HAS_TOKEN, originOf, collector, createKeyResolver |
| `migrations.js` | 249 | Schema migrations |  |
| `ulid.js` | 23 | ULID: 48-bit millisecond time + 80 random bits in Crockford base32. Sorts by | ALPHABET, ulid |

### src/db/repos/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `auth.js` | 77 | The app lock row — app_lock | createAuthRepo |
| `history.js` | 106 | Run history — test_runs + test_results | ULID, DEFAULT_MAX_RUNS, MAX_RUNS_CEILING, historyCap, num, createHistoryRepo |
| `providers.js` | 251 | Providers and their API keys | KEY_PLACEHOLDER, ANY_PLACEHOLDER, KEY_ID, maskKey, createProvidersRepo |
| `roster-events.js` | 123 | Roster change events — roster_events | EVENTS_KEPT, KINDS, createRosterEventsRepo |
| `secrets.js` | 70 | Named secrets — the OpenRouter key | SECRET_ORIGINS, createSecretsRepo |
| `settings.js` | 45 | Settings rows — settings, test, window | createSettingsRepo |
| `snapshots.js` | 187 | One provider's roster, split across the two tables the reference kept in one | WARNING_MAX, clip, createSnapshotRepo |

### src/logs/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `classify.js` | 283 | Request classification — pure, no I/O | QUOTA_CODES, JSON_PARSE_LIMIT, SCAN_WINDOW, MODEL_MAX, RETURNED_MODEL_MAX, LATENCY_EDGES, clipped, tokens, endpointOf, bodyText, parseObject, modelRequested, +13 more |
| `index.js` | 107 | Request log — venom-logs.db | LOGS_FILE, LogsTooNewError, latestVersion, migrate, open, tryOpen |
| `ipc.js` | 64 | Request log IPC — what the log pages (sub-project C) call | LOGS_CHANNELS, NOT_SAVED, offInfo, registerLogsIpc |
| `lookups.js` | 54 | venom.db lookups for the request log | createProviderLookup, readPrice, createPriceBook |
| `migrations.js` | 111 | Request log schema migrations (venom-logs.db) |  |
| `query.js` | 530 | Request log queries — what the log pages (sub-project C) read | HOUR, MAX_LIMIT, DEFAULT_LIMIT, MAX_FILTER_ITEMS, EXPORT_CHUNK, EVERYTHING, EXPORT_COLUMNS, LIKE, CLASS_COUNTERS, GROUP_COLUMNS, SORT_COLUMNS, MAX_SORT_RANGE_MS, +22 more |
| `recorder.js` | 186 | Request record — what one finished request becomes in the log | SOURCES, CANCEL_REASONS, TRIGGERS, BODY_MAX, REDACTED_HEADERS, shortString, whole, clip, redactHeaders, metaOf, originOf, whoFor, +3 more |
| `retention.js` | 157 | Request log retention — chunked purge, stepped vacuum | DAY, CHUNK, VACUUM_PAGES, defaultYield, neverBusy, inChunks, purgeLogsBefore, purgeBodiesBefore, purgeRollupsBefore, stepVacuum, monthsAgo, purge, +1 more |
| `scrub.js` | 39 | Scrub substituted secrets out of stored log text | formsOf, scrub |
| `settings.js` | 27 | Request log settings, read by main from the settings row | LOG_LEVELS, LOG_DEFAULTS, wholeIn, readLogSettings |
| `writer.js` | 182 | Batched writer — request_logs, request_bodies, usage_hourly | HOUR, WARN_EVERY_MS, ROW_COLUMNS, ROLLUP_KEYS, ROLLUP_COUNTERS, ERROR_CLASSES, ROLLUP_SQL, rollupDelta, rowValues, createWriter |

### src/renderer/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `activity.js` | 326 | Model activity — the notification center | PAGE_LIMIT, PAGE_STEP, PANEL_LIMIT, acState, acShell, AC_TOOLBAR, providerName, whenText, rel, itemHTML, added, dot, +38 more |
| `app.js` | 6874 | VENOM ROUTER — Application Logic v2 | DEFAULT_TEST_PROMPT, DEFAULT_EXPECTED, testPrompt, expectedAnswer, NA, RESPONSE_PREVIEW, truthy, KIND_LABELS, kindLimits, classifyModel, isMedia, isDecision, +428 more |
| `catalog-caps.js` | 217 | Model capabilities — what a catalogue row can do, read as three states | CAT_CAPABILITIES, hasModality, publishedBool, filesState, outputState, capabilityState, BOOLEAN_CAPS, capabilityOrigin, capabilitySet, capabilityCounts |
| `catalog.js` | 2101 | Models Catalog — the merged reference, scored | state, chat, details, ui, keyOf, connectedIds, historyRuns, loadHistoryRuns, loadPromise, load, reload, applyRead, +238 more |
| `database.js` | 319 | Read-only SQLite explorer. All SQL, identifier checks, and redaction happen | PAGE_SIZE, state, byId, escape, number, DB_ICON, sourceCounts, setNotice, box, updateSourceTabs, isApp, isLogs, +33 more |
| `key-usage.js` | 539 | Key usage — quota, expiry and request history per API key | KEY_USAGE |
| `lock.js` | 400 | The app lock screen — src/renderer/lock.js | MIN_IDLE_MIN, el, resolved, onUnlocked, particle, frame, running, activityBound, lastActivitySent, throttleTimer, reduceMotion, ACTIVITY_SEND_MS, +35 more |
| `logs-format.js` | 132 | Log pages — pure formatting and mapping | LOGS_RANGES, logEscape, normalizeProvider, providerLabel, formatDuration, formatCost, formatTokens, logPad, formatWhen, statusTone, passRateText, rangePreset, +1 more |
| `logs.js` | 1308 | Log pages — Runs, Requests and Monitoring | state, el, REDUCED_MOTION, drawerOpener, closeTimer, tabFromRoute, parts, loadInfo, LOG_ICONS, emptyState, loggingOffMarkup, why, +130 more |
| `profile.js` | 83 | Header profile menu — Administrator, and the way out | wrap, button, pop, setOpen, isOpen, lockNow, lockItem, signOutItem |
| `provider-facts.js` | 288 | Reference facts for the Providers test table. | TEST_INPUTS, FILE_TOKENS, MIN_SAMPLES_FOR_LATENCY, resolveContext, resolveScore, resolveCost, resolveCapabilityRow, resolveInputs, readsToken, filesState, modalityParts, fmtPrice, +8 more |
| `ui-select.js` | 245 | Design system — select menu | CHEVRON, CHECK, valueDesc, indexDesc, menu, owner, active, LEAD_ICONS, labelOf, opt, sync, trigger, +21 more |
| `ui-stepper.js` | 114 | Design system — number input stepper | CHEVRON_UP, CHEVRON_DOWN, enhance, input, stepper, label, stepUnit, unit, repeatTimer, repeatInterval, stopRepeat, enhanceAll, +1 more |
| `ulid.js` | 22 | Run ids — ULID, the same format as src/db/ulid.js | newUlid |
| `index.html` | 1690 | App shell markup: nav, every page, the drawers and modals |  |
| `styles.css` | 10002 | The whole stylesheet: tokens, themes, accents, components |  |

### src/renderer/providers/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `darkapi.js` | 47 | DARK API — integrated provider module | INTEGRATED_PROVIDERS |
| `experiential.js` | 125 | Experiential Labs — integrated provider module | INTEGRATED_PROVIDERS |
| `inception.js` | 56 | INCEPTION LABS — integrated provider module | INTEGRATED_PROVIDERS |
| `mirai.js` | 160 | MIRAI API — integrated provider module | INTEGRATED_PROVIDERS |
| `nara.js` | 139 | NARA Router — integrated provider module | INTEGRATED_PROVIDERS |
| `nexum.js` | 61 | NEXUM ROUTER — integrated provider module | INTEGRATED_PROVIDERS |
| `tokenharbor.js` | 178 | Token Harbor — integrated provider module | INTEGRATED_PROVIDERS, TOKENHARBOR_VIRTUAL_OWNER, tokenharborIsZero, tokenharborIsFree, TOKENHARBOR_QUOTA_CODE, tokenharborResetAt, tokenharborKeyFree |

### test/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `api-request.test.js` | 271 | Sends headers and one SSE chunk, then holds the response open. | a normal end resolves the reply and reports one record after it, a socket timeout reports exactly one record, a blocked request never leaves and reports once, a cancel after the end, a second cancel and an unknown id change nothing, a recorder that throws never touches the reply, and runs only after it, an unparsable URL resolves as a network error instead of rejecting |
| `check-import-counts.test.js` | 78 |  | before the import: legacy counts only |
| `flush.test.js` | 52 | answer: 'right' (echo the token), 'stale' (an old token), 'never'. | resolves "done" when the renderer confirms, then stops listening, a renderer that never answers cannot hold the close past the timeout, an answer to an earlier request is ignored, a destroyed window is skipped at once, the default wait is 2 seconds |
| `helpers.js` | 155 | Shared test helpers. Nothing here touches the real app data folder: stores |  |
| `main-wiring.test.js` | 108 | main.js needs Electron and can't be loaded under the test runner, so its | the startup-failure path closes the log database too, requests.log is no longer written; showing and clearing it still work, api-request goes through the requester and takes no logLevel, api-request is gated by the app lock, and a gated call spends nothing, the app lock is built after the database opens and before the window, src/logs and src/api-request never load electron |
| `renderer-ulid.test.js` | 28 | ulid.js is a plain browser script that declares a global function; it is | the history repository keeps a run id the renderer made |
| `repo-map.test.js` | 49 | docs/CODE_MAP.md is generated, and a stale one sends the next reader to the | the code map on disk is what the generator would write right now, a stale map is refused with exit 1 and the command that fixes it |
| `user-data.test.js` | 62 |  | fresh install uses the new folder and renames nothing, legacy only is moved to the new folder, both exist: the new folder wins and legacy is untouched, two first launches racing: the loser follows the folder the winner moved, locked legacy (old version running) keeps using the legacy folder |

### test/auth/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `hash.test.js` | 83 | The owner password: scrypt hash and verify. Pure Node, no Electron. | the shipped default round-trips, the shipped default is not stored in a comparable form, a wrong password is refused, two hashes of the same password differ (fresh salt each time), a string with its own parameters still verifies after the cost is raised, malformed strings return false rather than throwing |
| `ipc.test.js` | 147 | The auth IPC surface: five channels, every one of them resolving, and nothing | registers exactly the five auth channels, auth:status reports the lock without ever carrying the hash, auth:unlock resolves a verdict rather than rejecting, auth:unlock before the row exists is LOCK_NOT_READY, not a rejection, auth:change refuses a weak value with a code the UI can act on, auth:lock ends the session and tells the main process why |
| `lock.test.js` | 317 | The app lock: session, idle expiry and throttle. Pure Node — the lock takes a | a fresh database is locked and carries the shipped default, ensureDefault never overwrites a row that already exists, status with no row reads as the default rather than as unlocked, the right password unlocks and the wrong one does not, unlocking with no row is LOCK_NOT_READY, not a wrong password, the throttle survives closing and reopening the app |

### test/catalog/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `atomic.test.js` | 62 | Every JSON file the app owns is replaced atomically: a reader never sees a |  |
| `build.test.js` | 366 |  | a negative published price reads as null, never as -1000000 (§16.4), a sentinel price loses to the other source, not to nothing (§16.4), output_modalities is unioned across listings of one identity (§16.6) |
| `engine.test.js` | 432 | A sources stand-in backed by two Maps. It keeps the disk out of the test while | loadCache rebuilds from what is already cached, with no fetch at all, syncAll stores every payload that arrived and rebuilds, a source that fails after succeeding keeps its payload and reads stale, a second syncAll while one is in flight is refused with SYNC_IN_PROGRESS, syncAll resolves to one shape on either path, with the sync already over, syncIfUnscored syncs once for an unknown row, then gives up on it |
| `fetch.test.js` | 165 |  | an answer comes back parsed with accept: application/json added, a caller header survives, and a caller-set accept wins, exactly one retry on any failure, and the answer still arrives, the retry waits one full RETRY_DELAY_MS before the second attempt, a non-2xx is a failure even though the transport worked, unparsable JSON fails and retries: a truncated payload is not a source |
| `ipc.test.js` | 946 | The seven catalog channels, the single-flight door and the read/write split. | registers exactly the seven channels spec §6 names, purge window reads the saved setting, clamped, defaulting to thirty days, two overlapping ingests for one provider cost one snapshot write, catalog:health keeps only the last 20 samples, catalog:sources syncs when forced and reports without the TTL otherwise, catalog:sources answers with the engine summary, not with a bare ok |
| `keys.test.js` | 144 | lib/keys.js is where every cross-source model match happens. These cases are |  |
| `non-text.test.js` | 288 |  | a published non-text output is proof; silence is not, output_modalities reaches the row at all, a video model never enters the catalog, a row that publishes no modality is kept, the dropped rows are gone BEFORE the fits are computed, any one of the three proofs drops the row, and none of them keeps it |
| `row.test.js` | 374 |  | the row is exactly the reference shape, with nothing invented, an absent capability is null, never false — the rule the port rests on, today\, eight price spellings all land on cost per million, the preferred spelling wins when a provider co-publishes both spellings, a negative published price reads as null, and the kind says unknown |
| `scoring.test.js` | 558 | lib/scoring.js turns catalog rows into score + rank. Fits run on synthetic | a provider row reaches a measured catalog row through its alias alone |
| `snapshot.test.js` | 575 | src/catalog/snapshot.js diffs each sync against a store seam and reports which | one provider\, baseline sync: nothing is flagged new or removed, a model appearing after the baseline is flagged added and is_new, removed models are purged past REMOVED_WINDOW_DAYS, a custom purge window is honored instead of the default, moved reports the edge, not the window a change is still inside |
| `sources.test.js` | 231 | The one difference the original could not carry over: it sent its own | exactly four sources, in the reference order, with the reference urls, a row whose category is not overall ends that board and is not kept, a failure after a success keeps the payload and marks the source stale, readCache is null until both files exist, rowCount counts usable rows after indexing, not document size, newestFetchedAt is the newest meta timestamp across the four, or null |
| `util.test.js` | 70 |  | asNumber: absent, empty and unparsable all stay null, never 0, perMillion: null in, null out — a missing price is not free, boolOrNull: only a real true or false is an answer, providerOf: the routing prefix, or empty string, clamp: min then max |

### test/db/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `auth-repo.test.js` | 124 | The app_lock row: one row, enforced by the schema, and a fresh database reads | migration v4 creates an empty app_lock table, a fresh database has no row, so the default password applies, ensureDefault writes exactly one row and never replaces it, the schema refuses a second row, setHash clears is_default and the failure counters, setHash on a missing row throws rather than silently doing nothing |
| `cipher.test.js` | 54 |  | encrypt wraps in the enc:v1: envelope and decrypt opens it, encrypt refuses when OS encryption is unavailable (never plaintext), encrypt refuses an empty value, decrypt refuses a value without the envelope, decrypt of a value encrypted elsewhere throws, isEnvelope needs the prefix and a payload |
| `explorer.test.js` | 37 |  |  |
| `history.test.js` | 112 |  | append and read round-trip today\, runs come back in insertion order, not by time, append trims to the cap, results of trimmed runs go too, historyCap clamps to 5000 and falls back to 300, clear empties runs and results, a malformed run is refused and nothing is written |
| `import-json.test.js` | 480 |  | imports every file in one go and renames them, an I/O error that clears on a retry imports normally, a plaintext legacy key is encrypted on the way in, a legacy custom provider is imported as stored, flagged custom, keys without an id, with a duplicate id or an unusable id get fresh ids, a key with no value is skipped and reported |
| `ipc.test.js` | 224 | The catalogue left this surface: the model pool moved to repos.snapshots and | registers exactly the data channels, read-config on an empty database, read-config hands out placeholders and hints, never keys, no reply hands a secret to the renderer, copy-key writes the clipboard in main and refuses a key it cannot read, copy-key works again once the app is unlocked |
| `keys.test.js` | 229 | Needs escaping in JSON and in a URL. | a header placeholder becomes the key for its own provider, a placeholder in the URL is replaced URL-encoded, inside a JSON body the key is inserted JSON-escaped, a non-JSON string body gets the raw key, an object body is sent as JSON with the key inside, the longest matching key id wins |
| `open.test.js` | 267 | Migration v2 is additive, so v1's own shape is worth pinning on its own — and it | schema v1: every table it shipped with, and install_id, v3 is the irreversible one: backed up first, the legacy pool empty after, a v1 file upgrades to v2 with every row it held, pragmas on a file: WAL, NORMAL, foreign keys, busy timeout, temp store, :memory: reports journal_mode memory, reopening an up-to-date file runs nothing and makes no backup |
| `providers.test.js` | 253 |  | the placeholder of the same key keeps the stored cipher, a new value replaces the secret and the next read sees it, sending the same plaintext back keeps the stored cipher, keys missing from the payload are deleted, a key id that another provider owns is refused, created_at survives updates and position follows payload order |
| `roster-events.test.js` | 92 | Roster change events: one row per model arrival and departure, read by the | an empty store lists nothing and owes no unread, recorded arrivals and departures list newest-first with their facts, list filters by provider, kind and read state, with a clamped limit, markRead takes ids or everything, and concurrent arrivals stay unread, counts totals each kind under the current filter, record refuses an unknown kind and an empty batch writes nothing |
| `settings-secrets.test.js` | 106 |  | settings rows round-trip JS types exactly, saveSettings rejects anything but an object, saveTest stores the test row as given, secrets: unknown names are refused, openRouterApiKey is a known secret bound to openrouter.ai, secrets: with OS encryption unavailable nothing is stored |
| `snapshots.test.js` | 249 | The two-table roster repository: what survives a write, what a tombstone is, | a provider with no snapshot reads null, not an empty object, every file-level field the reference kept survives the round trip, pendingDrop is present only while a mass drop is quarantined, listProviderIds is the set that has ever produced a snapshot, forgetting a model deletes its row, so it is not read as a removal, setHealth records a probe without rewriting the summary or the history |

### test/logs/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `classify.test.js` | 197 |  | endpointOf keeps origin and path, drops the query, endpointOf caps a very long http(s) origin+path at 500 characters too, bodyText and modelRequested read the model from a JSON body, isStreamRequest: stream true in the body, or an event-stream reply, Anthropic JSON: input counts cache reads and writes, OpenAI SSE: usage from the final chunk, model from the chunks |
| `ipc.test.js` | 104 |  | registers exactly the log channels, with logging on, the reads answer from the database, a failing query rejects the call and is logged |
| `lookups.test.js` | 81 | The engine's row shape, as repos.snapshots stores it: provider facts only, | a missing, half-stated or malformed price is null, the price book never reads the retired models table, the provider lookup lists id, name and base URL |
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
| `catalog-caps.test.js` | 139 | catalog-caps.js is a plain browser script of top-level consts and function | a published modality list that omits a token answers no, vision and audio are read from the input modalities, case-insensitively, only a real boolean counts as a published flag, files prefers the published flag and falls back to the modality list, a declared generator answers yes with no modality published, capabilityOrigin names where each answer was read from |
| `decision-probe.test.js` | 139 | The TypeSafe /systemone decision wire protocol — the `noul` probe body and | nara declares the TypeSafe decision hooks at adapter level, nara decisionProbe builds the noul question body, experiential declares the same hooks at adapter level, readDecisionAnswer scores an object answer, named in the row, readDecisionAnswer scores a bare numeric answer, readDecisionAnswer returns null when no probability comes back |
| `key-quota-state.test.js` | 67 | The quota-state helpers in src/renderer/app.js are plain top-level function | a per-model refusal is a partial spend, never a spent key, a model-less record spends the whole key, a reset-less record expires after the TTL, a dated record is untouched by the TTL |
| `logs-format.test.js` | 140 | logs-format.js is a plain browser script of top-level function | logEscape: provider text cannot close a tag, toViewModel: escapes every string it puts on the page, formatCost: micros to dollars, small amounts kept visible, formatTokens: thousands separated, null is a dash, statusTone: one tone per outcome, passRateText: a fraction becomes a percentage, null stays unknown |
| `provider-facts.test.js` | 256 | provider-facts.js is a plain browser script of top-level consts and function | a model with nothing published resolves to null, never to zero, the provider context wins and the reference fills only the gap, the score carries its tier, and an unrated model stays unrated, an unpriced model is null, and a published zero is a zero, the ingested row is preferred, and the raw model is the fallback, the five inputs are read from the modality tokens, not the legend ids |
| `ui-stepper.test.js` | 155 | Mock DOM elements for testing the unit stepper in Node | enhance: ignores unit if no input[type="number"] exists, stepUnit: respects disabled and readOnly inputs |
