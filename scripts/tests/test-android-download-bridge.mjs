import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const LOCAL_ORIGIN = 'https://localhost';
const SQUARE_ORIGIN = 'https://rphforum.zeabur.app';
const script = await readFile(new URL('../../android/app/src/main/assets/rphub-download-bridge.js', import.meta.url), 'utf8');

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
        fetch: async () => ({ ok: true, blob: async () => ({ type: 'application/octet-stream', arrayBuffer: async () => new ArrayBuffer(0) }) })
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
    blob: async () => ({ type: 'image/png', arrayBuffer: async () => new ArrayBuffer(4) })
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
await new Promise(resolve => setImmediate(resolve));
await new Promise(resolve => setTimeout(resolve, 10));

assert.equal(framePosts.length, 1, 'trusted iframe posts one blob message');
assert.equal(framePosts[0].targetOrigin, LOCAL_ORIGIN, 'blob message uses fixed root target origin');
assert.equal(exportCalls.length, 1, 'trusted blob click calls exportFile once');
assert.equal(exportCalls[0].filename, 'card.png');

root.dispatchMessage({
    data: { type: 'rphub-download-blob', filename: 'evil-origin.png', data: { arrayBuffer() {} } },
    origin: 'https://evil.example',
    source: trustedSource
});
root.dispatchMessage({
    data: { type: 'rphub-download-blob', filename: 'evil-source.png', data: { arrayBuffer() {} } },
    origin: SQUARE_ORIGIN,
    source: untrustedSource
});
await new Promise(resolve => setImmediate(resolve));
assert.equal(exportCalls.length, 1, 'untrusted origin/source cannot invoke exportFile');

console.log('Android blob download bridge DOM harness: PASS');
