# VENOM Router — how work happens here

Rules for anyone (human or agent) working in this repository. They exist
because they were broken once and it cost the owner a day of confusion.

> **New here?** Read [AGENTS.md](AGENTS.md) first, then
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
> [docs/CODE_MAP.md](docs/CODE_MAP.md). Those say what the project is and where
> things are; the rules below are the ones you must not break.

## Current project facts

- Current version: read `package.json`; it is the only authoritative version.
- The suite currently contains **838 tests** and runs through Electron's Node.
- Eleven provider modules are loaded from `src/renderer/providers/`.
- Runtime data is SQLite: `venom.db` plus `venom-logs.db`; legacy JSON is import
  input only.
- Unpackaged `npm start` uses `%APPDATA%\venom-router-dev`; packaged builds use
  `%APPDATA%\venom-router`. An explicit `--user-data-dir` always wins.

## One checkout. Always this one.

The current authorized checkout is **`G:\Venom-Projects\venom-router`**. The owner runs the
app with **`npm start`** from that folder. That is the only copy of this
project they look at.

- **Never run `git worktree add`.** No second checkout, no scratch clone, no
  "isolated" copy. If isolation seems necessary, ask first and say plainly
  what it costs: *"your `npm start` will not show this work until it merges."*
- **Work only on `main`. Never create, switch to or push any other branch.**
  No `git switch -c`, no `git branch`, no feature branches, no PR branches.
  Every commit lands on `main` in this folder. The owner runs `npm start`
  from here, so a branch they never check out is work they cannot see.
- If work must live somewhere else for a real reason and the owner agrees,
  **say it in the same message**, with the exact command to run it:
  `cd "<path>" && npm start`. Never let them discover it by finding an empty
  app.

## The owner's data folder is theirs

Their real providers, keys and history live in
`%APPDATA%\venom-router`. Packaged builds open it by default; unpackaged
development uses the separate `venom-router-dev` folder described above.

- **Never launch the app on that folder to test something.** Every
  verification run uses `--user-data-dir=<a temporary folder>` and deletes it
  afterwards. `scripts/live/cdp.mjs` already does this and refuses a
  non-scratch path.
- A scratch run starts with **no providers and an empty database**. That is
  correct and expected — it is not a broken build. **Say so in one line the
  first time you do it in a session**, or it reads as damage.
- Stored keys may be used for live testing through the app's own request path
  (owner-authorized 2026-10-09). Key values themselves are still never
  printed, copied or moved anywhere.

## Never change how the app starts

`npm start`, the data folder it resolves, and the launch behaviour are the
owner's workflow. Do not change any of them — not for a refactor, not on a
reviewer's advice, not "temporarily". Ask, every time, even when the change
looks obviously right.

## Show working software early

The owner should be able to see progress **in their own app**, not in a test
summary.

- Do not go more than two or three tasks without something they can open and
  click. Say what to look at, in one line.
- "702 tests pass" is not the same as "you can see it working". Lead with the
  second when both are true.

## Verification that counts

- `npm test` runs the suite under Electron's own Node (plain `node` cannot
  load `better-sqlite3`). A single file: `npm test -- test/logs/query.test.js`.
- `npm run verify:live` drives the packaged app through CDP against a
  **mock provider** on `127.0.0.1`. It has never seen a real provider, a real
  key, a real 429 or a real stream. Say that whenever you report it as proof.
- A check that reads `textContent` proves the text exists, not that a person can
  see it. Measure geometry when the question is visibility — that is how a
  drawer that never appeared once passed a full live run.

### Verification commands

```text
npm run check                 CODE_MAP freshness + the full test suite
npm run check:keystore        Windows DPAPI/safeStorage encryption round-trip
npm run verify:live           end-to-end app path with mock provider and scratch data
npm run verify:catalog        catalog boot and sync path under a network guard
npm run verify:legend         capability legend geometry and icon states
npm run verify:sidebar        catalog details drawer geometry
npm run verify:lock           lock screen, inert shell and reset-lock behavior
node scripts/live/verify-renderer-modules.mjs  module composition, appearance, persistence and navigation
```

Run live checks serially when diagnosing a failure: each one owns a scratch
folder and DevTools port. Report the exact failing gate; do not turn a partial
live run into a claim that the whole application passed.

## Releasing

`main` is what ships. The version lives **only** in `package.json`; the
window reads it over IPC. Never hardcode it anywhere else.

`npm run release` smoke-tests the build, tags the remote, publishes the notes
from `CHANGELOG.md` and uploads the installers. **The tag cannot be taken
back.** Do not run it without the owner saying so in that message, and not
before they have used the build against their real providers for a normal
day.

Pushing `main` is not releasing — it saves work and ships nothing. Still ask,
but say plainly that it is a push.
