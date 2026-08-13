// Debug-only deterministic streaming benchmark. Enabled explicitly with ?rph_perf=1.
(function () {
    const params = new URLSearchParams(window.location.search);
    if (params.get('rph_perf') !== '1') {
        window.__RPH_PERF__ = Object.freeze({ enabled: false, active: false });
        return;
    }

    const encoder = new TextEncoder();
    const TARGET_SIZES = Object.freeze([2, 8, 32, 64]);
    const SCENARIO_TYPES = Object.freeze(['plain', 'markdown', 'cot', 'regex', 'mixed', 'rp-paragraph']);
    const NETWORK_CHUNK_COUNT = 144;
    const NETWORK_CHUNK_INTERVAL_MS = 10;
    const STREAM_FLUSH_INTERVAL_MS = 60;
    const STREAM_MAX_VISIBLE_LATENCY_MS = 350;
    const STREAM_MIN_VISIBLE_GAP_MS = 80;
    const cacheReaders = new Map();
    const pendingDom = new Set();
    const functionSamples = new Map();
    let app = null;
    let active = false;
    let responseFactory = null;
    let currentFlush = null;
    let flushSequence = 0;
    let runState = null;
    let longTaskObserver = null;
    let frameMonitor = null;
    let streamMaxLatencyOverride = null;
    const pendingStreamArrivals = [];

    const now = () => performance.now();
    const utf8Bytes = (text) => encoder.encode(String(text || '')).byteLength;
    const percentile = (values, fraction) => {
        if (!values.length) return null;
        const sorted = [...values].sort((a, b) => a - b);
        return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
    };
    const summarize = (values) => {
        if (!values.length) return { count: 0, total: 0, mean: null, median: null, p95: null, max: null };
        const total = values.reduce((sum, value) => sum + value, 0);
        return {
            count: values.length,
            total,
            mean: total / values.length,
            median: percentile(values, 0.5),
            p95: percentile(values, 0.95),
            max: Math.max(...values)
        };
    };
    const round = (value) => value === null || value === undefined ? value : Math.round(value * 1000) / 1000;
    const roundSummary = (summary) => Object.fromEntries(
        Object.entries(summary).map(([key, value]) => [key, typeof value === 'number' ? round(value) : value])
    );

    const templates = {
        plain: '雨落在旧城的石阶上。旅人放慢脚步，听见远处钟声与风穿过树梢。她说，我们把今天记下来，再继续向前。\n',
        markdown: [
            '# 夜航记录',
            '**重要**与*轻声*交替出现。',
            '- 第一项：检查灯塔',
            '- 第二项：记录潮汐',
            '> 风从北方来，船仍向前。',
            '`inlineCode()`',
            '```js',
            'const course = "north";',
            '```',
            '| 时间 | 状态 |',
            '| --- | --- |',
            '| 00:30 | 正常 |',
            '<details><summary>航海日志</summary>合成测试内容</details>',
            ''
        ].join('\n'),
        cot: '<think>先检查人物关系，再比较当前场景与既有线索。\n- 线索甲：钟声\n- 线索乙：旧地图\n保持叙事连续，不泄露系统信息。</think>\n正文从雨后的站台开始。她收起地图，说：“下一站见。”\n',
        regex: '【状态】平静[/状态] {{user}}走过回廊。代号 RPH-2048 出现三次：RPH-2048、RPH-2048、RPH-2048。 [scene]雨夜[/scene]\n',
        mixed: [
            '<cot>梳理场景：雨夜、旧站台、两名角色。确认语气克制，动作连续。</cot>',
            '## 雨夜重逢',
            '她把伞向你偏了偏，**很轻地**笑了一下。',
            '> “这一次，别再错过末班车。”',
            '- 远处传来钟声',
            '- 站牌在风里轻响',
            '`车次 RPH-17` 已经进站。',
            ''
        ].join('\n'),
        'rp-paragraph': [
            '她缓缓抬起头，窗外的雨正沿着玻璃向下滑落。远处钟楼传来低沉的回声，她没有立刻开口，只把手中的旧信轻轻折好。',
            '',
            '“我以为你不会来了。”她望向门口，语气平静，却仍能听见那一点没有藏好的期待。壁炉里的木柴发出细碎声响。',
            '',
            '你向前走了一步，把沾着雨水的外套挂在椅背上。长久以来准备好的解释忽然显得多余，最后只剩一句很轻的道歉。',
            '',
            '她沉默片刻，终于把另一把椅子拉开。故事没有因此结束，它只是从这个雨夜开始，换了一种更缓慢、也更诚实的写法。',
            ''
        ].join('\n')
    };

    const fitUtf8Bytes = (template, targetBytes) => {
        let value = '';
        while (utf8Bytes(value + template) <= targetBytes) value += template;
        let remaining = targetBytes - utf8Bytes(value);
        if (remaining > 0) {
            const units = Array.from(template);
            for (const unit of units) {
                const size = utf8Bytes(unit);
                if (size > remaining) continue;
                value += unit;
                remaining -= size;
                if (remaining === 0) break;
            }
        }
        if (remaining > 0) value += 'x'.repeat(remaining);
        if (utf8Bytes(value) !== targetBytes) throw new Error(`Fixture byte mismatch: ${utf8Bytes(value)} !== ${targetBytes}`);
        return value;
    };

    const buildFixture = (type, sizeKb) => {
        if (!SCENARIO_TYPES.includes(type)) throw new Error(`Unknown fixture type: ${type}`);
        if (!TARGET_SIZES.includes(sizeKb)) throw new Error(`Unsupported fixture size: ${sizeKb} KB`);
        const content = fitUtf8Bytes(templates[type], sizeKb * 1024);
        return Object.freeze({
            id: `${type}-${sizeKb}kb`,
            type,
            sizeKb,
            content,
            utf8Bytes: utf8Bytes(content),
            codeUnits: content.length,
            codePoints: Array.from(content).length,
            networkChunkCount: NETWORK_CHUNK_COUNT,
            networkChunkIntervalMs: NETWORK_CHUNK_INTERVAL_MS,
            streamFlushIntervalMs: STREAM_FLUSH_INTERVAL_MS,
            streamMaxVisibleLatencyMs: STREAM_MAX_VISIBLE_LATENCY_MS,
            streamMinVisibleGapMs: STREAM_MIN_VISIBLE_GAP_MS
        });
    };

    const splitDeterministically = (text, count) => {
        const units = Array.from(text);
        const chunks = [];
        let offset = 0;
        for (let index = 0; index < count; index++) {
            const remainingUnits = units.length - offset;
            const remainingChunks = count - index;
            const take = Math.ceil(remainingUnits / remainingChunks);
            chunks.push(units.slice(offset, offset + take).join(''));
            offset += take;
        }
        return chunks;
    };

    const createSseResponse = (fixture, onFinalByte) => {
        const chunks = splitDeterministically(fixture.content, fixture.networkChunkCount);
        let index = 0;
        const stream = new ReadableStream({
            start(controller) {
                const publish = () => {
                    if (index >= chunks.length) {
                        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                        onFinalByte?.(now());
                        controller.close();
                        return;
                    }
                    const payload = JSON.stringify({ choices: [{ delta: { content: chunks[index] } }] });
                    controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
                    index += 1;
                    setTimeout(publish, fixture.networkChunkIntervalMs);
                };
                setTimeout(publish, fixture.networkChunkIntervalMs);
            }
        });
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };

    const recordFunction = (name, duration) => {
        if (!active || !Number.isFinite(duration)) return;
        if (!functionSamples.has(name)) functionSamples.set(name, []);
        functionSamples.get(name).push(duration);
    };

    const measure = (name, operation) => {
        if (!active) return operation();
        const started = now();
        try {
            return operation();
        } finally {
            recordFunction(name, now() - started);
        }
    };

    const beginFlush = (delta, reason = 'unknown') => {
        if (!active) return null;
        let remainingBytes = utf8Bytes(delta?.content) + utf8Bytes(delta?.reasoning);
        const arrivalTimes = [];
        while (remainingBytes > 0 && pendingStreamArrivals.length) {
            const arrival = pendingStreamArrivals.shift();
            arrivalTimes.push(arrival.at);
            remainingBytes -= arrival.bytes;
        }
        const token = {
            id: ++flushSequence,
            startedAt: now(),
            callbackEndAt: null,
            domStableAt: null,
            deltaBytes: utf8Bytes(delta?.content) + utf8Bytes(delta?.reasoning),
            reason,
            arrivalTimes
        };
        currentFlush = token;
        runState.flushes.push(token);
        return token;
    };

    const recordStreamDelta = (delta) => {
        if (!active) return;
        const bytes = utf8Bytes(delta?.content) + utf8Bytes(delta?.reasoning);
        if (bytes > 0) pendingStreamArrivals.push({ at: now(), bytes });
    };

    const endFlush = (token) => {
        if (!token) return;
        token.callbackEndAt = now();
        if (performance.memory && runState) {
            runState.heapPeak = Math.max(runState.heapPeak || 0, performance.memory.usedJSHeapSize || 0);
        }
        if (currentFlush === token) currentFlush = null;
    };

    const trackDomStabilization = (promise) => {
        if (!active || !currentFlush || !promise) return;
        const token = currentFlush;
        const tracked = Promise.resolve(promise).then(() => {
            token.domStableAt = now();
        }).finally(() => pendingDom.delete(tracked));
        pendingDom.add(tracked);
    };

    const registerCacheReader = (name, reader) => {
        if (typeof reader === 'function') cacheReaders.set(name, reader);
    };

    const readCaches = () => Object.fromEntries([...cacheReaders].map(([name, reader]) => {
        try {
            return [name, reader()];
        } catch (error) {
            return [name, { error: error.message }];
        }
    }));

    const startLongTaskObserver = () => {
        if (!('PerformanceObserver' in window) || !PerformanceObserver.supportedEntryTypes?.includes('longtask')) return false;
        longTaskObserver = new PerformanceObserver((list) => {
            if (!active) return;
            list.getEntries().forEach((entry) => runState.longTasks.push(entry.duration));
        });
        longTaskObserver.observe({ type: 'longtask', buffered: false });
        return true;
    };

    const startFrameMonitor = () => {
        const intervals = [];
        let previous = null;
        let stopped = false;
        const tick = (timestamp) => {
            if (stopped) return;
            if (previous !== null) intervals.push(timestamp - previous);
            previous = timestamp;
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        frameMonitor = { intervals, stop: () => { stopped = true; } };
    };

    const stopObservers = () => {
        longTaskObserver?.disconnect();
        longTaskObserver = null;
        frameMonitor?.stop();
    };

    const waitForPaint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const replaceArray = (target, values) => target.splice(0, target.length, ...values);

    const makeHistory = (count) => Array.from({ length: count }, (_, index) => ({
        id: `perf-history-${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        name: index % 2 === 0 ? 'Benchmark User' : 'Benchmark Character',
        content: index % 2 === 0 ? `合成用户消息 ${index + 1}` : `合成助手消息 ${index + 1}，用于固定可见聊天环境。`,
        isSelf: index % 2 === 0,
        skipReveal: true,
        shouldAnimate: false
    }));

    const syntheticCharacter = Object.freeze({
        uuid: 'rph-perf-character',
        name: 'Benchmark Character',
        description: 'Synthetic performance fixture only.',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        avatar: ''
    });

    const regexFixture = Object.freeze([
        { name: 'Perf status', regex: '/【状态】([\\s\\S]*?)\\[\\/状态\\]/g', replacement: '<strong>$1</strong>', placement: [2], markdownOnly: true, enabled: true },
        { name: 'Perf scene', regex: '/\\[scene\\]([\\s\\S]*?)\\[\\/scene\\]/g', replacement: '> 场景：$1', placement: [2], markdownOnly: true, enabled: true },
        { name: 'Perf code', regex: '/RPH-(\\d+)/g', replacement: '`RPH-$1`', placement: [2], markdownOnly: true, enabled: true }
    ]);

    const snapshotApp = () => ({
        characters: [...app.characters],
        currentCharacterIndex: app.currentCharacterIndex,
        chatHistory: [...app.chatHistory],
        regexScripts: [...app.regexScripts],
        presets: [...app.presets],
        worldInfo: [...app.worldInfo],
        activeTools: [...app.activeTools],
        currentView: app.currentView,
        userInput: app.userInput,
        settings: {
            stream: app.settings.stream,
            uiTemplateEnabled: app.settings.uiTemplateEnabled,
            uiTemplateMainModelAnalysis: app.settings.uiTemplateMainModelAnalysis,
            autoImageGen: app.settings.autoImageGen,
            apiKey: app.settings.apiKey,
            model: app.settings.model,
            qualityModel: app.settings.qualityModel,
            apiProviderKeys: JSON.parse(JSON.stringify(app.settings.apiProviderKeys || {}))
        },
        memoryEnabled: app.memorySettings.enabled
    });

    const restoreApp = async (snapshot) => {
        replaceArray(app.characters, snapshot.characters);
        app.currentCharacterIndex = snapshot.currentCharacterIndex;
        replaceArray(app.chatHistory, snapshot.chatHistory);
        replaceArray(app.regexScripts, snapshot.regexScripts);
        replaceArray(app.presets, snapshot.presets);
        replaceArray(app.worldInfo, snapshot.worldInfo);
        replaceArray(app.activeTools, snapshot.activeTools);
        Object.assign(app.settings, snapshot.settings);
        app.memorySettings.enabled = snapshot.memoryEnabled;
        app.currentView = snapshot.currentView;
        app.userInput = snapshot.userInput;
        responseFactory = null;
        await waitForPaint();
    };

    const prepareRun = async ({ type, sizeKb, historyCount }) => {
        const fixture = buildFixture(type, sizeKb);
        replaceArray(app.characters, [syntheticCharacter]);
        app.currentCharacterIndex = 0;
        replaceArray(app.chatHistory, makeHistory(Math.max(0, historyCount - 2)));
        replaceArray(app.regexScripts, type === 'regex' ? regexFixture : []);
        replaceArray(app.presets, []);
        replaceArray(app.worldInfo, []);
        replaceArray(app.activeTools, app.activeTools.map(tool => ({ ...tool, enabled: false })));
        app.currentView = 'chat';
        app.settings.stream = true;
        app.settings.uiTemplateEnabled = false;
        app.settings.uiTemplateMainModelAnalysis = false;
        app.settings.autoImageGen = false;
        app.memorySettings.enabled = false;
        app.__perfSetChatRenderLimit(20);
        app.__perfClearCaches();
        await waitForPaint();
        return fixture;
    };

    const finalizeRun = async (fixture, historyCount, startedAt, finalByteAt) => {
        await Promise.all([...pendingDom]);
        await waitForPaint();
        const stableAt = now();
        frameMonitor?.stop();
        longTaskObserver?.disconnect();
        const renderLatencies = runState.flushes
            .filter(flush => flush.domStableAt !== null)
            .map(flush => flush.domStableAt - flush.startedAt);
        const callbackDurations = runState.flushes
            .filter(flush => flush.callbackEndAt !== null)
            .map(flush => flush.callbackEndAt - flush.startedAt);
        const frames = frameMonitor?.intervals || [];
        const displayStaleness = runState.flushes.flatMap(flush => {
            const visibleAt = flush.domStableAt ?? flush.callbackEndAt;
            return Number.isFinite(visibleAt)
                ? flush.arrivalTimes.map(arrivalAt => visibleAt - arrivalAt)
                : [];
        });
        const flushReasons = runState.flushes.reduce((counts, flush) => {
            counts[flush.reason] = (counts[flush.reason] || 0) + 1;
            return counts;
        }, {});
        const functionProfile = Object.fromEntries([...functionSamples].map(([name, samples]) => [name, roundSummary(summarize(samples))]));
        const finalMessage = app.chatHistory[app.chatHistory.length - 1];
        const caches = readCaches();
        const cacheEntryDelta = Object.fromEntries(Object.entries(caches).map(([name, value]) => [
            name,
            Number.isFinite(value?.entries) && Number.isFinite(runState.cacheBefore?.[name]?.entries)
                ? value.entries - runState.cacheBefore[name].entries
                : null
        ]));
        const result = {
            scenario: fixture.id,
            type: fixture.type,
            sizeKb: fixture.sizeKb,
            finalUtf8Bytes: fixture.utf8Bytes,
            finalCodeUnits: fixture.codeUnits,
            historyMessages: historyCount,
            visibleMessageLimit: 20,
            networkChunkCount: fixture.networkChunkCount,
            networkChunkIntervalMs: fixture.networkChunkIntervalMs,
            streamFlushIntervalMs: fixture.streamFlushIntervalMs,
            streamMaxVisibleLatencyMs: streamMaxLatencyOverride || STREAM_MAX_VISIBLE_LATENCY_MS,
            streamMinVisibleGapMs: STREAM_MIN_VISIBLE_GAP_MS,
            flushCount: runState.flushes.length,
            flushReasons,
            displayStalenessMs: roundSummary(summarize(displayStaleness)),
            totalDurationMs: round(stableAt - startedAt),
            flushRenderMs: roundSummary(summarize(renderLatencies)),
            flushCallbackMs: roundSummary(summarize(callbackDurations)),
            finalByteToStableDomMs: round(stableAt - finalByteAt),
            longTaskSupported: runState.longTaskSupported,
            longTasks: roundSummary(summarize(runState.longTasks)),
            raf: {
                samples: frames.length,
                over16_7: frames.filter(value => value > 16.7).length,
                over33_3: frames.filter(value => value > 33.3).length,
                over50: frames.filter(value => value > 50).length,
                over100: frames.filter(value => value > 100).length,
                maxIntervalMs: frames.length ? round(Math.max(...frames)) : null
            },
            functions: functionProfile,
            caches,
            cacheEntryDelta,
            outputMatches: finalMessage?.role === 'assistant' && finalMessage.content === fixture.content,
            memory: performance.memory ? {
                beforeUsedJSHeapSize: runState.heapBefore,
                peakUsedJSHeapSize: runState.heapPeak,
                afterUsedJSHeapSize: performance.memory.usedJSHeapSize,
                totalJSHeapSizeAfter: performance.memory.totalJSHeapSize,
                jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
                gcBehavior: 'not inferred from sampled heap values'
            } : null
        };
        return result;
    };

    const runOnce = async ({ type, sizeKb, historyCount = 20, streamMaxLatencyMs = null }) => {
        if (!app) throw new Error('RP-Hub app has not attached to the benchmark harness');
        if (active) throw new Error('A benchmark run is already active');
        active = true;
        functionSamples.clear();
        pendingDom.clear();
        pendingStreamArrivals.length = 0;
        streamMaxLatencyOverride = Number.isFinite(Number(streamMaxLatencyMs)) ? Number(streamMaxLatencyMs) : null;
        flushSequence = 0;
        runState = { flushes: [], longTasks: [], longTaskSupported: false, startedAt: null, cacheBefore: null, heapBefore: null, heapPeak: null };
        const fixture = await prepareRun({ type, sizeKb, historyCount });
        let finalByteAt = null;
        responseFactory = () => {
            functionSamples.clear();
            runState.flushes = [];
            runState.longTasks = [];
            runState.cacheBefore = readCaches();
            runState.heapBefore = performance.memory?.usedJSHeapSize ?? null;
            runState.heapPeak = runState.heapBefore;
            runState.startedAt = now();
            runState.longTaskSupported = startLongTaskObserver();
            startFrameMonitor();
            return createSseResponse(fixture, timestamp => { finalByteAt = timestamp; });
        };
        app.userInput = 'synthetic benchmark prompt';
        try {
            await app.sendMessage();
            if (finalByteAt === null) finalByteAt = now();
            return await finalizeRun(fixture, historyCount, runState.startedAt, finalByteAt);
        } finally {
            responseFactory = null;
            stopObservers();
            active = false;
            currentFlush = null;
            streamMaxLatencyOverride = null;
            pendingStreamArrivals.length = 0;
        }
    };

    const aggregateRuns = (runs) => {
        const field = (selector) => runs.map(selector).filter(Number.isFinite);
        const sumFunction = (name) => runs.map(run => run.functions[name]?.total || 0);
        const countFunction = (name) => runs.map(run => run.functions[name]?.count || 0);
        const flushReasonNames = [...new Set(runs.flatMap(run => Object.keys(run.flushReasons || {})))];
        return {
            samples: runs.length,
            totalDurationMs: roundSummary(summarize(field(run => run.totalDurationMs))),
            flushCount: roundSummary(summarize(field(run => run.flushCount))),
            flushMedianMs: roundSummary(summarize(field(run => run.flushRenderMs.median))),
            flushP95Ms: roundSummary(summarize(field(run => run.flushRenderMs.p95))),
            flushMaxMs: roundSummary(summarize(field(run => run.flushRenderMs.max))),
            finalByteToStableDomMs: roundSummary(summarize(field(run => run.finalByteToStableDomMs))),
            displayStalenessMedianMs: roundSummary(summarize(field(run => run.displayStalenessMs.median))),
            displayStalenessP95Ms: roundSummary(summarize(field(run => run.displayStalenessMs.p95))),
            displayStalenessMaxMs: roundSummary(summarize(field(run => run.displayStalenessMs.max))),
            longTaskCount: roundSummary(summarize(field(run => run.longTasks.count))),
            longTaskTotalMs: roundSummary(summarize(field(run => run.longTasks.total))),
            rafOver33_3: roundSummary(summarize(field(run => run.raf.over33_3))),
            flushReasons: Object.fromEntries(flushReasonNames.map(reason => [
                reason,
                roundSummary(summarize(field(run => run.flushReasons?.[reason] || 0)))
            ])),
            functionCallCounts: Object.fromEntries(
                ['parseCot', 'processRegex', 'marked.parse', 'DOMPurify.sanitize', 'renderMarkdown', 'messageUsesWideLayout', 'getTimelineSteps', 'appendAssistantText']
                    .map(name => [name, roundSummary(summarize(countFunction(name)))])
            ),
            functionTotalsMs: Object.fromEntries(
                ['parseCot', 'processRegex', 'marked.parse', 'DOMPurify.sanitize', 'renderMarkdown', 'messageUsesWideLayout', 'getTimelineSteps', 'appendAssistantText']
                    .map(name => [name, roundSummary(summarize(sumFunction(name)))])
            ),
            cacheEntries: Object.fromEntries([...cacheReaders.keys()].map(name => [
                name,
                roundSummary(summarize(field(run => run.caches[name]?.entries)))
            ])),
            cacheEntryDelta: Object.fromEntries([...cacheReaders.keys()].map(name => [
                name,
                roundSummary(summarize(field(run => run.cacheEntryDelta?.[name])))
            ])),
            allOutputsMatch: runs.every(run => run.outputMatches)
        };
    };

    const runSuite = async (options = {}) => {
        if (!app) throw new Error('RP-Hub app has not attached to the benchmark harness');
        const recordedRuns = Math.max(1, Number(options.recordedRuns) || 5);
        const warmupRuns = options.warmupRuns === undefined ? 1 : Math.max(0, Number(options.warmupRuns) || 0);
        const historyCounts = options.historyCounts || [20, 100];
        const sizes = options.sizes || TARGET_SIZES;
        const types = options.types || SCENARIO_TYPES;
        const orders = [
            [32, 2, 64, 8],
            [8, 64, 2, 32],
            [64, 32, 8, 2],
            [2, 8, 32, 64],
            [32, 64, 2, 8]
        ];
        const snapshot = snapshotApp();
        const rawRuns = [];
        try {
            for (const historyCount of historyCounts) {
                for (const type of types) {
                    for (let warmup = 0; warmup < warmupRuns; warmup++) {
                        for (const sizeKb of orders[warmup % orders.length].filter(size => sizes.includes(size))) {
                            await runOnce({ type, sizeKb, historyCount, streamMaxLatencyMs: options.streamMaxLatencyMs });
                        }
                    }
                    for (let iteration = 0; iteration < recordedRuns; iteration++) {
                        const order = orders[iteration % orders.length].filter(size => sizes.includes(size));
                        for (const sizeKb of order) {
                            const result = await runOnce({ type, sizeKb, historyCount, streamMaxLatencyMs: options.streamMaxLatencyMs });
                            rawRuns.push({ ...result, iteration: iteration + 1 });
                        }
                    }
                }
            }
        } finally {
            active = true;
            await restoreApp(snapshot);
            active = false;
        }
        const groups = {};
        rawRuns.forEach(run => {
            const key = `${run.type}-${run.sizeKb}kb-${run.historyMessages}msg`;
            if (!groups[key]) groups[key] = [];
            groups[key].push(run);
        });
        return {
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            userAgent: navigator.userAgent,
            commit: options.commit || null,
            fixtureContract: {
                sizesKb: [...sizes],
                types: [...types],
                networkChunkCount: NETWORK_CHUNK_COUNT,
                networkChunkIntervalMs: NETWORK_CHUNK_INTERVAL_MS,
                streamFlushIntervalMs: STREAM_FLUSH_INTERVAL_MS,
                streamMaxVisibleLatencyMs: options.streamMaxLatencyMs || STREAM_MAX_VISIBLE_LATENCY_MS,
                streamMinVisibleGapMs: STREAM_MIN_VISIBLE_GAP_MS,
                warmupRuns,
                recordedRuns,
                orderStrategy: 'interleaved Latin-style fixed orders'
            },
            summaries: Object.fromEntries(Object.entries(groups).map(([key, runs]) => [key, aggregateRuns(runs)])),
            rawRuns
        };
    };

    const measureIdleOverhead = async (durationMs = 2000) => {
        const sampleFrames = async (instrumentationActive) => {
            active = instrumentationActive;
            const intervals = [];
            let previous = null;
            const started = now();
            while (now() - started < durationMs) {
                const timestamp = await new Promise(resolve => requestAnimationFrame(resolve));
                if (previous !== null) intervals.push(timestamp - previous);
                previous = timestamp;
            }
            active = false;
            return roundSummary(summarize(intervals));
        };
        return { off: await sampleFrames(false), onIdle: await sampleFrames(true), metric: 'rAF interval ms' };
    };

    const api = {
        enabled: true,
        get active() { return active; },
        attachApp(instance) { app = instance; },
        beginFlush,
        buildFixture,
        currentFlush: () => currentFlush,
        endFlush,
        measure,
        measureIdleOverhead,
        getStreamMaxLatencyMs: () => streamMaxLatencyOverride,
        recordStreamDelta,
        recordFunction,
        registerCacheReader,
        runOnce,
        runSuite,
        takeSyntheticResponse(options) {
            if (!active || !responseFactory) return null;
            const factory = responseFactory;
            responseFactory = null;
            return factory(options);
        },
        trackDomStabilization
    };
    window.__RPH_PERF__ = api;
})();
