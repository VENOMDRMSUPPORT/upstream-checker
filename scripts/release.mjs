// One-shot release: tag the current version, push it, publish the notes, then
// build and upload the installers.
//
// electron-builder's GitHub publisher (releaseType: "release") needs the git tag
// to already exist on the remote, otherwise GitHub returns
// 422 "Published releases must have a valid tag". This script guarantees that
// ordering so `npm run release` works in a single command.
//
// It also creates the release *with its notes* before any asset is uploaded.
// electron-builder will otherwise create the release itself as a side effect of
// uploading, leaving a window where the release is live and visible to
// auto-update while its body is still empty — an app that checks during that
// window shows an empty "What's New" and caches it.
//
// Usage:  bump "version" in package.json, commit, then:  npm run release
// The GitHub token is taken from $GH_TOKEN / $GITHUB_TOKEN, or from the `gh` CLI
// (`gh auth token`) if you are logged in. The token is never printed.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const REPO = 'VENOMDRMSUPPORT/upstream-checker';
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

// 2. The notes for this version, straight out of the CHANGELOG. Read before
//    anything is published so a missing section is caught early rather than
//    after the installers are already on the release.
function changelogNotes() {
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  const escaped = version.replace(/\./g, '\\.');
  const section = changelog.match(
    new RegExp('## \\[' + escaped + '\\][^\\n]*\\n([\\s\\S]*?)(?=\\n## \\[)')
  );
  if (!section) return '';
  return section[1]
    .split('\n')
    .filter((line) => !line.startsWith('[' + version + ']:'))
    .join('\n')
    .trim();
}

const notes = changelogNotes();
if (!notes) {
  console.warn(`No CHANGELOG section found for ${version}. The release will have no notes.`);
}

const releasesForTag = () =>
  JSON.parse(capture(`gh api "repos/${REPO}/releases?per_page=100"`)).filter((r) => r.tag_name === tag);

console.log(`Releasing ${tag} ...\n`);

// 3. Push the current branch so the tag points at a commit that exists on the remote.
run('git push origin HEAD');

// 4. Create the tag locally if it is missing.
const localTags = capture('git tag').split(/\r?\n/).filter(Boolean);
if (!localTags.includes(tag)) {
  run(`git tag -a ${tag} -m "${tag}"`);
} else {
  console.log(`Tag ${tag} already exists locally.`);
}

// 5. Push the tag (ignore the case where it is already on the remote).
try {
  run(`git push origin ${tag}`);
} catch {
  console.log(`Tag ${tag} is already on the remote — continuing.`);
}

// 6. Publish the release with its notes, before any asset exists. This is what
//    closes the empty-notes window described at the top of the file.
if (notes && releasesForTag().length === 0) {
  console.log(`Creating release ${tag} with notes from CHANGELOG ...`);
  execSync(`gh api -X POST "repos/${REPO}/releases" --input -`, {
    input: JSON.stringify({ tag_name: tag, name: tag, body: notes, draft: false, prerelease: false }),
    stdio: ['pipe', 'ignore', 'inherit'],
  });
}

// 7. Build the installers and upload them to that release.
run('electron-builder --win --x64 --publish always');

// 8. Tidy up (best-effort). electron-builder publishes each build target
//    (nsis + portable) separately and can still end up creating a duplicate
//    release for the tag, so keep whichever carries the most assets, delete the
//    rest, and make sure the survivor has the notes.
try {
  const releases = releasesForTag().sort((a, b) => (b.assets?.length || 0) - (a.assets?.length || 0));

  if (releases.length === 0) {
    console.log(`No GitHub release found for ${tag}; nothing to tidy.`);
  } else {
    const keep = releases[0];
    for (const dup of releases.slice(1)) {
      console.log(`Deleting duplicate release ${dup.id} (${dup.assets?.length || 0} assets).`);
      execSync(`gh api -X DELETE "repos/${REPO}/releases/${dup.id}"`, { stdio: 'ignore' });
    }

    if (notes && !String(keep.body || '').trim()) {
      execSync(`gh api -X PATCH "repos/${REPO}/releases/${keep.id}" --input -`, {
        input: JSON.stringify({ body: notes }),
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      console.log('Release notes restored from CHANGELOG.');
    } else if (notes) {
      console.log('Release notes already present.');
    }
  }
} catch (err) {
  console.warn('Could not finalize release (non-fatal):', err.message);
}

console.log(`\nDone. Release: https://github.com/VENOMDRMSUPPORT/upstream-checker/releases/tag/${tag}`);
