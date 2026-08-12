(function initializePlatformServices(global) {
    'use strict';

    const getCapacitor = () => global.Capacitor;
    const getPlugin = (name) => getCapacitor()?.Plugins?.[name] || null;
    const TEXT_CHUNK_CODE_UNITS = 256 * 1024;
    const BINARY_CHUNK_BYTES = 192 * 1024;
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

    const normalizeFileOptions = (options = {}) => {
        const filename = String(options.filename || '').trim();
        if (!filename) throw new TypeError('A filename is required');
        const mimeType = String(options.mimeType || options.data?.type || 'application/octet-stream').split(';', 1)[0].trim();
        if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mimeType)) {
            throw new TypeError('A valid MIME type is required');
        }
        return { data: options.data ?? '', filename, mimeType };
    };

    const downloadFileInBrowser = ({ data, filename, mimeType }) => {
        const blob = data && typeof data.arrayBuffer === 'function' && typeof data.slice === 'function'
            ? data
            : new Blob([data], { type: mimeType });
        const downloadBlob = global.RPHubCardUtils?.downloadBlob;
        if (typeof downloadBlob === 'function') {
            downloadBlob(blob, filename, { revokeDelay: 1000 });
            return { supported: true, cancelled: false, bytesWritten: blob.size };
        }

        const url = global.URL.createObjectURL(blob);
        const anchor = global.document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.style.display = 'none';
        global.document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        global.setTimeout(() => global.URL.revokeObjectURL(url), 1000);
        return { supported: true, cancelled: false, bytesWritten: blob.size };
    };

    const bytesToBase64 = (bytes) => {
        let binary = '';
        const blockSize = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += blockSize) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + blockSize));
        }
        return global.btoa(binary);
    };

    const appendTextChunks = async (plugin, sessionId, text) => {
        let chunkIndex = 0;
        let offset = 0;
        while (offset < text.length) {
            let end = Math.min(offset + TEXT_CHUNK_CODE_UNITS, text.length);
            if (end < text.length) {
                const lastCodeUnit = text.charCodeAt(end - 1);
                const nextCodeUnit = text.charCodeAt(end);
                if (lastCodeUnit >= 0xD800 && lastCodeUnit <= 0xDBFF && nextCodeUnit >= 0xDC00 && nextCodeUnit <= 0xDFFF) {
                    end -= 1;
                }
            }
            await plugin.appendChunk({ sessionId, index: chunkIndex, encoding: 'utf8', data: text.slice(offset, end) });
            chunkIndex += 1;
            offset = end;
        }
        return chunkIndex;
    };

    const appendBinaryChunks = async (plugin, sessionId, data, mimeType) => {
        const blob = data && typeof data.arrayBuffer === 'function' && typeof data.slice === 'function'
            ? data
            : new Blob([data], { type: mimeType });
        let chunkIndex = 0;
        for (let offset = 0; offset < blob.size; offset += BINARY_CHUNK_BYTES) {
            const bytes = new Uint8Array(await blob.slice(offset, offset + BINARY_CHUNK_BYTES).arrayBuffer());
            await plugin.appendChunk({ sessionId, index: chunkIndex, encoding: 'base64', data: bytesToBase64(bytes) });
            chunkIndex += 1;
        }
        return chunkIndex;
    };

    const saveFile = async (options = {}) => {
        const file = normalizeFileOptions(options);
        if (!isNative()) return downloadFileInBrowser(file);

        const plugin = getPlugin('NativeFile');
        if (!plugin?.beginSave || !plugin?.appendChunk || !plugin?.finishSave || !plugin?.cancelSave) {
            return { supported: false, cancelled: false };
        }

        const beginResult = await plugin.beginSave({ filename: file.filename, mimeType: file.mimeType });
        if (beginResult?.cancelled) return { supported: true, cancelled: true };
        const sessionId = beginResult?.sessionId;
        if (!sessionId) throw new Error('Native file save did not create a session');

        try {
            const chunkCount = typeof file.data === 'string'
                ? await appendTextChunks(plugin, sessionId, file.data)
                : await appendBinaryChunks(plugin, sessionId, file.data, file.mimeType);
            const result = await plugin.finishSave({ sessionId });
            return { supported: true, cancelled: false, chunkCount, ...result };
        } catch (error) {
            try {
                await plugin.cancelSave({ sessionId });
            } catch {}
            throw error;
        }
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
        saveFile,
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
