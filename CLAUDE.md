# VENOM Router — how work happens here

Rules for anyone (human or agent) working in this repository. They exist
because they were broken once and it cost the owner a day of confusion.

## One checkout. Always this one.

The owner works in **`C:\Users\venom\Desktop\UPSTREAM CHECKER`** and runs the
app with **`npm start`** from that folder. That is the only copy of this
project they look at.

- **Never run `git worktree add`.** No second checkout, no scratch clone, no
  "isolated" copy. If isolation seems necessary, ask first and say plainly
  what it costs: *"your `npm start` will not show this work until it merges."*
- Work on a branch **in this folder**. `git switch -c feat/x` and stay here.
  A branch the owner can run is worth more than a branch that is tidy.
- If work must live somewhere else for a real reason and the owner agrees,
  **say it in the same message**, with the exact command to run it:
  `cd "<path>" && npm start`. Never let them discover it by finding an empty
  app.

## The owner's data folder is theirs

Their real providers, keys and history live in
`%APPDATA%\venom-router`. The app opens it by default.

- **Never launch the app on that folder to test something.** Every
  verification run uses `--user-data-dir=<a temporary folder>` and deletes it
  afterwards. `scripts/live/cdp.mjs` already does this and refuses a
  non-scratch path.
- A scratch run starts with **no providers and an empty database**. That is
  correct and expected — it is not a broken build. **Say so in one line the
  first time you do it in a session**, or it reads as damage.
- Never decrypt, print, copy or move their stored keys. To probe a provider
  with a real key, ask the owner to run it themselves with the key in an
  environment variable.

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
- "295 tests pass" is not the same as "you can see it working". Lead with the
  second when both are true.

## Verification that counts

- `npm test` runs the suite under Electron's own Node (plain `node` cannot
  load `better-sqlite3`). A single file: `npm test -- test/logs/query.test.js`.
- `npm run verify:live` drives the packaged app through CDP against a
  **mock provider** on `127.0.0.1`. It has never seen a real provider, a real
  key, a real 429 or a real stream. Say that whenever you report it as proof.
- A check that reads `textContent` proves the text exists, not that a person
  can see it. Measure geometry when the question is visibility — that is how
  a drawer that never appeared once passed a full live run.

## Releasing

`main` is what ships. The version lives **only** in `package.json`; the
window reads it over IPC. Never hardcode it anywhere else.

`npm run release` smoke-tests the build, tags the remote, publishes the notes
from `CHANGELOG.md` and uploads the installers. **The tag cannot be taken
back.** Do not run it without the owner saying so in that message, and not
before they have used the build against their real providers for a normal
day.

Pushing a branch or `main` is not releasing — it saves work and ships
nothing. Still ask, but say which of the two it is.
