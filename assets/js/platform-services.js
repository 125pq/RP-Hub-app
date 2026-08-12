(function initializePlatformServices(global) {
    'use strict';

    const getCapacitor = () => global.Capacitor;
    const getPlugin = (name) => getCapacitor()?.Plugins?.[name] || null;
    let appIsActive = true;
    let externalLinkHandlerInstalled = false;

    const isNative = () => {
        const capacitor = getCapacitor();
        if (!capacitor || typeof capacitor.isNativePlatform !== 'function') return false;
        return capacitor.isNativePlatform() === true;
    };

    const getPlatform = () => {
        if (!isNative()) return 'web';
        const platform = getCapacitor()?.getPlatform?.();
        return typeof platform === 'string' && platform ? platform : 'native';
    };

    const parseHttpUrl = (value) => {
        const url = new URL(String(value || ''), global.location?.href);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new TypeError(`Unsupported external URL protocol: ${url.protocol}`);
        }
        return url;
    };

    const openExternalUrl = async (value) => {
        const url = parseHttpUrl(value).href;
        if (isNative()) {
            const browser = getPlugin('Browser');
            if (!browser?.open) return { supported: false, opened: false, url };
            await browser.open({ url });
            return { supported: true, opened: true, url };
        }

        if (typeof global.open !== 'function') return { supported: false, opened: false, url };
        const openedWindow = global.open(url, '_blank', 'noopener,noreferrer');
        if (openedWindow) openedWindow.opener = null;
        return { supported: true, opened: !!openedWindow, url };
    };

    const share = async (options = {}) => {
        const shareOptions = {};
        for (const key of ['title', 'text', 'dialogTitle']) {
            if (options[key] !== undefined && options[key] !== null) {
                shareOptions[key] = String(options[key]);
            }
        }
        if (options.url !== undefined && options.url !== null && options.url !== '') {
            shareOptions.url = parseHttpUrl(options.url).href;
        }

        if (isNative()) {
            const nativeShare = getPlugin('Share');
            if (!nativeShare?.share) return { supported: false };
            if (nativeShare.canShare) {
                const capability = await nativeShare.canShare();
                if (capability?.value === false) return { supported: false };
            }
            const result = await nativeShare.share(shareOptions);
            return { supported: true, result };
        }

        if (typeof global.navigator?.share !== 'function') return { supported: false };
        const result = await global.navigator.share(shareOptions);
        return { supported: true, result };
    };

    const onBackButton = async (handler) => {
        if (typeof handler !== 'function' || !isNative()) return () => {};
        const app = getPlugin('App');
        if (!app?.addListener) return () => {};

        const listener = await app.addListener('backButton', async (event) => {
            let handled = false;
            try {
                handled = await handler(event) === true;
            } catch (error) {
                console.error('Platform back handler failed:', error);
            }
            if (!handled && app.minimizeApp) await app.minimizeApp();
        });
        return () => listener?.remove?.();
    };

    const onAppStateChange = async (handler) => {
        if (typeof handler !== 'function') return () => {};
        if (isNative()) {
            const app = getPlugin('App');
            if (!app?.addListener) return () => {};
            const listener = await app.addListener('appStateChange', (state) => {
                appIsActive = state?.isActive === true;
                handler({ isActive: appIsActive, state: appIsActive ? 'active' : 'background' });
            });
            return () => listener?.remove?.();
        }

        const handleVisibilityChange = () => {
            appIsActive = !global.document?.hidden;
            handler({ isActive: appIsActive, state: appIsActive ? 'active' : 'background' });
        };
        global.document?.addEventListener?.('visibilitychange', handleVisibilityChange);
        return () => global.document?.removeEventListener?.('visibilitychange', handleVisibilityChange);
    };

    const getAppInfo = async () => {
        const platform = getPlatform();
        if (!isNative()) {
            return { platform, name: 'RP Hub', id: null, version: null, build: null };
        }
        const app = getPlugin('App');
        if (!app?.getInfo) {
            return { platform, name: null, id: null, version: null, build: null };
        }
        return { platform, ...await app.getInfo() };
    };

    const handleExternalLinkClick = (event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const anchor = event.target?.closest?.('a[href]');
        if (!anchor || anchor.hasAttribute('download')) return;

        let url;
        try {
            url = parseHttpUrl(anchor.getAttribute('href'));
        } catch {
            return;
        }
        if (url.origin === global.location?.origin) return;

        event.preventDefault();
        openExternalUrl(url.href).catch(error => console.error('Failed to open external URL:', error));
    };

    const installExternalLinkHandler = () => {
        if (externalLinkHandlerInstalled || !isNative() || !global.document?.addEventListener) return;
        externalLinkHandlerInstalled = true;
        global.document.addEventListener('click', handleExternalLinkClick, true);
    };

    global.PlatformServices = Object.freeze({
        isNative,
        getPlatform,
        openExternalUrl,
        share,
        onBackButton,
        onAppStateChange,
        getAppInfo
    });

    if (global.document?.readyState === 'loading') {
        global.document.addEventListener('DOMContentLoaded', installExternalLinkHandler, { once: true });
    } else {
        installExternalLinkHandler();
    }
})(window);
