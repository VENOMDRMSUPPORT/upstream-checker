# Changelog

All notable changes to Upstream Checker will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
