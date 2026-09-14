// Execution-level coverage for the sync-upstream CLI top level.
//
// The offline unit tests exercise compose-sync and resolveMode directly, but
// they never ran the CLI's own module body, so a ReferenceError in the default
// branch slipped through. This runs the real script in a disposable clone with
// a local bare upstream and asserts the compose-mode decision is reached and
// the source lock/dist are untouched.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { repositoryRoot } from '../../web/paths.mjs';

const work = path.join(repositoryRoot, '.work/compose/cli-tests');
await mkdir(work, { recursive: true });

function git(cwd, args, options = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

const base = await mkdtemp(path.join(work, 'src-'));
const repo = path.join(base, 'repo');
const upstreamBare = path.join(base, 'upstream.git');

try {
  // A local bare upstream that exposes a stable tag pointing at a real upstream
  // release commit already present in the shared clone.
  const lock = JSON.parse(await readFile(path.join(repositoryRoot, 'upstream.lock.json'), 'utf8'));
  git(repositoryRoot, ['clone', '--shared', '--quiet', repositoryRoot, repo]);
  // Test the working-tree scripts under review, not the committed HEAD.
  await rm(path.join(repo, 'scripts'), { recursive: true, force: true });
  await cp(path.join(repositoryRoot, 'scripts'), path.join(repo, 'scripts'), { recursive: true });
  // The CLI requires a clean tree; commit the working-tree overlay so the clone
  // reflects this batch's code without a dirty status.
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '--allow-empty', '-m', 'overlay working tree']);
  const releaseCommit = lock.commit;
  const releaseTag = '1.9.9';
  git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'tag', releaseTag, releaseCommit]);
  git(repo, ['init', '--bare', '--quiet', upstreamBare]);
  git(repo, ['push', '--quiet', upstreamBare, `refs/tags/${releaseTag}:refs/tags/${releaseTag}`]);

  // Offline seams: local upstream URL and a pinned release resolution.
  const env = {
    ...process.env,
    RPHUB_UPSTREAM_URL: upstreamBare,
    RPHUB_SYNC_RELEASE_JSON: JSON.stringify({
      tagName: releaseTag,
      commitSha: releaseCommit,
      releaseName: releaseTag,
      publishedAt: '',
      url: '',
    }),
    RPHUB_CHECK_PUBLICATION: 'false',
  };
  const run = () => execFileSync(process.execPath, [
    // --prepare-only stops after mode decision/output, so no compose build runs.
    path.join(repo, 'scripts/upstream-sync/sync-upstream.mjs'), '--prepare-only',
  ], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, timeout: 120000 });

  const sourceHeadBefore = git(repositoryRoot, ['rev-parse', 'HEAD']);
  const sourceLockBefore = await readFile(path.join(repositoryRoot, 'upstream.lock.json'));
  let stdout = '';
  try {
    stdout = run();
  } catch (error) {
    stdout = `${error.stdout || ''}\n${error.stderr || ''}`;
    // The compose path with a lock mismatch must not crash with a ReferenceError.
    assert.doesNotMatch(stdout, /ReferenceError|is not defined/, `CLI crashed: ${stdout}`);
    throw error;
  }
  assert.match(stdout, /COMPOSE_MODE=compose SYNC_MODE=compose/, `expected compose decision, got:\n${stdout}`);
  assert.match(stdout, /UPSTREAM_RELEASE=1\.9\.9/);

  // The source repository must be untouched by the CLI run.
  assert.equal(git(repositoryRoot, ['rev-parse', 'HEAD']), sourceHeadBefore, 'source HEAD changed during CLI run');
  assert.ok((await readFile(path.join(repositoryRoot, 'upstream.lock.json'))).equals(sourceLockBefore), 'source lock changed during CLI run');
  assert.equal(JSON.parse(await readFile(path.join(repositoryRoot, 'upstream.lock.json'), 'utf8')).tag, lock.tag);

  // A pinned lock equal to the release must be recognized as already integrated
  // (noop/recover), never recomposed.
  await writeFile(path.join(repo, 'upstream.lock.json'), JSON.stringify({ ...lock, tag: releaseTag, commit: releaseCommit }, null, 2) + '\n');
  git(repo, ['add', 'upstream.lock.json']);
  git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'pin synthetic release']);
  const integrated = run();
  assert.match(integrated, /SYNC_MODE=noop|SYNC_MODE=recover/, `expected integrated decision, got:\n${integrated}`);

  console.log('Sync-upstream CLI: default compose decision, pinned-lock integration, no ReferenceError, source untouched PASS');
} finally {
  await rm(base, { recursive: true, force: true });
}
