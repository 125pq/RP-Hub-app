(function() {
    'use strict';
    if (window.__rphubDownloadBridgeInstalled) return;
    window.__rphubDownloadBridgeInstalled = true;

    const squareOrigins = new Set([
        'https://rphforum.zeabur.app',
        'https://rp.zhaoyangxx.ccwu.cc'
    ]);
    const rootOrigin = 'https://localhost';
    const maxBlobBytes = 64 * 1024 * 1024;
    const maxFilenameLength = 255;
    const maxMimeTypeLength = 127;
    const mimeTypePattern = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
    const isSquareFrame = () => squareOrigins.has(String(window.location.origin || ''));
    const isBlobOrData = href => {
        try {
            const protocol = new URL(String(href || ''), window.location.href).protocol;
            return protocol === 'blob:' || protocol === 'data:';
        } catch {
            return false;
        }
    };
    const isCardFileDownload = href => {
        try {
            const url = new URL(String(href || ''), window.location.href);
            return (url.protocol === 'http:' || url.protocol === 'https:')
                && squareOrigins.has(url.origin)
                && url.origin === window.location.origin
                && !url.search
                && !url.hash
                && /^\/api\/cards\/[^/]+\/download\/file\/?$/.test(url.pathname);
        } catch {
            return false;
        }
    };
    const shouldInterceptDownload = href => isBlobOrData(href) || isCardFileDownload(href);
    const filenameFor = anchor => String(anchor?.getAttribute?.('download') || '').trim() || 'download';
    const normalizeFilename = value => {
        if (typeof value !== 'string') return null;
        const filename = value.trim();
        if (!filename || filename.length > maxFilenameLength || /[\x00-\x1F\x7F/\\]/.test(filename)) return null;
        return filename;
    };
    const normalizeMimeType = value => {
        if (value == null || value === '') value = 'application/octet-stream';
        if (typeof value !== 'string') return null;
        const mimeType = value.split(';', 1)[0].trim();
        if (!mimeType || mimeType.length > maxMimeTypeLength || !mimeTypePattern.test(mimeType)) return null;
        return mimeType;
    };
    const isSafeBlobLike = value => value
        && typeof value.arrayBuffer === 'function'
        && typeof value.slice === 'function'
        && typeof value.size === 'number'
        && Number.isFinite(value.size)
        && value.size >= 0
        && value.size <= maxBlobBytes;
    const directDownloadFallbacks = new WeakSet();
    const postToParent = message => {
        if (window.parent && window.parent !== window) window.parent.postMessage(message, rootOrigin);
    };
    const saveBlobDownload = async (anchor, href, originalAnchorClick) => {
        try {
            const response = await fetch(href, { credentials: 'include' });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const blob = await response.blob();
            if (!isSafeBlobLike(blob)) throw new Error('Blob payload is invalid or too large');
            const filename = normalizeFilename(filenameFor(anchor));
            const mimeType = normalizeMimeType(blob.type);
            if (!filename || !mimeType) throw new Error('Download metadata is invalid');
            postToParent({
                type: 'rphub-download-blob',
                filename,
                mimeType,
                data: blob
            });
        } catch (error) {
            console.error('[RPHubDownload] blob/data download failed', error);
            postToParent({
                type: 'rphub-download-error',
                filename: filenameFor(anchor),
                error: String(error?.message || error)
            });
            if (isCardFileDownload(href) && typeof originalAnchorClick === 'function') {
                directDownloadFallbacks.add(anchor);
                void Promise.resolve().then(() => originalAnchorClick.call(anchor)).finally(() => {
                    setTimeout(() => directDownloadFallbacks.delete(anchor), 0);
                });
            }
        }
    };

    if (isSquareFrame()) {
        const interceptBlobClick = event => {
            const anchor = event.target?.closest?.('a[download]');
            const href = anchor?.href || anchor?.getAttribute?.('href');
            if (anchor && directDownloadFallbacks.has(anchor)) {
                directDownloadFallbacks.delete(anchor);
                return;
            }
            if (!anchor || !shouldInterceptDownload(href)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            void saveBlobDownload(anchor, href, originalAnchorClick);
        };
        document.addEventListener('click', interceptBlobClick, true);
        const originalAnchorClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function() {
            const href = this.href || this.getAttribute('href');
            if (directDownloadFallbacks.has(this)) {
                return originalAnchorClick.apply(this, arguments);
            }
            if (this.hasAttribute('download') && shouldInterceptDownload(href)) {
                void saveBlobDownload(this, href, originalAnchorClick);
                return;
            }
            return originalAnchorClick.apply(this, arguments);
        };
    }

    const isTrustedSquareFrameSource = source => {
        if (!source || !document?.querySelectorAll) return false;
        return Array.from(document.querySelectorAll('iframe')).some(frame => {
            if (frame.contentWindow !== source) return false;
            try {
                const frameUrl = new URL(frame.getAttribute('src') || frame.src || '', window.location.href);
                return squareOrigins.has(frameUrl.origin);
            } catch {
                return false;
            }
        });
    };

    if (window === window.top) {
        window.addEventListener('message', event => {
            const payload = event.data;
            if (
                !payload
                || payload.type !== 'rphub-download-blob'
                || !squareOrigins.has(event.origin)
                || !isTrustedSquareFrameSource(event.source)
            ) return;
            const data = payload.data;
            const filename = normalizeFilename(payload.filename);
            const mimeType = normalizeMimeType(payload.mimeType || data?.type);
            if (!isSafeBlobLike(data) || !filename || !mimeType) {
                console.error('[RPHubDownload] blob payload or metadata is invalid');
                return;
            }
            Promise.resolve().then(async () => {
                const adapter = window.platformAdapter;
                if (!adapter?.exportFile) throw new Error('Native file export is unavailable');
                const result = await adapter.exportFile({
                    data,
                    filename,
                    mimeType
                });
                if (result?.supported === false) throw new Error('Native file export is unsupported');
            }).catch(error => console.error('[RPHubDownload] native save failed', error));
        });
    }
})();
