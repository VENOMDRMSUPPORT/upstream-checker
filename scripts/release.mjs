// One-shot release: tag the current version, push it, then build + publish.
//
// electron-builder's GitHub publisher (releaseType: "release") needs the git tag
// to already exist on the remote, otherwise GitHub returns
// 422 "Published releases must have a valid tag". This script guarantees that
// ordering so `npm run release` works in a single command.
//
// Usage:  bump "version" in package.json, commit, then:  npm run release
// The GitHub token is taken from $GH_TOKEN / $GITHUB_TOKEN, or from the `gh` CLI
// (`gh auth token`) if you are logged in. The token is never printed.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const tag = `v${version}`;

const run = (cmd) => {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
};
const capture = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();

// 1. Ensure a GitHub token is available (never printed).
if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  try {
    const token = capture('gh auth token');
    if (token) process.env.GH_TOKEN = token;
  } catch {
    // gh not installed / not logged in — handled by the check below.
  }
}
if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  console.error('No GitHub token found. Set GH_TOKEN or run `gh auth login`, then retry.');
  process.exit(1);
}

console.log(`Releasing ${tag} ...\n`);

// 2. Push the current branch so the tag points at a commit that exists on the remote.
run('git push origin HEAD');

// 3. Create the tag locally if it is missing.
const localTags = capture('git tag').split(/\r?\n/).filter(Boolean);
if (!localTags.includes(tag)) {
  run(`git tag -a ${tag} -m "${tag}"`);
} else {
  console.log(`Tag ${tag} already exists locally.`);
}

// 4. Push the tag (ignore the case where it is already on the remote).
try {
  run(`git push origin ${tag}`);
} catch {
  console.log(`Tag ${tag} is already on the remote — continuing.`);
}

// 5. Build the installers and publish the release + assets to GitHub.
run('electron-builder --win --x64 --publish always');

// 6. Set the release notes from this version's CHANGELOG section (best-effort).
//    The in-app update modal reads these as "What's New".
try {
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  const esc = version.replace(/\./g, '\\.');
  const m = changelog.match(new RegExp('## \\[' + esc + '\\][^\\n]*\\n([\\s\\S]*?)(?=\\n## \\[)'));
  const notes = m
    ? m[1].split('\n').filter((l) => !l.startsWith('[' + version + ']:')).join('\n').trim()
    : '';
  if (notes) {
    writeFileSync('.release-notes.tmp', notes);
    run(`gh release edit ${tag} --notes-file .release-notes.tmp`);
    rmSync('.release-notes.tmp', { force: true });
    console.log('Release notes set from CHANGELOG.');
  } else {
    console.log(`No CHANGELOG section for ${version}; skipping release notes.`);
  }
} catch (err) {
  console.warn('Could not set release notes (non-fatal):', err.message);
}

console.log(`\nDone. Release: https://github.com/VENOMDRMSUPPORT/upstream-checker/releases/tag/${tag}`);
