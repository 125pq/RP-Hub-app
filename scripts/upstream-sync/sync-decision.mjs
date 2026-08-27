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
