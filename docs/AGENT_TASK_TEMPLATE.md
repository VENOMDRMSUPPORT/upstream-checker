# Task card — how to delegate without paying for discovery twice

An agent that has to *find* the task spends its context on the repository
instead of the work: reading files to work out what to read, then reading them
again to change them. A card removes that. Fill it once, paste it with the
request. Keep it short — the value is in the four lines that name files,
boundaries and proof.

Write the task itself in whatever language you speak; the agent answers in it.

## The card

```
GOAL
  <one sentence, in terms of observable behaviour — not "refactor X">

READ FIRST (only these)
  AGENTS.md
  docs/ARCHITECTURE.md  <section, if you know it>
  docs/CODE_MAP.md      <the rows/landmarks for the files below>

FILES YOU MAY CHANGE
  <exact paths>            (this is the write scope — nothing else)

DO NOT TOUCH
  <paths, or "npm start", or "the owner's data folder">

ACCEPTANCE (run this, paste the output)
  npm test                        # or
  npm test -- test/logs/query.test.js
  npm run verify:live             # UI paths only; mock provider, scratch folder

REPORT BACK
  what changed (files + why), the acceptance output, what you did NOT verify
```

## Example — a UI change

```
GOAL
  The Failed card on a provider page filters the results table to failed rows,
  and clicking it again clears the filter.

READ FIRST
  AGENTS.md; docs/ARCHITECTURE.md §7; docs/CODE_MAP.md → landmarks for
  src/renderer/app.js (Results table ~line 2887) and src/renderer/index.html

FILES YOU MAY CHANGE
  src/renderer/app.js, src/renderer/index.html, src/renderer/styles.css

DO NOT TOUCH
  src/main.js, src/db/**, src/logs/**, npm start

ACCEPTANCE
  npm test
  npm run verify:live     (add a check in scripts/live/verify-db.mjs that
                           measures geometry, not textContent)

REPORT BACK
  files + why, the live-check line that proves it, anything not covered
```

## Example — a data change

```
GOAL
  Record the HTTP response's `x-request-id` header on every logged request and
  show it in the request drawer.

READ FIRST
  AGENTS.md; docs/ARCHITECTURE.md §4; docs/COOKBOOK.md recipe 4
  docs/CODE_MAP.md → src/logs/*

FILES YOU MAY CHANGE
  src/logs/migrations.js, src/logs/writer.js, src/logs/recorder.js,
  src/logs/query.js, src/renderer/logs.js, src/renderer/logs-format.js,
  test/helpers.js, test/logs/**, test/renderer/logs-format.test.js

DO NOT TOUCH
  src/db/**, the owner's data folder

ACCEPTANCE
  npm test
  npm run repo:map          (new symbols land in the map)

REPORT BACK
  the migration version you added, the tests you added, what you did not verify
```

## Three rules that do the most work

1. **Name the files.** "Fix the log page" costs a full exploration; "the
   Requests table in src/renderer/logs.js" costs nothing.
2. **Name the proof.** An agent that knows the acceptance command stops when it
   passes instead of gold-plating.
3. **One writer per file.** Two agents on one file is a merge, not a team.
