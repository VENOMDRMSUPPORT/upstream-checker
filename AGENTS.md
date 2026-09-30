# AGENTS.md — start here

**VENOM Router** is a Windows desktop LLM router (Electron 33 + better-sqlite3):
it connects providers and keys, keeps a live model pool, measures models, and
routes through `venom-lite` / `venom-pro` / `venom-max`. Version 2.0.0.
Tests: `npm test` (295, ~2 s). Everything on disk is written in English.

This file is the entry point for any coding agent. Read it, then the two
documents it points at — **do not** start by reading source files, and never
read `src/renderer/app.js`, `styles.css` or `docs/superpowers/plans/*`
wholesale (~200 k tokens together).

## Read in this order

| # | File | What it gives you | Cost |
| --- | --- | --- | --- |
| 1 | [CLAUDE.md](CLAUDE.md) | **Binding workflow rules.** One checkout, the owner's data folder is off-limits, never change how the app starts, when a release may run. | ~900 tokens |
| 2 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Boot order, the two databases, the request lifecycle, the 38 IPC channels, the renderer's globals, what proves what. | ~3 k |
| 3 | [docs/CODE_MAP.md](docs/CODE_MAP.md) | Generated index: every file under `src/`, `scripts/`, `test/` with its purpose and top-level names, **and line landmarks inside every file over 700 lines** — jump to `app.js`'s Results table (line 2887), a page in `index.html`, a block in `styles.css`. | ~6 k |
| 4 | [docs/COOKBOOK.md](docs/COOKBOOK.md) | Recipes: add a provider, an IPC channel, a setting, a log column; change the UI and prove it. | ~2 k |

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
| `npm test` | the whole suite under Electron's Node (~2 s). One file: `npm test -- test/logs/query.test.js` |
| `npm run check` | the gate: `repo:map --check` then the whole suite. Run this before saying you are done |
| `npm run verify:live` | drives a separate app over CDP on a scratch data folder against a mock provider; prints `ALL LIVE CHECKS PASSED` |
| `npm run repo:map` | regenerate `docs/CODE_MAP.md` after adding/moving a file |
| `npm run repo:map -- --check` | fail if the map is stale |
| `npm run check:keystore` | DPAPI key encryption works on this machine |
| `npm run build` / `npm run build:portable` | installers into `dist/` |
| `npm run release` | **only when the owner asks in that message.** Tags cannot be taken back |

## Where things are

| Question | File |
| --- | --- |
| Boot order, IPC wiring, updater | `src/main.js` |
| The renderer's whole API | `src/preload.js` (48 entries) |
| Key placeholders → real secrets | `src/db/keys.js` |
| Encryption at rest (`enc:v1:`) | `src/db/cipher.js` |
| Schema of `venom.db` | `src/db/migrations.js`, repos in `src/db/repos/` |
| Schema of `venom-logs.db` | `src/logs/migrations.js` |
| One finished request → one log row | `src/logs/recorder.js` |
| Log query API (list/get/stats/runs/export) | `src/logs/query.js` |
| The pages: shell, settings, testing engine | `src/renderer/app.js` |
| Test History + Monitoring | `src/renderer/logs.js` + `logs-format.js` |
| Model pool, profiles, benchmark | `src/renderer/catalog.js`, `profiles.js`, `benchmark.js` |
| Providers (7 built-in) | `src/renderer/providers/*.js` |
| Live verification | `scripts/live/verify-db.mjs` |

## Non-negotiables (short version — CLAUDE.md is the authority)

- **One checkout, this one.** Never `git worktree add`.
- **Never launch the app against `%APPDATA%\venom-router`** to test. Use a
  scratch `--user-data-dir`; `scripts/live/cdp.mjs` enforces it.
- **Never change how the app starts** (`npm start`, the resolved data folder,
  launch behaviour) without asking in the same turn.
- **Never decrypt, print, copy or move stored keys.**
- Every outbound request goes through main; the renderer holds placeholders only.
- Verification that counts is `npm run verify:live` — and it uses a **mock**
  provider. Say so whenever you cite it as proof. A scratch run starts empty:
  no providers, empty database. That is expected, not damage.
- `textContent` proves text exists, not that a person can see it. Measure
  geometry for visibility.
- Pushing saves work; `npm run release` ships and cannot be undone. Ask before
  either.

## Repo state pointers

- What shipped and when: [CHANGELOG.md](CHANGELOG.md) and `git log --oneline`.
- `docs/INDEX.md` and `docs/superpowers/**` are the **historical** record of
  past phases and designs. Never treat them as current state.
- The version lives only in [package.json](package.json); the window reads it
  over IPC.
- If `git status` is dirty, say so in your first message: the task may be about
  the pending work rather than `HEAD`.
