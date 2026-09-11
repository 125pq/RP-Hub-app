import { countOccurrences, ensureAfter, ensureBefore, replaceOnce } from '../lib.mjs';

function requireSingle(source, needle, label) {
  const count = countOccurrences(source, needle);
  if (count !== 1) throw new Error(`Expected exactly one ${label}, found ${count}`);
}

function requireAbsent(source, needle, label) {
  const count = countOccurrences(source, needle);
  if (count !== 0) throw new Error(`Unexpected ${label}; found ${count}`);
}

const parseCotOriginalMarker = 'const parseCot = (text) => {';
const parseCotImplMarker = 'const parseCotImpl = (text) => {';
const parseCotWrapperMarker = 'const parseCot = (text) => {\n    const perf = window.__RPH_PERF__;';
const parseCotTelemetryMarker = "window.__RPH_PERF__?.registerCacheReader?.('parseCotCache', () => {";
const clearParseCotCacheMarker = '    clearParseCotCache: () => parseCotCache.clear(),';
const platformAdapterMarker = 'const getPlatformAdapter = () => {';
const saveGeneratedFileMarker = 'const saveGeneratedFile = async (data, filename, options = {}) => {';
const cardAdapterExportsMarker = '        getPlatformAdapter,\n        saveGeneratedFile,';

const parseCotPerfOverlay = `const parseCot = (text) => {
    const perf = window.__RPH_PERF__;
    return perf?.active ? perf.measure('parseCot', () => parseCotImpl(text)) : parseCotImpl(text);
};
window.__RPH_PERF__?.registerCacheReader?.('parseCotCache', () => {
    let keyChars = 0;
    let valueChars = 0;
    parseCotCache.forEach((value, key) => {
        keyChars += typeof key === 'string' ? key.length : 0;
        valueChars += (value?.cot?.length || 0) + (value?.main?.length || 0) + (value?.sys?.length || 0);
    });
    return { entries: parseCotCache.size, approxKeyChars: keyChars, approxValueChars: valueChars };
});`;

const cardAdapterOverlay = `    const getPlatformAdapter = () => {
        if (window.platformAdapter) return window.platformAdapter;
        try {
            if (window.parent !== window && window.parent.platformAdapter) return window.parent.platformAdapter;
        } catch {}
        return null;
    };

    const tryStreamViaFileSystemAccess = async (stream, filename, mimeType) => {
        if (typeof window.showSaveFilePicker !== 'function') return null;
        let handle;
        try {
            handle = await window.showSaveFilePicker({
                suggestedName: filename,
                types: [{ description: filename, accept: { [mimeType]: [] } }],
            });
        } catch (error) {
            if (error && error.name === 'AbortError') {
                return { supported: true, cancelled: true };
            }
            return null;
        }
        let writable;
        try {
            writable = await handle.createWritable();
            let bytesWritten = 0;
            const encoder = (typeof TextEncoder === 'function') ? new TextEncoder() : null;
            for await (const part of stream) {
                const text = String(part ?? '');
                const chunk = encoder ? encoder.encode(text) : new Blob([text]);
                bytesWritten += chunk.byteLength ?? text.length;
                await writable.write(chunk);
            }
            await writable.close();
            return { supported: true, cancelled: false, bytesWritten };
        } catch (error) {
            try { if (writable) await writable.abort(); } catch {}
            throw error;
        }
    };

    const saveGeneratedFile = async (data, filename, options = {}) => {
        const mimeType = String(options.mimeType || data?.type || 'application/octet-stream');
        const adapter = getPlatformAdapter();
        const isChunkStream = data && typeof data[Symbol.asyncIterator] === 'function';
        if (adapter?.exportFile && (!isChunkStream || adapter.isNative?.())) {
            const result = await adapter.exportFile({ data, filename, mimeType });
            if (result?.supported === false) throw new Error('当前平台不支持文件保存');
            return result;
        }
        if (isChunkStream) {
            const streamed = await tryStreamViaFileSystemAccess(data, filename, mimeType);
            if (streamed !== null) return streamed;
            const parts = [];
            for await (const part of data) parts.push(String(part ?? ''));
            data = new Blob(parts, { type: mimeType });
        } else {
            data = data && typeof data.arrayBuffer === 'function' && typeof data.slice === 'function'
                ? data
                : new Blob([data], { type: mimeType });
        }
        downloadBlob(data, filename, options);
        return { supported: true, cancelled: false, bytesWritten: data.size };
    };

`;

// 本切片(阶段 1)之前的 cardAdapterOverlay 旧实现。补丁需幂等升级:若检测到旧 overlay,
// 先替换为新 overlay,再走 ensureBefore 兜底首次插入。仅匹配与本常量**完全一致**的旧文本。
const cardAdapterOverlayLegacy = `    const getPlatformAdapter = () => {
        if (window.platformAdapter) return window.platformAdapter;
        try {
            if (window.parent !== window && window.parent.platformAdapter) return window.parent.platformAdapter;
        } catch {}
        return null;
    };

    const saveGeneratedFile = async (data, filename, options = {}) => {
        const mimeType = String(options.mimeType || data?.type || 'application/octet-stream');
        const adapter = getPlatformAdapter();
        const isChunkStream = data && typeof data[Symbol.asyncIterator] === 'function';
        if (adapter?.exportFile && (!isChunkStream || adapter.isNative?.())) {
            const result = await adapter.exportFile({ data, filename, mimeType });
            if (result?.supported === false) throw new Error('当前平台不支持文件保存');
            return result;
        }
        if (isChunkStream) {
            const parts = [];
            for await (const part of data) parts.push(String(part ?? ''));
            data = new Blob(parts, { type: mimeType });
        } else {
            data = data && typeof data.arrayBuffer === 'function' && typeof data.slice === 'function'
                ? data
                : new Blob([data], { type: mimeType });
        }
        downloadBlob(data, filename, options);
        return { supported: true, cancelled: false, bytesWritten: data.size };
    };

`;

function removeParseCotDiagnostics(source) {
  const diagnosticCounts = [
    countOccurrences(source, parseCotImplMarker),
    countOccurrences(source, parseCotWrapperMarker),
    countOccurrences(source, parseCotTelemetryMarker),
    countOccurrences(source, clearParseCotCacheMarker)
  ];
  const hasDiagnostics = diagnosticCounts.some(Boolean);
  if (!hasDiagnostics) {
    requireSingle(source, parseCotOriginalMarker, 'parseCot implementation');
    return source;
  }
  if (diagnosticCounts.some(count => count !== 1)) {
    throw new Error(`Partial parseCot performance diagnostics detected: ${diagnosticCounts.join(',')}`);
  }
  source = source.replace(parseCotImplMarker, parseCotOriginalMarker);
  source = source.replace(`\n${parseCotPerfOverlay}\n`, '\n');
  source = source.replace(`${clearParseCotCacheMarker}\n`, '');
  return source;
}

const cardAdapterExports = `
        getPlatformAdapter,
        saveGeneratedFile,`;

export function patchCoreUtilsOverlay(source) {
  source = removeParseCotDiagnostics(source);
  // 幂等升级:已有旧 overlay(阶段 1 前的 saveGeneratedFile)时替换为含流式支持的新 overlay。
  // 仅当文件含旧实现且尚未升级时替换;全新上游原版(两者皆无)交给 ensureBefore 首次插入。
  const hasLegacyCardAdapter = countOccurrences(source, cardAdapterOverlayLegacy) === 1;
  const hasNewCardAdapter = countOccurrences(source, cardAdapterOverlay) === 1;
  if (hasLegacyCardAdapter && !hasNewCardAdapter) {
    source = replaceOnce(source, cardAdapterOverlayLegacy, cardAdapterOverlay, 'card file adapter overlay upgrade');
  }
  source = ensureBefore(source, '    window.RPHubCardUtils = {', cardAdapterOverlay, 'card file adapter helpers');
  source = ensureAfter(source, '        injectPngTextChunk,', cardAdapterExports, 'card file adapter exports');

  requireSingle(source, parseCotOriginalMarker, 'parseCot implementation');
  requireSingle(source, platformAdapterMarker, 'card file adapter helper');
  requireSingle(source, saveGeneratedFileMarker, 'card file save helper');
  requireSingle(source, cardAdapterExportsMarker, 'card file adapter export');
  requireSingle(source, 'window.RPHubUtils = {', 'RPHubUtils export object');
  requireSingle(source, '    window.RPHubCardUtils = {', 'RPHubCardUtils export object');
  requireAbsent(source, parseCotImplMarker, 'split parseCot implementation');
  requireAbsent(source, '__RPH_PERF__', 'parseCot performance diagnostics');
  requireAbsent(source, clearParseCotCacheMarker, 'parseCot benchmark cache reset');
  return source;
}
