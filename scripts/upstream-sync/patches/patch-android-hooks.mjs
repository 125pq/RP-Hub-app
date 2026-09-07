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

export function patchAndroidCharacter(source) {
  const replacements = [
    [
      `                const downloadFile = (blob, filename) => {
                    cardUtils.downloadBlob(blob, filename, { targetBlank: true, revokeDelay: 2000 });
                };

                const exportJSON = () => {
                    const data = getCardData();
                    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                    const filename = sanitizeFilename(currentCharacter.value.name) + '.json';
                    downloadFile(blob, filename);
                };`,
      `                const downloadFile = async (data, filename, mimeType) => {
                    try {
                        return await cardUtils.saveGeneratedFile(data, filename, {
                            mimeType: mimeType || data?.type || 'application/octet-stream',
                            targetBlank: true,
                            revokeDelay: 2000
                        });
                    } catch (error) {
                        showToast(\`导出失败: \${error.message || '文件保存失败'}\`, 'error');
                        return { cancelled: true, error: true };
                    }
                };

                const exportJSON = async () => {
                    const data = getCardData();
                    const filename = sanitizeFilename(currentCharacter.value.name) + '.json';
                    await downloadFile(JSON.stringify(data, null, 2), filename, 'application/json');
                };`,
      'character public save hook'
    ],
    [
      `                    const blob = new Blob([newPng], { type: 'image/png' });
                    const filename = sanitizeFilename(currentCharacter.value.name) + '.png';
                    downloadFile(blob, filename);`,
      `                    const blob = new Blob([newPng], { type: 'image/png' });
                    const filename = sanitizeFilename(currentCharacter.value.name) + '.png';
                    await downloadFile(blob, filename);`,
      'character PNG save hook'
    ],
    [
      '                const confirmSelectiveExport = () => {',
      '                const confirmSelectiveExport = async () => {',
      'character selective export async hook'
    ],
    [
      `                    const data = config.build(selectedItems);
                    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                    const filename = buildSelectiveExportFilename(exportPicker.type, selectedItems, selectedMeta);
                    downloadFile(blob, filename);`,
      `                    const data = config.build(selectedItems);
                    const filename = buildSelectiveExportFilename(exportPicker.type, selectedItems, selectedMeta);
                    const result = await downloadFile(JSON.stringify(data, null, 2), filename, 'application/json');
                    if (result.cancelled) return;`,
      'character selective export save hook'
    ]
  ];
  const states = replacements.map(([before, after, label]) => ({
    before,
    after,
    label,
    beforeCount: countOccurrences(source, before),
    afterCount: countOccurrences(source, after)
  }));
  const pristine = states.every(({ beforeCount, afterCount }) => beforeCount === 1 && afterCount === 0);
  const patched = states.every(({ beforeCount, afterCount }) => beforeCount === 0 && afterCount === 1);
  if (!pristine && !patched) {
    const detail = states.map(({ label, beforeCount, afterCount }) => `${label}:old=${beforeCount},new=${afterCount}`).join('; ');
    throw new Error(`Partial Android character export hook state: ${detail}`);
  }
  if (pristine) {
    for (const { before, after } of states) source = source.replace(before, after);
  }
  for (const { before, after, label } of states) {
    const beforeCount = countOccurrences(source, before);
    const afterCount = countOccurrences(source, after);
    if (beforeCount !== 0 || afterCount !== 1) {
      throw new Error(`Android character hook validation failed for ${label}: old=${beforeCount}, new=${afterCount}`);
    }
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

  changes.push(await editText('character/index.html', category, patchAndroidCharacter));

  changes.push(await editText('novel/index.html', category, patchAndroidNovel));

  return changes.filter(Boolean);
}
