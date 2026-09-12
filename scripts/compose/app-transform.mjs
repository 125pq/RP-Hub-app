import { removeAppMergeArtifacts } from '../upstream-sync/patches/patch-app-artifacts.mjs';
import { patchAndroidApp } from '../upstream-sync/patches/patch-android-hooks.mjs';
import { patchAppFileExport } from '../upstream-sync/patches/patch-app-file-export.mjs';
import { patchChatExport } from '../upstream-sync/patches/patch-chat-export.mjs';
import { patchTextMetrics } from '../upstream-sync/patches/patch-text-metrics.mjs';
import { patchBackupApp } from '../upstream-sync/patches/patch-backup.mjs';
import { patchAppChatImport } from '../upstream-sync/patches/patch-app-chat-import.mjs';
import { patchAppOffscreen } from '../upstream-sync/patches/patch-app-offscreen.mjs';
import { patchAppFilterCache } from '../upstream-sync/patches/patch-app-filter-cache.mjs';

export function composeApp(source) {
  source = patchAndroidApp(source);
  source = patchAppFileExport(source);
  source = patchChatExport(source);
  source = patchTextMetrics(source);
  source = patchBackupApp(source);
  source = patchAppChatImport(source);
  source = patchAppOffscreen(source);
  source = patchAppFilterCache(source);
  return removeAppMergeArtifacts(source);
}
