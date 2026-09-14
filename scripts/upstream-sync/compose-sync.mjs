// Compose-based upstream sync core (phase 6).
//
// The new sync direction is "get stable upstream -> update the locked inputs ->
// compose and verify", replacing the old "merge all customized web sources into
// the working tree then reapply patches". This module owns that sequence so the
// CLI, the workflow, and offline tests share one implementation:
//
//   1. materialize the release tag locally
//   2. snapshot the release inputs (lock + version metadata)
//   3. pin the lock and apply the Android version metadata
//   4. compose dist from the locked upstream (build:web) and verify it
//
// On a failed step (or after a dry-run preview) the release inputs are restored
// byte-for-byte, so a new lock is never left paired with uncommitted metadata.
// There is no automatic fallback to the legacy merge path; callers that want it
// must ask for it explicitly.
import process from 'node:process';
import { pinUpstream as defaultPin } from '../compose/pin-upstream.mjs';
import { snapshotReleaseInputs, restoreReleaseInputs } from './release-inputs.mjs';

// Windows resolves npm/npx through .cmd shims; callers' run() only uses a shell
// for .cmd/.bat, so resolve the shim here to avoid spawn ENOENT.
function commandName(base) {
  return process.platform === 'win32' && ['npm', 'npx'].includes(base) ? `${base}.cmd` : base;
}

// `git(command, args)`, `run(command, args)`, and `pin(root, tag, commit)` are
// injected by the caller (the CLI wires the real ones). Callers may override
// `prepare`/`compose` to add steps; the defaults are the production commands.
export async function runComposeSync({
  projectRoot,
  release,
  revision,
  dryRun = false,
  git,
  run,
  pin = defaultPin,
  prepare,
  compose,
}) {
  const before = snapshotReleaseInputs(projectRoot);
  const applyPrepare = prepare || (() => run(process.execPath,
    ['scripts/upstream-sync/prepare-android-release.mjs', release.tagName, String(revision)]));
  const applyCompose = compose || (async () => {
    const npm = commandName('npm');
    for (const gate of ['test:upstream-sync', 'test:platform', 'test:performance']) {
      await run(npm, ['run', gate]);
    }
    await run(npm, ['run', 'build:web']);
    await run(npm, ['run', 'verify:dist']);
  });
  try {
    await git(['fetch', 'upstream', `refs/tags/${release.tagName}:refs/tags/${release.tagName}`]);
    pin(projectRoot, release.tagName, release.commitSha);
    await applyPrepare();
    await applyCompose();
  } catch (error) {
    restoreReleaseInputs(projectRoot, before);
    throw error;
  }
  if (dryRun) {
    restoreReleaseInputs(projectRoot, before);
    return { dryRun: true, restored: true };
  }
  return { dryRun: false, restored: false };
}
