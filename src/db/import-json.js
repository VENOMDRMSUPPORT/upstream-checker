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
