# Changelog

All notable changes to Upstream Checker will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
