# VENOM Router rebrand — design

Date: 2026-09-26
Status: approved in chat (naming, data folder, updates, logo)

## Goal

Rebrand the app from "Upstream Checker" (a tester/catalogue) to **VENOM Router**,
an LLM model router. No page, feature or setting is removed; only the name, the
concept expressed in user-facing copy, and the logo change.

## Decisions (made with the owner)

| Topic | Decision |
|---|---|
| Name | `VENOM Router` everywhere the user sees a name |
| Page naming | Router vocabulary (table below) |
| Data folder | Move `%APPDATA%\upstream-checker` → `%APPDATA%\venom-router` on first launch |
| Updates | Keep the GitHub repo `upstream-checker` and `appId` `com.upstream.checker` |
| Logo | "Viper V" — a V whose counter is a viper head with a forked tongue |

## 1. Naming and copy

### Map

| Where | Old | New |
|---|---|---|
| Window title / `<title>` | Upstream Checker | VENOM Router |
| Titlebar text | UPSTREAM CHECKER | VENOM ROUTER |
| Sidebar brand | UPSTREAM / CHECKER | VENOM / ROUTER |
| Nav + page title + breadcrumb | Model catalog / Model Catalog | Model Pool |
| Nav group | Testing | Routing |
| Nav + page title | Upstream Check | Route Test |
| Nav + page title + breadcrumb | Venom Profiles / Profiles | Routing Profiles |
| Settings section | Model Catalog | Model Pool |
| Settings section | About Upstream | About VENOM Router |
| About heading | Upstream Checker | VENOM Router |
| Quick stats / Overview KPI | Last Check / Last check | Last test |
| Buttons, tooltips | Open (in) Upstream Check | Open (in) Route Test |
| Prose | "the catalogue" | "the model pool" |
| Settings actions | Clear catalogue data / Reset catalogue | Clear model pool data / Reset model pool |
| Profiles export `generator` | Upstream Checker | VENOM Router |
| Export filename prefix | `upstream-…` | `venom-router-…` |
| Update-notes HTTP `User-Agent` | Upstream-Checker | VENOM-Router |

### Descriptions rewritten from the router's point of view

- Overview: "Routing health — providers, models and test activity at a glance."
- Model Pool: "Every model your connected providers offer — the pool the router draws from, kept live, benchmarked and ranked against the global leaderboard."
- Routing Profiles: "Three virtual models — Lite, Pro, Max — that route each request to the best real model in the pool by measured intelligence, speed, reliability and cost."
- Route Test: "Test every route a provider offers against one prompt."
- About note: "Routes every request to the best model across your providers, chosen from measurements taken on your own keys — not from marketing claims."
- `package.json` description: "LLM model router — one endpoint across every provider and key".

"Test", "benchmark" and "health check" stay where they describe those actions;
the router still tests its routes. Only the *checker/catalogue* identity goes.

### Not renamed (internal, invisible, or data-bearing)

Code identifiers (`CATALOG`, `catalog.js`, `sec-catalog`, page id `check`,
`#/check/...` routes), IPC channel names, CSS class names, and stored files
(`config.json`, `catalog.json`, `history.json`) keep their names. Renaming them
buys nothing the user can see and risks stored data and saved routes.
Top-of-file banner comments that name the product (`UPSTREAM CHECKER — …`) are
updated, since they are the product name, not an identifier.

## 2. Data folder migration

Electron derives `userData` from the package `name`. Renaming the package moves
the folder, and without migration the app would open empty. The encrypted API
keys also depend on the folder: safeStorage's master key lives in `Local State`
inside it.

At the top of `src/main.js`, before anything reads a path or writes a log:

```
legacy = appData/upstream-checker
target = appData/venom-router
if target does not exist and legacy exists:
    try rename(legacy, target)          // atomic on one volume; moves Local State too
    catch → app.setPath('userData', legacy)   // locked (old instance running): keep using legacy
```

- DPAPI protects `Local State`'s key per Windows user, not per path, so encrypted
  keys keep decrypting after the move.
- If both folders exist, `target` wins and `legacy` is left untouched.
- If the process was started with `--user-data-dir`, migration is skipped and
  that directory is used as is (dev and test instances).
- The logic is a small pure function (`resolveUserDataDir(appData, fsLike)`)
  so it can be exercised with a mocked fs in Node.

## 3. Packaging and updates

- `package.json`: `name` `venom-router`, `productName` `VENOM Router`, NSIS
  `artifactName` `VENOM-Router-Setup-${version}.exe`, portable
  `VENOM Router - Portable.exe`, new description.
- Unchanged: `build.publish` (repo `upstream-checker`), `appId`, and the repo
  constant in `scripts/release.mjs` and the release-notes URL in `main.js`.
  Existing installs keep receiving updates. electron-builder's installer runs the
  old uninstaller first, so the old "Upstream Checker" shortcuts are replaced.

## 4. Logo

**Viper V.** A symmetric solid V; its inner counter is cut as an angular
top-down viper head, and a forked tongue runs from the snout — one request in,
routes out. One colour, real holes (even-odd), no gradients.

Masters (512 viewBox, `fill="currentColor"`), stored in `src/assets/brand/`:

- `mark.svg` — full detail, for 64 px and up
- `mark-32.svg` — hinted to a 16-unit pixel grid, simplified tongue, for 20–48 px
- `mark-16.svg` — hinted to 32 units per pixel, no tongue, for 16 px

Generated by `scripts/generate-icons.js`, rewritten to read those masters:

- App icon = mark in `#00d4ff` on a `#0b0f17` rounded tile (rx = 112/512).
- `icon-16.png` from `mark-16`; `icon-32/48/64.png` and `favicon.png` from
  `mark-32`; `icon-128/256/512.png` and `icon.png` from `mark`.
- `icon.ico` with 16 (`mark-16`), 32 and 48 (`mark-32`), and 256 (`mark`).

In-app, inline SVG with `currentColor` so it follows the accent:

- Titlebar icon (18 px) and sidebar brand mark (on the accent square) use `mark-32`.
- The About heading uses `mark`.

## 5. Docs

README title, intro and feature names follow the new vocabulary. CHANGELOG
header line is renamed, and a new `[Unreleased]` entry describes the rebrand and
the data-folder move. Historical CHANGELOG entries are left as written.

## 6. Verification

- `node --check` on every edited JS file; the project has no test runner.
- The migration function is exercised in Node against a mocked fs: fresh
  install, legacy only, both exist, rename throws.
- `git grep -i -E "upstream check|upstream checker|catalogue|model catalog"` over
  `src/` and `package.json` returns only internal identifiers and comments.
- The app is launched over CDP (separate instance, port 9333) against a scratch
  copy of the data folder passed with `--user-data-dir`, so the migration never
  runs on the user's real folder during testing and nothing is written to it.
  The scratch copy is deleted afterwards. Every page and the About section are
  screenshotted in dark and light themes.
- Review subagents: code review of the diff, a hunt for leftovers of the old
  brand, and a visual inspection of the screenshots and the generated icons.
