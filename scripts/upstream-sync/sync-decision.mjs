export function determineSyncMode({ alreadyIntegrated, publicationComplete }) {
  if (!alreadyIntegrated) return 'merge';
  return publicationComplete ? 'noop' : 'recover';
}
