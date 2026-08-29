import { dominantEol, rebuildWithOriginalEol } from './lib.mjs';
import { patchIndexScriptOverlay } from './patches/index-script-overlay.mjs';
import { patchAndroidNovel } from './patches/patch-android-hooks.mjs';
import { patchBackupNovel } from './patches/patch-backup.mjs';
import { patchCoreUtilsOverlay } from './patches/patch-core-utils.mjs';
import { patchDataServicesOverlay } from './patches/patch-data-services.mjs';
import { patchOfflineIndex, patchOfflineNovel } from './patches/patch-offline-assets.mjs';
import { patchSafeAreaIndex, patchSafeAreaNovel, patchSquareHostSafeArea } from './patches/patch-safe-area.mjs';

const transforms = new Map([
  ['index.html', source => {
    source = patchOfflineIndex(source);
    source = patchSafeAreaIndex(source);
    source = patchSquareHostSafeArea(source);
    return patchIndexScriptOverlay(source);
  }],
  ['novel/index.html', source => {
    source = patchOfflineNovel(source);
    source = patchSafeAreaNovel(source);
    source = patchAndroidNovel(source);
    return patchBackupNovel(source);
  }],
  ['assets/js/core-utils.js', patchCoreUtilsOverlay],
  ['assets/js/data-services.js', patchDataServicesOverlay]
]);

export const overlayManifest = Object.freeze([...transforms.keys()]);

export function getOverlayTransformer(relativePath) {
  return transforms.get(relativePath) || null;
}

// Pure LF-text transform used by both filesystem hooks and the merge resolver.
// Callers that need byte/EOL preservation should use transformOverlayBlob below.
export function transformOverlayText(relativePath, source) {
  const transform = getOverlayTransformer(relativePath);
  if (!transform) throw new Error(`No registered upstream overlay transformer for ${relativePath}`);
  return transform(source);
}

// Apply the pure transform without normalizing the source file's existing EOL
// policy. Existing lines retain their own terminators; inserted lines use the
// source's dominant terminator, exactly like editText().
export function transformOverlayBlob(relativePath, source) {
  const normalized = source.replace(/\r\n/g, '\n');
  const afterNormalized = transformOverlayText(relativePath, normalized);
  return rebuildWithOriginalEol(source, afterNormalized, dominantEol(source));
}
