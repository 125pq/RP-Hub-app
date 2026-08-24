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
            addEventListener: (type, handler) => listeners.set(type, handler)
        },
        addEventListener: (type, handler) => listeners.set(type, handler),
        console: { error() {} },
        URL,
        Set,
        Array,
        String,
        Promise,
        Error,
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
trustedFrame.fetch = async () => ({
    ok: true,
    blob: async () => makeBlobLike()
});

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
}

trustedFrame.HTMLAnchorElement = Anchor;
vm.runInNewContext(script, trustedFrame, { filename: 'rphub-download-bridge.js:frame' });

const anchor = new trustedFrame.HTMLAnchorElement('blob:https://rphforum.zeabur.app/card', 'card.png');
anchor.click();
await flushTasks();

assert.equal(framePosts.length, 1, 'trusted iframe posts one blob message');
assert.equal(framePosts[0].targetOrigin, LOCAL_ORIGIN, 'blob message uses fixed root target origin');
assert.equal(exportCalls.length, 1, 'trusted blob click calls exportFile once');
assert.equal(exportCalls[0].filename, 'card.png');

trustedFrame.fetch = async () => ({
    ok: true,
    blob: async () => makeBlobLike({ size: MAX_BLOB_BYTES })
});
new trustedFrame.HTMLAnchorElement('blob:https://rphforum.zeabur.app/boundary', 'boundary.png').click();
await flushTasks();
assert.equal(framePosts.length, 2, 'trusted iframe posts a blob at the 64 MiB boundary');
assert.equal(exportCalls.length, 2, 'a blob at the 64 MiB boundary calls exportFile');
assert.equal(exportCalls[1].filename, 'boundary.png');

for (const invalidBlob of [
    makeBlobLike({ size: MAX_BLOB_BYTES + 1 }),
    makeBlobLike({ size: Infinity }),
    { size: 4, type: 'image/png', arrayBuffer: async () => new ArrayBuffer(4) }
]) {
    trustedFrame.fetch = async () => ({ ok: true, blob: async () => invalidBlob });
    new trustedFrame.HTMLAnchorElement('blob:https://rphforum.zeabur.app/invalid', 'invalid.png').click();
    await flushTasks();
}
trustedFrame.fetch = async () => ({ ok: true, blob: async () => makeBlobLike() });
new trustedFrame.HTMLAnchorElement('blob:https://rphforum.zeabur.app/path', '../escape.png').click();
await flushTasks();
assert.equal(framePosts.filter(({ message }) => message.type === 'rphub-download-blob').length, 2, 'sender rejects unsafe blobs and path filenames');
assert.equal(exportCalls.length, 2, 'sender-side rejection cannot invoke exportFile');

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
assert.equal(exportCalls.length, 2, 'untrusted or malformed payloads cannot invoke exportFile');

console.log('Android blob download bridge DOM harness: PASS');
