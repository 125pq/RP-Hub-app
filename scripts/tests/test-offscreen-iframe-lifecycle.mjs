import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../../assets/js/offscreen-iframe-lifecycle.js', import.meta.url), 'utf8');

class FakeClassList {
  constructor() { this.values = new Set(); }
  toggle(name, force) {
    if (force) this.values.add(name);
    else this.values.delete(name);
  }
  contains(name) { return this.values.has(name); }
}

const createChildDocument = () => {
  const elementsById = new Map();
  const appendChild = element => {
    if (element.id) elementsById.set(element.id, element);
  };
  return {
    documentElement: { classList: new FakeClassList(), appendChild },
    head: { appendChild },
    getElementById: id => elementsById.get(id) || null,
    createElement: tagName => ({ tagName, id: '', textContent: '' })
  };
};

const createFrame = (top, bottom) => {
  const listeners = new Map();
  return {
    nodeType: 1,
    isConnected: true,
    rect: { top, bottom, left: 0, right: 100 },
    contentDocument: createChildDocument(),
    matches: selector => selector === 'iframe.executable-html-frame',
    querySelectorAll: () => [],
    getBoundingClientRect() { return this.rect; },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    dispatch(type) { listeners.get(type)?.(); }
  };
};

const frames = [createFrame(20, 80), createFrame(150, 200), createFrame(300, 350)];
const container = {
  clientHeight: 100,
  getBoundingClientRect: () => ({ top: 0, bottom: 100, left: 0, right: 100 }),
  querySelectorAll: selector => selector === 'iframe.executable-html-frame' ? frames : [],
  listeners: new Map(),
  addEventListener(type, listener) { this.listeners.set(type, listener); },
  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  },
  dispatch(type) { this.listeners.get(type)?.(); }
};

const intersectionObservers = [];
class FakeIntersectionObserver {
  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.observed = new Set();
    intersectionObservers.push(this);
  }
  observe(target) { this.observed.add(target); }
  unobserve(target) { this.observed.delete(target); }
  disconnect() { this.observed.clear(); }
}

let mutationObserver;
class FakeMutationObserver {
  constructor(callback) { this.callback = callback; mutationObserver = this; }
  observe() {}
  disconnect() {}
}

let rafId = 0;
const rafCallbacks = new Map();
const requestAnimationFrame = callback => {
  const id = ++rafId;
  rafCallbacks.set(id, callback);
  return id;
};
const cancelAnimationFrame = id => rafCallbacks.delete(id);
const flushAnimationFrames = () => {
  const callbacks = [...rafCallbacks.values()];
  rafCallbacks.clear();
  callbacks.forEach(callback => callback(0));
};

let timeoutId = 0;
const timeouts = new Map();
const setTimeout = (fn) => {
  const id = ++timeoutId;
  timeouts.set(id, fn);
  return id;
};
const clearTimeout = id => timeouts.delete(id);
const flushTimeouts = () => {
  const entries = [...timeouts.values()];
  timeouts.clear();
  entries.forEach(fn => fn());
};

const eventTarget = {
  addEventListener() {},
  removeEventListener() {}
};
const documentObject = { ...eventTarget, hidden: false };
const windowObject = { ...eventTarget, IntersectionObserver: FakeIntersectionObserver, __RPH_PERF__: { enabled: true } };
const context = vm.createContext({
  window: windowObject,
  document: documentObject,
  Node: { ELEMENT_NODE: 1 },
  IntersectionObserver: FakeIntersectionObserver,
  MutationObserver: FakeMutationObserver,
  requestAnimationFrame,
  cancelAnimationFrame,
  setTimeout,
  clearTimeout
});

vm.runInContext(source, context, { filename: 'offscreen-iframe-lifecycle.js' });
const lifecycle = windowObject.RPHubOffscreenIframeLifecycle;
lifecycle.attach(container);

assert.equal(lifecycle.preloadViewports, 1.5);
assert.equal(intersectionObservers.length, 2);
assert.equal(intersectionObservers[0].options.rootMargin, '0px');
assert.equal(intersectionObservers[1].options.rootMargin, '150px 0px 150px 0px');
assert.equal(lifecycle.getState(frames[0]).state, 'ACTIVE');
assert.equal(lifecycle.getState(frames[0]).suspended, false);
assert.equal(lifecycle.getState(frames[1]).state, 'NEAR');
assert.equal(lifecycle.getState(frames[1]).suspended, false);
assert.equal(lifecycle.getState(frames[2]).state, 'OFFSCREEN');
assert.equal(lifecycle.getState(frames[2]).suspended, true);
assert.equal(frames[2].contentDocument.documentElement.classList.contains('rph-offscreen'), true);
assert.ok(frames[2].contentDocument.getElementById('rph-offscreen-animation-suspension'));

lifecycle.resetDiagnostics();

frames[2].rect = { top: 180, bottom: 230, left: 0, right: 100 };
intersectionObservers[0].callback([]);
intersectionObservers[1].callback([]);
flushAnimationFrames();
assert.equal(lifecycle.getState(frames[2]).state, 'NEAR');
assert.equal(lifecycle.getState(frames[2]).suspended, false);
assert.equal(frames[2].contentDocument.documentElement.classList.contains('rph-offscreen'), false);
assert.equal(lifecycle.getDiagnostics().preloadResumes, 1);
assert.equal(lifecycle.getDiagnostics().directActiveResumes, 0);

frames[2].rect = { top: 40, bottom: 90, left: 0, right: 100 };
intersectionObservers[0].callback([]);
flushAnimationFrames();
assert.equal(lifecycle.getState(frames[2]).state, 'ACTIVE');

frames[2].rect = { top: 400, bottom: 450, left: 0, right: 100 };
intersectionObservers[1].callback([]);
flushAnimationFrames();
assert.equal(lifecycle.getState(frames[2]).suspended, true);
frames[2].contentDocument = createChildDocument();
frames[2].dispatch('load');
assert.equal(frames[2].contentDocument.documentElement.classList.contains('rph-offscreen'), true);

frames[2].isConnected = false;
mutationObserver.callback([{ removedNodes: [frames[2]], addedNodes: [] }]);
assert.equal(lifecycle.getState(frames[2]), null);
assert.equal(frames[2].contentDocument.documentElement.classList.contains('rph-offscreen'), false);

// Scroll pause: while the container scrolls, in-view frames also suspend; idle resumes them.
container.dispatch('scroll');
flushAnimationFrames();
assert.equal(lifecycle.getState(frames[0]).state, 'ACTIVE');
assert.equal(lifecycle.getState(frames[0]).suspended, true);
assert.equal(frames[0].contentDocument.documentElement.classList.contains('rph-offscreen'), true);
assert.equal(lifecycle.getState(frames[1]).suspended, true);

flushTimeouts();
flushAnimationFrames();
assert.equal(lifecycle.getState(frames[0]).suspended, false);
assert.equal(lifecycle.getState(frames[1]).suspended, false);

lifecycle.detach();
assert.equal(lifecycle.getState(frames[0]), null);
assert.equal(lifecycle.getState(frames[1]), null);

console.log('Offscreen iframe lifecycle: PASS');
console.log('States: ACTIVE / NEAR / OFFSCREEN');
console.log('Cleanup: removed frames unobserved and resumed');
