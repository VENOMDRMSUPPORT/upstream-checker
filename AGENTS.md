# AGENTS.md — start here

**VENOM Router** is a Windows desktop LLM router (Electron 33 + better-sqlite3):
it connects providers and keys, keeps a live model catalog, tests models, records
requests, and monitors provider/model activity. Read the version in `package.json`.
Tests run with `npm test` under Electron's Node; its output is authoritative for
the current test count and duration. Everything on disk is written in English.

This file is the entry point for any coding agent. Read it first, then read the
linked guidance below in order — **do not** start by reading source files. Never
read `src/renderer/app.js` or `styles.css` wholesale (~130 k tokens together).

## Read in this order

| # | File | What it gives you |
| --- | --- | --- |
| 1 | [CLAUDE.md](CLAUDE.md) | **Binding workflow rules.** One checkout, the owner's data folder is off-limits, never change how the app starts, when a release may run. |
| 2 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Boot order, the two databases, the request lifecycle, IPC groups, the renderer's globals, what proves what. |
| 3 | [docs/CODE_MAP.md](docs/CODE_MAP.md) | Generated index of source files under `src/`, `scripts/`, and `test/`, with their purpose and top-level names; **line landmarks for files over 700 lines** — use the current generated landmarks. |
| 4 | [docs/COOKBOOK.md](docs/COOKBOOK.md) | Recipes for common changes and their acceptance checks; consult the relevant recipe for the task. |

Then open the specific files the task names — and for a long file, open the
window its landmarks give you, never the whole file.

**When you delegate this work onwards**, hand the other agent a card from
[docs/AGENT_TASK_TEMPLATE.md](docs/AGENT_TASK_TEMPLATE.md): the goal, the files
it may change, the acceptance command. That, plus this file, is what turns a
20-minute discovery into a two-minute one.

## Commands

| Command | Use |
| --- | --- |
| `npm start` | run **the owner's** app on **their** data folder — never for testing |
| `npm test` | the whole suite under Electron's Node; output reports the current count and duration. One file: `npm test -- test/logs/query.test.js` |
| `npm run check` | the gate: `repo:map --check` then the whole suite. Run this before saying you are done |
| `npm run verify:live` | drives a separate app over CDP on a scratch data folder against a mock provider; prints `ALL LIVE CHECKS PASSED` |
| `npm run verify:catalog` / `verify:legend` / `verify:sidebar` | focused Models Catalog live checks on scratch data |
| `npm run verify:lock` | focused app-lock and security-page live check on scratch data |
| `npm run verify:antigravity` | focused Antigravity check on scratch data: the sign-in, the roster, the allowance, the chat |
| `node scripts/live/verify-renderer-modules.mjs` | module composition, appearance, persistence and navigation, plus the router-page geometry check |
| `node scripts/live/verify-provider-table.mjs` | the provider test table's reference columns and their tri-state display |
| `npm run repo:map` | regenerate `docs/CODE_MAP.md` after adding/moving a file |
| `npm run repo:map -- --check` | fail if the map is stale |
| `npm run check:keystore` | DPAPI key encryption works on this machine |
| `npm run build` / `npm run build:portable` | installers into `dist/` |
| `npm run release` | **only when the owner asks in that message.** Tags cannot be taken back |

## Where things are

| Question | File |
| --- | --- |
| Boot order, IPC wiring, updater | `src/main.js` |
| The renderer's whole API | `src/preload.js` (the contextBridge surface) |
| Key placeholders → real secrets | `src/db/keys.js` |
| Encryption at rest (`enc:v1:`) | `src/db/cipher.js` |
| Schema of `venom.db` | `src/db/migrations.js`, repos in `src/db/repos/` |
| Catalog sources, merge, scoring and IPC | `src/catalog/` |
| Schema of `venom-logs.db` | `src/logs/migrations.js` |
| One finished request → one log row | `src/logs/recorder.js` |
| Log query API (list/get/stats/runs/export) | `src/logs/query.js` |
| Shell, general settings, provider/results UI and composition | `src/renderer/app.js` |
| Test policy, requests, responses and retry/hedging | `src/renderer/test-policy.js`, `test-attempts.js`, `test-response.js`, `test-runner.js` |
| Settings defaults, appearance, update UI and sidebar effects | `src/renderer/settings-defaults.js`, `appearance.js`, `updates.js`, `sidebar-effects.js` |
| Test History + Monitoring | `src/renderer/logs.js` + `logs-format.js` |
| Catalog roster: discovery, the Models table, the three per-row actions | `src/renderer/catalog.js` |
| Bell + Model Activity page (roster change feed) | `src/renderer/activity.js`, events in `src/db/repos/roster-events.js` |
| Local routing gateway and the three profiles | `src/router/index.js`, wired in `src/main.js`; `docs/LOCAL_GATEWAY.md` |
| Venom Profiles page and the shared profile badges | `src/renderer/router-status.js`, `src/renderer/profile-badges.js` |
| Built-in provider adapters (current set) | `src/renderer/providers/` — inspect the directory for the current modules |
| A provider that signs in on a web page (the OAuth plane) | `src/oauth/`, wired in `src/main.js`; `docs/OAUTH_PROVIDERS.md` |
| A provider that does not speak OpenAI (its own protocol) | `src/wire/` — the request it understands and the answer it sends back |
| Live verification | `scripts/live/verify-db.mjs` |

## Non-negotiables (short version — CLAUDE.md is the authority)

- **One checkout, this one.** Never `git worktree add`.
- **Work only on `main`.** Never create, switch to or push any other branch —
  no `git switch -c`, no feature branches.
- **Never launch the app against `%APPDATA%\venom-router`** to test. Use a
  scratch `--user-data-dir`; `scripts/live/cdp.mjs` enforces it.
- **Never change how the app starts** (`npm start`, the resolved data folder,
  launch behaviour) without asking in the same turn.
- **Stored keys may be used for live testing through the app's own request path
  (owner-authorized 2026-10-09); key values are never printed, copied or moved.**
- Every outbound request goes through main; the renderer holds placeholders only.
- `npm run verify:live` is the end-to-end app check and uses a **mock** provider;
  say so whenever you cite it as proof. Use `npm test` for unit-level behavior
  and the focused live gates for their specific UI paths; no single check proves
  every kind of change.
- Live checks use isolated scratch data, never the owner's data. Their initial
  state depends on the verifier: some seed synthetic fixtures, while others
  start empty. Check the specific script and describe its setup accurately.
- `textContent` proves text exists, not that a person can see it. Measure
  geometry for visibility.
- Pushing saves work; `npm run release` ships and cannot be undone. Ask before
  either.

## Repo state pointers

- What shipped and when: [CHANGELOG.md](CHANGELOG.md) and `git log --oneline`.
- What each document covers: [docs/INDEX.md](docs/INDEX.md). The documents in
  `docs/` describe the code as it is now; there is no separate historical set.
- The version lives only in [package.json](package.json); the window reads it
  over IPC.
- If `git status` is dirty, say so in your first message: the task may be about
  the pending work rather than `HEAD`.
