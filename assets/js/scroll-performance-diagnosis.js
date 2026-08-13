// Benchmark-only long-chat scroll diagnostics. Enabled explicitly with ?rph_perf=1.
(function () {
    const enabled = new URLSearchParams(window.location.search).get('rph_perf') === '1';
    if (!enabled) {
        window.__RPH_SCROLL_PERF__ = Object.freeze({ enabled: false, active: false });
        return;
    }

    const perf = window.__RPH_PERF__;
    let app = null;
    let active = false;
    let iframeActivity = null;

    const round = value => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : value;
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const waitFrames = (count = 2) => new Promise(resolve => {
        const next = () => count-- <= 0 ? resolve() : requestAnimationFrame(next);
        requestAnimationFrame(next);
    });

    const getContainer = () => app?.chatContainer || document.querySelector('[data-rph-chat-container]');
    const getMessageRows = () => [...document.querySelectorAll('[data-chat-index]')];
    const getIframes = () => [...(getContainer()?.querySelectorAll('iframe.executable-html-frame') || [])];
    const isVisibleInContainer = (element) => {
        const container = getContainer();
        if (!container || !element?.isConnected) return false;
        const rect = element.getBoundingClientRect();
        const viewport = container.getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < viewport.bottom && rect.right > viewport.left && rect.left < viewport.right;
    };

    const safeChildDocument = iframe => {
        try {
            return iframe.contentDocument || iframe.contentWindow?.document || null;
        } catch (_) {
            return null;
        }
    };

    const collectIframeRuntime = iframes => {
        const createBucket = () => ({
            iframe: 0,
            animations: 0,
            running: 0,
            paused: 0,
            finished: 0,
            other: 0,
            lifecycle: { ACTIVE: 0, NEAR: 0, OFFSCREEN: 0, unregistered: 0 },
            suspended: 0
        });
        const totals = { visible: createBucket(), offscreen: createBucket(), unreadable: 0 };
        iframes.forEach(iframe => {
            const bucket = isVisibleInContainer(iframe) ? totals.visible : totals.offscreen;
            bucket.iframe++;
            const lifecycle = window.RPHubOffscreenIframeLifecycle?.getState?.(iframe);
            if (lifecycle) {
                bucket.lifecycle[lifecycle.state] = (bucket.lifecycle[lifecycle.state] || 0) + 1;
                if (lifecycle.suspended) bucket.suspended++;
            } else {
                bucket.lifecycle.unregistered++;
            }
            const doc = safeChildDocument(iframe);
            if (!doc) {
                totals.unreadable++;
                return;
            }
            const animations = doc.getAnimations?.({ subtree: true }) || [];
            bucket.animations += animations.length;
            animations.forEach(animation => {
                if (animation.playState === 'running') bucket.running++;
                else if (animation.playState === 'paused') bucket.paused++;
                else if (animation.playState === 'finished') bucket.finished++;
                else bucket.other++;
            });
        });
        return totals;
    };

    const classifyResource = entry => {
        try {
            const url = new URL(entry.name, location.href);
            const extension = url.pathname.split('.').pop()?.toLowerCase() || '';
            const category = /^(png|jpe?g|gif|webp|svg|avif)$/.test(extension) ? 'image'
                : /^(mp3|wav|ogg|m4a|mp4|webm)$/.test(extension) ? 'media'
                    : entry.initiatorType || 'other';
            return { host: url.host || 'local', category };
        } catch (_) {
            return { host: 'unparsed', category: entry.initiatorType || 'other' };
        }
    };

    const resourceSummary = (entries) => {
        const groups = {};
        entries.forEach(entry => {
            const { host, category } = classifyResource(entry);
            const key = `${host}|${category}`;
            if (!groups[key]) groups[key] = { host, category, requests: 0, transferBytes: 0, decodedBytes: 0 };
            groups[key].requests += 1;
            groups[key].transferBytes += Number(entry.transferSize) || 0;
            groups[key].decodedBytes += Number(entry.decodedBodySize) || 0;
        });
        return Object.values(groups);
    };

    const countMedia = (root) => {
        const audio = [...root.querySelectorAll('audio')];
        const video = [...root.querySelectorAll('video')];
        const describe = element => ({
            paused: element.paused,
            ended: element.ended,
            autoplay: element.autoplay,
            muted: element.muted
        });
        return {
            audio: audio.length,
            video: video.length,
            activeAudio: audio.filter(element => !element.paused && !element.ended).length,
            activeVideo: video.filter(element => !element.paused && !element.ended).length,
            states: [...audio, ...video].map(describe)
        };
    };

    const countHeavyCss = (documentNode) => {
        const totals = { animation: 0, transition: 0, transform: 0, willChange: 0, fixed: 0, sticky: 0, shadow: 0, filter: 0, backdropFilter: 0 };
        [...documentNode.querySelectorAll('*')].forEach(element => {
            const style = documentNode.defaultView?.getComputedStyle(element);
            if (!style) return;
            if (style.animationName && style.animationName !== 'none') totals.animation++;
            if (style.transitionDuration && !/^0(?:s|ms)(?:,\s*0(?:s|ms))*$/.test(style.transitionDuration)) totals.transition++;
            if (style.transform && style.transform !== 'none') totals.transform++;
            if (style.willChange && style.willChange !== 'auto') totals.willChange++;
            if (style.position === 'fixed') totals.fixed++;
            if (style.position === 'sticky') totals.sticky++;
            if (style.boxShadow && style.boxShadow !== 'none') totals.shadow++;
            if (style.filter && style.filter !== 'none') totals.filter++;
            if (style.backdropFilter && style.backdropFilter !== 'none') totals.backdropFilter++;
        });
        return totals;
    };

    const snapshot = () => {
        if (!app) throw new Error('RP-Hub app has not attached to scroll diagnostics');
        const container = getContainer();
        const rows = getMessageRows();
        const iframes = getIframes();
        const visibleIframes = iframes.filter(isVisibleInContainer);
        const childDocuments = iframes.map(safeChildDocument).filter(Boolean);
        const iframeRuntime = collectIframeRuntime(iframes);
        const parentMedia = countMedia(document);
        const childMedia = childDocuments.map(countMedia);
        const heavyCss = childDocuments.reduce((total, doc) => {
            const counts = countHeavyCss(doc);
            Object.keys(total).forEach(key => { total[key] += counts[key]; });
            return total;
        }, { animation: 0, transition: 0, transform: 0, willChange: 0, fixed: 0, sticky: 0, shadow: 0, filter: 0, backdropFilter: 0 });
        const contentVisibility = rows.reduce((counts, row) => {
            const value = getComputedStyle(row).contentVisibility || 'visible';
            counts[value] = (counts[value] || 0) + 1;
            return counts;
        }, {});

        return {
            capturedAt: new Date().toISOString(),
            targetCharacterActive: String(app.currentCharacter?.name || '').trim().includes('黎明之契'),
            streamingActive: !!(app.isGenerating || app.isRemoteGenerating || app.isReceiving || app.isThinking),
            history: app.chatHistory?.length ?? null,
            displayed: app.displayedChatMessages?.length ?? null,
            renderLimit: app.__perfGetChatRenderLimit?.() ?? null,
            messageRows: rows.length,
            parentDomNodes: document.querySelectorAll('*').length,
            chatDomNodes: container?.querySelectorAll('*').length ?? null,
            iframe: {
                total: iframes.length,
                visible: visibleIframes.length,
                offscreen: iframes.length - visibleIframes.length,
                readableChildDocuments: childDocuments.length,
                childDomNodes: childDocuments.reduce((sum, doc) => sum + doc.querySelectorAll('*').length, 0),
                runtime: iframeRuntime
            },
            elements: {
                img: document.querySelectorAll('img').length + childDocuments.reduce((sum, doc) => sum + doc.querySelectorAll('img').length, 0),
                audio: parentMedia.audio + childMedia.reduce((sum, media) => sum + media.audio, 0),
                video: parentMedia.video + childMedia.reduce((sum, media) => sum + media.video, 0),
                canvas: document.querySelectorAll('canvas').length + childDocuments.reduce((sum, doc) => sum + doc.querySelectorAll('canvas').length, 0),
                activeAudio: parentMedia.activeAudio + childMedia.reduce((sum, media) => sum + media.activeAudio, 0),
                activeVideo: parentMedia.activeVideo + childMedia.reduce((sum, media) => sum + media.activeVideo, 0),
                mediaStates: [...parentMedia.states, ...childMedia.flatMap(media => media.states)]
            },
            heavyCss,
            contentVisibility,
            scrollRevealObservedTargets: app.__perfGetScrollRevealObservedCount?.() ?? null,
            scroll: container ? {
                top: round(container.scrollTop),
                height: container.clientHeight,
                totalHeight: container.scrollHeight
            } : null,
            memory: performance.memory ? {
                usedJSHeapSize: performance.memory.usedJSHeapSize,
                totalJSHeapSize: performance.memory.totalJSHeapSize,
                jsHeapSizeLimit: performance.memory.jsHeapSizeLimit
            } : null
        };
    };

    const recordIframeActivity = (iframe, type) => {
        if (!active || !iframeActivity || !iframe) return;
        const visibility = isVisibleInContainer(iframe) ? 'visible' : 'offscreen';
        const bucket = iframeActivity[visibility];
        bucket[type] = (bucket[type] || 0) + 1;
    };

    const animateScroll = (container, from, to, durationMs, safety) => new Promise(resolve => {
        const started = performance.now();
        let previous = started;
        let consecutiveHugeGaps = 0;
        const tick = timestamp => {
            const gap = timestamp - previous;
            previous = timestamp;
            consecutiveHugeGaps = gap > 1000 ? consecutiveHugeGaps + 1 : 0;
            if (consecutiveHugeGaps >= 2) {
                safety.stopped = true;
                safety.reason = 'repeated >1000 ms rAF gap';
                resolve();
                return;
            }
            const progress = Math.min(1, (timestamp - started) / durationMs);
            container.scrollTop = from + (to - from) * progress;
            if (progress >= 1 || safety.stopped) resolve();
            else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    });

    const runScroll = async (options = {}) => {
        if (active) throw new Error('A scroll diagnostic is already active');
        const container = getContainer();
        if (!container) throw new Error('Chat container is not available');
        if (app.isGenerating || app.isRemoteGenerating || app.isReceiving || app.isThinking) {
            throw new Error('Streaming must be inactive during scroll diagnosis');
        }
        const durationMs = Math.max(800, Math.min(4000, Number(options.durationMs) || 1800));
        const pauseMs = Math.max(100, Math.min(1000, Number(options.pauseMs) || 400));
        const requestedDistance = Math.max(container.clientHeight, Number(options.distancePx) || container.clientHeight * 3);
        const startTop = container.scrollTop;
        const startScrollHeight = container.scrollHeight;
        const distancePx = Math.min(requestedDistance, startTop);
        const topTarget = startTop - distancePx;
        const safety = { stopped: false, reason: null };
        const resourceStart = performance.now();
        let mutationCallbacks = 0;
        let mutationRecords = 0;
        const mutationObserver = new MutationObserver(records => {
            mutationCallbacks++;
            mutationRecords += records.length;
        });
        mutationObserver.observe(container, { subtree: true, childList: true, attributes: true, characterData: true });
        iframeActivity = { visible: {}, offscreen: {} };
        const lifecycle = window.RPHubOffscreenIframeLifecycle;
        lifecycle?.resetDiagnostics?.();
        const frameContinuity = getIframes().map(iframe => ({
            iframe,
            contentWindow: iframe.contentWindow,
            document: safeChildDocument(iframe),
            height: iframe.getBoundingClientRect().height
        }));
        active = true;
        perf.startDiagnosticSession();
        const startedAt = performance.now();
        try {
            await animateScroll(container, startTop, topTarget, durationMs, safety);
            if (!safety.stopped) await wait(pauseMs);
            if (!safety.stopped) await animateScroll(container, topTarget, startTop, durationMs, safety);
            await waitFrames(2);
        } finally {
            mutationObserver.disconnect();
        }
        const duration = performance.now() - startedAt;
        const performanceMetrics = perf.stopDiagnosticSession();
        active = false;
        const activity = iframeActivity;
        iframeActivity = null;
        const resources = performance.getEntriesByType('resource').filter(entry => entry.startTime >= resourceStart);
        const iframeCounts = snapshot().iframe;
        const continuity = frameContinuity.reduce((totals, before) => {
            if (!before.iframe.isConnected) {
                totals.removed++;
                return totals;
            }
            if (before.iframe.contentWindow === before.contentWindow) totals.sameContentWindow++;
            if (safeChildDocument(before.iframe) === before.document) totals.sameDocument++;
            const heightDelta = Math.abs(before.iframe.getBoundingClientRect().height - before.height);
            totals.maxHeightDelta = Math.max(totals.maxHeightDelta, heightDelta);
            return totals;
        }, { total: frameContinuity.length, sameContentWindow: 0, sameDocument: 0, removed: 0, maxHeightDelta: 0 });
        const withRates = bucket => Object.fromEntries(Object.entries(bucket).map(([key, count]) => [key, {
            count,
            perSecond: round(count / (duration / 1000))
        }]));
        return {
            action: { startTop: round(startTop), topTarget: round(topTarget), distancePx: round(distancePx), durationMs, pauseMs },
            durationMs: round(duration),
            stoppedForSafety: safety.stopped,
            stopReason: safety.reason,
            streamingActive: false,
            ...performanceMetrics,
            domMutationActivity: { callbacks: mutationCallbacks, records: mutationRecords, note: 'DOM mutation proxy; not an exact Vue component update count' },
            iframeCounts,
            lifecycle: lifecycle?.getDiagnostics?.() || null,
            continuity: {
                ...continuity,
                maxHeightDelta: round(continuity.maxHeightDelta),
                scrollTopReturnDelta: round(Math.abs(container.scrollTop - startTop)),
                scrollHeightDelta: round(container.scrollHeight - startScrollHeight)
            },
            iframeActivity: { visible: withRates(activity.visible), offscreen: withRates(activity.offscreen) },
            network: resourceSummary(resources)
        };
    };

    const loadEarlier = async (batchSize = 10) => {
        if (!app?.__perfLoadEarlierChatMessages) throw new Error('Earlier-history perf seam is unavailable');
        await app.__perfLoadEarlierChatMessages(Math.max(1, Math.min(20, Number(batchSize) || 10)));
        await waitFrames(3);
        return snapshot();
    };

    const selectTargetCharacter = async (name) => {
        const normalizedName = String(name || '').trim();
        const index = app?.characters?.findIndex(character => String(character?.name || '').trim().includes(normalizedName)) ?? -1;
        if (index < 0) throw new Error('Target performance-test character was not found');
        await app.selectCharacter(index);
        await waitFrames(4);
        return snapshot();
    };

    const scrollToBottom = async () => {
        const container = getContainer();
        if (!container) throw new Error('Chat container is not available');
        container.scrollTop = container.scrollHeight;
        await waitFrames(3);
        return snapshot();
    };

    const replaceIframesWithPlaceholders = async () => {
        const container = getContainer();
        if (!container) throw new Error('Chat container is not available');
        const beforeTop = container.scrollTop;
        const iframes = getIframes();
        iframes.forEach((iframe, index) => {
            const rect = iframe.getBoundingClientRect();
            const placeholder = document.createElement('div');
            placeholder.className = 'rph-perf-iframe-placeholder';
            placeholder.dataset.rphPerfPlaceholder = String(index);
            placeholder.style.cssText = `display:block;width:100%;height:${Math.max(1, rect.height)}px;min-height:${Math.max(1, rect.height)}px;contain:strict;`;
            iframe.replaceWith(placeholder);
        });
        container.scrollTop = beforeTop;
        await waitFrames(3);
        return { replaced: iframes.length, snapshot: snapshot(), recovery: 'Reload the app; no storage is written.' };
    };

    const api = {
        enabled: true,
        get active() { return active; },
        attachApp(instance) { app = instance; },
        loadEarlier,
        recordIframeActivity,
        replaceIframesWithPlaceholders,
        runScroll,
        scrollToBottom,
        selectTargetCharacter,
        snapshot
    };
    window.__RPH_SCROLL_PERF__ = api;
})();
