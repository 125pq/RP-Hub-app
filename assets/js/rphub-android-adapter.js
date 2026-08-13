(function initializeRPHubAndroidAdapter(global) {
    'use strict';

    if (global.__rphubAndroidAdapterLoaded) return;
    global.__rphubAndroidAdapterLoaded = true;

    const platform = global.RPHubPlatform;
    if (!platform?.BrowserAdapter || !global.platformAdapter) {
        throw new Error('platform-services.js must load before rphub-android-adapter.js');
    }

    const capacitor = global.Capacitor;
    const isAndroid = capacitor?.isNativePlatform?.() === true && capacitor?.getPlatform?.() === 'android';
    if (!isAndroid) return;

    const TEXT_CHUNK_CODE_UNITS = 256 * 1024;
    const BINARY_CHUNK_BYTES = 192 * 1024;

    class AndroidAdapter extends platform.BrowserAdapter {
        constructor(host) {
            super(host);
            this.externalLinkHandlerInstalled = false;
        }

        isNative() {
            return true;
        }

        getPlatform() {
            return 'android';
        }

        getPlugin(name) {
            return this.global.Capacitor?.Plugins?.[name] || null;
        }

        async invokeNative(pluginName, method, options = {}) {
            const plugin = this.getPlugin(pluginName);
            if (typeof plugin?.[method] !== 'function') return { supported: false };
            return { supported: true, result: await plugin[method](options) };
        }

        async openExternalUrl(value) {
            const url = platform.parseHttpUrl(value).href;
            const response = await this.invokeNative('Browser', 'open', { url });
            return { supported: response.supported, opened: response.supported, url };
        }

        async share(options = {}) {
            const plugin = this.getPlugin('Share');
            if (!plugin?.share) return { supported: false };
            if (plugin.canShare && (await plugin.canShare())?.value === false) return { supported: false };
            const result = await plugin.share(this.normalizeShareOptions(options));
            return { supported: true, result };
        }

        async appendTextChunks(plugin, sessionId, text) {
            let chunkIndex = 0;
            let offset = 0;
            while (offset < text.length) {
                let end = Math.min(offset + TEXT_CHUNK_CODE_UNITS, text.length);
                if (end < text.length) {
                    const last = text.charCodeAt(end - 1);
                    const next = text.charCodeAt(end);
                    if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end -= 1;
                }
                await plugin.appendChunk({
                    sessionId,
                    index: chunkIndex,
                    encoding: 'utf8',
                    data: text.slice(offset, end)
                });
                chunkIndex += 1;
                offset = end;
            }
            return chunkIndex;
        }

        async appendBinaryChunks(plugin, sessionId, data, mimeType) {
            const blob = platform.toBlob(data, mimeType);
            let chunkIndex = 0;
            for (let offset = 0; offset < blob.size; offset += BINARY_CHUNK_BYTES) {
                const bytes = new Uint8Array(await blob.slice(offset, offset + BINARY_CHUNK_BYTES).arrayBuffer());
                await plugin.appendChunk({
                    sessionId,
                    index: chunkIndex,
                    encoding: 'base64',
                    data: platform.bytesToBase64(bytes)
                });
                chunkIndex += 1;
            }
            return chunkIndex;
        }

        async exportFile(options = {}) {
            const file = platform.normalizeFileOptions(options);
            const plugin = this.getPlugin('NativeFile');
            if (!plugin?.beginSave || !plugin?.appendChunk || !plugin?.finishSave || !plugin?.cancelSave) {
                return { supported: false, cancelled: false };
            }

            const beginResult = await plugin.beginSave({ filename: file.filename, mimeType: file.mimeType });
            if (beginResult?.cancelled) return { supported: true, cancelled: true };
            const sessionId = beginResult?.sessionId;
            if (!sessionId) throw new Error('Native file save did not create a session');

            try {
                const chunkCount = typeof file.data === 'string'
                    ? await this.appendTextChunks(plugin, sessionId, file.data)
                    : await this.appendBinaryChunks(plugin, sessionId, file.data, file.mimeType);
                return {
                    supported: true,
                    cancelled: false,
                    chunkCount,
                    ...await plugin.finishSave({ sessionId })
                };
            } catch (error) {
                try {
                    await plugin.cancelSave({ sessionId });
                } catch {}
                throw error;
            }
        }

        saveFile(options = {}) {
            return this.exportFile(options);
        }

        download(options = {}) {
            return this.exportFile(options);
        }

        async onBackButton(handler) {
            if (typeof handler !== 'function') return () => {};
            const app = this.getPlugin('App');
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
        }

        async onAppStateChange(handler) {
            if (typeof handler !== 'function') return () => {};
            const app = this.getPlugin('App');
            if (!app?.addListener) return () => {};
            const listener = await app.addListener('appStateChange', (state) => {
                const isActive = state?.isActive === true;
                handler({ isActive, state: isActive ? 'active' : 'background' });
            });
            return () => listener?.remove?.();
        }

        async getAppInfo() {
            const app = this.getPlugin('App');
            if (!app?.getInfo) return { platform: 'android', name: null, id: null, version: null, build: null };
            return { platform: 'android', ...await app.getInfo() };
        }

        handleExternalLinkClick = (event) => {
            if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            const anchor = event.target?.closest?.('a[href]');
            if (!anchor || anchor.hasAttribute('download')) return;
            let url;
            try {
                url = platform.parseHttpUrl(anchor.getAttribute('href'));
            } catch {
                return;
            }
            if (url.origin === this.global.location?.origin) return;
            event.preventDefault();
            this.openExternalUrl(url.href).catch(error => console.error('Failed to open external URL:', error));
        };

        initialize() {
            if (this.externalLinkHandlerInstalled || !this.global.document?.addEventListener) return;
            this.externalLinkHandlerInstalled = true;
            this.global.document.addEventListener('click', this.handleExternalLinkClick, true);
        }
    }

    platform.installNativeAdapter(new AndroidAdapter(global));
})(window);
