import { countOccurrences, editText, ensureAfter, ensureBefore, replaceOnce, requireContains } from '../lib.mjs';
import { patchCoreUtilsOverlay } from './patch-core-utils.mjs';
import { patchIndexScriptOverlay } from './index-script-overlay.mjs';

const category = 'android-hooks';

export function patchAndroidNovel(source) {
  source = replaceOnce(source, '                const exportBook = () => {', '                const exportBook = async () => {', 'novel async export hook');
  if (!source.includes('adapter?.exportFile')) {
    const start = source.indexOf('                    const blob = new Blob([content]');
    const endMarker = "                    showToast('小说已开始导出', 'success');";
    const end = source.indexOf(endMarker, start);
    if (start < 0 || end < 0) throw new Error('Missing sync anchor: novel browser export block');
    const fallback = source.slice(start, end + endMarker.length);
    const hook = `                    let adapter = window.platformAdapter;\n                    try {\n                        if (!adapter && window.parent !== window) adapter = window.parent.platformAdapter;\n                    } catch {}\n                    if (adapter?.exportFile) {\n                        let result;\n                        try {\n                            result = await adapter.exportFile({\n                                data: content,\n                                filename: \`\${novel.value.title || '小说导出'}.txt\`,\n                                mimeType: 'text/plain'\n                            });\n                        } catch (error) {\n                            showToast(\`小说导出失败：\${error.message || '文件保存失败'}\`, 'error');\n                            return;\n                        }\n                        if (result.cancelled) return;\n                        if (result.supported === false) throw new Error('当前平台不支持文件保存');\n                        showToast('小说已开始导出', 'success');\n                        return;\n                    }\n\n`;
    source = `${source.slice(0, start)}${hook}${fallback}${source.slice(end + endMarker.length)}`;
  }
  requireContains(source, 'adapter?.exportFile', 'novel platform export');
  return source;
}

export function patchAndroidApp(source) {
  const legacyDeclarations = `        let removePlatformBackListener = () => {};
        let removePlatformStateListener = () => {};
        let isNativeAppActive = true;`;
  const backDeclaration = '        let removePlatformBackListener = () => {};';
  const legacyInitializer = `        const initializePlatformAdapters = async () => {
            const adapter = window.platformAdapter;
            if (!adapter) return;
            removePlatformBackListener = await adapter.onBackButton(handlePlatformBackButton);
            removePlatformStateListener = await adapter.onAppStateChange(({ isActive }) => {
                isNativeAppActive = isActive;
            });
        };

`;
  const backInitializer = `        const initializePlatformAdapters = async () => {
            const adapter = window.platformAdapter;
            if (!adapter) return;
            removePlatformBackListener = await adapter.onBackButton(handlePlatformBackButton);
        };

`;
  const legacyCleanup = '\n            removePlatformBackListener();\n            removePlatformStateListener();';
  const backCleanup = '\n            removePlatformBackListener();';
  const requireExactlyOnce = (needle, label) => {
    const count = countOccurrences(source, needle);
    if (count !== 1) throw new Error(`Expected exactly one ${label}, found ${count}`);
  };

  if (source.includes(legacyDeclarations)) {
    const count = countOccurrences(source, legacyDeclarations);
    if (count !== 1) throw new Error(`Expected one replacement anchor for obsolete app-state declarations, found ${count}`);
    source = source.replace(legacyDeclarations, backDeclaration);
  }
  if (source.includes(legacyInitializer)) {
    source = replaceOnce(source, legacyInitializer, backInitializer, 'obsolete app-state listener');
  } else if (!source.includes(backInitializer)) {
    if (source.includes('const initializePlatformAdapters = async () => {')) {
      throw new Error('Missing sync anchor: app lifecycle adapter drifted');
    }
    source = ensureBefore(
      source,
      '        const confirmCharacterExport = (type) => {',
      backInitializer,
      'app lifecycle adapter'
    );
  }
  source = ensureAfter(
    source,
    '            scheduleMobileVisualViewportSync({ force: true });',
    '\n            await initializePlatformAdapters();',
    'app lifecycle initialization'
  );
  if (source.includes(legacyCleanup)) {
    const count = countOccurrences(source, legacyCleanup);
    if (count !== 1) throw new Error(`Expected one replacement anchor for obsolete app-state cleanup, found ${count}`);
    source = source.replace(legacyCleanup, backCleanup);
  } else {
    source = ensureAfter(
      source,
      '            clearTimeout(mobileKeyboardBlurTimer);',
      backCleanup,
      'app lifecycle cleanup'
    );
  }
  requireExactlyOnce(backDeclaration, 'app back-listener cleanup declaration');
  requireExactlyOnce(backInitializer, 'app back-listener initialization');
  for (const obsolete of ['removePlatformStateListener', 'isNativeAppActive']) {
    if (source.includes(obsolete)) throw new Error(`Obsolete app lifecycle hook remains: ${obsolete}`);
  }
  return source;
}

export async function applyAndroidHooks() {
  const changes = [];

  changes.push(await editText('index.html', category, patchIndexScriptOverlay));

  changes.push(await editText('assets/js/app.js', category, patchAndroidApp));

  changes.push(await editText('assets/js/core-utils.js', category, patchCoreUtilsOverlay));

  changes.push(await editText('assets/js/update-check.js', category, source => {
    const dispatch = `                    window.dispatchEvent(new CustomEvent('rphub:update-available', {\n                        detail: { versionId: latestVersionId }\n                    }));`;
    const guardedDispatch = `                    // The native APK checks GitHub Releases through AppUpdateManager. A\n                    // WebView reload cannot update the installed APK, so keep this web-only prompt\n                    // out of native builds while preserving browser update notifications.\n                    const isNativeApp = window.platformAdapter?.isNative?.() === true;\n                    if (!isNativeApp) {\n                        window.dispatchEvent(new CustomEvent('rphub:update-available', {\n                            detail: { versionId: latestVersionId }\n                        }));\n                    }`;
    if (!source.includes(guardedDispatch)) {
      source = replaceOnce(source, dispatch, guardedDispatch, 'update-check native update guard');
    }
    requireContains(source, guardedDispatch, 'update-check native guard');
    return source;
  }));

  changes.push(await editText('character/index.html', category, source => {    if (!source.includes('cardUtils.saveGeneratedFile')) {
      source = replaceOnce(
        source,
        `                const downloadFile = (blob, filename) => {\n                    cardUtils.downloadBlob(blob, filename, { targetBlank: true, revokeDelay: 2000 });\n                };`,
        `                const downloadFile = async (data, filename, mimeType) => {\n                    try {\n                        return await cardUtils.saveGeneratedFile(data, filename, {\n                            mimeType: mimeType || data?.type || 'application/octet-stream',\n                            targetBlank: true,\n                            revokeDelay: 2000\n                        });\n                    } catch (error) {\n                        showToast(\`Export failed: \${error.message || 'file save failed'}\`, 'error');\n                        return { cancelled: true, error: true };\n                    }\n                };`,
        'character public save hook'
      );
    }
    requireContains(source, 'cardUtils.saveGeneratedFile', 'character public file save');
    return source;
  }));

  changes.push(await editText('novel/index.html', category, patchAndroidNovel));

  return changes.filter(Boolean);
}
