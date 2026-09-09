import { countOccurrences, editText } from '../lib.mjs';

function requireCount(source, needle, expected, label) {
  const count = countOccurrences(source, needle);
  if (count !== expected) throw new Error(`Expected ${expected} ${label}, found ${count}`);
}

function requirePatternCount(source, pattern, expected, label) {
  const count = source.match(pattern)?.length ?? 0;
  if (count !== expected) throw new Error(`Expected ${expected} ${label}, found ${count}`);
}

const endpointHelper = `    const buildApiEndpoint = (baseUrl, path) => {
        const root = String(baseUrl || '').replace(/\\/+$/, '');
        const apiRoot = /\\/v1$/i.test(root) ? root : \`\${root}/v1\`;
        return \`\${apiRoot}/\${String(path || '').replace(/^\\/+/, '')}\`;
    };`;

const retiredSchedulerMarkers = Object.freeze([
  'createStreamingBoundaryTracker',
  'schedulePublish',
  'STREAM_MAX_VISIBLE_LATENCY_MS',
  'STREAM_MIN_VISIBLE_GAP_MS',
  'getStreamMaxVisibleLatency',
  'paragraphBoundaryPending',
  'publishTimerDueAt'
]);

const fixedFlush192 = `                let flushPromise = Promise.resolve();
                const flush = () => {
                    if (!result.isStream || (!pendingContent && !pendingReasoning)) return;
                    const delta = { content: pendingContent, reasoning: pendingReasoning };
                    pendingContent = pendingReasoning = '';
                    flushPromise = flushPromise.then(() => options.onDelta?.(delta));
                    // 立即挂上处理器，最终仍由 await 抛出回调错误。
                    flushPromise.catch(() => {});
                };`;

const fixedFlush193 = `                let flushPromise = Promise.resolve();
                const flush = () => {
                    if (!result.isStream || (!pendingContent && !pendingReasoning && !toolsChanged)) return;
                    const delta = { content: pendingContent, reasoning: pendingReasoning,
                        ...(toolsChanged ? { toolCalls: toolSnapshot().filter(call => call.function.name
                            && !(options.replyInTool && replyTool.function.name.startsWith(call.function.name))) } : {}) };
                    pendingContent = pendingReasoning = '';
                    toolsChanged = false;
                    flushPromise = flushPromise.then(() => options.onDelta?.(delta));
                    // 立即挂上处理器，最终仍由 await 抛出回调错误。
                    flushPromise.catch(() => {});
                };`;

function validateSharedTransport(source) {
  requireCount(source, 'const interval = setInterval(flush, 60);', 1, 'upstream fixed stream interval');
  requireCount(source, 'clearInterval(interval);', 1, 'upstream fixed stream interval cleanup');
  requireCount(source, '                    flush();\n                    await flushPromise;', 1, 'upstream final stream flush');
  requireCount(source, 'result.finishReason = choice.finish_reason ?? result.finishReason;', 1, 'upstream finish-reason capture');
  requireCount(source, "options.signal?.removeEventListener('abort', abort);", 1, 'upstream abort cleanup');
  requireCount(source, '__RPH_PERF__', 0, 'retired performance diagnostics');
}

function rejectRetiredScheduler(source) {
  const marker = retiredSchedulerMarkers.find(candidate => source.includes(candidate));
  if (marker) throw new Error(`Retired local stream scheduler marker remains: ${marker}`);
}

function validateEndpointOnlyTransport(source) {
  requireCount(source, endpointHelper, 1, 'endpoint helper implementation');
  requireCount(source, 'window.RPHubApiUtils = Object.freeze({ buildApiEndpoint });', 1, 'endpoint helper export');
  requirePatternCount(source, /^\s*window\.RPHubApiClient\s*=/gm, 0, 'endpoint-only API client exports');
  requirePatternCount(
    source,
    /^\s*(?:(?:const|let|var)\s+requestChatCompletion(?:Once)?\b|(?:async\s+)?function\s+requestChatCompletion(?:Once)?\b)/gm,
    0,
    'endpoint-only chat transport declarations'
  );
}

// The fork deliberately has no transport customization. This validator stays in
// the overlay manifest so a known stable transport is proven before reapply or
// conflict resolution, while the returned bytes remain the upstream bytes.
export function patchApiUtilsOverlay(source) {
  rejectRetiredScheduler(source);

  if (source.includes('    const requestChatCompletionOnce = async (options, attempt) => {')) {
    validateSharedTransport(source);
    requireCount(source, fixedFlush193, 1, 'stable 1.9.3 stream flush implementation');
    requireCount(source, 'const requestChatCompletion = async options => {', 1, 'stable 1.9.3 retry wrapper');
    requireCount(source, 'retryableEmptyToolReply', 2, 'stable 1.9.3 empty tool-reply retry contract');
    requireCount(source, 'toolCalls: toolSnapshot()', 1, 'stable 1.9.3 streamed tool-call snapshot');
    requireCount(source, 'return finish();', 2, 'stable 1.9.3 finish paths');
    return source;
  }

  if (source.includes('    const requestChatCompletion = async (options) => {')) {
    validateSharedTransport(source);
    requireCount(source, fixedFlush192, 1, 'stable 1.9.2 stream flush implementation');
    requireCount(source, '        const accept = data => {', 1, 'stable 1.9.2 stream accept handler');
    requireCount(source, 'result.content += content;', 1, 'stable 1.9.2 content accumulation');
    requireCount(source, 'window.RPHubApiClient = Object.freeze({ requestChatCompletion, requestJson });', 1, 'stable 1.9.2 API client export');
    return source;
  }

  if (source.includes('const buildApiEndpoint')) {
    validateEndpointOnlyTransport(source);
    return source;
  }

  throw new Error('Unsupported API transport drift');
}

export async function applyApiUtilsHooks() {
  const change = await editText('assets/js/api-utils.js', 'api-utils-hooks', patchApiUtilsOverlay);
  return change ? [change] : [];
}
