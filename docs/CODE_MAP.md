# Code map

> GENERATED FILE — do not edit by hand. Regenerate with: npm run repo:map

194 files under src/, scripts/, test plus the app shell and the stylesheet. Each row is one file: its size, what it is for and the names it defines. Read this before opening files, then open only what the task needs — for the long ones, jump with the landmarks section below.

The architecture behind these files — boot order, IPC channels, the two databases, the request lifecycle — is in [ARCHITECTURE.md](ARCHITECTURE.md). Task recipes are in [COOKBOOK.md](COOKBOOK.md).

## IPC channels

47 channels, in registration order. invoke/handle answers a promise; send/on is fire-and-forget. The renderer reaches them through window.electronAPI (src/preload.js).

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
| `router:status` | src/main.js |
| `router:refresh` | src/main.js |
| `router:profiles` | src/main.js |
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

### src/main.js — 1146 lines

| Line | Section |
| --- | --- |
| 387 | Local database — venom.db (src/db) |
| 403 | Request log — venom-logs.db (src/logs) |
| 490 | Model catalog engine — src/catalog |
| 1026 | API requests (src/api-request.js) |
| 1064 | Old request log file (requests.log) |

### src/renderer/app.js — 3601 lines

| Line | Section |
| --- | --- |
| 2 | VENOM ROUTER — Application Logic v2 |
| 33 | Model kinds |
| 104 | Settings |
| 235 | Saving — every write goes through persist() |
| 308 | Run history — uptime, regressions, scheduling |
| 459 | Test definition — prompt + expected answer |
| 828 | Title bar |
| 1125 | API Keys management |
| 1248 | Test reliability settings |
| 1344 | Testers — one request, judged by the model's kind |
| 1378 | Test all selected models |
| 1638 | Results table |
| 1713 | Reference facts for the test table |
| 2120 | Stats & status |
| 2224 | Update handling |
| 2230 | Add Key modal |
| 2338 | Edit Provider modal |
| 2413 | Init |
| 2416 | Scheduled re-testing |
| 2449 | Settings panel |
| 2840 | Security — the app lock from inside the app |
| 3071 | Breadcrumb — shared helper |
| 3101 | Providers page |
| 3148 | Providers page — key management panel (table rows and cards) |
| 3168 | Action feedback — Recheck and key Test |
| 3333 | Data toolbar — shared |

### src/renderer/catalog.js — 2125 lines

| Line | Section |
| --- | --- |
| 2 | Models Catalog — the merged reference, scored |

### src/renderer/logs.js — 1310 lines

| Line | Section |
| --- | --- |
| 2 | Log pages — Runs, Requests and Monitoring |

### src/router/index.js — 940 lines

*(no section banners)*

### test/catalog/ipc.test.js — 946 lines

*(no section banners)*

### src/renderer/index.html — 2403 lines

| Line | Section |
| --- | --- |
| 321 | page: overview |
| 363 | page: providers |
| 384 | page: database |
| 440 | page: catalog |
| 460 | page: activity |
| 469 | page: provider |
| 595 | page: history |
| 619 | page: monitor |
| 627 | page: router |
| 640 | page: settings |
| 658 | settings: sec-appearance |
| 662 | settings: sec-test |
| 666 | settings: sec-schedule |
| 670 | settings: sec-speed |
| 674 | settings: sec-reliability |
| 678 | settings: sec-catalog |
| 682 | settings: sec-history |
| 686 | settings: sec-logs |
| 690 | settings: sec-data |
| 694 | settings: sec-about |
| 1833 | page: profile |
| 2074 | overlay: response-modal |
| 2094 | overlay: add-key-modal |
| 2125 | overlay: add-provider-modal |
| 2160 | overlay: update-modal |
| 2177 | overlay: update-modal-notes |
| 2219 | overlay: log-drawer |
| 2220 | overlay: log-drawer-scrim |
| 2226 | overlay: log-drawer-body |
| 2230 | overlay: ku-drawer |
| 2248 | overlay: mc-chat-drawer |
| 2278 | overlay: mc-details-drawer |

### src/renderer/styles.css — 12987 lines

| Line | Section |
| --- | --- |
| 2 | VENOM ROUTER — Enterprise Dark Theme |
| 98 | Reset & Base |
| 148 | Title Bar |
| 328 | App shell — nav rail + page area |
| 397 | SIDEBAR BOTTOM ACCENT & STARRY STIPPLE EFFECT |
| 2052 | Animations |
| 2071 | API Keys |
| 2297 | Responsive |
| 2305 | Update Modal |
| 2536 | Settings |
| 2606 | Themes |
| 3846 | Tab footer notice — separator + plain text |
| 3900 | About — Reorganized 3-Part Architecture |
| 4207 | Pages — Overview placeholder |
| 4287 | Shell header |
| 4694 | Dark mode: pages share the nav's visual language |
| 4721 | Provider page — one provider's keys, models and test runs |
| 4968 | Light mode — page area only |
| 4992 | Overview — live panels |
| 5121 | Card headers — one accent-led treatment everywhere |
| 5176 | Signature heart (nav footer) |
| 5240 | Sidebar ambience — a living layer of stars |
| 5314 | Breadcrumb — shared by every page that needs one |
| 5357 | Providers page |
| 6083 | Stat cards — shared (Overview, Providers, …) |
| 6124 | Page toolbar — one card for every page that has one |
| 6172 | Design system — form fields |
| 6524 | Data table — shared |
| 6811 | Provider types — legend and markers |
| 7008 | Settings page — layout |
| 7017 | Providers — expandable rows and the key panel |
| 7041 | Providers — list of row cards |
| 7821 | Settings — Unified 2-Column Design System |
| 8567 | Settings content — one design language for every tab |
| 8965 | Models Catalog |
| 9451 | Key usage (key-usage.js) — quota and expiry in the key row, the rest in a |
| 9624 | Catalog: live health badge + toast notifications |
| 9697 | Model details drawer — a full-height sidebar sliding in from the right, |
| 9853 | Model chat drawer — a full-height panel sliding in from the right, |
| 10231 | Log pages — Runs, Requests, Monitoring |
| 10814 | Monitoring Page |
| 10959 | Database explorer — compact SQLite workbench |
| 10965 | Model Activity — same page padding as every other page |
| 11184 | App lock screen — the front door |
| 11572 | Header profile menu |
| 11757 | Profile Page — Universal Layout & Components |
| 12083 | Security settings |
| 12144 | Notifications bell + Model Activity |
| 12669 | Venom Router page (.page-router) |
| 12704 | Venom Profiles — fixed model color identity + dossiers |

### scripts/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `check-import-counts.js` | 169 | Owner-run, read-only comparison of the legacy JSON files with venom.db. | BLOCKED, relaunchUnderElectron, blockNetworking, asObject, readJson, legacyCounts, dbCounts, compare, main |
| `generate-icons.js` | 98 | Builds every brand asset the app uses from the VenomGPT brand pack, kept in | ROOT, SRC, ASSETS, OUT, ACCENTS, DEFAULT_ACCENT, UI_SIZE, ICO_SIZES, resize, buildICO, main |
| `keystore-check.js` | 77 | Throwaway verification of src/keystore.js under a real Electron process. | quiet, failures, check, save, load |
| `release.mjs` | 171 | One-shot release: tag the current version, push it, publish the notes, then | REPO, version, tag, run, capture, changelogNotes, notes, smokeTest, releasesForTag, localTags |
| `repo-map.mjs` | 313 | Code map — a compact symbol index of the source tree | ROOT, OUT, ROOTS, EXTENSIONS, SKIP_DIRS, MAX_SYMBOLS, MAX_TEST_NAMES, MAX_PURPOSE, MAX_LANDMARKS, LANDMARK_MIN_LINES, PLAIN_FILES, PURPOSE_OVERRIDES, +19 more |
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
| `verify-db.mjs` | 548 | Live check of the local database against a synthetic data folder. | failures, check, sleep, until, READY, checkImport, checkKeysStayInMain, saveForNextRun, queueSaveThenClose, checkFlushOnClose, checkPersistence, checkSingleInstance, +20 more |
| `verify-lock.mjs` | 486 | Live check of the app lock, against a scratch data folder. | require, ROOT, SHOT_DIR, shotPath, runResetLock, readRow, readLockRow, readSurvivors, failures, check, PORT, READY, +4 more |
| `verify-provider-table.mjs` | 420 | Live check of the provider test table's reference columns, against the fixture | REAL_CACHE, seedRealCache, REAL_MODELS, startMockWithRealModels, failures, check, READY, freePort, measureTable, dir, mock, app |
| `verify-renderer-modules.mjs` | 220 | Live acceptance for extracted renderer units: real DOM and scratch data only. | failures, check, dir |

### src/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `api-request.js` | 226 | api-request — every outbound request the renderer asks for | CONTENT_TOKEN, CANCEL_REASONS, CUT_OFF, createApiRequester |
| `flush.js` | 38 | Close handshake with the renderer | DEFAULT_FLUSH_TIMEOUT_MS, requestFlush |
| `keystore.js` | 74 | API keys at rest | decryptKeyEntry, encryptKeyEntry, eachStoredKey, countPlaintextKeys |
| `main.js` | 1146 | Main process: data folder, boot order, IPC wiring, auto-updater | venomRouter, venomGateway, venomGatewayStarting, readRosterRowsForRouter, startVenomRouter, gatewayPort, buildVenomRouter, venomGatewayStarted, ensureVenomGateway, refreshVenomRouter, isPrimary, store, +33 more |
| `preload.js` | 129 | contextBridge surface — the renderer's only door to main | minimize, maximize, close, setWindowIcon, authStatus, authUnlock, authChange, authLock, authActivity, onAuthLocked, apiRequest, cancelApiRequest, +51 more |
| `user-data.js` | 40 | Where the app keeps its data. Electron names the userData folder after the | LEGACY_DIR, CURRENT_DIR, DEV_DIR, resolveUserDataDir |

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
| `migrations.js` | 294 | Schema migrations |  |
| `ulid.js` | 23 | ULID: 48-bit millisecond time + 80 random bits in Crockford base32. Sorts by | ALPHABET, ulid |

### src/db/repos/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `auth.js` | 77 | The app lock row — app_lock | createAuthRepo |
| `history.js` | 106 | Run history — test_runs + test_results | ULID, DEFAULT_MAX_RUNS, MAX_RUNS_CEILING, historyCap, num, createHistoryRepo |
| `providers.js` | 309 | Providers and their API keys | KEY_PLACEHOLDER, ANY_PLACEHOLDER, KEY_ID, KEY_TIERS, normaliseTier, maskKey, createProvidersRepo |
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
| `activity.js` | 336 | Model activity — the notification center | PAGE_LIMIT, PAGE_STEP, PANEL_LIMIT, acState, acShell, AC_TOOLBAR, providerName, whenText, rel, itemHTML, added, dot, +39 more |
| `app.js` | 3601 | VENOM ROUTER — Application Logic v2 | DEFAULT_TEST_PROMPT, DEFAULT_EXPECTED, testPrompt, expectedAnswer, NA, RESPONSE_PREVIEW, truthy, KIND_LABELS, kindLimits, classifyModel, isMedia, isDecision, +270 more |
| `appearance.js` | 324 | Theme, accent and density controls; state is read through live getters. | VENOM_RENDERER |
| `catalog-caps.js` | 217 | Model capabilities — what a catalogue row can do, read as three states | CAT_CAPABILITIES, hasModality, publishedBool, filesState, outputState, capabilityState, BOOLEAN_CAPS, capabilityOrigin, capabilitySet, capabilityCounts |
| `catalog.js` | 2125 | Models Catalog — the merged reference, scored | state, chat, details, ui, keyOf, connectedIds, historyRuns, loadHistoryRuns, loadPromise, load, reload, applyRead, +242 more |
| `database.js` | 319 | Read-only SQLite explorer. All SQL, identifier checks, and redaction happen | PAGE_SIZE, state, byId, escape, number, DB_ICON, sourceCounts, setNotice, box, updateSourceTabs, isApp, isLogs, +33 more |
| `key-usage.js` | 607 | Key usage — quota, expiry and request history per API key | KEY_USAGE |
| `lock.js` | 400 | The app lock screen — src/renderer/lock.js | MIN_IDLE_MIN, el, resolved, onUnlocked, particle, frame, running, activityBound, lastActivitySent, throttleTimer, reduceMotion, ACTIVITY_SEND_MS, +35 more |
| `logs-format.js` | 132 | Log pages — pure formatting and mapping | LOGS_RANGES, logEscape, normalizeProvider, providerLabel, formatDuration, formatCost, formatTokens, logPad, formatWhen, statusTone, passRateText, rangePreset, +1 more |
| `logs.js` | 1310 | Log pages — Runs, Requests and Monitoring | state, el, REDUCED_MOTION, drawerOpener, closeTimer, tabFromRoute, parts, loadInfo, LOG_ICONS, emptyState, loggingOffMarkup, why, +130 more |
| `page-router.js` | 51 | Hash-route parsing and synchronization for the renderer shell. | VENOM_RENDERER |
| `profile-badges.js` | 95 | Venom Profiles — shared profile badges | SHORT, indexProfiles, map, add, classify, badgeHTML, label, state, warm, bridge, badgeFor, profile |
| `profile.js` | 83 | Header profile menu — Administrator, and the way out | wrap, button, pop, setOpen, isOpen, lockNow, lockItem, signOutItem |
| `provider-actions.js` | 228 | Provider key and health actions; persistence and network remain injected. | VENOM_RENDERER, copyKey, toggleKeyActive, removeKey, recheckProvider, refreshAfterKeyChange, probeKey, testKey, setKeyActive, deleteKey, showKeyDeletedToast, togglePvExpanded |
| `provider-detail.js` | 59 | The single-provider page header and API-key list. | VENOM_RENDERER |
| `provider-facts.js` | 288 | Reference facts for the Providers test table. | TEST_INPUTS, FILE_TOKENS, MIN_SAMPLES_FOR_LATENCY, resolveContext, resolveScore, resolveCost, resolveCapabilityRow, resolveInputs, readsToken, filesState, modalityParts, fmtPrice, +8 more |
| `provider-keys.js` | 198 | Shared provider-key status and rendering for cards and connected rows. | VENOM_RENDERER |
| `provider-models.js` | 290 | Provider model discovery, roster ownership and catalog ingestion. | VENOM_RENDERER |
| `provider-roster.js` | 291 | Connected and integrated providers page controller. | VENOM_RENDERER |
| `provider-store.js` | 118 | Runtime provider data and its persistence boundary. | VENOM_RENDERER |
| `provider-view.js` | 557 | Shared provider presentation and card/row markup. | VENOM_RENDERER, isConnected, providerWebsite, websiteLinkHTML, providerHost, providerStats, providerCapabilities, providerTags, RL_ICON, rlPopOpener, rateLimitPopHTML, openRateLimitPop, +23 more |
| `results-table.js` | 275 | Results table sort/filter/export and response modal. Row HTML and reference | VENOM_RENDERER |
| `router-status.js` | 454 | Venom Profiles — routing dossiers page | MIN_EVIDENCE, rtState, esc, api, buildShell, crumbs, refresh, DOSSIERS, POLICY, median, sorted, mid, +61 more |
| `settings-defaults.js` | 151 | Shipped settings defaults and appearance choices — no DOM or I/O. | VENOM_RENDERER |
| `settings-panel.js` | 247 | General settings form binding, cost estimate and section navigation. | VENOM_RENDERER |
| `shell.js` | 228 | App shell navigation, page lifecycle and Overview summaries. | VENOM_RENDERER |
| `sidebar-effects.js` | 83 | Deterministic sidebar stars and keyboard-accessible signature-heart effects. | VENOM_RENDERER |
| `test-attempts.js` | 310 | Provider test requests — chat, media and decision routes through injected IPC only. | VENOM_RENDERER |
| `test-policy.js` | 375 | Key eligibility, quota state and per-key pacing. Maps belong to each instance. | VENOM_RENDERER |
| `test-response.js` | 133 | Test response parsing, asset lookup and result classification — pure helpers. | VENOM_RENDERER |
| `test-runner.js` | 301 | Adaptive hedging and per-model retry orchestration, independent of DOM and application globals. | VENOM_RENDERER |
| `ui-select.js` | 245 | Design system — select menu | CHEVRON, CHECK, valueDesc, indexDesc, menu, owner, active, LEAD_ICONS, labelOf, opt, sync, trigger, +21 more |
| `ui-stepper.js` | 114 | Design system — number input stepper | CHEVRON_UP, CHEVRON_DOWN, enhance, input, stepper, label, stepUnit, unit, repeatTimer, repeatInterval, stopRepeat, enhanceAll, +1 more |
| `ulid.js` | 22 | Run ids — ULID, the same format as src/db/ulid.js | newUlid |
| `updates.js` | 292 | Update badge, modal and inert release-note rendering; download state belongs to this controller. | VENOM_RENDERER |
| `index.html` | 2403 | App shell markup: nav, every page, the drawers and modals |  |
| `styles.css` | 12987 | The whole stylesheet: tokens, themes, accents, components |  |

### src/renderer/providers/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `apinex.js` | 157 | APINEX — integrated provider module | INTEGRATED_PROVIDERS, APINEX_WEB_BASE |
| `darkapi.js` | 54 | DARK API — integrated provider module | INTEGRATED_PROVIDERS |
| `devora.js` | 61 | DEVORA — integrated provider module | INTEGRATED_PROVIDERS |
| `experiential.js` | 129 | Experiential Labs — integrated provider module | INTEGRATED_PROVIDERS |
| `inception.js` | 60 | INCEPTION LABS — integrated provider module | INTEGRATED_PROVIDERS |
| `jerouter.js` | 48 | JEROUTER — integrated provider module | INTEGRATED_PROVIDERS |
| `kiosapi.js` | 43 | KIOSAPI — integrated provider module | INTEGRATED_PROVIDERS |
| `mirai.js` | 160 | MIRAI API — integrated provider module | INTEGRATED_PROVIDERS |
| `nara.js` | 143 | NARA Router — integrated provider module | INTEGRATED_PROVIDERS |
| `nexum.js` | 61 | NEXUM ROUTER — integrated provider module | INTEGRATED_PROVIDERS |
| `tokenharbor.js` | 271 | Token Harbor — integrated provider module | INTEGRATED_PROVIDERS, TOKENHARBOR_VIRTUAL_OWNER, tokenharborIsZero, tokenharborIsFree, TOKENHARBOR_QUOTA_CODE, tokenharborResetAt, TOKENHARBOR_QUOTA_ATTEMPTS, TOKENHARBOR_QUOTA_MODELS, TOKENHARBOR_RETRY_BASE_MS, TOKENHARBOR_RETRY_AFTER_MAX_S, tokenharborLowerHeaders, tokenharborRetryAfterMs, +5 more |

### src/router/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `index.js` | 940 | Venom router plane: multi-account smart routing behind one local endpoint. | ROUTER_PORT, ROUTER_HOST, normalizeGatewayPort, TIER_DRAIN_ORDER, TIER_RANK, canonicalSlug, upstreamModelId, evaluateModelCapabilities, compressToolMessages, rescuePlainTextToolCalls, analyzeCascadeStage, PRO_MIN_SCORE, +30 more |

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
| `user-data.test.js` | 98 |  | fresh install uses the new folder and renames nothing, legacy only is moved to the new folder, both exist: the new folder wins and legacy is untouched, two first launches racing: the loser follows the folder the winner moved, locked legacy (old version running) keeps using the legacy folder, folder names: dev, packaged and legacy constants |

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
| `ipc.test.js` | 225 | The catalogue left this surface: the model pool moved to repos.snapshots and | registers exactly the data channels, read-config on an empty database, read-config hands out placeholders and hints, never keys, no reply hands a secret to the renderer, copy-key writes the clipboard in main and refuses a key it cannot read, copy-key works again once the app is unlocked |
| `keys.test.js` | 229 | Needs escaping in JSON and in a URL. | a header placeholder becomes the key for its own provider, a placeholder in the URL is replaced URL-encoded, inside a JSON body the key is inserted JSON-escaped, a non-JSON string body gets the raw key, an object body is sent as JSON with the key inside, the longest matching key id wins |
| `open.test.js` | 281 | Migration v2 is additive, so v1's own shape is worth pinning on its own — and it | schema v1: every table it shipped with, and install_id, schema v6 adds key tiers and the router tables without touching rows, v3 is the irreversible one: backed up first, the legacy pool empty after, a v1 file upgrades to v2 with every row it held, pragmas on a file: WAL, NORMAL, foreign keys, busy timeout, temp store, :memory: reports journal_mode memory |
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
| `apinex-provider.test.js` | 151 | Apinex discovery is tier-aware: a free key may call only the ids the public | a free key sees only allowFree ids, tagged FREE, a subscription key sees the full roster, none tagged FREE, an unreadable subscription answer is treated as free, not as paid, a 401 roster is an error naming the status, not an empty list, a free key reads its daily quota and the 00:00 UTC reset as expiry, a subscription key reads its plan quota and the plan expiry |
| `appearance-dom.js` | 39 | Minimal DOM boundary for production appearance controls; live gates prove geometry. |  |
| `appearance.test.js` | 56 | Appearance factory behavior with a small DOM boundary; production functions are not copied. | system theme changes only apply while following the system, unknown accents are refused without changing or saving appearance |
| `catalog-caps.test.js` | 139 | catalog-caps.js is a plain browser script of top-level consts and function | a published modality list that omits a token answers no, vision and audio are read from the input modalities, case-insensitively, only a real boolean counts as a published flag, files prefers the published flag and falls back to the modality list, a declared generator answers yes with no modality published, capabilityOrigin names where each answer was read from |
| `decision-probe.test.js` | 126 | The TypeSafe /systemone decision wire protocol — the `noul` probe body and | nara declares the TypeSafe decision hooks at adapter level, nara decisionProbe builds the noul question body, experiential declares the same hooks at adapter level, readDecisionAnswer scores an object answer, named in the row, readDecisionAnswer scores a bare numeric answer, readDecisionAnswer returns null when no probability comes back |
| `key-budget-free.test.js` | 38 | Free-budget checks through the same production pacing used by test attempts. | a key under its cap has a free slot, a key at its cap is not free, slots older than a minute do not count against the cap, no configured cap means no constraint (always free) |
| `key-quota-state.test.js` | 54 | The complete key-policy factory owns these quota predicates. Evaluating it | a per-model refusal is a partial spend, never a spent key, a model-less record spends the whole key, a reset-less record expires after the TTL, a dated record is untouched by the TTL |
| `kiosapi-provider.test.js` | 87 | KiosAPI registers as the eleventh built-in provider. Its roster differs per | registers into window.INTEGRATED_PROVIDERS with the KiosAPI identity, meta is plain data — structuredClone-safe for the provider store, declares a free tier so the Providers legend shows the Free Tier dot, logo file exists at the path the meta declares, no fetchKeyUsage: sentinel billing numbers must not feed a quota bar, the default discovery mappers read a KiosAPI-shaped entry without harm |
| `logs-format.test.js` | 140 | logs-format.js is a plain browser script of top-level function | logEscape: provider text cannot close a tag, toViewModel: escapes every string it puts on the page, formatCost: micros to dollars, small amounts kept visible, formatTokens: thousands separated, null is a dash, statusTone: one tone per outcome, passRateText: a fraction becomes a percentage, null stays unknown |
| `module-loader.js` | 20 | Loads complete browser modules in a controlled VM; no source slicing. |  |
| `page-router.test.js` | 60 | Hash routes belong to the page-router unit; page changes remain app callbacks. | deep links delegate page entry and subpage behavior to the app |
| `profile-badges.test.js` | 51 | Profile badges: the pure classifier behind the fixed model color identity. | badge markup wears the fixed profile tone and nothing else, a missing bridge warms to empty instead of throwing |
| `provider-actions.test.js` | 55 | Provider-key actions use injected persistence and the main request path. | key activation saves changes and locked keys remain unchanged |
| `provider-detail.test.js` | 81 | Provider detail UI: the complete production module receives app behavior through callbacks. | key list escapes provider text and routes key actions through callbacks, empty key list shows the connect hint without binding stale actions |
| `provider-facts.test.js` | 256 | provider-facts.js is a plain browser script of top-level consts and function | a model with nothing published resolves to null, never to zero, the provider context wins and the reference fills only the gap, the score carries its tier, and an unrated model stays unrated, an unpriced model is null, and a published zero is a zero, the ingested row is preferred, and the raw model is the fallback, the five inputs are read from the modality tokens, not the legend ids |
| `provider-keys.test.js` | 48 | Shared key status and provider-row rendering. |  |
| `provider-models.test.js` | 104 | Provider model discovery owns the per-provider roster and catalog handoff. | a quota-based roster (no free rows) still renders every model item |
| `provider-roster.test.js` | 94 | Connected and integrated provider page state and rendering. |  |
| `provider-store.test.js` | 115 | Provider runtime records, hydration and save reconciliation. | failed config read blocks all seed, merge and cleanup writes, save reconciles stored key placeholders without erasing live key state, save invalidates catalog data and refreshes the visible providers page |
| `results-table.test.js` | 146 | Results table sort/filter/export through the production factory. | results module registers a create factory, sort sinks null times and toggles failed-only filter, clear restores empty DOM and notifies status, CSV export uses provider slug and includes status, tokensPerSecond ignores prompt tokens and non-pass rows |
| `retry-after-parse.test.js` | 33 | Exercise the complete pure response module with no provider or window I/O. | delay-seconds form reads as seconds, HTTP-date form reads as seconds until that date, a past HTTP-date waits a moment, not a full window, garbage and absence read as "not stated" (0) |
| `router-status.test.js` | 239 | Venom Profiles page: the complete production module against a fake DOM | typing in search updates the query state for live filtering, measured outcomes compute from routed log rows only, outcome labels sit above their values, dynamic strings are escaped, refresh button re-queries main and re-renders, a refused profiles payload falls back to status counts, never a throw |
| `settings-appearance.test.js` | 331 |  | Appearance: SETTING_INPUTS includes reduceMotion and debugHeader, Appearance: reset appearance restores all appearance keys to defaults, Appearance: SECTION_RESETTERS unifies reset across all settings tabs, Appearance: reset button has red danger styles and accent dock is styled, Appearance: theme preview boxes render detailed UI mockups, Appearance: accent cluster widget and density preview centering |
| `settings-panel.test.js` | 201 | General settings form binding and section navigation. | settings panel module registers create, fillForm converts stored milliseconds to seconds, bindForm ignores an empty per-model budget field, lock idle minutes are clamped to 5..480, gateway port is clamped to 1024..65535, switchSection updates the active nav and page head |
| `shell.test.js` | 84 | App shell page lifecycle and Overview summary. | Overview stats and health lamp summarize live getters |
| `sidebar-effects.test.js` | 41 | Sidebar decoration behavior through the complete production effects script. |  |
| `test-attempts.test.js` | 84 | Real request construction with controlled IPC transport (no network). | missing image route is learned per provider without losing chat fallback, Stop after pacing prevents any IPC request from being sent |
| `test-model-budget.test.js` | 133 | Per-model budgets against the complete production retry/hedge runner. | an empty budget expires and reports the give-up, not an endless ladder, Stop wins over the budget: an aborted run says Aborted, media models have no budget: a video model may take its minutes, a pass always wins, budget or no budget |
| `test-policy.test.js` | 95 | Key eligibility, quota facts and request pacing through the production factory. | pacing reserves a slot and another free key beats one at its minute cap, per-model quota is retained without disabling unrelated models, Stop while pacing does not reserve another request slot |
| `test-response.test.js` | 59 | Production response parsing and classification, evaluated as a whole module. | response parser uses reasoning text only when message content is empty, failure parser retains machine error code, key identity and retry delay, empty and transport results preserve outcome rather than invent content |
| `test-runner.test.js` | 65 | Hedging and retry behavior through the production runner factory. | a race winner cancels all minted request ids as hedge losers, decision transport failures are not duplicated by transient retries, a settings replacement controls the next model retry count |
| `tokenharbor-quota.test.js` | 144 | Token Harbor quota reads share one account-wide 60/min budget across keys, | usage headers are read case-insensitively, missing usage headers read as no reading, only the spent code reads as a spent allowance, a header reading returns the allowance, an over-budget 429 is retried and then read, a model answering without headers is skipped for the next free model |
| `ui-stepper.test.js` | 155 | Mock DOM elements for testing the unit stepper in Node | enhance: ignores unit if no input[type="number"] exists, stepUnit: respects disabled and readOnly inputs |
| `updates.test.js` | 74 | Update UI state machine through a fake IPC boundary; never downloads or installs. | release Markdown keeps wrapped bullets and headings as text items, download failure resets downloading state so badge can retry, Later closes the modal without installing or discarding ready behavior |

### test/router/

| File | Lines | Purpose | Defines |
| --- | --- | --- | --- |
| `profiles.test.js` | 261 | Venom Profiles: tier differentiation, heuristic scoring, lead-analyst | lite admits free rows at VQ >= 20 only, pro and max stay distinct, frontier VQ 56-58 rows reach venom-max and the pro capable rung, fake and non-text rows never enter any tier or the counts, formatModelDisplayName strips routing prefixes, upstream id stays raw, unscored rows read an est-heuristic score but stay below the lite floor, buildProfilesPayload carries per-profile target lists with key counts |
| `router.test.js` | 249 | Router plane: smart catalog split, three-level key isolation, cascade | gateway port falls back to the default outside 1024..65535, identity keeps the raw upstream address apart from the match key, capability read never invents a measured score, smart catalog preserves upstream ids and splits three tiers, key pool isolates a model-on-key failure from the rest of the key, key pool drains subscription before free before paid |

## Incoming references (imported by)

Static relative imports only (`require`, `import … from`, `import()`). Builtins and external packages are ignored. A file with no row below has no static relative importer in this tree.

| File | Imported by |
| --- | --- |
| `scripts/check-import-counts.js` | `test/check-import-counts.test.js` |
| `scripts/live/cdp.mjs` | `scripts/live/fixture.mjs`, `scripts/live/verify-catalog-boot.mjs`, `scripts/live/verify-catalog-legend.mjs`, `scripts/live/verify-catalog-sidebar.mjs`, `scripts/live/verify-db.mjs`, `scripts/live/verify-lock.mjs`, `scripts/live/verify-provider-table.mjs`, `scripts/live/verify-renderer-modules.mjs` |
| `scripts/live/fixture.mjs` | `scripts/live/verify-catalog-legend.mjs`, `scripts/live/verify-catalog-sidebar.mjs`, `scripts/live/verify-db.mjs`, `scripts/live/verify-provider-table.mjs`, `scripts/live/verify-renderer-modules.mjs` |
| `scripts/live/mock-provider.mjs` | `scripts/live/verify-catalog-legend.mjs`, `scripts/live/verify-catalog-sidebar.mjs`, `scripts/live/verify-db.mjs`, `scripts/live/verify-provider-table.mjs`, `scripts/live/verify-renderer-modules.mjs` |
| `src/api-request.js` | `src/main.js`, `test/api-request.test.js`, `test/main-wiring.test.js` |
| `src/auth/hash.js` | `src/auth/index.js`, `test/auth/hash.test.js`, `test/auth/ipc.test.js`, `test/auth/lock.test.js`, `test/db/auth-repo.test.js` |
| `src/auth/index.js` | `src/main.js`, `test/auth/ipc.test.js`, `test/auth/lock.test.js` |
| `src/auth/ipc.js` | `src/main.js`, `test/auth/ipc.test.js` |
| `src/catalog/atomic.js` | `src/catalog/sources.js`, `test/catalog/atomic.test.js` |
| `src/catalog/build.js` | `src/catalog/engine.js`, `src/catalog/sources.js`, `test/catalog/build.test.js`, `test/catalog/non-text.test.js` |
| `src/catalog/engine.js` | `src/main.js`, `test/catalog/engine.test.js`, `test/catalog/ipc.test.js` |
| `src/catalog/fetch.js` | `src/main.js`, `test/catalog/engine.test.js`, `test/catalog/fetch.test.js`, `test/catalog/sources.test.js` |
| `src/catalog/ipc.js` | `src/main.js`, `test/catalog/ipc.test.js` |
| `src/catalog/keys.js` | `src/catalog/build.js`, `src/catalog/row.js`, `src/catalog/scoring.js`, `test/catalog/keys.test.js` |
| `src/catalog/row.js` | `src/catalog/ipc.js`, `test/catalog/ipc.test.js`, `test/catalog/row.test.js` |
| `src/catalog/scoring.js` | `src/catalog/build.js`, `src/catalog/engine.js`, `test/catalog/non-text.test.js`, `test/catalog/scoring.test.js` |
| `src/catalog/snapshot.js` | `src/catalog/ipc.js`, `test/catalog/non-text.test.js`, `test/catalog/snapshot.test.js` |
| `src/catalog/sources.js` | `src/main.js`, `test/catalog/engine.test.js`, `test/catalog/sources.test.js` |
| `src/catalog/util.js` | `src/catalog/build.js`, `src/catalog/row.js`, `src/catalog/scoring.js`, `test/catalog/scoring.test.js`, `test/catalog/util.test.js` |
| `src/db/cipher.js` | `src/db/import-json.js`, `src/db/repos/providers.js`, `src/db/repos/secrets.js`, `src/keystore.js`, `src/main.js`, `test/db/cipher.test.js`, `test/helpers.js` |
| `src/db/explorer.js` | `src/db/ipc.js` |
| `src/db/import-json.js` | `src/main.js`, `test/check-import-counts.test.js`, `test/db/import-json.test.js` |
| `src/db/index.js` | `src/main.js`, `test/check-import-counts.test.js`, `test/db/open.test.js`, `test/helpers.js` |
| `src/db/ipc.js` | `src/main.js`, `test/db/explorer.test.js`, `test/db/ipc.test.js` |
| `src/db/keys.js` | `src/main.js`, `test/db/keys.test.js` |
| `src/db/migrations.js` | `src/db/index.js`, `test/db/auth-repo.test.js` |
| `src/db/repos/auth.js` | `src/db/index.js`, `test/db/auth-repo.test.js` |
| `src/db/repos/history.js` | `src/db/index.js`, `test/db/history.test.js` |
| `src/db/repos/providers.js` | `src/db/import-json.js`, `src/db/index.js`, `test/db/providers.test.js` |
| `src/db/repos/roster-events.js` | `src/db/index.js`, `test/db/roster-events.test.js` |
| `src/db/repos/secrets.js` | `src/db/index.js`, `src/db/keys.js`, `test/db/settings-secrets.test.js` |
| `src/db/repos/settings.js` | `src/db/index.js` |
| `src/db/repos/snapshots.js` | `src/db/index.js` |
| `src/db/ulid.js` | `src/db/repos/history.js`, `src/logs/recorder.js`, `test/db/history.test.js`, `test/renderer-ulid.test.js` |
| `src/flush.js` | `src/main.js`, `test/flush.test.js` |
| `src/keystore.js` | `scripts/keystore-check.js` |
| `src/logs/classify.js` | `src/logs/query.js`, `src/logs/recorder.js`, `src/logs/writer.js`, `test/logs/classify.test.js` |
| `src/logs/index.js` | `src/main.js`, `test/helpers.js`, `test/logs/open.test.js` |
| `src/logs/ipc.js` | `src/main.js`, `test/logs/ipc.test.js` |
| `src/logs/lookups.js` | `src/main.js`, `test/logs/lookups.test.js` |
| `src/logs/migrations.js` | `src/logs/index.js`, `test/helpers.js`, `test/logs/retention.test.js` |
| `src/logs/query.js` | `src/logs/index.js`, `src/logs/ipc.js`, `test/logs/query.test.js` |
| `src/logs/recorder.js` | `src/main.js`, `test/logs/recorder.test.js` |
| `src/logs/retention.js` | `src/logs/query.js`, `src/main.js`, `test/logs/retention.test.js` |
| `src/logs/scrub.js` | `src/logs/recorder.js`, `test/logs/scrub.test.js` |
| `src/logs/settings.js` | `src/main.js`, `test/logs/schema.test.js` |
| `src/logs/writer.js` | `src/logs/index.js`, `src/logs/query.js`, `test/logs/query.test.js`, `test/logs/retention.test.js`, `test/logs/writer.test.js` |
| `src/renderer/ui-stepper.js` | `test/renderer/ui-stepper.test.js` |
| `src/router/index.js` | `src/main.js`, `test/router/profiles.test.js`, `test/router/router.test.js` |
| `src/user-data.js` | `src/main.js`, `test/user-data.test.js` |
| `test/helpers.js` | `test/api-request.test.js`, `test/auth/ipc.test.js`, `test/auth/lock.test.js`, `test/catalog/engine.test.js`, `test/catalog/ipc.test.js`, `test/catalog/snapshot.test.js`, `test/catalog/sources.test.js`, `test/check-import-counts.test.js`, `test/db/auth-repo.test.js`, `test/db/cipher.test.js`, `test/db/explorer.test.js`, `test/db/history.test.js`, `test/db/import-json.test.js`, `test/db/ipc.test.js`, `test/db/keys.test.js`, `test/db/open.test.js`, `test/db/providers.test.js`, `test/db/roster-events.test.js`, `test/db/settings-secrets.test.js`, `test/db/snapshots.test.js`, `test/logs/ipc.test.js`, `test/logs/lookups.test.js`, `test/logs/open.test.js`, `test/logs/query.test.js`, `test/logs/retention.test.js`, `test/logs/schema.test.js`, `test/logs/writer.test.js`, `test/renderer-ulid.test.js`, `test/repo-map.test.js` |
| `test/renderer/appearance-dom.js` | `test/renderer/appearance.test.js`, `test/renderer/settings-appearance.test.js` |
| `test/renderer/module-loader.js` | `test/renderer/appearance-dom.js`, `test/renderer/decision-probe.test.js`, `test/renderer/key-budget-free.test.js`, `test/renderer/key-quota-state.test.js`, `test/renderer/page-router.test.js`, `test/renderer/profile-badges.test.js`, `test/renderer/provider-actions.test.js`, `test/renderer/provider-detail.test.js`, `test/renderer/provider-keys.test.js`, `test/renderer/provider-models.test.js`, `test/renderer/provider-roster.test.js`, `test/renderer/provider-store.test.js`, `test/renderer/results-table.test.js`, `test/renderer/retry-after-parse.test.js`, `test/renderer/router-status.test.js`, `test/renderer/settings-panel.test.js`, `test/renderer/shell.test.js`, `test/renderer/sidebar-effects.test.js`, `test/renderer/test-attempts.test.js`, `test/renderer/test-model-budget.test.js`, `test/renderer/test-policy.test.js`, `test/renderer/test-response.test.js`, `test/renderer/test-runner.test.js`, `test/renderer/updates.test.js` |

Every relative import in this tree resolved to a file in this map.
