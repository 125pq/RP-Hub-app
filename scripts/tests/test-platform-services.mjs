import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const platformSource = await readFile(new URL('../../assets/js/platform-services.js', import.meta.url), 'utf8');
const androidSource = await readFile(new URL('../../assets/js/rphub-android-adapter.js', import.meta.url), 'utf8');
const toPlainObject = value => JSON.parse(JSON.stringify(value));

assert.doesNotMatch(platformSource, /\bCapacitor\b|NativeFile/, 'generic platform facade must not contain Android bridge details');
assert.match(androidSource, /\bCapacitor\b/);
assert.match(androidSource, /NativeFile/);

function createDocument(readyState = 'complete') {
  const listeners = new Map();
  return {
    hidden: false,
    readyState,
    addEventListener(name, handler) {
      listeners.set(name, handler);
    },
    removeEventListener(name, handler) {
      if (listeners.get(name) === handler) listeners.delete(name);
    },
    listeners,
  };
}

function loadPlatformServices(overrides = {}) {
  const document = overrides.document || createDocument();
  const window = {
    Blob,
    Uint8Array,
    atob,
    btoa,
    console,
    document,
    location: new URL('https://app.example/index.html'),
    navigator: {},
    open: () => ({ opener: {} }),
    setTimeout,
    ...overrides,
  };
  const context = vm.createContext({ Blob, URL, Uint8Array, window });
  vm.runInContext(platformSource, context, { filename: 'platform-services.js' });
  vm.runInContext(androidSource, context, { filename: 'rphub-android-adapter.js' });
  return { document, services: window.platformAdapter, window, context };
}

{
  const opened = [];
  const { document, services, window } = loadPlatformServices({
    open: (...args) => {
      opened.push(args);
      return { opener: {} };
    },
  });

  assert.equal(services.isNative(), false);
  assert.equal(services.getPlatform(), 'web');
  assert.equal(services, window.PlatformServices, 'legacy PlatformServices alias must share the singleton');
  assert.equal((await services.share({ text: 'test' })).supported, false);
  const downloads = [];
  window.RPHubCardUtils = { downloadBlob: (blob, filename) => downloads.push({ blob, filename }) };
  const webSave = await services.exportFile({ filename: '测试.json', mimeType: 'application/json', data: '{"ok":true}' });
  assert.equal(webSave.cancelled, false);
  assert.equal(downloads[0].filename, '测试.json');
  assert.equal(await downloads[0].blob.text(), '{"ok":true}');
  assert.equal((await services.openExternalUrl('https://example.com/path')).opened, true);
  assert.deepEqual(opened[0], ['https://example.com/path', '_blank', 'noopener,noreferrer']);
  assert.equal(document.listeners.has('click'), false, 'web must keep its existing link behavior');

  const info = await services.getAppInfo();
  assert.equal(info.platform, 'web');
  assert.equal(info.version, null);

  const states = [];
  const removeState = await services.onAppStateChange(state => states.push(state));
  document.hidden = true;
  document.listeners.get('visibilitychange')();
  assert.deepEqual(toPlainObject(states), [{ isActive: false, state: 'background' }]);
  removeState();
  assert.equal(typeof await services.onBackButton(() => true), 'function');
  assert.equal(typeof services.pickFile, 'function');
  assert.equal(typeof services.importFile, 'function');
  assert.equal(await services.readFile(new Blob(['imported']), 'text'), 'imported');

  const encoded = await services.blobToBase64(new Blob(['adapter'], { type: 'text/plain' }));
  assert.equal(await services.base64ToBlob(encoded, 'text/plain').text(), 'adapter');

  window.navigator.share = async options => options;
  const shareResult = await services.share({ title: 'RP Hub', text: 'test' });
  assert.equal(shareResult.supported, true);
  assert.deepEqual(toPlainObject(shareResult.result), { title: 'RP Hub', text: 'test' });
  await assert.rejects(() => services.openExternalUrl('javascript:alert(1)'), /Unsupported external URL protocol/);
}

{
  const calls = { browser: [], share: [], minimize: 0, removed: [], file: [], cancelled: [] };
  const listeners = new Map();
  const plugins = {
    App: {
      async addListener(name, handler) {
        listeners.set(name, handler);
        return { remove: () => calls.removed.push(name) };
      },
      async minimizeApp() {
        calls.minimize += 1;
      },
      async getInfo() {
        return { name: 'RP Hub', id: 'io.github.pq125.rphub', version: '0.1.0', build: '1' };
      },
    },
    Browser: {
      async open(options) {
        calls.browser.push(options);
      },
    },
    Share: {
      async canShare() {
        return { value: true };
      },
      async share(options) {
        calls.share.push(options);
        return { activityType: '' };
      },
    },
    NativeFile: {
      async beginSave(options) {
        calls.file.push({ method: 'beginSave', options });
        return { cancelled: false, sessionId: 'save-1' };
      },
      async appendChunk(options) {
        calls.file.push({ method: 'appendChunk', options });
        return { nextChunkIndex: options.index + 1 };
      },
      async finishSave(options) {
        calls.file.push({ method: 'finishSave', options });
        return { bytesWritten: 42 };
      },
      async cancelSave(options) {
        calls.cancelled.push(options);
        return { cancelled: true };
      },
    },
  };
  const document = createDocument();
  const { services, context, window } = loadPlatformServices({
    Capacitor: {
      Plugins: plugins,
      getPlatform: () => 'android',
      isNativePlatform: () => true,
    },
    document,
  });

  assert.equal(services.isNative(), true);
  assert.equal(services.getPlatform(), 'android');
  assert.equal((await services.invokeNative('MissingPlugin', 'missingMethod')).supported, false);
  const nativeImplementation = window.RPHubPlatform.getImplementation();
  vm.runInContext(androidSource, context, { filename: 'rphub-android-adapter.js' });
  assert.equal(window.RPHubPlatform.getImplementation(), nativeImplementation, 'Android adapter initialization must be idempotent');
  await services.openExternalUrl('https://example.com/native');
  assert.deepEqual(toPlainObject(calls.browser[0]), { url: 'https://example.com/native' });

  await services.share({ title: 'RP Hub', text: 'test', url: 'https://example.com/share' });
  assert.deepEqual(toPlainObject(calls.share[0]), {
    title: 'RP Hub',
    text: 'test',
    url: 'https://example.com/share',
  });

  const boundaryText = `${'a'.repeat((256 * 1024) - 1)}😺\n中文`;
  const fileResult = await services.exportFile({
    filename: '聊天:备份.jsonl',
    mimeType: 'application/jsonl; charset=utf-8',
    data: boundaryText,
  });
  assert.equal(fileResult.cancelled, false);
  const fileCalls = calls.file.splice(0);
  assert.deepEqual(toPlainObject(fileCalls[0]), {
    method: 'beginSave',
    options: { filename: '聊天:备份.jsonl', mimeType: 'application/jsonl' },
  });
  const textChunks = fileCalls.filter(item => item.method === 'appendChunk');
  assert.equal(textChunks.length, 2);
  assert.equal(textChunks.map(item => item.options.data).join(''), boundaryText, 'surrogate pairs must remain intact');
  assert.deepEqual(textChunks.map(item => item.options.index), [0, 1]);
  assert.equal(fileCalls.at(-1).method, 'finishSave');

  await services.saveFile({
    filename: 'card.png',
    mimeType: 'image/png',
    data: new Blob([new Uint8Array(200 * 1024).fill(0x5a)], { type: 'image/png' }),
  });
  const binaryCalls = calls.file.splice(0).filter(item => item.method === 'appendChunk');
  assert.equal(binaryCalls.length, 2);
  assert.equal(binaryCalls.every(item => item.options.encoding === 'base64'), true);
  assert.equal(Buffer.concat(binaryCalls.map(item => Buffer.from(item.options.data, 'base64'))).length, 200 * 1024);

  const streamPieces = [
    'a'.repeat((256 * 1024) - 1),
    '😺\n中文',
    'b'.repeat(100),
  ];
  const streamResult = await services.exportFile({
    filename: 'stream.jsonl',
    mimeType: 'application/jsonl',
    data: (async function* () {
      for (const piece of streamPieces) yield piece;
    })(),
  });
  assert.equal(streamResult.cancelled, false);
  const streamFileCalls = calls.file.splice(0);
  assert.equal(streamFileCalls[0].method, 'beginSave');
  const streamChunks = streamFileCalls.filter(item => item.method === 'appendChunk');
  assert.equal(streamChunks.map(item => item.options.data).join(''), streamPieces.join(''), 'streamed pieces must concatenate intact');
  assert.deepEqual(streamChunks.map(item => item.options.index), [0, 1], 'stream must carry a running chunk index');
  assert.equal(streamChunks.every(item => item.options.encoding === 'utf8'), true);
  assert.equal(streamChunks[1].options.data.startsWith('😺'), true, 'surrogate pair must not be split across chunks');
  assert.equal(streamFileCalls.at(-1).method, 'finishSave');

  const info = await services.getAppInfo();
  assert.deepEqual(toPlainObject(info), {
    platform: 'android',
    name: 'RP Hub',
    id: 'io.github.pq125.rphub',
    version: '0.1.0',
    build: '1',
  });

  const removeBack = await services.onBackButton(() => true);
  await listeners.get('backButton')({ canGoBack: false });
  assert.equal(calls.minimize, 0);
  removeBack();

  await services.onBackButton(() => false);
  await listeners.get('backButton')({ canGoBack: false });
  assert.equal(calls.minimize, 1, 'unhandled main-view Back should minimize the app');

  const states = [];
  const removeState = await services.onAppStateChange(state => states.push(state));
  listeners.get('appStateChange')({ isActive: false });
  listeners.get('appStateChange')({ isActive: true });
  assert.deepEqual(toPlainObject(states), [
    { isActive: false, state: 'background' },
    { isActive: true, state: 'active' },
  ]);
  removeState();

  let prevented = false;
  document.listeners.get('click')({
    altKey: false,
    button: 0,
    ctrlKey: false,
    defaultPrevented: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: () => { prevented = true; },
    target: {
      closest: () => ({
        getAttribute: () => 'https://outside.example/page',
        hasAttribute: () => false,
      }),
    },
  });
  await Promise.resolve();
  assert.equal(prevented, true);
  assert.deepEqual(toPlainObject(calls.browser.at(-1)), { url: 'https://outside.example/page' });
}

{
  let cancelCount = 0;
  const plugins = {
    NativeFile: {
      async beginSave() { return { cancelled: false, sessionId: 'failed-save' }; },
      async appendChunk() { throw new Error('write failed'); },
      async finishSave() { throw new Error('finish must not run'); },
      async cancelSave() { cancelCount += 1; return { cancelled: true }; },
    },
  };
  const { services } = loadPlatformServices({
    Capacitor: { Plugins: plugins, getPlatform: () => 'android', isNativePlatform: () => true },
  });
  await assert.rejects(
    () => services.saveFile({ filename: 'backup.json', mimeType: 'application/json', data: '{}' }),
    /write failed/,
  );
  assert.equal(cancelCount, 1, 'failed writes must clean up the native session');

  plugins.NativeFile.beginSave = async () => ({ cancelled: true });
  const cancelled = await services.saveFile({ filename: 'backup.json', mimeType: 'application/json', data: '{}' });
  assert.deepEqual(toPlainObject(cancelled), { supported: true, cancelled: true });
}

console.log('PlatformAdapter browser fallback, Android bridge, file chunks, cancellation, and singleton contracts: PASS');
