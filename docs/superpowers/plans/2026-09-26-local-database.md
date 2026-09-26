# Local Database (Sub-project A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `config.json`, `catalog.json` and `history.json` with one SQLite file (`venom.db`) owned by the main process, keep API keys in main, and close every data-loss path the persistence audit found.

**Architecture:** A new `src/db/` layer (better-sqlite3, synchronous, main process only) with one repository per store, a one-shot JSON importer and a single IPC registration module. Nothing under `src/db/` loads electron; encryption is an injected cipher built from `safeStorage`. The renderer stops treating main as a blob store: it sends small typed writes (`save-settings`, `save-provider`, …) through one `persist()` helper that reports failures and is blocked for the whole session if a startup read failed. In phase 2 the renderer holds placeholders (`venomkey:<id>`) instead of keys and main swaps in the secret per request, only for that key's own origin.

**Tech Stack:** Electron 33 (Node 20.18, ABI 130), better-sqlite3 `~12.11`, plain-JS renderer (no bundler), electron-builder 26 (NSIS + portable), `node:test` run under Electron's Node, CDP driven by Node 24's built-in `fetch`/`WebSocket` for live checks.

**Spec:** `docs/superpowers/specs/2026-09-26-local-database-design.md` (rev 2, approved). Supporting research: `docs/superpowers/research/2026-09-26-new-api/06-venom-current-persistence.md`, `07-verification.md`, `02-data-model.md`.

**Execution notes:** work on branch `feat/local-database` (created in Task 1). One commit per task. Never push. Run a review subagent after each phase (Tasks 1-14, 15-17, 18-19, 20) and a whole-branch review at the end. Phases are not released on their own. `npm start` on this branch uses the real data folder, %APPDATA%\venom-router, same as a packaged run (owner decision 2026-09-26). Before running it against real data, copy %APPDATA%\venom-router somewhere safe yourself. Agents must not launch the app without an explicit `--user-data-dir` pointed at a scratch folder.

## Global Constraints

- Engine: `better-sqlite3` pinned `~12.11` (`~12.11.1`), a local dependency, loaded in the main process only. No Electron upgrade (Electron 33 = Node 20.18, ABI 130; better-sqlite3 13.x needs Node ≥ 22).
- npm 12 blocks dependency install scripts: better-sqlite3 is approved with `npm install-scripts approve better-sqlite3` (recorded as `allowScripts` in `package.json`). `postinstall` is `electron-builder install-app-deps`.
- DB file `venom.db` in `app.getPath('userData')` (resolved by `src/user-data.js`), opened once inside `app.whenReady()` before the window, closed in `will-quit`.
- Pragmas on open: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`, `temp_store=MEMORY`.
- Schema version in `PRAGMA user_version`; one transaction per migration; backup `venom.db.bak-v<from>` before migrating a non-empty DB, keep the last 3; newer schema → dialog "This data was written by a newer VENOM Router. Update the app to open it." and quit without writing.
- `src/db/*` never `require('electron')` at load. Everything that encrypts takes a cipher `{ available(), encrypt(text), decrypt(text) }`; the real one wraps `safeStorage` in the `enc:v1:` + base64 envelope. Tests inject a fake cipher.
- Conventions: timestamps are integer epoch ms; booleans 0/1; JSON columns are `TEXT` named `*_json`.
- `provider_keys.cipher` and `secrets.cipher` are always `enc:v1:…`: never plaintext, never `''`. Existing ciphertext is copied verbatim on import, never decrypted and re-encrypted.
- Import: 3 read attempts 200 ms apart; renames `<name>.imported.json`, `<name>.imported-<ms>.json` on collision, `<name>.unreadable.json` for a damaged catalogue/history; nothing is deleted; `requests.log` is not touched. Missing DB + `*.imported.json` → dialog with buttons "Re-import from the saved files" / "Start empty".
- Renderer key shape: `{ id, name, key: 'venomkey:<id>', hint, active, quotaSpent, locked }`; locked → `key = ''`, `hint = ''`. `settings.aaApiKey` is `'venomsecret:aaApiKey'` when set, else `''`.
- Placeholder resolution: provider key → origin of its provider's `base_url`; `aaApiKey` → `https://artificialanalysis.ai`. Refusal resolves `{ status: 0, blocked: true, error: 'Key blocked: <host> is not this key's provider' }` and is logged. `requests.log` keeps placeholders.
- History cap: `historyMaxRuns`, max 5000, default 300; the renderer caps its in-memory history the same way.
- Close flush waits for `flush-done` at most 2 s. `install-update` runs the same flush before `quitAndInstall`.
- Single instance: `app.requestSingleInstanceLock()` right after `app.setPath('userData')`, before the DB opens.
- Tests: `node:test`, run by `scripts/run-tests.js` under Electron with `ELECTRON_RUN_AS_NODE=1`, files listed explicitly (Node 20 has no `--test` globs). `npm test` runs it.
- Live checks run a separate instance on a scratch `--user-data-dir` under `%TEMP%` built from a synthetic fixture. Never open, copy or launch against `%APPDATA%\venom-router`. Never send keyboard shortcuts to the owner's windows. Kill only processes the script spawned.
- Code style: CommonJS in `src/` main-side code, plain browser scripts in `src/renderer` (no modules; top-level functions are globals shared across files), ESM `.mjs` only under `scripts/live/` and `scripts/release.mjs`. Comments explain why, at the density of the surrounding code. Everything written to disk is English.
- Use the Edit tool for source edits (scripted `String.replace` eats `$$`, heredocs eat backslashes).

## Review Focus

1. **Import aborted half-way** (a row write fails inside the import transaction, e.g. disk full): nothing is committed, the JSON files are not renamed, `imported_from_json_at` stays unset and the next launch imports again. Test: Task 8 `a write that fails mid-import commits nothing and renames nothing`.
2. **A secret crossing to the renderer**: no IPC reply (`read-config`, `save-provider`, `merge-provider`, `save-secret`, `copy-key`) ever contains a key or the Artificial Analysis key in plaintext, including a key typed in just now. Test: Task 16 `no reply hands a secret to the renderer`.
3. **Saves pending at close** (a settings change 100 ms before the X button, or a hung renderer): the close waits for the renderer's flush, and a renderer that never answers cannot hold the window open past 2 s. Tests: Task 19 `requestFlush` unit tests and the live check `a save queued right before closing was written by the close handshake`.
4. **A catalogue write that rolls back** (constraint or disk error inside the transaction): the in-memory row hashes are not advanced, so the next write sends the same rows again instead of silently skipping them. Test: Task 6 `a write that fails inside the transaction is retried in full next time`.
5. **Settings fields the renderer doesn't know** (legacy `mediaPrompt`, fields a newer build added): the renderer's first `save-settings` keeps them instead of dropping them. Test: Task 4 `saveSettings strips aaApiKey and keeps fields the renderer does not know`.

## Spec rulings made while planning

1. "Toast" = the existing status bar (`setStatus('error', 'Couldn't save settings: …')`) plus `console.error`. No new toast component.
2. `save-settings` merges into the stored `settings` row (Review Focus 5); `aaApiKey` is always stripped.
3. Catalogue round trip: every field round-trips exactly (JSON columns keep `null` apart from absent), except `benchError`/`capsError`, which read back as `null` when they were absent (the renderer treats both alike). The round-trip fixture carries both fields.
4. Importer: a legacy key with no value is skipped and reported (there is no secret to keep); key ids that don't match `[A-Za-z0-9_.-]{1,64}` are re-assigned like duplicates (placeholders must stay resolvable); a provider or key entry that isn't an object aborts the import ("cannot be written").
5. Import I/O and parse aborts happen after `venom.db` was created and migrated (empty, no `imported_from_json_at`), so the next launch retries. "No new file is created" applies to open failures.
6. `merge-provider` and `delete-provider` arrive in phase 1: `write-config` is removed there, so the renderer can no longer edit provider arrays and write them back.
7. In phase 1 the AA key input saves through `save-secret` directly and "Reset settings" keeps the secret, because `save-settings` starts stripping the key in phase 1. The "Saved"/"Remove" UI is phase 2.
8. Startup read gate: after a failed read the window still renders defaults/empty stores in memory so it stays usable, but `persist()` refuses every write for the session and a banner stays up.
9. `db.backup()` is async in better-sqlite3, so `open()` is async.
10. `save-provider`: a placeholder of another key of the same provider copies that cipher; an unknown placeholder fails; a plaintext equal to the stored secret keeps the stored cipher (no re-encryption churn while phase 1 hands out plaintext).
11. DB-level `CHECK (cipher LIKE 'enc:v1:_%')` on `provider_keys` and `secrets` as defence in depth.
12. Longest-id rule: the maximal token run `[A-Za-z0-9_.-]+` resolves to the longest existing key id that prefixes it; no prefix → blocked as unknown.
13. Publishing uses `--prepackaged dist/win-unpacked`, so the uploaded installers are built from the smoke-tested binaries.
14. `--smoke-test` refuses to run without `--user-data-dir` (exit 2), so it can never write into real data.
15. The import-warnings dialog is covered by unit tests, not by the live fixture (a modal dialog would stall the CDP run).

## File map

| File | Responsibility |
|---|---|
| `scripts/run-tests.js` | Lists `test/**/*.test.js`, runs them under Electron's Node |
| `src/db/cipher.js` | `enc:v1:` envelope, `createCipher(safeStorage)`, `revealCached` |
| `src/db/migrations.js` | Ordered `{ version, up(db) }`; schema v1 |
| `src/db/index.js` | `open(dir, { cipher, log })`, pragmas, `migrate()`, backup, meta, `close()`, repository wiring |
| `src/db/repos/settings.js` | `settings` rows (`settings`, `test`, `window`) |
| `src/db/repos/secrets.js` | Encrypted named secrets (`aaApiKey`), allowed origins |
| `src/db/repos/providers.js` | Providers + keys, save semantics, merge, delete, `maskKey` |
| `src/db/repos/catalog.js` | Model pool rows, diffed writes, catalogue meta |
| `src/db/repos/history.js` | Test runs + results, trim |
| `src/db/ulid.js` | ULID for `run_uid` |
| `src/db/import-json.js` | One-shot legacy JSON importer, warnings text |
| `src/db/ipc.js` | Registers every data IPC channel |
| `src/db/keys.js` | Placeholder → secret resolution for `api-request` |
| `src/flush.js` | Close handshake with the renderer |
| `src/main.js` | Startup (lock, DB, import, dialogs), window, `api-request`, smoke test |
| `src/preload.js` | New IPC surface |
| `src/renderer/app.js`, `catalog.js`, `key-usage.js`, `index.html`, `styles.css` | Renderer changes |
| `scripts/live/cdp.mjs`, `fixture.mjs`, `mock-provider.mjs`, `verify-db.mjs` | Live check tooling |
| `scripts/check-import-counts.js` | Owner-run read-only count comparison |
| `scripts/release.mjs` | Build → smoke → publish |
| `test/helpers.js`, `test/db/*.test.js`, `test/*.test.js` | Unit tests |

---

# Phase 1 — DB layer, importer, new IPC surface, startup read gate

### Task 1: Dependency spike and test runner

**Files:**
- Modify: `package.json` (dependency, `allowScripts`, `postinstall`, `test`)
- Modify: `package-lock.json` (by npm)
- Create: `scripts/run-tests.js`
- Test: `test/user-data.test.js` (existing, unchanged; now run through the new runner)

**Interfaces:**
- Consumes: nothing.
- Produces: `npm test` (all files) and `npm test -- <file> [<file>…]` (just those), both under Electron's Node with `ELECTRON_RUN_AS_NODE=1`. `require('better-sqlite3')` works under Electron's ABI in tests and in the app.

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feat/local-database
```
Expected: `Switched to a new branch 'feat/local-database'`

- [ ] **Step 1b: Commit this plan on the branch**

```bash
git add docs/superpowers/plans/2026-09-26-local-database.md && git commit -m "docs: local database implementation plan"
```
Expected: one file committed; `git status --short` prints nothing.

- [ ] **Step 2: Install better-sqlite3 as a local dependency**

```bash
npm install better-sqlite3@~12.11.1
```
Expected: `package.json` `dependencies` gains `"better-sqlite3": "~12.11.1"`, and npm 12 warns that the install script was blocked:
```
npm warn install-scripts   better-sqlite3@12.11.1 (install: prebuild-install || node-gyp rebuild --release)
```

- [ ] **Step 3: Approve its install script**

```bash
npm install-scripts approve better-sqlite3
```
Expected: `Approved better-sqlite3:` and `package.json` gains:
```json
"allowScripts": {
  "better-sqlite3@12.11.1": true
}
```

- [ ] **Step 4: Add `postinstall` and point `test` at the new runner**

In `package.json` replace:
```json
    "check:keystore": "electron scripts/keystore-check.js",
    "test": "node --test \"test/**/*.test.js\""
```
with:
```json
    "check:keystore": "electron scripts/keystore-check.js",
    "postinstall": "electron-builder install-app-deps",
    "test": "node scripts/run-tests.js"
```

- [ ] **Step 5: Rebuild native dependencies for Electron's ABI**

```bash
npm run postinstall
```
Expected: electron-builder logs `installing native dependencies  arch=x64` and a line naming `better-sqlite3`, and exits 0. (It uses `@electron/rebuild`, which fetches the `electron-v130-win32-x64` prebuild.)

- [ ] **Step 6: Prove it loads under Electron's Node**

```bash
ELECTRON_RUN_AS_NODE=1 npx electron -e "const D = require('better-sqlite3'); const db = new D(':memory:'); console.log(db.prepare('SELECT sqlite_version() AS v').get().v, process.versions.electron, process.versions.modules); db.close()"
```
Expected: `3.<x>.<y> 33.4.11 130` (SQLite version as bundled, Electron `33.4.11`, ABI `130`).

And, for the record, the system Node cannot load the Electron build (this is why tests run under Electron):
```bash
node -e "require('better-sqlite3')(':memory:')"
```
Expected: an error mentioning `NODE_MODULE_VERSION 130` (or "Could not locate the bindings file").

- [ ] **Step 7: Prove it loads inside the app process**

Create the scratch file `scripts/spike-sqlite.js` (deleted in Step 9, never committed):
```js
// Scratch: proves better-sqlite3 loads in Electron's main process. Delete after use.
const { app } = require('electron');

app.whenReady().then(() => {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    console.log('APP LOAD OK', db.prepare('SELECT sqlite_version() AS v').get().v, process.versions.electron);
    db.close();
    app.exit(0);
  } catch (err) {
    console.error('APP LOAD FAILED', err);
    app.exit(1);
  }
});
```
Run: `npx electron scripts/spike-sqlite.js`
Expected: `APP LOAD OK 3.<x>.<y> 33.4.11`, exit code 0. (No window opens and no data folder is touched.)

- [ ] **Step 8: Write `scripts/run-tests.js`**

```js
// Runs the unit tests under Electron's own Node (ELECTRON_RUN_AS_NODE=1).
// better-sqlite3 is rebuilt for Electron's ABI by postinstall, so the system
// Node can't load it. Node 20 (Electron 33) has no globs in --test, so the
// test files are listed here.
//
//   npm test                          every test/**/*.test.js
//   npm test -- test/db/x.test.js     just the files given
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
// Required from plain Node, the electron package exports the binary's path.
const electron = require('electron');

const ROOT = path.join(__dirname, '..');

function findTests(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return findTests(full);
      return entry.name.endsWith('.test.js') ? [full] : [];
    })
    .sort();
}

const args = process.argv.slice(2);
const files = args.length ? args.map((f) => path.resolve(ROOT, f)) : findTests(path.join(ROOT, 'test'));
if (files.length === 0) {
  console.error('No test files found');
  process.exit(1);
}

const result = spawnSync(electron, ['--test', ...files], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
```

- [ ] **Step 9: Run the existing suite through the runner, then remove the scratch file**

Run: `npm test`
Expected: the five `user-data` tests run and the summary shows `pass 5` and `fail 0`.

```bash
rm scripts/spike-sqlite.js
git status --short
```
Expected: only `package.json`, `package-lock.json` and `scripts/run-tests.js` are listed.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json scripts/run-tests.js
git commit -m "build: add better-sqlite3 and run tests under Electron's Node"
```

---

### Task 2: Cipher and test helpers

**Files:**
- Create: `src/db/cipher.js`
- Create: `test/helpers.js`
- Create: `test/db/cipher.test.js`
- Modify: `src/keystore.js:15` (take `ENC_PREFIX` from the cipher module)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `src/db/cipher.js`: `ENC_PREFIX = 'enc:v1:'`; `isEnvelope(value) → boolean`; `createCipher(safeStorage) → { available(): boolean, encrypt(text: string): string, decrypt(value: string): string }` (encrypt throws when unavailable or given `''`; decrypt throws on a non-envelope or an undecryptable value); `revealCached(cipher, cache: Map, cacheKey: string, value: string) → string | null` (null = locked; cached for the session).
  - `test/helpers.js`: `quietLog`, `fakeSafeStorage(state?)`, `fakeCipher({ available }?) → cipher & { state, calls: { encrypt, decrypt } }`, `encFake(text) → string` (what `fakeCipher().encrypt(text)` returns), `LOCKED_BLOB` (well-formed envelope the fake can't open), `tempDir(t) → string`, `memoryStore(t, { cipher, log }?) → Promise<store>` (needs `src/db` from Task 3).

- [ ] **Step 1: Write the failing test**

`test/db/cipher.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { createCipher, revealCached, isEnvelope, ENC_PREFIX } = require('../../src/db/cipher');
const { fakeSafeStorage, LOCKED_BLOB } = require('../helpers');

test('encrypt wraps in the enc:v1: envelope and decrypt opens it', () => {
  const cipher = createCipher(fakeSafeStorage());
  const value = cipher.encrypt('sk-secret-1');
  assert.ok(value.startsWith(ENC_PREFIX));
  assert.ok(!value.includes('sk-secret-1'));
  assert.strictEqual(cipher.decrypt(value), 'sk-secret-1');
});

test('encrypt refuses when OS encryption is unavailable (never plaintext)', () => {
  const cipher = createCipher(fakeSafeStorage({ available: false }));
  assert.strictEqual(cipher.available(), false);
  assert.throws(() => cipher.encrypt('sk-secret-1'), /unavailable/);
});

test('encrypt refuses an empty value', () => {
  const cipher = createCipher(fakeSafeStorage());
  assert.throws(() => cipher.encrypt(''), /Nothing to encrypt/);
});

test('decrypt refuses a value without the envelope', () => {
  const cipher = createCipher(fakeSafeStorage());
  assert.throws(() => cipher.decrypt('sk-plain'), /enc:v1:/);
});

test('decrypt of a value encrypted elsewhere throws', () => {
  const cipher = createCipher(fakeSafeStorage());
  assert.throws(() => cipher.decrypt(LOCKED_BLOB));
});

test('isEnvelope needs the prefix and a payload', () => {
  assert.strictEqual(isEnvelope('enc:v1:abc'), true);
  assert.strictEqual(isEnvelope('enc:v1:'), false);
  assert.strictEqual(isEnvelope('sk-abc'), false);
  assert.strictEqual(isEnvelope(null), false);
});

test('revealCached decrypts once and remembers a locked value as null', () => {
  const cipher = createCipher(fakeSafeStorage());
  let decrypts = 0;
  const counting = { ...cipher, decrypt: (v) => { decrypts += 1; return cipher.decrypt(v); } };
  const cache = new Map();
  const good = cipher.encrypt('abc');
  assert.strictEqual(revealCached(counting, cache, 'key:a', good), 'abc');
  assert.strictEqual(revealCached(counting, cache, 'key:a', good), 'abc');
  assert.strictEqual(revealCached(counting, cache, 'key:b', LOCKED_BLOB), null);
  assert.strictEqual(revealCached(counting, cache, 'key:b', LOCKED_BLOB), null);
  assert.strictEqual(decrypts, 2);
});
```

`test/helpers.js`:
```js
// Shared test helpers. Nothing here touches the real app data folder: stores
// live in memory or in a fresh temp directory, and encryption is a fake that
// needs no OS keystore.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCipher, ENC_PREFIX } = require('../src/db/cipher');

const quietLog = { info() {}, warn() {}, error() {} };

// Stands in for Electron's safeStorage. It "encrypts" by prefixing, so a value
// it did not make (LOCKED_BLOB) fails to decrypt, like DPAPI data from another
// machine or Windows user.
function fakeSafeStorage(state = { available: true }) {
  return {
    isEncryptionAvailable: () => state.available,
    encryptString: (text) => Buffer.from(`fake:${text}`, 'utf8'),
    decryptString: (buf) => {
      const s = buf.toString('utf8');
      if (!s.startsWith('fake:')) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      return s.slice('fake:'.length);
    },
  };
}

// A cipher backed by the fake, with call counters. Flip state.available to
// simulate the OS keystore going away.
function fakeCipher({ available = true } = {}) {
  const state = { available };
  const real = createCipher(fakeSafeStorage(state));
  const calls = { encrypt: 0, decrypt: 0 };
  return {
    state,
    calls,
    available: () => real.available(),
    encrypt: (text) => { calls.encrypt += 1; return real.encrypt(text); },
    decrypt: (value) => { calls.decrypt += 1; return real.decrypt(value); },
  };
}

// What fakeCipher().encrypt(text) returns, for building legacy fixtures.
const encFake = (text) => ENC_PREFIX + Buffer.from(`fake:${text}`, 'utf8').toString('base64');

// A well-formed envelope the fake can't open: a key encrypted on another machine.
const LOCKED_BLOB = ENC_PREFIX + Buffer.from('ciphertext from another machine', 'utf8').toString('base64');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-test-'));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { /* a file still open on Windows */ }
  });
  return dir;
}

// A migrated in-memory database with every repository, closed after the test.
async function memoryStore(t, { cipher = fakeCipher(), log = quietLog } = {}) {
  const database = require('../src/db');
  const store = await database.open(':memory:', { cipher, log });
  t.after(() => store.close());
  return store;
}

module.exports = { quietLog, fakeSafeStorage, fakeCipher, encFake, LOCKED_BLOB, tempDir, memoryStore };
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/db/cipher.test.js`
Expected: FAIL with `Cannot find module '../src/db/cipher'` (from `test/helpers.js`).

- [ ] **Step 3: Write `src/db/cipher.js`**

```js
// ============================================
// Secrets at rest — the enc:v1: envelope
// ============================================
// A secret is stored as 'enc:v1:' + base64(safeStorage.encryptString(text)).
// On Windows safeStorage is DPAPI: the value opens only for this Windows user
// on this machine, with the master key kept in <userData>\Local State.
//
// safeStorage is passed in rather than required, so nothing under src/db
// loads electron and the tests can use a fake.
const ENC_PREFIX = 'enc:v1:';

function isEnvelope(value) {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX) && value.length > ENC_PREFIX.length;
}

function createCipher(safeStorage) {
  const available = () => safeStorage.isEncryptionAvailable();
  return {
    available,
    // Throws rather than fall back to plaintext: a secret is never stored readable.
    encrypt(text) {
      if (typeof text !== 'string' || text === '') throw new TypeError('Nothing to encrypt');
      if (!available()) throw new Error('OS encryption is unavailable');
      return ENC_PREFIX + safeStorage.encryptString(text).toString('base64');
    },
    decrypt(value) {
      if (!isEnvelope(value)) throw new TypeError('Not an enc:v1: value');
      if (!available()) throw new Error('OS encryption is unavailable');
      return safeStorage.decryptString(Buffer.from(value.slice(ENC_PREFIX.length), 'base64'));
    },
  };
}

// Decrypts a stored value once per session. null means it can't be opened on
// this machine (a "locked" key): remembered, so it isn't retried on every read.
function revealCached(cipher, cache, cacheKey, value) {
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  let plain = null;
  try {
    plain = cipher.decrypt(value);
  } catch (_) {
    plain = null;
  }
  cache.set(cacheKey, plain);
  return plain;
}

module.exports = { ENC_PREFIX, isEnvelope, createCipher, revealCached };
```

- [ ] **Step 4: Point `src/keystore.js` at the shared prefix**

In `src/keystore.js` replace:
```js
const ENC_PREFIX = 'enc:v1:';
```
with:
```js
// The envelope is owned by src/db/cipher.js now; this file only serves
// scripts/keystore-check.js.
const { ENC_PREFIX } = require('./db/cipher');
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- test/db/cipher.test.js`
Expected: `pass 7`, `fail 0`.

Run: `npm run check:keystore`
Expected: last line `ALL CHECKS PASSED` (real safeStorage, throwaway values, no data folder touched).

- [ ] **Step 6: Commit**

```bash
git add src/db/cipher.js src/keystore.js test/helpers.js test/db/cipher.test.js
git commit -m "feat(db): enc:v1 cipher with injected safeStorage, test helpers"
```

---

### Task 3: Database core — open, pragmas, migrations, meta

**Files:**
- Create: `src/db/migrations.js`
- Create: `src/db/index.js`
- Test: `test/db/open.test.js`

**Interfaces:**
- Consumes: nothing at runtime (the cipher is only passed through).
- Produces (`src/db/index.js`):
  - `open(dir: string | ':memory:', { cipher, log, migrations }?) → Promise<{ db, file, migration: { from, to, backup: string|null }, repos, close() }>` — throws on any failure; `err.code === 'DB_TOO_NEW'` for a newer schema.
  - `migrate(db, { file, migrations, log }) → Promise<{ from, to, backup }>`, `applyPragmas(db)`, `close(db)`, `getMeta(db, key) → string|null`, `setMeta(db, key, value)`.
  - `DB_FILE = 'venom.db'`, `MIGRATIONS`, `DbTooNewError`.
  - `repos.meta.get(key)`, `repos.meta.set(key, value)`. Later tasks add `repos.cache`, `repos.settings`, `repos.secrets`, `repos.providers`, `repos.catalog`, `repos.history` by replacing `createRepos`.
  - Schema v1 exactly as spec §1, plus `meta.install_id` (random UUID) written by the migration.

- [ ] **Step 1: Write the failing test**

`test/db/open.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const database = require('../../src/db');
const { fakeCipher, quietLog, tempDir, memoryStore } = require('../helpers');

const opts = () => ({ cipher: fakeCipher(), log: quietLog });

test('schema v1: user_version, every table, install_id', async (t) => {
  const store = await memoryStore(t);
  assert.strictEqual(store.db.pragma('user_version', { simple: true }), 1);
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  assert.deepStrictEqual(tables, [
    'catalog_meta', 'key_model_counts', 'meta', 'model_keys', 'models', 'provider_keys',
    'provider_sync', 'providers', 'secrets', 'settings', 'test_results', 'test_runs',
  ]);
  assert.match(store.repos.meta.get('install_id'), /^[0-9a-f-]{36}$/);
});

test('pragmas on a file: WAL, NORMAL, foreign keys, busy timeout, temp store', async (t) => {
  const dir = tempDir(t);
  const store = await database.open(dir, opts());
  try {
    assert.strictEqual(store.db.pragma('journal_mode', { simple: true }), 'wal');
    assert.strictEqual(store.db.pragma('synchronous', { simple: true }), 1); // NORMAL
    assert.strictEqual(store.db.pragma('foreign_keys', { simple: true }), 1);
    assert.strictEqual(store.db.pragma('busy_timeout', { simple: true }), 5000);
    assert.strictEqual(store.db.pragma('temp_store', { simple: true }), 2); // MEMORY
    assert.strictEqual(store.file, path.join(dir, 'venom.db'));
    assert.ok(fs.existsSync(store.file));
  } finally {
    store.close();
  }
});

test(':memory: reports journal_mode memory', async (t) => {
  const store = await memoryStore(t);
  assert.strictEqual(store.db.pragma('journal_mode', { simple: true }), 'memory');
});

test('reopening an up-to-date file runs nothing and makes no backup', async (t) => {
  const dir = tempDir(t);
  (await database.open(dir, opts())).close();
  const store = await database.open(dir, opts());
  try {
    assert.deepStrictEqual(store.migration, { from: 1, to: 1, backup: null });
    assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.includes('.bak-v')), []);
  } finally {
    store.close();
  }
});

test('a pending migration backs up first, then runs and bumps user_version', async (t) => {
  const dir = tempDir(t);
  (await database.open(dir, opts())).close();
  const withV2 = [...database.MIGRATIONS, { version: 2, up(db) { db.exec('CREATE TABLE extra_v2 (x INTEGER)'); } }];
  const store = await database.open(dir, { ...opts(), migrations: withV2 });
  try {
    assert.strictEqual(store.migration.from, 1);
    assert.strictEqual(store.migration.to, 2);
    assert.strictEqual(store.migration.backup, path.join(dir, 'venom.db.bak-v1'));
    assert.ok(fs.existsSync(store.migration.backup));
    assert.strictEqual(store.db.pragma('user_version', { simple: true }), 2);
  } finally {
    store.close();
  }
});

test('a migration that throws rolls back and leaves the version', async (t) => {
  const dir = tempDir(t);
  (await database.open(dir, opts())).close();
  const broken = [...database.MIGRATIONS, {
    version: 2,
    up(db) { db.exec('CREATE TABLE half_done (x INTEGER)'); throw new Error('migration bug'); },
  }];
  await assert.rejects(database.open(dir, { ...opts(), migrations: broken }), /migration bug/);
  const store = await database.open(dir, opts());
  try {
    assert.strictEqual(store.db.pragma('user_version', { simple: true }), 1);
    assert.strictEqual(store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'half_done'").get().n, 0);
  } finally {
    store.close();
  }
});

test('keeps only the three newest backups', async (t) => {
  const dir = tempDir(t);
  (await database.open(dir, opts())).close();
  const steps = [...database.MIGRATIONS];
  for (let v = 2; v <= 5; v += 1) {
    steps.push({ version: v, up(db) { db.exec(`CREATE TABLE step_${v} (x INTEGER)`); } });
    (await database.open(dir, { ...opts(), migrations: [...steps] })).close();
  }
  const backups = fs.readdirSync(dir).filter((n) => n.startsWith('venom.db.bak-v')).sort();
  assert.deepStrictEqual(backups, ['venom.db.bak-v2', 'venom.db.bak-v3', 'venom.db.bak-v4']);
});

test('downgrade guard: a newer schema is refused and the file is not written', async (t) => {
  const dir = tempDir(t);
  const first = await database.open(dir, opts());
  first.db.pragma('user_version = 9');
  first.close();
  const file = path.join(dir, 'venom.db');
  const before = fs.readFileSync(file);
  await assert.rejects(database.open(dir, opts()), (err) => err.code === 'DB_TOO_NEW');
  assert.strictEqual(Buffer.compare(before, fs.readFileSync(file)), 0);
});

test('a corrupt file is refused and left as it was', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'venom.db');
  const garbage = Buffer.alloc(4096, 0x41);
  fs.writeFileSync(file, garbage);
  await assert.rejects(database.open(dir, opts()));
  assert.strictEqual(Buffer.compare(garbage, fs.readFileSync(file)), 0);
});

test('meta get/set round-trips strings and returns null when unset', async (t) => {
  const store = await memoryStore(t);
  assert.strictEqual(store.repos.meta.get('imported_from_json_at'), null);
  store.repos.meta.set('imported_from_json_at', 1727000000000);
  assert.strictEqual(store.repos.meta.get('imported_from_json_at'), '1727000000000');
  store.repos.meta.set('imported_from_json_at', 'none');
  assert.strictEqual(store.repos.meta.get('imported_from_json_at'), 'none');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/db/open.test.js`
Expected: FAIL with `Cannot find module '../../src/db'`.

- [ ] **Step 3: Write `src/db/migrations.js`**

```js
// ============================================
// Schema migrations
// ============================================
// Ordered and forward only. Kept as SQL strings inside a JS module (not .sql
// files) so electron-builder's `files: ["src/**/*"]` ships them with no extra
// config. A new version appends an entry; an entry that has shipped is never
// edited.
const crypto = require('crypto');

module.exports = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE secrets (
          name TEXT PRIMARY KEY,
          cipher TEXT NOT NULL CHECK (cipher LIKE 'enc:v1:_%'),
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE providers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          base_url TEXT NOT NULL,
          rpm INTEGER,
          is_custom INTEGER NOT NULL DEFAULT 0,
          position INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        -- A key row holds ciphertext only: never plaintext, never ''.
        CREATE TABLE provider_keys (
          id TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          cipher TEXT NOT NULL CHECK (cipher LIKE 'enc:v1:_%'),
          active INTEGER NOT NULL DEFAULT 1,
          position INTEGER NOT NULL DEFAULT 0,
          quota_spent_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX provider_keys_by_provider ON provider_keys(provider_id, position);

        -- Catalogue and history rows keep the ids of deleted providers and
        -- keys on purpose, so they carry no foreign keys to either.
        CREATE TABLE models (
          provider_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          name TEXT,
          kind TEXT,
          first_seen INTEGER,
          last_seen INTEGER,
          removed_at INTEGER,
          is_new INTEGER NOT NULL DEFAULT 0,
          summary_json TEXT,
          bench_json TEXT,
          history_json TEXT,
          bench_error TEXT,
          caps_json TEXT,
          caps_error TEXT,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (provider_id, model_id)
        );
        CREATE INDEX models_by_provider ON models(provider_id, removed_at);

        CREATE TABLE model_keys (
          provider_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          key_id TEXT NOT NULL,
          PRIMARY KEY (provider_id, model_id, key_id),
          FOREIGN KEY (provider_id, model_id) REFERENCES models(provider_id, model_id) ON DELETE CASCADE
        );

        CREATE TABLE provider_sync (
          provider_id TEXT PRIMARY KEY,
          last_sync_at INTEGER NOT NULL
        );

        CREATE TABLE key_model_counts (
          key_id TEXT PRIMARY KEY,
          count INTEGER NOT NULL,
          at INTEGER NOT NULL
        );

        CREATE TABLE catalog_meta (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL
        );

        CREATE TABLE test_runs (
          id INTEGER PRIMARY KEY,
          run_uid TEXT NOT NULL UNIQUE,
          at INTEGER NOT NULL,
          provider_id TEXT NOT NULL,
          provider_name TEXT NOT NULL,
          prompt TEXT NOT NULL
        );
        CREATE INDEX test_runs_by_at ON test_runs(at);
        CREATE INDEX test_runs_by_provider ON test_runs(provider_id, id);

        CREATE TABLE test_results (
          id INTEGER PRIMARY KEY,
          run_id INTEGER NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
          model_id TEXT NOT NULL,
          status TEXT NOT NULL,
          time_ms INTEGER,
          tokens INTEGER,
          completion_tokens INTEGER,
          attempts INTEGER NOT NULL DEFAULT 1,
          correct INTEGER
        );
        CREATE INDEX test_results_by_run ON test_results(run_id);
        CREATE INDEX test_results_by_model ON test_results(model_id);
      `);
      // Identifies this install to a future sync server. Never changes.
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('install_id', crypto.randomUUID());
    },
  },
];
```

- [ ] **Step 4: Write `src/db/index.js`**

```js
// ============================================
// Local database — venom.db
// ============================================
// One SQLite file in the app data folder, opened once by the main process;
// the renderer never touches it. better-sqlite3 is synchronous, so every call
// runs on the main thread: statements stay small and each write is one short
// transaction.
//
// Nothing here loads electron. Encryption comes in as a cipher object
// (src/db/cipher.js builds the real one from safeStorage), so the whole layer
// runs under plain Node in the tests.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const MIGRATIONS = require('./migrations');

const DB_FILE = 'venom.db';
const BACKUPS_KEPT = 3;

class DbTooNewError extends Error {
  constructor(found, known) {
    super(`venom.db is at schema version ${found}; this build knows up to ${known}`);
    this.name = 'DbTooNewError';
    this.code = 'DB_TOO_NEW';
  }
}

// busy_timeout first, so the pragmas after it wait out a lock instead of
// failing. WAL with synchronous=NORMAL can lose the last commits on power loss
// but never corrupts the file.
function applyPragmas(db) {
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');
}

function latestVersion(migrations) {
  return migrations.reduce((max, m) => Math.max(max, m.version), 0);
}

// A copy of the file as it was before migrating, so a migration bug can be
// undone by hand. Only the newest BACKUPS_KEPT are kept.
async function backupBeforeMigrate(db, file, from, log) {
  const dest = `${file}.bak-v${from}`;
  await db.backup(dest);
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.bak-v`;
  fs.readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
    .map((name) => ({ name, version: Number(name.slice(prefix.length)) }))
    .sort((a, b) => b.version - a.version)
    .slice(BACKUPS_KEPT)
    .forEach(({ name }) => {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch (err) {
        log.warn(`Could not remove old backup ${name}:`, err.message);
      }
    });
  return dest;
}

// PRAGMA user_version is the schema version. Each pending migration runs in
// its own transaction together with the version bump, so a failure leaves the
// file at the last version that fully applied.
async function migrate(db, { file = null, migrations = MIGRATIONS, log = console } = {}) {
  const from = db.pragma('user_version', { simple: true });
  const to = latestVersion(migrations);
  if (from > to) throw new DbTooNewError(from, to);
  if (from === to) return { from, to, backup: null };
  const backup = from > 0 && file ? await backupBeforeMigrate(db, file, from, log) : null;
  migrations
    .filter((m) => m.version > from)
    .sort((a, b) => a.version - b.version)
    .forEach((m) => {
      db.transaction(() => {
        m.up(db);
        db.pragma(`user_version = ${m.version}`);
      })();
    });
  return { from, to, backup };
}

function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function createRepos(db, cipher, log) {
  return {
    meta: { get: (key) => getMeta(db, key), set: (key, value) => setMeta(db, key, value) },
  };
}

// Folds the WAL back into the main file, so a closed database is one file.
function close(db) {
  if (!db.open) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (_) {
    // Already failing: close anyway.
  }
  db.close();
}

// dir is the app data folder, or ':memory:' in tests. Throws on any failure
// (corrupt or locked file, newer schema); the caller shows it and quits.
async function open(dir, { cipher = null, log = console, migrations = MIGRATIONS } = {}) {
  const file = dir === ':memory:' ? ':memory:' : path.join(dir, DB_FILE);
  const db = new Database(file);
  try {
    applyPragmas(db);
    const migration = await migrate(db, { file: file === ':memory:' ? null : file, migrations, log });
    return { db, file, migration, repos: createRepos(db, cipher, log), close: () => close(db) };
  } catch (err) {
    try {
      db.close();
    } catch (_) {
      // Already unusable.
    }
    throw err;
  }
}

module.exports = { open, migrate, applyPragmas, close, getMeta, setMeta, DB_FILE, MIGRATIONS, DbTooNewError };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- test/db/open.test.js`
Expected: `pass 10`, `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations.js src/db/index.js test/db/open.test.js
git commit -m "feat(db): open venom.db with pragmas, versioned migrations, backups and downgrade guard"
```

### Task 4: Settings and secrets repositories

**Files:**
- Create: `src/db/repos/settings.js`
- Create: `src/db/repos/secrets.js`
- Modify: `src/db/index.js` (requires + `createRepos`)
- Test: `test/db/settings-secrets.test.js`

**Interfaces:**
- Consumes: `revealCached`, `isEnvelope` from `src/db/cipher.js`; `open()` from Task 3.
- Produces:
  - `repos.cache: Map` — shared session cache of decrypted secrets (`'key:<id>'`, `'secret:<name>'`; `null` = locked).
  - `repos.settings`: `get(key) → any|null`, `set(key, value)`, `saveSettings(obj) → merged` (merge into row `settings`, `aaApiKey` stripped), `saveTest(obj)` (row `test`).
  - `repos.secrets`: `has(name) → boolean`, `getCipher(name) → string|null`, `save(name, value) → boolean` (`''` deletes; returns whether one is stored), `setCipher(name, envelope)` (import only), `reveal(name) → string|null`.
  - `SECRET_ORIGINS = { aaApiKey: 'https://artificialanalysis.ai' }` exported from `src/db/repos/secrets.js`.

- [ ] **Step 1: Write the failing test**

`test/db/settings-secrets.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { memoryStore, fakeCipher, encFake, LOCKED_BLOB } = require('../helpers');

test('settings rows round-trip JS types exactly', async (t) => {
  const { repos } = await memoryStore(t);
  const value = { timeGoodMs: 10000, hedgeEnabled: false, theme: 'vercel', nothing: null, list: [1, 'a'] };
  repos.settings.set('settings', value);
  assert.deepStrictEqual(repos.settings.get('settings'), value);
  assert.strictEqual(repos.settings.get('window'), null);
});

test('saveSettings strips aaApiKey and keeps fields the renderer does not know', async (t) => {
  const store = await memoryStore(t);
  store.repos.settings.set('settings', { theme: 'vercel', mediaPrompt: 'legacy prompt', futureField: 42 });
  store.repos.settings.saveSettings({ theme: 'daylight', historyMaxRuns: 50, aaApiKey: 'aa-secret-value' });
  assert.deepStrictEqual(store.repos.settings.get('settings'), {
    theme: 'daylight', mediaPrompt: 'legacy prompt', futureField: 42, historyMaxRuns: 50,
  });
  const raw = store.db.prepare("SELECT value_json FROM settings WHERE key = 'settings'").get().value_json;
  assert.ok(!raw.includes('aa-secret-value'));
});

test('saveSettings rejects anything but an object', async (t) => {
  const { repos } = await memoryStore(t);
  [null, 'x', [1]].forEach((v) => assert.throws(() => repos.settings.saveSettings(v), /must be an object/));
});

test('saveTest stores the test row as given', async (t) => {
  const { repos } = await memoryStore(t);
  repos.settings.saveTest({ prompt: 'What is 2+2?', expected: '', autoMinutes: 15 });
  assert.deepStrictEqual(repos.settings.get('test'), { prompt: 'What is 2+2?', expected: '', autoMinutes: 15 });
  assert.throws(() => repos.settings.saveTest(null), /must be an object/);
});

test('secrets: save encrypts, reveal decrypts, the row never holds the plaintext', async (t) => {
  const store = await memoryStore(t);
  assert.strictEqual(store.repos.secrets.save('aaApiKey', '  aa-secret-1  '), true);
  const raw = store.db.prepare("SELECT cipher FROM secrets WHERE name = 'aaApiKey'").get().cipher;
  assert.ok(raw.startsWith('enc:v1:'));
  assert.ok(!raw.includes('aa-secret-1'));
  assert.strictEqual(store.repos.secrets.reveal('aaApiKey'), 'aa-secret-1');
  assert.strictEqual(store.repos.secrets.has('aaApiKey'), true);
});

test("secrets: saving '' deletes", async (t) => {
  const { repos } = await memoryStore(t);
  repos.secrets.save('aaApiKey', 'aa-secret-1');
  assert.strictEqual(repos.secrets.save('aaApiKey', ''), false);
  assert.strictEqual(repos.secrets.has('aaApiKey'), false);
  assert.strictEqual(repos.secrets.reveal('aaApiKey'), null);
});

test('secrets: unknown names are refused', async (t) => {
  const { repos } = await memoryStore(t);
  assert.throws(() => repos.secrets.save('githubToken', 'x'), /Unknown secret/);
});

test('secrets: with OS encryption unavailable nothing is stored', async (t) => {
  const store = await memoryStore(t, { cipher: fakeCipher({ available: false }) });
  assert.throws(() => store.repos.secrets.save('aaApiKey', 'aa-secret'), /unavailable/);
  assert.strictEqual(store.repos.secrets.has('aaApiKey'), false);
});

test('secrets: setCipher copies an envelope verbatim and refuses anything else', async (t) => {
  const { repos } = await memoryStore(t);
  repos.secrets.setCipher('aaApiKey', encFake('aa-x'));
  assert.strictEqual(repos.secrets.getCipher('aaApiKey'), encFake('aa-x'));
  assert.strictEqual(repos.secrets.reveal('aaApiKey'), 'aa-x');
  assert.throws(() => repos.secrets.setCipher('aaApiKey', 'aa-plain'), /enc:v1:/);
});

test('secrets: a value encrypted elsewhere reveals as null (locked)', async (t) => {
  const { repos } = await memoryStore(t);
  repos.secrets.setCipher('aaApiKey', LOCKED_BLOB);
  assert.strictEqual(repos.secrets.has('aaApiKey'), true);
  assert.strictEqual(repos.secrets.reveal('aaApiKey'), null);
});

test('secrets: replacing a secret drops the cached plaintext', async (t) => {
  const { repos } = await memoryStore(t);
  repos.secrets.save('aaApiKey', 'aa-first');
  assert.strictEqual(repos.secrets.reveal('aaApiKey'), 'aa-first');
  repos.secrets.save('aaApiKey', 'aa-second');
  assert.strictEqual(repos.secrets.reveal('aaApiKey'), 'aa-second');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/db/settings-secrets.test.js`
Expected: FAIL — `TypeError: Cannot read properties of undefined (reading 'set')` (no `repos.settings` yet).

- [ ] **Step 3: Write `src/db/repos/settings.js`**

```js
// ============================================
// Settings rows — settings, test, window
// ============================================
// One JSON value per row. JSON keeps number, string and boolean apart, so a
// value reads back with the type it was saved with (loadSettings ignores a
// value whose type differs from the default).
function createSettingsRepo(db) {
  const q = {
    get: db.prepare('SELECT value_json FROM settings WHERE key = ?'),
    set: db.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`),
  };

  function get(key) {
    const row = q.get.get(key);
    return row ? JSON.parse(row.value_json) : null;
  }

  function set(key, value) {
    if (value === undefined) throw new TypeError(`Setting "${key}" has no value`);
    q.set.run(key, JSON.stringify(value), Date.now());
  }

  // save-settings. Merged into the stored row, so fields this build doesn't
  // know (legacy mediaPrompt, fields a newer build added) survive the first
  // save. aaApiKey is a secret (secrets table) and never lands here.
  const saveSettings = db.transaction((incoming) => {
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new TypeError('Settings must be an object');
    const merged = { ...(get('settings') || {}), ...incoming };
    delete merged.aaApiKey;
    set('settings', merged);
    return merged;
  });

  // save-test-definition: { prompt, expected, autoMinutes }.
  function saveTest(test) {
    if (!test || typeof test !== 'object' || Array.isArray(test)) throw new TypeError('The test definition must be an object');
    set('test', test);
  }

  return { get, set, saveSettings, saveTest };
}

module.exports = { createSettingsRepo };
```

- [ ] **Step 4: Write `src/db/repos/secrets.js`**

```js
// ============================================
// Named secrets — the Artificial Analysis key
// ============================================
// Stored in the enc:v1: envelope like provider keys. Each name has the one
// origin it may be sent to (src/db/keys.js enforces it).
const { isEnvelope, revealCached } = require('../cipher');

const SECRET_ORIGINS = { aaApiKey: 'https://artificialanalysis.ai' };

function createSecretsRepo(db, cipher, cache) {
  const q = {
    get: db.prepare('SELECT cipher FROM secrets WHERE name = ?'),
    set: db.prepare(`INSERT INTO secrets (name, cipher, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET cipher = excluded.cipher, updated_at = excluded.updated_at`),
    remove: db.prepare('DELETE FROM secrets WHERE name = ?'),
  };
  const cacheKey = (name) => `secret:${name}`;

  function known(name) {
    if (!Object.prototype.hasOwnProperty.call(SECRET_ORIGINS, name)) throw new Error(`Unknown secret "${name}"`);
  }

  function getCipher(name) {
    const row = q.get.get(name);
    return row ? row.cipher : null;
  }

  function has(name) {
    return getCipher(name) !== null;
  }

  // save-secret: '' deletes. Encryption failing (OS keystore unavailable)
  // throws, so a secret is never stored readable. Returns whether one is stored.
  function save(name, value) {
    known(name);
    const text = typeof value === 'string' ? value.trim() : '';
    cache.delete(cacheKey(name));
    if (!text) {
      q.remove.run(name);
      return false;
    }
    q.set.run(name, cipher.encrypt(text), Date.now());
    return true;
  }

  // Import only: an existing envelope is copied as is, never re-encrypted.
  function setCipher(name, value) {
    known(name);
    if (!isEnvelope(value)) throw new TypeError(`Secret "${name}" must be an enc:v1: value`);
    cache.delete(cacheKey(name));
    q.set.run(name, value, Date.now());
  }

  // Plaintext for main-process use only (request signing), or null when unset
  // or not readable on this machine.
  function reveal(name) {
    const value = getCipher(name);
    return value === null ? null : revealCached(cipher, cache, cacheKey(name), value);
  }

  return { has, getCipher, save, setCipher, reveal };
}

module.exports = { createSecretsRepo, SECRET_ORIGINS };
```

- [ ] **Step 5: Wire them into `src/db/index.js`**

Replace:
```js
const MIGRATIONS = require('./migrations');
```
with:
```js
const MIGRATIONS = require('./migrations');
const { createSettingsRepo } = require('./repos/settings');
const { createSecretsRepo } = require('./repos/secrets');
```

Replace:
```js
function createRepos(db, cipher, log) {
  return {
    meta: { get: (key) => getMeta(db, key), set: (key, value) => setMeta(db, key, value) },
  };
}
```
with:
```js
function createRepos(db, cipher, log) {
  // Decrypted secrets for this session, keyed 'key:<id>' / 'secret:<name>'.
  // null marks a value this machine can't open. Entries are dropped when a
  // secret is replaced or deleted.
  const cache = new Map();
  return {
    cache,
    meta: { get: (key) => getMeta(db, key), set: (key, value) => setMeta(db, key, value) },
    settings: createSettingsRepo(db),
    secrets: createSecretsRepo(db, cipher, cache),
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- test/db/settings-secrets.test.js test/db/open.test.js`
Expected: `pass 21`, `fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/db/repos/settings.js src/db/repos/secrets.js src/db/index.js test/db/settings-secrets.test.js
git commit -m "feat(db): settings rows and encrypted named secrets"
```

---

### Task 5: Providers repository — keys, save semantics, merge, delete

**Files:**
- Create: `src/db/repos/providers.js`
- Modify: `src/db/index.js` (require + `createRepos`)
- Test: `test/db/providers.test.js`

**Interfaces:**
- Consumes: `ENC_PREFIX`, `revealCached` (Task 2); `repos.cache` (Task 4).
- Produces `repos.providers`:
  - `list() → { [id]: { name, baseUrl, rpm, keys: Key[], custom?: true } }` in position order, where `Key = { id, name, key: 'venomkey:<id>' | '', hint, active: boolean, locked: boolean, quotaSpent? }`.
  - `get(id) → provider | null` (same shape).
  - `save({ id, name, baseUrl, rpm, custom?, keys: [{ id, name, key, active, quotaSpent }] }) → provider` — one transaction; semantics in spec §4.
  - `merge(fromId, intoId) → provider` (the target), `remove(id) → boolean`.
  - `keyRecord(id) → { id, name, providerId, baseUrl } | null`, `revealKey(id) → string | null` (main-side only).
  - `importProvider({ id, name, baseUrl, rpm, custom, position, keys: [{ id, name, cipher, active, quotaSpent }] })` — raw insert for the importer.
  - `maskKey(key) → string` exported from the module.

- [ ] **Step 1: Write the failing test**

`test/db/providers.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { memoryStore, fakeCipher, encFake, LOCKED_BLOB } = require('../helpers');
const { maskKey } = require('../../src/db/repos/providers');

const NARA = 'https://router.bynara.id/v1';
const nara = (keys, extra = {}) => ({ id: 'nara', name: 'NaraRouter', baseUrl: NARA, rpm: null, keys, ...extra });
const cipherOf = (store, id) => store.db.prepare('SELECT cipher FROM provider_keys WHERE id = ?').get(id).cipher;
const OTHER_LOCKED = `enc:v1:${Buffer.from('ciphertext from a second machine').toString('base64')}`;

test('a typed key is stored encrypted and read back as a placeholder with a hint', async (t) => {
  const store = await memoryStore(t);
  const saved = store.repos.providers.save(nara([{ id: 'key_1', name: 'Main', key: 'sk-nara-secret-0001', active: true }]));
  const raw = cipherOf(store, 'key_1');
  assert.ok(raw.startsWith('enc:v1:') && !raw.includes('sk-nara-secret-0001'));
  assert.deepStrictEqual(saved, {
    name: 'NaraRouter', baseUrl: NARA, rpm: null,
    keys: [{ id: 'key_1', name: 'Main', key: 'venomkey:key_1', hint: 'sk-nara-se********0001', active: true, locked: false }],
  });
  assert.strictEqual(store.repos.providers.revealKey('key_1'), 'sk-nara-secret-0001');
  assert.deepStrictEqual(Object.keys(store.repos.providers.list()), ['nara']);
});

test("maskKey is today's mask", () => {
  assert.strictEqual(maskKey(''), '');
  assert.strictEqual(maskKey('sk-short-1'), 'sk-sho********rt-1');
  assert.strictEqual(maskKey('sk-nara-secret-0001'), 'sk-nara-se********0001');
});

test('the placeholder of the same key keeps the stored cipher', async (t) => {
  const cipher = fakeCipher();
  const store = await memoryStore(t, { cipher });
  store.repos.providers.save(nara([{ id: 'key_1', name: 'Main', key: 'sk-1', active: true }]));
  const before = cipherOf(store, 'key_1');
  const encrypts = cipher.calls.encrypt;
  store.repos.providers.save(nara([{ id: 'key_1', name: 'Renamed', key: 'venomkey:key_1', active: false }]));
  assert.strictEqual(cipherOf(store, 'key_1'), before);
  assert.strictEqual(cipher.calls.encrypt, encrypts);
  const k = store.repos.providers.get('nara').keys[0];
  assert.strictEqual(k.name, 'Renamed');
  assert.strictEqual(k.active, false);
});

test("a locked key sent back as '' keeps its ciphertext, save after save", async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.importProvider({
    id: 'nara', name: 'NaraRouter', baseUrl: NARA, rpm: null, custom: false, position: 0,
    keys: [{ id: 'key_1', name: 'Other PC', cipher: LOCKED_BLOB, active: true, quotaSpent: null }],
  });
  for (let i = 0; i < 3; i += 1) {
    const current = store.repos.providers.get('nara');
    assert.deepStrictEqual(current.keys[0], { id: 'key_1', name: 'Other PC', key: '', hint: '', active: true, locked: true });
    store.repos.providers.save({ id: 'nara', name: current.name, baseUrl: current.baseUrl, rpm: current.rpm, keys: current.keys });
    assert.strictEqual(cipherOf(store, 'key_1'), LOCKED_BLOB);
  }
});

test("'' for a key that doesn't exist yet fails and writes nothing", async (t) => {
  const store = await memoryStore(t);
  assert.throws(() => store.repos.providers.save(nara([{ id: 'key_1', name: 'Empty', key: '', active: true }])), /has no value/);
  assert.strictEqual(store.repos.providers.get('nara'), null);
});

test('a new value replaces the secret and the next read sees it', async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.save(nara([{ id: 'key_1', name: 'Main', key: 'sk-old-value-1', active: true }]));
  assert.strictEqual(store.repos.providers.revealKey('key_1'), 'sk-old-value-1');
  store.repos.providers.save(nara([{ id: 'key_1', name: 'Main', key: 'sk-new-value-2', active: true }]));
  assert.strictEqual(store.repos.providers.revealKey('key_1'), 'sk-new-value-2');
});

test('sending the same plaintext back keeps the stored cipher', async (t) => {
  const cipher = fakeCipher();
  const store = await memoryStore(t, { cipher });
  store.repos.providers.save(nara([{ id: 'key_1', name: 'Main', key: 'sk-same', active: true }]));
  const before = cipherOf(store, 'key_1');
  const encrypts = cipher.calls.encrypt;
  store.repos.providers.save(nara([{ id: 'key_1', name: 'Main', key: 'sk-same', active: true }]));
  assert.strictEqual(cipherOf(store, 'key_1'), before);
  assert.strictEqual(cipher.calls.encrypt, encrypts);
});

test('keys missing from the payload are deleted', async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.save(nara([
    { id: 'key_1', name: 'One', key: 'sk-1', active: true },
    { id: 'key_2', name: 'Two', key: 'sk-2', active: true },
  ]));
  store.repos.providers.save(nara([{ id: 'key_2', name: 'Two', key: 'venomkey:key_2', active: true }]));
  assert.deepStrictEqual(store.repos.providers.get('nara').keys.map((k) => k.id), ['key_2']);
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM provider_keys').get().n, 1);
  assert.strictEqual(store.repos.providers.revealKey('key_1'), null);
});

test("a placeholder of another provider's key fails and changes nothing", async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.save(nara([{ id: 'key_1', name: 'Nara', key: 'sk-nara-1', active: true }]));
  const dark = (name, keys) => ({ id: 'darkapi', name, baseUrl: 'https://darkapi.dev/v1', rpm: null, keys });
  store.repos.providers.save(dark('Dark API', [{ id: 'key_2', name: 'Dark', key: 'sk-dark-2', active: true }]));
  assert.throws(() => store.repos.providers.save(dark('Dark API renamed', [
    { id: 'key_2', name: 'Dark', key: 'venomkey:key_2', active: true },
    { id: 'key_3', name: 'Stolen', key: 'venomkey:key_1', active: true },
  ])), /belongs to another provider/);
  assert.strictEqual(store.repos.providers.get('darkapi').name, 'Dark API');
  assert.deepStrictEqual(store.repos.providers.get('darkapi').keys.map((k) => k.id), ['key_2']);
});

test('a key id that another provider owns is refused', async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.save(nara([{ id: 'key_1', name: 'Nara', key: 'sk-nara-1', active: true }]));
  assert.throws(() => store.repos.providers.save({
    id: 'darkapi', name: 'Dark API', baseUrl: 'https://darkapi.dev/v1', rpm: null,
    keys: [{ id: 'key_1', name: 'Clash', key: 'sk-other', active: true }],
  }), /belongs to another provider/);
  assert.strictEqual(store.repos.providers.revealKey('key_1'), 'sk-nara-1');
});

test('an unknown placeholder, a secret placeholder or a ciphertext is refused as a value', async (t) => {
  const store = await memoryStore(t);
  const attempt = (key) => () => store.repos.providers.save(nara([{ id: 'key_1', name: 'Bad', key, active: true }]));
  assert.throws(attempt('venomkey:nope'), /doesn't exist/);
  assert.throws(attempt('venomsecret:aaApiKey'), /not a usable key value/);
  assert.throws(attempt(encFake('x')), /not a usable key value/);
});

test('created_at survives updates and position follows payload order', async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.save(nara([
    { id: 'key_1', name: 'One', key: 'sk-1', active: true },
    { id: 'key_2', name: 'Two', key: 'sk-2', active: true },
  ]));
  const createdAt = (id) => store.db.prepare('SELECT created_at FROM provider_keys WHERE id = ?').get(id).created_at;
  const first = createdAt('key_1');
  await new Promise((r) => setTimeout(r, 5));
  store.repos.providers.save(nara([
    { id: 'key_2', name: 'Two', key: 'venomkey:key_2', active: true },
    { id: 'key_1', name: 'One', key: 'venomkey:key_1', active: true },
  ]));
  assert.deepStrictEqual(store.repos.providers.get('nara').keys.map((k) => k.id), ['key_2', 'key_1']);
  assert.strictEqual(createdAt('key_1'), first);
  const positions = store.db.prepare('SELECT id, position FROM provider_keys ORDER BY id').all();
  assert.deepStrictEqual(positions, [{ id: 'key_1', position: 1 }, { id: 'key_2', position: 0 }]);
});

test('is_custom is kept when the payload leaves it out', async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.save({ ...nara([]), id: 'old_custom', custom: true });
  assert.strictEqual(store.repos.providers.get('old_custom').custom, true);
  store.repos.providers.save({ ...nara([]), id: 'old_custom' });
  assert.strictEqual(store.repos.providers.get('old_custom').custom, true);
  store.repos.providers.save({ ...nara([]), id: 'old_custom', custom: false });
  assert.strictEqual('custom' in store.repos.providers.get('old_custom'), false);
});

test('with OS encryption unavailable a typed key is refused and nothing is stored', async (t) => {
  const store = await memoryStore(t, { cipher: fakeCipher({ available: false }) });
  assert.throws(() => store.repos.providers.save(nara([{ id: 'key_1', name: 'Main', key: 'sk-1', active: true }])), /unavailable/);
  assert.strictEqual(store.repos.providers.get('nara'), null);
});

test('merge moves keys, drops duplicates by value and deletes the source', async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.save(nara([{ id: 'key_1', name: 'Main', key: 'sk-shared', active: true }]));
  store.repos.providers.save({
    id: 'custom_1', name: 'Old custom', baseUrl: `${NARA}/`, rpm: null, custom: true,
    keys: [
      { id: 'key_2', name: 'Dup', key: 'sk-shared', active: true },
      { id: 'key_3', name: 'Only here', key: 'sk-only-custom', active: false },
    ],
  });
  const merged = store.repos.providers.merge('custom_1', 'nara');
  assert.deepStrictEqual(merged.keys.map((k) => [k.id, k.active]), [['key_1', true], ['key_3', false]]);
  assert.strictEqual(store.repos.providers.get('custom_1'), null);
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM provider_keys').get().n, 2);
  assert.strictEqual(store.repos.providers.revealKey('key_3'), 'sk-only-custom');
});

test('merge dedupes locked keys by ciphertext', async (t) => {
  const store = await memoryStore(t);
  const add = (id, keys) => store.repos.providers.importProvider({ id, name: id, baseUrl: NARA, rpm: null, custom: id !== 'nara', position: 0, keys });
  add('nara', [{ id: 'key_1', name: 'Locked A', cipher: LOCKED_BLOB, active: true, quotaSpent: null }]);
  add('custom_1', [
    { id: 'key_2', name: 'Locked A again', cipher: LOCKED_BLOB, active: true, quotaSpent: null },
    { id: 'key_3', name: 'Locked B', cipher: OTHER_LOCKED, active: true, quotaSpent: null },
  ]);
  const merged = store.repos.providers.merge('custom_1', 'nara');
  assert.deepStrictEqual(merged.keys.map((k) => k.id), ['key_1', 'key_3']);
  assert.strictEqual(cipherOf(store, 'key_3'), OTHER_LOCKED);
});

test('merge refuses a missing provider or itself', async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.save(nara([]));
  assert.throws(() => store.repos.providers.merge('nara', 'nara'), /itself/);
  assert.throws(() => store.repos.providers.merge('ghost', 'nara'), /not found/);
  assert.throws(() => store.repos.providers.merge('nara', 'ghost'), /not found/);
});

test('remove deletes the provider and its keys', async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.save(nara([{ id: 'key_1', name: 'Main', key: 'sk-1', active: true }]));
  assert.strictEqual(store.repos.providers.remove('nara'), true);
  assert.strictEqual(store.repos.providers.get('nara'), null);
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM provider_keys').get().n, 0);
  assert.strictEqual(store.repos.providers.remove('nara'), false);
});

test("keyRecord names the key's provider; revealKey is null for a locked key", async (t) => {
  const store = await memoryStore(t);
  store.repos.providers.save(nara([{ id: 'key_1', name: 'Main', key: 'sk-1', active: true }]));
  store.repos.providers.importProvider({
    id: 'darkapi', name: 'Dark API', baseUrl: 'https://darkapi.dev/v1', rpm: null, custom: false, position: 1,
    keys: [{ id: 'key_2', name: 'Other PC', cipher: LOCKED_BLOB, active: true, quotaSpent: null }],
  });
  assert.deepStrictEqual(store.repos.providers.keyRecord('key_1'), { id: 'key_1', name: 'Main', providerId: 'nara', baseUrl: NARA });
  assert.strictEqual(store.repos.providers.keyRecord('key_9'), null);
  assert.strictEqual(store.repos.providers.revealKey('key_2'), null);
  assert.strictEqual(store.repos.providers.revealKey('key_9'), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/db/providers.test.js`
Expected: FAIL with `Cannot find module '../../src/db/repos/providers'`.

- [ ] **Step 3: Write `src/db/repos/providers.js`**

```js
// ============================================
// Providers and their API keys
// ============================================
// A key row holds only ciphertext (enc:v1:…). The plaintext exists in main
// memory, decrypted once per session into the shared cache, and leaves main
// only as a masked hint. A key whose ciphertext this machine can't open is
// "locked": kept untouched and reported as such, never overwritten.
const { ENC_PREFIX, revealCached } = require('../cipher');

const KEY_PLACEHOLDER = 'venomkey:';
const ANY_PLACEHOLDER = /^venom(?:key|secret):/;

// The display mask the renderer has always shown, computed from the plaintext
// at read time. Never stored: it still holds real characters of the key.
function maskKey(key) {
  if (!key) return '';
  const head = key.length <= 12 ? 6 : 10;
  return key.slice(0, head) + '********' + key.slice(-4);
}

function createProvidersRepo(db, cipher, cache, log = console) {
  const q = {
    providers: db.prepare('SELECT * FROM providers ORDER BY position, id'),
    provider: db.prepare('SELECT * FROM providers WHERE id = ?'),
    nextProviderPosition: db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM providers'),
    insertProvider: db.prepare(`INSERT INTO providers (id, name, base_url, rpm, is_custom, position, created_at, updated_at)
      VALUES (@id, @name, @base_url, @rpm, @is_custom, @position, @now, @now)`),
    updateProvider: db.prepare(`UPDATE providers SET name = @name, base_url = @base_url, rpm = @rpm,
      is_custom = @is_custom, updated_at = @now WHERE id = @id`),
    deleteProvider: db.prepare('DELETE FROM providers WHERE id = ?'),
    keysOf: db.prepare('SELECT * FROM provider_keys WHERE provider_id = ? ORDER BY position, id'),
    key: db.prepare('SELECT * FROM provider_keys WHERE id = ?'),
    keyWithProvider: db.prepare(`SELECT k.id, k.name, k.provider_id, p.base_url FROM provider_keys k
      JOIN providers p ON p.id = k.provider_id WHERE k.id = ?`),
    insertKey: db.prepare(`INSERT INTO provider_keys
      (id, provider_id, name, cipher, active, position, quota_spent_json, created_at, updated_at)
      VALUES (@id, @provider_id, @name, @cipher, @active, @position, @quota_spent_json, @now, @now)`),
    updateKey: db.prepare(`UPDATE provider_keys SET name = @name, cipher = @cipher, active = @active,
      position = @position, quota_spent_json = @quota_spent_json, updated_at = @now WHERE id = @id`),
    moveKey: db.prepare('UPDATE provider_keys SET provider_id = ?, position = ?, updated_at = ? WHERE id = ?'),
    deleteKey: db.prepare('DELETE FROM provider_keys WHERE id = ?'),
  };
  const cacheKey = (id) => `key:${id}`;
  const warnedLocked = new Set();

  function reveal(row) {
    const plain = revealCached(cipher, cache, cacheKey(row.id), row.cipher);
    if (plain === null && !warnedLocked.has(row.id)) {
      warnedLocked.add(row.id);
      log.warn(`Key "${row.name}" can't be decrypted here (encrypted for another machine or user); kept as is`);
    }
    return plain;
  }

  // The key as the renderer sees it: a placeholder and a hint, never the secret.
  function toKey(row) {
    const secret = reveal(row);
    const locked = secret === null;
    const out = {
      id: row.id,
      name: row.name,
      key: locked ? '' : KEY_PLACEHOLDER + row.id,
      hint: locked ? '' : maskKey(secret),
      active: row.active === 1,
      locked,
    };
    if (row.quota_spent_json) out.quotaSpent = JSON.parse(row.quota_spent_json);
    return out;
  }

  function toProvider(row) {
    const out = { name: row.name, baseUrl: row.base_url, rpm: row.rpm, keys: q.keysOf.all(row.id).map(toKey) };
    if (row.is_custom === 1) out.custom = true;
    return out;
  }

  function list() {
    const out = {};
    q.providers.all().forEach((row) => { out[row.id] = toProvider(row); });
    return out;
  }

  function get(id) {
    const row = q.provider.get(id);
    return row ? toProvider(row) : null;
  }

  // What to store for one key of a save-provider payload (spec §4, "save-provider
  // key semantics").
  function cipherFor(providerId, k, stored) {
    const label = k.name || k.id;
    const value = typeof k.key === 'string' ? k.key : '';
    if (value.startsWith(KEY_PLACEHOLDER)) {
      const ref = q.key.get(value.slice(KEY_PLACEHOLDER.length));
      if (!ref) throw new Error(`Key "${label}" points at a key that doesn't exist`);
      if (ref.provider_id !== providerId) throw new Error(`Key "${label}" belongs to another provider`);
      return ref.cipher;
    }
    if (value === '') {
      // '' is how a locked key comes back: keep what is stored, never write ''.
      if (stored) return stored.cipher;
      throw new Error(`Key "${label}" has no value`);
    }
    if (ANY_PLACEHOLDER.test(value) || value.startsWith(ENC_PREFIX)) throw new Error(`Key "${label}" is not a usable key value`);
    // The same secret sent back (while the renderer still holds plaintext):
    // keep the stored ciphertext instead of re-encrypting it on every save.
    if (stored && reveal(stored) === value) return stored.cipher;
    cache.delete(cacheKey(k.id));
    return cipher.encrypt(value);
  }

  // save-provider: upsert by id, keys as sent. One transaction, so a refused
  // key leaves the provider exactly as it was.
  const saveTx = db.transaction((p) => {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id) throw new TypeError('A provider needs an id');
    if (typeof p.name !== 'string' || typeof p.baseUrl !== 'string') throw new TypeError(`Provider "${p.id}" needs a name and a base URL`);
    const keys = Array.isArray(p.keys) ? p.keys : [];
    const now = Date.now();
    const existing = q.provider.get(p.id);
    const row = {
      id: p.id,
      name: p.name,
      base_url: p.baseUrl,
      rpm: Number.isFinite(p.rpm) ? p.rpm : null,
      is_custom: p.custom === undefined ? (existing ? existing.is_custom : 0) : (p.custom ? 1 : 0),
      now,
    };
    if (existing) q.updateProvider.run(row);
    else q.insertProvider.run({ ...row, position: q.nextProviderPosition.get().p });

    const stored = new Map(q.keysOf.all(p.id).map((r) => [r.id, r]));
    const seen = new Set();
    keys.forEach((k, position) => {
      if (!k || typeof k.id !== 'string' || !k.id) throw new TypeError(`A key of "${p.id}" has no id`);
      if (seen.has(k.id)) throw new Error(`Key ${k.id} is listed twice`);
      seen.add(k.id);
      const owner = q.key.get(k.id);
      if (owner && owner.provider_id !== p.id) throw new Error(`Key ${k.id} belongs to another provider`);
      const values = {
        id: k.id,
        provider_id: p.id,
        name: typeof k.name === 'string' && k.name ? k.name : k.id,
        cipher: cipherFor(p.id, k, stored.get(k.id)),
        active: k.active === false ? 0 : 1,
        position,
        quota_spent_json: k.quotaSpent ? JSON.stringify(k.quotaSpent) : null,
        now,
      };
      if (stored.has(k.id)) q.updateKey.run(values);
      else q.insertKey.run(values);
    });
    // A key left out of the payload was deleted by the user.
    stored.forEach((r, id) => {
      if (seen.has(id)) return;
      q.deleteKey.run(id);
      cache.delete(cacheKey(id));
    });
  });

  function save(p) {
    saveTx(p);
    return get(p.id);
  }

  // merge-provider: a legacy custom provider folded into its built-in twin.
  const mergeTx = db.transaction((fromId, intoId) => {
    if (fromId === intoId) throw new Error('A provider cannot be merged into itself');
    if (!q.provider.get(fromId)) throw new Error(`Provider "${fromId}" not found`);
    if (!q.provider.get(intoId)) throw new Error(`Provider "${intoId}" not found`);
    // Same secret = same key. A locked key has no readable value, so its
    // ciphertext stands in for it (two copies of one locked key still match).
    const identity = (row) => {
      const value = reveal(row);
      return value === null ? `cipher:${row.cipher}` : `value:${value}`;
    };
    const target = q.keysOf.all(intoId);
    const have = new Set(target.map(identity));
    let position = target.reduce((max, r) => Math.max(max, r.position), -1) + 1;
    const now = Date.now();
    q.keysOf.all(fromId).forEach((row) => {
      const id = identity(row);
      if (have.has(id)) {
        q.deleteKey.run(row.id);
        cache.delete(cacheKey(row.id));
        return;
      }
      have.add(id);
      q.moveKey.run(intoId, position, now, row.id);
      position += 1;
    });
    q.deleteProvider.run(fromId);
  });

  function merge(fromId, intoId) {
    mergeTx(fromId, intoId);
    return get(intoId);
  }

  // delete-provider: its keys go with it (ON DELETE CASCADE).
  const remove = db.transaction((id) => {
    const keys = q.keysOf.all(id);
    const { changes } = q.deleteProvider.run(id);
    keys.forEach((k) => cache.delete(cacheKey(k.id)));
    return changes > 0;
  });

  // For request signing (src/db/keys.js) and copy-key.
  function keyRecord(id) {
    const row = q.keyWithProvider.get(id);
    return row ? { id: row.id, name: row.name, providerId: row.provider_id, baseUrl: row.base_url } : null;
  }

  function revealKey(id) {
    const row = q.key.get(id);
    return row ? reveal(row) : null;
  }

  // Import only, inside the importer's transaction: rows exactly as given,
  // ciphertext included.
  function importProvider(p) {
    const now = Date.now();
    q.insertProvider.run({ id: p.id, name: p.name, base_url: p.baseUrl, rpm: p.rpm, is_custom: p.custom ? 1 : 0, position: p.position, now });
    p.keys.forEach((k, position) => q.insertKey.run({
      id: k.id,
      provider_id: p.id,
      name: k.name,
      cipher: k.cipher,
      active: k.active ? 1 : 0,
      position,
      quota_spent_json: k.quotaSpent ? JSON.stringify(k.quotaSpent) : null,
      now,
    }));
  }

  return { list, get, save, merge, remove, keyRecord, revealKey, importProvider };
}

module.exports = { createProvidersRepo, maskKey, KEY_PLACEHOLDER };
```

- [ ] **Step 4: Wire it into `src/db/index.js`**

Replace:
```js
const { createSecretsRepo } = require('./repos/secrets');
```
with:
```js
const { createSecretsRepo } = require('./repos/secrets');
const { createProvidersRepo } = require('./repos/providers');
```

Replace:
```js
    secrets: createSecretsRepo(db, cipher, cache),
  };
```
with:
```js
    secrets: createSecretsRepo(db, cipher, cache),
    providers: createProvidersRepo(db, cipher, cache, log),
  };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- test/db/providers.test.js`
Expected: `pass 19`, `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/db/repos/providers.js src/db/index.js test/db/providers.test.js
git commit -m "feat(db): providers and encrypted keys with save, merge and delete semantics"
```

### Task 6: Catalogue repository — diffed writes

**Files:**
- Create: `src/db/repos/catalog.js`
- Modify: `src/db/index.js` (require + `createRepos`)
- Test: `test/db/catalog.test.js`

**Interfaces:**
- Consumes: `open()` (Task 3).
- Produces `repos.catalog`:
  - `read() → { version: 1, models: { 'pid::mid': Entry }, lastSync: { pid: ms }, keyModels: { kid: { count, at } }, leaderboard: object|null, leaderboardError?, profiles? }` — today's `catalog.json` shape; `Entry.key` is derived.
  - `write(catalog, { reset }?) → { written, deleted }` — one transaction; only rows whose hash changed; entries missing from the payload are deleted; throws `Refusing to empty the model pool without a reset` when the payload has no models, the DB has some and `reset !== true`. `lastSync`, `keyModels` and each of `leaderboard`/`leaderboardError`/`profiles` are only touched when present in the payload.
  - `resetCache()` — forget the row hashes (rebuilt lazily from the DB).

- [ ] **Step 1: Write the failing test**

`test/db/catalog.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { memoryStore } = require('../helpers');

function catalogFixture() {
  return {
    version: 1,
    models: {
      'nara::qwen3.8-flash:free': {
        key: 'nara::qwen3.8-flash:free', providerId: 'nara', id: 'qwen3.8-flash:free',
        firstSeen: 1727000000000, lastSeen: 1727100000000, removedAt: null, isNew: true,
        pricing: { input: 0, output: 0, source: 'free tier' }, declaresTools: null, maxOutput: 8192,
        name: 'Qwen 3.8 Flash', kind: 'chat', hasVision: false, hasReasoning: true, isFree: true, isFreeForPaid: false,
        contextLabel: '128K', contextWindow: 131072, keyIds: ['key_2', 'key_1'], ownedBy: 'qwen',
        bench: { suite: 3, at: 1727100000000, composite: 71.5, tier: 'B', items: [{ id: 'r1', ok: true, reply: 'four' }] },
        history: [{ at: 1727100000000, composite: 71.5, tier: 'B', quality: 70, latencyMs: 900, ttftMs: 300 }],
        benchError: null,
        caps: { version: 1, at: 1727100000000, tools: { supported: true, time: 800, note: '' } },
        capsError: null,
        aliasGroup: 'qwen3.8-flash',
      },
      'darkapi::old-model': {
        key: 'darkapi::old-model', providerId: 'darkapi', id: 'old-model',
        firstSeen: 1726000000000, lastSeen: 1726500000000, removedAt: 1726600000000, isNew: false,
        pricing: null, declaresTools: false, maxOutput: null, name: 'old-model', kind: 'image',
        hasVision: false, hasReasoning: false, isFree: false, isFreeForPaid: true, contextLabel: '', contextWindow: null,
        keyIds: [], ownedBy: '', bench: null, history: [], benchError: 'HTTP 502', capsError: null,
      },
    },
    lastSync: { nara: 1727100000000, darkapi: 1726600000000 },
    keyModels: { key_1: { count: 12, at: 1727100000000 }, key_2: { count: 3, at: 1727100000000 } },
    leaderboard: {
      source: 'artificialanalysis.ai (live API)', at: 1727000000000,
      models: [{ name: 'Qwen', slug: 'qwen3-8', creator: 'Alibaba', index: 55, codingIndex: 50, mathIndex: 60, tps: 120, ttft: 0.4, priceBlended: 0.2 }],
    },
    leaderboardError: null,
    profiles: { policy: { version: 1, minRuns: 3, topN: 5 } },
  };
}

test('a catalogue round-trips deep-equal', async (t) => {
  const { repos } = await memoryStore(t);
  repos.catalog.write(catalogFixture(), { reset: true });
  assert.deepStrictEqual(repos.catalog.read(), catalogFixture());
});

test('unknown entry fields are kept under summary_json.extra', async (t) => {
  const store = await memoryStore(t);
  store.repos.catalog.write(catalogFixture(), { reset: true });
  const row = store.db.prepare("SELECT summary_json FROM models WHERE model_id = 'qwen3.8-flash:free'").get();
  const summary = JSON.parse(row.summary_json);
  assert.deepStrictEqual(summary.extra, { aliasGroup: 'qwen3.8-flash' });
  assert.deepStrictEqual(Object.keys(summary).filter((k) => k !== 'extra').sort(), [
    'contextLabel', 'contextWindow', 'declaresTools', 'hasReasoning', 'hasVision', 'isFree', 'isFreeForPaid', 'maxOutput', 'ownedBy', 'pricing',
  ]);
});

test('absent benchError/capsError read back as null; absent caps stays absent', async (t) => {
  const { repos } = await memoryStore(t);
  const cat = catalogFixture();
  delete cat.models['darkapi::old-model'].benchError;
  delete cat.models['darkapi::old-model'].capsError;
  repos.catalog.write(cat, { reset: true });
  const e = repos.catalog.read().models['darkapi::old-model'];
  assert.strictEqual(e.benchError, null);
  assert.strictEqual(e.capsError, null);
  assert.strictEqual('caps' in e, false);
});

test('keyIds keep their order', async (t) => {
  const { repos } = await memoryStore(t);
  repos.catalog.write(catalogFixture(), { reset: true });
  assert.deepStrictEqual(repos.catalog.read().models['nara::qwen3.8-flash:free'].keyIds, ['key_2', 'key_1']);
});

test('unchanged rows are not rewritten, before or after a read', async (t) => {
  const { repos } = await memoryStore(t);
  assert.deepStrictEqual(repos.catalog.write(catalogFixture(), { reset: true }), { written: 2, deleted: 0 });
  assert.deepStrictEqual(repos.catalog.write(catalogFixture()), { written: 0, deleted: 0 });
  repos.catalog.resetCache();
  repos.catalog.read();
  assert.deepStrictEqual(repos.catalog.write(catalogFixture()), { written: 0, deleted: 0 });
});

test('a changed row is written alone and a missing entry is deleted with its key links', async (t) => {
  const store = await memoryStore(t);
  store.repos.catalog.write(catalogFixture(), { reset: true });
  const cat = catalogFixture();
  cat.models['darkapi::old-model'].lastSeen = 1726700000000;
  delete cat.models['nara::qwen3.8-flash:free'];
  assert.deepStrictEqual(store.repos.catalog.write(cat), { written: 1, deleted: 1 });
  assert.deepStrictEqual(Object.keys(store.repos.catalog.read().models), ['darkapi::old-model']);
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM model_keys').get().n, 0);
});

test('an empty model set never replaces a non-empty one without reset', async (t) => {
  const { repos } = await memoryStore(t);
  const empty = { ...catalogFixture(), models: {} };
  assert.deepStrictEqual(repos.catalog.write(empty), { written: 0, deleted: 0 });
  repos.catalog.write(catalogFixture(), { reset: true });
  assert.throws(() => repos.catalog.write(empty), /Refusing to empty the model pool/);
  assert.throws(() => repos.catalog.write(empty, { reset: 'yes' }), /Refusing to empty the model pool/);
  assert.strictEqual(Object.keys(repos.catalog.read().models).length, 2);
  assert.deepStrictEqual(repos.catalog.write(empty, { reset: true }), { written: 0, deleted: 2 });
  assert.deepStrictEqual(repos.catalog.read().models, {});
});

test('lastSync, keyModels and meta follow the payload; absent sections are left alone', async (t) => {
  const { repos } = await memoryStore(t);
  repos.catalog.write(catalogFixture(), { reset: true });
  const cat = catalogFixture();
  delete cat.lastSync.darkapi;
  cat.keyModels = { key_1: { count: 13, at: 1727200000000 } };
  delete cat.profiles;
  cat.leaderboardError = undefined;
  repos.catalog.write(cat);
  const back = repos.catalog.read();
  assert.deepStrictEqual(back.lastSync, { nara: 1727100000000 });
  assert.deepStrictEqual(back.keyModels, { key_1: { count: 13, at: 1727200000000 } });
  assert.deepStrictEqual(back.profiles, catalogFixture().profiles);
  assert.strictEqual('leaderboardError' in back, false);
});

test('a write that fails inside the transaction is retried in full next time', async (t) => {
  const store = await memoryStore(t);
  const cat = catalogFixture();
  store.repos.catalog.write(cat, { reset: true });
  store.db.exec(`CREATE TRIGGER fail_sync BEFORE INSERT ON provider_sync WHEN NEW.provider_id = 'boom'
    BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
  cat.models['nara::qwen3.8-flash:free'].name = 'Renamed';
  cat.lastSync.boom = 1;
  assert.throws(() => store.repos.catalog.write(cat), /disk full/);
  // Raw SQL, not read(): read() would rebuild the hashes and hide the bug this pins.
  assert.strictEqual(store.db.prepare("SELECT name FROM models WHERE model_id = 'qwen3.8-flash:free'").get().name, 'Qwen 3.8 Flash');
  store.db.exec('DROP TRIGGER fail_sync');
  delete cat.lastSync.boom;
  assert.strictEqual(store.repos.catalog.write(cat).written, 1);
  assert.strictEqual(store.repos.catalog.read().models['nara::qwen3.8-flash:free'].name, 'Renamed');
});

test('an entry without providerId or id is refused before anything is written', async (t) => {
  const { repos } = await memoryStore(t);
  const cat = catalogFixture();
  cat.models['broken'] = { id: 'x' };
  assert.throws(() => repos.catalog.write(cat, { reset: true }), /providerId and id/);
  assert.deepStrictEqual(repos.catalog.read().models, {});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/db/catalog.test.js`
Expected: FAIL — `TypeError: Cannot read properties of undefined (reading 'write')`.

- [ ] **Step 3: Write `src/db/repos/catalog.js`**

```js
// ============================================
// Model pool — models, key links, sync times, catalogue meta
// ============================================
// The renderer still owns the catalogue object and sends it whole
// (write-catalog). Main compares every entry with a hash of the row it wrote
// last and writes only what changed, in one transaction — a sync that changes
// nothing writes nothing. Granular IPC per mutation can come later.
//
// Entry ↔ row mapping (spec §1): scalar fields have columns; the summary
// fields go to summary_json with any unknown field under `extra`, so a round
// trip never drops data; bench/history/caps stay JSON.
const SUMMARY_KEYS = ['pricing', 'declaresTools', 'maxOutput', 'hasVision', 'hasReasoning', 'isFree', 'isFreeForPaid', 'contextLabel', 'contextWindow', 'ownedBy'];
const COLUMN_FIELDS = new Set(['key', 'providerId', 'id', 'name', 'kind', 'firstSeen', 'lastSeen', 'removedAt', 'isNew', 'bench', 'history', 'benchError', 'caps', 'capsError', 'keyIds', ...SUMMARY_KEYS]);
const META_KEYS = ['leaderboard', 'leaderboardError', 'profiles'];
const HASH_COLUMNS = ['name', 'kind', 'first_seen', 'last_seen', 'removed_at', 'is_new', 'summary_json', 'bench_json', 'history_json', 'bench_error', 'caps_json', 'caps_error'];

const keyOf = (providerId, modelId) => `${providerId}::${modelId}`;
const numOrNull = (v) => (Number.isFinite(v) ? v : null);
// JSON columns keep null apart from absent: SQL NULL = absent, 'null' = null.
const jsonOrNull = (v) => (v === undefined ? null : JSON.stringify(v));
const textOrNull = (v) => (v === undefined || v === null ? null : String(v));

function entryToRow(entry) {
  const summary = {};
  SUMMARY_KEYS.forEach((k) => { if (entry[k] !== undefined) summary[k] = entry[k]; });
  const extra = {};
  Object.keys(entry).forEach((k) => { if (!COLUMN_FIELDS.has(k) && entry[k] !== undefined) extra[k] = entry[k]; });
  if (Object.keys(extra).length) summary.extra = extra;
  return {
    provider_id: entry.providerId,
    model_id: entry.id,
    name: typeof entry.name === 'string' ? entry.name : null,
    kind: typeof entry.kind === 'string' ? entry.kind : null,
    first_seen: numOrNull(entry.firstSeen),
    last_seen: numOrNull(entry.lastSeen),
    removed_at: numOrNull(entry.removedAt),
    is_new: entry.isNew ? 1 : 0,
    summary_json: JSON.stringify(summary),
    bench_json: jsonOrNull(entry.bench),
    history_json: jsonOrNull(entry.history),
    bench_error: textOrNull(entry.benchError),
    caps_json: jsonOrNull(entry.caps),
    caps_error: textOrNull(entry.capsError),
  };
}

// Deduped, order kept: rows are re-inserted in this order and read back by rowid.
function entryKeyIds(entry) {
  return Array.isArray(entry.keyIds) ? [...new Set(entry.keyIds.filter((k) => typeof k === 'string' && k))] : [];
}

function rowHash(row, keyIds) {
  return JSON.stringify([HASH_COLUMNS.map((c) => row[c]), keyIds]);
}

function rowToEntry(row, keyIds) {
  const { extra, ...summary } = JSON.parse(row.summary_json || '{}');
  const e = { ...(extra || {}), key: keyOf(row.provider_id, row.model_id), providerId: row.provider_id, id: row.model_id };
  if (row.name !== null) e.name = row.name;
  if (row.kind !== null) e.kind = row.kind;
  if (row.first_seen !== null) e.firstSeen = row.first_seen;
  if (row.last_seen !== null) e.lastSeen = row.last_seen;
  e.removedAt = row.removed_at;
  e.isNew = row.is_new === 1;
  Object.assign(e, summary);
  if (row.bench_json !== null) e.bench = JSON.parse(row.bench_json);
  if (row.history_json !== null) e.history = JSON.parse(row.history_json);
  // Absent and null read the same to the renderer; both come back as null.
  e.benchError = row.bench_error;
  if (row.caps_json !== null) e.caps = JSON.parse(row.caps_json);
  e.capsError = row.caps_error;
  e.keyIds = keyIds;
  return e;
}

function createCatalogRepo(db) {
  const q = {
    models: db.prepare('SELECT * FROM models'),
    modelKeys: db.prepare('SELECT provider_id, model_id, key_id FROM model_keys ORDER BY rowid'),
    upsertModel: db.prepare(`INSERT INTO models (provider_id, model_id, name, kind, first_seen, last_seen, removed_at, is_new,
        summary_json, bench_json, history_json, bench_error, caps_json, caps_error, updated_at)
      VALUES (@provider_id, @model_id, @name, @kind, @first_seen, @last_seen, @removed_at, @is_new,
        @summary_json, @bench_json, @history_json, @bench_error, @caps_json, @caps_error, @updated_at)
      ON CONFLICT(provider_id, model_id) DO UPDATE SET name = excluded.name, kind = excluded.kind,
        first_seen = excluded.first_seen, last_seen = excluded.last_seen, removed_at = excluded.removed_at,
        is_new = excluded.is_new, summary_json = excluded.summary_json, bench_json = excluded.bench_json,
        history_json = excluded.history_json, bench_error = excluded.bench_error, caps_json = excluded.caps_json,
        caps_error = excluded.caps_error, updated_at = excluded.updated_at`),
    deleteModel: db.prepare('DELETE FROM models WHERE provider_id = ? AND model_id = ?'),
    deleteModelKeys: db.prepare('DELETE FROM model_keys WHERE provider_id = ? AND model_id = ?'),
    insertModelKey: db.prepare('INSERT INTO model_keys (provider_id, model_id, key_id) VALUES (?, ?, ?)'),
    syncRows: db.prepare('SELECT provider_id, last_sync_at FROM provider_sync'),
    upsertSync: db.prepare(`INSERT INTO provider_sync (provider_id, last_sync_at) VALUES (?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET last_sync_at = excluded.last_sync_at`),
    deleteSync: db.prepare('DELETE FROM provider_sync WHERE provider_id = ?'),
    countRows: db.prepare('SELECT key_id, count, at FROM key_model_counts'),
    upsertCount: db.prepare(`INSERT INTO key_model_counts (key_id, count, at) VALUES (?, ?, ?)
      ON CONFLICT(key_id) DO UPDATE SET count = excluded.count, at = excluded.at`),
    deleteCount: db.prepare('DELETE FROM key_model_counts WHERE key_id = ?'),
    meta: db.prepare('SELECT value_json FROM catalog_meta WHERE key = ?'),
    upsertMeta: db.prepare(`INSERT INTO catalog_meta (key, value_json) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`),
    deleteMeta: db.prepare('DELETE FROM catalog_meta WHERE key = ?'),
  };

  // 'pid::mid' -> { hash, providerId, modelId } for every row on disk; null
  // until built. Replaced only after a commit, so a rolled-back write can't
  // make the next one skip rows that never reached the disk.
  let hashes = null;

  function loadModels() {
    const keyIds = new Map();
    q.modelKeys.all().forEach((r) => {
      const k = keyOf(r.provider_id, r.model_id);
      if (!keyIds.has(k)) keyIds.set(k, []);
      keyIds.get(k).push(r.key_id);
    });
    const models = {};
    const fresh = new Map();
    q.models.all().forEach((row) => {
      const k = keyOf(row.provider_id, row.model_id);
      const ids = keyIds.get(k) || [];
      models[k] = rowToEntry(row, ids);
      fresh.set(k, { hash: rowHash(row, ids), providerId: row.provider_id, modelId: row.model_id });
    });
    hashes = fresh;
    return models;
  }

  function read() {
    const models = loadModels();
    const lastSync = {};
    q.syncRows.all().forEach((r) => { lastSync[r.provider_id] = r.last_sync_at; });
    const keyModels = {};
    q.countRows.all().forEach((r) => { keyModels[r.key_id] = { count: r.count, at: r.at }; });
    const out = { version: 1, models, lastSync, keyModels, leaderboard: null };
    META_KEYS.forEach((k) => {
      const row = q.meta.get(k);
      if (row) out[k] = JSON.parse(row.value_json);
    });
    return out;
  }

  function writeLastSync(map) {
    const current = new Map(q.syncRows.all().map((r) => [r.provider_id, r.last_sync_at]));
    const seen = new Set();
    Object.entries(map).forEach(([pid, at]) => {
      if (!Number.isFinite(at)) return;
      seen.add(pid);
      if (current.get(pid) !== at) q.upsertSync.run(pid, at);
    });
    current.forEach((_, pid) => { if (!seen.has(pid)) q.deleteSync.run(pid); });
  }

  function writeKeyModels(map) {
    const current = new Map(q.countRows.all().map((r) => [r.key_id, r]));
    const seen = new Set();
    Object.entries(map).forEach(([kid, v]) => {
      if (!v || !Number.isFinite(v.count) || !Number.isFinite(v.at)) return;
      seen.add(kid);
      const had = current.get(kid);
      if (!had || had.count !== v.count || had.at !== v.at) q.upsertCount.run(kid, v.count, v.at);
    });
    current.forEach((_, kid) => { if (!seen.has(kid)) q.deleteCount.run(kid); });
  }

  function writeMeta(key, value) {
    if (value === undefined) {
      q.deleteMeta.run(key);
      return;
    }
    const json = JSON.stringify(value);
    const row = q.meta.get(key);
    if (!row || row.value_json !== json) q.upsertMeta.run(key, json);
  }

  function write(catalog, { reset = false } = {}) {
    if (!catalog || typeof catalog !== 'object' || !catalog.models || typeof catalog.models !== 'object') {
      throw new TypeError('write-catalog needs an object with models');
    }
    if (!hashes) loadModels();
    const next = new Map();
    Object.values(catalog.models).forEach((entry) => {
      if (!entry || typeof entry !== 'object' || typeof entry.providerId !== 'string' || !entry.providerId || typeof entry.id !== 'string' || !entry.id) {
        throw new TypeError('A catalogue entry needs providerId and id');
      }
      const row = entryToRow(entry);
      const keyIds = entryKeyIds(entry);
      next.set(keyOf(row.provider_id, row.model_id), { row, keyIds, hash: rowHash(row, keyIds) });
    });
    // A failed read or a bug upstream must never wipe the pool; only the
    // Clear/Reset buttons send reset.
    if (next.size === 0 && hashes.size > 0 && reset !== true) throw new Error('Refusing to empty the model pool without a reset');

    const now = Date.now();
    let written = 0;
    let deleted = 0;
    db.transaction(() => {
      next.forEach((n, k) => {
        const had = hashes.get(k);
        if (had && had.hash === n.hash) return;
        q.upsertModel.run({ ...n.row, updated_at: now });
        q.deleteModelKeys.run(n.row.provider_id, n.row.model_id);
        n.keyIds.forEach((kid) => q.insertModelKey.run(n.row.provider_id, n.row.model_id, kid));
        written += 1;
      });
      hashes.forEach((h, k) => {
        if (next.has(k)) return;
        q.deleteModel.run(h.providerId, h.modelId);
        deleted += 1;
      });
      if (catalog.lastSync && typeof catalog.lastSync === 'object') writeLastSync(catalog.lastSync);
      if (catalog.keyModels && typeof catalog.keyModels === 'object') writeKeyModels(catalog.keyModels);
      META_KEYS.forEach((k) => { if (k in catalog) writeMeta(k, catalog[k]); });
    })();

    const fresh = new Map();
    next.forEach((n, k) => fresh.set(k, { hash: n.hash, providerId: n.row.provider_id, modelId: n.row.model_id }));
    hashes = fresh;
    return { written, deleted };
  }

  function resetCache() {
    hashes = null;
  }

  return { read, write, resetCache };
}

module.exports = { createCatalogRepo };
```

- [ ] **Step 4: Wire it into `src/db/index.js`**

Replace:
```js
const { createProvidersRepo } = require('./repos/providers');
```
with:
```js
const { createProvidersRepo } = require('./repos/providers');
const { createCatalogRepo } = require('./repos/catalog');
```

Replace:
```js
    providers: createProvidersRepo(db, cipher, cache, log),
  };
```
with:
```js
    providers: createProvidersRepo(db, cipher, cache, log),
    catalog: createCatalogRepo(db),
  };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- test/db/catalog.test.js`
Expected: `pass 10`, `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/db/repos/catalog.js src/db/index.js test/db/catalog.test.js
git commit -m "feat(db): model pool repository with row-hash diffed writes"
```

---

### Task 7: History repository and ULID

**Files:**
- Create: `src/db/ulid.js`
- Create: `src/db/repos/history.js`
- Modify: `src/db/index.js` (require + `createRepos`)
- Test: `test/db/history.test.js`

**Interfaces:**
- Consumes: `open()` (Task 3).
- Produces:
  - `src/db/ulid.js`: `ulid(now?: number, random?: (n) => Buffer) → string` (26 chars, Crockford base32).
  - `repos.history`: `read() → { version: 1, runs: [{ id, at, provider, providerName, prompt, results: [{ model, status, time, tokens, completionTokens, attempts, correct }] }] }` ordered by id; `insert(run) → { id, runUid }` (no trim; importer); `append(run, maxRuns) → { id, runUid }` (insert + trim to `historyCap(maxRuns)`); `clear()`.
  - `historyCap(maxRuns) → number` exported: `min(floor(n), 5000)` for n > 0, else 300.

- [ ] **Step 1: Write the failing test**

`test/db/history.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { memoryStore } = require('../helpers');
const { ulid } = require('../../src/db/ulid');
const { historyCap } = require('../../src/db/repos/history');

const run = (at, results, extra = {}) => ({
  at, provider: 'nara', providerName: 'NaraRouter', prompt: 'What is 2+2?', results, ...extra,
});
const pass = (model) => ({ model, status: 'pass', time: 900, tokens: 12, completionTokens: 2, attempts: 1, correct: true });
const fail = (model) => ({ model, status: 'fail', time: null, tokens: null, completionTokens: null, attempts: 3, correct: null });

test('append and read round-trip today\'s run shape, plus an id', async (t) => {
  const { repos } = await memoryStore(t);
  const { id, runUid } = repos.history.append(run(1727000000000, [pass('m1'), { ...fail('m2'), correct: false }]), 300);
  assert.strictEqual(typeof id, 'number');
  assert.match(runUid, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.deepStrictEqual(repos.history.read(), {
    version: 1,
    runs: [{
      id, at: 1727000000000, provider: 'nara', providerName: 'NaraRouter', prompt: 'What is 2+2?',
      results: [pass('m1'), { ...fail('m2'), correct: false }],
    }],
  });
});

test('missing providerName and prompt fall back to the provider id and an empty prompt', async (t) => {
  const { repos } = await memoryStore(t);
  repos.history.insert({ at: 1, provider: 'nara', results: [] });
  const [r] = repos.history.read().runs;
  assert.strictEqual(r.providerName, 'nara');
  assert.strictEqual(r.prompt, '');
});

test('runs come back in insertion order, not by time', async (t) => {
  const { repos } = await memoryStore(t);
  repos.history.append(run(3000, [pass('a')]), 300);
  repos.history.append(run(1000, [pass('b')]), 300);
  assert.deepStrictEqual(repos.history.read().runs.map((r) => r.at), [3000, 1000]);
});

test('append trims to the cap, results of trimmed runs go too', async (t) => {
  const store = await memoryStore(t);
  for (let i = 1; i <= 5; i += 1) store.repos.history.append(run(i, [pass('m1'), fail('m2')]), 3);
  assert.deepStrictEqual(store.repos.history.read().runs.map((r) => r.at), [3, 4, 5]);
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM test_results').get().n, 6);
});

test('historyCap clamps to 5000 and falls back to 300', () => {
  assert.strictEqual(historyCap(50), 50);
  assert.strictEqual(historyCap(12000), 5000);
  assert.strictEqual(historyCap(0), 300);
  assert.strictEqual(historyCap('abc'), 300);
  assert.strictEqual(historyCap(undefined), 300);
});

test('clear empties runs and results', async (t) => {
  const store = await memoryStore(t);
  store.repos.history.append(run(1, [pass('m1')]), 300);
  store.repos.history.clear();
  assert.deepStrictEqual(store.repos.history.read(), { version: 1, runs: [] });
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM test_results').get().n, 0);
});

test('a malformed run is refused and nothing is written', async (t) => {
  const { repos } = await memoryStore(t);
  assert.throws(() => repos.history.append({ provider: 'nara', results: [] }, 300), /numeric at/);
  assert.throws(() => repos.history.append({ at: 1, results: [] }, 300), /provider id/);
  assert.throws(() => repos.history.append(run(1, [{ status: 'pass' }]), 300), /model and a status/);
  assert.deepStrictEqual(repos.history.read().runs, []);
});

test('ulid: 26 Crockford characters, time-prefixed, unique', () => {
  const a = ulid(1727000000000);
  const b = ulid(1727000000000);
  assert.match(a, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.strictEqual(a.slice(0, 10), b.slice(0, 10));
  assert.notStrictEqual(a, b);
  assert.ok(ulid(1727000000001).slice(0, 10) > a.slice(0, 10));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/db/history.test.js`
Expected: FAIL with `Cannot find module '../../src/db/ulid'`.

- [ ] **Step 3: Write `src/db/ulid.js`**

```js
// ULID: 48-bit millisecond time + 80 random bits in Crockford base32. Sorts by
// creation time and needs no coordination, so a run keeps one identity when a
// future server syncs it.
const crypto = require('crypto');

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function ulid(now = Date.now(), random = crypto.randomBytes) {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i += 1) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = random(16);
  let rand = '';
  // 256 is a multiple of 32, so the modulo keeps every character equally likely.
  for (let i = 0; i < 16; i += 1) rand += ALPHABET[bytes[i] % 32];
  return time + rand;
}

module.exports = { ulid };
```

- [ ] **Step 4: Write `src/db/repos/history.js`**

```js
// ============================================
// Run history — test_runs + test_results
// ============================================
// One row per Route Test run and one per model verdict. Only the verdict is
// kept, never the response text. Order is insertion order (id), which is what
// uptime, sparklines and regression detection read.
const { ulid } = require('../ulid');

const DEFAULT_MAX_RUNS = 300;
const MAX_RUNS_CEILING = 5000;

function historyCap(maxRuns) {
  const n = Number(maxRuns);
  return n > 0 ? Math.min(Math.floor(n), MAX_RUNS_CEILING) : DEFAULT_MAX_RUNS;
}

const num = (v) => (Number.isFinite(v) ? v : null);

function createHistoryRepo(db, { newUid = ulid } = {}) {
  const q = {
    insertRun: db.prepare('INSERT INTO test_runs (run_uid, at, provider_id, provider_name, prompt) VALUES (?, ?, ?, ?, ?)'),
    insertResult: db.prepare(`INSERT INTO test_results
      (run_id, model_id, status, time_ms, tokens, completion_tokens, attempts, correct) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    trim: db.prepare('DELETE FROM test_runs WHERE id NOT IN (SELECT id FROM test_runs ORDER BY id DESC LIMIT ?)'),
    runs: db.prepare('SELECT id, at, provider_id, provider_name, prompt FROM test_runs ORDER BY id'),
    results: db.prepare(`SELECT run_id, model_id, status, time_ms, tokens, completion_tokens, attempts, correct
      FROM test_results ORDER BY run_id, id`),
    clear: db.prepare('DELETE FROM test_runs'),
  };

  const insert = db.transaction((run) => {
    if (!run || typeof run !== 'object') throw new TypeError('A run must be an object');
    if (!Number.isFinite(run.at)) throw new TypeError('A run needs a numeric at');
    if (typeof run.provider !== 'string' || !run.provider) throw new TypeError('A run needs a provider id');
    const results = Array.isArray(run.results) ? run.results : [];
    results.forEach((r) => {
      if (!r || typeof r.model !== 'string' || !r.model || typeof r.status !== 'string' || !r.status) {
        throw new TypeError('A result needs a model and a status');
      }
    });
    const runUid = newUid();
    const providerName = typeof run.providerName === 'string' && run.providerName ? run.providerName : run.provider;
    const prompt = typeof run.prompt === 'string' ? run.prompt : '';
    const id = Number(q.insertRun.run(runUid, run.at, run.provider, providerName, prompt).lastInsertRowid);
    results.forEach((r) => q.insertResult.run(
      id, r.model, r.status, num(r.time), num(r.tokens), num(r.completionTokens),
      Number.isFinite(r.attempts) ? r.attempts : 1,
      typeof r.correct === 'boolean' ? (r.correct ? 1 : 0) : null,
    ));
    return { id, runUid };
  });

  // append-run: the cap applies on every append (and matches the renderer's
  // in-memory cap), so lowering historyMaxRuns trims on the next run.
  const append = db.transaction((run, maxRuns) => {
    const out = insert(run);
    q.trim.run(historyCap(maxRuns));
    return out;
  });

  function read() {
    const byRun = new Map();
    q.results.all().forEach((r) => {
      if (!byRun.has(r.run_id)) byRun.set(r.run_id, []);
      byRun.get(r.run_id).push({
        model: r.model_id,
        status: r.status,
        time: r.time_ms,
        tokens: r.tokens,
        completionTokens: r.completion_tokens,
        attempts: r.attempts,
        correct: r.correct === null ? null : r.correct === 1,
      });
    });
    const runs = q.runs.all().map((r) => ({
      id: r.id,
      at: r.at,
      provider: r.provider_id,
      providerName: r.provider_name,
      prompt: r.prompt,
      results: byRun.get(r.id) || [],
    }));
    return { version: 1, runs };
  }

  function clear() {
    q.clear.run();
  }

  return { read, insert, append, clear };
}

module.exports = { createHistoryRepo, historyCap };
```

- [ ] **Step 5: Wire it into `src/db/index.js`**

Replace:
```js
const { createCatalogRepo } = require('./repos/catalog');
```
with:
```js
const { createCatalogRepo } = require('./repos/catalog');
const { createHistoryRepo } = require('./repos/history');
```

Replace:
```js
    catalog: createCatalogRepo(db),
  };
```
with:
```js
    catalog: createCatalogRepo(db),
    history: createHistoryRepo(db),
  };
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: `pass 70` (5 user-data, 7 cipher, 10 open, 11 settings/secrets, 19 providers, 10 catalog, 8 history), `fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/db/ulid.js src/db/repos/history.js src/db/index.js test/db/history.test.js
git commit -m "feat(db): run history with ULID run ids and a capped append"
```

### Task 8: One-shot JSON importer

**Files:**
- Create: `src/db/import-json.js`
- Test: `test/db/import-json.test.js`

**Interfaces:**
- Consumes: `ENC_PREFIX` (Task 2); `repos.meta`, `repos.settings.set`, `repos.secrets.setCipher`, `repos.providers.importProvider`, `repos.catalog.write`/`resetCache`, `repos.history.insert` (Tasks 3-7).
- Produces:
  - `importLegacy({ dir, db, repos, cipher, log?, fs?, sleep?, now?, source?: 'legacy' | 'imported' }) → Promise<Report>` where `Report` is `{ status: 'skipped' }`, `{ status: 'none' }`, or `{ status: 'imported', source, files: { config, catalog, history }, unreadable: ('catalog'|'history')[], skipped: { keys, catalogEntries, runs, results }, reassignedKeys, renamed: [{ from, to }], renameFailed: string[] }`. Throws `ImportAbort` with `code` `IMPORT_IO` | `IMPORT_CONFIG_PARSE` | `IMPORT_NO_ENCRYPTION` | `IMPORT_BAD_ROW` | `IMPORT_WRITE`, a user-facing `message` and `file` (path or null).
  - `listImportedFiles(dir, fs?) → string[]` (existing `config.imported.json`, `catalog.imported.json`, `history.imported.json`).
  - `describeImportWarnings(report) → string` ('' when there is nothing to say).
  - `needsReimportPrompt({ importedAt: string|null, legacyPresent: boolean, savedCopies: number }) → boolean` — true only when nothing is imported yet, no legacy JSON is left and saved `*.imported.json` copies exist.
  - `ImportAbort` class.

- [ ] **Step 1: Write the failing test**

`test/db/import-json.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { importLegacy, listImportedFiles, describeImportWarnings, needsReimportPrompt, ImportAbort } = require('../../src/db/import-json');
const { memoryStore, fakeCipher, encFake, LOCKED_BLOB, quietLog, tempDir } = require('../helpers');

const NOW = 1727000000000;

const legacyConfig = () => ({
  version: 1,
  providers: {
    nara: {
      name: 'NaraRouter', baseUrl: 'https://router.bynara.id/v1', rpm: null,
      keys: [
        { id: 'key_1', name: 'Main', key: encFake('sk-nara-main'), active: true },
        { id: 'key_2', name: 'Spent', key: encFake('sk-nara-spent'), active: false,
          quotaSpent: { until: 1727100000000, status: 429, message: 'weekly', at: 1727000000000, models: ['m1'] } },
      ],
    },
    darkapi: { name: 'Dark API', baseUrl: 'https://darkapi.dev/v1', rpm: 20, keys: [{ id: 'key_3', name: 'Other PC', key: LOCKED_BLOB, active: true }] },
  },
  settings: { theme: 'daylight', historyMaxRuns: 50, mediaPrompt: 'legacy prompt', futureField: { a: 1 }, aaApiKey: 'aa-plain-key' },
  test: { prompt: 'What is 2+2?', expected: '4', autoMinutes: 15 },
  window: { x: 10, y: 20, width: 1300, height: 850, maximized: false },
});

const legacyCatalog = () => ({
  version: 1,
  models: {
    'nara::m1': {
      key: 'nara::m1', providerId: 'nara', id: 'm1', firstSeen: 1, lastSeen: 2, removedAt: null, isNew: false,
      name: 'm1', kind: 'chat', keyIds: ['key_1'], bench: null, history: [], benchError: null, capsError: null,
    },
  },
  lastSync: { nara: 2 },
  keyModels: { key_1: { count: 1, at: 2 } },
  leaderboard: null,
});

const legacyHistory = () => ({
  version: 1,
  runs: [
    { at: 1727000000000, provider: 'nara', providerName: 'NaraRouter', prompt: 'What is 2+2?',
      results: [{ model: 'm1', status: 'pass', time: 900, tokens: 10, completionTokens: 2, attempts: 1, correct: true }] },
    { at: 1727000100000, provider: 'nara',
      results: [{ model: 'm1', status: 'fail', time: null, tokens: null, completionTokens: null, attempts: 3, correct: null }] },
  ],
});

const all = () => ({ 'config.json': legacyConfig(), 'catalog.json': legacyCatalog(), 'history.json': legacyHistory() });
const ls = (dir) => fs.readdirSync(dir).sort();
const count = (store, table) => store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

async function setup(t, { cipher = fakeCipher(), files = {}, fsImpl } = {}) {
  const dir = tempDir(t);
  Object.entries(files).forEach(([name, content]) => {
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  });
  const store = await memoryStore(t, { cipher });
  const run = (extra = {}) => importLegacy({
    dir, db: store.db, repos: store.repos, cipher, log: quietLog, sleep: async () => {}, now: () => NOW,
    ...(fsImpl ? { fs: fsImpl } : {}), ...extra,
  });
  return { dir, store, run, cipher };
}

function assertNothingWritten(store) {
  ['providers', 'provider_keys', 'settings', 'secrets', 'models', 'test_runs'].forEach((table) => {
    assert.strictEqual(count(store, table), 0, table);
  });
  assert.strictEqual(store.repos.meta.get('imported_from_json_at'), null);
}

// fs with readFileSync failing EBUSY for one file, `failures` times.
function flakyFs(failName, failures) {
  let reads = 0;
  return {
    ...fs,
    readFileSync(file, enc) {
      if (path.basename(file) === failName) {
        reads += 1;
        if (reads <= failures) {
          const e = new Error(`EBUSY: resource busy or locked, open '${file}'`);
          e.code = 'EBUSY';
          throw e;
        }
      }
      return fs.readFileSync(file, enc);
    },
    reads: () => reads,
  };
}

test('imports every file in one go and renames them', async (t) => {
  const { dir, store, run, cipher } = await setup(t, { files: all() });
  const report = await run();
  assert.strictEqual(report.status, 'imported');
  assert.deepStrictEqual(report.unreadable, []);
  assert.deepStrictEqual(report.skipped, { keys: 0, catalogEntries: 0, runs: 0, results: 0 });
  // Ciphertext copied verbatim; nothing was decrypted.
  assert.deepStrictEqual(store.db.prepare('SELECT id, provider_id, cipher, active FROM provider_keys ORDER BY id').all(), [
    { id: 'key_1', provider_id: 'nara', cipher: encFake('sk-nara-main'), active: 1 },
    { id: 'key_2', provider_id: 'nara', cipher: encFake('sk-nara-spent'), active: 0 },
    { id: 'key_3', provider_id: 'darkapi', cipher: LOCKED_BLOB, active: 1 },
  ]);
  assert.strictEqual(cipher.calls.decrypt, 0);
  const providers = store.repos.providers.list();
  assert.deepStrictEqual(Object.keys(providers), ['nara', 'darkapi']);
  assert.strictEqual(providers.darkapi.rpm, 20);
  assert.deepStrictEqual(providers.nara.keys[1].quotaSpent, legacyConfig().providers.nara.keys[1].quotaSpent);
  assert.strictEqual(providers.darkapi.keys[0].locked, true);
  // Settings verbatim minus the AA key, which is a secret now.
  const { aaApiKey, ...settings } = legacyConfig().settings;
  assert.deepStrictEqual(store.repos.settings.get('settings'), settings);
  assert.strictEqual(store.repos.secrets.reveal('aaApiKey'), aaApiKey);
  assert.deepStrictEqual(store.repos.settings.get('test'), legacyConfig().test);
  assert.deepStrictEqual(store.repos.settings.get('window'), legacyConfig().window);
  // History, with the missing name and prompt filled in.
  const runs = store.repos.history.read().runs;
  assert.deepStrictEqual(runs.map((r) => [r.providerName, r.prompt]), [['NaraRouter', 'What is 2+2?'], ['nara', '']]);
  assert.deepStrictEqual(runs[0].results, legacyHistory().runs[0].results);
  const cat = store.repos.catalog.read();
  assert.deepStrictEqual(cat.models['nara::m1'], legacyCatalog().models['nara::m1']);
  assert.deepStrictEqual(cat.lastSync, { nara: 2 });
  assert.deepStrictEqual(cat.keyModels, { key_1: { count: 1, at: 2 } });
  assert.strictEqual(store.repos.meta.get('imported_from_json_at'), String(NOW));
  assert.deepStrictEqual(ls(dir), ['catalog.imported.json', 'config.imported.json', 'history.imported.json']);
  assert.strictEqual(describeImportWarnings(report), '');
});

test('a fresh install without legacy files is marked, and a later config.json is ignored', async (t) => {
  const { dir, store, run } = await setup(t);
  assert.deepStrictEqual(await run(), { status: 'none' });
  assert.strictEqual(store.repos.meta.get('imported_from_json_at'), 'none');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(legacyConfig()));
  assert.deepStrictEqual(await run(), { status: 'skipped' });
  assert.strictEqual(count(store, 'providers'), 0);
  assert.ok(fs.existsSync(path.join(dir, 'config.json')));
});

test('an I/O error on any file that outlasts the retries aborts with nothing written', async (t) => {
  for (const name of ['config.json', 'catalog.json', 'history.json']) {
    const flaky = flakyFs(name, 99);
    const { dir, store, run } = await setup(t, { files: all(), fsImpl: flaky });
    await assert.rejects(run(), (err) => err instanceof ImportAbort && err.code === 'IMPORT_IO' && err.message.includes(name), name);
    assert.strictEqual(flaky.reads(), 3, name);
    assertNothingWritten(store);
    assert.deepStrictEqual(ls(dir), ['catalog.json', 'config.json', 'history.json'], name);
  }
});

test('an I/O error that clears on a retry imports normally', async (t) => {
  const flaky = flakyFs('config.json', 1);
  const { store, run } = await setup(t, { files: all(), fsImpl: flaky });
  assert.strictEqual((await run()).status, 'imported');
  assert.strictEqual(flaky.reads(), 2);
  assert.strictEqual(count(store, 'providers'), 2);
});

test('a damaged config.json aborts with nothing written: bad JSON, empty file, not an object', async (t) => {
  for (const content of ['{ "providers": ', '', 'null', '[1, 2]']) {
    const { dir, store, run } = await setup(t, { files: { ...all(), 'config.json': content } });
    await assert.rejects(run(), (err) => err.code === 'IMPORT_CONFIG_PARSE');
    assertNothingWritten(store);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'), content);
  }
});

test('a damaged catalogue or history is left out, renamed .unreadable.json and reported', async (t) => {
  const { dir, store, run } = await setup(t, { files: { ...all(), 'catalog.json': '{"models": {', 'history.json': '[1, 2' } });
  const report = await run();
  assert.strictEqual(report.status, 'imported');
  assert.deepStrictEqual(report.unreadable, ['catalog', 'history']);
  assert.strictEqual(count(store, 'providers'), 2);
  assert.strictEqual(count(store, 'models'), 0);
  assert.strictEqual(count(store, 'test_runs'), 0);
  assert.deepStrictEqual(ls(dir), ['catalog.unreadable.json', 'config.imported.json', 'history.unreadable.json']);
  const text = describeImportWarnings(report);
  assert.match(text, /catalog\.json is damaged and was not imported\. It was renamed catalog\.unreadable\.json\./);
  assert.match(text, /history\.json is damaged and was not imported/);
});

test('malformed catalogue entries and history rows are skipped and counted', async (t) => {
  const catalog = legacyCatalog();
  catalog.models.junk = 'not an entry';
  catalog.models['nara::no-provider'] = { id: 'no-provider' };
  const history = legacyHistory();
  history.runs.push({ at: 5, results: [] });
  history.runs.push('garbage');
  history.runs[0].results.push({ status: 'pass' });
  const { store, run } = await setup(t, { files: { ...all(), 'catalog.json': catalog, 'history.json': history } });
  const report = await run();
  assert.deepStrictEqual(report.skipped, { keys: 0, catalogEntries: 2, runs: 2, results: 1 });
  assert.strictEqual(count(store, 'models'), 1);
  assert.strictEqual(count(store, 'test_runs'), 2);
  const text = describeImportWarnings(report);
  assert.match(text, /2 damaged model pool entries were skipped\./);
  assert.match(text, /2 damaged test runs were skipped\./);
  assert.match(text, /1 damaged test result was skipped\./);
});

test('a plaintext legacy key is encrypted on the way in', async (t) => {
  const config = legacyConfig();
  config.providers.nara.keys[0].key = 'sk-plain-legacy-key';
  const { store, run, cipher } = await setup(t, { files: { 'config.json': config } });
  await run();
  const raw = store.db.prepare("SELECT cipher FROM provider_keys WHERE id = 'key_1'").get().cipher;
  assert.ok(raw.startsWith('enc:v1:') && !raw.includes('sk-plain-legacy-key'));
  assert.strictEqual(store.repos.providers.revealKey('key_1'), 'sk-plain-legacy-key');
  assert.strictEqual(cipher.calls.encrypt, 2); // the key and the plaintext AA key
});

test('without OS encryption a plaintext key aborts the import; ciphertext alone still imports', async (t) => {
  const plain = legacyConfig();
  plain.providers.nara.keys[0].key = 'sk-plain-legacy-key';
  const a = await setup(t, { cipher: fakeCipher({ available: false }), files: { 'config.json': plain } });
  await assert.rejects(a.run(), (err) => err.code === 'IMPORT_NO_ENCRYPTION');
  assertNothingWritten(a.store);
  assert.deepStrictEqual(ls(a.dir), ['config.json']);

  const sealed = legacyConfig();
  delete sealed.settings.aaApiKey;
  const b = await setup(t, { cipher: fakeCipher({ available: false }), files: { 'config.json': sealed } });
  assert.strictEqual((await b.run()).status, 'imported');
  assert.strictEqual(count(b.store, 'provider_keys'), 3);
});

test('a legacy custom provider is imported as stored, flagged custom', async (t) => {
  const config = legacyConfig();
  config.providers.custom_171 = {
    name: 'My router', baseUrl: 'https://router.bynara.id/v1/', custom: true,
    keys: [{ id: 'key_9', name: 'Old', key: encFake('sk-custom'), active: true }],
  };
  const { store, run } = await setup(t, { files: { 'config.json': config } });
  await run();
  const p = store.repos.providers.get('custom_171');
  assert.strictEqual(p.custom, true);
  assert.strictEqual(p.baseUrl, 'https://router.bynara.id/v1/');
  assert.deepStrictEqual(p.keys.map((k) => k.id), ['key_9']);
});

test('keys without an id, with a duplicate id or an unusable id get fresh ids', async (t) => {
  const config = legacyConfig();
  config.providers.nara.keys.push({ name: 'No id', key: encFake('sk-a'), active: true });
  config.providers.darkapi.keys.push({ id: 'key_1', name: 'Duplicate', key: encFake('sk-b'), active: true });
  config.providers.darkapi.keys.push({ id: 'key with spaces', name: 'Unusable', key: encFake('sk-c'), active: true });
  const { store, run } = await setup(t, { files: { 'config.json': config } });
  const report = await run();
  assert.strictEqual(report.reassignedKeys, 2);
  const ids = store.db.prepare('SELECT id FROM provider_keys ORDER BY provider_id, position').all().map((r) => r.id);
  assert.deepStrictEqual(ids, ['key_3', `key_${NOW}_1`, `key_${NOW}_2`, 'key_1', 'key_2', `key_${NOW}`]);
  assert.match(describeImportWarnings(report), /2 keys had a duplicate or unusable id and got a new one\./);
});

test('a key with no value is skipped and reported', async (t) => {
  const config = legacyConfig();
  config.providers.nara.keys.push({ id: 'key_empty', name: 'Blank', key: '', active: true });
  const { store, run } = await setup(t, { files: { 'config.json': config } });
  const report = await run();
  assert.strictEqual(report.skipped.keys, 1);
  assert.strictEqual(store.repos.providers.keyRecord('key_empty'), null);
  assert.match(describeImportWarnings(report), /1 key had no value and was skipped\./);
});

test('running the import again does nothing', async (t) => {
  const { store, run } = await setup(t, { files: all() });
  await run();
  assert.deepStrictEqual(await run(), { status: 'skipped' });
  assert.strictEqual(count(store, 'provider_keys'), 3);
  assert.strictEqual(count(store, 'test_runs'), 2);
});

test('an existing .imported.json is never overwritten', async (t) => {
  const { dir, run } = await setup(t, { files: { ...all(), 'config.imported.json': '{"from":"an earlier import"}' } });
  await run();
  assert.strictEqual(fs.readFileSync(path.join(dir, 'config.imported.json'), 'utf-8'), '{"from":"an earlier import"}');
  assert.ok(fs.existsSync(path.join(dir, `config.imported-${NOW}.json`)));
  assert.ok(!fs.existsSync(path.join(dir, 'config.json')));
});

test('a write that fails mid-import commits nothing and renames nothing', async (t) => {
  const { dir, store, run } = await setup(t, { files: all() });
  store.db.exec("CREATE TRIGGER fail_runs BEFORE INSERT ON test_runs BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  await assert.rejects(run(), (err) => err.code === 'IMPORT_WRITE' && /disk full/.test(err.message));
  assertNothingWritten(store);
  assert.deepStrictEqual(ls(dir), ['catalog.json', 'config.json', 'history.json']);
  store.db.exec('DROP TRIGGER fail_runs');
  assert.strictEqual((await run()).status, 'imported');
  assert.strictEqual(count(store, 'test_runs'), 2);
  assert.strictEqual(count(store, 'models'), 1);
});

test('re-import reads the .imported.json copies and leaves them in place', async (t) => {
  const files = { 'config.imported.json': legacyConfig(), 'catalog.imported.json': legacyCatalog(), 'history.imported.json': legacyHistory() };
  const { dir, store, run } = await setup(t, { files });
  assert.deepStrictEqual(listImportedFiles(dir), ['config.imported.json', 'catalog.imported.json', 'history.imported.json']);
  const report = await run({ source: 'imported' });
  assert.strictEqual(report.status, 'imported');
  assert.strictEqual(count(store, 'provider_keys'), 3);
  assert.deepStrictEqual(report.renamed, []);
  assert.deepStrictEqual(ls(dir), ['catalog.imported.json', 'config.imported.json', 'history.imported.json']);
});

test('needsReimportPrompt: offered only when saved copies are all that is left', () => {
  // The database was deleted: a fresh DB, no legacy files, saved copies present.
  assert.strictEqual(needsReimportPrompt({ importedAt: null, legacyPresent: false, savedCopies: 3 }), true);
  // Relaunch after an aborted re-import: still nothing imported, copies untouched.
  assert.strictEqual(needsReimportPrompt({ importedAt: null, legacyPresent: false, savedCopies: 1 }), true);
  // Legacy files present: a normal first import, no offer.
  assert.strictEqual(needsReimportPrompt({ importedAt: null, legacyPresent: true, savedCopies: 3 }), false);
  // Already imported, or a fresh install marked 'none'.
  assert.strictEqual(needsReimportPrompt({ importedAt: String(NOW), legacyPresent: false, savedCopies: 3 }), false);
  assert.strictEqual(needsReimportPrompt({ importedAt: 'none', legacyPresent: false, savedCopies: 3 }), false);
});

test('a rename that fails is reported, not fatal', async (t) => {
  const stubborn = {
    ...fs,
    renameSync(from, to) {
      if (path.basename(from) === 'history.json') {
        const e = new Error('EPERM: operation not permitted');
        e.code = 'EPERM';
        throw e;
      }
      return fs.renameSync(from, to);
    },
  };
  const { dir, store, run } = await setup(t, { files: all(), fsImpl: stubborn });
  const report = await run();
  assert.strictEqual(report.status, 'imported');
  assert.deepStrictEqual(report.renameFailed, ['history.json']);
  assert.strictEqual(count(store, 'test_runs'), 2);
  assert.ok(fs.existsSync(path.join(dir, 'history.json')));
  assert.match(describeImportWarnings(report), /history\.json was imported but could not be renamed/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/db/import-json.test.js`
Expected: FAIL with `Cannot find module '../../src/db/import-json'`.

- [ ] **Step 3: Write `src/db/import-json.js`**

```js
// ============================================
// One-shot import of the legacy JSON files
// ============================================
// config.json, catalog.json and history.json go into venom.db once, in one
// transaction, on the first launch of this version. The rules exist to keep
// the data (spec §2):
//   - every file is read, with retries, before anything is written; an I/O
//     error on any of them, or a damaged config.json, aborts with nothing
//     written, and the import runs again on the next launch;
//   - a damaged catalog.json or history.json is left out, renamed
//     *.unreadable.json and reported;
//   - ciphertext is copied as is; a plaintext key is encrypted on the way in,
//     and if it can't be, nothing is imported;
//   - after the commit the files are renamed *.imported.json. Nothing is
//     deleted. requests.log is not touched.
const nodeFs = require('fs');
const path = require('path');
const { ENC_PREFIX } = require('./cipher');

const FILES = { config: 'config.json', catalog: 'catalog.json', history: 'history.json' };
const READ_ATTEMPTS = 3;
const READ_GAP_MS = 200;
// Key ids must stay resolvable as venomkey:<id> placeholders (src/db/keys.js).
const KEY_ID = /^[A-Za-z0-9_.-]{1,64}$/;

class ImportAbort extends Error {
  constructor(code, message, file = null) {
    super(message);
    this.name = 'ImportAbort';
    this.code = code;
    this.file = file;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const renamedAs = (name, tag) => name.replace(/\.json$/i, `.${tag}.json`);
const plural = (n, one, many) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

// The copies an earlier import left behind (for the "database is missing" prompt).
function listImportedFiles(dir, fs = nodeFs) {
  return Object.values(FILES)
    .map((name) => renamedAs(name, 'imported'))
    .filter((name) => fs.existsSync(path.join(dir, name)));
}

// null when the file doesn't exist. Antivirus and OneDrive hold files open
// for a moment, hence the retries.
async function readWithRetry(file, fs, sleep) {
  let lastError = null;
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt += 1) {
    try {
      return fs.readFileSync(file, 'utf-8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      lastError = err;
      if (attempt < READ_ATTEMPTS) await sleep(READ_GAP_MS);
    }
  }
  throw new ImportAbort(
    'IMPORT_IO',
    `${path.basename(file)} could not be read (${lastError.code || lastError.message}). It may be open in another program, such as antivirus or OneDrive.`,
    file,
  );
}

function parse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function normaliseConfig(config, { cipher, now, report, log }) {
  const out = { providers: [], settings: null, test: null, window: null, aaCipher: null };
  if (!config) return out;
  const used = new Set();
  let serial = 0;
  const freshId = () => {
    let id;
    do {
      id = serial ? `key_${now()}_${serial}` : `key_${now()}`;
      serial += 1;
    } while (used.has(id));
    return id;
  };
  // Ciphertext is copied as is, so a locked key stays exactly what it was. A
  // plaintext value needs the OS keystore; without it nothing is imported.
  const sealed = (value, what) => {
    if (value.startsWith(ENC_PREFIX)) return value;
    if (!cipher.available()) {
      throw new ImportAbort('IMPORT_NO_ENCRYPTION', `Windows could not encrypt ${what}, so nothing was imported: a key is never stored as plain text. No file was changed.`);
    }
    return cipher.encrypt(value);
  };

  const providers = isObject(config.providers) ? config.providers : {};
  Object.entries(providers).forEach(([id, p], position) => {
    if (!isObject(p)) {
      throw new ImportAbort('IMPORT_BAD_ROW', `Provider "${id}" in config.json can't be read, so nothing was imported. No file was changed.`);
    }
    const keys = [];
    (Array.isArray(p.keys) ? p.keys : []).forEach((k) => {
      if (!isObject(k)) {
        throw new ImportAbort('IMPORT_BAD_ROW', `A key of provider "${id}" in config.json can't be read, so nothing was imported. No file was changed.`);
      }
      const value = typeof k.key === 'string' ? k.key : '';
      const label = (typeof k.name === 'string' && k.name) || (typeof k.id === 'string' && k.id) || 'unnamed';
      if (!value || value === ENC_PREFIX) {
        report.skipped.keys += 1;
        log.warn(`Skipped key "${label}" of ${id}: it has no value`);
        return;
      }
      let keyId = typeof k.id === 'string' ? k.id : '';
      if (!keyId) {
        keyId = freshId();
      } else if (!KEY_ID.test(keyId) || used.has(keyId)) {
        const old = keyId;
        keyId = freshId();
        report.reassignedKeys += 1;
        log.warn(`Key id "${old}" of ${id} was a duplicate or unusable; it is now ${keyId}`);
      }
      used.add(keyId);
      keys.push({
        id: keyId,
        name: typeof k.name === 'string' && k.name ? k.name : keyId,
        cipher: sealed(value, `the key "${label}"`),
        active: k.active !== false,
        quotaSpent: isObject(k.quotaSpent) ? k.quotaSpent : null,
      });
    });
    out.providers.push({
      id,
      name: typeof p.name === 'string' && p.name ? p.name : id,
      baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : '',
      rpm: Number.isFinite(p.rpm) ? p.rpm : null,
      custom: p.custom === true,
      position,
      keys,
    });
  });

  // Verbatim minus the AA key, so mediaPrompt and fields from other builds survive.
  if (isObject(config.settings)) {
    const { aaApiKey, ...rest } = config.settings;
    out.settings = rest;
    const aa = typeof aaApiKey === 'string' ? aaApiKey.trim() : '';
    if (aa && aa !== ENC_PREFIX) out.aaCipher = sealed(aa, 'the Artificial Analysis key');
  }
  if (isObject(config.test)) out.test = config.test;
  if (isObject(config.window)) out.window = config.window;
  return out;
}

function normaliseCatalog(catalog, report) {
  if (!catalog) return null;
  const models = {};
  Object.values(isObject(catalog.models) ? catalog.models : {}).forEach((e) => {
    if (!isObject(e) || typeof e.providerId !== 'string' || !e.providerId || typeof e.id !== 'string' || !e.id) {
      report.skipped.catalogEntries += 1;
      return;
    }
    models[`${e.providerId}::${e.id}`] = e;
  });
  const lastSync = {};
  Object.entries(isObject(catalog.lastSync) ? catalog.lastSync : {}).forEach(([pid, at]) => {
    if (Number.isFinite(at)) lastSync[pid] = at;
  });
  const keyModels = {};
  Object.entries(isObject(catalog.keyModels) ? catalog.keyModels : {}).forEach(([kid, v]) => {
    if (isObject(v) && Number.isFinite(v.count) && Number.isFinite(v.at)) keyModels[kid] = { count: v.count, at: v.at };
  });
  const out = { models, lastSync, keyModels };
  ['leaderboard', 'leaderboardError', 'profiles'].forEach((k) => {
    if (catalog[k] !== undefined) out[k] = catalog[k];
  });
  return out;
}

function normaliseHistory(history, report) {
  if (!history) return [];
  const runs = [];
  (Array.isArray(history.runs) ? history.runs : []).forEach((run) => {
    if (!isObject(run) || !Number.isFinite(run.at) || typeof run.provider !== 'string' || !run.provider) {
      report.skipped.runs += 1;
      return;
    }
    const results = [];
    (Array.isArray(run.results) ? run.results : []).forEach((r) => {
      if (!isObject(r) || typeof r.model !== 'string' || !r.model || typeof r.status !== 'string' || !r.status) {
        report.skipped.results += 1;
        return;
      }
      results.push(r);
    });
    runs.push({
      at: run.at,
      provider: run.provider,
      providerName: typeof run.providerName === 'string' && run.providerName ? run.providerName : run.provider,
      prompt: typeof run.prompt === 'string' ? run.prompt : '',
      results,
    });
  });
  return runs;
}

// rename() replaces an existing target on Windows, so a taken name gets a
// timestamp instead of being overwritten.
function renameAside(dir, name, tag, { fs, now, report, log }) {
  let to = renamedAs(name, tag);
  if (fs.existsSync(path.join(dir, to))) to = name.replace(/\.json$/i, `.${tag}-${now()}.json`);
  try {
    fs.renameSync(path.join(dir, name), path.join(dir, to));
    report.renamed.push({ from: name, to });
  } catch (err) {
    log.warn(`Could not rename ${name} after the import:`, err.message);
    report.renameFailed.push(name);
  }
}

async function importLegacy({
  dir, db, repos, cipher, log = console, fs = nodeFs,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, source = 'legacy',
}) {
  if (repos.meta.get('imported_from_json_at')) return { status: 'skipped' };

  const names = {};
  const texts = {};
  for (const [kind, base] of Object.entries(FILES)) {
    names[kind] = source === 'imported' ? renamedAs(base, 'imported') : base;
    texts[kind] = await readWithRetry(path.join(dir, names[kind]), fs, sleep);
  }
  if (Object.values(texts).every((text) => text === null)) {
    // Fresh install: marked, so a config.json that turns up later is never
    // imported over the providers the app has seeded by then.
    repos.meta.set('imported_from_json_at', 'none');
    return { status: 'none' };
  }

  const report = {
    status: 'imported',
    source,
    files: names,
    unreadable: [],
    skipped: { keys: 0, catalogEntries: 0, runs: 0, results: 0 },
    reassignedKeys: 0,
    renamed: [],
    renameFailed: [],
  };

  let config = null;
  if (texts.config !== null) {
    const parsed = parse(texts.config);
    if (!parsed.ok || !isObject(parsed.value)) {
      throw new ImportAbort(
        'IMPORT_CONFIG_PARSE',
        `${names.config} is damaged (${parsed.ok ? 'it is not a settings object' : parsed.error.message}), so nothing was imported. No file was changed.`,
        path.join(dir, names.config),
      );
    }
    config = parsed.value;
  }
  const readOptional = (kind) => {
    if (texts[kind] === null) return null;
    const parsed = parse(texts[kind]);
    if (parsed.ok && isObject(parsed.value)) return parsed.value;
    log.warn(`${names[kind]} is damaged and is not imported:`, parsed.ok ? 'not an object' : parsed.error.message);
    report.unreadable.push(kind);
    return null;
  };
  const catalog = readOptional('catalog');
  const history = readOptional('history');

  // Everything that can fail on bad input runs before the transaction.
  const plan = normaliseConfig(config, { cipher, now, report, log });
  const catalogRows = normaliseCatalog(catalog, report);
  const runs = normaliseHistory(history, report);

  const write = db.transaction(() => {
    plan.providers.forEach((p) => repos.providers.importProvider(p));
    if (plan.settings) repos.settings.set('settings', plan.settings);
    if (plan.test) repos.settings.set('test', plan.test);
    if (plan.window) repos.settings.set('window', plan.window);
    if (plan.aaCipher) repos.secrets.setCipher('aaApiKey', plan.aaCipher);
    if (catalogRows) repos.catalog.write(catalogRows, { reset: true });
    runs.forEach((run) => repos.history.insert(run));
    repos.meta.set('imported_from_json_at', String(now()));
  });
  try {
    write();
  } catch (err) {
    throw new ImportAbort('IMPORT_WRITE', `The saved data could not be written to venom.db (${err.message}), so nothing was imported. No file was changed.`);
  } finally {
    // The catalogue's row hashes may describe a write that was rolled back.
    repos.catalog.resetCache();
  }

  // A re-import leaves the *.imported.json copies where they are.
  if (source === 'legacy') {
    Object.keys(FILES).forEach((kind) => {
      if (texts[kind] === null) return;
      renameAside(dir, names[kind], report.unreadable.includes(kind) ? 'unreadable' : 'imported', { fs, now, report, log });
    });
  }
  log.info(`Imported ${names.config}, ${names.catalog}, ${names.history} into venom.db:`,
    JSON.stringify({ providers: plan.providers.length, runs: runs.length, skipped: report.skipped }));
  return report;
}

// The warning dialog text shown once the window is open; '' when all went in.
function describeImportWarnings(report) {
  if (!report || report.status !== 'imported') return '';
  const lines = [];
  report.unreadable.forEach((kind) => {
    const name = report.files[kind];
    const moved = report.renamed.find((r) => r.from === name);
    lines.push(moved ? `${name} is damaged and was not imported. It was renamed ${moved.to}.` : `${name} is damaged and was not imported.`);
  });
  const s = report.skipped;
  if (s.keys) lines.push(`${plural(s.keys, 'key had no value and was skipped', 'keys had no value and were skipped')}.`);
  if (s.catalogEntries) lines.push(`${plural(s.catalogEntries, 'damaged model pool entry was skipped', 'damaged model pool entries were skipped')}.`);
  if (s.runs) lines.push(`${plural(s.runs, 'damaged test run was skipped', 'damaged test runs were skipped')}.`);
  if (s.results) lines.push(`${plural(s.results, 'damaged test result was skipped', 'damaged test results were skipped')}.`);
  if (report.reassignedKeys) {
    lines.push(`${plural(report.reassignedKeys, 'key had a duplicate or unusable id and got a new one', 'keys had a duplicate or unusable id and got a new one')}.`);
  }
  report.renameFailed.forEach((name) => lines.push(`${name} was imported but could not be renamed; it is ignored from now on.`));
  return lines.join('\n');
}

// The "database is missing" offer. Decided on the database's own state, not
// on whether venom.db existed at launch: after a re-import that aborted, the
// file exists but nothing was imported, and the offer must come back.
function needsReimportPrompt({ importedAt, legacyPresent, savedCopies }) {
  return importedAt === null && !legacyPresent && savedCopies > 0;
}

module.exports = { importLegacy, listImportedFiles, describeImportWarnings, needsReimportPrompt, ImportAbort, FILES };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/db/import-json.test.js`
Expected: `pass 18`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/db/import-json.js test/db/import-json.test.js
git commit -m "feat(db): one-shot legacy JSON importer with abort, skip and rename rules"
```

---

### Task 9: Data IPC registration

**Files:**
- Create: `src/db/ipc.js`
- Test: `test/db/ipc.test.js`

**Interfaces:**
- Consumes: every repository (Tasks 3-7).
- Produces:
  - `registerDataIpc({ ipcMain, repos, log?, plaintextKeys? })` — registers `read-config`, `save-settings`, `save-secret`, `save-test-definition`, `save-provider`, `merge-provider`, `delete-provider`, `read-catalog`, `write-catalog`, `read-history`, `append-run`, `clear-history`. A throwing handler rejects the renderer's promise.
  - Return values: `save-settings`/`save-test-definition`/`clear-history` → `{ success: true }`; `save-secret` → `{ placeholder: 'venomsecret:<name>' | '' }`; `save-provider`/`merge-provider` → the provider as `read-config` shows it; `delete-provider` → `{ deleted }`; `write-catalog` → `{ written, deleted }` (reset only when `opts.reset === true`); `append-run` → `{ id, runUid }`.
  - `readConfig(repos, { plaintext }) → { version: 1, providers, settings?, test?, window? }`.
  - `plaintextKeys: true` (phase 1 only, removed in Task 16): keys and `settings.aaApiKey` go out as plaintext.

- [ ] **Step 1: Write the failing test**

`test/db/ipc.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { registerDataIpc } = require('../../src/db/ipc');
const { memoryStore, quietLog } = require('../helpers');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle(channel, fn) {
      if (handlers.has(channel)) throw new Error(`Registered twice: ${channel}`);
      handlers.set(channel, fn);
    },
    invoke: async (channel, ...args) => handlers.get(channel)({}, ...args),
    channels: () => [...handlers.keys()].sort(),
  };
}

async function setup(t, opts = {}) {
  const store = await memoryStore(t);
  const ipc = fakeIpcMain();
  registerDataIpc({ ipcMain: ipc, repos: store.repos, log: quietLog, ...opts });
  return { store, ipc };
}

const nara = (keys) => ({ id: 'nara', name: 'NaraRouter', baseUrl: 'https://router.bynara.id/v1', rpm: null, keys });

test('registers exactly the data channels', async (t) => {
  const { ipc } = await setup(t);
  assert.deepStrictEqual(ipc.channels(), [
    'append-run', 'clear-history', 'delete-provider', 'merge-provider', 'read-catalog', 'read-config',
    'read-history', 'save-provider', 'save-secret', 'save-settings', 'save-test-definition', 'write-catalog',
  ]);
});

test('read-config on an empty database', async (t) => {
  const { ipc } = await setup(t);
  assert.deepStrictEqual(await ipc.invoke('read-config'), { version: 1, providers: {} });
});

test('read-config reveals keys and the AA key only when plaintextKeys is on', async (t) => {
  const plain = await setup(t, { plaintextKeys: true });
  await plain.ipc.invoke('save-provider', nara([{ id: 'key_1', name: 'Main', key: 'sk-nara-1', active: true }]));
  await plain.ipc.invoke('save-secret', 'aaApiKey', 'aa-secret');
  const open = await plain.ipc.invoke('read-config');
  assert.strictEqual(open.providers.nara.keys[0].key, 'sk-nara-1');
  assert.strictEqual(open.settings.aaApiKey, 'aa-secret');

  const sealed = await setup(t);
  await sealed.ipc.invoke('save-provider', nara([{ id: 'key_1', name: 'Main', key: 'sk-nara-1', active: true }]));
  await sealed.ipc.invoke('save-secret', 'aaApiKey', 'aa-secret');
  const closed = await sealed.ipc.invoke('read-config');
  assert.strictEqual(closed.providers.nara.keys[0].key, 'venomkey:key_1');
  assert.strictEqual(closed.settings.aaApiKey, 'venomsecret:aaApiKey');
});

test('save-settings drops aaApiKey; settings, test and window come back in read-config', async (t) => {
  const { store, ipc } = await setup(t);
  assert.deepStrictEqual(await ipc.invoke('save-settings', { theme: 'daylight', aaApiKey: 'aa-typed' }), { success: true });
  assert.deepStrictEqual(await ipc.invoke('save-test-definition', { prompt: 'p', expected: 'e', autoMinutes: 0 }), { success: true });
  store.repos.settings.set('window', { width: 1200, height: 800, maximized: false });
  assert.deepStrictEqual(await ipc.invoke('read-config'), {
    version: 1,
    providers: {},
    settings: { theme: 'daylight', aaApiKey: '' },
    test: { prompt: 'p', expected: 'e', autoMinutes: 0 },
    window: { width: 1200, height: 800, maximized: false },
  });
  assert.strictEqual(store.repos.secrets.has('aaApiKey'), false);
});

test('save-secret answers with the placeholder, or empty after a delete', async (t) => {
  const { ipc } = await setup(t);
  assert.deepStrictEqual(await ipc.invoke('save-secret', 'aaApiKey', 'aa-secret'), { placeholder: 'venomsecret:aaApiKey' });
  assert.deepStrictEqual(await ipc.invoke('save-secret', 'aaApiKey', ''), { placeholder: '' });
});

test('save-provider, merge-provider and delete-provider', async (t) => {
  const { ipc } = await setup(t);
  const saved = await ipc.invoke('save-provider', nara([{ id: 'key_1', name: 'Main', key: 'sk-1', active: true }]));
  assert.deepStrictEqual(saved.keys.map((k) => k.id), ['key_1']);
  await ipc.invoke('save-provider', { id: 'custom_1', name: 'Old', baseUrl: 'https://router.bynara.id/v1/', rpm: null, custom: true,
    keys: [{ id: 'key_2', name: 'Extra', key: 'sk-2', active: true }] });
  const merged = await ipc.invoke('merge-provider', 'custom_1', 'nara');
  assert.deepStrictEqual(merged.keys.map((k) => k.id), ['key_1', 'key_2']);
  assert.deepStrictEqual(await ipc.invoke('delete-provider', 'nara'), { deleted: true });
  assert.deepStrictEqual((await ipc.invoke('read-config')).providers, {});
});

test('write-catalog resets only on reset === true', async (t) => {
  const { ipc } = await setup(t);
  const entry = { key: 'nara::m1', providerId: 'nara', id: 'm1', name: 'm1', removedAt: null, isNew: false, keyIds: [] };
  assert.deepStrictEqual(await ipc.invoke('write-catalog', { models: { 'nara::m1': entry } }), { written: 1, deleted: 0 });
  await assert.rejects(ipc.invoke('write-catalog', { models: {} }, { reset: 'yes' }), /Refusing to empty/);
  assert.deepStrictEqual(await ipc.invoke('write-catalog', { models: {} }, { reset: true }), { written: 0, deleted: 1 });
  assert.deepStrictEqual((await ipc.invoke('read-catalog')).models, {});
});

test('append-run returns the new ids; read-history and clear-history', async (t) => {
  const { ipc } = await setup(t);
  const out = await ipc.invoke('append-run', { at: 1, provider: 'nara', providerName: 'N', prompt: 'p', results: [] }, 300);
  assert.strictEqual(typeof out.id, 'number');
  assert.strictEqual(typeof out.runUid, 'string');
  assert.deepStrictEqual((await ipc.invoke('read-history')).runs.map((r) => r.id), [out.id]);
  assert.deepStrictEqual(await ipc.invoke('clear-history'), { success: true });
  assert.deepStrictEqual((await ipc.invoke('read-history')).runs, []);
});

test('a handler that fails rejects the call', async (t) => {
  const { ipc } = await setup(t);
  await assert.rejects(ipc.invoke('save-settings', null), /must be an object/);
  await assert.rejects(ipc.invoke('merge-provider', 'ghost', 'nara'), /not found/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/db/ipc.test.js`
Expected: FAIL with `Cannot find module '../../src/db/ipc'`.

- [ ] **Step 3: Write `src/db/ipc.js`**

```js
// ============================================
// Data IPC — the renderer's only way to the database
// ============================================
// Each channel reads or writes one thing, so two writers no longer overwrite
// each other's sections of one big file. A handler that fails throws: the
// renderer's promise rejects and it says so. Nothing is swallowed here.
function readConfig(repos, { plaintext = false } = {}) {
  const providers = repos.providers.list();
  if (plaintext) Object.values(providers).forEach((p) => revealKeys(repos, p));
  const data = { version: 1, providers };
  const settings = repos.settings.get('settings');
  const aa = plaintext
    ? repos.secrets.reveal('aaApiKey') || ''
    : repos.secrets.has('aaApiKey') ? 'venomsecret:aaApiKey' : '';
  if (settings || aa) data.settings = { ...(settings || {}), aaApiKey: aa };
  const test = repos.settings.get('test');
  if (test) data.test = test;
  const win = repos.settings.get('window');
  if (win) data.window = win;
  return data;
}

// Until the renderer works with placeholders, it still gets each key's
// plaintext. Removed when keys stay in main.
function revealKeys(repos, provider) {
  if (!provider) return provider;
  provider.keys.forEach((k) => {
    if (!k.locked) k.key = repos.providers.revealKey(k.id) || '';
  });
  return provider;
}

function registerDataIpc({ ipcMain, repos, log = console, plaintextKeys = false }) {
  const opts = { plaintext: plaintextKeys };
  const out = (provider) => (plaintextKeys ? revealKeys(repos, provider) : provider);
  const handle = (channel, fn) => {
    ipcMain.handle(channel, (_event, ...args) => {
      try {
        return fn(...args);
      } catch (err) {
        log.error(`${channel} failed:`, err.message);
        throw err;
      }
    });
  };

  handle('read-config', () => readConfig(repos, opts));
  handle('save-settings', (settings) => {
    repos.settings.saveSettings(settings);
    return { success: true };
  });
  handle('save-secret', (name, value) => ({ placeholder: repos.secrets.save(name, value) ? `venomsecret:${name}` : '' }));
  handle('save-test-definition', (test) => {
    repos.settings.saveTest(test);
    return { success: true };
  });
  handle('save-provider', (provider) => out(repos.providers.save(provider)));
  handle('merge-provider', (fromId, intoId) => out(repos.providers.merge(fromId, intoId)));
  handle('delete-provider', (id) => ({ deleted: repos.providers.remove(id) }));
  handle('read-catalog', () => repos.catalog.read());
  handle('write-catalog', (catalog, writeOpts) => repos.catalog.write(catalog, { reset: !!writeOpts && writeOpts.reset === true }));
  handle('read-history', () => repos.history.read());
  handle('append-run', (run, maxRuns) => repos.history.append(run, maxRuns));
  handle('clear-history', () => {
    repos.history.clear();
    return { success: true };
  });
}

module.exports = { registerDataIpc, readConfig };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/db/ipc.test.js`
Expected: `pass 9`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/db/ipc.js test/db/ipc.test.js
git commit -m "feat(db): register the data IPC channels"
```

### Task 10: Main process wiring, preload, live launcher

**Files:**
- Modify: `src/main.js` (imports; remove the JSON stores; startup; window state; IPC)
- Modify: `src/preload.js:18-29`
- Create: `scripts/live/cdp.mjs`

**Interfaces:**
- Consumes: `database.open`, `DB_FILE` (Task 3); `createCipher` (Task 2); `importLegacy`, `listImportedFiles`, `describeImportWarnings`, `needsReimportPrompt`, `FILES` (Task 8); `registerDataIpc` (Task 9).
- Produces:
  - Main: `store` (open DB) and startup behaviour of spec §1-2 (dialogs for open failure, newer schema, missing DB with saved copies, import abort; import warnings after the window loads). `saveWindowState()` writes the `window` row.
  - Preload `window.electronAPI`: `readConfig()`, `saveSettings(settings)`, `saveSecret(name, value)`, `saveTestDefinition(test)`, `saveProvider(provider)`, `mergeProvider(fromId, intoId)`, `deleteProvider(id)`, `readHistory()`, `appendRun(run, maxRuns)`, `clearHistory()`, `readCatalog()`, `writeCatalog(data, opts)`. `writeConfig` is gone.
  - `scripts/live/cdp.mjs`: `assertScratchDir(dir)`, `launch({ userDataDir, port? }) → { child, evaluate(expr, ms?), waitFor(expr, ms?), close(ms?) → exitCode, exited, output() }`.

- [ ] **Step 1: Replace the imports at the top of `src/main.js`**

Replace:
```js
const { app, BrowserWindow, ipcMain, Notification, shell } = require('electron');
const path = require('path');
const https = require('https');
const http = require('http');
const fs = require('fs');
const log = require('electron-log');
const {
  ENC_PREFIX,
  decryptKeyEntry,
  encryptKeyEntry,
  eachStoredKey,
  countPlaintextKeys,
} = require('./keystore');
const { resolveUserDataDir } = require('./user-data');
```
with:
```js
const { app, BrowserWindow, ipcMain, Notification, shell, dialog, safeStorage } = require('electron');
const path = require('path');
const https = require('https');
const http = require('http');
const fs = require('fs');
const log = require('electron-log');
const { resolveUserDataDir } = require('./user-data');
const database = require('./db');
const { createCipher } = require('./db/cipher');
const { importLegacy, listImportedFiles, describeImportWarnings, needsReimportPrompt, FILES } = require('./db/import-json');
const { registerDataIpc } = require('./db/ipc');
```

- [ ] **Step 2: Keep dev builds off the real data folder, remove the JSON stores, add the database startup**

> **Superseded:** commit `fba2d91` (2026-09-26) replaced the dev-vs-packaged split
> below with the plain `resolveUserDataDir` call again — the owner runs and tests
> `npm start` on the real data folder. The snippet is left as written for history.

A dev build (`npm start`) must never import or rename the installed app's data. Replace:
```js
if (!app.commandLine.hasSwitch('user-data-dir')) {
  const userData = resolveUserDataDir(app.getPath('appData'), fs);
  app.setPath('userData', userData.dir);
  if (userData.migrated) log.info('Moved app data to', userData.dir);
  if (userData.error) log.warn('Could not move the old app data folder, still using it:', userData.error.message);
}
```
with:
```js
if (!app.commandLine.hasSwitch('user-data-dir')) {
  if (!app.isPackaged) {
    // A dev build never touches the installed app's data folder.
    app.setPath('userData', path.join(app.getPath('appData'), 'venom-router-dev'));
  } else {
    const userData = resolveUserDataDir(app.getPath('appData'), fs);
    app.setPath('userData', userData.dir);
    if (userData.migrated) log.info('Moved app data to', userData.dir);
    if (userData.error) log.warn('Could not move the old app data folder, still using it:', userData.error.message);
  }
}
```
Do not launch the app without `--user-data-dir` to test this guard; it is reviewed in code.

Then remove the JSON stores. In `src/main.js`, delete the whole block that starts at
```js
let autoUpdater; // Lazy load after app ready
let updateCheckInterval;
let configPath;

const CONFIG_VERSION = 1;
```
and ends with the closing brace of `saveWindowState` (currently lines 25-216):
```js
function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const data = readConfig();
    data.window = { ...mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() };
    writeConfig(data);
  } catch (err) {
    log.warn('Could not save window state:', err.message);
  }
}
```
That block holds `getDefaultConfig`, `getConfigPath`, `readConfig`, `ensureConfig`, `migrateConfigSecrets`, `writeConfig`, the "Run history" section (`HISTORY_VERSION` … `appendRun`), the "Model pool — catalog.json" section (`CATALOG_VERSION` … `writeCatalog`), `let mainWindow;` and `saveWindowState`. Put this in its place:
```js
let autoUpdater; // Lazy load after app ready
let updateCheckInterval;

// ============================================
// Local database — venom.db (src/db)
// ============================================
// Opened once, before the window, and closed on quit. A failure to open or to
// import stops the app with the reason on screen: carrying on with an empty
// store is how keys used to get overwritten.
let store = null;
let importReport = null;

function showStartupError(message, detail) {
  dialog.showErrorBox('VENOM Router', `${message}\n\n${detail}`);
}

async function startDatabase() {
  const dir = app.getPath('userData');
  const dbPath = path.join(dir, database.DB_FILE);
  const cipher = createCipher(safeStorage);
  try {
    store = await database.open(dir, { cipher, log });
    store.repos.meta.set('app_version', app.getVersion());
  } catch (err) {
    log.error('Could not open venom.db:', err);
    showStartupError(
      err.code === 'DB_TOO_NEW'
        ? 'This data was written by a newer VENOM Router. Update the app to open it.'
        : 'VENOM Router could not open its database, so it will close. Nothing was changed.',
      `${dbPath}\n\n${err.message}`,
    );
    if (store) store.close();
    store = null;
    return false;
  }

  // Nothing imported yet, no legacy JSON left, but saved copies from an
  // earlier import: the database was deleted or moved, or a re-import
  // aborted. Starting empty without asking would look like every key had
  // been lost.
  let source = 'legacy';
  const saved = listImportedFiles(dir);
  if (needsReimportPrompt({
    importedAt: store.repos.meta.get('imported_from_json_at'),
    legacyPresent: Object.values(FILES).some((name) => fs.existsSync(path.join(dir, name))),
    savedCopies: saved.length,
  })) {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: 'VENOM Router',
      message: 'The VENOM Router database is missing.',
      detail: `It may have been deleted or moved. The files from the earlier import are still in\n${dir}:\n\n${saved.join('\n')}\n\nRe-import them, or start with no providers, keys or history.`,
      buttons: ['Re-import from the saved files', 'Start empty'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (choice === 0) source = 'imported';
  }

  try {
    importReport = await importLegacy({ dir, db: store.db, repos: store.repos, cipher, log, source });
  } catch (err) {
    log.error('Import of the saved JSON files failed:', err);
    showStartupError(
      `VENOM Router could not import its saved data, so it will close.\n\n${err.message}`,
      `${err.file || dir}\n\nThe import runs again the next time VENOM Router starts.`,
    );
    store.close();
    store = null;
    return false;
  }
  return true;
}

let mainWindow;

// Damaged files and skipped rows from the import, said once the window is up.
function showImportWarnings() {
  const detail = describeImportWarnings(importReport);
  importReport = null;
  if (!detail || !mainWindow) return;
  dialog.showMessageBox(mainWindow, { type: 'warning', title: 'VENOM Router', message: 'Some saved data could not be imported.', detail });
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed() || !store) return;
  try {
    store.repos.settings.set('window', { ...mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() });
  } catch (err) {
    log.warn('Could not save window state:', err.message);
  }
}
```

- [ ] **Step 3: Read the window row in `createWindow` and show import warnings after load**

Replace:
```js
  const saved = (readConfig().window) || {};
```
with:
```js
  const saved = (store && store.repos.settings.get('window')) || {};
```

Replace:
```js
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('app-version', app.getVersion());
  });
```
with:
```js
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('app-version', app.getVersion());
    showImportWarnings();
  });
```

- [ ] **Step 4: Open the database before the window; close it on quit**

Replace:
```js
app.whenReady().then(() => {
  ensureConfig();
  migrateConfigSecrets();
  initAutoUpdater();
  createWindow();
  startUpdateChecks();
});

app.on('will-quit', () => {
  stopUpdateChecks();
});
```
with:
```js
app.whenReady().then(async () => {
  if (!(await startDatabase())) {
    app.quit();
    return;
  }
  // Keys still reach the renderer as plaintext here; they stay in main once
  // the renderer works with placeholders.
  registerDataIpc({ ipcMain, repos: store.repos, log, plaintextKeys: true });
  initAutoUpdater();
  createWindow();
  startUpdateChecks();
});

app.on('will-quit', () => {
  stopUpdateChecks();
  if (store) {
    store.close();
    store = null;
  }
});
```

- [ ] **Step 5: Remove the old history, catalogue and config handlers**

Delete:
```js
// History IPC handlers
ipcMain.handle('read-history', () => readHistory());
ipcMain.handle('append-run', (event, run, maxRuns) => appendRun(run, maxRuns));
ipcMain.handle('clear-history', () => {
  try {
    writeHistory({ version: HISTORY_VERSION, runs: [] });
    return { success: true };
  } catch (err) {
    log.error('Failed to clear history:', err);
    return { success: false, error: err.message };
  }
});

// Catalog IPC handlers
ipcMain.handle('read-catalog', () => readCatalog());
ipcMain.handle('write-catalog', (event, data) => writeCatalog(data));

```
and delete:
```js
// Config IPC handlers
ipcMain.handle('read-config', () => {
  return readConfig();
});

ipcMain.handle('write-config', (event, data) => {
  return writeConfig(data);
});

```

Run: `grep -nE "readConfig|writeConfig|readHistory|writeHistory|readCatalog|writeCatalog|getConfigPath|require\('./keystore'\)|decryptKeyEntry|encryptKeyEntry" src/main.js`
Expected: no output.

Run: `node --check src/main.js`
Expected: no output (exit 0).

- [ ] **Step 6: Replace the data calls in `src/preload.js`**

Replace:
```js
  // Config file operations
  readConfig: () => ipcRenderer.invoke('read-config'),
  writeConfig: (data) => ipcRenderer.invoke('write-config', data),

  // Run history
  readHistory: () => ipcRenderer.invoke('read-history'),
  appendRun: (run, maxRuns) => ipcRenderer.invoke('append-run', run, maxRuns),
  clearHistory: () => ipcRenderer.invoke('clear-history'),

  // Model pool (models seen per provider + benchmark results)
  readCatalog: () => ipcRenderer.invoke('read-catalog'),
  writeCatalog: (data) => ipcRenderer.invoke('write-catalog', data),
```
with:
```js
  // Saved data (venom.db, owned by main). Each call writes one thing.
  readConfig: () => ipcRenderer.invoke('read-config'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  saveSecret: (name, value) => ipcRenderer.invoke('save-secret', name, value),
  saveTestDefinition: (test) => ipcRenderer.invoke('save-test-definition', test),
  saveProvider: (provider) => ipcRenderer.invoke('save-provider', provider),
  mergeProvider: (fromId, intoId) => ipcRenderer.invoke('merge-provider', fromId, intoId),
  deleteProvider: (id) => ipcRenderer.invoke('delete-provider', id),

  // Run history
  readHistory: () => ipcRenderer.invoke('read-history'),
  appendRun: (run, maxRuns) => ipcRenderer.invoke('append-run', run, maxRuns),
  clearHistory: () => ipcRenderer.invoke('clear-history'),

  // Model pool (models seen per provider + benchmark results). opts.reset is
  // sent only by the Clear and Reset buttons.
  readCatalog: () => ipcRenderer.invoke('read-catalog'),
  writeCatalog: (data, opts) => ipcRenderer.invoke('write-catalog', data, opts),
```

Run: `node --check src/preload.js`
Expected: no output.

- [ ] **Step 7: Write the live launcher `scripts/live/cdp.mjs`**

```js
// Launches a separate VENOM Router on a scratch data folder with remote
// debugging, and drives it over CDP with Node's own fetch and WebSocket (no
// packages). Used by the live checks; never pointed at the owner's data.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Required from plain Node, the electron package exports the binary's path.
const ELECTRON = require('electron');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Refuses anything inside %APPDATA%, where the owner's venom-router folder lives.
export function assertScratchDir(dir) {
  const full = path.resolve(dir).toLowerCase();
  const appData = process.env.APPDATA ? path.resolve(process.env.APPDATA).toLowerCase() : null;
  if (appData && (full === appData || full.startsWith(appData + path.sep))) {
    throw new Error(`Refusing to use ${dir}: it is inside %APPDATA%`);
  }
}

// NODE_ENV=development skips the update check (no GitHub traffic), and
// ELECTRON_RUN_AS_NODE must not leak in from a test shell.
export function appEnv() {
  const env = { ...process.env, NODE_ENV: 'development' };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export { ROOT, ELECTRON };

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms: ${what}`)), ms);
    }),
  ]);
}

export async function launch({ userDataDir, port = 9333 }) {
  assertScratchDir(userDataDir);
  const child = spawn(ELECTRON, [
    '.',
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    // Windows stops painting an occluded window, which stalls CDP calls.
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ], { cwd: ROOT, env: appEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i += 1) {
    await sleep(500);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch (_) {
      // Not listening yet.
    }
  }
  if (!wsUrl) {
    child.kill();
    throw new Error(`The app did not open a debuggable window.\n${output}`);
  }

  const ws = new WebSocket(wsUrl);
  await withTimeout(new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }), 10000, 'CDP connect');
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}, ms = 30000) => {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return withTimeout(new Promise((resolve) => pending.set(id, resolve)), ms, method);
  };

  // Evaluates in the page's global scope (app.js globals are visible) and
  // returns the value; a returned promise is awaited.
  async function evaluate(expression, ms = 30000) {
    const msg = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, ms);
    if (msg.error) throw new Error(msg.error.message);
    const r = msg.result;
    if (r.exceptionDetails) {
      throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    }
    return r.result.value;
  }

  async function waitFor(expression, ms = 20000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        if (await evaluate(expression, 5000)) return true;
      } catch (_) {
        // Page still loading.
      }
      await sleep(250);
    }
    throw new Error(`Timed out waiting for: ${expression}`);
  }

  // Closes through the app's own close path (the title-bar X), so whatever
  // runs on close runs. Kills its own process only if it doesn't exit.
  async function close(ms = 15000) {
    try {
      ws.send(JSON.stringify({ id: nextId++, method: 'Runtime.evaluate', params: { expression: 'window.electronAPI.close()' } }));
    } catch (_) {
      // Socket already gone.
    }
    const code = await Promise.race([exited, sleep(ms).then(() => 'timeout')]);
    try { ws.close(); } catch (_) { /* already closed */ }
    if (code === 'timeout') {
      child.kill();
      await exited;
      throw new Error(`The app did not exit within ${ms} ms of closing its window`);
    }
    return code;
  }

  return { child, evaluate, waitFor, close, exited, output: () => output };
}
```

- [ ] **Step 8: Live startup check on a fresh scratch folder**

Create the scratch file `scripts/live/_startup-check.mjs` (deleted in this step, never committed):
```js
// Scratch check for Task 10. Delete after running.
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launch } from './cdp.mjs';

const dir = mkdtempSync(join(tmpdir(), 'venom-startup-'));
let ok = true;
const app = await launch({ userDataDir: dir });
try {
  await app.waitFor("typeof window.electronAPI.saveProvider === 'function'");
  const cfg = await app.evaluate('window.electronAPI.readConfig()');
  console.log('read-config:', JSON.stringify(cfg).slice(0, 160));
  ok = ok && cfg.version === 1 && typeof cfg.providers === 'object';
  ok = ok && (await app.evaluate('typeof window.electronAPI.writeConfig')) === 'undefined';
  ok = ok && existsSync(join(dir, 'venom.db'));
  console.log('venom.db exists:', existsSync(join(dir, 'venom.db')));
} finally {
  const code = await app.close().catch((err) => { console.error(err.message); return 1; });
  ok = ok && code === 0;
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
console.log(ok ? 'STARTUP CHECK PASSED' : 'STARTUP CHECK FAILED');
process.exit(ok ? 0 : 1);
```
Run: `node scripts/live/_startup-check.mjs`
Expected: `read-config: {"version":1,"providers":{}...`, `venom.db exists: true`, `STARTUP CHECK PASSED`. (The renderer still calls the removed `writeConfig` inside a try/catch until Tasks 11-12, so providers stay empty here.)

```bash
rm scripts/live/_startup-check.mjs
```

- [ ] **Step 9: Run the unit tests**

Run: `npm test`
Expected: `pass 97`, `fail 0`.

- [ ] **Step 10: Commit**

```bash
git add src/main.js src/preload.js scripts/live/cdp.mjs
git commit -m "feat(db): open venom.db and import legacy JSON at startup; typed data IPC in preload"
```

---

### Task 11: Renderer — persist(), startup read gate, settings, test prompt, history

**Files:**
- Modify: `src/renderer/app.js` (sections quoted below)
- Modify: `src/renderer/catalog.js:1109-1114` (AA key input saves the secret)
- Modify: `src/renderer/index.html` (banner inside `<main class="shell-main">`)
- Modify: `src/renderer/styles.css` (banner style, after `.shell-page[hidden]`)

**Interfaces:**
- Consumes: preload calls from Task 10.
- Produces (globals in `app.js`, shared with the other renderer scripts):
  - `storeReadError: string | null`; `failStartupRead(what: string, err)` — shows the banner, sets the gate.
  - `persist(what: string, call: () => Promise<T>) → Promise<T | undefined>` — refuses when gated, reports failures in the status bar and console, tracks in-flight writes in `pendingSaves: Set<Promise>`.
  - `saveSettingsNow() → Promise`, `saveSettingsTimer` (null when nothing is queued), `saveTestDefinition() → Promise`, `saveTestTimer`.
  - `foldRun(run)`, `capHistory()`, `historyCap() → number`; history entries carry `seq`.

- [ ] **Step 1: Add the banner markup**

In `src/renderer/index.html` replace:
```html
    <main class="shell-main">
      <!-- Page header: fixed above every page. Left: the page's identity.
```
with:
```html
    <main class="shell-main">
      <!-- Shown when saved data could not be read at startup. Nothing is saved
           for the rest of the session, so defaults never overwrite real data. -->
      <div class="store-error" id="store-error" role="alert" hidden>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
        <span id="store-error-text"></span>
      </div>
      <!-- Page header: fixed above every page. Left: the page's identity.
```

- [ ] **Step 2: Style it**

In `src/renderer/styles.css` replace:
```css
.shell-page[hidden] {
  display: none;
}
```
with:
```css
.shell-page[hidden] {
  display: none;
}

/* Saved data could not be read at startup; every write is refused (app.js persist). */
.store-error {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  background: var(--fail-bg);
  border-bottom: 1px solid var(--fail);
  color: var(--text-1);
  font-size: 13px;
  line-height: 1.4;
}
.store-error[hidden] { display: none; }
.store-error svg { flex: none; color: var(--fail); }
```

- [ ] **Step 3: Add `persist()` and the read gate**

In `src/renderer/app.js` replace:
```js
// ============================================
// Persistence — JSON config file
// ============================================
async function saveProviderConfig(providerId) {
```
with:
```js
// ============================================
// Saving — every write goes through persist()
// ============================================
// Writes are small typed calls into main (venom.db). A failure is shown in the
// status bar, never swallowed. If saved data could not be read at startup,
// every write is refused for the rest of the session: the app is then showing
// defaults, and saving them would overwrite the real data.
let storeReadError = null;
const pendingSaves = new Set();

// "Error invoking remote method 'save-settings': TypeError: …" → "…"
function ipcMessage(err) {
  return String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, '');
}

function failStartupRead(what, err) {
  console.error(`Could not read ${what} at startup:`, err);
  if (!storeReadError) storeReadError = `${what}: ${ipcMessage(err)}`;
  const banner = $('#store-error');
  if (banner) {
    banner.hidden = false;
    $('#store-error-text').textContent = `Saved data could not be read (${storeReadError}). Nothing will be saved this session — close VENOM Router and open it again.`;
  }
  setStatus('error', 'Saved data could not be read — changes are not being saved');
}

// Runs one write. Resolves with its result, or undefined when it was refused
// or failed (already reported).
async function persist(what, call) {
  if (storeReadError) {
    setStatus('error', `Couldn't ${what}: saved data could not be read at startup, so nothing is saved this session`);
    return undefined;
  }
  const job = Promise.resolve().then(call);
  pendingSaves.add(job);
  try {
    return await job;
  } catch (err) {
    console.error(`Couldn't ${what}:`, err);
    setStatus('error', `Couldn't ${what}: ${ipcMessage(err)}`);
    return undefined;
  } finally {
    pendingSaves.delete(job);
  }
}

// ============================================
// Providers — each saved on its own (save-provider)
// ============================================
async function saveProviderConfig(providerId) {
```

- [ ] **Step 4: `loadSettings` no longer swallows a failed read**

Replace:
```js
async function loadSettings() {
  try {
    const data = await window.electronAPI.readConfig();
    if (data.settings && typeof data.settings === 'object') {
      Object.keys(DEFAULT_SETTINGS).forEach((k) => {
        const v = data.settings[k];
        if (typeof v === typeof DEFAULT_SETTINGS[k]) settings[k] = v;
      });
      // One prompt used to drive both generators; it seeds both of their own.
      const legacy = data.settings.mediaPrompt;
      if (typeof legacy === 'string' && legacy.trim()) {
        if (typeof data.settings.imagePrompt !== 'string') settings.imagePrompt = legacy;
        if (typeof data.settings.videoPrompt !== 'string') settings.videoPrompt = legacy;
      }
    }
  } catch (_) {}
```
with:
```js
// A failed read throws to init(), which shows it and blocks every write.
async function loadSettings() {
  const data = await window.electronAPI.readConfig();
  if (data.settings && typeof data.settings === 'object') {
    Object.keys(DEFAULT_SETTINGS).forEach((k) => {
      const v = data.settings[k];
      if (typeof v === typeof DEFAULT_SETTINGS[k]) settings[k] = v;
    });
    // One prompt used to drive both generators; it seeds both of their own.
    const legacy = data.settings.mediaPrompt;
    if (typeof legacy === 'string' && legacy.trim()) {
      if (typeof data.settings.imagePrompt !== 'string') settings.imagePrompt = legacy;
      if (typeof data.settings.videoPrompt !== 'string') settings.videoPrompt = legacy;
    }
  }
```

- [ ] **Step 5: Settings save becomes one `save-settings` call**

Replace:
```js
let saveSettingsTimer = null;
function queueSettingsSave() {
  clearTimeout(saveSettingsTimer);
  saveSettingsTimer = setTimeout(async () => {
    try {
      const data = await window.electronAPI.readConfig();
      data.settings = { ...settings };
      await window.electronAPI.writeConfig(data);
    } catch (err) {
      console.warn('Failed to persist settings:', err);
    }
  }, 350);
}
```
with:
```js
// One row, written on its own: no read-modify-write, so it can't undo a key
// or provider change made meanwhile. aaApiKey is dropped by main (the key is
// a secret, saved with saveSecret).
let saveSettingsTimer = null;
function saveSettingsNow() {
  clearTimeout(saveSettingsTimer);
  saveSettingsTimer = null;
  return persist('save settings', () => window.electronAPI.saveSettings({ ...settings }));
}

function queueSettingsSave() {
  clearTimeout(saveSettingsTimer);
  saveSettingsTimer = setTimeout(saveSettingsNow, 350);
}
```

- [ ] **Step 6: History — failed read throws, in-memory history is capped**

Replace:
```js
async function loadHistory() {
  history = new Map();
  let data = { runs: [] };
  try {
    data = await window.electronAPI.readHistory();
  } catch (_) {}
  runLog = (data.runs || []).map(summariseRun);
  (data.runs || []).forEach((run) => {
    (run.results || []).forEach((r) => {
      const key = historyKey(run.provider, r.model);
      if (!history.has(key)) history.set(key, []);
      history.get(key).push({ at: run.at, ok: r.status === 'pass' });
    });
  });
}
```
with:
```js
// A failed read throws to init() (startup) or to the Clear button's handler.
async function loadHistory() {
  history = new Map();
  runLog = [];
  const data = await window.electronAPI.readHistory();
  (data.runs || []).forEach(foldRun);
  capHistory();
}

// Every run gets a sequence number, so capping can drop whole runs from both
// indexes at once.
let runSeq = 0;
function foldRun(run) {
  runSeq += 1;
  const seq = runSeq;
  runLog.push({ ...summariseRun(run), seq });
  (run.results || []).forEach((r) => {
    const key = historyKey(run.provider, r.model);
    if (!history.has(key)) history.set(key, []);
    history.get(key).push({ at: run.at, ok: r.status === 'pass', seq });
  });
}

// Same cap as main applies on disk (historyMaxRuns, at most 5000), so a long
// session doesn't grow memory without bound and uptime reads the same runs
// the disk keeps.
function historyCap() {
  const n = Number(settings.historyMaxRuns);
  return n > 0 ? Math.min(Math.floor(n), 5000) : 300;
}

function capHistory() {
  const excess = runLog.length - historyCap();
  if (excess <= 0) return;
  const cutoff = runLog[excess - 1].seq;
  runLog = runLog.slice(excess);
  history.forEach((list, key) => {
    const kept = list.filter((e) => e.seq > cutoff);
    if (kept.length) history.set(key, kept);
    else history.delete(key);
  });
}
```

Replace:
```js
  try {
    await window.electronAPI.appendRun(run, settings.historyMaxRuns);
  } catch (err) {
    console.warn('Failed to record run history:', err);
  }
  // Fold into the in-memory index so the table reflects it immediately.
  run.results.forEach((r) => {
    const key = historyKey(providerId, r.model);
    if (!history.has(key)) history.set(key, []);
    history.get(key).push({ at: run.at, ok: r.status === 'pass' });
  });
  runLog.push(summariseRun(run));
  renderQuickStats();
}
```
with:
```js
  await persist('record the run', () => window.electronAPI.appendRun(run, settings.historyMaxRuns));
  // Fold into the in-memory index so the table reflects it immediately.
  foldRun(run);
  capHistory();
  renderQuickStats();
}
```

Replace the Clear history handler:
```js
$('#btn-clear-history').addEventListener('click', async () => {
  await window.electronAPI.clearHistory();
  await loadHistory();
  if (tableRows.length > 0) renderResultsTable();
  setStatus('done', 'History cleared');
});
```
with:
```js
$('#btn-clear-history').addEventListener('click', async () => {
  const cleared = await persist('clear the run history', () => window.electronAPI.clearHistory());
  if (!cleared) return;
  try {
    await loadHistory();
  } catch (err) {
    setStatus('error', `Couldn't reload the run history: ${ipcMessage(err)}`);
    return;
  }
  if (tableRows.length > 0) renderResultsTable();
  setStatus('done', 'History cleared');
});
```

- [ ] **Step 7: Test definition — failed read throws, save is one call**

Replace:
```js
async function loadTestDefinition() {
  try {
    const data = await window.electronAPI.readConfig();
    const t = data.test || {};
    if (typeof t.prompt === 'string') testPrompt = t.prompt;
    // An empty string is a real choice (checking off), so only a missing key
    // falls back to the default.
    if (typeof t.expected === 'string') expectedAnswer = t.expected;
    if (Number.isFinite(t.autoMinutes)) autoTestMinutes = t.autoMinutes;
  } catch (_) {}
  $('#prompt-input').value = testPrompt;
  $('#expected-input').value = expectedAnswer;
  $('#auto-test-select').value = String(autoTestMinutes);
  applyAutoTestSchedule();
}

async function saveTestDefinition() {
  try {
    const data = await window.electronAPI.readConfig();
    data.test = { prompt: testPrompt, expected: expectedAnswer, autoMinutes: autoTestMinutes };
    await window.electronAPI.writeConfig(data);
  } catch (err) {
    console.warn('Failed to persist test definition:', err);
  }
}

// Typing fires per keystroke, and a save now costs an OS keystore round trip for
// every stored key plus a full config rewrite. Coalesce the writes.
let saveTestTimer = null;
```
with:
```js
// The inputs are filled either way; a failed read then throws to init().
async function loadTestDefinition() {
  try {
    const data = await window.electronAPI.readConfig();
    const t = data.test || {};
    if (typeof t.prompt === 'string') testPrompt = t.prompt;
    // An empty string is a real choice (checking off), so only a missing key
    // falls back to the default.
    if (typeof t.expected === 'string') expectedAnswer = t.expected;
    if (Number.isFinite(t.autoMinutes)) autoTestMinutes = t.autoMinutes;
  } finally {
    $('#prompt-input').value = testPrompt;
    $('#expected-input').value = expectedAnswer;
    $('#auto-test-select').value = String(autoTestMinutes);
    applyAutoTestSchedule();
  }
}

function saveTestDefinition() {
  clearTimeout(saveTestTimer);
  saveTestTimer = null;
  return persist('save the test prompt', () => window.electronAPI.saveTestDefinition({
    prompt: testPrompt, expected: expectedAnswer, autoMinutes: autoTestMinutes,
  }));
}

// Typing fires per keystroke; coalesce the writes.
let saveTestTimer = null;
```

- [ ] **Step 8: "Reset settings" keeps the Artificial Analysis key**

Replace:
```js
$('#btn-reset-settings').addEventListener('click', () => {
  settings = { ...DEFAULT_SETTINGS };
```
with:
```js
$('#btn-reset-settings').addEventListener('click', () => {
  // The Artificial Analysis key is a saved secret, not a setting: a reset keeps it.
  settings = { ...DEFAULT_SETTINGS, aaApiKey: settings.aaApiKey };
```

- [ ] **Step 9: The read gate in `init()`**

Replace:
```js
async function init() {
  await loadSettings();
  applyAppearance();
  applySidebarWidth(clampSidebar(settings.sidebarWidth));
  bindSettingsForm();
  window.electronAPI.getDataPath().then((dir) => { $('#settings-path').textContent = dir; });
  await loadTestDefinition();
  await loadHistory();
  await loadAllProviders();
```
with:
```js
async function init() {
  // Startup read gate: a read that fails is shown and blocks every write for
  // the session (see persist), instead of becoming defaults that a later save
  // would write over the real data.
  try { await loadSettings(); } catch (err) { failStartupRead('settings', err); }
  applyAppearance();
  applySidebarWidth(clampSidebar(settings.sidebarWidth));
  bindSettingsForm();
  window.electronAPI.getDataPath().then((dir) => { $('#settings-path').textContent = dir; });
  try { await loadTestDefinition(); } catch (err) { failStartupRead('the test prompt', err); }
  try { await loadHistory(); } catch (err) { failStartupRead('run history', err); }
  await loadAllProviders();
```

Replace (still in `init()`):
```js
  setStatus('idle', 'Ready — add an API key to begin');
```
with:
```js
  if (!storeReadError) setStatus('idle', 'Ready — add an API key to begin');
```

- [ ] **Step 10: The AA key input saves the secret (catalog.js)**

In `src/renderer/catalog.js` replace:
```js
    const key = $('#set-aa-key');
    if (key) key.addEventListener('change', () => { settings.aaApiKey = key.value.trim(); queueSettingsSave(); });
    const refresh = $('#btn-aa-refresh');
    if (refresh) refresh.addEventListener('click', async () => {
      if (key) { settings.aaApiKey = key.value.trim(); queueSettingsSave(); }
```
with:
```js
    const key = $('#set-aa-key');
    // The key is a saved secret, encrypted in main; save-settings drops it.
    const saveAaKey = () => {
      settings.aaApiKey = key.value.trim();
      return persist('save the Artificial Analysis key', () => window.electronAPI.saveSecret('aaApiKey', settings.aaApiKey));
    };
    if (key) key.addEventListener('change', saveAaKey);
    const refresh = $('#btn-aa-refresh');
    if (refresh) refresh.addEventListener('click', async () => {
      if (key) await saveAaKey();
```

- [ ] **Step 11: Syntax check**

Run: `node --check src/renderer/app.js && node --check src/renderer/catalog.js`
Expected: no output.

Run: `grep -n "writeConfig" src/renderer/app.js`
Expected: exactly the two lines left in `saveProviderConfig` and `loadAllProviders` (replaced in Task 12).

- [ ] **Step 12: Commit**

```bash
git add src/renderer/app.js src/renderer/catalog.js src/renderer/index.html src/renderer/styles.css
git commit -m "feat(renderer): persist() with a startup read gate; settings, test prompt and history on the new IPC"
```

---

### Task 12: Renderer — providers and the model pool on the new IPC

**Files:**
- Modify: `src/renderer/app.js` (`saveProviderConfig`, `loadAllProviders`, `init`)
- Modify: `src/renderer/catalog.js` (`load`, `save`, Clear/Reset buttons)

**Interfaces:**
- Consumes: `persist`, `failStartupRead`, `storeReadError` (Task 11); preload `saveProvider`, `mergeProvider`, `deleteProvider`, `writeCatalog(data, opts)`.
- Produces:
  - `providerPayload(id) → { id, name, baseUrl, rpm, keys: [{ id, name, key, active, quotaSpent }] }` (global).
  - `saveProviderConfig(id)` sends one provider.
  - `loadAllProviders()` builds `PROVIDERS`, then throws if the read failed; seeds missing built-ins one at a time; merges or deletes legacy custom providers through main.
  - `CATALOG.save({ reset }?)` (reset is sticky until the debounced write goes out); internal `flushSave() → Promise` (exported as `CATALOG.flush` in Task 19).

- [ ] **Step 1: `saveProviderConfig` sends one provider**

In `src/renderer/app.js` replace:
```js
async function saveProviderConfig(providerId) {
  const p = PROVIDERS[providerId];
  if (!p) return;
  const data = await window.electronAPI.readConfig();
  if (!data.providers) data.providers = {};
  data.providers[providerId] = { name: p.name, baseUrl: p.baseUrl, keys: p.keys, rpm: p.rpm ?? null };
  await window.electronAPI.writeConfig(data);
```
with:
```js
// The provider as save-provider takes it. A key's `key` is what the user
// typed, the key's placeholder, or '' for a key main holds but can't read
// here (locked); main keeps the stored secret for the last two.
function providerPayload(id) {
  const p = PROVIDERS[id];
  return {
    id,
    name: p.name,
    baseUrl: p.baseUrl,
    rpm: p.rpm ?? null,
    keys: p.keys.map((k) => ({ id: k.id, name: k.name, key: k.key || '', active: k.active !== false, quotaSpent: k.quotaSpent || null })),
  };
}

async function saveProviderConfig(providerId) {
  const p = PROVIDERS[providerId];
  if (!p) return;
  await persist(`save ${p.name}`, () => window.electronAPI.saveProvider(providerPayload(providerId)));
```

- [ ] **Step 2: `loadAllProviders` — no write on a failed read; seed and merge through main**

Replace the whole function:
```js
async function loadAllProviders() {
  let data = { providers: {} };
  try {
    data = await window.electronAPI.readConfig();
  } catch (_) {}
  data.providers = data.providers || {};
  const stored = data.providers;
  const norm = (u) => (u || '').trim().replace(/\/+$/, '').toLowerCase();
  let dirty = false;

  PROVIDERS = {};

  // Built-ins: code template with config name/baseUrl/keys overlaid (config wins).
  // A newly-shipped built-in that isn't in config yet is seeded so its name/baseUrl
  // are visible and editable.
  Object.values(BUILTIN_PROVIDERS).forEach((def) => {
    const p = makeRuntimeProvider(def);
    const s = stored[def.id];
    if (s) {
      if (s.name) p.name = s.name;
      if (s.baseUrl) p.baseUrl = s.baseUrl;
      // null is "not set", which a provider seeded before its module declared a
      // limit carries; it falls back to the module's documented rpm.
      if (s.rpm != null) p.rpm = s.rpm;
      p.keys = s.keys || [];
    } else {
      stored[def.id] = { name: p.name, baseUrl: p.baseUrl, keys: p.keys, rpm: p.rpm ?? null };
      dirty = true;
    }
    PROVIDERS[def.id] = p;
  });

  // The app only runs its integrated providers. A custom provider left in an
  // older config is migrated into the built-in with the same baseUrl (its keys
  // move over); one with no built-in twin and no keys is removed. One that still
  // holds keys is left in the file untouched, so no key is ever thrown away, but
  // it is not loaded.
  Object.entries(stored).forEach(([id, s]) => {
    if (!s.custom || PROVIDERS[id]) return;
    const builtin = Object.values(PROVIDERS).find((p) => !p.custom && norm(p.baseUrl) === norm(s.baseUrl));
    if (builtin) {
      // Undecryptable keys all read as '', so identify by ciphertext when present
      // — otherwise merging would silently drop all but the first of them.
      const identity = (k) => k.cipher || k.key;
      const have = new Set(builtin.keys.map(identity));
      (s.keys || []).forEach((k) => {
        if (!have.has(identity(k))) {
          builtin.keys.push(k);
          have.add(identity(k));
        }
      });
      delete stored[id];
      stored[builtin.id] = { name: builtin.name, baseUrl: builtin.baseUrl, keys: builtin.keys, rpm: builtin.rpm ?? null };
      dirty = true;
      return;
    }
    if (!(s.keys || []).length) {
      delete stored[id];
      dirty = true;
    } else {
      console.warn(`Custom provider "${s.name || id}" still holds keys; left in config, not loaded.`);
    }
  });

  if (dirty) {
    try {
      await window.electronAPI.writeConfig(data);
    } catch (err) {
      console.warn('Failed to persist providers:', err);
    }
  }
}
```
with:
```js
async function loadAllProviders() {
  let stored = {};
  let readError = null;
  try {
    stored = (await window.electronAPI.readConfig()).providers || {};
  } catch (err) {
    readError = err;
  }
  const norm = (u) => (u || '').trim().replace(/\/+$/, '').toLowerCase();

  PROVIDERS = {};

  // Built-ins: code template with the stored name/baseUrl/keys overlaid (the
  // store wins). A newly-shipped built-in the store doesn't have yet is seeded
  // below so its name and baseUrl are visible and editable.
  const missing = [];
  Object.values(BUILTIN_PROVIDERS).forEach((def) => {
    const p = makeRuntimeProvider(def);
    const s = stored[def.id];
    if (s) {
      if (s.name) p.name = s.name;
      if (s.baseUrl) p.baseUrl = s.baseUrl;
      // null is "not set", which a provider seeded before its module declared a
      // limit carries; it falls back to the module's documented rpm.
      if (s.rpm != null) p.rpm = s.rpm;
      p.keys = s.keys || [];
    } else {
      missing.push(def.id);
    }
    PROVIDERS[def.id] = p;
  });

  // Nothing below may write when the store could not be read: PROVIDERS is
  // then the bare templates, without a single key. init() shows the error.
  if (readError) throw readError;

  // Seeded one at a time, so seeding never rewrites another provider.
  for (const id of missing) {
    await persist(`add ${PROVIDERS[id].name}`, () => window.electronAPI.saveProvider(providerPayload(id)));
  }

  // The app only runs its integrated providers. A custom provider left by an
  // older version is merged in main into the built-in with the same baseUrl
  // (keys move over, duplicates are dropped by value — by ciphertext for keys
  // this machine can't read); one with no built-in twin and no keys is
  // removed. One that still holds keys stays in the store untouched, so no key
  // is ever thrown away, but it is not loaded.
  for (const [id, s] of Object.entries(stored)) {
    if (!s.custom || PROVIDERS[id]) continue;
    const builtin = Object.values(PROVIDERS).find((p) => !p.custom && norm(p.baseUrl) === norm(s.baseUrl));
    if (builtin) {
      const merged = await persist(`merge ${s.name || id} into ${builtin.name}`, () => window.electronAPI.mergeProvider(id, builtin.id));
      if (merged) builtin.keys = merged.keys;
    } else if (!(s.keys || []).length) {
      await persist(`remove ${s.name || id}`, () => window.electronAPI.deleteProvider(id));
    } else {
      console.warn(`Custom provider "${s.name || id}" still holds keys; kept in the store, not loaded.`);
    }
  }
}
```

- [ ] **Step 3: Gate the provider read in `init()`**

Replace:
```js
  try { await loadHistory(); } catch (err) { failStartupRead('run history', err); }
  await loadAllProviders();
```
with:
```js
  try { await loadHistory(); } catch (err) { failStartupRead('run history', err); }
  try { await loadAllProviders(); } catch (err) { failStartupRead('providers', err); }
```

- [ ] **Step 4: Catalogue `load()` — a failed read is shown, never saved over**

In `src/renderer/catalog.js` replace:
```js
      try {
        state.data = await window.electronAPI.readCatalog();
      } catch (_) {
        state.data = null;
      }
      if (!state.data || typeof state.data !== 'object') state.data = { version: 1, models: {}, lastSync: {}, leaderboard: null };
```
with:
```js
      try {
        state.data = await window.electronAPI.readCatalog();
      } catch (err) {
        // Shown empty for this session and never saved: the read gate makes
        // persist() refuse every write.
        failStartupRead('model pool', err);
        state.data = null;
      }
      if (!state.data || typeof state.data !== 'object') state.data = { version: 1, models: {}, lastSync: {}, leaderboard: null };
```

- [ ] **Step 5: Catalogue `save()` goes through `persist()`, reset is explicit**

Replace:
```js
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      Promise.resolve(window.electronAPI.writeCatalog(state.data)).catch(() => {});
      // The profiles are a pure function of the catalogue; tell them it moved.
      window.dispatchEvent(new CustomEvent('catalog-changed'));
    }, 300);
  }
```
with:
```js
  // Main writes only the rows that changed. It refuses to empty a non-empty
  // pool unless reset is set, which only the Clear and Reset buttons do; the
  // flag sticks until the debounced write goes out, because another save()
  // can land inside the window.
  let saveTimer = null;
  let saveReset = false;
  function save({ reset = false } = {}) {
    saveReset = saveReset || reset === true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 300);
  }

  function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const opts = { reset: saveReset };
    saveReset = false;
    // The profiles are a pure function of the catalogue; tell them it moved.
    window.dispatchEvent(new CustomEvent('catalog-changed'));
    return persist('save the model pool', () => window.electronAPI.writeCatalog(state.data, opts));
  }
```

- [ ] **Step 6: Clear and Reset send `reset: true`**

Replace:
```js
      Object.values(state.data.models).forEach((e) => { e.bench = null; e.history = []; e.benchError = null; });
      save();
```
with:
```js
      Object.values(state.data.models).forEach((e) => { e.bench = null; e.history = []; e.benchError = null; });
      save({ reset: true });
```

Replace:
```js
      state.data.models = {};
      state.data.lastSync = {};
      save();
```
with:
```js
      state.data.models = {};
      state.data.lastSync = {};
      save({ reset: true });
```

`profiles.js` needs no change: `savePolicy()` writes `C.state.data.profiles` and calls `C.save()`, which now lands in the `profiles` catalogue-meta row.

- [ ] **Step 7: Syntax check and leftovers**

Run: `node --check src/renderer/app.js && node --check src/renderer/catalog.js`
Expected: no output.

Run: `grep -rn "writeConfig" src/`
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/app.js src/renderer/catalog.js
git commit -m "feat(renderer): providers saved one at a time, merges in main, model pool writes gated and explicit about reset"
```

### Task 13: Synthetic fixture, mock provider and the live verification script

**Files:**
- Create: `scripts/live/fixture.mjs`
- Create: `scripts/live/mock-provider.mjs`
- Create: `scripts/live/verify-db.mjs`
- Modify: `package.json` (`verify:live` script)

**Interfaces:**
- Consumes: `launch`, `assertScratchDir` (Task 10); renderer globals `PROVIDERS`, `settings`, `runLog`, `testPrompt`, `CATALOG`, `queueSettingsSave`, `setKeyActive`, `failStartupRead`, `saveSettingsNow`, `persist` (Tasks 11-12).
- Produces:
  - `fixture.mjs`: `FIXTURE = { port: 47831, keys: { dark1, dark2, cust2, nexum1, orphan }, aaKey, lockedBlob }`; `writeFixture(dir, origin) → { alphaFirstSeen }` — writes `config.json`, `catalog.json`, `history.json` as an older build did: plaintext keys (the importer must encrypt them with the real safeStorage), one undecryptable `enc:v1:` blob (must come through locked), a legacy custom provider that merges into Dark API, one that stays unloaded, `mediaPrompt`, an `aaApiKey`, a fresh leaderboard (so nothing calls artificialanalysis.ai) and `catalogAutoBench: false`.
  - `mock-provider.mjs`: `startMock(port) → Promise<{ origin, requests: [{ method, url, authorization, body }], close() }>` on 127.0.0.1; answers `/models` and `/chat/completions` only for `Bearer sk-fixture-…`.
  - `verify-db.mjs`: step lists `RUN1`, `RUN1_END`, `RUN2`, `RUN2_END` (later tasks append to `RUN1`, `RUN1_END` and `RUN2`); each step is `async (ctx) => void` with `ctx = { app, dir, mock, fixture, check }`; exit code 0 only when every check passed. `npm run verify:live` runs it.

- [ ] **Step 1: Write `scripts/live/fixture.mjs`**

```js
// Synthetic legacy data folder for the live checks: config.json, catalog.json
// and history.json as an older VENOM Router wrote them, with fake keys and
// provider URLs on a local mock. The plaintext keys are there on purpose —
// the importer must encrypt them with the real OS keystore — and so is one
// enc:v1: blob no machine can open, which must come through as a locked key.
// The owner's real data is never copied, so no timer can send a real key.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertScratchDir } from './cdp.mjs';

export const FIXTURE = {
  port: 47831,
  keys: {
    dark1: 'sk-fixture-dark-0001',
    dark2: 'sk-fixture-dark-0002',
    cust2: 'sk-fixture-cust-0003',
    nexum1: 'sk-fixture-nexum-0004',
    orphan: 'sk-fixture-orphan-0005',
  },
  aaKey: 'aa_fixture_0000000000',
  lockedBlob: `enc:v1:${Buffer.from('fixture: not a DPAPI blob').toString('base64')}`,
};

export function writeFixture(dir, origin) {
  assertScratchDir(dir);
  const now = Date.now();
  const alphaFirstSeen = now - 86400000;
  const k = FIXTURE.keys;

  const config = {
    version: 1,
    providers: {
      darkapi: {
        name: 'Dark API (fixture)', baseUrl: `${origin}/darkapi/v1`, rpm: null,
        keys: [
          { id: 'k_dark_1', name: 'Dark one', key: k.dark1, active: true },
          { id: 'k_dark_2', name: 'Dark two', key: k.dark2, active: true },
        ],
      },
      nexum: {
        name: 'Nexum (fixture)', baseUrl: `${origin}/nexum/v1`, rpm: 30,
        keys: [
          { id: 'k_nexum_1', name: 'Nexum plain', key: k.nexum1, active: true,
            quotaSpent: { until: now + 3600000, status: 429, message: 'fixture quota', at: now, models: ['fixture-beta'] } },
          { id: 'k_nexum_locked', name: 'Other machine', key: FIXTURE.lockedBlob, active: true },
        ],
      },
      // Same base URL as Dark API (trailing slash): merged into it at startup;
      // its first key duplicates Dark one and must be dropped.
      custom_legacy: {
        name: 'Old Dark custom', baseUrl: `${origin}/darkapi/v1/`, custom: true,
        keys: [
          { id: 'k_cust_1', name: 'Dup of Dark one', key: k.dark1, active: true },
          { id: 'k_cust_2', name: 'Custom only', key: k.cust2, active: false },
        ],
      },
      // No built-in twin and it holds a key: kept in the store, never loaded.
      custom_orphan: {
        name: 'Orphan custom', baseUrl: `${origin}/orphan/v1`, custom: true,
        keys: [{ id: 'k_orphan_1', name: 'Orphan key', key: k.orphan, active: true }],
      },
    },
    settings: {
      theme: 'daylight', historyMaxRuns: 5, sparkRuns: 12, catalogAutoBench: false,
      mediaPrompt: 'A fixture media prompt.', aaApiKey: FIXTURE.aaKey, futureField: 'kept',
    },
    test: { prompt: 'Fixture prompt?', expected: '4', autoMinutes: 0 },
    window: { width: 1280, height: 820, maximized: false },
  };

  const entry = (id, extra) => ({
    key: `darkapi::${id}`, providerId: 'darkapi', id, firstSeen: alphaFirstSeen, lastSeen: now - 60000, removedAt: null,
    isNew: false, name: id, kind: 'chat', pricing: null, declaresTools: null, maxOutput: null, hasVision: false,
    hasReasoning: false, isFree: false, isFreeForPaid: false, contextLabel: '', contextWindow: null, keyIds: ['k_dark_1'],
    ownedBy: 'fixture', bench: null, history: [], benchError: null, ...extra,
  });
  const catalog = {
    version: 1,
    models: {
      'darkapi::fixture-alpha': entry('fixture-alpha', {}),
      'darkapi::fixture-gone': entry('fixture-gone', { removedAt: now - 3600000, keyIds: ['k_dark_2'] }),
    },
    lastSync: { darkapi: now - 60000 },
    keyModels: { k_dark_1: { count: 2, at: now - 60000 } },
    // Fresh, so the app never asks artificialanalysis.ai for it.
    leaderboard: {
      source: 'fixture', at: now,
      models: [{ name: 'Fixture Alpha', slug: 'fixture-alpha', creator: 'Fixture', index: 50, codingIndex: 40, mathIndex: 30, tps: 100, ttft: 0.5, priceBlended: 1 }],
    },
    leaderboardError: null,
  };

  const result = (status) => (status === 'pass'
    ? { model: 'fixture-alpha', status, time: 900, tokens: 6, completionTokens: 1, attempts: 1, correct: true }
    : { model: 'fixture-alpha', status, time: null, tokens: null, completionTokens: null, attempts: 3, correct: null });
  const history = {
    version: 1,
    runs: [
      { at: now - 3000, provider: 'darkapi', providerName: 'Dark API (fixture)', prompt: 'Fixture prompt?', results: [result('pass')] },
      { at: now - 2000, provider: 'darkapi', providerName: 'Dark API (fixture)', prompt: 'Fixture prompt?', results: [result('fail')] },
      // An older build's run: no prompt, no providerName.
      { at: now - 1000, provider: 'darkapi', results: [result('pass')] },
    ],
  };

  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2));
  writeFileSync(join(dir, 'catalog.json'), JSON.stringify(catalog));
  writeFileSync(join(dir, 'history.json'), JSON.stringify(history));
  return { alphaFirstSeen };
}
```

- [ ] **Step 2: Write `scripts/live/mock-provider.mjs`**

```js
// A local stand-in for the fixture's providers: OpenAI-shaped /models and
// /chat/completions on 127.0.0.1, answering only fixture keys. It records
// every request, so the live check can see which key actually went out.
import http from 'node:http';

export function startMock(port) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const authorization = req.headers.authorization || '';
      requests.push({ method: req.method, url: req.url, authorization, body });
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (!authorization.startsWith('Bearer sk-fixture-')) return send(401, { error: { message: 'fixture: missing or unknown key' } });
      if (req.method === 'GET' && req.url.endsWith('/models')) {
        return send(200, { object: 'list', data: [
          { id: 'fixture-alpha', object: 'model', owned_by: 'fixture' },
          { id: 'fixture-beta', object: 'model', owned_by: 'fixture' },
        ] });
      }
      if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
        return send(200, {
          id: 'fixture', object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: '4' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        });
      }
      return send(404, { error: { message: 'fixture: no such route' } });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({
      origin: `http://127.0.0.1:${port}`,
      requests,
      close: () => new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
    }));
  });
}
```

- [ ] **Step 3: Write `scripts/live/verify-db.mjs`**

```js
// Live check of the local database against a synthetic data folder.
//
//   npm run verify:live
//
// Builds a fixture userData in %TEMP% (legacy JSON with fake keys, provider
// URLs on a local mock), launches a separate VENOM Router on it over CDP,
// checks the import and what survives a restart, then deletes the folder.
// The owner's data folder is never read.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './cdp.mjs';
import { FIXTURE, writeFixture } from './fixture.mjs';
import { startMock } from './mock-provider.mjs';

let failures = 0;
function check(name, cond, detail = '') {
  if (!cond) failures += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(250);
  }
  return false;
}

const READY = "typeof PROVIDERS === 'object' && Object.keys(PROVIDERS).length === 7 && !!window.CATALOG && CATALOG.state.loaded";

// ---- run 1: the first launch imports the fixture -----------------------------

async function checkImport({ app, dir, mock, fixture }) {
  const s = await app.evaluate(`(async () => {
    const cfg = await window.electronAPI.readConfig();
    const keys = (id) => PROVIDERS[id].keys.map((k) => ({ id: k.id, active: k.active, locked: !!k.locked, quota: !!k.quotaSpent }));
    return {
      providers: Object.keys(PROVIDERS),
      dark: keys('darkapi'),
      nexum: keys('nexum'),
      stored: Object.keys(cfg.providers),
      orphanCustom: !!(cfg.providers.custom_orphan && cfg.providers.custom_orphan.custom),
      theme: settings.theme,
      imagePrompt: settings.imagePrompt,
      hasAa: typeof settings.aaApiKey === 'string' && settings.aaApiKey.length > 0,
      runs: runLog.length,
      prompt: testPrompt,
      alphaFirstSeen: (CATALOG.state.data.models['darkapi::fixture-alpha'] || {}).firstSeen,
      banner: !document.querySelector('#store-error').hidden,
    };
  })()`);
  check('seven built-in providers loaded', s.providers.length === 7, s.providers.join(', '));
  check('legacy custom provider merged into Dark API, duplicate key dropped',
    s.dark.map((k) => k.id).join(',') === 'k_dark_1,k_dark_2,k_cust_2', s.dark.map((k) => k.id).join(','));
  check('the merged custom provider is gone from the store', !s.stored.includes('custom_legacy'), s.stored.join(', '));
  check('a custom provider with keys and no built-in twin is kept but not loaded', s.orphanCustom && !s.providers.includes('custom_orphan'));
  check('the undecryptable enc:v1: key came through locked',
    s.nexum.map((k) => `${k.id}:${k.locked}`).join(',') === 'k_nexum_1:false,k_nexum_locked:true', JSON.stringify(s.nexum));
  check('quotaSpent survived the import', s.nexum[0].quota === true);
  check('a disabled key stayed disabled through the merge', s.dark[2].active === false);
  check('settings imported', s.theme === 'daylight', s.theme);
  check('legacy mediaPrompt seeded the image prompt', s.imagePrompt === 'A fixture media prompt.', s.imagePrompt);
  check('Artificial Analysis key imported', s.hasAa);
  check('three history runs imported', s.runs === 3, String(s.runs));
  check('test prompt imported', s.prompt === 'Fixture prompt?', s.prompt);
  check('model pool imported with firstSeen kept', s.alphaFirstSeen === fixture.alphaFirstSeen, String(s.alphaFirstSeen));
  check('no read-failure banner', !s.banner);
  ['config', 'catalog', 'history'].forEach((name) => {
    check(`${name}.json renamed to ${name}.imported.json`,
      existsSync(join(dir, `${name}.imported.json`)) && !existsSync(join(dir, `${name}.json`)));
  });
  check('venom.db created', existsSync(join(dir, 'venom.db')));
  const sent = await until(() => mock.requests.some((r) => r.authorization === `Bearer ${FIXTURE.keys.dark1}`));
  check('health and sync traffic reached the mock with the imported key', sent);
  const leaked = mock.requests.filter((r) => [FIXTURE.lockedBlob, FIXTURE.keys.orphan, FIXTURE.keys.cust2]
    .some((v) => r.authorization.includes(v) || r.body.includes(v)));
  check('locked, orphaned and disabled keys were never sent', leaked.length === 0, leaked.map((r) => r.url).join(', '));
}

// Saved and waited for, so the next run can check it survived.
async function saveForNextRun({ app }) {
  await app.evaluate(`(async () => {
    settings.sparkRuns = 17;
    queueSettingsSave();
    await setKeyActive('darkapi', 'k_dark_2');
    await new Promise((r) => setTimeout(r, 800));
    return true;
  })()`);
}

// ---- run 2: relaunch on the same folder -----------------------------------------

async function checkPersistence({ app, dir }) {
  const s = await app.evaluate(`({
    spark: settings.sparkRuns,
    dark: PROVIDERS.darkapi.keys.map((k) => k.id + ':' + k.active).join(','),
    runs: runLog.length,
    models: Object.keys(CATALOG.state.data.models).length,
  })`);
  check('a setting saved in run 1 survived the restart', s.spark === 17, String(s.spark));
  check('a key toggled in run 1 stayed toggled', s.dark === 'k_dark_1:true,k_dark_2:false,k_cust_2:false', s.dark);
  check('no second import: still three runs', s.runs === 3, String(s.runs));
  check('the imported files were left alone', existsSync(join(dir, 'config.imported.json')) && !existsSync(join(dir, 'config.json')));
  check('the model pool kept its rows', s.models >= 2, String(s.models));
}

// Last in its run: it poisons the session on purpose.
async function checkWriteGate({ app }) {
  const r = await app.evaluate(`(async () => {
    const before = (await window.electronAPI.readConfig()).settings.sparkRuns;
    failStartupRead('live check', new Error('simulated read failure'));
    settings.sparkRuns = 39;
    const direct = await saveSettingsNow();
    const after = (await window.electronAPI.readConfig()).settings.sparkRuns;
    return { before, after, direct: direct === undefined, banner: !document.querySelector('#store-error').hidden };
  })()`);
  check('read gate: the banner is shown', r.banner);
  check('read gate: a settings save is refused and nothing changes on disk', r.direct && r.after === r.before, `${r.before} -> ${r.after}`);
}

const RUN1 = [checkImport];
const RUN1_END = [saveForNextRun];
const RUN2 = [checkPersistence];
const RUN2_END = [checkWriteGate];

async function session(ctx, steps) {
  const app = await launch({ userDataDir: ctx.dir });
  try {
    await app.waitFor(READY, 30000);
    for (const step of steps) await step({ ...ctx, app });
  } finally {
    const code = await app.close().catch((err) => {
      check('the app closed', false, err.message);
      return null;
    });
    if (code !== null) check('the app exited with code 0', code === 0, String(code));
  }
}

const dir = mkdtempSync(join(tmpdir(), 'venom-live-'));
const mock = await startMock(FIXTURE.port);
try {
  const fixture = writeFixture(dir, mock.origin);
  const ctx = { dir, mock, fixture, check };
  console.log(`Fixture data folder: ${dir}\n`);
  await session(ctx, [...RUN1, ...RUN1_END]);
  await session(ctx, [...RUN2, ...RUN2_END]);
} catch (err) {
  check('the live run finished', false, err.stack || err.message);
} finally {
  await mock.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL LIVE CHECKS PASSED');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 4: Add the npm script**

In `package.json` replace:
```json
    "postinstall": "electron-builder install-app-deps",
```
with:
```json
    "postinstall": "electron-builder install-app-deps",
    "verify:live": "node scripts/live/verify-db.mjs",
```

- [ ] **Step 5: Run the live check**

Run: `npm run verify:live`
Expected: every line starts with `PASS` (21 checks in run 1 including the exit code, 8 in run 2 including the gate and the exit code), last line `ALL LIVE CHECKS PASSED`, exit 0. A new window opens and closes twice; nothing else on the desktop is touched.

If a check fails, fix the code under test (not the check) and re-run.

- [ ] **Step 6: Commit**

```bash
git add scripts/live/fixture.mjs scripts/live/mock-provider.mjs scripts/live/verify-db.mjs package.json
git commit -m "test(live): synthetic legacy fixture, local mock provider and CDP verification of the import"
```

---

### Task 14: Owner-run read-only count check

**Files:**
- Create: `scripts/check-import-counts.js`
- Test: `test/check-import-counts.test.js`
- Modify: `package.json` (`check:import` script)

**Interfaces:**
- Consumes: the schema (Task 3). Tests use `database.open` and `importLegacy` with the fake cipher.
- Produces: `legacyCounts(dir) → { files, providers: { id: keyCount }, settings, hasAa, models, runs, results }` (reads `<name>.json`, else `<name>.imported.json`); `dbCounts(dir) → same shape + importedAt | null` (read-only open, no decryption); `compare(legacy, db) → [{ what, before, after, same, note }]`. CLI: `npm run check:import [-- <folder>]`, default `%APPDATA%\venom-router`; relaunches itself under Electron's Node; blocks `http`, `https`, `http2`, `net`, `tls`, `dns`, `dgram`, `child_process`, `electron` before reading anything.

- [ ] **Step 1: Write the failing test**

`test/check-import-counts.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const database = require('../src/db');
const { importLegacy } = require('../src/db/import-json');
const { legacyCounts, dbCounts, compare } = require('../scripts/check-import-counts');
const { fakeCipher, encFake, quietLog, tempDir } = require('./helpers');

function writeLegacy(dir) {
  const config = {
    version: 1,
    providers: {
      nara: {
        name: 'NaraRouter', baseUrl: 'https://router.bynara.id/v1', rpm: null,
        keys: [
          { id: 'key_1', name: 'A', key: encFake('sk-owner-secret-1'), active: true },
          { id: 'key_2', name: 'B', key: 'sk-owner-plain-2', active: true },
        ],
      },
      darkapi: { name: 'Dark API', baseUrl: 'https://darkapi.dev/v1', rpm: null, keys: [] },
    },
    settings: { theme: 'daylight', historyMaxRuns: 50, aaApiKey: 'aa-owner-secret' },
  };
  const catalog = {
    version: 1,
    models: {
      'nara::m1': { key: 'nara::m1', providerId: 'nara', id: 'm1', keyIds: [] },
      'nara::m2': { key: 'nara::m2', providerId: 'nara', id: 'm2', keyIds: [] },
    },
    lastSync: {},
  };
  const history = {
    version: 1,
    runs: [
      { at: 1, provider: 'nara', providerName: 'N', prompt: 'p', results: [{ model: 'm1', status: 'pass' }, { model: 'm2', status: 'fail' }] },
      { at: 2, provider: 'nara', providerName: 'N', prompt: 'p', results: [{ model: 'm1', status: 'pass' }] },
    ],
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(catalog));
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify(history));
}

test('before the import: legacy counts only', (t) => {
  const dir = tempDir(t);
  writeLegacy(dir);
  const legacy = legacyCounts(dir);
  assert.deepStrictEqual(legacy.providers, { nara: 2, darkapi: 0 });
  assert.strictEqual(legacy.models, 2);
  assert.strictEqual(legacy.runs, 2);
  assert.strictEqual(legacy.results, 3);
  assert.strictEqual(legacy.hasAa, true);
  assert.strictEqual(dbCounts(dir), null);
});

test('after the import every count matches and nothing secret is printed', async (t) => {
  const dir = tempDir(t);
  writeLegacy(dir);
  const cipher = fakeCipher();
  const store = await database.open(dir, { cipher, log: quietLog });
  try {
    await importLegacy({ dir, db: store.db, repos: store.repos, cipher, log: quietLog });
  } finally {
    store.close();
  }
  const rows = compare(legacyCounts(dir), dbCounts(dir));
  assert.deepStrictEqual(rows.filter((r) => !r.same), []);
  const printed = JSON.stringify(rows);
  ['sk-owner-secret-1', 'sk-owner-plain-2', 'aa-owner-secret', 'enc:v1:'].forEach((s) => assert.ok(!printed.includes(s), s));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/check-import-counts.test.js`
Expected: FAIL with `Cannot find module '../scripts/check-import-counts'`.

- [ ] **Step 3: Write `scripts/check-import-counts.js`**

```js
// Owner-run, read-only comparison of the legacy JSON files with venom.db.
//
//   npm run check:import                          (%APPDATA%\venom-router)
//   npm run check:import -- "D:\path\to\folder"
//
// Close VENOM Router first. The script opens nothing for writing, decrypts
// nothing and loads no networking module (blockNetworking makes sure). It
// prints counts and setting names only — never a key, a ciphertext or a
// setting's value. Run it before updating (legacy counts only) and after the
// first launch of the new version (both columns side by side).
'use strict';
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BLOCKED = new Set(['http', 'https', 'http2', 'net', 'tls', 'dns', 'dgram', 'child_process', 'electron']);

// better-sqlite3 is built for Electron's ABI, so the check runs under
// Electron's own Node.
function relaunchUnderElectron() {
  const { spawnSync } = require('child_process');
  const electron = require('electron'); // the binary's path, required from plain Node
  const res = spawnSync(electron, [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  process.exit(res.status === null ? 1 : res.status);
}

function blockNetworking() {
  const load = Module._load;
  Module._load = function guardedLoad(request, ...rest) {
    if (BLOCKED.has(String(request).replace(/^node:/, ''))) {
      throw new Error(`check-import-counts: "${request}" is blocked (read-only, offline check)`);
    }
    return load.call(this, request, ...rest);
  };
}

const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// <name>.json before the update, <name>.imported.json after it.
function readJson(dir, base) {
  for (const name of [base, base.replace(/\.json$/, '.imported.json')]) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    try {
      return { name, data: JSON.parse(fs.readFileSync(file, 'utf-8')) };
    } catch (err) {
      return { name, error: err.message };
    }
  }
  return null;
}

function legacyCounts(dir) {
  const config = readJson(dir, 'config.json');
  const catalog = readJson(dir, 'catalog.json');
  const history = readJson(dir, 'history.json');
  const cfg = asObject(config && config.data);
  const providers = {};
  Object.entries(asObject(cfg.providers)).forEach(([id, p]) => {
    providers[id] = (Array.isArray(p && p.keys) ? p.keys : []).filter((k) => k && typeof k.key === 'string' && k.key !== '').length;
  });
  const settings = cfg.settings && typeof cfg.settings === 'object' ? { ...cfg.settings } : null;
  const hasAa = !!(settings && typeof settings.aaApiKey === 'string' && settings.aaApiKey.trim());
  if (settings) delete settings.aaApiKey;
  const runs = Array.isArray(asObject(history && history.data).runs) ? history.data.runs : [];
  return {
    files: [config, catalog, history].filter(Boolean).map((f) => (f.error ? `${f.name} (unreadable)` : f.name)),
    providers,
    settings,
    hasAa,
    models: Object.keys(asObject(asObject(catalog && catalog.data).models)).length,
    runs: runs.length,
    results: runs.reduce((n, r) => n + (Array.isArray(r && r.results) ? r.results.length : 0), 0),
  };
}

function dbCounts(dir) {
  const file = path.join(dir, 'venom.db');
  if (!fs.existsSync(file)) return null;
  const Database = require('better-sqlite3');
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const one = (sql) => db.prepare(sql).get().n;
    const providers = {};
    db.prepare('SELECT p.id, COUNT(k.id) AS n FROM providers p LEFT JOIN provider_keys k ON k.provider_id = p.id GROUP BY p.id')
      .all()
      .forEach((r) => { providers[r.id] = r.n; });
    const settingsRow = db.prepare("SELECT value_json FROM settings WHERE key = 'settings'").get();
    const imported = db.prepare("SELECT value FROM meta WHERE key = 'imported_from_json_at'").get();
    return {
      importedAt: imported ? imported.value : null,
      providers,
      settings: settingsRow ? JSON.parse(settingsRow.value_json) : null,
      hasAa: one("SELECT COUNT(*) AS n FROM secrets WHERE name = 'aaApiKey'") > 0,
      models: one('SELECT COUNT(*) AS n FROM models'),
      runs: one('SELECT COUNT(*) AS n FROM test_runs'),
      results: one('SELECT COUNT(*) AS n FROM test_results'),
    };
  } finally {
    db.close();
  }
}

function compare(legacy, db) {
  const rows = [];
  const add = (what, before, after, note = '') => rows.push({ what, before, after, same: before === after, note });
  const sum = (m) => Object.values(m).reduce((n, v) => n + v, 0);
  add('providers', Object.keys(legacy.providers).length, Object.keys(db.providers).length,
    'new built-ins are added and legacy custom providers merged at first launch');
  [...new Set([...Object.keys(legacy.providers), ...Object.keys(db.providers)])].sort().forEach((id) => {
    add(`keys of ${id}`, legacy.providers[id] ?? '-', db.providers[id] ?? '-');
  });
  add('keys in total', sum(legacy.providers), sum(db.providers), "a merged custom provider's keys move to its built-in; duplicates are dropped");
  add('Artificial Analysis key', legacy.hasAa ? 'set' : 'none', db.hasAa ? 'set' : 'none');
  add('models', legacy.models, db.models, 'the model pool re-syncs after launch');
  add('test runs', legacy.runs, db.runs, 'runs made after launch add to this; the run cap trims it');
  add('test results', legacy.results, db.results);
  const a = legacy.settings || {};
  const b = db.settings || {};
  const differing = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  add('settings fields that differ', 0, differing.length, differing.join(', '));
  return rows;
}

function main() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const dir = path.resolve(process.argv[2] || path.join(appData, 'venom-router'));
  console.log(`Folder: ${dir}`);
  const legacy = legacyCounts(dir);
  console.log(`Legacy files: ${legacy.files.length ? legacy.files.join(', ') : 'none found'}`);
  const db = dbCounts(dir);
  if (!db) {
    const keys = Object.values(legacy.providers).reduce((n, v) => n + v, 0);
    console.log('venom.db: not there yet (run this again after the first launch of the new version)\n');
    console.log(`providers ${Object.keys(legacy.providers).length} · keys ${keys} · models ${legacy.models} · runs ${legacy.runs} · results ${legacy.results} · AA key ${legacy.hasAa ? 'set' : 'none'}`);
    return;
  }
  console.log(`venom.db: imported_from_json_at = ${db.importedAt}\n`);
  const rows = compare(legacy, db);
  const width = Math.max(...rows.map((r) => r.what.length));
  rows.forEach((r) => {
    const note = r.same || !r.note ? '' : `  (${r.note})`;
    console.log(`${r.same ? 'same ' : 'CHECK'}  ${r.what.padEnd(width)}  ${String(r.before).padStart(6)} -> ${String(r.after).padEnd(6)}${note}`);
  });
}

if (require.main === module) {
  if (!process.versions.electron) {
    relaunchUnderElectron();
  } else {
    blockNetworking();
    main();
  }
}

module.exports = { legacyCounts, dbCounts, compare };
```

- [ ] **Step 4: Add the npm script**

In `package.json` replace:
```json
    "verify:live": "node scripts/live/verify-db.mjs",
```
with:
```json
    "verify:live": "node scripts/live/verify-db.mjs",
    "check:import": "node scripts/check-import-counts.js",
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: `pass 99`, `fail 0`.

Run the CLI on a scratch copy, never on the real folder (that is the owner's to run):
```bash
SCRATCH="$(mktemp -d)"
printf '{"version":1,"providers":{"nara":{"name":"N","baseUrl":"https://x.test/v1","keys":[{"id":"key_1","name":"A","key":"enc:v1:Zm9v","active":true}]}}}' > "$SCRATCH/config.json"
npm run check:import -- "$(cygpath -w "$SCRATCH")"
rm -rf "$SCRATCH"
```
Expected: `Legacy files: config.json`, `venom.db: not there yet …`, and `providers 1 · keys 1 · models 0 · runs 0 · results 0 · AA key none`.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-import-counts.js test/check-import-counts.test.js package.json
git commit -m "feat(scripts): owner-run read-only count check of the JSON import"
```

# Phase 2 — Keys stay in main

### Task 15: Placeholder resolution

**Files:**
- Create: `src/db/keys.js`
- Test: `test/db/keys.test.js`

**Interfaces:**
- Consumes: `repos.providers.keyRecord(id)`, `repos.providers.revealKey(id)` (Task 5); `repos.secrets.reveal(name)`, `SECRET_ORIGINS` (Task 4).
- Produces: `createKeyResolver({ providers, secrets }) → { resolve({ url, headers, body }) → { url, headers, body } | { blocked: true, error } }`. A request without any `venomkey:`/`venomsecret:` token comes back untouched (same objects). Otherwise: URL tokens become `encodeURIComponent(secret)`, header tokens the raw secret, string-body tokens the JSON-escaped secret when the body parses as JSON (raw otherwise); an object body is stringified first. Refusal message: `Key blocked: <host> is not this key's provider`.

- [ ] **Step 1: Write the failing test**

`test/db/keys.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { createKeyResolver } = require('../../src/db/keys');
const { memoryStore, LOCKED_BLOB } = require('../helpers');

const NARA = 'https://router.bynara.id/v1';
const MIRAI = 'https://api.miraiapi.com/v1';
// Needs escaping in JSON and in a URL.
const TRICKY = 'sk-"mirai\\quote';

async function setup(t) {
  const store = await memoryStore(t);
  const providers = store.repos.providers;
  providers.save({ id: 'nara', name: 'NaraRouter', baseUrl: NARA, rpm: null, keys: [
    { id: 'key_1', name: 'One', key: 'sk-nara-1', active: true },
    { id: 'key_12', name: 'Twelve', key: 'sk-nara-12', active: true },
  ] });
  providers.save({ id: 'mirai', name: 'Mirai', baseUrl: MIRAI, rpm: null, keys: [{ id: 'key_m', name: 'M', key: TRICKY, active: true }] });
  providers.importProvider({ id: 'darkapi', name: 'Dark API', baseUrl: 'https://darkapi.dev/v1', rpm: null, custom: false, position: 2,
    keys: [{ id: 'key_locked', name: 'Other PC', cipher: LOCKED_BLOB, active: true, quotaSpent: null }] });
  store.repos.secrets.save('aaApiKey', 'aa-secret');
  return { store, resolver: createKeyResolver({ providers, secrets: store.repos.secrets }) };
}

test('a header placeholder becomes the key for its own provider', async (t) => {
  const { resolver } = await setup(t);
  const out = resolver.resolve({ url: `${NARA}/models`, headers: { Authorization: 'Bearer venomkey:key_1', 'Content-Type': 'application/json' } });
  assert.deepStrictEqual(out, {
    url: `${NARA}/models`,
    headers: { Authorization: 'Bearer sk-nara-1', 'Content-Type': 'application/json' },
    body: undefined,
  });
});

test('a placeholder in the URL is replaced URL-encoded', async (t) => {
  const { resolver } = await setup(t);
  const out = resolver.resolve({ url: `${MIRAI}/usage?key=venomkey:key_m`, headers: {} });
  assert.strictEqual(out.url, `${MIRAI}/usage?key=${encodeURIComponent(TRICKY)}`);
});

test('inside a JSON body the key is inserted JSON-escaped', async (t) => {
  const { resolver } = await setup(t);
  const out = resolver.resolve({
    url: 'https://api.miraiapi.com/api/usage/check', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: 'venomkey:key_m' }),
  });
  assert.deepStrictEqual(JSON.parse(out.body), { api_key: TRICKY });
});

test('a non-JSON string body gets the raw key', async (t) => {
  const { resolver } = await setup(t);
  const out = resolver.resolve({ url: `${NARA}/x`, headers: {}, body: 'token=venomkey:key_1&x=1' });
  assert.strictEqual(out.body, 'token=sk-nara-1&x=1');
});

test('an object body is sent as JSON with the key inside', async (t) => {
  const { resolver } = await setup(t);
  const out = resolver.resolve({ url: `${NARA}/x`, headers: {}, body: { key: 'venomkey:key_1' } });
  assert.deepStrictEqual(JSON.parse(out.body), { key: 'sk-nara-1' });
});

test('the longest matching key id wins', async (t) => {
  const { resolver } = await setup(t);
  const header = (value) => resolver.resolve({ url: `${NARA}/m`, headers: { A: value } }).headers.A;
  assert.strictEqual(header('venomkey:key_12'), 'sk-nara-12');
  assert.strictEqual(header('venomkey:key_1'), 'sk-nara-1');
  assert.strictEqual(header('venomkey:key_1,next'), 'sk-nara-1,next');
});

test("a key sent to another provider's host is refused", async (t) => {
  const { resolver } = await setup(t);
  const auth = { Authorization: 'Bearer venomkey:key_1' };
  assert.deepStrictEqual(resolver.resolve({ url: `${MIRAI}/models`, headers: auth }),
    { blocked: true, error: "Key blocked: api.miraiapi.com is not this key's provider" });
  assert.strictEqual(resolver.resolve({ url: 'http://router.bynara.id/v1/models', headers: auth }).blocked, true);
  assert.strictEqual(resolver.resolve({ url: 'https://router.bynara.id:8443/v1/models', headers: auth }).blocked, true);
  assert.strictEqual(resolver.resolve({ url: 'https://evil.test/?u=https://router.bynara.id', headers: auth }).blocked, true);
});

test('the Artificial Analysis key goes to artificialanalysis.ai only', async (t) => {
  const { resolver } = await setup(t);
  const ok = resolver.resolve({ url: 'https://artificialanalysis.ai/api/v2/data/llms/models', headers: { 'x-api-key': 'venomsecret:aaApiKey' } });
  assert.strictEqual(ok.headers['x-api-key'], 'aa-secret');
  assert.deepStrictEqual(resolver.resolve({ url: `${NARA}/models`, headers: { 'x-api-key': 'venomsecret:aaApiKey' } }),
    { blocked: true, error: "Key blocked: router.bynara.id is not this key's provider" });
});

test('unknown keys, locked keys and unknown secrets are refused', async (t) => {
  const { resolver } = await setup(t);
  assert.match(resolver.resolve({ url: `${NARA}/m`, headers: { A: 'venomkey:nope' } }).error, /unknown key/);
  assert.match(resolver.resolve({ url: 'https://darkapi.dev/v1/m', headers: { A: 'venomkey:key_locked' } }).error, /can't be read on this machine/);
  assert.match(resolver.resolve({ url: `${NARA}/m`, headers: { A: 'venomsecret:githubToken' } }).error, /unknown secret/);
});

test('a request without placeholders is passed through untouched', async (t) => {
  const { resolver } = await setup(t);
  const req = { url: `${NARA}/m`, headers: { A: 'plain', N: 5 }, body: { x: 1 } };
  const out = resolver.resolve(req);
  assert.strictEqual(out.headers, req.headers);
  assert.strictEqual(out.body, req.body);
  assert.strictEqual(out.url, req.url);
});

test('one refused placeholder blocks the whole request', async (t) => {
  const { resolver } = await setup(t);
  const out = resolver.resolve({ url: `${NARA}/m`, headers: { A: 'venomkey:key_1', B: 'venomkey:key_m' } });
  assert.strictEqual(out.blocked, true);
});

test('a replaced key is sent with its new value', async (t) => {
  const { store, resolver } = await setup(t);
  assert.strictEqual(resolver.resolve({ url: `${NARA}/m`, headers: { A: 'venomkey:key_1' } }).headers.A, 'sk-nara-1');
  store.repos.providers.save({ id: 'nara', name: 'NaraRouter', baseUrl: NARA, rpm: null, keys: [{ id: 'key_1', name: 'One', key: 'sk-nara-rotated', active: true }] });
  assert.strictEqual(resolver.resolve({ url: `${NARA}/m`, headers: { A: 'venomkey:key_1' } }).headers.A, 'sk-nara-rotated');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/db/keys.test.js`
Expected: FAIL with `Cannot find module '../../src/db/keys'`.

- [ ] **Step 3: Write `src/db/keys.js`**

```js
// ============================================
// Placeholders → secrets, for outgoing requests
// ============================================
// The renderer never holds a key. It puts venomkey:<keyId> (a provider key) or
// venomsecret:<name> (the Artificial Analysis key) where the key goes — a
// header, the URL, a body — and main swaps in the secret just before sending,
// only when the request goes to that secret's own origin.
//
// Defence in depth, not a wall: a compromised renderer could still repoint a
// provider's base URL with save-provider. It stops a key reaching the wrong
// host by mistake or through an injected URL.
const { SECRET_ORIGINS } = require('./repos/secrets');

const TOKEN = /venom(key|secret):([A-Za-z0-9_.-]+)/g;
const HAS_TOKEN = /venom(?:key|secret):/;

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch (_) {
    return null;
  }
}

function createKeyResolver({ providers, secrets }) {
  // A token's secret and the one origin it may go to. For keys the longest key
  // id that starts the token wins, so venomkey:key_12 is key_12, never key_1
  // followed by a "2".
  function lookup(kind, run) {
    if (kind === 'secret') {
      if (!Object.prototype.hasOwnProperty.call(SECRET_ORIGINS, run)) return { error: `Key blocked: unknown secret "${run}"` };
      const secret = secrets.reveal(run);
      if (secret === null) return { error: `Key blocked: the ${run} secret is not set or can't be read on this machine` };
      return { secret, origin: SECRET_ORIGINS[run], used: run.length };
    }
    for (let len = run.length; len > 0; len -= 1) {
      const record = providers.keyRecord(run.slice(0, len));
      if (!record) continue;
      const secret = providers.revealKey(record.id);
      if (secret === null) return { error: `Key blocked: "${record.name}" can't be read on this machine` };
      return { secret, origin: originOf(record.baseUrl), used: len };
    }
    return { error: `Key blocked: unknown key "${run}"` };
  }

  function substitute(text, target, host, encode) {
    let error = null;
    const out = text.replace(TOKEN, (match, kind, run) => {
      if (error) return match;
      const hit = lookup(kind, run);
      if (hit.error) {
        error = hit.error;
        return match;
      }
      if (!target || hit.origin !== target) {
        error = `Key blocked: ${host} is not this key's provider`;
        return match;
      }
      return encode(hit.secret) + run.slice(hit.used);
    });
    return { text: out, error };
  }

  const raw = (s) => s;
  const inJson = (s) => JSON.stringify(s).slice(1, -1);

  // { url, headers, body } ready to send, or { blocked: true, error }.
  function resolve({ url, headers, body }) {
    const bodyText = body === undefined || body === null || body === '' || typeof body === 'string' ? body : JSON.stringify(body);
    const needed = HAS_TOKEN.test(String(url))
      || Object.values(headers || {}).some((v) => typeof v === 'string' && HAS_TOKEN.test(v))
      || (typeof bodyText === 'string' && HAS_TOKEN.test(bodyText));
    if (!needed) return { url, headers, body };

    const target = originOf(url);
    let host = String(url);
    try {
      host = new URL(url).host;
    } catch (_) {
      // Unparsable: named as given.
    }
    const blocked = (error) => ({ blocked: true, error });

    const u = substitute(String(url), target, host, encodeURIComponent);
    if (u.error) return blocked(u.error);
    const outHeaders = {};
    for (const [name, value] of Object.entries(headers || {})) {
      if (typeof value !== 'string') {
        outHeaders[name] = value;
        continue;
      }
      const h = substitute(value, target, host, raw);
      if (h.error) return blocked(h.error);
      outHeaders[name] = h.text;
    }
    let outBody = bodyText;
    if (typeof bodyText === 'string' && HAS_TOKEN.test(bodyText)) {
      let isJson = true;
      try {
        JSON.parse(bodyText);
      } catch (_) {
        isJson = false;
      }
      const b = substitute(bodyText, target, host, isJson ? inJson : raw);
      if (b.error) return blocked(b.error);
      outBody = b.text;
    }
    return { url: u.text, headers: outHeaders, body: outBody };
  }

  return { resolve };
}

module.exports = { createKeyResolver };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/db/keys.test.js`
Expected: `pass 12`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/db/keys.js test/db/keys.test.js
git commit -m "feat(db): resolve key placeholders per request, only for the key's own origin"
```

---

### Task 16: Main — placeholders out, secrets resolved in `api-request`, `copy-key`

**Files:**
- Modify: `src/db/ipc.js` (full replacement)
- Modify: `test/db/ipc.test.js` (setup, channel list, the phase-1 plaintext test, new tests)
- Modify: `src/main.js` (imports, resolver, `registerDataIpc` call, `api-request`)
- Modify: `src/preload.js` (`copyKey`)

**Interfaces:**
- Consumes: `createKeyResolver` (Task 15); `repos.providers.revealKey` (Task 5).
- Produces:
  - `registerDataIpc({ ipcMain, repos, clipboard, log })` — `plaintextKeys` is gone; `read-config`, `save-provider`, `merge-provider` return placeholders and hints only; `settings.aaApiKey` is `'venomsecret:aaApiKey'` or `''`; new channel `copy-key(keyId) → { copied: true }` (throws for an unknown or locked key).
  - `api-request` resolves placeholders before sending; a refusal resolves `{ status: 0, body: '', elapsed: 0, headers: {}, blocked: true, error }` and is logged; `requests.log` records the request as the renderer sent it.
  - Preload: `copyKey(keyId)`.

- [ ] **Step 1: Update the IPC tests first**

In `test/db/ipc.test.js` replace:
```js
const { memoryStore, quietLog } = require('../helpers');
```
with:
```js
const { memoryStore, quietLog, LOCKED_BLOB } = require('../helpers');
```

Replace:
```js
async function setup(t, opts = {}) {
  const store = await memoryStore(t);
  const ipc = fakeIpcMain();
  registerDataIpc({ ipcMain: ipc, repos: store.repos, log: quietLog, ...opts });
  return { store, ipc };
}
```
with:
```js
async function setup(t) {
  const store = await memoryStore(t);
  const ipc = fakeIpcMain();
  const clipboard = { text: null, writeText(value) { this.text = value; } };
  registerDataIpc({ ipcMain: ipc, repos: store.repos, clipboard, log: quietLog });
  return { store, ipc, clipboard };
}
```

Replace:
```js
    'append-run', 'clear-history', 'delete-provider', 'merge-provider', 'read-catalog', 'read-config',
```
with:
```js
    'append-run', 'clear-history', 'copy-key', 'delete-provider', 'merge-provider', 'read-catalog', 'read-config',
```

Replace the whole phase-1 test:
```js
test('read-config reveals keys and the AA key only when plaintextKeys is on', async (t) => {
  const plain = await setup(t, { plaintextKeys: true });
  await plain.ipc.invoke('save-provider', nara([{ id: 'key_1', name: 'Main', key: 'sk-nara-1', active: true }]));
  await plain.ipc.invoke('save-secret', 'aaApiKey', 'aa-secret');
  const open = await plain.ipc.invoke('read-config');
  assert.strictEqual(open.providers.nara.keys[0].key, 'sk-nara-1');
  assert.strictEqual(open.settings.aaApiKey, 'aa-secret');

  const sealed = await setup(t);
  await sealed.ipc.invoke('save-provider', nara([{ id: 'key_1', name: 'Main', key: 'sk-nara-1', active: true }]));
  await sealed.ipc.invoke('save-secret', 'aaApiKey', 'aa-secret');
  const closed = await sealed.ipc.invoke('read-config');
  assert.strictEqual(closed.providers.nara.keys[0].key, 'venomkey:key_1');
  assert.strictEqual(closed.settings.aaApiKey, 'venomsecret:aaApiKey');
});
```
with:
```js
test('read-config hands out placeholders and hints, never keys', async (t) => {
  const { ipc } = await setup(t);
  await ipc.invoke('save-provider', nara([{ id: 'key_1', name: 'Main', key: 'sk-nara-secret-0001', active: true }]));
  await ipc.invoke('save-secret', 'aaApiKey', 'aa-secret');
  const cfg = await ipc.invoke('read-config');
  assert.deepStrictEqual(cfg.providers.nara.keys[0], {
    id: 'key_1', name: 'Main', key: 'venomkey:key_1', hint: 'sk-nara-se********0001', active: true, locked: false,
  });
  assert.strictEqual(cfg.settings.aaApiKey, 'venomsecret:aaApiKey');
});

test('no reply hands a secret to the renderer', async (t) => {
  const { ipc, clipboard } = await setup(t);
  const secrets = ['sk-live-SECRET-0001', 'sk-live-SECRET-0002', 'aa-live-SECRET'];
  const replies = [];
  replies.push(await ipc.invoke('save-provider', nara([{ id: 'key_1', name: 'A', key: secrets[0], active: true }])));
  replies.push(await ipc.invoke('save-provider', {
    id: 'custom_x', name: 'X', baseUrl: 'https://router.bynara.id/v1/', rpm: null, custom: true,
    keys: [{ id: 'key_2', name: 'B', key: secrets[1], active: true }],
  }));
  replies.push(await ipc.invoke('save-secret', 'aaApiKey', secrets[2]));
  replies.push(await ipc.invoke('read-config'));
  replies.push(await ipc.invoke('merge-provider', 'custom_x', 'nara'));
  replies.push(await ipc.invoke('copy-key', 'key_2'));
  replies.push(await ipc.invoke('read-config'));
  const wire = JSON.stringify(replies);
  secrets.forEach((s) => assert.ok(!wire.includes(s), `${s} reached the renderer`));
  assert.ok(wire.includes('venomkey:key_1') && wire.includes('venomkey:key_2') && wire.includes('venomsecret:aaApiKey'));
  assert.strictEqual(clipboard.text, secrets[1]);
});

test('copy-key writes the clipboard in main and refuses a key it cannot read', async (t) => {
  const { store, ipc, clipboard } = await setup(t);
  store.repos.providers.importProvider({
    id: 'darkapi', name: 'Dark API', baseUrl: 'https://darkapi.dev/v1', rpm: null, custom: false, position: 0,
    keys: [{ id: 'key_9', name: 'Other PC', cipher: LOCKED_BLOB, active: true, quotaSpent: null }],
  });
  await ipc.invoke('save-provider', nara([{ id: 'key_1', name: 'Main', key: 'sk-copy-me', active: true }]));
  assert.deepStrictEqual(await ipc.invoke('copy-key', 'key_1'), { copied: true });
  assert.strictEqual(clipboard.text, 'sk-copy-me');
  await assert.rejects(ipc.invoke('copy-key', 'key_9'), /cannot be read/);
  await assert.rejects(ipc.invoke('copy-key', 'key_nope'), /cannot be read/);
  assert.strictEqual(clipboard.text, 'sk-copy-me');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/db/ipc.test.js`
Expected: FAIL — `registers exactly the data channels` (no `copy-key`), and both copy-key tests with `TypeError: handlers.get(...) is not a function`.

- [ ] **Step 3: Replace `src/db/ipc.js`**

```js
// ============================================
// Data IPC — the renderer's only way to the database
// ============================================
// Each channel reads or writes one thing, so two writers no longer overwrite
// each other's sections of one big file. A handler that fails throws: the
// renderer's promise rejects and it says so. Nothing is swallowed here.
//
// No reply ever carries a secret: keys go out as venomkey:<id> placeholders
// with a masked hint, the Artificial Analysis key as venomsecret:aaApiKey.
function readConfig(repos) {
  const data = { version: 1, providers: repos.providers.list() };
  const settings = repos.settings.get('settings');
  const aa = repos.secrets.has('aaApiKey') ? 'venomsecret:aaApiKey' : '';
  if (settings || aa) data.settings = { ...(settings || {}), aaApiKey: aa };
  const test = repos.settings.get('test');
  if (test) data.test = test;
  const win = repos.settings.get('window');
  if (win) data.window = win;
  return data;
}

function registerDataIpc({ ipcMain, repos, clipboard, log = console }) {
  const handle = (channel, fn) => {
    ipcMain.handle(channel, (_event, ...args) => {
      try {
        return fn(...args);
      } catch (err) {
        log.error(`${channel} failed:`, err.message);
        throw err;
      }
    });
  };

  handle('read-config', () => readConfig(repos));
  handle('save-settings', (settings) => {
    repos.settings.saveSettings(settings);
    return { success: true };
  });
  handle('save-secret', (name, value) => ({ placeholder: repos.secrets.save(name, value) ? `venomsecret:${name}` : '' }));
  handle('save-test-definition', (test) => {
    repos.settings.saveTest(test);
    return { success: true };
  });
  handle('save-provider', (provider) => repos.providers.save(provider));
  handle('merge-provider', (fromId, intoId) => repos.providers.merge(fromId, intoId));
  handle('delete-provider', (id) => ({ deleted: repos.providers.remove(id) }));
  // Main writes the clipboard, so a copied key never passes through the page.
  handle('copy-key', (keyId) => {
    const secret = repos.providers.revealKey(keyId);
    if (secret === null) throw new Error('This key is unknown or cannot be read on this machine');
    clipboard.writeText(secret);
    return { copied: true };
  });
  handle('read-catalog', () => repos.catalog.read());
  handle('write-catalog', (catalog, writeOpts) => repos.catalog.write(catalog, { reset: !!writeOpts && writeOpts.reset === true }));
  handle('read-history', () => repos.history.read());
  handle('append-run', (run, maxRuns) => repos.history.append(run, maxRuns));
  handle('clear-history', () => {
    repos.history.clear();
    return { success: true };
  });
}

module.exports = { registerDataIpc, readConfig };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/db/ipc.test.js`
Expected: `pass 11`, `fail 0`.

- [ ] **Step 5: Wire the resolver and the clipboard into `src/main.js`**

Replace:
```js
const { app, BrowserWindow, ipcMain, Notification, shell, dialog, safeStorage } = require('electron');
```
with:
```js
const { app, BrowserWindow, ipcMain, Notification, shell, dialog, safeStorage, clipboard } = require('electron');
```

Replace:
```js
const { registerDataIpc } = require('./db/ipc');
```
with:
```js
const { registerDataIpc } = require('./db/ipc');
const { createKeyResolver } = require('./db/keys');
```

Replace:
```js
let store = null;
let importReport = null;
```
with:
```js
let store = null;
let importReport = null;
// Swaps key placeholders for secrets in api-request (src/db/keys.js).
let keyResolver = null;
```

Replace:
```js
  // Keys still reach the renderer as plaintext here; they stay in main once
  // the renderer works with placeholders.
  registerDataIpc({ ipcMain, repos: store.repos, log, plaintextKeys: true });
```
with:
```js
  registerDataIpc({ ipcMain, repos: store.repos, clipboard, log });
  keyResolver = createKeyResolver({ providers: store.repos.providers, secrets: store.repos.secrets });
```

- [ ] **Step 6: Resolve placeholders in `api-request`**

Replace:
```js
ipcMain.handle('api-request', async (event, { url, method, headers, body, requestId, timeoutMs, logLevel }) => {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const urlObj = new URL(url);
```
with:
```js
ipcMain.handle('api-request', async (event, { url, method, headers, body, requestId, timeoutMs, logLevel }) => {
  // The renderer holds placeholders (venomkey:<id>, venomsecret:<name>), not
  // keys. They become the real secret here, only for the origin that secret
  // belongs to; anything else is refused without sending. The request log
  // below records the request as the renderer sent it, placeholders and all.
  const outgoing = keyResolver ? keyResolver.resolve({ url, headers, body }) : { url, headers, body };
  if (outgoing.blocked) {
    log.warn(outgoing.error);
    return { status: 0, body: '', elapsed: 0, headers: {}, blocked: true, error: outgoing.error };
  }
  return new Promise((resolve) => {
    const startTime = Date.now();
    const urlObj = new URL(outgoing.url);
```

Replace:
```js
      method: method || 'GET',
      headers: headers || {},
```
with:
```js
      method: method || 'GET',
      headers: outgoing.headers || {},
```

Replace:
```js
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
```
with:
```js
    if (outgoing.body) req.write(typeof outgoing.body === 'string' ? outgoing.body : JSON.stringify(outgoing.body));
    req.end();
```

The three `appendRequestLog` calls keep using `url`, `headers` and `body` (the renderer's originals). Check:

Run: `grep -n "requestHeaders: redactHeaders(headers)\|requestBody: clip(body)" src/main.js`
Expected: two lines each for headers and body (success and error paths) — all still on the original variables.

Run: `node --check src/main.js`
Expected: no output.

- [ ] **Step 7: Expose `copyKey` in `src/preload.js`**

Replace:
```js
  deleteProvider: (id) => ipcRenderer.invoke('delete-provider', id),
```
with:
```js
  deleteProvider: (id) => ipcRenderer.invoke('delete-provider', id),
  // Main decrypts the key and writes the clipboard; the page never holds it.
  copyKey: (keyId) => ipcRenderer.invoke('copy-key', keyId),
```

Run: `node --check src/preload.js && npm test`
Expected: no syntax output; `pass 113`, `fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/db/ipc.js test/db/ipc.test.js src/main.js src/preload.js
git commit -m "feat(keys): keys stay in main — placeholders to the renderer, secrets resolved per request, copy-key"
```

---

### Task 17: Renderer — hints, copy through main, in-place key swap, AA key "Saved"/"Remove"

**Files:**
- Modify: `src/renderer/app.js` (key list mask, `maskKey`, `copyKey`, `saveProviderConfig`, Providers-page key row, Providers-page copy)
- Modify: `src/renderer/key-usage.js:25-27`, `:471`
- Modify: `src/renderer/catalog.js` (`fillSettings`, AA key binding)
- Modify: `src/renderer/index.html:1020-1024`
- Modify: `src/renderer/styles.css` (hidden buttons in `.settings-actions`)
- Modify: `scripts/live/verify-db.mjs` (keys-in-main checks)

**Interfaces:**
- Consumes: key shape `{ id, name, key: 'venomkey:<id>'|'', hint, active, locked, quotaSpent? }`; preload `copyKey`, `saveSecret` (returns `{ placeholder }`).
- Produces: `adoptSavedKeys(p, saved)` (global, app.js); the renderer never shows or holds a secret after a save; `maskKey` no longer exists in the renderer.

- [ ] **Step 1: Route Test key list shows the hint**

In `src/renderer/app.js` replace:
```js
          k.locked ? 'Encrypted for another machine — re-add it' : maskKey(k.key)
```
with:
```js
          k.locked ? 'Encrypted for another machine — re-add it' : escapeHtml(k.hint || '')
```

- [ ] **Step 2: Drop `maskKey`; copy goes through main**

Replace:
```js
// The key is only ever shown masked. Copy is the one way the full value leaves
// the app, so it can't be shoulder-surfed off the screen.
// A key flagged `locked` came out of config.json as ciphertext this machine
// can't open, so there is nothing to send — it is excluded from every run.
function usableKeys(p) {
  return p.keys.filter((k) => k.active && !k.locked);
}

function maskKey(key) {
  if (!key) return '';
  const head = key.length <= 12 ? 6 : 10;
  return key.slice(0, head) + '********' + key.slice(-4);
}

async function copyKey(keyId, btn) {
  const key = PROVIDERS[activeProvider].keys.find((k) => k.id === keyId);
  if (!key) return;
  try {
    await navigator.clipboard.writeText(key.key);
```
with:
```js
// The page never holds a key: k.key is a venomkey:<id> placeholder that main
// swaps for the secret per request, and k.hint is the masked form main
// computed. Copy is the one way the full value leaves the app, and main
// writes it to the clipboard itself.
// A key flagged `locked` is ciphertext this machine can't open, so there is
// nothing to send — it is excluded from every run.
function usableKeys(p) {
  return p.keys.filter((k) => k.active && !k.locked);
}

async function copyKey(keyId, btn) {
  const key = PROVIDERS[activeProvider].keys.find((k) => k.id === keyId);
  if (!key || key.locked) return;
  try {
    await window.electronAPI.copyKey(keyId);
```

- [ ] **Step 3: Swap each key object in place after `save-provider`**

Replace (the Task 12 code):
```js
async function saveProviderConfig(providerId) {
  const p = PROVIDERS[providerId];
  if (!p) return;
  await persist(`save ${p.name}`, () => window.electronAPI.saveProvider(providerPayload(providerId)));
```
with:
```js
// Main answers with each key as a placeholder and a hint. The objects are
// updated in place — the Connect flow still holds the one storeKey created —
// so a key typed a moment ago doesn't stay in the page. Name, active and
// quotaSpent stay the renderer's: a later edit may already be on its way.
function adoptSavedKeys(p, saved) {
  const fresh = new Map(saved.keys.map((k) => [k.id, k]));
  p.keys.forEach((k) => {
    const s = fresh.get(k.id);
    if (!s) return;
    k.key = s.key;
    k.hint = s.hint;
    k.locked = s.locked;
  });
}

async function saveProviderConfig(providerId) {
  const p = PROVIDERS[providerId];
  if (!p) return;
  const saved = await persist(`save ${p.name}`, () => window.electronAPI.saveProvider(providerPayload(providerId)));
  if (saved) adoptSavedKeys(p, saved);
```

- [ ] **Step 4: Providers-page key row shows the hint**

Replace:
```js
        <code>${k.locked ? 'encrypted' : escapeHtml(maskKey(k.key))}</code>
```
with:
```js
        <code>${k.locked ? 'encrypted' : escapeHtml(k.hint || '')}</code>
```

- [ ] **Step 5: Providers-page copy button goes through main**

Replace:
```js
      const k = PROVIDERS[pid]?.keys.find((x) => x.id === kid);
      if (k) {
        try {
          await navigator.clipboard.writeText(k.key);
          kx.classList.add('copied');
          setTimeout(() => kx.classList.remove('copied'), 1200);
        } catch (_) {}
      }
```
with:
```js
      const k = PROVIDERS[pid]?.keys.find((x) => x.id === kid);
      if (k && !k.locked) {
        try {
          await window.electronAPI.copyKey(kid);
          kx.classList.add('copied');
          setTimeout(() => kx.classList.remove('copied'), 1200);
        } catch (err) {
          setStatus('error', 'Could not copy the key to the clipboard');
        }
      }
```

- [ ] **Step 6: key-usage.js uses the hint**

In `src/renderer/key-usage.js` replace:
```js
// Loaded after app.js and uses its globals (PROVIDERS, escapeHtml, maskKey,
// providerLogoHTML, formatAgo, refreshAfterKeyChange, and the spent-quota
```
with:
```js
// Loaded after app.js and uses its globals (PROVIDERS, escapeHtml,
// providerLogoHTML, formatAgo, refreshAfterKeyChange, and the spent-quota
```

Replace:
```js
        <span class="ku-head-sub">${escapeHtml(p.name)} · <code>${escapeHtml(maskKey(k.key))}</code></span>
```
with:
```js
        <span class="ku-head-sub">${escapeHtml(p.name)} · <code>${escapeHtml(k.hint || '')}</code></span>
```

Run: `grep -rn "maskKey\|clipboard.writeText(k" src/renderer`
Expected: no output.

- [ ] **Step 7: AA key markup — "Saved" and "Remove"**

In `src/renderer/index.html` replace:
```html
                      <div class="settings-row-field"><input type="password" class="prompt-input" id="set-aa-key" spellcheck="false" autocomplete="off" placeholder="aa_… (free key from artificialanalysis.ai)">
                    <div class="settings-actions">
                      <button class="btn btn-ghost" id="btn-aa-refresh" type="button">Refresh global leaderboard</button>
```
with:
```html
                      <div class="settings-row-field"><input type="password" class="prompt-input" id="set-aa-key" spellcheck="false" autocomplete="off" placeholder="aa_… (free key from artificialanalysis.ai)">
                    <div class="settings-actions">
                      <span class="settings-row-status" id="aa-key-saved" hidden>Saved</span>
                      <button class="btn btn-ghost" id="btn-aa-remove" type="button" hidden>Remove</button>
                      <button class="btn btn-ghost" id="btn-aa-refresh" type="button">Refresh global leaderboard</button>
```

In `src/renderer/styles.css` replace:
```css
.settings-row-field > .settings-actions { margin-top: 0; }
```
with:
```css
.settings-row-field > .settings-actions { margin-top: 0; }
.settings-actions .btn[hidden] { display: none; }
```

- [ ] **Step 8: AA key behaviour (catalog.js)**

In `src/renderer/catalog.js` replace:
```js
    const key = $('#set-aa-key');
    if (key) key.value = settings.aaApiKey || '';
    renderLeaderboardStatus();
  }
```
with:
```js
    renderAaKey();
    renderLeaderboardStatus();
  }

  // The key never comes back to the page: a saved one shows as "Saved" with an
  // empty field, and typing a new one replaces it.
  const AA_PLACEHOLDER = 'aa_… (free key from artificialanalysis.ai)';
  function renderAaKey() {
    const saved = settings.aaApiKey === 'venomsecret:aaApiKey';
    const key = $('#set-aa-key');
    if (key) {
      key.value = '';
      key.placeholder = saved ? 'Saved — type a new key to replace it' : AA_PLACEHOLDER;
    }
    const badge = $('#aa-key-saved');
    if (badge) badge.hidden = !saved;
    const remove = $('#btn-aa-remove');
    if (remove) remove.hidden = !saved;
  }

  // Empty or unchanged text is not a change. New text goes to main, which
  // encrypts it; the page keeps only the placeholder. On failure the typed
  // text stays in the field so it can be retried.
  async function storeAaKey() {
    const key = $('#set-aa-key');
    const text = key ? key.value.trim() : '';
    if (!text || text === settings.aaApiKey) return;
    const res = await persist('save the Artificial Analysis key', () => window.electronAPI.saveSecret('aaApiKey', text));
    if (!res) return;
    settings.aaApiKey = res.placeholder;
    renderAaKey();
  }

  async function removeAaKey() {
    const res = await persist('remove the Artificial Analysis key', () => window.electronAPI.saveSecret('aaApiKey', ''));
    if (!res) return;
    settings.aaApiKey = '';
    renderAaKey();
    renderLeaderboardStatus();
  }
```

Replace (the Task 11 code):
```js
    const key = $('#set-aa-key');
    // The key is a saved secret, encrypted in main; save-settings drops it.
    const saveAaKey = () => {
      settings.aaApiKey = key.value.trim();
      return persist('save the Artificial Analysis key', () => window.electronAPI.saveSecret('aaApiKey', settings.aaApiKey));
    };
    if (key) key.addEventListener('change', saveAaKey);
    const refresh = $('#btn-aa-refresh');
    if (refresh) refresh.addEventListener('click', async () => {
      if (key) await saveAaKey();
```
with:
```js
    const key = $('#set-aa-key');
    if (key) key.addEventListener('change', storeAaKey);
    const removeKey = $('#btn-aa-remove');
    if (removeKey) removeKey.addEventListener('click', removeAaKey);
    const refresh = $('#btn-aa-refresh');
    if (refresh) refresh.addEventListener('click', async () => {
      await storeAaKey();
```

`apiKeyPresent()` and `refreshLeaderboard()` need no change: the placeholder is longer than 8 characters and goes out in the `x-api-key` header, where main swaps it for the key (artificialanalysis.ai only).

Run: `node --check src/renderer/app.js && node --check src/renderer/catalog.js && node --check src/renderer/key-usage.js`
Expected: no output.

- [ ] **Step 9: Add the keys-in-main live checks**

In `scripts/live/verify-db.mjs` replace:
```js
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
```
with:
```js
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
```

Replace:
```js
// Saved and waited for, so the next run can check it survived.
```
with:
```js
// ---- keys stay in main ----------------------------------------------------------

async function checkKeysStayInMain({ app, dir, mock }) {
  const s = await app.evaluate(`(async () => {
    const cfg = await window.electronAPI.readConfig();
    const keys = Object.values(PROVIDERS).flatMap((p) => p.keys);
    const blocked = await window.electronAPI.apiRequest({
      url: 'http://localhost:${FIXTURE.port}/steal/models', method: 'GET',
      headers: { Authorization: 'Bearer venomkey:k_dark_1' },
    });
    const sent = await window.electronAPI.apiRequest({
      url: PROVIDERS.darkapi.baseUrl + '/chat/completions', method: 'POST', logLevel: 'all',
      headers: { Authorization: 'Bearer venomkey:k_dark_1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'fixture-alpha', api_key: 'venomkey:k_dark_1', messages: [{ role: 'user', content: 'hi' }] }),
    });
    let lockedCopy = 'copied';
    try { await window.electronAPI.copyKey('k_nexum_locked'); } catch (err) { lockedCopy = 'refused'; }
    CATALOG.fillSettings();
    return {
      page: JSON.stringify({ providers: PROVIDERS, settings, cfg }),
      placeholders: keys.every((k) => (k.locked ? k.key === '' : k.key === 'venomkey:' + k.id)),
      hint: PROVIDERS.darkapi.keys.find((k) => k.id === 'k_dark_1').hint,
      aa: settings.aaApiKey,
      aaField: document.querySelector('#set-aa-key').value,
      aaSaved: !document.querySelector('#aa-key-saved').hidden,
      blocked,
      sentStatus: sent.status,
      lockedCopy,
    };
  })()`);
  check('no key and no AA key anywhere in the page', !s.page.includes('sk-fixture-') && !s.page.includes(FIXTURE.aaKey));
  check('every key is its placeholder (a locked key is empty)', s.placeholders);
  check('the key hint is the old mask', s.hint === 'sk-fixture********0001', s.hint);
  check('settings.aaApiKey is the placeholder', s.aa === 'venomsecret:aaApiKey', s.aa);
  check('the AA key field is empty with "Saved" showing', s.aaField === '' && s.aaSaved);
  check("a key sent to a host that isn't its provider is refused",
    s.blocked.blocked === true && s.blocked.status === 0 && s.blocked.error === "Key blocked: localhost:47831 is not this key's provider",
    JSON.stringify(s.blocked));
  check('the refused request never left the app', !mock.requests.some((r) => r.url.includes('/steal')));
  const hit = mock.requests.find((r) => r.url.endsWith('/darkapi/v1/chat/completions') && r.body.includes('fixture-alpha'));
  check('main put the real key in the header and the JSON body',
    s.sentStatus === 200 && !!hit && hit.authorization === `Bearer ${FIXTURE.keys.dark1}` && JSON.parse(hit.body).api_key === FIXTURE.keys.dark1);
  const log = existsSync(join(dir, 'requests.log')) ? readFileSync(join(dir, 'requests.log'), 'utf-8') : '';
  check('requests.log keeps the placeholder, never the key', log.includes('venomkey:k_dark_1') && !log.includes(FIXTURE.keys.dark1));
  check('copy-key refuses a locked key', s.lockedCopy === 'refused');
}

// Saved and waited for, so the next run can check it survived.
```

Replace:
```js
const RUN1 = [checkImport];
```
with:
```js
const RUN1 = [checkImport, checkKeysStayInMain];
```

- [ ] **Step 10: Run the live check**

Run: `npm run verify:live`
Expected: every line `PASS`, including the ten keys-in-main checks; last line `ALL LIVE CHECKS PASSED`.

Run: `npm test`
Expected: `pass 113`, `fail 0`.

- [ ] **Step 11: Commit**

```bash
git add src/renderer/app.js src/renderer/key-usage.js src/renderer/catalog.js src/renderer/index.html src/renderer/styles.css scripts/live/verify-db.mjs
git commit -m "feat(renderer): keys shown as hints, copied by main, swapped for placeholders after save; AA key Saved/Remove"
```

# Phase 3 — Close flush and the single-instance lock

### Task 18: Single-instance lock

**Files:**
- Modify: `src/main.js` (after the userData block; start of `whenReady`)
- Modify: `scripts/live/cdp.mjs` (`spawnPlain`)
- Modify: `scripts/live/verify-db.mjs` (single-instance check)

**Interfaces:**
- Consumes: `appEnv`, `ROOT`, `ELECTRON`, `assertScratchDir` (Task 10).
- Produces: `isPrimary` in main (false → `app.quit()` and `whenReady` does nothing); `second-instance` restores and focuses the open window. `spawnPlain({ userDataDir }) → { child, exited: Promise<code> }` in `cdp.mjs`.

- [ ] **Step 1: Write the failing live check**

In `scripts/live/cdp.mjs` append at the end of the file:
```js
// A second, plain instance on the same data folder (no CDP), for the
// single-instance check.
export function spawnPlain({ userDataDir }) {
  assertScratchDir(userDataDir);
  const child = spawn(ELECTRON, ['.', `--user-data-dir=${userDataDir}`], { cwd: ROOT, env: appEnv(), stdio: 'ignore' });
  return { child, exited: new Promise((resolve) => child.on('exit', (code) => resolve(code))) };
}
```

In `scripts/live/verify-db.mjs` replace:
```js
import { launch } from './cdp.mjs';
```
with:
```js
import { launch, spawnPlain } from './cdp.mjs';
```

Replace:
```js
// Last in its run: it poisons the session on purpose.
```
with:
```js
async function checkSingleInstance({ app, dir }) {
  const second = spawnPlain({ userDataDir: dir });
  const code = await Promise.race([second.exited, sleep(15000).then(() => 'timeout')]);
  if (code === 'timeout') {
    second.child.kill();
    await second.exited;
  }
  check('a second instance on the same data folder exits on its own', code !== 'timeout', String(code));
  check('the first instance keeps running', (await app.evaluate('1 + 1')) === 2);
}

// Last in its run: it poisons the session on purpose.
```

Replace:
```js
const RUN2 = [checkPersistence];
```
with:
```js
const RUN2 = [checkPersistence, checkSingleInstance];
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run verify:live`
Expected: `FAIL  a second instance on the same data folder exits on its own  -> timeout` (a second window opens and is killed by the script after 15 s); the run ends with `1 CHECK(S) FAILED`.

- [ ] **Step 3: Take the lock in `src/main.js`**

Replace:
```js
    if (userData.error) log.warn('Could not move the old app data folder, still using it:', userData.error.message);
  }
}
```
with:
```js
    if (userData.error) log.warn('Could not move the old app data folder, still using it:', userData.error.message);
  }
}

// One instance per data folder (the lock is per userData, so it comes right
// after setPath and before the database opens). A second instance would run
// every timer twice and race the first one's writes; it hands over to the
// window that is already open and quits.
const isPrimary = app.requestSingleInstanceLock();
if (!isPrimary) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}
```

Replace:
```js
app.whenReady().then(async () => {
  if (!(await startDatabase())) {
```
with:
```js
app.whenReady().then(async () => {
  if (!isPrimary) return;
  if (!(await startDatabase())) {
```

Run: `node --check src/main.js`
Expected: no output.

- [ ] **Step 4: Run the live check to verify it passes**

Run: `npm run verify:live`
Expected: `PASS  a second instance on the same data folder exits on its own  -> 0`, `PASS  the first instance keeps running`, and `ALL LIVE CHECKS PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/main.js scripts/live/cdp.mjs scripts/live/verify-db.mjs
git commit -m "feat(main): single-instance lock per data folder"
```

---

### Task 19: Close flush handshake

**Files:**
- Create: `src/flush.js`
- Test: `test/flush.test.js`
- Modify: `src/main.js` (require; flush state; `createWindow` close handler; `install-update`)
- Modify: `src/preload.js` (`onFlushPending`, `flushDone`)
- Modify: `src/renderer/app.js` (`flushPendingSaves` + listener, after `persist`)
- Modify: `src/renderer/catalog.js` (`flush` export)
- Modify: `scripts/live/verify-db.mjs` (flush-on-close check)

**Interfaces:**
- Consumes: `saveSettingsNow`, `saveSettingsTimer`, `saveTestDefinition`, `saveTestTimer`, `pendingSaves` (Task 11); `flushSave` (Task 12); `saveWindowState` (Task 10).
- Produces:
  - `src/flush.js`: `requestFlush({ webContents, ipcMain, timeoutMs = 2000 }) → Promise<'done' | 'timeout' | 'skipped'>`; `DEFAULT_FLUSH_TIMEOUT_MS = 2000`. Sends `flush-pending` with a token and waits for `flush-done` carrying the same token.
  - Main: `flushBeforeClose() → Promise` (shared by the close handler and `install-update`; writes the `window` row once the renderer answered or timed out).
  - Preload: `onFlushPending(callback(token))`, `flushDone(token)`.
  - `CATALOG.flush() → Promise`.

- [ ] **Step 1: Write the failing test**

`test/flush.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { requestFlush, DEFAULT_FLUSH_TIMEOUT_MS } = require('../src/flush');

// answer: 'right' (echo the token), 'stale' (an old token), 'never'.
function fakes({ answer = 'right', destroyed = false } = {}) {
  const ipcMain = new EventEmitter();
  const sent = [];
  const webContents = {
    isDestroyed: () => destroyed,
    isCrashed: () => false,
    send(channel, token) {
      sent.push(channel);
      if (answer === 'right') setImmediate(() => ipcMain.emit('flush-done', {}, token));
      if (answer === 'stale') setImmediate(() => ipcMain.emit('flush-done', {}, 'an-earlier-token'));
    },
  };
  return { ipcMain, webContents, sent };
}

test('resolves "done" when the renderer confirms, then stops listening', async () => {
  const f = fakes();
  assert.strictEqual(await requestFlush({ webContents: f.webContents, ipcMain: f.ipcMain, timeoutMs: 1000 }), 'done');
  assert.deepStrictEqual(f.sent, ['flush-pending']);
  assert.strictEqual(f.ipcMain.listenerCount('flush-done'), 0);
});

test('a renderer that never answers cannot hold the close past the timeout', async () => {
  const f = fakes({ answer: 'never' });
  const started = Date.now();
  assert.strictEqual(await requestFlush({ webContents: f.webContents, ipcMain: f.ipcMain, timeoutMs: 100 }), 'timeout');
  const took = Date.now() - started;
  assert.ok(took >= 90 && took < 1000, `took ${took} ms`);
  assert.strictEqual(f.ipcMain.listenerCount('flush-done'), 0);
});

test('an answer to an earlier request is ignored', async () => {
  const f = fakes({ answer: 'stale' });
  assert.strictEqual(await requestFlush({ webContents: f.webContents, ipcMain: f.ipcMain, timeoutMs: 100 }), 'timeout');
});

test('a destroyed window is skipped at once', async () => {
  const f = fakes({ destroyed: true });
  assert.strictEqual(await requestFlush({ webContents: f.webContents, ipcMain: f.ipcMain, timeoutMs: 1000 }), 'skipped');
  assert.deepStrictEqual(f.sent, []);
});

test('the default wait is 2 seconds', () => {
  assert.strictEqual(DEFAULT_FLUSH_TIMEOUT_MS, 2000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/flush.test.js`
Expected: FAIL with `Cannot find module '../src/flush'`.

- [ ] **Step 3: Write `src/flush.js`**

```js
// ============================================
// Close handshake with the renderer
// ============================================
// Before the window closes, and before an update installs, the renderer is
// asked to write what it still holds (debounced settings, the test prompt, the
// model pool). Main waits for its answer, but at most timeoutMs, so a hung
// renderer can never keep the app open. The token ties an answer to its
// request, so a late answer to an earlier close can't end this one.
const DEFAULT_FLUSH_TIMEOUT_MS = 2000;

function requestFlush({ webContents, ipcMain, timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    if (!webContents || webContents.isDestroyed() || webContents.isCrashed()) {
      resolve('skipped');
      return;
    }
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let timer = null;
    const finish = (how) => {
      clearTimeout(timer);
      ipcMain.removeListener('flush-done', onDone);
      resolve(how);
    };
    function onDone(_event, answer) {
      if (answer === token) finish('done');
    }
    ipcMain.on('flush-done', onDone);
    timer = setTimeout(() => finish('timeout'), timeoutMs);
    try {
      webContents.send('flush-pending', token);
    } catch (_) {
      finish('skipped');
    }
  });
}

module.exports = { requestFlush, DEFAULT_FLUSH_TIMEOUT_MS };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/flush.test.js`
Expected: `pass 5`, `fail 0`.

- [ ] **Step 5: Use it in `src/main.js`**

Replace:
```js
const { createKeyResolver } = require('./db/keys');
```
with:
```js
const { createKeyResolver } = require('./db/keys');
const { requestFlush } = require('./flush');
```

Replace:
```js
function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed() || !store) return;
```
with:
```js
// The renderer's pending saves go out before the window closes or an update
// installs (src/flush.js). One flush per window, shared: a second click on
// the X, or the update path, waits on the same one.
let flushPromise = null;
let flushed = false;
function flushBeforeClose() {
  if (!flushPromise) {
    const asked = mainWindow && !mainWindow.isDestroyed()
      ? requestFlush({ webContents: mainWindow.webContents, ipcMain })
      : Promise.resolve('skipped');
    flushPromise = asked.then((how) => {
      if (how === 'timeout') log.warn('The window did not confirm its pending saves within 2 s; closing anyway');
      saveWindowState();
      flushed = true;
    });
  }
  return flushPromise;
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed() || !store) return;
```

Replace:
```js
function createWindow() {
  const saved = (store && store.repos.settings.get('window')) || {};
```
with:
```js
function createWindow() {
  flushPromise = null;
  flushed = false;
  const saved = (store && store.repos.settings.get('window')) || {};
```

Replace:
```js
  mainWindow.on('close', saveWindowState);
```
with:
```js
  // The X button, Alt+F4 and the title-bar close all land here. The first
  // close waits for the renderer's pending saves (at most 2 s) and the window
  // row, then destroys the window; destroy() does not fire 'close' again.
  mainWindow.on('close', (event) => {
    if (flushed) return;
    event.preventDefault();
    flushBeforeClose().then(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    });
  });
```

Replace:
```js
ipcMain.on('install-update', () => {
  log.info('User requested update install');
  if (autoUpdater) setImmediate(() => autoUpdater.quitAndInstall(true, true));
});
```
with:
```js
ipcMain.on('install-update', () => {
  log.info('User requested update install');
  if (!autoUpdater) return;
  // electron-updater starts the installer before the app quits, so the
  // renderer's pending saves are written first.
  flushBeforeClose().then(() => setImmediate(() => autoUpdater.quitAndInstall(true, true)));
});
```

Run: `node --check src/main.js`
Expected: no output.

- [ ] **Step 6: Expose the handshake in `src/preload.js`**

Replace:
```js
  // App info
  onAppVersion: (callback) => {
    ipcRenderer.on('app-version', (_, version) => callback(version));
  },
```
with:
```js
  // App info
  onAppVersion: (callback) => {
    ipcRenderer.on('app-version', (_, version) => callback(version));
  },

  // Close handshake: main asks for pending saves before the window closes or
  // an update installs; the renderer answers once they are written.
  onFlushPending: (callback) => ipcRenderer.on('flush-pending', (_, token) => callback(token)),
  flushDone: (token) => ipcRenderer.send('flush-done', token),
```

- [ ] **Step 7: Answer it in the renderer**

In `src/renderer/app.js` replace:
```js
// ============================================
// Providers — each saved on its own (save-provider)
// ============================================
```
with:
```js
// Close handshake (main's flush-pending, sent before the window closes and
// before an update installs): debounced writes go out now instead of being
// dropped, writes already in flight are waited for, then main is told.
async function flushPendingSaves() {
  const writes = [];
  if (saveSettingsTimer) writes.push(saveSettingsNow());
  if (saveTestTimer) writes.push(saveTestDefinition());
  if (window.CATALOG) writes.push(window.CATALOG.flush());
  await Promise.allSettled(writes);
  await Promise.allSettled([...pendingSaves]);
}

window.electronAPI.onFlushPending(async (token) => {
  try {
    await flushPendingSaves();
  } finally {
    window.electronAPI.flushDone(token);
  }
});

// ============================================
// Providers — each saved on its own (save-provider)
// ============================================
```

In `src/renderer/catalog.js` replace:
```js
  function flushSave() {
```
with:
```js
  // For the close handshake: the pending write, now, if there is one.
  function flush() {
    return saveTimer ? flushSave() : Promise.resolve();
  }

  function flushSave() {
```

Replace:
```js
  window.CATALOG = {
    init,
```
with:
```js
  window.CATALOG = {
    init,
    flush,
```

Run: `node --check src/renderer/app.js && node --check src/renderer/catalog.js && node --check src/preload.js`
Expected: no output.

- [ ] **Step 8: Add the flush-on-close live check**

In `scripts/live/verify-db.mjs` replace:
```js
// ---- run 2: relaunch on the same folder -----------------------------------------
```
with:
```js
// Queued and NOT waited for: the close that follows must still write it.
async function queueSaveThenClose({ app }) {
  await app.evaluate('settings.hedgeStepMs = 2345; queueSettingsSave(); true');
}

// ---- run 2: relaunch on the same folder -----------------------------------------

async function checkFlushOnClose({ app }) {
  const v = await app.evaluate('settings.hedgeStepMs');
  check('a save queued right before closing was written by the close handshake', v === 2345, String(v));
}
```

Replace:
```js
const RUN1_END = [saveForNextRun];
const RUN2 = [checkPersistence, checkSingleInstance];
```
with:
```js
const RUN1_END = [saveForNextRun, queueSaveThenClose];
const RUN2 = [checkPersistence, checkFlushOnClose, checkSingleInstance];
```

- [ ] **Step 9: Run everything**

Run: `npm test`
Expected: `pass 118`, `fail 0`.

Run: `npm run verify:live`
Expected: `PASS  a save queued right before closing was written by the close handshake  -> 2345`, both runs exit with code 0, `ALL LIVE CHECKS PASSED`.

To see the check can fail, temporarily comment out the `window.electronAPI.onFlushPending(...)` registration, re-run: the check reads the default `2000` and fails, and the close still completes after about 2 s (the timeout path). Restore the registration and re-run to green before committing.

- [ ] **Step 10: Commit**

```bash
git add src/flush.js test/flush.test.js src/main.js src/preload.js src/renderer/app.js src/renderer/catalog.js scripts/live/verify-db.mjs
git commit -m "feat(main): flush the renderer's pending saves before close and before an update installs"
```

---

# Phase 4 — Packaging and the release smoke step

### Task 20: `--smoke-test`, build → smoke → publish, final verification

**Files:**
- Modify: `src/main.js` (`runSmokeTest`, `whenReady`)
- Modify: `scripts/release.mjs` (imports, header comment, smoke step, publish from the tested build)

**Interfaces:**
- Consumes: `database.open`, `createCipher` (Tasks 2-3); `isPrimary` (Task 18).
- Produces: `VENOM Router.exe --smoke-test --user-data-dir=<dir>` → opens `venom.db` in `<dir>`, writes and reads a `smoke` settings row, exits 0 (1 on failure, 2 without `--user-data-dir`); no window, no import, no network. `npm run release` builds with `--publish never`, checks the unpacked native module, runs the smoke test, and only then pushes, tags and publishes the same build with `--prepackaged dist/win-unpacked`.

- [ ] **Step 1: Add the smoke test to `src/main.js`**

First, refuse a smoke run without a scratch folder before anything resolves or locks the real data folder. Replace:
```js
// Settled before anything reads a path or writes a log. An explicit
// --user-data-dir (dev and test instances) is used as given.
if (!app.commandLine.hasSwitch('user-data-dir')) {
```
with:
```js
// --smoke-test only ever runs on an explicit scratch folder: refused here,
// before the real data folder is resolved, moved or locked.
if (app.commandLine.hasSwitch('smoke-test') && !app.commandLine.hasSwitch('user-data-dir')) {
  console.error('SMOKE FAILED: --smoke-test needs --user-data-dir');
  process.exit(2);
}

// Settled before anything reads a path or writes a log. An explicit
// --user-data-dir (dev and test instances) is used as given.
if (!app.commandLine.hasSwitch('user-data-dir')) {
```

Then replace:
```js
let mainWindow;

// Damaged files and skipped rows from the import, said once the window is up.
```
with:
```js
// Release check (scripts/release.mjs): the packaged app is started with
// --smoke-test --user-data-dir=<temp>. It opens the database, writes and reads
// back a row, and exits 0 — proof that the native SQLite module loads from
// app.asar.unpacked. No window, no import, no network. (A run without
// --user-data-dir was already refused at the top of this file.)
async function runSmokeTest() {
  let code = 1;
  try {
    const smoke = await database.open(app.getPath('userData'), { cipher: createCipher(safeStorage), log });
    const stamp = `smoke-${Date.now()}`;
    smoke.repos.settings.set('smoke', { stamp });
    const back = smoke.repos.settings.get('smoke');
    smoke.close();
    code = back && back.stamp === stamp ? 0 : 1;
    console.log(code === 0 ? 'SMOKE OK' : 'SMOKE FAILED: the row read back differs');
  } catch (err) {
    console.error('SMOKE FAILED:', (err && err.stack) || err);
  }
  app.exit(code);
}

let mainWindow;

// Damaged files and skipped rows from the import, said once the window is up.
```

Replace:
```js
app.whenReady().then(async () => {
  if (!isPrimary) return;
  if (!(await startDatabase())) {
```
with:
```js
app.whenReady().then(async () => {
  if (!isPrimary) return;
  if (app.commandLine.hasSwitch('smoke-test')) {
    await runSmokeTest();
    return;
  }
  if (!(await startDatabase())) {
```

Run: `node --check src/main.js`
Expected: no output.

- [ ] **Step 2: Check the flag in the dev app**

```bash
SMOKE_DIR="$(mktemp -d)"
npx electron . --smoke-test --user-data-dir="$(cygpath -w "$SMOKE_DIR")"; echo "exit=$?"
ls "$SMOKE_DIR"
rm -rf "$SMOKE_DIR"
npx electron . --smoke-test; echo "exit=$?"
```
Expected: `SMOKE OK` and `exit=0`; the folder listing shows `venom.db` (and Chromium's own files); then `SMOKE FAILED: --smoke-test needs --user-data-dir` and `exit=2`. No window opens in either run.

- [ ] **Step 3: Build → smoke → publish in `scripts/release.mjs`**

Replace:
```js
// Usage:  bump "version" in package.json, commit, then:  npm run release
```
with:
```js
// Nothing is pushed, tagged or uploaded until the build has passed a smoke
// test: the packaged app is started with --smoke-test on a scratch data
// folder and must open its database (the native better-sqlite3 module from
// app.asar.unpacked), write, read and exit 0. The installers uploaded at the
// end are made from that same tested build (--prepackaged).
//
// Usage:  bump "version" in package.json, commit, then:  npm run release
```

Replace:
```js
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
```
with:
```js
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
```

Replace:
```js
const releasesForTag = () =>
```
with:
```js
// 2b. Build without publishing and prove the packaged app starts.
function smokeTest() {
  const unpacked = fileURLToPath(new URL('../dist/win-unpacked/', import.meta.url));
  const exe = join(unpacked, 'VENOM Router.exe');
  const native = join(unpacked, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  if (!existsSync(native)) {
    console.error(`Smoke test failed: ${native} is missing from the build. Nothing was published.`);
    process.exit(1);
  }
  const dir = mkdtempSync(join(tmpdir(), 'venom-smoke-'));
  try {
    console.log(`$ "${exe}" --smoke-test --user-data-dir=<temp>`);
    const res = spawnSync(exe, ['--smoke-test', `--user-data-dir=${dir}`], { stdio: 'inherit', timeout: 60000 });
    if (res.status !== 0) {
      console.error(`Smoke test failed (exit ${res.status ?? (res.error && res.error.message)}). Nothing was published.`);
      process.exit(1);
    }
    console.log('Smoke test passed.\n');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

run('electron-builder --win --x64 --publish never');
smokeTest();

const releasesForTag = () =>
```

Replace:
```js
// 7. Build the installers and upload them to that release.
run('electron-builder --win --x64 --publish always');
```
with:
```js
// 7. Package the smoke-tested build into the installers and upload them to
//    that release. --prepackaged reuses dist/win-unpacked instead of building
//    a second, untested copy.
run('electron-builder --win --x64 --prepackaged dist/win-unpacked --publish always');
```

Run: `node --check scripts/release.mjs`
Expected: no output. (Do not run `npm run release`: it pushes and publishes.)

- [ ] **Step 4: Build the packaged app and run the smoke step by hand**

Run: `npm run build`
Expected: electron-builder rebuilds `better-sqlite3` for Electron (a `rebuilding native dependency` / `install prebuilt binary` line naming it) and writes `dist/win-unpacked/` plus the NSIS and portable installers; exit 0.

```bash
ls "dist/win-unpacked/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
SMOKE_DIR="$(mktemp -d)"
"dist/win-unpacked/VENOM Router.exe" --smoke-test --user-data-dir="$(cygpath -w "$SMOKE_DIR")"; echo "exit=$?"
rm -rf "$SMOKE_DIR"
```
Expected: the `.node` path is listed; `exit=0`.

Dry-run the publish command without publishing, to prove `--prepackaged` packages the tested build:
```bash
npx electron-builder --win --x64 --prepackaged dist/win-unpacked --publish never
```
Expected: `VENOM-Router-Setup-<version>.exe` and `VENOM Router - Portable.exe` written to `dist/` again, exit 0.

- [ ] **Step 5: Full verification**

Run: `npm test`
Expected: `pass 118`, `fail 0`.

Run: `npm run verify:live`
Expected: `ALL LIVE CHECKS PASSED`.

Run: `grep -rnE "writeConfig|maskKey|navigator\.clipboard\.writeText\(k" src/`
Expected: no output.

Run: `git status --short`
Expected: only `src/main.js` and `scripts/release.mjs` modified (`dist/` is ignored; if it is not, do not add it).

- [ ] **Step 6: Commit**

```bash
git add src/main.js scripts/release.mjs
git commit -m "build: --smoke-test flag; release builds, smoke-tests, then publishes the same build"
```

- [ ] **Step 7: Hand-off notes for the owner (chat, not a file)**

Tell the owner, in the final report:
- `npm start` uses the real data folder, %APPDATA%\venom-router, same as the installed release (owner decision 2026-09-26, commit fba2d91). Before installing a new version, copy %APPDATA%\venom-router somewhere safe yourself.
- Before installing the new version, run `npm run check:import` once (legacy counts only); after the first launch, close the app and run it again to compare. It is read-only, offline and decrypts nothing.
- The old JSON files are kept as `*.imported.json` next to `venom.db`. An older build started after this one will start empty (accepted in the spec); the files make a manual rollback possible.
- `npm run release` now builds and smoke-tests before it pushes or publishes anything.

