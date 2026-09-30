# Cookbook

The changes that come up most often, each with the exact files, the order to
touch them in and the command that proves it. Read
[ARCHITECTURE.md](ARCHITECTURE.md) first if a step here does not make sense.

Every recipe ends with **Accept** — the command you run before saying it is
done. If a step is missing, the tests will usually tell you which one.

---

## 1. Add an integrated provider

**Touch:** `src/renderer/providers/<id>.js` (new), `src/assets/providers/<id>.svg`
(new), `src/renderer/index.html` (one script tag), `README.md` (the table),
`scripts/live/fixture.mjs` + `scripts/live/verify-db.mjs` (the provider count).

1. Create the module. It registers itself; nothing else imports it:
   ```js
   window.INTEGRATED_PROVIDERS = window.INTEGRATED_PROVIDERS || {};
   window.INTEGRATED_PROVIDERS.myprovider = {
     meta: {
       id: 'myprovider', name: 'My Provider', baseUrl: 'https://api.example.com/v1',
       color: '#22d3ee', logo: '../assets/providers/myprovider.svg',
       modelsEndpoint: '/models', chatEndpoint: '/chat/completions',
       // optional: rateLimits, website, auth, freeTier
     },
     // optional hooks: fetchModels, classify(model), fetchKeyUsage,
     // fetchKeyHistory, readQuotaError, readUsageHeaders
   };
   ```
2. Add the logo SVG next to the other seven.
3. `index.html`: add `<script src="providers/myprovider.js"></script>` **before**
   `app.js`, in the block that already lists `providers/*.js`.
4. If the provider's usage API needs a request, tag it: every `apiRequest` call
   carries `source` (one of the `SOURCES` set in `src/logs/recorder.js`) so the
   Request Log can attribute it. An untagged call is recorded as `other`.
5. Update the two live-check constants: `READY` in `scripts/live/verify-db.mjs`
   asserts the built-in provider count, and the fixture writes providers for the
   mock server. A new provider that is not in the fixture simply never connects.
6. `npm run repo:map` (the new file must appear in CODE_MAP.md).

**Accept:** `npm test` then `npm run verify:live` — the live check prints
`seven built-in providers loaded` (now eight) and everything else passes.

**Traps:** discovery asks *every active key* for its models and records which
keys served which model; a provider whose catalogue differs per key needs no
special case, but a provider that returns a different shape needs `fetchModels`.

---

## 2. Add an IPC channel

**Touch:** the owning IPC module, `src/preload.js`, the caller in
`src/renderer`, and the channel-list assertion in `test/db/ipc.test.js` or
`test/logs/ipc.test.js`.

1. Decide where it belongs: data → `src/db/ipc.js`; request log →
   `src/logs/ipc.js`; window/update/network → `src/main.js`.
   In `db/ipc.js` use the local `handle(channel, fn)` helper — it logs the
   failure and rethrows, so the renderer's promise rejects with the reason.
2. Add one line to the `electronAPI` object in `src/preload.js`:
   `myThing: (a) => ipcRenderer.invoke('my-thing', a)` (`send` instead of
   `invoke` for fire-and-forget).
3. Call it from the renderer as `window.electronAPI.myThing(...)`.
4. **Update the exact-list test.** `test/db/ipc.test.js` asserts the complete,
   sorted channel list; adding a channel without updating it fails `npm test`
   on purpose — that list is how a stray channel gets noticed.
5. Never return a secret: replies carry `venomkey:<id>` placeholders and a
   masked hint only (`src/db/ipc.js` `readConfig`).
6. `npm run repo:map` (the channel appears in the generated IPC table).

**Accept:** `npm test` (channel list + behaviour), and the renderer path
exercised once by hand or through a live check.

---

## 3. Add a setting

**Touch:** `src/renderer/app.js` (`DEFAULTS`, `SETTING_INPUTS`), the matching
input in `src/renderer/index.html`, and — only if main needs the value —
`src/main.js` + `src/db/ipc.js` hook.

1. Add the key to `DEFAULTS` in `app.js` (~line 90) with its default and a
   comment saying what it is for. `loadSettings` ignores a stored value whose
   type differs from the default, so the default's type is the contract.
2. Add the control to the right Settings section in `index.html`
   (`data-section="sec-…"`), with a stable id like `#set-my-thing`.
3. Register it once in the `SETTING_INPUTS` table in `app.js` (~line 3885):
   `['#set-my-thing', 'myThing', 'int' | 'text' | 'bool' | 'sec' | 'ratio']`.
   That single line gives it fill-on-open, save-on-input and debounced persist.
4. If a change must act immediately (not just be stored), add the side effect in
   the input handler in `bindSettingsForm()` (~line 3950), next to
   `scheduleHealthMonitor()`.
5. If **main** needs it (a timer, a purge limit, a network default), read it
   from the saved row — do not send it per request. Follow
   `src/logs/settings.js`: a pure `readX(row)` function called at startup and
   again from the `onSettingsSaved` hook in `src/main.js`. `save-settings`
   merges, so a field main does not know about survives a save.
6. A setting that spends quota (`concurrency`, scheduled runs, auto-benchmark)
   must default to the cheap side and say so in the UI copy.

**Accept:** `npm test`; then in the app: open Settings, change it, close and
reopen — the value is still there. The live check has the same round-trip for
retention (`a changed retention value round-trips to the database`).

---

## 4. Add a column to the request log

**Touch:** `src/logs/migrations.js`, `src/logs/writer.js`,
`src/logs/recorder.js`, maybe `src/logs/classify.js`, `src/logs/query.js`,
then the page (`src/renderer/logs.js`, `logs-format.js`) and `test/helpers.js`.

1. `src/logs/migrations.js`: **append** version 2 (`ALTER TABLE request_logs
   ADD COLUMN …`). Never edit version 1 — it has shipped on the owner's machine.
2. `src/logs/writer.js`: add the name to `ROW_COLUMNS` (positional binding; a
   missing name is a silent `null`). If it is a number the charts should count,
   also add it to `ROLLUP_COUNTERS` and set it in `rollupDelta`.
3. `src/logs/recorder.js`: fill the value in `buildRecord`. Anything read out of
   provider text must be clipped and scrubbed like the fields already there.
4. `src/logs/query.js`: expose it — `EXPORT_COLUMNS` for CSV/JSON, the row
   shape for the list and the drawer.
5. `src/renderer/logs-format.js`: pure formatting/mapping (`toViewModel`), with
   a unit test in `test/renderer/logs-format.test.js`. Then the page markup in
   `src/renderer/logs.js`; every provider-sourced string goes through
   `logEscape`.
6. `test/helpers.js` `logRow()` builds a full row: add the field there or every
   log test starts from a row missing a column.
7. `npm run repo:map` is not needed for a column, but `npm test` is: the schema,
   writer and query tests will fail if a step is missing.

**Accept:** `npm test`, then `npm run verify:live` for the visual path.

**Traps:** the log database is *not* backed up before a migration (it is not
critical data). A failed migration must leave the file at the last good
version — that is why each migration runs in its own transaction.

---

## 5. Change the UI and prove it

**Touch:** `src/renderer/*`.

1. `npm start` runs **your** app on **your** data folder. In development main
   watches `src/renderer`: a CSS save is swapped into the open page, a JS or
   HTML save reloads it. No restart.
2. Automated proof: `npm run verify:live` launches a **separate** app over CDP
   on a scratch `--user-data-dir` against a mock provider on 127.0.0.1, then
   deletes the folder. `scripts/live/cdp.mjs` refuses any path under
   `%APPDATA%`. A scratch run starts with **no providers and an empty
   database** — that is expected, not a broken build.
3. To check a new element, extend `scripts/live/verify-db.mjs` with an
   `app.evaluate(...)` block: click the real control, then assert.
4. **Measure geometry, not text.** `textContent` proves text exists, not that
   anyone can see it; a drawer that never appeared once passed a whole live run.
   Use `getBoundingClientRect()` and check the panel is inside the viewport
   (see `checkRequestsPageAndDrawer`).
5. Anything a provider can influence (model id, provider name, error message)
   is escaped before it reaches `innerHTML`.

**Accept:** the live check prints `ALL LIVE CHECKS PASSED`, or the specific new
check passes. Say out loud that it ran against a **mock** provider — it has
never seen a real provider, a real key, a real 429 or a real stream.

---

## 6. Keep the docs honest

```bash
npm run repo:map          # regenerate docs/CODE_MAP.md after adding/moving files
npm run repo:map -- --check   # exits 1 when it is stale (use in CI or pre-commit)
```

- Adding or renaming a file under `src/`, `scripts/` or `test/` requires
  `npm run repo:map`, or the map starts lying.
- Changing the architecture in a way this cookbook or ARCHITECTURE.md describes
  means editing them in the same change. They are hand-written; CODE_MAP.md is
  the only generated one.
- `docs/superpowers/**` and `docs/INDEX.md` are the historical record. Do not
  update them to describe new work; write the new state into ARCHITECTURE.md or
  the CHANGELOG instead.
