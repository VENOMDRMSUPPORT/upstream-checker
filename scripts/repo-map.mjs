// ============================================
// Code map — a compact symbol index of the source tree
// ============================================
// Written for whoever (human or agent) has to find the right file without
// reading all of them. It is generated, deterministic and cheap to regenerate:
//
//   npm run repo:map              writes docs/CODE_MAP.md
//   npm run repo:map -- --check   exits 1 when the file on disk is stale
//
// Run it after adding, renaming or deleting a file under src/, scripts/ or
// test/, so the map never lies. Nothing here loads electron or the database:
// it only reads text.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'CODE_MAP.md');
const ROOTS = ['src', 'scripts', 'test'];
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
// Vendored, binary or generated content is not part of "where do I edit".
const SKIP_DIRS = new Set(['node_modules', 'dist', 'assets', 'fonts', 'data']);
const MAX_SYMBOLS = 12;
const MAX_TEST_NAMES = 6;
const MAX_PURPOSE = 96;
const MAX_LANDMARKS = 120;
// A file this long is not read whole: it is entered at a landmark.
const LANDMARK_MIN_LINES = 700;
// Markup and stylesheets are not JavaScript, so they carry no symbols, but the
// two of them are 280 KB of the tree and every UI task touches them.
const PLAIN_FILES = ['src/renderer/index.html', 'src/renderer/styles.css'];
// A few files open with code rather than a banner comment. They are the ones a
// reader most needs named, so they are listed here instead of left blank.
const PURPOSE_OVERRIDES = {
  'src/main.js': 'Main process: data folder, boot order, IPC wiring, auto-updater',
  'src/preload.js': "contextBridge surface — the renderer's only door to main",
  'src/renderer/index.html': 'App shell markup: nav, every page, the drawers and modals',
  'src/renderer/styles.css': 'The whole stylesheet: tokens, themes, accents, components',
};

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else if (EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      out.push(full);
    }
  }
  return out;
}

// The first line of prose in the file's opening comment block. Divider lines
// (// ======) and a bare // carry no information.
function purposeOf(lines) {
  let started = false;
  for (const raw of lines.slice(0, 40)) {
    const line = raw.trim();
    if (!started) {
      if (!line.startsWith('//')) continue;
      started = true;
    } else if (!line.startsWith('//')) {
      break;
    }
    const text = line.replace(/^\/\/+/, '').trim();
    if (!text || /^[=\-*#]+$/.test(text)) continue;
    return text.length > MAX_PURPOSE ? `${text.slice(0, MAX_PURPOSE - 1)}…` : text;
  }
  return '';
}

const DECL = /^(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=|let\s+([A-Za-z_$][\w$]*)\s*=|var\s+([A-Za-z_$][\w$]*)\s*=)/;
const WINDOW_GLOBAL = /^window\.([A-Za-z_$][\w$]*)\s*=/;
const EXPORTED = /^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/;

// The section banners inside one long file, with their line numbers, so a
// reader can open a window instead of the file. Each family marks sections its
// own way, so each is read its own way.
function landmarksOf(rel, lines) {
  const out = [];
  const push = (at, text) => {
    const clean = text.trim();
    if (clean && out.length < MAX_LANDMARKS) out.push({ at, text: clean });
  };
  if (rel.endsWith('.css')) {
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^\/\* ={6,}/.test(lines[i])) continue;
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j += 1) {
        const text = lines[j].replace(/^\s*\/?\*+\s?/, '').replace(/\*\/\s*$/, '').trim();
        if (text && !/^=+$/.test(text)) { push(j + 1, text); break; }
      }
    }
    return out;
  }
  if (rel.endsWith('.html')) {
    lines.forEach((line, i) => {
      const page = line.match(/<section[^>]*shell-page[^>]*data-page="([^"]+)"/);
      if (page) { push(i + 1, `page: ${page[1]}`); return; }
      const section = line.match(/data-section="(sec-[a-z-]+)"/);
      if (section) { push(i + 1, `settings: ${section[1]}`); return; }
      const id = line.match(/<div[^>]*id="([a-z-]*(?:drawer|modal)[a-z-]*)"/i);
      if (id) push(i + 1, `overlay: ${id[1]}`);
    });
    return out;
  }
  // JavaScript: a banner is a divider, its title, and a second divider.
  for (let i = 0; i + 2 < lines.length; i += 1) {
    if (!/^\/\/ ={10,}\s*$/.test(lines[i])) continue;
    if (!/^\/\/ ={10,}\s*$/.test(lines[i + 2])) continue;
    const title = lines[i + 1].replace(/^\/\/\s?/, '').trim();
    if (title && !/^=+$/.test(title)) push(i + 2, title);
  }
  return out;
}

function symbolsOf(rel, lines) {
  if (rel.startsWith('test')) {
    return lines.map((l) => (l.match(/^test\('([^']{1,72})'/) || [])[1])
      .filter(Boolean)
      .slice(0, MAX_TEST_NAMES);
  }
  const names = [];
  for (const line of lines) {
    const exp = line.match(EXPORTED);
    const win = line.match(WINDOW_GLOBAL);
    const decl = line.match(DECL);
    const name = (win && win[1]) || (exp && exp[1]) || (decl && (decl[1] || decl[2] || decl[3] || decl[4] || decl[5]));
    if (!name) continue;
    // A module's imported bindings are noise: keep what the file defines.
    if (/=\s*(?:require\(|await import\()/.test(line)) continue;
    if (!names.includes(name)) names.push(name);
  }
  // The renderer's page modules wrap everything in one IIFE, and preload
  // exposes a single object literal, so a file that names nothing at the top
  // level still has an API worth listing. Fall back to one level in.
  return names.length ? names : nestedNames(lines);
}

function nestedNames(lines) {
  const NESTED = /^\s{2,4}(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=|let\s+([A-Za-z_$][\w$]*)\s*=|([A-Za-z_$][\w$]*)\s*:\s*(?:function|\([^)]*\)\s*=>|async))/;
  const names = [];
  for (const line of lines) {
    const m = line.match(NESTED);
    if (!m) continue;
    const name = m[1] || m[2] || m[3] || m[4];
    // One-letter names are loop indices, never an API surface.
    if (name && name.length > 1 && !names.includes(name)) names.push(name);
  }
  return names;
}

function render(entries) {
  const stamp = 'GENERATED FILE — do not edit by hand. Regenerate with: npm run repo:map';
  const out = [];
  out.push('# Code map');
  out.push('');
  out.push(`> ${stamp}`);
  out.push('');
  out.push(`${entries.length} files under ${ROOTS.join('/, ')} plus the app shell and the stylesheet. Each row is one file: its size, what it is for and the names it defines. Read this before opening files, then open only what the task needs — for the long ones, jump with the landmarks section below.`);
  out.push('');
  out.push('The architecture behind these files — boot order, IPC channels, the two databases, the request lifecycle — is in [ARCHITECTURE.md](ARCHITECTURE.md). Task recipes are in [COOKBOOK.md](COOKBOOK.md).');
  out.push('');

  // --- IPC surface, extracted so it cannot rot silently ---
  // src/catalog/ipc.js registers behind its own `handle(channel, fn)` wrapper, so it
  // matches the same line shape as src/db/ipc.js. Leaving it out printed a list of
  // 37 channels in which the five the Models page depends on did not appear — the
  // map was confidently wrong.
  const ipc = [];
  const IPC_FILE = /^src[\/](main\.js|db[\/]ipc\.js|logs[\/]ipc\.js|catalog[\/]ipc\.js)$/;
  for (const { rel, lines } of entries) {
    if (!IPC_FILE.test(rel)) continue;
    for (const line of lines) {
      const m = line.match(/^\s*(?:ipcMain\.(handle|on)|handle)\('([^']+)'/);
      if (m) ipc.push({ owner: rel, channel: m[2] });
    }
  }
  out.push('## IPC channels');
  out.push('');
  out.push(`${ipc.length} channels, in registration order. invoke/handle answers a promise; send/on is fire-and-forget. The renderer reaches them through window.electronAPI (src/preload.js).`);
  out.push('');
  out.push('| Channel | Registered in |');
  out.push('| --- | --- |');
  for (const row of ipc) out.push(`| \`${row.channel}\` | ${row.owner} |`);
  out.push('');

  // --- landmarks inside the long files ---
  const long = entries.filter((e) => e.lineCount >= LANDMARK_MIN_LINES);
  if (long.length) {
    out.push('## Large-file landmarks');
    out.push('');
    out.push(`Files of ${LANDMARK_MIN_LINES}+ lines, with the section banners inside them. Open the window you need — do not read one of these whole. Line numbers are 1-based.`);
    out.push('');
    for (const entry of long) {
      const marks = landmarksOf(entry.rel, entry.lines);
      out.push(`### ${entry.rel} — ${entry.lineCount} lines`);
      out.push('');
      if (!marks.length) {
        out.push('*(no section banners)*');
        out.push('');
        continue;
      }
      out.push('| Line | Section |');
      out.push('| --- | --- |');
      for (const mark of marks) out.push(`| ${mark.at} | ${mark.text} |`);
      out.push('');
    }
  }

  // --- one table per directory ---
  const byDir = new Map();
  for (const entry of entries) {
    const dir = dirname(entry.rel).split(sep).join('/');
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(entry);
  }
  for (const dir of [...byDir.keys()].sort()) {
    out.push(`### ${dir}/`);
    out.push('');
    out.push('| File | Lines | Purpose | Defines |');
    out.push('| --- | --- | --- | --- |');
    for (const entry of byDir.get(dir)) {
      const name = entry.rel.slice(dir.length + 1);
      const shown = entry.symbols.slice(0, MAX_SYMBOLS).join(', ');
      const more = entry.symbols.length > MAX_SYMBOLS ? `, +${entry.symbols.length - MAX_SYMBOLS} more` : '';
      out.push(`| \`${name}\` | ${entry.lineCount} | ${entry.purpose} | ${shown}${more} |`);
    }
    out.push('');
  }
  return out.join('\n');
}

function collect() {
  const entries = [];
  for (const root of ROOTS) {
    const dir = join(ROOT, root);
    if (!existsSync(dir)) continue;
    for (const full of walk(dir)) {
      const text = readFileSync(full, 'utf8');
      const lines = text.split(/\r?\n/);
      const rel = relative(ROOT, full).split(sep).join('/');
      entries.push({ rel, lineCount: lines.length, lines, symbols: symbolsOf(rel, lines), purpose: PURPOSE_OVERRIDES[rel] || purposeOf(lines) });
    }
  }
  for (const rel of PLAIN_FILES) {
    const full = join(ROOT, rel);
    if (!existsSync(full)) continue;
    const lines = readFileSync(full, 'utf8').split(/\r?\n/);
    entries.push({ rel: rel.split(sep).join('/'), lineCount: lines.length, lines, symbols: [], purpose: PURPOSE_OVERRIDES[rel] || purposeOf(lines) });
  }
  return entries;
}

// One definition of "the file on disk is what this run would write". A
// Windows checkout may hand the file back with CRLF (core.autocrlf) while this
// script always emits LF, and a freshness check that fails on line endings is
// a check nobody trusts.
const normalise = (text) => (text === null ? null : text.replace(/\r\n/g, '\n'));

const check = process.argv.includes('--check');
const markdown = render(collect());
const current = normalise(existsSync(OUT) ? readFileSync(OUT, 'utf8') : null);

if (check) {
  if (current === markdown) {
    console.log('docs/CODE_MAP.md is up to date');
    process.exit(0);
  }
  console.error('docs/CODE_MAP.md is stale — run: npm run repo:map');
  process.exit(1);
}

const changed = current !== markdown;
writeFileSync(OUT, markdown);
console.log(`${changed ? 'Wrote' : 'Unchanged'} docs/CODE_MAP.md (${markdown.length} bytes, ${markdown.split('\n').length} lines)`);
