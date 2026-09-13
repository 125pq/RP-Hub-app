// Materialize the locked upstream tag locally when it is absent.
//
// Composition builds read the upstream tree directly from the Git object store,
// so a fresh checkout or CI runner needs the locked tag to resolve. This helper
// is a no-op once the tag already points at the pinned commit; otherwise it
// fetches exactly that tag from the locked repository and verifies the commit.
// It never queries "latest" and never moves the lock.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { repositoryRoot } from '../web/paths.mjs';

const lock = JSON.parse(readFileSync(path.join(repositoryRoot, 'upstream.lock.json'), 'utf8'));
assert.equal(lock.schemaVersion, 1);
assert.match(lock.tag, /^v?\d+\.\d+\.\d+$/, 'Locked upstream tag must be a stable release tag');
assert.match(lock.commit, /^[0-9a-f]{40}$/, 'Locked upstream commit must be a full Git commit id');
assert.match(lock.repository, /^(https:\/\/|git@)/, 'Locked repository must be a Git URL');

const git = (args, options = {}) =>
  execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8', stdio: options.stdio || ['ignore', 'pipe', 'pipe'] });

function resolveTag() {
  try {
    return git(['rev-parse', `refs/tags/${lock.tag}^{commit}`]).trim();
  } catch {
    return null;
  }
}

const present = resolveTag();
if (present === lock.commit) {
  console.log(`Locked upstream tag present: ${lock.tag} ${lock.commit}`);
  process.exit(0);
}
// An existing tag that points elsewhere is a real conflict: never force-fetch
// over it, since that would move a local tag before the lock is verified.
if (present !== null) {
  throw new Error(`Local tag ${lock.tag} points to ${present}, but the lock pins ${lock.commit}; refusing to overwrite it`);
}

let remoteUrl = null;
try {
  remoteUrl = git(['remote', 'get-url', 'upstream']).trim();
} catch {
  remoteUrl = null;
}
if (remoteUrl === null) {
  git(['remote', 'add', 'upstream', lock.repository], { stdio: 'inherit' });
  console.log(`Added upstream remote: ${lock.repository}`);
} else if (remoteUrl.replace(/\/$/, '') !== lock.repository.replace(/\/$/, '')) {
  throw new Error(`Remote upstream points to ${remoteUrl}, expected ${lock.repository}`);
}

git(['fetch', 'upstream', `refs/tags/${lock.tag}:refs/tags/${lock.tag}`], { stdio: 'inherit' });
const fetched = resolveTag();
assert.equal(fetched, lock.commit, `Fetched ${lock.tag} resolved to ${fetched}, expected the locked commit ${lock.commit}`);
console.log(`Locked upstream tag fetched: ${lock.tag} ${lock.commit}`);
