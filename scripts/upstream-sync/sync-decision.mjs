export function determineSyncMode({ alreadyIntegrated, publicationComplete }) {
  if (!alreadyIntegrated) return 'merge';
  return publicationComplete ? 'noop' : 'recover';
}

export function assertReleaseTargetsHead({ androidTag, targetCommitish, headSha }) {
  const target = String(targetCommitish || '').trim().toLowerCase();
  const head = String(headSha || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`Invalid current HEAD for ${androidTag}: ${headSha || '(empty)'}`);
  if (target !== head) {
    throw new Error(
      `Android Release ${androidTag} targets ${targetCommitish || '(empty)'}, expected current HEAD ${headSha}; refusing to reuse its APK`
    );
  }
  return true;
}
