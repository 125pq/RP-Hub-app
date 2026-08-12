import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../assets/js/platform-services.js', import.meta.url), 'utf8');
const toPlainObject = value => JSON.parse(JSON.stringify(value));

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
    console,
    document,
    location: new URL('https://app.example/index.html'),
    navigator: {},
    open: () => ({ opener: {} }),
    ...overrides,
  };
  const context = vm.createContext({ URL, window });
  vm.runInContext(source, context, { filename: 'platform-services.js' });
  return { document, services: window.PlatformServices, window };
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
  assert.equal((await services.share({ text: 'test' })).supported, false);
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

  window.navigator.share = async options => options;
  const shareResult = await services.share({ title: 'RP Hub', text: 'test' });
  assert.equal(shareResult.supported, true);
  assert.deepEqual(toPlainObject(shareResult.result), { title: 'RP Hub', text: 'test' });
  await assert.rejects(() => services.openExternalUrl('javascript:alert(1)'), /Unsupported external URL protocol/);
}

{
  const calls = { browser: [], share: [], minimize: 0, removed: [] };
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
  };
  const document = createDocument();
  const { services } = loadPlatformServices({
    Capacitor: {
      Plugins: plugins,
      getPlatform: () => 'android',
      isNativePlatform: () => true,
    },
    document,
  });

  assert.equal(services.isNative(), true);
  assert.equal(services.getPlatform(), 'android');
  await services.openExternalUrl('https://example.com/native');
  assert.deepEqual(toPlainObject(calls.browser[0]), { url: 'https://example.com/native' });

  await services.share({ title: 'RP Hub', text: 'test', url: 'https://example.com/share' });
  assert.deepEqual(toPlainObject(calls.share[0]), {
    title: 'RP Hub',
    text: 'test',
    url: 'https://example.com/share',
  });

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

console.log('PlatformServices browser fallback and native contracts: PASS');
