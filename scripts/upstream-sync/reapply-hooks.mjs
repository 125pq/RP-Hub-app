import { pathToFileURL } from 'node:url';
import { applyAndroidHooks } from './patches/patch-android-hooks.mjs';
import { applyBackupHooks } from './patches/patch-backup.mjs';
import { applySafeAreaHooks } from './patches/patch-safe-area.mjs';
import { applyOfflineAssetHooks } from './patches/patch-offline-assets.mjs';
import { applyPerformanceHooks } from './patches/patch-performance.mjs';
import { applySidebarRenderingHooks } from './patches/patch-sidebar-rendering.mjs';
import { applyChatLayoutHooks } from './patches/patch-chat-layout.mjs';
import { applyDataServicesHooks } from './patches/patch-data-services.mjs';

export async function reapplyHooks() {
  const groups = [
    ['android-hooks', applyAndroidHooks],
    ['webview-layout-safe-area', applySafeAreaHooks],
    ['webview-sidebar-rendering', applySidebarRenderingHooks],
    ['webview-chat-layout', applyChatLayoutHooks],
    ['offline-assets', applyOfflineAssetHooks],
    ['data-services-hooks', applyDataServicesHooks],
    ['performance-patches', applyPerformanceHooks],
    ['backup-hooks', applyBackupHooks]
  ];
  const changes = [];
  for (const [category, apply] of groups) {
    const groupChanges = await apply();
    changes.push(...groupChanges);
    console.log(`${category}: ${groupChanges.length ? groupChanges.map(item => item.file).join(', ') : 'no changes'}`);
  }
  console.log(`REAPPLY_CHANGED_FILES=${changes.length}`);
  return changes;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await reapplyHooks();
}
