// Keeps executable message cards mounted while pausing CSS animations far from the chat viewport.
(function () {
    const FRAME_SELECTOR = 'iframe.executable-html-frame';
    const OFFSCREEN_CLASS = 'rph-offscreen';
    const SUSPENSION_STYLE_ID = 'rph-offscreen-animation-suspension';
    const PRELOAD_VIEWPORTS = 1.5;
    const SCROLL_IDLE_DELAY = 180;
    const metadata = new WeakMap();
    const registeredFrames = new Set();
    const diagnostics = window.__RPH_PERF__?.enabled === true ? {
        transitions: {},
        suspensions: 0,
        preloadResumes: 0,
        directActiveResumes: 0
    } : null;

    let container = null;
    let activeObserver = null;
    let nearObserver = null;
    let mutationObserver = null;
    let refreshFrame = null;
    let resizeFrame = null;
    let scrolling = false;
    let scrollIdleTimer = null;

    const safeChildDocument = iframe => {
        try {
            return iframe.contentDocument || iframe.contentWindow?.document || null;
        } catch (_) {
            return null;
        }
    };

    const ensureSuspensionStyle = doc => {
        if (!doc?.documentElement || doc.getElementById(SUSPENSION_STYLE_ID)) return;
        const style = doc.createElement('style');
        style.id = SUSPENSION_STYLE_ID;
        style.textContent = `
html.${OFFSCREEN_CLASS} *,
html.${OFFSCREEN_CLASS} *::before,
html.${OFFSCREEN_CLASS} *::after {
    animation-play-state: paused !important;
}`;
        (doc.head || doc.documentElement).appendChild(style);
    };

    const applySuspension = (iframe, suspended) => {
        const meta = metadata.get(iframe);
        if (!meta) return;
        meta.suspended = suspended;
        const doc = safeChildDocument(iframe);
        if (!doc?.documentElement) return;
        ensureSuspensionStyle(doc);
        doc.documentElement.classList.toggle(OFFSCREEN_CLASS, suspended);
    };

    const classify = iframe => {
        if (!container || !iframe?.isConnected) return 'OFFSCREEN';
        const viewport = container.getBoundingClientRect();
        const rect = iframe.getBoundingClientRect();
        const overlapsHorizontally = rect.right > viewport.left && rect.left < viewport.right;
        const active = overlapsHorizontally && rect.bottom > viewport.top && rect.top < viewport.bottom;
        if (active) return 'ACTIVE';
        const preload = Math.max(1, container.clientHeight * PRELOAD_VIEWPORTS);
        const near = overlapsHorizontally
            && rect.bottom > viewport.top - preload
            && rect.top < viewport.bottom + preload;
        return near ? 'NEAR' : 'OFFSCREEN';
    };

    const updateFrame = iframe => {
        const meta = metadata.get(iframe);
        if (!meta) return;
        const state = classify(iframe);
        const previousState = meta.state;
        if (diagnostics && previousState && previousState !== state) {
            const key = `${previousState}->${state}`;
            diagnostics.transitions[key] = (diagnostics.transitions[key] || 0) + 1;
            if (state === 'OFFSCREEN') diagnostics.suspensions++;
            if (previousState === 'OFFSCREEN' && state === 'NEAR') diagnostics.preloadResumes++;
            if (previousState === 'OFFSCREEN' && state === 'ACTIVE') diagnostics.directActiveResumes++;
        }
        meta.state = state;
        applySuspension(iframe, state === 'OFFSCREEN' || scrolling);
    };

    const refreshAll = () => registeredFrames.forEach(updateFrame);

    const scheduleRefresh = () => {
        if (refreshFrame !== null) return;
        refreshFrame = requestAnimationFrame(() => {
            refreshFrame = null;
            refreshAll();
        });
    };

    const setScrolling = active => {
        if (scrolling === active) return;
        scrolling = active;
        scheduleRefresh();
    };

    const handleScroll = () => {
        if (!scrolling) setScrolling(true);
        if (scrollIdleTimer !== null) clearTimeout(scrollIdleTimer);
        scrollIdleTimer = setTimeout(() => {
            scrollIdleTimer = null;
            setScrolling(false);
        }, SCROLL_IDLE_DELAY);
    };

    const unobserveFrame = iframe => {
        const meta = metadata.get(iframe);
        if (!meta) return;
        activeObserver?.unobserve(iframe);
        nearObserver?.unobserve(iframe);
        iframe.removeEventListener('load', meta.handleLoad);
        applySuspension(iframe, false);
        registeredFrames.delete(iframe);
        metadata.delete(iframe);
    };

    const observeFrame = iframe => {
        if (!iframe?.matches?.(FRAME_SELECTOR) || metadata.has(iframe)) return;
        const meta = {
            state: null,
            suspended: false,
            handleLoad: () => updateFrame(iframe)
        };
        metadata.set(iframe, meta);
        registeredFrames.add(iframe);
        iframe.addEventListener('load', meta.handleLoad);
        activeObserver?.observe(iframe);
        nearObserver?.observe(iframe);
        updateFrame(iframe);
    };

    const scanAddedNode = node => {
        if (node?.nodeType !== Node.ELEMENT_NODE) return;
        if (node.matches?.(FRAME_SELECTOR)) observeFrame(node);
        node.querySelectorAll?.(FRAME_SELECTOR).forEach(observeFrame);
    };

    const scanRemovedNode = node => {
        if (node?.nodeType !== Node.ELEMENT_NODE) return;
        if (node.matches?.(FRAME_SELECTOR)) unobserveFrame(node);
        node.querySelectorAll?.(FRAME_SELECTOR).forEach(unobserveFrame);
    };

    const createObservers = () => {
        activeObserver?.disconnect();
        nearObserver?.disconnect();
        activeObserver = null;
        nearObserver = null;
        if (!container || !window.IntersectionObserver) return;
        const onIntersection = () => scheduleRefresh();
        activeObserver = new IntersectionObserver(onIntersection, {
            root: container,
            rootMargin: '0px',
            threshold: 0
        });
        const preload = Math.max(1, Math.round(container.clientHeight * PRELOAD_VIEWPORTS));
        nearObserver = new IntersectionObserver(onIntersection, {
            root: container,
            rootMargin: `${preload}px 0px ${preload}px 0px`,
            threshold: 0
        });
        registeredFrames.forEach(iframe => {
            activeObserver.observe(iframe);
            nearObserver.observe(iframe);
        });
    };

    const handleResize = () => {
        if (resizeFrame !== null) return;
        resizeFrame = requestAnimationFrame(() => {
            resizeFrame = null;
            createObservers();
            refreshAll();
        });
    };

    const handleVisibility = () => {
        if (!document.hidden) scheduleRefresh();
    };

    const detach = () => {
        mutationObserver?.disconnect();
        mutationObserver = null;
        activeObserver?.disconnect();
        activeObserver = null;
        nearObserver?.disconnect();
        nearObserver = null;
        registeredFrames.forEach(unobserveFrame);
        if (refreshFrame !== null) cancelAnimationFrame(refreshFrame);
        if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
        refreshFrame = null;
        resizeFrame = null;
        window.removeEventListener('resize', handleResize);
        window.removeEventListener('pageshow', scheduleRefresh);
        document.removeEventListener('visibilitychange', handleVisibility);
        container?.removeEventListener?.('scroll', handleScroll, true);
        if (scrollIdleTimer !== null) clearTimeout(scrollIdleTimer);
        scrollIdleTimer = null;
        scrolling = false;
        container = null;
    };

    const attach = nextContainer => {
        if (nextContainer === container) {
            scheduleRefresh();
            return;
        }
        detach();
        if (!nextContainer) return;
        container = nextContainer;
        createObservers();
        mutationObserver = new MutationObserver(records => records.forEach(record => {
            record.removedNodes.forEach(scanRemovedNode);
            record.addedNodes.forEach(scanAddedNode);
        }));
        mutationObserver.observe(container, { childList: true, subtree: true });
        container.querySelectorAll(FRAME_SELECTOR).forEach(observeFrame);
        container.addEventListener?.('scroll', handleScroll, { passive: true, capture: true });
        window.addEventListener('resize', handleResize, { passive: true });
        window.addEventListener('pageshow', scheduleRefresh, { passive: true });
        document.addEventListener('visibilitychange', handleVisibility);
        refreshAll();
    };

    const getState = iframe => {
        const meta = metadata.get(iframe);
        return meta ? { state: meta.state, suspended: meta.suspended } : null;
    };

    const resetDiagnostics = () => {
        if (!diagnostics) return;
        diagnostics.transitions = {};
        diagnostics.suspensions = 0;
        diagnostics.preloadResumes = 0;
        diagnostics.directActiveResumes = 0;
    };

    const getDiagnostics = () => diagnostics ? {
        transitions: { ...diagnostics.transitions },
        suspensions: diagnostics.suspensions,
        preloadResumes: diagnostics.preloadResumes,
        directActiveResumes: diagnostics.directActiveResumes,
        registeredFrames: registeredFrames.size
    } : null;

    window.RPHubOffscreenIframeLifecycle = Object.freeze({
        attach,
        detach,
        getDiagnostics,
        getState,
        resetDiagnostics,
        selector: FRAME_SELECTOR,
        preloadViewports: PRELOAD_VIEWPORTS
    });
})();
