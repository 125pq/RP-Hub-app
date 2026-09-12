import { patchAppFileExport } from './patch-app-file-export.mjs';
import { patchAppNavigation } from './patch-app-navigation.mjs';
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
    "            window.addEventListener('resize', handleMobileViewportResize, { passive: true });\n            scheduleMobileVisualViewportSync({ force: true });",
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
      '            if (mobileViewportRaf) cancelAnimationFrame(mobileViewportRaf);\n            clearTimeout(mobileKeyboardBlurTimer);',
      backCleanup,
      'app lifecycle cleanup'
    );
  }
  source = patchAppNavigation(source);
  if (!source.includes(backDeclaration)) {
    source = ensureBefore(source, '        const handlePlatformBackButton =', backDeclaration + '\n\n', 'back listener declaration');
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
  // 阶段 2:整卡 JSON 导出从「先 JSON.stringify 出完整字符串」升级为
  // RPHubIO.jsonTextChunks 流式写入(原生分块 / FSA / 聚合回退通用)。把升级
  // 视作同一接入器的第二种已应用状态,保证 reapply 幂等且能识别旧状态升级。
  const streamifySave = (text) => text
    .replace(
      `await downloadFile(JSON.stringify(data, null, 2), filename, 'application/json');`,
      `await downloadFile(window.RPHubIO.jsonTextChunks(data, { space: 2 }), filename, 'application/json');`
    )
    .replace(
      `const result = await downloadFile(JSON.stringify(data, null, 2), filename, 'application/json');`,
      `const result = await downloadFile(window.RPHubIO.jsonTextChunks(data, { space: 2 }), filename, 'application/json');`
    );
  const streamedLabels = new Set(['character public save hook', 'character selective export save hook']);
  const states = replacements.map(([before, afterOld, label]) => ({
    before,
    afterOld,
    afterNew: streamedLabels.has(label) ? streamifySave(afterOld) : afterOld,
    label
  }));
  const describe = (entry) => {
    const beforeCount = countOccurrences(source, entry.before);
    const oldCount = countOccurrences(source, entry.afterOld);
    const newCount = countOccurrences(source, entry.afterNew);
    const changed = entry.afterOld !== entry.afterNew;
    const oldSatisfied = changed
      ? beforeCount === 0 && oldCount === 1 && newCount === 0
      : beforeCount === 0 && oldCount === 1;
    const newSatisfied = changed
      ? beforeCount === 0 && oldCount === 0 && newCount === 1
      : beforeCount === 0 && oldCount === 1;
    return { ...entry, beforeCount, oldCount, newCount, oldSatisfied, newSatisfied };
  };
  const states2 = states.map(describe);
  const pristine = states2.every(({ beforeCount, oldCount, newCount }) => beforeCount === 1 && oldCount === 0 && newCount === 0);
  const patchedOld = states2.every(({ oldSatisfied }) => oldSatisfied);
  const patchedNew = states2.every(({ newSatisfied }) => newSatisfied);
  if (!pristine && !patchedOld && !patchedNew) {
    const detail = states2.map(({ label, beforeCount, oldCount, newCount }) => `${label}:before=${beforeCount},old=${oldCount},new=${newCount}`).join('; ');
    throw new Error(`Partial Android character export hook state: ${detail}`);
  }
  if (pristine) {
    for (const { before, afterNew } of states2) source = source.replace(before, afterNew);
  } else if (patchedOld) {
    for (const { afterOld, afterNew } of states2) {
      if (afterOld !== afterNew) source = source.replace(afterOld, afterNew);
    }
  }
  for (const { before, afterNew, label } of states2) {
    if (countOccurrences(source, before) !== 0 || countOccurrences(source, afterNew) !== 1) {
      throw new Error(`Android character hook validation failed for ${label}`);
    }
  }
  // Load the shared IO module beside the other character-page scripts.
  source = ensureAfter(
    source,
    '<script src="../assets/js/core-utils.js"></script>',
    '\n    <script src="../assets/js/rphub-io.js"></script>',
    'character rphub-io script'
  );
  return source;
}

// Shared by filesystem reapply and the isolated composition build.
export function patchAndroidUpdateCheck(source) {
  const dispatch = `                    window.dispatchEvent(new CustomEvent('rphub:update-available', {\n                        detail: { versionId: latestVersionId }\n                    }));`;
  const guardedDispatch = `                    // The native APK checks GitHub Releases through AppUpdateManager. A\n                    // WebView reload cannot update the installed APK, so keep this web-only prompt\n                    // out of native builds while preserving browser update notifications.\n                    const isNativeApp = window.platformAdapter?.isNative?.() === true;\n                    if (!isNativeApp) {\n                        window.dispatchEvent(new CustomEvent('rphub:update-available', {\n                            detail: { versionId: latestVersionId }\n                        }));\n                    }`;
  const rawCount = countOccurrences(source, dispatch);
  const guardedCount = countOccurrences(source, guardedDispatch);
  const eventCount = countOccurrences(source, "new CustomEvent('rphub:update-available'");
  if (eventCount !== 1 || !((rawCount === 1 && guardedCount === 0) || (rawCount === 0 && guardedCount === 1))) {
    throw new Error('Ambiguous or drifted update-check native guard: expected exactly one raw or guarded notification');
  }
  if (rawCount === 1) {
    source = replaceOnce(source, dispatch, guardedDispatch, 'update-check native update guard');
  }
  requireContains(source, guardedDispatch, 'update-check native guard');
  return source;
}

export async function applyAndroidHooks() {
  const changes = [];

  changes.push(await editText('index.html', category, patchIndexScriptOverlay));

  changes.push(await editText('assets/js/app.js', category, source => patchAppFileExport(patchAndroidApp(source))));

  changes.push(await editText('assets/js/core-utils.js', category, patchCoreUtilsOverlay));

  changes.push(await editText('assets/js/update-check.js', category, patchAndroidUpdateCheck));

  changes.push(await editText('character/index.html', category, patchAndroidCharacter));

  changes.push(await editText('novel/index.html', category, patchAndroidNovel));

  return changes.filter(Boolean);
}
