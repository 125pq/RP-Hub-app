import { countOccurrences, editText, replaceOnce } from '../lib.mjs';
import { streamSchedulerSetup } from './patch-performance.mjs';

function requireCount(source, needle, expected, label) {
  const count = countOccurrences(source, needle);
  if (count !== expected) throw new Error(`Expected ${expected} ${label}, found ${count}`);
}

function removeOnce(source, block, label) {
  const count = countOccurrences(source, block);
  if (count === 0) return source;
  if (count !== 1) throw new Error(`Expected one removal anchor for ${label}, found ${count}`);
  return source.replace(block, '');
}

const requestHeader = '    const requestChatCompletion = async (options) => {';
const legacyEndpointOnlyModule = `// Shared API endpoint helpers used by the main app and the novel page.
(function () {
    const buildApiEndpoint = (baseUrl, path) => {
        const root = String(baseUrl || '').replace(/\\/+$/, '');
        const apiRoot = /\\/v1$/i.test(root) ? root : \`\${root}/v1\`;
        return \`\${apiRoot}/\${String(path || '').replace(/^\\/+/, '')}\`;
    };

    window.RPHubApiUtils = Object.freeze({ buildApiEndpoint });
})();
`;
const rawRequestState = `        let pendingContent = '';
        let pendingReasoning = '';
        const accept = data => {
            receivedPayload = true;
            result.usage = getApiUsagePayload(data) || result.usage;
            const choice = data.choices?.[0] || {};
            const message = choice.delta || choice.message || {};
            const content = readTextContent(message.content ?? choice.text);
            const reasoning = extractNativeReasoning(message) || extractNativeReasoning(choice) || '';
            result.content += content;
            result.reasoning += reasoning;
            result.finishReason = choice.finish_reason ?? result.finishReason;
            pendingContent += content;
            pendingReasoning += reasoning;
        };`;

const scheduledRequestState = `        let pendingContent = '';
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
            if (!result.isStream || (!pendingContent && !pendingReasoning)) return;
            clearPublishTimer();
            const delta = { content: pendingContent, reasoning: pendingReasoning };
            pendingContent = pendingReasoning = '';
            pendingSince = null;
            paragraphBoundaryPending = false;
            lastPublishAt = performance.now();
            flushPromise = flushPromise.then(async () => {
                const perf = window.__RPH_PERF__;
                const token = perf?.active ? perf.beginFlush(delta, reason) : null;
                try { await options.onDelta?.(delta); }
                finally { if (token) perf.endFlush(token); }
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
            if (dueAt <= currentTime) { flushPending(reason); return; }
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
        const accept = data => {
            receivedPayload = true;
            result.usage = getApiUsagePayload(data) || result.usage;
            const choice = data.choices?.[0] || {};
            const message = choice.delta || choice.message || {};
            const content = readTextContent(message.content ?? choice.text);
            const reasoning = extractNativeReasoning(message) || extractNativeReasoning(choice) || '';
            result.content += content;
            result.reasoning += reasoning;
            result.finishReason = choice.finish_reason ?? result.finishReason;
            pendingContent += content;
            pendingReasoning += reasoning;
            if (!result.isStream || (!content && !reasoning)) return;
            window.__RPH_PERF__?.recordStreamDelta?.({ content, reasoning });
            if (pendingSince === null) pendingSince = performance.now();
            if (contentBoundaries.scan(content) || reasoningBoundaries.scan(reasoning)) paragraphBoundaryPending = true;
            schedulePublish();
        };`;

const legacyFlush = `                let flushPromise = Promise.resolve();
                const flush = () => {
                    if (!result.isStream || (!pendingContent && !pendingReasoning)) return;
                    const delta = { content: pendingContent, reasoning: pendingReasoning };
                    pendingContent = pendingReasoning = '';
                    flushPromise = flushPromise.then(() => options.onDelta?.(delta));
                    // 立即挂上处理器，最终仍由 await 抛出回调错误。
                    flushPromise.catch(() => {});
                };
`;

const legacyCompletion = `                    if (!receivedPayload) throw new Error('API 未返回有效的模型响应');
                    return result;
                } finally {
                    clearInterval(interval);
                    if (reader) {
                        try { await reader.cancel(); } catch (_) { }
                        reader.releaseLock();
                    }
                    flush();
                    await flushPromise;
                }`;

const scheduledCompletion = `                    if (!receivedPayload) throw new Error('API 未返回有效的模型响应');
                    flushPending('final');
                    await flushPromise;
                    return result;
                } catch (error) {
                    flushPending(error?.name === 'AbortError' ? 'abort' : 'error');
                    await flushPromise;
                    throw error;
                } finally {
                    clearPublishTimer();
                    if (reader) {
                        try { await reader.cancel(); } catch (_) { }
                        reader.releaseLock();
                    }
                }`;

export function patchApiUtilsOverlay(source) {
  if (!source.includes(requestHeader)) {
    if (source !== legacyEndpointOnlyModule) throw new Error('Unsupported endpoint-only API module drift');
    return source;
  }
  source = replaceOnce(source, requestHeader, `${streamSchedulerSetup}\n${requestHeader}`, 'API streaming scheduler setup');
  source = replaceOnce(source, rawRequestState, scheduledRequestState, 'API stream request state');
  source = replaceOnce(
    source,
    '            const response = await fetch(options.url, {',
    `            const syntheticResponse = window.__RPH_PERF__?.takeSyntheticResponse?.(options);
            const response = syntheticResponse || await fetch(options.url, {`,
    'API synthetic response hook'
  );
  source = removeOnce(source, legacyFlush, 'API fixed stream flush');
  source = removeOnce(source, '                const interval = setInterval(flush, 60);\n', 'API fixed stream interval');
  source = replaceOnce(source, legacyCompletion, scheduledCompletion, 'API stream completion and error flush');

  requireCount(source, 'createStreamingBoundaryTracker = () => {', 1, 'paragraph boundary tracker');
  requireCount(source, 'createStreamingBoundaryTracker()', 2, 'paragraph boundary tracker instances');
  requireCount(source, 'const schedulePublish = () => {', 1, 'stream publish scheduler');
  requireCount(source, "flushPending('final');", 1, 'streaming final flush');
  requireCount(source, "flushPending(error?.name === 'AbortError' ? 'abort' : 'error');", 1, 'streaming error flush');
  requireCount(source, 'result.content += content;', 1, 'API result content accumulation');
  requireCount(source, 'const interval = setInterval(flush, 60);', 0, 'fixed stream intervals');
  requireCount(source, 'takeSyntheticResponse?.(options)', 1, 'synthetic response hook');
  requireCount(source, requestHeader, 1, 'API request completion entry');
  return source;
}

export async function applyApiUtilsHooks() {
  const change = await editText('assets/js/api-utils.js', 'api-utils-hooks', patchApiUtilsOverlay);
  return change ? [change] : [];
}
