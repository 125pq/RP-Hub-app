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
    const replyTool = {
        type: 'function',
        function: {
            name: 'output_reply',
            description: '将本次回复交给聊天界面显示。遵守现有输出规则，正文及需要附带的面板、图片标记、变量更新块等全部放入 content，不在普通消息中重复输出。检索工具返回结果后，只传新增回复内容。',
            parameters: {
                type: 'object',
                properties: { content: { type: 'string', description: '本次回复的原文，保留原有格式；作为 JSON 字符串正确转义。' } },
                required: ['content'],
                additionalProperties: false
            }
        }
    };

    // 超时按“多久没有响应”计算，持续输出的长回复不会因总时长被中断。
    const withApiResponse = async (options, read, diagnostics) => {
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
            if (diagnostics) {
                const { model, stream, tools, tool_choice, parallel_tool_calls, temperature, reasoning_effort, stream_options } = options.body;
                diagnostics.请求配置 = { model, stream, tools, tool_choice, parallel_tool_calls, temperature, reasoning_effort, stream_options,
                    消息数量: options.body.messages?.length, 末尾消息角色: options.body.messages?.slice(-6).map(message => message.role) };
                console.info('[工具输出][流式诊断] 请求', { 请求ID: diagnostics.请求ID, ...diagnostics.请求配置 });
                diagnostics.阶段 = '等待响应头';
            }
            const response = await fetch(options.url, {
                method: options.body === undefined ? 'GET' : 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
                ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
                signal: controller.signal
            });
            touch();
            if (diagnostics) {
                diagnostics.阶段 = '检查HTTP响应';
                diagnostics.HTTP状态 = response.status;
                diagnostics.响应头耗时ms = Date.now() - diagnostics.请求ID;
                diagnostics.响应类型 = response.headers.get('content-type') || '未提供';
                // 只读取追踪用响应头；未暴露给浏览器的跨域响应头也会为 null。
                diagnostics.响应追踪 = Object.fromEntries(['x-request-id', 'x-oneapi-request-id', 'cf-ray'].map(key => [key, response.headers.get(key)]));
                console.info('[工具输出][流式诊断] 开始', { 请求ID: diagnostics.请求ID, HTTP状态: response.status,
                    响应类型: diagnostics.响应类型, 响应头耗时ms: diagnostics.响应头耗时ms, 响应追踪: diagnostics.响应追踪 });
            }
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

    const requestChatCompletion = async (options) => {
        const startedAt = Date.now();
        const result = { content: '', reasoning: '', usage: null, finishReason: null, isStream: false };
        let receivedPayload = false;
        let pendingContent = '';
        let pendingReasoning = '';
        const replyCall = { id: '', name: '', arguments: '' };
        // 只记录工具配置、响应结构和回复正文，不记录密钥或上下文；样本保留前五条及最后一条。
        const streamDebug = options.replyInTool ? {
            请求ID: startedAt, 请求流式: !!options.stream, 响应类型: '',
            阶段: '准备请求', 失败阶段: null, 错误类型: null, HTTP状态: null,
            响应事件数: 0, 工具调用片段数: 0, 收到DONE: false, 响应结构样本: [],
            网络数据块数: 0, 参数片段数: 0, 正文推送批次: 0,
            首个网络块ms: null, 首个参数ms: null, 工具名就绪ms: null,
            首次正文解析ms: null, 首次正文推送ms: null, 结束时补充正文字符数: 0,
            普通正文全文: '', 拒绝信息: '',
            参数片段样本: []
        } : null;
        let replyPosition = null;
        let replyClosed = false;
        const invalidReply = () => new Error('输出正文工具的参数格式错误，应为仅含 content 字符串的 JSON 对象');
        // 只解码已经收齐的字符串字符，JSON 外壳和未收齐的转义不会进入正文。
        const readReplyDelta = () => {
            if (replyCall.name !== replyTool.function.name || replyClosed) return '';
            const source = replyCall.arguments;
            if (replyPosition === null) {
                const header = /^\s*\{\s*"content"\s*:\s*"/.exec(source);
                if (!header) return '';
                replyPosition = header[0].length;
            }
            let text = '';
            let lastPosition = replyPosition;
            while (replyPosition < source.length) {
                const char = source[replyPosition];
                if (char === '"') { replyPosition++; replyClosed = true; break; }
                if (char.charCodeAt(0) < 32) throw invalidReply();
                let size = 1;
                if (char === '\\') {
                    const escape = source[replyPosition + 1];
                    if (!escape) break;
                    if (escape === 'u') {
                        const digits = source.slice(replyPosition + 2, replyPosition + 6);
                        if (/[^\da-f]/i.test(digits)) throw invalidReply();
                        if (digits.length < 4) break;
                        size = 6;
                    } else {
                        if (!'"\\/bfnrt'.includes(escape)) throw invalidReply();
                        size = 2;
                    }
                }
                lastPosition = replyPosition;
                text += size === 1 ? char : JSON.parse('"' + source.slice(replyPosition, replyPosition + size) + '"');
                replyPosition += size;
            }
            if (!replyClosed && /[\uD800-\uDBFF]$/.test(text)) {
                replyPosition = lastPosition;
                text = text.slice(0, -1);
            }
            return text;
        };
        const finish = () => {
            if (streamDebug) streamDebug.阶段 = '校验工具输出';
            if (!options.replyInTool) return result;
            if (result.finishReason === 'content_filter') throw new Error('API 已停止工具输出');
            if (replyCall.name !== replyTool.function.name) {
                throw new Error('API 未返回抗截断输出，可能触发了空回或站点不支持，请重新尝试。');
            }
            let payload;
            try { payload = JSON.parse(replyCall.arguments); }
            catch (_) {
                if (replyPosition === null || (replyClosed && replyCall.arguments.slice(replyPosition).trim())) throw invalidReply();
                // 容忍末尾缺失的 JSON 闭合符号，保留已经解码的正文。
                return result;
            }
            if (!payload || typeof payload.content !== 'string' || Object.keys(payload).length !== 1
                || !payload.content.startsWith(result.content)) throw invalidReply();
            if (streamDebug) streamDebug.结束时补充正文字符数 = payload.content.length - result.content.length;
            pendingContent += payload.content.slice(result.content.length);
            result.content = payload.content;
            return result;
        };
        const accept = data => {
            if (streamDebug) streamDebug.阶段 = '提取响应字段';
            receivedPayload = true;
            result.usage = getApiUsagePayload(data) || result.usage;
            const choice = data.choices?.[0] || {};
            const message = choice.delta || choice.message || {};
            let content = readTextContent(message.content ?? choice.text);
            const reasoning = extractNativeReasoning(message) || extractNativeReasoning(choice) || '';
            if (options.replyInTool) {
                streamDebug.响应ID = data.id ?? streamDebug.响应ID;
                streamDebug.返回模型 = data.model ?? streamDebug.返回模型;
                streamDebug.工具调用片段数 += Array.isArray(message.tool_calls) ? message.tool_calls.length : 0;
                const sample = { 序号: ++streamDebug.响应事件数, 时间ms: Date.now() - startedAt,
                    顶层字段: Object.keys(data).slice(0, 24), choices数: data.choices?.length ?? 0, 选中分支: choice.index ?? null,
                    delta字段: Object.keys(choice.delta || {}).slice(0, 24), message字段: Object.keys(choice.message || {}).slice(0, 24),
                    正文类型: Array.isArray(message.content) ? message.content.slice(0, 6).map(part => part?.type || typeof part) : typeof message.content,
                    普通正文字符数: content.length, 原生思考字符数: reasoning.length, 结束原因: choice.finish_reason ?? null,
                    工具字段类型: Array.isArray(message.tool_calls) ? 'array' : typeof message.tool_calls,
                    工具片段: Array.isArray(message.tool_calls) ? message.tool_calls.slice(0, 3).map(call => ({
                        index: call?.index ?? null, type: call?.type, name: call?.function?.name,
                        字段: Object.keys(call || {}).slice(0, 24), 参数类型: typeof call?.function?.arguments,
                        参数字符数: typeof call?.function?.arguments === 'string' ? call.function.arguments.length : null
                    })) : [], 旧版函数调用: !!message.function_call };
                streamDebug.响应结构样本[Math.min(streamDebug.响应结构样本.length, 5)] = sample;
                streamDebug.普通正文全文 += content;
                streamDebug.拒绝信息 += readTextContent(message.refusal);
                for (const call of message.tool_calls || []) {
                    if ((call.index ?? 0) !== 0 || (call.type && call.type !== 'function')
                        || (call.id && replyCall.id && call.id !== replyCall.id)) throw invalidReply();
                    replyCall.id = call.id || replyCall.id;
                    replyCall.name += call.function?.name || '';
                    replyCall.arguments += call.function?.arguments || '';
                    if (call.function?.arguments) {
                        const elapsed = Date.now() - startedAt;
                        streamDebug.参数片段数++;
                        streamDebug.首个参数ms ??= elapsed;
                        const sample = { 时间ms: elapsed, 字符数: String(call.function.arguments).length };
                        streamDebug.参数片段样本[Math.min(streamDebug.参数片段样本.length, 5)] = sample;
                    }
                }
                if (replyCall.name === replyTool.function.name) streamDebug.工具名就绪ms ??= Date.now() - startedAt;
                streamDebug.阶段 = '解码工具正文';
                content = readReplyDelta();
                if (content) streamDebug.首次正文解析ms ??= Date.now() - startedAt;
            }
            result.content += content;
            result.reasoning += reasoning;
            result.finishReason = choice.finish_reason ?? result.finishReason;
            pendingContent += content;
            pendingReasoning += reasoning;
            if (streamDebug) streamDebug.阶段 = '读取响应';
        };
        try {
            const responseResult = await withApiResponse({ ...options, body: {
                model: options.model, messages: options.messages, temperature: options.temperature,
                ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
                ...(options.replyInTool ? {
                    tools: [replyTool],
                    tool_choice: { type: 'function', function: { name: replyTool.function.name } },
                    parallel_tool_calls: false
                } : {}),
                stream: !!options.stream,
                ...(options.stream ? { stream_options: { include_usage: true } } : {})
            } }, async (response, touch) => {
                if (streamDebug) streamDebug.阶段 = '读取响应';
                const eventStream = response.headers.get('content-type')?.includes('text/event-stream');
                let rawText;
                if (!eventStream) {
                    rawText = await response.text();
                    if (!/^\s*(?:data:|:)/.test(rawText)) {
                        if (streamDebug) streamDebug.阶段 = '解析响应JSON';
                        accept(parsePayload(rawText, response.status));
                        return finish();
                    }
                }
                result.isStream = !!options.stream;
                let buffer = '';
                let eventLines = [];
                let done = false;
                let flushPromise = Promise.resolve();
                const flush = () => {
                    if (!result.isStream || (!pendingContent && !pendingReasoning)) return;
                    const delta = { content: pendingContent, reasoning: pendingReasoning };
                    pendingContent = pendingReasoning = '';
                    flushPromise = flushPromise.then(() => {
                        if (streamDebug && delta.content) {
                            streamDebug.正文推送批次++;
                            streamDebug.首次正文推送ms ??= Date.now() - startedAt;
                        }
                        return options.onDelta?.(delta);
                    });
                    // 立即挂上处理器，最终仍由 await 抛出回调错误。
                    flushPromise.catch(() => { if (streamDebug) streamDebug.失败阶段 = '聊天显示回调'; });
                };
                const dispatch = () => {
                    if (!eventLines.length) return;
                    const payload = eventLines.join('\n');
                    eventLines = [];
                    if (payload.trim() === '[DONE]') {
                        done = true;
                        if (streamDebug) streamDebug.收到DONE = true;
                        return;
                    }
                    if (streamDebug) streamDebug.阶段 = '解析响应JSON';
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
                const interval = setInterval(flush, 60);
                try {
                    if (reader) {
                        while (!done) {
                            const chunk = await reader.read();
                            touch();
                            if (chunk.done) break;
                            if (streamDebug && chunk.value.length) {
                                streamDebug.网络数据块数++;
                                streamDebug.首个网络块ms ??= Date.now() - startedAt;
                            }
                            feed(decoder.decode(chunk.value, { stream: true }));
                        }
                        feed(decoder.decode());
                    } else feed(rawText);
                    // 兼容缺失最后换行的完整 JSON；损坏 JSON 必须报错，不能伪装成功。
                    if (!done) { readLine(buffer.replace(/\r$/, '')); dispatch(); }
                    if (!receivedPayload) throw new Error('API 未返回有效的模型响应');
                    return finish();
                } finally {
                    clearInterval(interval);
                    if (reader) {
                        try { await reader.cancel(); } catch (_) { }
                        reader.releaseLock();
                    }
                    flush();
                    await flushPromise;
                }
            }, streamDebug);
            if (streamDebug) streamDebug.阶段 = '完成';
            return responseResult;
        } catch (error) {
            if (streamDebug) {
                streamDebug.失败阶段 ??= streamDebug.阶段;
                streamDebug.错误类型 = error.name;
            }
            throw error;
        } finally {
            if (streamDebug) console.info('[工具输出][流式诊断] 汇总', {
                ...streamDebug, 总耗时ms: Date.now() - startedAt, 结果按流式处理: result.isStream,
                参数总字符数: replyCall.arguments.length, 正文总字符数: result.content.length,
                正文全文: result.content,
                原生思考字符数: result.reasoning.length,
                实际工具名: replyCall.name, 参数解析位置: replyPosition, 正文字符串已闭合: replyClosed,
                收到用量: !!result.usage,
                参数开头已识别: replyPosition !== null, 结束原因: result.finishReason
            });
            // 在业务层 JSON/模板校验之前记账；部分流式响应后中止也不会漏掉已返回的用量。
            if (receivedPayload) options.onUsage?.(result.usage, {
                isStream: result.isStream, durationMs: Date.now() - startedAt,
                outputCharacters: (options.replyInTool ? replyCall.arguments.length : result.content.length) + result.reasoning.length
            });
        }
    };

    window.RPHubApiUtils = Object.freeze({ buildApiEndpoint });
    window.RPHubApiClient = Object.freeze({ requestChatCompletion, requestJson });
})();
