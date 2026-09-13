import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

// Files rewritten by pin-upstream + prepare-android-release when a sync binds a
// new upstream release. On a failed run (or after a dry run) they must be
// restored byte-for-byte so the working tree returns to its prior state and a
// failed validation never leaves a new lock paired with uncommitted metadata.
export const releaseInputFiles = [
  'upstream.lock.json',
  'package.json',
  'package-lock.json',
  'README.md',
  'android/app/build.gradle',
  'scripts/android/build-android-release.ps1',
];

export function snapshotReleaseInputs(root, files = releaseInputFiles) {
  const snapshot = new Map();
  for (const file of files) {
    const absolute = path.join(root, file);
    snapshot.set(file, existsSync(absolute) ? readFileSync(absolute) : null);
  }
  return snapshot;
}

export function restoreReleaseInputs(root, snapshot) {
  for (const [file, bytes] of snapshot) {
    const absolute = path.join(root, file);
    if (bytes === null) {
      if (existsSync(absolute)) rmSync(absolute);
    } else {
      writeFileSync(absolute, bytes);
    }
  }
}
