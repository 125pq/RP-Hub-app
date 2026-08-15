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
            this.securePasteInstalled = false;
            this.securePasteObserver = null;
            this.securePasteMenu = null;
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

        async appendTextChunks(plugin, sessionId, text, startIndex = 0) {
            let chunkIndex = startIndex;
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

        async appendTextStream(plugin, sessionId, stream) {
            let chunkIndex = 0;
            let buffer = '';
            for await (const piece of stream) {
                buffer += String(piece ?? '');
                while (buffer.length >= TEXT_CHUNK_CODE_UNITS) {
                    let end = TEXT_CHUNK_CODE_UNITS;
                    const last = buffer.charCodeAt(end - 1);
                    const next = buffer.charCodeAt(end);
                    if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end -= 1;
                    await plugin.appendChunk({
                        sessionId,
                        index: chunkIndex,
                        encoding: 'utf8',
                        data: buffer.slice(0, end)
                    });
                    chunkIndex += 1;
                    buffer = buffer.slice(end);
                }
            }
            if (buffer.length > 0) {
                await plugin.appendChunk({
                    sessionId,
                    index: chunkIndex,
                    encoding: 'utf8',
                    data: buffer
                });
                chunkIndex += 1;
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
                let chunkCount;
                if (file.data && typeof file.data[Symbol.asyncIterator] === 'function') {
                    chunkCount = await this.appendTextStream(plugin, sessionId, file.data);
                } else if (typeof file.data === 'string') {
                    chunkCount = await this.appendTextChunks(plugin, sessionId, file.data);
                } else {
                    chunkCount = await this.appendBinaryChunks(plugin, sessionId, file.data, file.mimeType);
                }
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

        closeSecurePasteMenu() {
            this.securePasteMenu?.remove?.();
            this.securePasteMenu = null;
        }

        showSecurePasteMenu(input, clientX, clientY) {
            this.closeSecurePasteMenu();
            const menu = this.global.document.createElement('button');
            menu.type = 'button';
            menu.className = 'rphub-native-paste-menu';
            menu.textContent = '粘贴';
            menu.setAttribute('aria-label', '从系统剪贴板粘贴');
            menu.style.left = `${Math.max(8, Math.min(clientX - 28, this.global.innerWidth - 72))}px`;
            menu.style.top = `${Math.max(8, clientY - 52)}px`;
            menu.addEventListener('pointerdown', event => {
                event.preventDefault();
                event.stopPropagation();
            });
            menu.addEventListener('click', async event => {
                event.preventDefault();
                event.stopPropagation();
                try {
                    const response = await this.invokeNative('NativeClipboard', 'readText');
                    const value = response?.result?.value ?? '';
                    if (response.supported && value) {
                        input.value = String(value);
                        input.dispatchEvent(new this.global.Event('input', { bubbles: true }));
                        input.dispatchEvent(new this.global.Event('change', { bubbles: true }));
                        this.global.navigator?.vibrate?.(30);
                    }
                } catch (error) {
                    console.error('Failed to paste into secure input:', error);
                } finally {
                    this.closeSecurePasteMenu();
                }
            });
            this.global.document.body.appendChild(menu);
            this.securePasteMenu = menu;
        }

        decorateSecurePasteInput(input) {
            if (!input || input.dataset.rphubNativePaste === 'true') return;
            input.dataset.rphubNativePaste = 'true';
            let timer = null;
            let startX = 0;
            let startY = 0;
            const cancelTimer = () => {
                if (timer !== null) this.global.clearTimeout(timer);
                timer = null;
            };
            input.addEventListener('pointerdown', event => {
                cancelTimer();
                this.closeSecurePasteMenu();
                startX = event.clientX;
                startY = event.clientY;
                timer = this.global.setTimeout(() => {
                    timer = null;
                    this.showSecurePasteMenu(input, startX, startY);
                }, 550);
            });
            input.addEventListener('pointermove', event => {
                if (Math.abs(event.clientX - startX) > 12 || Math.abs(event.clientY - startY) > 12) cancelTimer();
            });
            input.addEventListener('pointerup', cancelTimer);
            input.addEventListener('pointercancel', cancelTimer);
            input.addEventListener('blur', cancelTimer);
            input.addEventListener('contextmenu', event => {
                event.preventDefault();
                cancelTimer();
                this.showSecurePasteMenu(input, event.clientX || startX, event.clientY || startY);
            });
        }

        decorateSecurePasteInputs(root) {
            if (root?.matches?.('input[type="password"]')) this.decorateSecurePasteInput(root);
            root?.querySelectorAll?.('input[type="password"]').forEach(input => this.decorateSecurePasteInput(input));
        }

        installSecurePasteSupport() {
            if (this.securePasteInstalled || !this.global.document?.documentElement) return;
            this.securePasteInstalled = true;
            const style = this.global.document.createElement('style');
            style.id = 'rphub-android-secure-paste-style';
            style.textContent = `
                .rphub-native-paste-menu {
                    position: fixed; z-index: 2147483647; min-width: 3.5rem; min-height: 2.25rem;
                    padding: 0.45rem 0.75rem; border: 0; border-radius: 0.5rem;
                    background: #263238; color: #fff; box-shadow: 0 3px 10px rgba(0, 0, 0, 0.3);
                    font-size: 0.875rem; font-weight: 500; line-height: 1;
                }
            `;
            this.global.document.head?.appendChild(style);
            this.decorateSecurePasteInputs(this.global.document);
            this.global.document.addEventListener('pointerdown', event => {
                if (!event.target?.closest?.('.rphub-native-paste-menu')) this.closeSecurePasteMenu();
            }, true);
            if (typeof this.global.MutationObserver === 'function') {
                this.securePasteObserver = new this.global.MutationObserver(records => {
                    for (const record of records) {
                        record.addedNodes.forEach(node => {
                            if (node.nodeType === 1) this.decorateSecurePasteInputs(node);
                        });
                    }
                });
                this.securePasteObserver.observe(this.global.document.documentElement, { childList: true, subtree: true });
            }
        }

        initialize() {
            if (!this.global.document?.addEventListener) return;
            if (!this.externalLinkHandlerInstalled) {
                this.externalLinkHandlerInstalled = true;
                this.global.document.addEventListener('click', this.handleExternalLinkClick, true);
            }
            this.installSecurePasteSupport();
        }
    }

    platform.installNativeAdapter(new AndroidAdapter(global));
})(window);
