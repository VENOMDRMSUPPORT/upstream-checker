# Changelog

All notable changes to VENOM Router (formerly Upstream Checker) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Upstream Checker is now **VENOM Router**, an LLM model router. The app has a
  new name, a new logo (the Viper V) and router vocabulary throughout: Model
  catalog is now Model Pool, Upstream Check is Route Test, and Venom Profiles
  are Routing Profiles. No page, feature or setting was removed.
- App data moves from `%APPDATA%\upstream-checker` to `%APPDATA%\venom-router`
  on first launch, keys and history included. If an older version is still
  running, the old folder is kept in use and the move is tried again next time.
- Installers are named `VENOM-Router-Setup-<version>.exe` and
  `VENOM Router - Portable.exe`. Existing installs keep updating in place.

## [1.4.1] - 2026-09-26

### Added
- Key usage, starting with Mirai API. Each key row on the Connected tab now
  shows the quota left (a bar, the percentage and the amount) and when the key
  expires (amber within three days, red within one or once expired). Clicking
  either opens a drawer from the right with the full quota breakdown, the
  expiry date, the last 24 hours (requests, success and error rate) and the
  key's request history, 20 requests a page. Usage refreshes on Connect, on
  opening a provider's keys (when older than five minutes), on Test, on
  Recheck and from the drawer's refresh button — never in the background.
- Provider modules can report usage through two optional functions,
  `fetchKeyUsage` and `fetchKeyHistory`, returning a shared shape that the new
  `key-usage.js` renders; the app itself stays provider-agnostic. Mirai's
  usage session cookie is kept in memory only and never written to disk.
- Spent quotas. A key refused a model because its allowance is used up is
  now recognised from the provider's own error. The refusal is remembered per
  model on that key — one key can draw on more than one allowance (Token
  Harbor's campaign models carry their own) — so later runs skip only the
  models that were refused, with no request, and every other model is still
  tried. The key row reads "Quota used" in amber with the refusal's status, a
  "Resets in …" cell counts down to the reset time the provider named (date
  under it), and its tooltip lists the affected models. It is kept across
  restarts and lifts by itself at the reset, or as soon as the key serves one
  of those models again.
- Token Harbor key usage. Each key row shows how much of its free allowance is
  used (a bar and the percentage) and when it renews ("Resets in 6d 22h", date
  under it), always, not only once it runs out; the drawer shows the same with
  the plan. Token Harbor sends the allowance on every chat answer
  (`x-th-free-used-pct`, `x-th-free-resets`, `x-th-plan`), so a test run keeps
  the reading current for free; opening the keys, Test and Refresh read it with
  a one-token request to one of the key's own free models. A spent key's 429
  carries no such headers, so its reading comes from the refusal (100% used,
  renewing at the time the message names). A reading under 100% lifts a stale
  "Quota used". The free-tier refusal (`free_tier_limit_reached`) is
  recognised; modules can declare `readQuotaError` and `readUsageHeaders`, and
  the standard `insufficient_quota` / `quota_exceeded` codes are recognised
  for every provider.

- Rate limit details. The Rate limit badge on every provider card has an info
  button that opens a panel with how runs are paced for that provider, the
  limits it publishes (from the module's `meta.rateLimits`, with a link to the
  source when there is one — Token Harbor, NARA and Inception today), and what
  a run does when the provider answers 429. Integrated cards lost the "View in
  Connected" link; the line under the Connect button is centred on it.
- Token Harbor paces runs at its documented free-account limit, 60 requests a
  minute (docs/api/rate-limits: 60/min and 1,800/hour per account across all
  keys, 100/min per IP; paid accounts have none), so its Rate limit badge now
  lights. A going-over 429 still waits out the provider's Retry-After.

### Changed
- Updates: once an update finishes downloading, the update dialog opens in a
  "Update Ready" state that explains what happens next, with **Restart now**
  and **Later** (installs on the next close). The titlebar badge turns into a
  green restart arrow instead of a closed ring that looked like a spinner, and
  clicking it reopens that dialog.
- Updates install silently and reopen the app on their own. The installer
  wizard no longer appears, so there is no frozen window while it checks the
  app has closed and no Finish button to press.
- Providers, Integrated tab: cards show only who the provider is (logo, name,
  base URL, capability tags) and a Connect button. Keys, models, pass rate,
  health and the key strip now live only on the Connected tab. A connected
  provider's button reads "Already connected" in a grey, dashed, clearly
  disabled style, with a "View in Connected" link under it.
- Integrated tab layout: providers are grouped by auth kind (OAuth, API Key)
  under the same dividers as the Connected tab, in a denser grid of smaller
  cards that fits four at a typical window and adapts from one column to six.
- Provider capability badges are now the same four on every card, in a fixed
  2x2 grid of square-cornered cells — OpenAI API, Filtered, Plans, Rate limit —
  lit when the provider has the capability and dimmed when it doesn't. Each
  has a tooltip explaining what it means (the rate limit's shows the number).
- Connect checks the key with the provider before saving it. A working key
  saves and moves you to the Connected tab with that provider's keys open; a
  refused key (401/403) is not saved and the dialog says so; if the provider
  cannot be reached, the dialog offers "Save anyway".
- Provider modules can declare `meta.keyCheck` (endpoint, method, body) when
  their models endpoint answers without a key. Inception Labs uses a one-token
  chat request, so Connect and a key's Test button now catch a bad key there.

### Fixed
- The update badge now turns green when an update is ready; the update
  dialog's icon rule was overriding its color with the accent.
- A provider whose stored rate limit was empty (`null`, saved before its
  module declared one) now uses the module's documented limit instead of
  running unpaced.

[1.4.1]: https://github.com/VENOMDRMSUPPORT/upstream-checker/releases/tag/v1.4.1

## [1.4.0] - 2026-09-26

### Changed
- Providers: the table is gone. Connected providers are a list of row cards
  with a gap between them, on one column grid shared by every provider row
  and every key row, so values line up down the list; there is no column
  header, and no key button: the row itself opens its keys. An open
  provider's card carries the accent bar, its keys sit in a recessed well
  inside the card, and the tree line still grows from the logo into each key.
  Narrow windows drop the same columns from every row.
- Toolbar layout: search and sort on the left, the status filters and page
  actions on the right, on every page that has one.
- Providers are filtered and grouped by how they authenticate: the toolbar's
  filters are All, OAuth and API Key (dotted in the legend's colours, in place
  of Reachable and Issues), and the list — rows or cards — shows each kind
  under its own divider, OAuth first. A kind with no provider shows no group;
  a provider offering both is filed under its first kind and found by either
  filter.
- Status badges (providers and keys) are rectangles with a light radius and
  one width for all, so they stack as a column. The colour dot carries the
  verdict, so a healthy badge shows only its latency ("● | 476 ms"); a failure
  shows its code without "HTTP" ("● | 401"). Under every key's badge, healthy
  ones included, a two-word line says it in words ("Key working", "Key
  rejected", "Host unreachable"…), centred on the badge (a provider's badge
  stands alone: the words are for telling its keys apart); every
  message the probes can produce has its own, and anything unexpected falls
  back to its state's ("Check failed"). The value follows the dot
  with no gap, in a slot sized for the longest reading ("—" when there is
  none), so every badge keeps one width. The full sentence is in the tooltip.
- A key's masked value and its copy button are one framed component, the
  button a segment of its own behind a hairline. The status column is now as
  wide as a badge, and the room it gave up went to the name column, so a
  key's name and value sit clear of its status and are never cut short.
- Key rows drop the Active / Off / Failing badge: the index chip's colour
  already says it. A key switched off carries a lock by its name ("Disabled by
  the admin"), and one that can't be decrypted here a warning mark.
- Crossing the window width where the list turns into cards resets the
  Providers page: Connected tab, All, no search, legend folded, every
  provider closed.
- A group's provider count is a framed rectangle, like the other badges, and
  the group's heading (dot, kind, count) is framed as one tag on the page's
  neutral surface, with only the dot in the kind's colour.
- In a key row the two-word line sits above the badge, level with the key's
  name, and the badge level with its masked value, at the same height.
- The live-updates switch moved from every breadcrumb to an orb in the seam
  between the Providers page's Connected and Integrated tabs: a pulse while
  live, a pause mark when paused, in the theme's own neutrals.
- Breadcrumbs start at Overview (not "Home") with the sidebar's own Overview
  icon, and every crumb that stands for a page (Providers, Model Catalog,
  Profiles, Settings) carries that page's sidebar icon.
- Sidebar: the system-status lamp beats like a radar (two rings sweeping out
  in turn, faster when something is wrong); the footer's heart answers a
  click with a big beat and a burst of small hearts and sparks; and a second
  layer of faint stars twinkles and rises over the painted starfield, with a
  shooting star now and then. All of it stays under the content and stops
  under reduced motion.
- A key's last check sits under its buttons, in a frame as wide as the
  buttons, instead of in the Last run column.
- An open provider stands apart from its neighbours with more space above
  and below it.
- The provider-types legend opens and closes from anywhere on its header,
  not only its button, and its header is slimmer.
- One toolbar card for every page that has one (Providers, Model Catalog,
  Profiles): same frame, surface, padding and spacing in both themes.
- Form fields are one design-system component across the app. Focus is the
  theme's own neutral (one border shade up and a soft ring) instead of an
  accent-coloured frame, from a single rule for every field. The search box
  keeps its icon in a segment of its own, set apart by a hairline and a
  slightly different surface.
- Every dropdown is the app's own menu (`ui-select.js`) instead of the
  native list, whose Windows-blue highlight ignored the theme: the app's
  surface, a neutral highlight, a tick on the chosen option, keyboard
  navigation, sized to its field. The native `<select>` stays underneath as
  the source of truth, so every existing control works unchanged, and
  dropdowns added later are converted automatically.
- No more list/cards switch in the toolbar: Providers and the Model Catalog
  show the list at full width and cards once the window is narrow enough for
  the sidebar to fold away (1100px), switching as the window is resized.

### Removed
- Custom providers. The app runs its integrated (built-in) providers only:
  they can be connected, disconnected, renamed or re-pointed, never added or
  deleted. The Add provider button and the Remove action are gone, and a
  keyless custom provider left in an older config is removed from it; one
  that still holds keys is left in the file, not loaded, so no key is lost.

[1.4.0]: https://github.com/VENOMDRMSUPPORT/upstream-checker/releases/tag/v1.4.0

## [1.3.1] - 2026-09-26

### Fixed
- The update dialog showed its notes as raw HTML (`<h3>`, `<li>`…) in a
  second framed, scrolling box inside the notes panel. electron-updater reads
  the notes from GitHub's releases feed, which carries them as rendered HTML,
  and the dialog only understood Markdown. The app now fetches the release's
  Markdown body from the GitHub API first (feed HTML as the fallback) and the
  dialog reads both shapes, still building every line as text nodes. Wrapped
  entries are no longer cut to their first line, bold and code show as such,
  and the notes panel is taller.

[1.3.1]: https://github.com/VENOMDRMSUPPORT/upstream-checker/releases/tag/v1.3.1

## [1.3.0] - 2026-09-25

### Added
- **Model Catalog** page. Every model each connected provider lists, kept
  live: the catalogue re-reads `/models` on every key every 5 minutes (setting),
  on focus, and whenever a key is added or removed. A model the provider adds
  is flagged NEW and, with the option on, benchmarked automatically (the first
  sync of a provider is a baseline and runs nothing); a model the provider
  drops disappears at once; a disconnected provider takes its models with it.
  Stored in `catalog.json` next to the config and history.
- **Quick benchmark** (`benchmark.js`): 21 short, machine-graded tasks in three
  categories — reasoning & math, coding, instruction following — in easy, hard
  and expert tiers worth 1, 2 and 3 points, plus a streamed latency probe and
  a streamed throughput probe. 23 requests, three at a time, under a minute per
  model. Produces a composite score (70% intelligence, 20% speed, 10%
  reliability), an S/A/B/C/D tier, a rank among benchmarked models, median
  latency, time to first *content* token and tokens per second measured on
  generation alone, with every reply kept for inspection. A provider error,
  timeout or empty stream is retried twice and then excluded from intelligence
  and charged to reliability — it says nothing about what the model knows.
  Too many failures mark the run incomplete instead of scoring it low.
- **Global reference.** Each model is matched to the Artificial Analysis
  leaderboard (bundled snapshot, or the live API when a free key is set in
  Settings) and shown next to its Intelligence Index, global rank, TTFT and
  speed, with a verdict on whether our tier agrees. Once three or more
  benchmarked models are on the global board, a Spearman rank correlation
  ("Validity vs global") says whether this benchmark ranks models the way the
  world does.
- **Venom Profiles** page (`profiles.js`): three virtual models — `venom-lite`,
  `venom-pro`, `venom-max` — filled automatically from the catalogue. Each
  profile has an editable policy (intelligence floor, first-token and
  throughput limits, reliability floor, context, price cap, required
  capabilities) and weights that rank the sources that pass it. Traffic is
  spread over the top N by score with a cap per provider; the same model on
  several providers is one family with several sources and shares its
  measured intelligence; a source with too little evidence is a candidate,
  three failures in a row put it in cooldown; every exclusion carries its
  reason. Export as `profiles.json` for the router, or copy.
- Catalogue data for routing: price per 1M tokens (where the provider
  publishes it), capability probes (tool calling, strict JSON mode, a
  5.5k-token needle-in-haystack with its latency) run once per model after
  the benchmark and cached two weeks, an Arabic category in the benchmark,
  per-model reliability from every recorded verdict, run-to-run stability,
  and a "Router readiness" panel on each model.
- Settings › Model Catalog: sync cadence, auto-benchmark toggle, Artificial
  Analysis API key, leaderboard refresh, clear results, reset catalogue.
- `api-request` now reports `firstByteMs` and `firstTokenMs` — the time to the
  first byte, and the time to the first chunk carrying model text, which is the
  time to first token on a streamed completion even behind a proxy that flushes
  headers or an empty role delta early.
- Routes in the URL hash (`#/providers`, `#/check/<provider>`,
  `#/settings/<section>`), so a reload stays on the current page.
- **Live** switch in every breadcrumb: pauses or resumes background provider
  health checks. Settings › Schedule sets their cadence (1–30 minutes).
- Model Catalog and Profiles show each provider's health beside its name and
  update the moment a provider goes up or down.

### Changed
- The background health check probes every active key, in parallel, and
  records each key's own result, so key rows no longer sit at "Not tested"
  and a failing key is visible even when another key of the provider works.
- Provider logos follow the theme. A module's `meta.logoTone` (`mono` for a
  light single-colour mark, `bright` for light brand colours) re-inks the logo
  on the light theme, where logo tiles are now white instead of a dark box.
  This replaces the per-provider watermark CSS and the dark chip behind
  sidebar logos.
- Recheck (provider) and Test (key) answer the click: a spinner while the
  probe runs (held at least 650 ms so an instant answer still reads), then the
  verdict's icon in its colour for 2.6 s. Background checks stay silent.
- Providers table: an open provider's keys are real table rows on the
  provider's own columns (the key's check under Status, its state under Keys,
  its model count under Models, when it was checked under Last run, its
  buttons under Actions). One accent bar runs down the provider row and
  through its keys, the keys sit in a recessed well, and a tree line grows
  from under the provider's logo and branches into each key. Cards keep the
  stacked key panel.
- Each key row shows how many models that key sees and when it was last
  checked ("14 models · Checked 2m ago"). The count comes from the catalogue
  sync, which discovers every key on its own through the provider's discovery
  and filters, and is kept in `catalog.json` as `keyModels`. A key that sees
  fewer models than its provider's keys together reads "18 of 21 models".
- Settings speaks one design language on every tab: each setting is a row
  with an icon, a title and a plain description, its control on the right
  (or full width under the text for prompts and keys); numbers carry their
  unit inside the field ("300 | runs"); a tab opens with a short note and
  keeps anything destructive in a separate zone at its foot. Both cards'
  headers carry an icon and a description under the title, the settings card
  taking the active tab's icon.
- Sidebar: Overview, Providers and Model catalog lead the General group, with
  new icons.
- Settings scrolls as one page instead of inside its card. The breadcrumb
  scrolls away and the categories card sticks to the top, so every tab stays
  one click away; a tab picked while scrolled down opens at its own top.
- Bundled provider logo SVGs are cropped to their artwork, so every mark fills
  its tile evenly and reads larger.
- Providers page: rounded-square logo tiles (the redundant "connected" tick is
  gone) with the provider-type dots on a rail under the logo, a status pill
  that separates the verdict from its measurement ("Reachable | 351 ms",
  "Key rejected | HTTP 401"), and key rows numbered `#1`, `#2`… with the
  index chip carrying the key's state.

### Fixed
- On most launches the Model Catalog and Profiles never started: no sync
  timer, no auto-benchmark, no page bindings. `catalog.js` and `profiles.js`
  load after `app.js`, and startup could reach the point where it hands them
  the providers before the page had run them. Startup now waits for
  `DOMContentLoaded`, and a startup failure is logged instead of vanishing.

[1.3.0]: https://github.com/VENOMDRMSUPPORT/upstream-checker/releases/tag/v1.3.0

## [1.2.1] - 2026-09-22

### Fixed
- The update dialog showed an empty "What's New" panel. A GitHub release is
  created by the asset upload and only gets its notes afterwards, so an app that
  checked during that gap received an empty body and cached it. The release
  script now publishes the release with its notes before any asset exists, which
  removes the gap, and the dialog no longer renders a blank panel either — it
  says whether nothing arrived or something arrived in a shape it could not
  parse, and shows unparsed notes verbatim rather than swallowing them.

[1.2.1]: https://github.com/VENOMDRMSUPPORT/upstream-checker/releases/tag/v1.2.1

## [1.2.0] - 2026-09-22

Three more providers, a settings page, encrypted keys, and a record that turns
"does this model work right now" into "is this model reliable".

### Added
- **Run history and uptime.** Every run is recorded, and each model carries the
  share of runs it passed plus a bar per recent run, so a model that has always
  worked and one that broke today no longer read the same. Kept per provider —
  the same model can be solid on one router and flaky on another.
- **Regression reporting.** A run is compared against what history already knew
  and the summary says what moved: "2 newly failing, 1 recovered".
- **Scheduled re-testing** on a timer, off by default, with an OS notification
  when a model that was working stops.
- **Settings page**, reached from the title bar: test prompt, schedule, latency
  bands, timeouts per model kind, retry policy, hedging, history depth,
  appearance, diagnostics, and an about page. Standing above it is a running
  estimate of what the current configuration costs per run, because hedging,
  retries and the schedule multiply together and the product is invisible while
  you turn any one of them.
- **Answer checking.** The prompt is now visible and editable with an expected
  answer beside it, and a new column says whether the response actually contained
  it. Passing used to mean only that HTTP 200 came back, so a model answering
  "Five" counted as a success.
- **Three providers**: Nexum Router, Mirai API, Inception Labs — five in total.
- **Appearance**: six themes, six accents, three row densities.
- **Diagnostics**: optional request logging at two levels, with the
  Authorization header stripped before anything reaches disk.
- **TPS column** — completion tokens per second, excluding prompt tokens, which
  aren't generated and would inflate the rate.
- Sortable columns, a failures-only filter, full responses in a modal, and a
  sidebar you can narrow or hide by dragging its edge.
- Stop a run in progress; retry a single failed model or all of them at once.
- Filter, select-all and select-none over the model list.

### Security
- **API keys are encrypted at rest** with the OS keystore, so config.json is no
  longer useful to anything reading it off disk. A config that will not decrypt
  keeps its ciphertext rather than being read as empty, and says so instead of
  failing later with a confusing 401.
- The reveal button is gone: keys are only ever shown masked, and Copy is the one
  way the full value leaves the app.
- `script-src` no longer allows `'unsafe-inline'`, fonts are bundled instead of
  fetched from Google on every launch, `connect-src` is denied outright, and an
  unvalidated `shell.openExternal` bridge that nothing called was removed.

### Fixed
- **Responses were mangled.** Bodies were decoded one network chunk at a time, so
  any UTF-8 character split across a boundary came out wrong — a model answering
  "bốn" rendered as "Bón".
- **Rate limits were recorded as model failures.** A per-minute cap is a property
  of how fast we were going, not of the model. A capped run now waits out the
  window or moves to another key, and the wait is charged to no model's time.
  The real limit is learned from being refused rather than trusted from a
  published figure.
- **Keys were not entitled to every model.** An unfunded account asked for a paid
  tier model would fail, and the model was blamed. Entitlement is now learned
  from the provider's refusal and the request retried on a key that has it.
- **Only the first key was ever used.** Keys now rotate per request with a
  per-key minute budget and cooldown, and each model is sent a key that actually
  serves it — providers can hand out different catalogues per key.
- **Stop did not exist.** The machinery was there but never triggered, so a
  started run could only be escaped by closing the app.
- **Image and video generators were tested as chat models** — asking a generator
  what 2+2 is spends a real generation, takes a minute, and scores the picture it
  returns as a wrong answer. They are tagged, prompted and judged separately, and
  start unselected.
- Failed requests showed "Error invoking remote method" and 0.0s, because the
  real message and the elapsed time were lost crossing the IPC boundary.
- A fixed 60s socket timeout killed video generation regardless of the deadline
  set for it.
- Avg Time averaged failures in, so a provider returning quick 502s looked faster
  than it was.
- Total counted every model fetched rather than the models in the run.
- Failed rows showed "0" tokens, which reads as a measured zero.
- A `display:flex` on a table cell dropped the TYPE column out of the table
  layout, leaving its border as a floating line.
- Latency turned amber above 5s, which painted most of a healthy run amber and
  left the colour saying nothing. Green now runs to 10s.
- Queued rows claimed to be "Testing", so a fifteen-model run looked like fifteen
  models in flight when it does one at a time.
- Release-note headings never rendered: the parser returned early on any line
  starting with '#', leaving both heading branches below it unreachable.
- Border weight is now solved to a shared contrast target per theme, rather than
  ranging from 1.12 to 1.23 by eye.

### Changed
- Models are tested in a configurable number of parallel lanes, default 1.
  Widening the hedge instead would raise rate-limit pressure rather than lower
  it — hedging rescues a model stuck behind a queue, it does not lower that
  model's own latency.
- Config is written atomically, so a crash mid-write cannot truncate the file the
  encrypted keys now live in.
- Exports carry the provider name and a timestamp.
- The window reopens where it was left.

[1.2.0]: https://github.com/VENOMDRMSUPPORT/upstream-checker/releases/tag/v1.2.0

## [1.1.1] - 2026-09-22

### Added
- Dark API as a second integrated provider, with its models fetched dynamically.
- Provider logos shown next to each provider's name.

### Fixed
- NARA model discovery now uses the pricing endpoint's per-model `free_for_paid`
  flag (and the price-0 plan for the free tier), so every free and free-for-paid
  model appears — including ones the plans list omitted (e.g. mimo-v2.6-flash-free).

### Changed
- The app is fully provider-agnostic: provider-specific logic lives only in each
  provider's module, and a provider added from the UI is migrated automatically
  when it later ships as a built-in (its key is preserved).

[1.1.1]: https://github.com/VENOMDRMSUPPORT/upstream-checker/releases/tag/v1.1.1

## [1.1.0] - 2026-09-22

### Added
- Multiple providers: NARA is now a self-contained integrated-provider module,
  and OpenAI-compatible providers can be added, edited, and removed from the UI.
- Config file is created on first launch and is the source of truth for each
  provider's name and base URL (editable in-app; a small "+" adds a provider).

### Changed
- Model testing is now reliable and fast:
  - Adaptive hedging — each model starts with one request and only fans out
    parallel attempts while it is slow; the fastest correct answer wins and the
    rest are cancelled. Fast models cost one request; slow/variable ones speed up.
  - Streaming recovery for models that return content only over SSE.
  - Transient failures (429/5xx/network) retried with Retry-After backoff, with a
    per-model deadline so a stuck model can't block the run.
  - `reasoning_effort: low` sent on every request to keep reasoning-heavy models
    fast on the trivial test prompt.
  - Results run in order and appear top-to-bottom.
- Genuinely empty responses are reported honestly instead of as false passes.
- Removed the always-visible Base URL field from the sidebar (edited per provider).

[1.1.0]: https://github.com/VENOMDRMSUPPORT/upstream-checker/releases/tag/v1.1.0

## [1.0.1] - 2025-09-21

### Added
- Titlebar update notification badge (animated gradient)
- Click to download/install updates directly from titlebar
- Download progress indicator on badge
- Badge turns green when ready to install

[1.0.1]: https://github.com/VENOMDRMSUPPORT/upstream-checker/releases/tag/v1.0.1

## [1.0.0] - 2025-09-21

### Added
- Initial release of Upstream Checker
- Test AI models from NARA Router provider
- Support for free and freemium model tiers
- Real-time model testing with detailed metrics
- Display test results with pass/fail status, response time, and tokens used
- Export test results to CSV and JSON formats
- Multi-API key management with toggle activation
- Auto-update infrastructure for seamless future updates
- Beautiful enterprise dark theme UI
- Custom window controls (minimize, maximize, close)
- Model filtering: free tier and free-for-paid models
- Support for reasoning models with special handling
- Responsive results table with status indicators
- Progress tracking during batch testing

### Technical
- Built with Electron 33.0.0
- Vanilla JavaScript (no framework dependencies)
- electron-updater integration for auto-updates
- GitHub Releases as update server
- NSIS installer and portable builds for Windows x64

[1.0.0]: https://github.com/VENOMDRMSUPPORT/upstream-checker/releases/tag/v1.0.0
