// docs/CODE_MAP.md is generated, and a stale one sends the next reader to the
// wrong file. `npm run check` catches that, but a plain `npm test` must catch
// it too: these tests run the generator in --check mode through a child
// process and repeat the command that fixes a stale map.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const GENERATOR = path.join(ROOT, 'scripts', 'repo-map.mjs');
const FIX = 'npm run repo:map';

// Runs scripts/repo-map.mjs --check in the given root, the same way
// `npm run repo:map -- --check` does. process.execPath is Electron running as
// Node under the test runner (ELECTRON_RUN_AS_NODE), which the generator needs
// nothing more than plain text reading for.
function runCheck(cwd) {
  const generator = path.join(cwd, 'scripts', 'repo-map.mjs');
  const run = spawnSync(process.execPath, [generator, '--check'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env },
  });
  if (run.error) throw run.error;
  return { status: run.status, output: `${run.stdout || ''}${run.stderr || ''}` };
}

test('the code map on disk is what the generator would write right now', () => {
  const { status, output } = runCheck(ROOT);
  assert.strictEqual(status, 0, `docs/CODE_MAP.md is stale — run: ${FIX}\n${output}`);
  assert.match(output, /up to date/);
});

test('a stale map is refused with exit 1 and the command that fixes it', (t) => {
  // The same generator against a tree whose docs/CODE_MAP.md does not match
  // what it would write — a sandbox, so nothing real is touched.
  const sandbox = tempDir(t);
  fs.mkdirSync(path.join(sandbox, 'scripts'));
  fs.copyFileSync(GENERATOR, path.join(sandbox, 'scripts', 'repo-map.mjs'));

  const { status, output } = runCheck(sandbox);
  assert.strictEqual(status, 1, output);
  assert.match(output, /stale/);
  assert.ok(output.includes(`run: ${FIX}`), `expected the fix command in: ${output}`);
});
