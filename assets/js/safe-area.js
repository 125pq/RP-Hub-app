(function () {
    'use strict';

    let probe = null;
    let frame = 0;

    const readInsets = () => {
        if (!probe) {
            probe = document.createElement('div');
            probe.setAttribute('aria-hidden', 'true');
            probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;'
                + 'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) '
                + 'env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
            document.body.appendChild(probe);
        }
        const style = getComputedStyle(probe);
        const pixels = value => Math.max(0, Number.parseFloat(value) || 0);
        return {
            top: pixels(style.paddingTop),
            right: pixels(style.paddingRight),
            bottom: pixels(style.paddingBottom),
            left: pixels(style.paddingLeft)
        };
    };

    const isKeyboardOpen = () => {
        const viewport = window.visualViewport;
        if (!viewport) return false;
        const layoutHeight = window.innerHeight || document.documentElement.clientHeight;
        return viewport.height < layoutHeight - 80;
    };

    const applyToRoot = (root, insets, keyboardOpen) => {
        root.style.setProperty('--safe-top', `${insets.top}px`);
        root.style.setProperty('--safe-right', `${insets.right}px`);
        root.style.setProperty('--safe-bottom', `${insets.bottom}px`);
        root.style.setProperty('--safe-left', `${insets.left}px`);
        root.style.setProperty('--safe-bottom-effective', keyboardOpen ? '0px' : `${insets.bottom}px`);
    };

    const syncFrame = iframe => {
        try {
            const root = iframe?.contentDocument?.documentElement;
            if (root) applyToRoot(root, readInsets(), isKeyboardOpen());
        } catch {
            // Cross-origin frames own their viewport and safe-area handling.
        }
    };

    const sync = () => {
        frame = 0;
        const insets = readInsets();
        const keyboardOpen = isKeyboardOpen();
        document.documentElement.classList.toggle('safe-area-keyboard-open', keyboardOpen);
        document.querySelectorAll('iframe').forEach(iframe => {
            try {
                const root = iframe.contentDocument?.documentElement;
                if (root) applyToRoot(root, insets, keyboardOpen);
            } catch {
                // Cross-origin frames own their viewport and safe-area handling.
            }
        });
    };

    const schedule = () => {
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(sync);
    };

    window.addEventListener('resize', schedule, { passive: true });
    window.addEventListener('orientationchange', schedule, { passive: true });
    window.visualViewport?.addEventListener('resize', schedule, { passive: true });
    window.visualViewport?.addEventListener('scroll', schedule, { passive: true });
    window.RPHubSafeArea = Object.freeze({ sync: schedule, syncFrame });
    schedule();
})();
