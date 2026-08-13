(function initializePlatformAdapter(global) {
    'use strict';

    const ADAPTER_MARKER = 'rphub-platform-adapter-v1';

    if (global.platformAdapter?.__rphubAdapterMarker === ADAPTER_MARKER) {
        global.PlatformServices = global.platformAdapter;
        return;
    }

    try {
        const parentAdapter = global.parent !== global ? global.parent?.platformAdapter : null;
        if (parentAdapter?.__rphubAdapterMarker === ADAPTER_MARKER) {
            global.platformAdapter = parentAdapter;
            global.PlatformServices = parentAdapter;
            return;
        }
    } catch {}

    const parseHttpUrl = (value) => {
        const url = new URL(String(value || ''), global.location?.href);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new TypeError(`Unsupported external URL protocol: ${url.protocol}`);
        }
        return url;
    };

    const normalizeFileOptions = (options = {}) => {
        const filename = String(options.filename || '').trim();
        if (!filename) throw new TypeError('A filename is required');
        const mimeType = String(options.mimeType || options.data?.type || 'application/octet-stream')
            .split(';', 1)[0]
            .trim();
        if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mimeType)) {
            throw new TypeError('A valid MIME type is required');
        }
        return { data: options.data ?? '', filename, mimeType };
    };

    const isBlobLike = (value) => value
        && typeof value.arrayBuffer === 'function'
        && typeof value.slice === 'function';

    const toBlob = (data, mimeType = 'application/octet-stream') => (
        isBlobLike(data) ? data : new Blob([data ?? ''], { type: mimeType })
    );

    const bytesToBase64 = (bytes) => {
        let binary = '';
        const blockSize = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += blockSize) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + blockSize));
        }
        return global.btoa(binary);
    };

    const base64ToBytes = (base64) => {
        const binary = global.atob(String(base64 || ''));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return bytes;
    };

    class BrowserAdapter {
        constructor(host = global) {
            this.global = host;
        }

        isNative() {
            return false;
        }

        getPlatform() {
            return 'web';
        }

        async openExternalUrl(value) {
            const url = parseHttpUrl(value).href;
            if (typeof this.global.open !== 'function') return { supported: false, opened: false, url };
            const openedWindow = this.global.open(url, '_blank', 'noopener,noreferrer');
            if (openedWindow) openedWindow.opener = null;
            return { supported: true, opened: !!openedWindow, url };
        }

        async share(options = {}) {
            if (typeof this.global.navigator?.share !== 'function') return { supported: false };
            const result = await this.global.navigator.share(this.normalizeShareOptions(options));
            return { supported: true, result };
        }

        normalizeShareOptions(options = {}) {
            const normalized = {};
            for (const key of ['title', 'text', 'dialogTitle']) {
                if (options[key] !== undefined && options[key] !== null) normalized[key] = String(options[key]);
            }
            if (options.url !== undefined && options.url !== null && options.url !== '') {
                normalized.url = parseHttpUrl(options.url).href;
            }
            return normalized;
        }

        async exportFile(options = {}) {
            const file = normalizeFileOptions(options);
            const blob = toBlob(file.data, file.mimeType);
            const downloadBlob = this.global.RPHubCardUtils?.downloadBlob;
            if (typeof downloadBlob === 'function') {
                downloadBlob(blob, file.filename, { revokeDelay: 1000 });
            } else {
                const url = this.global.URL.createObjectURL(blob);
                const anchor = this.global.document.createElement('a');
                anchor.href = url;
                anchor.download = file.filename;
                anchor.style.display = 'none';
                this.global.document.body.appendChild(anchor);
                anchor.click();
                anchor.remove();
                this.global.setTimeout(() => this.global.URL.revokeObjectURL(url), 1000);
            }
            return { supported: true, cancelled: false, bytesWritten: blob.size };
        }

        saveFile(options = {}) {
            return this.exportFile(options);
        }

        download(options = {}) {
            return this.exportFile(options);
        }

        pickFile(options = {}) {
            return new Promise((resolve) => {
                const input = this.global.document.createElement('input');
                input.type = 'file';
                input.accept = String(options.accept || '');
                input.multiple = options.multiple === true;
                input.style.display = 'none';
                const finish = (files) => {
                    input.remove();
                    resolve({ supported: true, cancelled: files.length === 0, files });
                };
                input.addEventListener('change', () => finish(Array.from(input.files || [])), { once: true });
                input.addEventListener('cancel', () => finish([]), { once: true });
                this.global.document.body.appendChild(input);
                input.click();
            });
        }

        async importFile(options = {}) {
            const picked = await this.pickFile({ ...options, multiple: false });
            if (picked.cancelled || !picked.files[0]) return { ...picked, file: null, data: null };
            const file = picked.files[0];
            return {
                ...picked,
                file,
                data: await this.readFile(file, options.encoding || 'text')
            };
        }

        async readFile(file, encoding = 'text') {
            if (!file) throw new TypeError('A File or Blob is required');
            if (encoding === 'arrayBuffer') return file.arrayBuffer();
            if (encoding === 'base64') return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
            if (encoding === 'dataUrl') {
                const base64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
                return `data:${file.type || 'application/octet-stream'};base64,${base64}`;
            }
            if (encoding !== 'text') throw new TypeError(`Unsupported file encoding: ${encoding}`);
            return file.text();
        }

        blobToBase64(blob) {
            return blob.arrayBuffer().then(buffer => bytesToBase64(new Uint8Array(buffer)));
        }

        base64ToBlob(base64, mimeType = 'application/octet-stream') {
            return new Blob([base64ToBytes(base64)], { type: mimeType });
        }

        get storage() {
            const storage = this.global.localStorage;
            return Object.freeze({
                get: async key => storage?.getItem(String(key)) ?? null,
                set: async (key, value) => storage?.setItem(String(key), String(value)),
                remove: async key => storage?.removeItem(String(key))
            });
        }

        async invokeNative() {
            return { supported: false };
        }

        async onBackButton() {
            return () => {};
        }

        async onAppStateChange(handler) {
            if (typeof handler !== 'function') return () => {};
            const handleVisibilityChange = () => {
                const isActive = !this.global.document?.hidden;
                handler({ isActive, state: isActive ? 'active' : 'background' });
            };
            this.global.document?.addEventListener?.('visibilitychange', handleVisibilityChange);
            return () => this.global.document?.removeEventListener?.('visibilitychange', handleVisibilityChange);
        }

        async getAppInfo() {
            return { platform: 'web', name: 'RP Hub', id: null, version: null, build: null };
        }

        initialize() {}
    }

    let implementation = new BrowserAdapter(global);
    let nativeAdapterInstalled = false;
    const call = (method, ...args) => implementation[method](...args);

    const platformAdapter = Object.freeze({
        __rphubAdapterMarker: ADAPTER_MARKER,
        isNative: () => implementation.isNative(),
        getPlatform: () => implementation.getPlatform(),
        openExternalUrl: value => call('openExternalUrl', value),
        share: options => call('share', options),
        exportFile: options => call('exportFile', options),
        saveFile: options => call('saveFile', options),
        download: options => call('download', options),
        pickFile: options => call('pickFile', options),
        importFile: options => call('importFile', options),
        readFile: (file, encoding) => call('readFile', file, encoding),
        blobToBase64: blob => call('blobToBase64', blob),
        base64ToBlob: (base64, mimeType) => call('base64ToBlob', base64, mimeType),
        invokeNative: (plugin, method, options) => call('invokeNative', plugin, method, options),
        onBackButton: handler => call('onBackButton', handler),
        onAppStateChange: handler => call('onAppStateChange', handler),
        getAppInfo: () => call('getAppInfo'),
        get storage() { return implementation.storage; }
    });

    const installNativeAdapter = (adapter) => {
        if (nativeAdapterInstalled) return false;
        if (!adapter || typeof adapter.isNative !== 'function' || adapter.isNative() !== true) return false;
        implementation = adapter;
        nativeAdapterInstalled = true;
        adapter.initialize?.();
        return true;
    };

    global.RPHubPlatform = Object.freeze({
        BrowserAdapter,
        installNativeAdapter,
        getImplementation: () => implementation,
        normalizeFileOptions,
        parseHttpUrl,
        toBlob,
        bytesToBase64
    });
    global.platformAdapter = platformAdapter;
    global.PlatformServices = platformAdapter;
})(window);
