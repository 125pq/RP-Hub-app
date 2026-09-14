// Sync mode + release integrity decisions.
//
// Two models coexist during phase 6:
//  - compose (default): the lock is the source of truth. Upstream is NOT an
//    ancestor of HEAD; a release is "already integrated" when the lock pins it.
//  - legacy merge (explicit --legacy-merge): upstream was merged into HEAD, so
//    integration is a Git ancestry question.
// The compose functions are the ones the production CLI/workflow use; the
// legacy functions stay for the explicit escape hatch and existing fixtures.

// --- compose model ---

export function determineComposeMode({ lockedTag, lockedCommit, release, publicationComplete }) {
  const locked = lockedTag === release.tagName && lockedCommit === release.commitSha;
  if (!locked) return 'compose';
  return publicationComplete ? 'noop' : 'recover';
}

// A release target is trustworthy when it is in our history (so HEAD can
// reproduce/descend from it) AND the target pinned exactly this upstream release
// in its lock. This replaces the merge-era "upstream is an ancestor of the
// target" proof, which no longer holds once we stop merging upstream into HEAD.
export async function assertReleaseTargetLock({ androidTag, upstreamSha, targetCommitish, headSha, lockAt, isAncestor }) {
  const upstream = String(upstreamSha || '').trim().toLowerCase();
  const target = String(targetCommitish || '').trim().toLowerCase();
  const head = String(headSha || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(upstream)) throw new Error(`Invalid upstream release for ${androidTag}: ${upstreamSha || '(empty)'}`);
  if (!/^[0-9a-f]{7,40}$/.test(target)) {
    throw new Error(`Android Release ${androidTag} has invalid target ${targetCommitish || '(empty)'}, refusing to reuse its APK`);
  }
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`Invalid current HEAD for ${androidTag}: ${headSha || '(empty)'}`);

  if (!await isAncestor(target, head)) {
    throw new Error(
      `Android Release ${androidTag} targets ${targetCommitish}, which is not an ancestor of current HEAD ${headSha}; refusing to reuse its APK`
    );
  }
  const locked = String(await lockAt(targetCommitish) || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(locked)) {
    throw new Error(`Android Release ${androidTag} target ${targetCommitish} has no readable upstream lock; refusing to reuse its APK`);
  }
  if (locked !== upstream) {
    throw new Error(
      `Android Release ${androidTag} target ${targetCommitish} pinned upstream ${locked}, not the selected release ${upstreamSha}; refusing to reuse its APK`
    );
  }
  return true;
}

// Resolve the sync mode the CLI runs, keeping the branch selection in one
// tested place. `lock` is the parsed upstream.lock.json (compose model) and
// `integrationCheck`/`publicationCheck` are async predicates for the legacy
// merge model. This is the exact decision the top-level CLI makes, so an
// offline test can exercise it without a network remote.
export async function resolveMode({
  legacyMerge,
  release,
  lock = null,
  integrationCheck = async () => false,
  publicationCheck = async () => true,
}) {
  if (legacyMerge) {
    const alreadyIntegrated = await integrationCheck();
    const complete = alreadyIntegrated ? await publicationCheck() : false;
    return determineSyncMode({ alreadyIntegrated, publicationComplete: complete });
  }
  const locked = lock && lock.tag === release.tagName && lock.commit === release.commitSha;
  const complete = locked ? await publicationCheck() : false;
  return determineComposeMode({
    lockedTag: lock ? lock.tag : null,
    lockedCommit: lock ? lock.commit : null,
    release,
    publicationComplete: complete,
  });
}

// --- legacy merge model (explicit --legacy-merge only) ---

export function determineSyncMode({ alreadyIntegrated, publicationComplete }) {
  if (!alreadyIntegrated) return 'merge';
  return publicationComplete ? 'noop' : 'recover';
}

export async function assertReleaseTargetAncestry({ androidTag, upstreamSha, targetCommitish, headSha, isAncestor }) {
  const upstream = String(upstreamSha || '').trim().toLowerCase();
  const target = String(targetCommitish || '').trim().toLowerCase();
  const head = String(headSha || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(upstream)) throw new Error(`Invalid upstream release for ${androidTag}: ${upstreamSha || '(empty)'}`);
  if (!/^[0-9a-f]{7,40}$/.test(target)) {
    throw new Error(`Android Release ${androidTag} has invalid target ${targetCommitish || '(empty)'}, refusing to reuse its APK`);
  }
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`Invalid current HEAD for ${androidTag}: ${headSha || '(empty)'}`);

  if (!await isAncestor(upstream, target)) {
    throw new Error(
      `Upstream release ${upstreamSha} is not an ancestor of Android Release ${androidTag} target ${targetCommitish}; refusing to reuse its APK`
    );
  }
  if (!await isAncestor(target, head)) {
    throw new Error(
      `Android Release ${androidTag} targets ${targetCommitish}, which is not an ancestor of current HEAD ${headSha}; refusing to reuse its APK`
    );
  }
  return true;
}
