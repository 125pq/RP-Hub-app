import { countOccurrences, editText, ensureAfter, ensureBefore, replaceOnce } from '../lib.mjs';

function requireSingle(source, needle, label) {
  const count = countOccurrences(source, needle);
  if (count !== 1) throw new Error(`Expected exactly one ${label}, found ${count}`);
}

function requireCount(source, needle, expected, label) {
  const count = countOccurrences(source, needle);
  if (count !== expected) throw new Error(`Expected ${expected} ${label}, found ${count}`);
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
const metaViewportAnchor = '        const metaViewport = ';
const triggerSlashAnchor = `                window.triggerSlash = function(text) {
                    if (window.parent && window.parent.triggerSlash) window.parent.triggerSlash(text);
                };`;
const updateHeightAnchor = '                function updateHeight() {';
const requestAnimationAnchor = '                    requestAnimationFrame(function() {';
const heightUpdateAnchor = `                            window.frameElement.style.height = newHeight + 'px';`;
const iframeLoadAnchor = `        iframe.onload = function () {
            try {
                setTimeout(() => {`;
const stripUpdateAnchor = `    const stripUiTemplateUpdateBlock = (text) => {
        const source = String(text || '');
        const match = findUiTemplateUpdateBlock(source);
        return match ? source.slice(0, match.index).trimEnd() : source;
    };`;
const localAssetLine = '    const getLocalAssetUrl = (relativePath) => new URL(relativePath, window.location.href).href;';
const iframePerfEnabledMarker = 'const iframePerfEnabled = window.__RPH_PERF__?.enabled === true;';
const jqueryUrlMarker = "const jqueryUrl = getLocalAssetUrl('assets/vendor/jquery/jquery.min.js');";
const oldJqueryMarker = "const jqueryScript = '<script src=\"https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js\" defer><\\/script>';";
const triggerPerfMarker = '                ${perfReporter}';
const heightMeasureMarker = "                    ${reportIframePerf('heightMeasureRequest')}";
const helperRafMarker = "                        ${reportIframePerf('helperRaf')}";
const heightUpdateMarker = "                            ${reportIframePerf('heightUpdate')}";
const timerCallbackMarker = "setTimeout(function() { ${reportIframePerf('timerCallback')} updateHeight(); }, ";
const clickResizeMarker = "                        ${reportIframePerf('clickResizeTick')}";
const imageLoadMarker = "img.addEventListener('load', function() { ${reportIframePerf('imageLoad')} updateHeight(); });";
const resizeObserverMarker = "var ro = new ResizeObserver(function() { ${reportIframePerf('resizeObserver')} updateHeight(); });";
const fallbackTimerMarker = "setInterval(function() { ${reportIframePerf('timerCallback')} updateHeight(); }, 1000);";
const parentLoadMarker = `if (window.__RPH_PERF__?.enabled === true) {
                        window.__RPH_SCROLL_PERF__?.recordIframeActivity?.(this, 'parentLoadTimer');`;
const processMainContentImplMarker = 'const processMainContentImpl = (mainText, isGeneratingState) => {';
const processMainContentCacheMarker = 'const processMainContentCache = new Map();';
const processMainContentMarker = 'const processMainContent = (mainText, isGeneratingState) => {';
const processMainContentExportMarker = '        stripUiTemplateUpdateBlock,\n        processMainContent\n';

function patchBuildExecutableHtmlDocument(source) {
  source = replaceOnce(source, `\n\n${buildExecutableHtmlAnchor}`, `\n${localAssetLine}\n\n${buildExecutableHtmlAnchor}`, 'local iframe asset URL');
  source = ensureBefore(source, metaViewportAnchor, iframePerfSetup, 'iframe performance setup');
  source = replaceOnce(
    source,
    `        const jqueryScript = '<script src="https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js" defer><\\/script>';`,
    `        const jqueryUrl = getLocalAssetUrl('assets/vendor/jquery/jquery.min.js');
        const jqueryScript = \`<script src="\${jqueryUrl}"><\\/script>\`;`,
    'local iframe jquery asset'
  );
  source = ensureAfter(source, triggerSlashAnchor, `\n${triggerPerfReporter}`, 'iframe performance reporter');
  source = ensureAfter(source, updateHeightAnchor, `\n${reportHeightMeasure}`, 'iframe height measurement');
  source = ensureAfter(source, requestAnimationAnchor, `\n${reportHelperRaf}`, 'iframe helper RAF measurement');
  source = ensureAfter(source, heightUpdateAnchor, `\n${reportHeightUpdate}`, 'iframe height update measurement');
  source = replaceOnce(source, '                    setTimeout(updateHeight, 200);', `                    ${reportTimerCallback}200);`, 'iframe delayed height measurement');
  source = replaceOnce(source, '                    setTimeout(updateHeight, 1000);', `                    ${reportTimerCallback}1000);`, 'iframe delayed height measurement');
  source = ensureAfter(source, '                        if (Date.now() - start >= 600) return;', `\n${reportClickResize}`, 'iframe click resize measurement');
  source = replaceOnce(source, "                        img.addEventListener('load', updateHeight);", `                        ${reportImageLoad}`, 'iframe image load measurement');
  source = replaceOnce(source, '                    var ro = new ResizeObserver(updateHeight);', `                    ${reportResizeObserver}`, 'iframe resize observer measurement');
  source = replaceOnce(source, '                    setInterval(updateHeight, 1000);', `                    ${reportFallbackTimer}`, 'iframe fallback timer measurement');
  source = ensureAfter(source, iframeLoadAnchor, `\n${parentLoadPerf}`, 'iframe parent load measurement');

  requireSingle(source, localAssetLine, 'local iframe asset URL');
  requireSingle(source, iframePerfEnabledMarker, 'iframe performance setup');
  requireSingle(source, jqueryUrlMarker, 'local iframe jquery asset');
  requireAbsent(source, oldJqueryMarker, 'remote iframe jquery asset');
  requireSingle(source, triggerPerfMarker, 'iframe performance reporter');
  requireSingle(source, heightMeasureMarker, 'iframe height measurement');
  requireSingle(source, helperRafMarker, 'iframe helper RAF measurement');
  requireSingle(source, heightUpdateMarker, 'iframe height update measurement');
  requireCount(source, timerCallbackMarker, 2, 'iframe delayed height measurements');
  requireSingle(source, clickResizeMarker, 'iframe click resize measurement');
  requireSingle(source, imageLoadMarker, 'iframe image load measurement');
  requireSingle(source, resizeObserverMarker, 'iframe resize observer measurement');
  requireSingle(source, fallbackTimerMarker, 'iframe fallback timer measurement');
  requireSingle(source, parentLoadMarker, 'iframe parent load measurement');
  requireAbsent(source, '                    setTimeout(updateHeight, 200);', 'unmeasured 200ms iframe timer');
  requireAbsent(source, '                    setTimeout(updateHeight, 1000);', 'unmeasured 1000ms iframe timer');
  requireAbsent(source, "                        img.addEventListener('load', updateHeight);", 'unmeasured iframe image listener');
  requireAbsent(source, '                    var ro = new ResizeObserver(updateHeight);', 'unmeasured iframe resize observer');
  requireAbsent(source, '                    setInterval(updateHeight, 1000);', 'unmeasured iframe fallback timer');
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
