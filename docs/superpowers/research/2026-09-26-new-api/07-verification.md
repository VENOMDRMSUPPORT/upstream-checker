# Verification of 06-venom-current-persistence.md

An independent agent checked the persistence audit against the source (no user data opened).
Overall reliability: 8/10. File:line references were accurate where checked.

## Verdicts

| # | Claim | Verdict | Correction / evidence |
|---|---|---|---|
| 1 | JSON stores rewritten whole; requests.log append-only | CONFIRMED | config `main.js:90-97`; history `main.js:135-149`; catalog `main.js:191-197`; requests.log `appendFileSync` `main.js:538`, rotates to `.1` above 5 MiB (`main.js:507`, strict `>`), rotation errors swallowed |
| 2 | Whole catalogue sent on every save, at least once per sync | CONFIRMED | `catalog.js:75-81`, unconditional `save()` at `catalog.js:262`; the `online` event also triggers sync (`catalog.js:1061`) |
| 3 | Keys decrypted on every read and sent to the renderer in plaintext | CONFIRMED | `main.js:54`, `main.js:611-613`. All HTTP goes out from main (`api-request`, `main.js:388-483`), but the renderer holds the plaintext key and builds the auth header (e.g. `app.js:5253`, `catalog.js:450`) |
| 4 | `settings.aaApiKey` unencrypted | CONFIRMED | `keystore.js:50-55` walks only provider keys |
| 5 | Corrupt config.json read as empty, then overwritten, losing all keys | CONFIRMED, broader | ANY `readConfig` exception (EBUSY/EPERM from antivirus or OneDrive, a 0-byte file after power loss, `null`) falls back to defaults (`main.js:55-57`); the renderer seeds providers and writes (`app.js:612-614`, `:651-653`). Second wipe path: `saveWindowState` on window close (`main.js:207-212`, `:248`) writes the default config back |
| 6 | Temp + rename, no fsync, no single-instance lock, pending saves dropped on quit | CONFIRMED | no `fsync`, `requestSingleInstanceLock`, `before-quit`; debounced timers abandoned (settings 350 ms `app.js:295-305`, test 400 ms `app.js:513-515`, catalogue 300 ms `catalog.js:77`) |
| 7 | Concurrent config saves can lose updates | CONFIRMED | read-then-write across two IPC calls (`app.js:299-301`, `:502-504`, `:357-360`, `:590`/`:653`) |
| 8 | Runs have no ID; uptime depends on order and cap | PARTLY | no ID (`app.js:435-449`); uptime is ok/count, independent of order, but depends on the cap; order matters for regression detection (`app.js:430`) and sparklines |
| 9 | Quota refusal → config save, health probe, re-sync after 1.5 s | CONFIRMED | `app.js:2398-2400` → `:1652-1660` → `:357-365` → `catalog.js:1051-1055` (debounced; skipped if a sync is running) |

## Missed by the audit

1. Write failures are silent: `writeConfig`/`writeCatalog` return `{success:false}` and no caller checks it.
2. A failed read equals an empty store for all three JSON files (`readCatalog` `main.js:185-188`).
3. `saveWindowState` is a second overwrite path after a failed read.
4. In-memory history grows without bound during a session; the run cap is shared by all providers (`main.js:148`).
5. The `online` sync trigger.
6. Probably overstated: per-key DPAPI cost (safeStorage unwraps one master key; per-string AES is cheap).
