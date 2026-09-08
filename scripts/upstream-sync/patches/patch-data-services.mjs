import { countOccurrences, editText, ensureAfter, replaceOnce } from '../lib.mjs';

function requireSingle(source, needle, label) {
  const count = countOccurrences(source, needle);
  if (count !== 1) throw new Error(`Expected exactly one ${label}, found ${count}`);
}

function requireAbsent(source, needle, label) {
  const count = countOccurrences(source, needle);
  if (count !== 0) throw new Error(`Unexpected ${label}; found ${count}`);
}

const iframePerfSetup = `        const iframePerfEnabled = window.__RPH_PERF__?.enabled === true;
        const perfReporter = iframePerfEnabled ? \`
                function reportRphIframePerf(type) {
                    try {
                        window.parent.__RPH_SCROLL_PERF__?.recordIframeActivity?.(window.frameElement, type);
                    } catch (_) {}
                }
        \` : '';
        const reportIframePerf = (type) => iframePerfEnabled ? \`reportRphIframePerf('\${type}');\` : '';
`;

const triggerPerfReporter = `                \${perfReporter}`;
const reportHeightMeasure = `                    \${reportIframePerf('heightMeasureRequest')}`;
const reportHelperRaf = `                        \${reportIframePerf('helperRaf')}`;
const reportHeightUpdate = `                            \${reportIframePerf('heightUpdate')}`;
const reportTimerCallback = `setTimeout(function() { \${reportIframePerf('timerCallback')} updateHeight(); }, `;
const reportClickResize = `                        \${reportIframePerf('clickResizeTick')}`;
const reportImageLoad = `img.addEventListener('load', function() { \${reportIframePerf('imageLoad')} updateHeight(); });`;
const reportResizeObserver = `var ro = new ResizeObserver(function() { \${reportIframePerf('resizeObserver')} updateHeight(); });`;
const reportFallbackTimer = `setInterval(function() { \${reportIframePerf('timerCallback')} updateHeight(); }, 1000);`;

const processMainContentOverlay = `

    const processMainContentImpl = (mainText, isGeneratingState) => {
        mainText = stripUiTemplateUpdateBlock(mainText);
        if (!isGeneratingState) return { text: mainText, showSpinner: false };
        const imageStart = mainText.lastIndexOf('image###');
        if (imageStart !== -1) {
            const imageTail = mainText.slice(imageStart + 'image###'.length);
            if (!imageTail.includes('###') && !/[\\r\\n]/.test(imageTail)) {
                mainText = mainText.slice(0, imageStart);
            }
        }
        const patterns = ['\`\`\`html', '\`\`\`vue', '<!DOCTYPE', '<div', '<style'];
        let earliestIndex = -1;
        for (const p of patterns) {
            const idx = mainText.toLowerCase().indexOf(p);
            if (idx !== -1 && (earliestIndex === -1 || idx < earliestIndex)) {
                earliestIndex = idx;
            }
        }
        if (earliestIndex !== -1) {
            return { text: mainText.substring(0, earliestIndex), showSpinner: true };
        }
        return { text: mainText, showSpinner: false };
    };
    const processMainContentCache = new Map();
    const processMainContent = (mainText, isGeneratingState) => {
        const bucketKey = isGeneratingState ? 1 : 0;
        let bucket = processMainContentCache.get(bucketKey);
        if (!bucket) {
            bucket = new Map();
            processMainContentCache.set(bucketKey, bucket);
        }
        const key = mainText || '';
        if (bucket.has(key)) return bucket.get(key);
        const result = processMainContentImpl(mainText, isGeneratingState);
        bucket.set(key, result);
        if (bucket.size > 800) bucket.delete(bucket.keys().next().value);
        return result;
    };`;

const parentLoadPerf = `                    if (window.__RPH_PERF__?.enabled === true) {
                        window.__RPH_SCROLL_PERF__?.recordIframeActivity?.(this, 'parentLoadTimer');
                    }`;

const buildExecutableHtmlAnchor = '    const buildExecutableHtmlDocument = (rawHtml) => {';
const stripUpdateAnchor = `    const stripUiTemplateUpdateBlock = (text) => {
        const source = String(text || '');
        const match = findUiTemplateUpdateBlock(source);
        return match ? source.slice(0, match.index).trimEnd() : source;
    };`;
const localAssetLine = '    const getLocalAssetUrl = (relativePath) => new URL(relativePath, window.location.href).href;';
const jqueryUrlMarker = "const jqueryUrl = getLocalAssetUrl('assets/vendor/jquery/jquery.min.js');";
const oldJqueryMarker = "const jqueryScript = '<script src=\"https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js\" defer><\\/script>';";
const processMainContentImplMarker = 'const processMainContentImpl = (mainText, isGeneratingState) => {';
const processMainContentCacheMarker = 'const processMainContentCache = new Map();';
const processMainContentMarker = 'const processMainContent = (mainText, isGeneratingState) => {';
const processMainContentExportMarker = '        stripUiTemplateUpdateBlock,\n        processMainContent\n';

function removeOptionalOnce(source, block, label) {
  const count = countOccurrences(source, block);
  if (count > 1) throw new Error(`Duplicate hook detected: ${label}`);
  return count === 1 ? source.replace(block, '') : source;
}

function removeIframeDiagnostics(source) {
  source = removeOptionalOnce(source, iframePerfSetup, 'iframe performance setup');
  source = removeOptionalOnce(source, `\n${triggerPerfReporter}`, 'iframe performance reporter');
  source = removeOptionalOnce(source, `\n${reportHeightMeasure}`, 'iframe height measurement');
  source = removeOptionalOnce(source, `\n${reportHelperRaf}`, 'iframe helper RAF measurement');
  source = removeOptionalOnce(source, `\n${reportHeightUpdate}`, 'iframe height update measurement');
  source = source.replace(`${reportTimerCallback}200);`, 'setTimeout(updateHeight, 200);');
  source = source.replace(`${reportTimerCallback}1000);`, 'setTimeout(updateHeight, 1000);');
  source = removeOptionalOnce(source, `\n${reportClickResize}`, 'iframe click resize measurement');
  source = source.replace(reportImageLoad, "img.addEventListener('load', updateHeight);");
  source = source.replace(reportResizeObserver, 'var ro = new ResizeObserver(updateHeight);');
  source = source.replace(reportFallbackTimer, 'setInterval(updateHeight, 1000);');
  source = removeOptionalOnce(source, `\n${parentLoadPerf}`, 'iframe parent load measurement');
  for (const marker of [
    '__RPH_PERF__', '__RPH_SCROLL_PERF__', 'perfReporter', 'reportIframePerf',
    'reportRphIframePerf', "recordIframeActivity"
  ]) requireAbsent(source, marker, 'iframe performance diagnostics');
  return source;
}

function patchBuildExecutableHtmlDocument(source) {
  source = removeIframeDiagnostics(source);
  source = replaceOnce(source, `\n\n${buildExecutableHtmlAnchor}`, `\n${localAssetLine}\n\n${buildExecutableHtmlAnchor}`, 'local iframe asset URL');
  source = replaceOnce(
    source,
    `        const jqueryScript = '<script src="https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js" defer><\\/script>';`,
    `        const jqueryUrl = getLocalAssetUrl('assets/vendor/jquery/jquery.min.js');
        const jqueryScript = \`<script src="\${jqueryUrl}"><\\/script>\`;`,
    'local iframe jquery asset'
  );
  requireSingle(source, localAssetLine, 'local iframe asset URL');
  requireSingle(source, jqueryUrlMarker, 'local iframe jquery asset');
  requireAbsent(source, oldJqueryMarker, 'remote iframe jquery asset');
  requireSingle(source, '                    setTimeout(updateHeight, 200);', '200ms iframe timer');
  requireSingle(source, '                    setTimeout(updateHeight, 1000);', '1000ms iframe timer');
  requireSingle(source, "                        img.addEventListener('load', updateHeight);", 'iframe image listener');
  requireSingle(source, '                    var ro = new ResizeObserver(updateHeight);', 'iframe resize observer');
  requireSingle(source, '                    setInterval(updateHeight, 1000);', 'iframe fallback timer');
  return source;
}

export function patchDataServicesOverlay(source) {
  source = patchBuildExecutableHtmlDocument(source);
  source = ensureAfter(source, stripUpdateAnchor, processMainContentOverlay, 'streaming main-content processing');
  source = replaceOnce(source, '        stripUiTemplateUpdateBlock\n', '        stripUiTemplateUpdateBlock,\n        processMainContent\n', 'streaming main-content export');

  requireSingle(source, processMainContentImplMarker, 'streaming main-content processing');
  requireSingle(source, processMainContentCacheMarker, 'streaming main-content cache');
  requireSingle(source, processMainContentMarker, 'streaming main-content helper');
  requireSingle(source, processMainContentExportMarker, 'streaming main-content export');
  return source;
}

export async function applyDataServicesHooks() {
  const change = await editText('assets/js/data-services.js', 'data-services-hooks', patchDataServicesOverlay);
  return change ? [change] : [];
}
