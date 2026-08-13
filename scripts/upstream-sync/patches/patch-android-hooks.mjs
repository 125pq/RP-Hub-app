import { editText, ensureAfter, ensureBefore, replaceOnce, requireContains } from '../lib.mjs';

const category = 'android-hooks';

export async function applyAndroidHooks() {
  const changes = [];

  changes.push(await editText('index.html', category, source => {
    source = ensureBefore(
      source,
      `        document.write('<script src="assets/js/safe-area.js?v=' + new Date().getTime() + '"><\\/script>');`,
      `        document.write('<script src="assets/js/platform-services.js?v=' + new Date().getTime() + '"><\\/script>');\n        document.write('<script src="assets/js/rphub-android-adapter.js?v=' + new Date().getTime() + '"><\\/script>');\n`,
      'platform adapter scripts'
    );
    return source;
  }));

  changes.push(await editText('assets/js/app.js', category, source => {
    if (!source.includes('const initializePlatformAdapters = async () => {')) {
      source = ensureBefore(
        source,
        '        const confirmCharacterExport = (type) => {',
        `        const initializePlatformAdapters = async () => {\n            const adapter = window.platformAdapter;\n            if (!adapter) return;\n            removePlatformBackListener = await adapter.onBackButton(handlePlatformBackButton);\n            removePlatformStateListener = await adapter.onAppStateChange(({ isActive }) => {\n                isNativeAppActive = isActive;\n            });\n        };\n\n`,
        'app lifecycle adapter'
      );
    }
    source = ensureAfter(
      source,
      '            scheduleMobileVisualViewportSync({ force: true });',
      '\n            await initializePlatformAdapters();',
      'app lifecycle initialization'
    );
    source = ensureAfter(
      source,
      '            clearTimeout(mobileKeyboardBlurTimer);',
      '\n            removePlatformBackListener();\n            removePlatformStateListener();',
      'app lifecycle cleanup'
    );
    return source;
  }));

  changes.push(await editText('assets/js/core-utils.js', category, source => {
    if (!source.includes('const getPlatformAdapter = () => {')) {
      source = ensureBefore(
        source,
        '    window.RPHubCardUtils = {',
        `    const getPlatformAdapter = () => {\n        if (window.platformAdapter) return window.platformAdapter;\n        try {\n            if (window.parent !== window && window.parent.platformAdapter) return window.parent.platformAdapter;\n        } catch {}\n        return null;\n    };\n\n    const saveGeneratedFile = async (data, filename, options = {}) => {\n        const mimeType = String(options.mimeType || data?.type || 'application/octet-stream');\n        const adapter = getPlatformAdapter();\n        if (adapter?.exportFile) {\n            const result = await adapter.exportFile({ data, filename, mimeType });\n            if (result?.supported === false) throw new Error('Current platform cannot save files');\n            return result;\n        }\n        const blob = data && typeof data.arrayBuffer === 'function' && typeof data.slice === 'function'\n            ? data\n            : new Blob([data], { type: mimeType });\n        downloadBlob(blob, filename, options);\n        return { supported: true, cancelled: false, bytesWritten: blob.size };\n    };\n\n`,
        'core file adapter helpers'
      );
      source = ensureAfter(source, '        injectPngTextChunk,', '\n        getPlatformAdapter,\n        saveGeneratedFile,', 'core adapter exports');
    }
    requireContains(source, 'adapter?.exportFile', 'core-utils exportFile call');
    return source;
  }));

  changes.push(await editText('character/index.html', category, source => {
    if (!source.includes('cardUtils.saveGeneratedFile')) {
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

  changes.push(await editText('novel/index.html', category, source => {
    if (!source.includes('adapter?.exportFile')) {
      const start = source.indexOf('                    const blob = new Blob([content]');
      const endMarker = "                    showToast('小说已开始导出', 'success');";
      const end = source.indexOf(endMarker, start);
      if (start < 0 || end < 0) throw new Error('Missing sync anchor: novel browser export block');
      const fallback = source.slice(start, end + endMarker.length);
      const hook = `                    let adapter = window.platformAdapter;\n                    try {\n                        if (!adapter && window.parent !== window) adapter = window.parent.platformAdapter;\n                    } catch {}\n                    if (adapter?.exportFile) {\n                        const result = await adapter.exportFile({\n                            data: content,\n                            filename: \`\${novel.value.title || '小说导出'}.txt\`,\n                            mimeType: 'text/plain'\n                        });\n                        if (result.cancelled) return;\n                        if (result.supported === false) throw new Error('Current platform cannot save files');\n                        showToast('小说已开始导出', 'success');\n                        return;\n                    }\n\n`;
      source = `${source.slice(0, start)}${hook}${fallback}${source.slice(end + endMarker.length)}`;
    }
    requireContains(source, 'adapter?.exportFile', 'novel platform export');
    return source;
  }));

  return changes.filter(Boolean);
}
