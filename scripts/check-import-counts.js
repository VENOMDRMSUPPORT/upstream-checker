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
