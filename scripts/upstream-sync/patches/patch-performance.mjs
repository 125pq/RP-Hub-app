import { countOccurrences, editText, ensureAfter, replaceOnce, requireContains } from '../lib.mjs';
import { patchIndexScriptOverlay } from './index-script-overlay.mjs';

const category = 'performance-patches';

function requireSingle(source, needle, label) {
  const count = countOccurrences(source, needle);
  if (count !== 1) throw new Error(`Expected exactly one ${label}, found ${count}`);
}

export const streamSchedulerSetup = `    const STREAM_MAX_VISIBLE_LATENCY_MS = 350;
    const STREAM_MIN_VISIBLE_GAP_MS = 80;

    const createStreamingBoundaryTracker = () => {
        let insideFence = false;
        let fenceMarker = '';
        let insideThink = false;
        let insideCot = false;
        let linePrefix = '';
        let fenceHandledOnLine = false;
        let recent = '';
        let previousWasNewline = false;

        const scan = (text) => {
            let paragraphBoundary = false;
            let semanticBlockClosed = false;

            for (const char of String(text || '')) {
                if (char === '\\n') {
                    if (previousWasNewline && !insideFence && !insideThink && !insideCot) {
                        paragraphBoundary = true;
                    }
                    previousWasNewline = true;
                    linePrefix = '';
                    fenceHandledOnLine = false;
                } else if (char !== '\\r') {
                    previousWasNewline = false;
                    if (linePrefix.length < 8) linePrefix += char;
                }

                if (!fenceHandledOnLine && char !== '\\r' && char !== '\\n') {
                    const fence = linePrefix.match(/^ {0,3}(\`{3,}|~{3,})$/);
                    if (fence) {
                        fenceHandledOnLine = true;
                        const marker = fence[1][0];
                        if (!insideFence) {
                            insideFence = true;
                            fenceMarker = marker;
                        } else if (marker === fenceMarker) {
                            insideFence = false;
                            fenceMarker = '';
                        }
                    }
                }

                recent = \`\${recent}\${char}\`.slice(-16).toLowerCase();
                if (insideFence) continue;
                if (recent.endsWith('<think>')) insideThink = true;
                if (recent.endsWith('<cot>')) insideCot = true;
                if (recent.endsWith('</think>')) {
                    insideThink = false;
                    semanticBlockClosed = true;
                }
                if (recent.endsWith('</cot>')) {
                    insideCot = false;
                    semanticBlockClosed = true;
                }
            }

            return paragraphBoundary || semanticBlockClosed;
        };

        return { scan };
    };

    const getStreamMaxVisibleLatency = () => {
        const benchmarkValue = Number(window.__RPH_PERF__?.getStreamMaxLatencyMs?.());
        return Number.isFinite(benchmarkValue) && benchmarkValue >= 50
            ? benchmarkValue
            : STREAM_MAX_VISIBLE_LATENCY_MS;
    };`;

const legacyStreamStateAndFlush = `        let pendingContent = '';
        let pendingReasoning = '';
        let flushPromise = Promise.resolve();
        let publishTimer = null;
        let publishTimerDueAt = null;
        let publishTimerReason = null;
        let pendingSince = null;
        let paragraphBoundaryPending = false;
        let lastPublishAt = -Infinity;
        const contentBoundaries = createStreamingBoundaryTracker();
        const reasoningBoundaries = createStreamingBoundaryTracker();
        const maxVisibleLatencyMs = getStreamMaxVisibleLatency();

        const clearPublishTimer = () => {
            if (publishTimer !== null) clearTimeout(publishTimer);
            publishTimer = null;
            publishTimerDueAt = null;
            publishTimerReason = null;
        };

        const flushPending = (reason) => {
            if (!pendingContent && !pendingReasoning) return;
            clearPublishTimer();
            const delta = { content: pendingContent, reasoning: pendingReasoning };
            pendingContent = '';
            pendingReasoning = '';
            pendingSince = null;
            paragraphBoundaryPending = false;
            lastPublishAt = performance.now();
            flushPromise = flushPromise.then(async () => {
                const perf = window.__RPH_PERF__;
                const token = perf?.active ? perf.beginFlush(delta, reason) : null;
                try {
                    await onDelta?.(delta);
                } finally {
                    if (token) perf.endFlush(token);
                }
            });
        };

        const schedulePublish = () => {
            if (pendingSince === null) return;
            const currentTime = performance.now();
            const maxLatencyDueAt = pendingSince + maxVisibleLatencyMs;
            const paragraphDueAt = paragraphBoundaryPending
                ? Math.max(currentTime, lastPublishAt + STREAM_MIN_VISIBLE_GAP_MS)
                : Infinity;
            const reason = paragraphDueAt <= maxLatencyDueAt ? 'paragraph' : 'max-latency';
            const dueAt = Math.min(paragraphDueAt, maxLatencyDueAt);

            if (dueAt <= currentTime) {
                flushPending(reason);
                return;
            }
            if (publishTimer !== null && publishTimerDueAt <= dueAt) return;
            clearPublishTimer();
            publishTimerDueAt = dueAt;
            publishTimerReason = reason;
            publishTimer = setTimeout(() => {
                const scheduledReason = publishTimerReason;
                publishTimer = null;
                publishTimerDueAt = null;
                publishTimerReason = null;
                flushPending(scheduledReason);
            }, Math.max(0, dueAt - currentTime));
        };

        const queueDelta = (chunk) => {
            if (!chunk.content && !chunk.reasoning) return;
            window.__RPH_PERF__?.recordStreamDelta?.(chunk);
            if (pendingSince === null) pendingSince = performance.now();
            pendingContent += chunk.content;
            pendingReasoning += chunk.reasoning;
            const contentBoundary = contentBoundaries.scan(chunk.content);
            const reasoningBoundary = reasoningBoundaries.scan(chunk.reasoning);
            const hasBoundary = contentBoundary || reasoningBoundary;
            if (hasBoundary) paragraphBoundaryPending = true;
            schedulePublish();
        };`;

function patchLegacyRuntimeApi(source) {
  if (!source.includes('// --- API client ---')) {
    requireSingle(source, '// RP-Hub message rendering and application composables.', '1.9.2 runtime module header');
    if (source.includes('window.RPHubApiClient')) throw new Error('Unexpected API client in split runtime module');
    return source;
  }
  source = replaceOnce(source, '    const STREAM_RENDER_INTERVAL = 60;', streamSchedulerSetup, 'legacy stream scheduler');
  source = replaceOnce(
    source,
    `        let pendingContent = '';
        let pendingReasoning = '';
        let flushPromise = Promise.resolve();

        const flushPending = () => {
            if (!pendingContent && !pendingReasoning) return;
            const delta = { content: pendingContent, reasoning: pendingReasoning };
            pendingContent = '';
            pendingReasoning = '';
            flushPromise = flushPromise.then(() => onDelta?.(delta));
        };

        const flushInterval = setInterval(flushPending, STREAM_RENDER_INTERVAL);`,
    legacyStreamStateAndFlush,
    'legacy stream flush scheduler'
  );
  source = replaceOnce(
    source,
    `                        pendingContent += chunk.content;
                        pendingReasoning += chunk.reasoning;`,
    '                        queueDelta(chunk);',
    'legacy stream delta queue'
  );
  source = replaceOnce(
    source,
    `            return { content: '', reasoning: '', usage };
        } finally {
            clearInterval(flushInterval);
            flushPending();
            await flushPromise;
        }`,
    `            flushPending('final');
            await flushPromise;
            return { content: '', reasoning: '', usage };
        } catch (error) {
            flushPending(error?.name === 'AbortError' ? 'abort' : 'error');
            await flushPromise;
            throw error;
        } finally {
            clearPublishTimer();
        }`,
    'legacy stream completion flush'
  );
  source = replaceOnce(
    source,
    `    const requestChatCompletion = async (options) => {
        const response = await fetch(options.url, {`,
    `    const requestChatCompletion = async (options) => {
        const syntheticResponse = window.__RPH_PERF__?.takeSyntheticResponse?.(options);
        const response = syntheticResponse || await fetch(options.url, {`,
    'legacy synthetic response hook'
  );
  requireSingle(source, 'const createStreamingBoundaryTracker = () => {', 'legacy paragraph boundary tracker');
  requireSingle(source, "flushPending('final');", 'legacy final stream flush');
  requireSingle(source, 'takeSyntheticResponse?.(options)', 'legacy synthetic response hook');
  return source;
}

export function patchRuntimeServicesOverlay(source) {
  source = patchLegacyRuntimeApi(source);
  const rendererCacheStats = `        const getCacheStats = (cache) => {
            let keyChars = 0;
            let valueChars = 0;
            cache.forEach((value, key) => {
                keyChars += typeof key === 'string' ? key.length : 0;
                valueChars += typeof value === 'string' ? value.length : 0;
            });
            return { entries: cache.size, approxKeyChars: keyChars, approxValueChars: valueChars };
        };
`;
  source = ensureAfter(
    source,
    '        const frameDetectionCache = new Map();',
    `\n\n${rendererCacheStats.trimEnd()}`,
    'message renderer cache statistics'
  );
  source = replaceOnce(
    source,
    '        const sanitizeMarkdown = (text) => DOMPurify.sanitize(marked.parse(text), cleanConfig);',
    `        const sanitizeMarkdown = (text) => {
            const perf = window.__RPH_PERF__;
            const parsed = perf?.active
                ? perf.measure('marked.parse', () => marked.parse(text))
                : marked.parse(text);
            return perf?.active
                ? perf.measure('DOMPurify.sanitize', () => DOMPurify.sanitize(parsed, cleanConfig))
                : DOMPurify.sanitize(parsed, cleanConfig);
        };`,
    'message renderer sanitize measurements'
  );
  source = replaceOnce(
    source,
    '        const renderMarkdown = (text, role = \'assistant\', skipRegex = false) => {',
    '        const renderMarkdownImpl = (text, role = \'assistant\', skipRegex = false) => {',
    'message renderer implementation split'
  );
  source = replaceOnce(
    source,
    '        return { clearCaches, contentUsesHtmlFrame, renderMarkdown };',
    `        const renderMarkdown = (text, role = 'assistant', skipRegex = false) => {
            const perf = window.__RPH_PERF__;
            return perf?.active
                ? perf.measure('renderMarkdown', () => renderMarkdownImpl(text, role, skipRegex))
                : renderMarkdownImpl(text, role, skipRegex);
        };

        window.__RPH_PERF__?.registerCacheReader?.('renderedCache', () => getCacheStats(renderedCache));
        window.__RPH_PERF__?.registerCacheReader?.('frameDetectionCache', () => getCacheStats(frameDetectionCache));
        return { clearCaches, contentUsesHtmlFrame, renderMarkdown };`,
    'message renderer performance wrapper'
  );

  requireSingle(source, 'const getCacheStats = (cache) => {', 'message renderer cache statistics');
  requireSingle(source, 'const renderMarkdownImpl = (text, role = \'assistant\', skipRegex = false) => {', 'message renderer implementation');
  requireSingle(source, 'const renderMarkdown = (text, role = \'assistant\', skipRegex = false) => {', 'message renderer wrapper');
  return source;
}

export async function applyPerformanceHooks() {
  const changes = [];
  changes.push(await editText('index.html', category, patchIndexScriptOverlay));

  changes.push(await editText('assets/js/app.js', category, source => {
    requireContains(source, 'window.RPHubOffscreenIframeLifecycle?.attach(container);', 'offscreen attach hook');
    requireContains(source, 'window.RPHubOffscreenIframeLifecycle?.detach();', 'offscreen cleanup hook');
    return source;
  }));

  changes.push(await editText('assets/js/runtime-services.js', category, patchRuntimeServicesOverlay));
  return changes.filter(Boolean);
}
