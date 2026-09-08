// Shared model API transport for chat, memory, templates and standalone pages.
(function () {
    const { extractApiErrorMessage, formatApiErrorMessage, getApiUsagePayload } = window.RPHubUtils;
    const { extractNativeReasoning, isNativeReasoningPart } = window.RPHubCardUtils;
    const buildApiEndpoint = (baseUrl, path) => {
        const root = String(baseUrl || '').replace(/\/+$/, '');
        const apiRoot = /\/v1$/i.test(root) ? root : `${root}/v1`;
        return `${apiRoot}/${String(path || '').replace(/^\/+/, '')}`;
    };

    const parsePayload = (text, status) => {
        const data = JSON.parse(text);
        const error = extractApiErrorMessage(data, status);
        if (error) throw new Error(error);
        return data;
    };
    const readTextContent = value => Array.isArray(value)
        ? value.filter(part => !isNativeReasoningPart(part)).map(part => part?.text || part?.content || '').join('')
        : String(value || '');

    // 超时按“多久没有响应”计算，持续输出的长回复不会因总时长被中断。
    const withApiResponse = async (options, read) => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        let timer;
        let timedOut = false;
        const touch = () => {
            clearTimeout(timer);
            timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? 120000);
        };
        if (options.signal?.aborted) abort();
        else options.signal?.addEventListener('abort', abort, { once: true });
        touch();
        try {
            const syntheticResponse = window.__RPH_PERF__?.takeSyntheticResponse?.(options);
            const response = syntheticResponse || await fetch(options.url, {
                method: options.body === undefined ? 'GET' : 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
                ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
                signal: controller.signal
            });
            touch();
            if (!response.ok) {
                const text = await response.text();
                let payload;
                try { payload = JSON.parse(text); } catch (_) { }
                throw new Error(extractApiErrorMessage(payload, response.status) || formatApiErrorMessage(response.status, text));
            }
            return await read(response, touch);
        } catch (error) {
            if (timedOut && !options.signal?.aborted) {
                const timeout = new Error('API 响应超时，请稍后重试');
                timeout.name = 'TimeoutError';
                throw timeout;
            }
            throw error;
        } finally {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', abort);
        }
    };

    const requestJson = options => withApiResponse(options, async response => parsePayload(await response.text(), response.status));

    const STREAM_MAX_VISIBLE_LATENCY_MS = 350;
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
                if (char === '\n') {
                    if (previousWasNewline && !insideFence && !insideThink && !insideCot) {
                        paragraphBoundary = true;
                    }
                    previousWasNewline = true;
                    linePrefix = '';
                    fenceHandledOnLine = false;
                } else if (char !== '\r') {
                    previousWasNewline = false;
                    if (linePrefix.length < 8) linePrefix += char;
                }

                if (!fenceHandledOnLine && char !== '\r' && char !== '\n') {
                    const fence = linePrefix.match(/^ {0,3}(`{3,}|~{3,})$/);
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

                recent = `${recent}${char}`.slice(-16).toLowerCase();
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
    };
    const requestChatCompletion = async (options) => {
        const startedAt = Date.now();
        const result = { content: '', reasoning: '', usage: null, finishReason: null, isStream: false };
        let receivedPayload = false;
        let pendingContent = '';
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
        };
        try {
            return await withApiResponse({ ...options, body: {
                model: options.model, messages: options.messages, temperature: options.temperature,
                ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
                stream: !!options.stream,
                ...(options.stream ? { stream_options: { include_usage: true } } : {})
            } }, async (response, touch) => {
                const eventStream = response.headers.get('content-type')?.includes('text/event-stream');
                let rawText;
                if (!eventStream) {
                    rawText = await response.text();
                    if (!/^\s*(?:data:|:)/.test(rawText)) {
                        accept(parsePayload(rawText, response.status));
                        return result;
                    }
                }
                result.isStream = !!options.stream;
                let buffer = '';
                let eventLines = [];
                let done = false;
                const dispatch = () => {
                    if (!eventLines.length) return;
                    const payload = eventLines.join('\n');
                    eventLines = [];
                    if (payload.trim() === '[DONE]') { done = true; return; }
                    if (payload.trim()) accept(parsePayload(payload, response.status));
                };
                const readLine = line => {
                    if (done) return;
                    if (!line.trim()) dispatch();
                    else if (line.startsWith('data:')) {
                        // 部分兼容接口省略事件间空行，但多行 JSON 仍需等它完整。
                        let complete = eventLines.join('\n').trim() === '[DONE]';
                        try { JSON.parse(eventLines.join('\n')); complete = true; } catch (_) { }
                        if (complete) dispatch();
                        if (!done) eventLines.push(line.slice(5).replace(/^ /, ''));
                    }
                };
                const feed = text => {
                    buffer += text;
                    const lines = buffer.split(/\r\n|\n|\r(?!$)/);
                    buffer = lines.pop();
                    lines.forEach(readLine);
                };
                const reader = rawText === undefined ? response.body.getReader() : null;
                const decoder = new TextDecoder();
                try {
                    if (reader) {
                        while (!done) {
                            const chunk = await reader.read();
                            touch();
                            if (chunk.done) break;
                            feed(decoder.decode(chunk.value, { stream: true }));
                        }
                        feed(decoder.decode());
                    } else feed(rawText);
                    // 兼容缺失最后换行的完整 JSON；损坏 JSON 必须报错，不能伪装成功。
                    if (!done) { readLine(buffer.replace(/\r$/, '')); dispatch(); }
                    if (!receivedPayload) throw new Error('API 未返回有效的模型响应');
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
                }
            });
        } finally {
            // 在业务层 JSON/模板校验之前记账；部分流式响应后中止也不会漏掉已返回的用量。
            if (receivedPayload) options.onUsage?.(result.usage, {
                isStream: result.isStream, durationMs: Date.now() - startedAt,
                outputCharacters: result.content.length + result.reasoning.length
            });
        }
    };

    window.RPHubApiUtils = Object.freeze({ buildApiEndpoint });
    window.RPHubApiClient = Object.freeze({ requestChatCompletion, requestJson });
})();
