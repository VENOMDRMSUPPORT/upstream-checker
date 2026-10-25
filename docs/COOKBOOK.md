# Cookbook

The changes that come up most often, each with the exact files, the order to
touch them in and the command that proves it. Read
[ARCHITECTURE.md](ARCHITECTURE.md) first if a step here does not make sense.

Every recipe ends with **Accept** — the command you run before saying it is
done. If a step is missing, the tests will usually tell you which one.

---

## 1. Add an integrated provider

**Touch:** `src/renderer/providers/<id>.js` (new), `src/assets/providers/<id>.svg (or .png for raster logos)`
(new), `src/renderer/index.html` (one script tag), `README.md` (the table),
`scripts/live/verify-db.mjs` and the other live gates (the provider count).
`scripts/live/fixture.mjs` only if the provider should answer the mock server.

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
     // optional hooks: fetchModels, classify(model), excludeModel(model),
     // fetchKeyUsage, fetchKeyHistory, readQuotaError, readUsageHeaders
   };
   ```
2. Add the logo file (SVG, or PNG if raster) next to the other provider logos.
3. `index.html`: add `<script src="providers/myprovider.js"></script>` **before**
   `app.js`, in the block that already lists `providers/*.js`.
4. If the provider's usage API needs a request, tag it: every `apiRequest` call
   carries `source` (one of the `SOURCES` set in `src/logs/recorder.js`) so the
   Request Log can attribute it. An untagged call is recorded as `other`.
5. Update the live-check constants: `READY` in `scripts/live/verify-db.mjs`
   (and the same count in `verify-provider-table.mjs`,
   `verify-catalog-legend.mjs`, `verify-catalog-sidebar.mjs` and
   `verify-renderer-modules.mjs`) asserts the built-in provider count. The
   fixture writes providers for the mock server; a new provider that is not in
   the fixture simply never connects.
6. `npm run repo:map` (the new file must appear in CODE_MAP.md).

**A provider that signs in on a web page** is not this recipe: it declares
`auth: ['oauth']` and its flow in `meta.oauth`, and the OAuth plane drives it
([OAUTH_PROVIDERS.md](OAUTH_PROVIDERS.md)).

**Accept:** `npm test`, then the relevant live gate. The provider-count assertion
must report the new total and the live run must use the mock provider on scratch
data; it does not prove a real provider or key.

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

1. Add the key to `DEFAULT_SETTINGS` in `settings-defaults.js` with its default and a
   comment saying what it is for. `loadSettings` ignores a stored value whose
   type differs from the default, so the default's type is the contract.
2. Add the control to the right Settings section in `index.html`
   (`data-section="sec-…"`), with a stable id like `#set-my-thing`.
3. Register it once in the `SETTING_INPUTS` table in `app.js` (use CODE_MAP landmarks):
   `['#set-my-thing', 'myThing', 'int' | 'text' | 'bool' | 'sec' | 'ratio']`.
   That single line gives it fill-on-open, save-on-input and debounced persist.
4. If a change must act immediately (not just be stored), add the side effect in
   the input handler in `bindSettingsForm()` (use CODE_MAP landmarks), next to
   `scheduleHealthMonitor()`.
5. If **main** needs it (a timer, a purge limit, a network default), read it
   from the saved row — do not send it per request. Follow
   `src/logs/settings.js`: a pure `readX(row)` function called at startup and
   again from the `onSettingsSaved` hook in `src/main.js`. `save-settings`
   merges, so a field main does not know about survives a save.
6. A setting that spends quota (`concurrency`, scheduled runs)
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
   `%APPDATA%`. This check imports synthetic fixture data into its scratch
   folder; some focused checks start empty. Their setup is verifier-specific,
   and none uses the owner's data folder.
3. To check a new element, extend `scripts/live/verify-db.mjs` with an
   `app.evaluate(...)` block: click the real control, then assert.
4. **Measure geometry, not text.** `textContent` proves text exists, not that
   anyone can see it; a drawer that never appeared once passed a whole live run.
   Use `getBoundingClientRect()` and check the panel is inside the viewport
   (see `checkRequestsPageAndDrawer`).
5. Anything a provider can influence (model id, provider name, error message)
   is escaped before it reaches `innerHTML`.

**Accept:** the specific live check passes, or the complete live check prints
`ALL LIVE CHECKS PASSED`. Say out loud that it ran against a **mock** provider —
it has never seen a real provider, a real key, a real 429 or a real stream.

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
- The documents in `docs/` describe the code as it is now. There is no parallel
 set of historical plans to update: new state goes into ARCHITECTURE.md, the
gateway goes into LOCAL_GATEWAY.md, and shipped work goes into the
CHANGELOG.

---

## 7. Verification matrix

| Change | First proof | Stronger proof | What it does not prove |
| --- | --- | --- | --- |
| Data, logs, request, auth or catalog logic | `npm test` | `npm run check` | Visual renderer behavior |
| Renderer page or drawer | focused live gate (`verify:legend`, `verify:sidebar`, or `verify:lock`) | `npm run verify:live` | A real provider, key, stream or 429 |
| Provider integration | `npm test` | `npm run verify:live` with the fixture updated | That the provider's real endpoint accepts a real key |
| New or moved source/test file | `npm run repo:map -- --check` | `npm run check` | Runtime behavior |

Run live gates serially while diagnosing failures. They launch separate Electron
instances over scratch folders and use a local mock provider; do not use
`npm start` as a substitute for an automated live proof.

---

## 8. Extract or extend a renderer unit

1. Keep the current classic-script/CSP model. Register on `window.VENOM_RENDERER`
   inside an IIFE or expose `create(deps)`; do not add ambient lexical globals,
   runtime HTML fetches, a framework or new Node/network access in the renderer.
2. Pick a cohesive boundary (policy, requests, response parsing, appearance,
   results table, settings panel, provider storage, provider detail UI or
   connected/integrated provider roster),
   not arbitrary line chunks. Pure parsing stays in `test-response.js`; key
   eligibility/pacing belongs in `test-policy.js`; request adapters live in
   `test-attempts.js`; retry/hedging belongs in `test-runner.js`; table state,
   sorting/export and the response modal belong in `results-table.js`; form
   conversion and section navigation belong in `settings-panel.js`.
3. Pass callbacks and **live getters** from app.js. Do not capture `settings`
   or `abortTesting` by value: reset replaces settings and Stop can happen while
   a request is in flight. Do not expose mutable cooldown/denial maps just to
   make a test convenient. Preserve the original event-binding/init points.
   Keep section resetters and shared provider-card/key-panel markup in app.js.
   Provider persistence belongs in `provider-store.js`; the single-provider
   header and key list belong in `provider-detail.js`; connected/integrated
   roster state and page interactions belong in `provider-roster.js`. Pass live
   provider/page getters and narrow callbacks; discovery, roster ownership and
   catalog handoff belong in `provider-models.js`. None should import app state
   or duplicate persistence. Hash parsing and deep-link dispatch belong in
   `page-router.js`; page lifecycle effects stay composed in app.js.
4. Add the script before app.js in index.html. Existing DOM IDs, script order,
   lock-gated startup, request tags and the main/preload path stay unchanged.
   Keep existing global helper aliases only where legacy consumers need them.
5. Use `test/renderer/module-loader.js` to evaluate the **whole production
   script** in a controlled VM. Avoid extracting functions by comment anchors,
   asserting implementation source strings or testing copied mock algorithms.
6. Run focused module tests, `npm run repo:map`, then `npm run check`. For a
   renderer split, also run `node scripts/live/verify-renderer-modules.mjs`,
   `npm run verify:live` and `npm run verify:lock` serially.

The module live gate measures appearance/popup/modal/page geometry, exercises
real controls, resets/replaces settings and verifies save/close/reopen. It uses
only fake fixture keys and a local mock, and never downloads or installs an
update. It is not evidence of real-provider, real-stream or real-429 behavior.

For provider-roster assertions, `CATALOG.state.loaded` is **not discovery
readiness**. Wait for `lastSyncAt > 0 && !syncing` with a bounded deadline, then
assert the actual published rows. Do not hide a failure with a fixed sleep or
change startup behavior to make a test pass.

index.html remains one static document in this gradual slice. If source-template
composition is introduced later, keep it build-time, preserve IDs/order/CSP and
verify generated-output freshness; do not fetch templates at runtime.
