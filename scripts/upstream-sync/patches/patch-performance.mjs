import { countOccurrences, editText, requireContains } from '../lib.mjs';
import { patchIndexScriptOverlay } from './index-script-overlay.mjs';

const category = 'performance-patches';

export function patchRuntimeServicesOverlay(source) {
  const cacheStats = `

        const getCacheStats = (cache) => {
            let keyChars = 0;
            let valueChars = 0;
            cache.forEach((value, key) => {
                keyChars += typeof key === 'string' ? key.length : 0;
                valueChars += typeof value === 'string' ? value.length : 0;
            });
            return { entries: cache.size, approxKeyChars: keyChars, approxValueChars: valueChars };
        };`;
  source = source.replace(cacheStats, '');
  source = source.replace(
    `        const sanitizeMarkdown = (text) => {
            const perf = window.__RPH_PERF__;
            const parsed = perf?.active
                ? perf.measure('marked.parse', () => marked.parse(text))
                : marked.parse(text);
            return perf?.active
                ? perf.measure('DOMPurify.sanitize', () => DOMPurify.sanitize(parsed, cleanConfig))
                : DOMPurify.sanitize(parsed, cleanConfig);
        };`,
    '        const sanitizeMarkdown = (text) => DOMPurify.sanitize(marked.parse(text), cleanConfig);'
  );
  source = source.replace(
    `        const renderMarkdown = (text, role = 'assistant', skipRegex = false) => {
            const perf = window.__RPH_PERF__;
            return perf?.active
                ? perf.measure('renderMarkdown', () => renderMarkdownImpl(text, role, skipRegex))
                : renderMarkdownImpl(text, role, skipRegex);
        };

        window.__RPH_PERF__?.registerCacheReader?.('renderedCache', () => getCacheStats(renderedCache));
        window.__RPH_PERF__?.registerCacheReader?.('frameDetectionCache', () => getCacheStats(frameDetectionCache));
        return { clearCaches, contentUsesHtmlFrame, renderMarkdown };`,
    '        return { clearCaches, contentUsesHtmlFrame, renderMarkdown };'
  );
  source = source.replace(
    "        const renderMarkdownImpl = (text, role = 'assistant', skipRegex = false) => {",
    "        const renderMarkdown = (text, role = 'assistant', skipRegex = false) => {"
  );
  requireContains(source, "const renderMarkdown = (text, role = 'assistant', skipRegex = false) => {", 'message renderer');
  if (source.includes('__RPH_PERF__')) throw new Error('Performance diagnostics remain in runtime services');
  return source;
}

const appPerfBlocks = Object.freeze({
  observedSet: '        const perfObservedRevealElements = window.__RPH_PERF__?.enabled ? new WeakSet() : null;\n',
  observedAdd: '                        perfObservedRevealElements?.add(el);\n',
  savePromiseGuard: '            if (window.__RPH_PERF__?.active) return Promise.resolve();\n',
  saveGuard: '            if (window.__RPH_PERF__?.active) return;\n',
  trackDom: `                        if (window.__RPH_PERF__?.active) {
                            window.__RPH_PERF__.trackDomStabilization(
                                nextTick().then(() => new Promise(resolve => requestAnimationFrame(resolve)))
                            );
                        }
`,
  processRegexWrapper: `        const processRegex = (text, options = {}) => {
            const perf = window.__RPH_PERF__;
            return perf?.active
                ? perf.measure('processRegex', () => processRegexImpl(text, options))
                : processRegexImpl(text, options);
        };
`,
  wideLayoutWrapper: `        const messageUsesWideLayout = (msg) => {
            const perf = window.__RPH_PERF__;
            return perf?.active
                ? perf.measure('messageUsesWideLayout', () => messageUsesWideLayoutImpl(msg))
                : messageUsesWideLayoutImpl(msg);
        };
`,
  timelineWrapper: `        const getTimelineSteps = (message) => {
            const perf = window.__RPH_PERF__;
            return perf?.active
                ? perf.measure('getTimelineSteps', () => getTimelineStepsImpl(message))
                : getTimelineStepsImpl(message);
        };
`,
  appendStart: `            const appendAssistantText = (message, field, text) => {
                const perfStartedAt = window.__RPH_PERF__?.active ? performance.now() : null;
                try {`,
  appendEnd: `                if (isContinuation) activeToolContinuationHasResponse.value = true;
                } finally {
                    if (perfStartedAt !== null) {
                        window.__RPH_PERF__.recordFunction('appendAssistantText', performance.now() - perfStartedAt);
                    }
                }
            };`,
  exports: `            __perfSetChatRenderLimit: limit => { if (window.__RPH_PERF__?.enabled) chatRenderLimit.value = limit; },
            __perfLoadEarlierChatMessages: batchSize => window.__RPH_PERF__?.enabled
                ? loadEarlierChatMessages(batchSize)
                : Promise.resolve(),
            __perfGetChatRenderLimit: () => window.__RPH_PERF__?.enabled ? chatRenderLimit.value : null,
            __perfGetScrollRevealObservedCount: () => window.__RPH_PERF__?.enabled
                ? (messageElements.value || []).filter(el => perfObservedRevealElements?.has(el)).length
                : null,
            __perfClearCaches: () => {
                if (!window.__RPH_PERF__?.enabled) return;
                clearMessageRenderCaches();
                window.RPHubUtils.clearParseCotCache?.();
            },
`,
  mount: `const appInstance = app.mount('#app');
window.__RPH_PERF__?.attachApp?.(appInstance);
window.__RPH_SCROLL_PERF__?.attachApp?.(appInstance);`
});

function replaceAppPerfBlock(source, before, after, label, expected = 1) {
  const count = countOccurrences(source, before);
  if (count !== expected) throw new Error(`Expected ${expected} ${label}, found ${count}`);
  return source.split(before).join(after);
}

export function removeAppDiagnostics(source) {
  const diagnosticMarkers = ['__RPH_PERF__', '__RPH_SCROLL_PERF__', '__perf', 'processRegexImpl', 'messageUsesWideLayoutImpl', 'getTimelineStepsImpl'];
  if (!diagnosticMarkers.some(marker => source.includes(marker))) {
    requireContains(source, "app.mount('#app');", 'Vue app mount');
    return source;
  }
  source = replaceAppPerfBlock(source, appPerfBlocks.observedSet, '', 'scroll reveal diagnostic set');
  source = replaceAppPerfBlock(source, appPerfBlocks.observedAdd, '', 'scroll reveal diagnostic observation');
  source = replaceAppPerfBlock(source, appPerfBlocks.savePromiseGuard, '', 'chat-save diagnostic guard');
  source = replaceAppPerfBlock(source, appPerfBlocks.saveGuard, '', 'persistence diagnostic guards', 2);
  source = replaceAppPerfBlock(source, '        const processRegexImpl =', '        const processRegex =', 'processRegex diagnostic implementation');
  source = replaceAppPerfBlock(source, appPerfBlocks.processRegexWrapper, '', 'processRegex diagnostic wrapper');
  source = replaceAppPerfBlock(source, '        const messageUsesWideLayoutImpl =', '        const messageUsesWideLayout =', 'wide-layout diagnostic implementation');
  source = replaceAppPerfBlock(source, appPerfBlocks.wideLayoutWrapper, '', 'wide-layout diagnostic wrapper');
  source = replaceAppPerfBlock(source, '        const getTimelineStepsImpl =', '        const getTimelineSteps =', 'timeline diagnostic implementation');
  source = replaceAppPerfBlock(source, appPerfBlocks.timelineWrapper, '', 'timeline diagnostic wrapper');
  source = replaceAppPerfBlock(source, appPerfBlocks.appendStart, '            const appendAssistantText = (message, field, text) => {', 'assistant append diagnostic start');
  source = replaceAppPerfBlock(source, appPerfBlocks.appendEnd, `                if (isContinuation) activeToolContinuationHasResponse.value = true;
            };`, 'assistant append diagnostic end');
  source = replaceAppPerfBlock(source, appPerfBlocks.trackDom, '', 'DOM stabilization diagnostic');
  source = replaceAppPerfBlock(source, appPerfBlocks.exports, '', 'benchmark app exports');
  source = replaceAppPerfBlock(source, appPerfBlocks.mount, "app.mount('#app');", 'benchmark app mount');
  if (diagnosticMarkers.some(marker => source.includes(marker))) throw new Error('Performance diagnostics remain in app.js');
  return source;
}

function removeOffscreenDiagnostics(source) {
  source = source.replace(/    const diagnostics = window\.__RPH_PERF__\?\.enabled === true \? \{[\s\S]*?    \} : null;\n/, '');
  source = source.replace(/        if \(diagnostics && previousState && previousState !== state\) \{[\s\S]*?        \}\n/, '');
  source = source.replace('        const previousState = meta.state;\n', '');
  source = source.replace(/\n    const resetDiagnostics = \(\) => \{[\s\S]*?    \};\n\n    const getDiagnostics = \(\) => diagnostics \? \{[\s\S]*?    \} : null;\n/, '\n');
  source = source.replace('        getDiagnostics,\n', '');
  source = source.replace('        resetDiagnostics,\n', '');
  if (source.includes('diagnostics')) throw new Error('Performance diagnostics remain in offscreen iframe lifecycle');
  return source;
}

export async function applyPerformanceHooks() {
  const changes = [];
  changes.push(await editText('index.html', category, patchIndexScriptOverlay));
  changes.push(await editText('assets/js/app.js', category, source => {
    source = removeAppDiagnostics(source);
    requireContains(source, 'window.RPHubOffscreenIframeLifecycle?.attach(container);', 'offscreen attach hook');
    requireContains(source, 'window.RPHubOffscreenIframeLifecycle?.detach();', 'offscreen cleanup hook');
    return source;
  }));
  changes.push(await editText('assets/js/runtime-services.js', category, patchRuntimeServicesOverlay));
  changes.push(await editText('assets/js/offscreen-iframe-lifecycle.js', category, removeOffscreenDiagnostics));
  return changes.filter(Boolean);
}
