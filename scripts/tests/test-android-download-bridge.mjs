import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const LOCAL_ORIGIN = 'https://localhost';
const SQUARE_ORIGIN = 'https://rphforum.zeabur.app';
const MAX_BLOB_BYTES = 64 * 1024 * 1024;
const script = await readFile(new URL('../../android/app/src/main/assets/rphub-download-bridge.js', import.meta.url), 'utf8');
const makeBlobLike = ({ size = 4, type = 'image/png' } = {}) => ({
    size,
    type,
    arrayBuffer: async () => new ArrayBuffer(Math.min(Number.isFinite(size) ? size : 0, 4)),
    slice() { return this; }
});
const flushTasks = async () => {
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setTimeout(resolve, 10));
};

const makeWindow = (origin) => {
    const listeners = new Map();
    const window = {
        window: null,
        parent: null,
        top: null,
        location: { origin, href: `${origin}/` },
        document: {
            querySelectorAll: () => [],
            addEventListener: (type, handler) => listeners.set(type, handler),
            dispatchEvent: event => listeners.get(event.type)?.(event)
        },
        addEventListener: (type, handler) => listeners.set(type, handler),
        console: { error() {} },
        URL,
        Set,
        Array,
        String,
        Promise,
        Error,
        setTimeout,
        fetch: async () => ({ ok: true, blob: async () => makeBlobLike({ size: 0, type: 'application/octet-stream' }) })
    };
    window.window = window;
    window.parent = window;
    window.top = window;
    window.dispatchMessage = (event) => listeners.get('message')?.(event);
    return window;
};

const root = makeWindow(LOCAL_ORIGIN);
const trustedFrame = makeWindow(SQUARE_ORIGIN);
const untrustedFrame = makeWindow(SQUARE_ORIGIN);
const trustedSource = 'trusted-frame-source';
const untrustedSource = 'untrusted-frame-source';
const framePosts = [];
const exportCalls = [];
const originalClicks = [];

root.platformAdapter = {
    exportFile: async options => {
        exportCalls.push(options);
        return { supported: true };
    }
};
root.document.querySelectorAll = () => [{
    contentWindow: trustedSource,
    src: `${SQUARE_ORIGIN}/`,
    getAttribute: name => name === 'src' ? `${SQUARE_ORIGIN}/` : null
}];
trustedFrame.parent = {
    postMessage: (message, targetOrigin) => {
        framePosts.push({ message, targetOrigin });
        if (targetOrigin === LOCAL_ORIGIN) {
            root.dispatchMessage({ data: message, origin: SQUARE_ORIGIN, source: trustedSource });
        }
    }
};
trustedFrame.top = root;
trustedFrame.fetch = async (href, options) => {
    trustedFrame.fetch.lastHref = href;
    trustedFrame.fetch.lastOptions = options;
    return {
        ok: true,
        blob: async () => makeBlobLike()
    };
};

vm.runInNewContext(script, root, { filename: 'rphub-download-bridge.js:root' });

class Anchor {
    constructor(href, filename) {
        this.href = href;
        this.attributes = { download: filename };
    }

    getAttribute(name) {
        return this.attributes[name] || null;
    }

    hasAttribute(name) {
        return Object.hasOwn(this.attributes, name);
    }

    closest(selector) {
        return selector === 'a[download]' && this.hasAttribute('download') ? this : null;
    }
}

Anchor.prototype.click = function() {
    originalClicks.push(this.href);
};

trustedFrame.HTMLAnchorElement = Anchor;
vm.runInNewContext(script, trustedFrame, { filename: 'rphub-download-bridge.js:frame' });

const directCardUrl = `${SQUARE_ORIGIN}/api/cards/42/download/file`;
const captureCardAnchor = new trustedFrame.HTMLAnchorElement(directCardUrl, 'card-capture.png');
let capturePrevented = false;
trustedFrame.document.dispatchEvent({
    type: 'click',
    target: captureCardAnchor,
    preventDefault: () => { capturePrevented = true; },
    stopImmediatePropagation: () => {}
});
await flushTasks();
assert.equal(capturePrevented, true, 'capture click prevents a matching direct card navigation');
assert.equal(framePosts.length, 1, 'capture click posts one blob message');
assert.equal(exportCalls.length, 1, 'capture click calls exportFile once');
assert.equal(exportCalls[0].filename, 'card-capture.png');

const directCardAnchor = new trustedFrame.HTMLAnchorElement(directCardUrl, 'card-direct.png');
directCardAnchor.click();
await flushTasks();
assert.equal(framePosts.length, 2, 'same-origin direct card download posts one blob message');
assert.equal(exportCalls.length, 2, 'same-origin direct card download calls exportFile once');
assert.equal(exportCalls[1].filename, 'card-direct.png');

assert.equal(trustedFrame.fetch.lastHref, directCardUrl, 'direct card URL is fetched unchanged');
assert.equal(trustedFrame.fetch.lastOptions?.credentials, 'include', 'direct card fetch includes credentials');

const directFetch = trustedFrame.fetch;
trustedFrame.fetch = async (href, options) => {
    trustedFrame.fetch.lastHref = href;
    trustedFrame.fetch.lastOptions = options;
    return directFetch(href, options);
};
const trailingSlashAnchor = new trustedFrame.HTMLAnchorElement(`${directCardUrl}/`, 'card-trailing.png');
trailingSlashAnchor.click();
await flushTasks();
assert.equal(framePosts.length, 3, 'trailing-slash direct card download posts one blob message');
assert.equal(exportCalls.length, 3, 'trailing-slash direct card download calls exportFile once');
assert.equal(exportCalls[2].filename, 'card-trailing.png');
assert.equal(trustedFrame.fetch.lastHref, `${directCardUrl}/`, 'trailing-slash URL is fetched unchanged');
assert.equal(trustedFrame.fetch.lastOptions?.credentials, 'include', 'trailing-slash fetch includes credentials');

for (const href of [
    'https://example.test/api/cards/42/download/file',
    `${SQUARE_ORIGIN}/api/cards/42/download/other`,
    `${SQUARE_ORIGIN}/api/cards/42/download/file/extra`,
    `${SQUARE_ORIGIN}/api/cards/42/download/file?x=1`
]) {
    new trustedFrame.HTMLAnchorElement(href, 'untouched.png').click();
}
const noDownloadAnchor = new trustedFrame.HTMLAnchorElement(directCardUrl, 'no-download.png');
noDownloadAnchor.attributes = {};
noDownloadAnchor.click();
await flushTasks();
assert.equal(framePosts.length, 3, 'external, invalid-path, query, and non-download links are not bridged');
assert.equal(exportCalls.length, 3, 'unbridgeable direct links do not call exportFile');
assert.equal(originalClicks.length, 5, 'unbridgeable direct links use the original click');

trustedFrame.fetch = async () => { throw new Error('network down'); };
const rejectedCardAnchor = new trustedFrame.HTMLAnchorElement(directCardUrl, 'card-rejected.png');
rejectedCardAnchor.click();
await flushTasks();
assert.equal(exportCalls.length, 3, 'network rejection does not call exportFile');
assert.equal(originalClicks.filter(href => href === directCardUrl).length, 2, 'network rejection falls back to original click once');
rejectedCardAnchor.click();
await flushTasks();
assert.equal(originalClicks.filter(href => href === directCardUrl).length, 3, 'a later user retry gets one independent fallback');

trustedFrame.fetch = async () => ({ ok: false, status: 403, blob: async () => makeBlobLike() });
const failedStatusAnchor = new trustedFrame.HTMLAnchorElement(directCardUrl, 'card-403.png');
failedStatusAnchor.click();
await flushTasks();
assert.equal(exportCalls.length, 3, 'non-2xx response does not call exportFile');
assert.equal(originalClicks.filter(href => href === directCardUrl).length, 4, 'non-2xx response falls back once');

trustedFrame.fetch = async () => ({ ok: true, blob: async () => makeBlobLike({ size: MAX_BLOB_BYTES + 1 }) });
const oversizedCardAnchor = new trustedFrame.HTMLAnchorElement(directCardUrl, 'card-oversized.png');
oversizedCardAnchor.click();
await flushTasks();
assert.equal(exportCalls.length, 3, 'oversized direct card blob does not call exportFile');
assert.equal(originalClicks.filter(href => href === directCardUrl).length, 5, 'oversized direct card blob falls back once');

trustedFrame.fetch = async () => ({ ok: true, blob: async () => makeBlobLike() });
const anchor = new trustedFrame.HTMLAnchorElement('blob:https://rphforum.zeabur.app/card', 'card.png');
anchor.click();
await flushTasks();

const blobMessages = framePosts.filter(({ message }) => message.type === 'rphub-download-blob');
assert.equal(blobMessages.length, 4, 'trusted iframe posts one blob message');
assert.equal(blobMessages.at(-1).targetOrigin, LOCAL_ORIGIN, 'blob message uses fixed root target origin');
assert.equal(exportCalls.length, 4, 'trusted blob click calls exportFile once');
assert.equal(exportCalls[3].filename, 'card.png');

trustedFrame.fetch = async () => ({
    ok: true,
    blob: async () => makeBlobLike({ size: MAX_BLOB_BYTES })
});
new trustedFrame.HTMLAnchorElement('blob:https://rphforum.zeabur.app/boundary', 'boundary.png').click();
await flushTasks();
assert.equal(framePosts.filter(({ message }) => message.type === 'rphub-download-blob').length, 5, 'trusted iframe posts a blob at the 64 MiB boundary');
assert.equal(exportCalls.length, 5, 'a blob at the 64 MiB boundary calls exportFile');
assert.equal(exportCalls[4].filename, 'boundary.png');

for (const invalidBlob of [
    makeBlobLike({ size: MAX_BLOB_BYTES + 1 }),
    makeBlobLike({ size: Infinity }),
    { size: 4, type: 'image/png', arrayBuffer: async () => new ArrayBuffer(4) }
]) {
    trustedFrame.fetch = async () => ({ ok: true, blob: async () => invalidBlob });
    new trustedFrame.HTMLAnchorElement('blob:https://rphforum.zeabur.app/invalid', 'invalid.png').click();
    await flushTasks();
}
trustedFrame.fetch = async () => { throw new Error('blob network down'); };
const originalClicksBeforeBlobFailure = originalClicks.length;
new trustedFrame.HTMLAnchorElement('blob:https://rphforum.zeabur.app/rejected', 'rejected.png').click();
await flushTasks();
assert.equal(originalClicks.length, originalClicksBeforeBlobFailure, 'blob fetch failure does not navigate through the original click');
trustedFrame.fetch = async () => ({ ok: true, blob: async () => makeBlobLike() });
new trustedFrame.HTMLAnchorElement('blob:https://rphforum.zeabur.app/path', '../escape.png').click();
await flushTasks();
assert.equal(framePosts.filter(({ message }) => message.type === 'rphub-download-blob').length, 5, 'sender rejects unsafe blobs and path filenames');
assert.equal(exportCalls.length, 5, 'sender-side rejection cannot invoke exportFile');

root.dispatchMessage({
    data: { type: 'rphub-download-blob', filename: 'evil-origin.png', mimeType: 'image/png', data: makeBlobLike() },
    origin: 'https://evil.example',
    source: trustedSource
});
root.dispatchMessage({
    data: { type: 'rphub-download-blob', filename: 'evil-source.png', mimeType: 'image/png', data: makeBlobLike() },
    origin: SQUARE_ORIGIN,
    source: untrustedSource
});
const invalidTrustedPayloads = [
    { filename: 'oversize.png', mimeType: 'image/png', data: makeBlobLike({ size: MAX_BLOB_BYTES + 1 }) },
    { filename: 'infinite.png', mimeType: 'image/png', data: makeBlobLike({ size: Infinity }) },
    { filename: 'not-blob.png', mimeType: 'image/png', data: { size: 4, arrayBuffer() {} } },
    { filename: 'missing-data.png', mimeType: 'image/png', data: null },
    { filename: 'x'.repeat(256), mimeType: 'image/png', data: makeBlobLike() },
    { filename: '../escape.png', mimeType: 'image/png', data: makeBlobLike() },
    { filename: 'folder\\escape.png', mimeType: 'image/png', data: makeBlobLike() },
    { filename: 123, mimeType: 'image/png', data: makeBlobLike() },
    { filename: 'bad-mime.png', mimeType: `application/${'x'.repeat(116)}`, data: makeBlobLike() },
    { filename: 'invalid-mime.png', mimeType: 'not-a-mime', data: makeBlobLike() },
    { filename: 'non-string-mime.png', mimeType: 123, data: makeBlobLike() }
];
for (const payload of invalidTrustedPayloads) {
    root.dispatchMessage({
        data: { type: 'rphub-download-blob', ...payload },
        origin: SQUARE_ORIGIN,
        source: trustedSource
    });
}
await flushTasks();
assert.equal(exportCalls.length, 5, 'untrusted or malformed payloads cannot invoke exportFile');

console.log('Android blob download bridge DOM harness: PASS');
