import { resolveAutoConflicts } from './auto-resolver.mjs';

async function gitText(git, args) {
  return (await git(args, { capture: true })).stdout.trim();
}

async function mergeInProgress(git) {
  return (await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], {
    capture: true,
    allowFailure: true
  })).code === 0;
}

// Shared merge/conflict/reapply orchestration. `git` and `reapply` are injected
// so offline fixtures can exercise the exact production abort/classification
// path without a network remote or a second resolver implementation.
export async function mergeWithAutoResolver({
  cwd,
  upstreamRef,
  git,
  resolver = resolveAutoConflicts,
  reapply,
  log = console
}) {
  const merge = await git(['merge', '--no-ff', '--no-commit', upstreamRef], {
    allowFailure: true,
    capture: true
  });
  if (merge.stdout) log.log(merge.stdout);
  if (merge.stderr && merge.code === 0) log.error(merge.stderr);
  if (merge.code !== 0) {
    if (merge.stderr) log.error(merge.stderr);
    const conflicts = await gitText(git, ['diff', '--name-only', '--diff-filter=U']);
    if (conflicts) {
      log.error(`MERGE_CONFLICTS=\n${conflicts}`);
      try {
        const resolved = await resolver({ cwd });
        log.log(`AUTO_RESOLVER=PASS\n${resolved.join('\n')}`);
      } catch (error) {
        log.error(`AUTO_RESOLVER=FAIL\n${error.message}`);
        if (await mergeInProgress(git)) await git(['merge', '--abort'], { allowFailure: true });
        throw new Error(`Upstream merge conflicted and was aborted; auto-resolver refused the conflict: ${error.message}`);
      }
      const remaining = await gitText(git, ['diff', '--name-only', '--diff-filter=U']);
      if (remaining) {
        if (await mergeInProgress(git)) await git(['merge', '--abort'], { allowFailure: true });
        throw new Error(`Upstream merge conflicted and auto-resolver left unmerged paths:\n${remaining}`);
      }
      if (reapply) await reapply({ cwd });
      return { conflicts, resolved: true };
    }
    if (await mergeInProgress(git)) await git(['merge', '--abort'], { allowFailure: true });
    const detail = [merge.stderr, merge.stdout].filter(Boolean).join('\n');
    throw new Error(
      `Upstream git merge failed without content conflicts${detail ? `:\n${detail}` : ''}`
    );
  }
  if (reapply) await reapply({ cwd });
  return { conflicts: '', resolved: false };
}
